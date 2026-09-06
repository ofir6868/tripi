// Builds the demo-mode UI:
//   dist/pages/        — a static site for Cloudflare Pages (public/ + the mock shim,
//                        _redirects for the pretty routes, a no-op service worker)
//   dist/preview.html  — the trip page as ONE self-contained file (CSS, JS, vendor
//                        Leaflet and the mock inlined) for hosting anywhere a single file goes
// Usage: node tools/preview/build.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');
const read = (p) => fs.readFileSync(p, 'utf8');

const SHIM_TAGS = '  <script src="/js/preview-mock.js"></script>\n  <script src="/js/preview-shim.js"></script>\n';
const DEMO_BADGE = `  <div class="demo-badge" title="תצוגת דמו — API מדומה, שום דבר לא נשמר בשרת">DEMO</div>\n`;
const DEMO_CSS = `
/* demo build only */
.demo-badge { position: fixed; top: calc(8px + env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); z-index: 9998;
  padding: 2px 9px; border-radius: 999px; font: 800 .62rem/1.6 system-ui, sans-serif; letter-spacing: .12em;
  color: #2a1500; background: #ffb45f; pointer-events: none; opacity: .9; }
@media (max-width: 640px) { .demo-badge { top: auto; bottom: calc(var(--dock-h, 66px) + 18px + env(safe-area-inset-bottom)); } }
`;

function patchPage(html) {
  return html
    .replace('  <script src="/js/common.js"></script>\n', SHIM_TAGS + '  <script src="/js/common.js"></script>\n')
    .replace('<body>\n', '<body>\n' + DEMO_BADGE);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// ---- Cloudflare Pages ----
const PAGES = path.join(DIST, 'pages');
fs.rmSync(PAGES, { recursive: true, force: true });
copyDir(PUB, PAGES);
fs.copyFileSync(path.join(__dirname, 'mock-api.js'), path.join(PAGES, 'js', 'preview-mock.js'));
fs.copyFileSync(path.join(__dirname, 'shim.js'), path.join(PAGES, 'js', 'preview-shim.js'));
for (const f of ['trip.html', 'index.html', 'my.html', 'plan.html']) {
  const p = path.join(PAGES, f);
  if (fs.existsSync(p)) fs.writeFileSync(p, patchPage(read(p)));
}
fs.appendFileSync(path.join(PAGES, 'css', 'style.css'), DEMO_CSS);
fs.writeFileSync(path.join(PAGES, 'sw.js'), "self.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', () => self.registration.unregister());\n");
fs.writeFileSync(path.join(PAGES, '_redirects'), ['/trip/* /trip.html 200', '/my /my.html 200', '/plan /plan.html 200', '/ /trip/731502 302', ''].join('\n'));
fs.writeFileSync(path.join(PAGES, '_headers'), '/*\n  Cache-Control: no-cache\n  X-Robots-Tag: noindex\n');
fs.rmSync(path.join(PAGES, 'admin.html'), { force: true });

// ---- single file ----
let html = read(path.join(PUB, 'trip.html'));
const inlineCss = (href, file) => { html = html.replace(`<link rel="stylesheet" href="${href}">`, `<style>\n${read(file)}\n</style>`); };
inlineCss('/css/style.css', path.join(PUB, 'css', 'style.css'));
inlineCss('/vendor/leaflet/leaflet.css', path.join(PUB, 'vendor', 'leaflet', 'leaflet.css'));
html = html.replace(/<link rel="(manifest|apple-touch-icon)"[^>]*>\n/g, '');
html = html.replace('  <script src="/js/common.js"></script>\n',
  `  <script>\n${read(path.join(__dirname, 'mock-api.js'))}\n</script>\n  <script>\n${read(path.join(__dirname, 'shim.js'))}\n</script>\n  <script src="/js/common.js"></script>\n`);
html = html.replace(/  <script src="(\/[^"]+\.js)"><\/script>\n/g, (m, src) =>
  `  <script>\n${read(path.join(PUB, src)).replace(/<\/script>/gi, '<\\/script>')}\n</script>\n`);
html = html.replace('<body>\n', '<body>\n' + DEMO_BADGE);
html = html.replace('</style>', DEMO_CSS + '\nhtml { font-size: 16px; }\n</style>');
// hosts that wrap the file in their own document skeleton get the same content minus ours
const bodyOnly = html
  .replace(/^[\s\S]*?<title>[^<]*<\/title>/, '<title>TRIP MAKER Demo</title>').replace('</head>\n<body>\n', '\n').replace(/<\/body>\s*<\/html>\s*$/, '');
fs.writeFileSync(path.join(DIST, 'preview.html'), html);
fs.writeFileSync(path.join(DIST, 'preview-embed.html'), bodyOnly);
const kb = (p) => Math.round(fs.statSync(p).size / 1024);
console.log(`dist/pages ready · dist/preview.html ${kb(path.join(DIST, 'preview.html'))} KB · dist/preview-embed.html ${kb(path.join(DIST, 'preview-embed.html'))} KB`);
