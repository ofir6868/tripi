// Downloads the home page's hero photo and writes it into public/img, at the widths
// index.html asks for.
//   Usage: node tools/fetch-hero.js
//
// Why the photo should live in our own repo rather than be linked from Unsplash:
// it is the LCP element, and a cross-origin one costs a DNS lookup, a TCP handshake
// and a TLS negotiation before its first byte — all of it on the critical path, in
// front of the largest thing on the screen, on every cold visit. From our own origin
// it arrives on the connection the HTML already opened. It is also one fixed
// marketing photo that has not changed since the page was written, so there is
// nothing dynamic to preserve by fetching it at runtime.
//
// No dependencies, and no image processing: Unsplash's own CDN does the resizing and
// the format conversion, so this asks it for exactly the renditions we want and
// saves what comes back. `auto=format` picks the format from the Accept header, and
// we send WebP — universally supported by anything that can render this site, and
// roughly a third the bytes of the JPEG.
//
// Re-run it if the hero photo changes. The files are served immutable (see
// server.js), so a NEW photo needs a new filename, not new bytes under the old one.
const fs = require('fs');
const https = require('https');
const path = require('path');

// the photo index.html has always used, and the widths in its srcset
const PHOTO = 'photo-1469854523086-cc02fe5d8800';
const WIDTHS = [640, 960, 1280, 1600];
const QUALITY = 60; // it is seen through .hero-veil and a brightness(.8) filter
const OUT = path.join(__dirname, '..', 'public', 'img');

const url = (w) =>
  `https://images.unsplash.com/${PHOTO}?auto=format&fit=crop&w=${w}&q=${QUALITY}`;

function get(u, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { Accept: 'image/webp,*/*', 'User-Agent': 'tripmaker-fetch-hero' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 4) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, u).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
    }).on('error', reject);
  });
}

// a WebP file is a RIFF container whose form type is "WEBP" — enough to catch an
// error page saved under an .webp name, which would break the hero silently
const isWebp = (b) =>
  b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let total = 0;
  for (const w of WIDTHS) {
    const { body, type } = await get(url(w));
    if (!isWebp(body)) {
      throw new Error(`${url(w)} came back as ${type} (${body.length} bytes), not WebP — ` +
        'Unsplash may have stopped honouring auto=format for this Accept header');
    }
    const file = path.join(OUT, `hero-${w}.webp`);
    fs.writeFileSync(file + '.tmp', body);
    fs.renameSync(file + '.tmp', file);   // never leave a half-written file behind
    total += body.length;
    console.log(`  public/img/hero-${w}.webp  ${(body.length / 1024).toFixed(1)} kB`);
  }

  // provenance, the same way public/fonts/README.md records the typefaces
  fs.writeFileSync(path.join(OUT, 'README.md'), `# Images

Written by \`node tools/fetch-hero.js\` — do not edit by hand.

\`hero-*.webp\` is the home page's hero photo, the page's LCP element, served from
this origin so it does not cost a handshake with someone else's before it starts.

| | |
| --- | --- |
| source | https://unsplash.com/photos/${PHOTO.replace(/^photo-/, '')} |
| renditions | ${WIDTHS.map((w) => w + 'px').join(', ')} wide, WebP, q=${QUALITY} |
| licence | [Unsplash License](https://unsplash.com/license) — free to use, including commercially, no permission needed |

Everything in this directory is served \`immutable\` for a year (see \`server.js\`), so
**a changed photo needs a changed filename** — new bytes under an old name reach
nobody who has already visited.
`);

  console.log(`\n${WIDTHS.length} renditions, ${(total / 1024).toFixed(0)} kB total, in public/img/`);
  console.log('Commit them, and index.html can point at /img/hero-*.webp instead of images.unsplash.com.');
})().catch((err) => {
  console.error('fetch-hero failed:', err.message);
  process.exit(1);
});
