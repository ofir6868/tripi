// Static preview of the UI with the mock API — no database, no keys.
//   node tools/preview/server.js [port]   →  http://localhost:4173/trip/731502
// The service worker is deliberately not served: it would pin a stale shell across edits.
const http = require('http');
const fs = require('fs');
const path = require('path');
const mock = require('./mock-api');

// PREVIEW_ROOT=dist/pages serves a built demo instead (STATIC=1 leaves /api to the in-page shim)
const PUB = path.resolve(process.env.PREVIEW_ROOT || path.join(__dirname, '..', '..', 'public'));
const STATIC = !!process.env.STATIC;
const PORT = +(process.argv[2] || process.env.PORT || 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const PAGES = { '/': '/index.html', '/my': '/my.html', '/plan': '/plan.html', '/admin': '/admin.html' };

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/') && !STATIC) {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      const r = mock.handle(req.method, req.url, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(r.body));
    }
    let p = url.pathname;
    if (/^\/trip\/\d+$/.test(p)) p = '/trip.html';
    p = PAGES[p] || p;
    if (p === '/sw.js' && !STATIC) { res.writeHead(404); return res.end(); }
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => console.log(`preview: http://localhost:${PORT}/trip/${mock.trip.share_code}`));
