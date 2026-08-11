// Rasterises public/icon.svg into the PNG set iOS and Android need.
// Usage: node tools/make-icons.js
//
// Written against zlib alone rather than a rasteriser dependency: the mark is
// four analytic shapes, so sampling them directly is both exact and reproducible,
// and nothing extra ends up in the deploy. Re-run it whenever the brand mark
// changes — the geometry below is the same 512-unit space as icon.svg.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');
const SS = 4; // supersampling factor per axis — 16 samples a pixel, plenty for curves

/* ---------- geometry, in icon.svg's 512×512 space ---------- */

const BG_FROM = [0x16, 0x30, 0x2a];
const BG_TO = [0x0a, 0x15, 0x12];
const AMBER_FROM = [0xff, 0xb4, 0x5f];
const AMBER_TO = [0xe8, 0x85, 0x3a];
const RING = [245, 239, 227, 0.25];
const MINT = [143, 216, 196, 0.85];
const HUB_FILL = [0x0a, 0x15, 0x12, 1];
const HUB_STROKE = [0xff, 0xb4, 0x5f, 1];

const NEEDLE = [[256, 116], [296, 256], [256, 396], [216, 256]];
const CROSS = [[116, 256], [256, 216], [396, 256], [256, 296]];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// even-odd crossing test; both marks are convex kites so this is exact
function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// src-over: dst is opaque throughout (every icon starts from a filled background)
function over(dst, src, alpha) {
  if (alpha <= 0) return;
  dst[0] = lerp(dst[0], src[0], alpha);
  dst[1] = lerp(dst[1], src[1], alpha);
  dst[2] = lerp(dst[2], src[2], alpha);
}

// colour of one sample point. `content` re-maps shape coordinates so a maskable
// icon can shrink the mark into the safe zone while the background stays edge to edge.
function sample(sx, sy, u, v, content, rounded) {
  const px = { r: 0, g: 0, b: 0, a: 1 };
  const c = mix(BG_FROM, BG_TO, (u + v) / 2);
  const out = [c[0], c[1], c[2]];

  // shape space: scale about the centre
  const gx = 256 + (sx - 256) / content;
  const gy = 256 + (sy - 256) / content;
  const dist = Math.hypot(gx - 256, gy - 256);

  if (Math.abs(dist - 150) <= 7) over(out, RING, RING[3]);              // ring, stroke-width 14
  if (inPoly(NEEDLE, gx, gy)) {
    const t = Math.min(Math.max((gx / 512 + gy / 512) / 2, 0), 1);
    over(out, mix(AMBER_FROM, AMBER_TO, t), 1);
  }
  if (inPoly(CROSS, gx, gy)) over(out, MINT, MINT[3]);
  if (dist <= 26) over(out, HUB_FILL, 1);                               // hub fill
  if (Math.abs(dist - 26) <= 4) over(out, HUB_STROKE, 1);               // hub stroke, width 8

  px.r = out[0]; px.g = out[1]; px.b = out[2];

  // rounded corners for the "any" icons; Apple and maskable want full-bleed squares
  if (rounded) {
    const R = 110;
    const cx = Math.min(sx, 512 - sx);
    const cy = Math.min(sy, 512 - sy);
    if (cx < R && cy < R && Math.hypot(R - cx, R - cy) > R) px.a = 0;
  }
  return px;
}

function render(size, { content = 1, rounded = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const p = sample(u * 512, v * 512, u, v, content, rounded);
          r += p.r * p.a; g += p.g * p.a; b += p.b * p.a; a += p.a;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // premultiplied accumulation, un-premultiplied on the way out
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

/* ---------- minimal PNG writer (RGBA8, filter 0) ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the set ---------- */

const TARGETS = [
  // iOS home screen. Apple masks the corners itself, so these are square and fully
  // opaque — a rounded, transparent source would show dark notches inside the mask.
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'apple-touch-icon-167.png', size: 167 },
  { file: 'apple-touch-icon-152.png', size: 152 },
  { file: 'apple-touch-icon-120.png', size: 120 },
  // Android / PWA install
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  // maskable: the launcher crops to a shape of its choosing, so the background runs
  // edge to edge. The mark's bounding circle is already 61% of the width — inside the
  // 80% safe zone — so it only needs easing in slightly, not shrinking to a dot.
  { file: 'icon-maskable-512.png', size: 512, content: 0.85 },
];

for (const t of TARGETS) {
  const buf = png(render(t.size, { content: t.content ?? 1, rounded: !!t.rounded }), t.size);
  fs.writeFileSync(path.join(OUT, t.file), buf);
  console.log(`  + ${t.file.padEnd(28)} ${t.size}×${t.size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log('done.');
