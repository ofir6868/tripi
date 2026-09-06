// End-to-end check of the מסמכים content tagging in a real browser (Playwright's
// chromium, against the mock-API preview): a text PDF, a rendered "boarding pass"
// image that needs OCR, an image-only scanned PDF, a .docx, an .eml, a name-only
// file and a blank photo go through the picker, and the folder each lands in is
// printed and asserted. Exits 1 on a wrong folder or a page error.
//   node tools/preview/server.js 4173 &
//   NODE_PATH=$(npm root -g) node tools/preview/docs-check.js http://localhost:4173
// The OCR/PDF engines come from jsDelivr unless DOC_LIBS_BASE (and DOC_LANG_PATH, a
// directory with eng/heb .traineddata.gz) point at a mirror with the same layout —
// that is how it runs with no outside network.
const { chromium, devices } = require('playwright');
const zlib = require('zlib');

const BASE = process.argv[2] || 'http://localhost:4173';
const LIBS = process.env.DOC_LIBS_BASE || null;
const LANGS = process.env.DOC_LANG_PATH || null;
const login = { token: 'demo', user: { id: 1, name: 'רגב כהן', email: 'demo@tripmaker.co.il', is_admin: false } };

// ---- fixtures, built here so the check has no files to ship ----

// a one-page PDF with a real text layer (Helvetica, standard encoding — ASCII only)
function textPdf(lines) {
  const escapePdf = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const content = `BT /F1 12 Tf 50 790 Td 15 TL ${lines.map((l) => `(${escapePdf(l)}) Tj T*`).join(' ')} ET`;
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ], { Title: 'Electronic Ticket Receipt', Author: 'EL AL Israel Airlines' });
}

// a one-page PDF that is only a JPEG — a scan: no text layer at all
function scanPdf(jpeg, w, h) {
  const content = `q ${595} 0 0 ${Math.round((595 * h) / w)} 0 ${842 - Math.round((595 * h) / w)} cm /Im1 Do Q`;
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
  ]);
}

function assemblePdf(objects, info) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')];
  const offsets = [];
  let pos = parts[0].length;
  const push = (b) => { parts.push(b); pos += b.length; };
  const all = info ? [...objects, `<< ${Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(' ')} >>`] : objects;
  all.forEach((o, i) => {
    offsets.push(pos);
    push(Buffer.from(`${i + 1} 0 obj\n`));
    push(Buffer.isBuffer(o) ? o : Buffer.from(o));
    push(Buffer.from('\nendobj\n'));
  });
  const xref = pos;
  push(Buffer.from(`xref\n0 ${all.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`));
  push(Buffer.from(`trailer\n<< /Size ${all.length + 1} /Root 1 0 R${info ? ` /Info ${all.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// a .docx: a zip with the one XML that matters (and the content-types file Word insists on)
function docx(paragraphs) {
  const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${xmlEsc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  return zip([['[Content_Types].xml', types], ['word/document.xml', doc]]);
}

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc32(raw), 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(off, 42);
    locals.push(head, n, data);
    centrals.push(cen, n);
    off += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// an e-mail: an encoded-word subject and a quoted-printable UTF-8 body, like a real client writes it
function eml(subject, from, body) {
  const qp = Buffer.from(body, 'utf8').toString('binary').replace(/[^\t\n\r\x20-\x3c\x3e-\x7e]/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).replace(/(.{72})/g, '$1=\n');
  return `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=\nFrom: ${from}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n${qp}\n`;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'he-IL' });
  await ctx.addInitScript((o) => {
    localStorage.setItem('tripmaker_token', o.login.token);
    localStorage.setItem('tripmaker_user', JSON.stringify(o.login.user));
    if (o.libs) window.TRIPMAKER_DOC_LIBS = { base: o.libs, langPath: o.langs || null };
  }, { login, libs: LIBS, langs: LANGS });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // the preview deliberately serves no sw.js — that 404 is the registration failing, not the page
  page.on('console', (m) => { if (m.type() === 'error' && !/unsplash|open-meteo|osrm|net::ERR|Failed to load resource|bad HTTP response code \(404\) was received when fetching the script/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(`${BASE}/trip/731502`);
  await page.waitForSelector('#days-container .item-card:not(.skl-stop)', { timeout: 15000 });
  await page.click('#docs-btn');
  await page.waitForSelector('.docs-empty');
  console.log('capabilities:', JSON.stringify(await page.evaluate(() => DocText.capabilities())));

  // images are painted in the page itself: a boarding pass, a passport page, and a blank one
  const paint = (lines, w = 1400, h = 900) => page.evaluate(({ lines, w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111'; g.font = 'bold 52px Arial, Helvetica, sans-serif'; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, 60, 60 + i * 90));
    return { png: c.toDataURL('image/png'), jpeg: c.toDataURL('image/jpeg', 0.85) };
  }, { lines, w, h });
  const b64 = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
  const boarding = await paint(['WIZZ AIR  BOARDING PASS', 'MR DAVID COHEN', 'TLV - BUD   W6 2312', 'GATE B7   SEAT 14A', 'CONFIRMATION K9XR2P']);
  const passport = await paint(['STATE OF ISRAEL', 'PASSPORT', 'Surname COHEN  Given names DAVID', 'Nationality ISRAELI', 'P<ISRCOHEN<<DAVID<<<<<<<<<<<<<<<<']);
  const blank = await paint([]);

  const files = [
    { name: 'Document.pdf', mimeType: 'application/pdf', buffer: textPdf(['EL AL ISRAEL AIRLINES', 'ELECTRONIC TICKET ITINERARY / RECEIPT', 'Passenger: COHEN/DAVID MR', 'Ticket number: 114-2401234567', 'LY 315  TLV - ATH  14 AUG 2026  Economy  Seat 22C', 'Baggage: 1 x 23 kg', 'Total paid: 1,890.00 ILS']), want: 'flights', read: 'pdf' },
    { name: 'Screenshot_20260814-101533.png', mimeType: 'image/png', buffer: b64(boarding.png), want: 'flights', read: 'ocr' },
    { name: 'scan0001.pdf', mimeType: 'application/pdf', buffer: scanPdf(b64(passport.jpeg), 1400, 900), want: 'id', read: 'pdf-ocr' },
    { name: 'Confirmation.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx(['Booking.com — Your booking is confirmed', 'Hotel Artemide, Rome', 'Check-in: 14 August 2026   Check-out: 17 August 2026', '3 nights, Double Room, breakfast included', 'Total price: € 690']), want: 'stay', read: 'docx' },
    { name: 'policy.eml', mimeType: 'message/rfc822', buffer: Buffer.from(eml('אישור פוליסה — ביטוח נסיעות לחו"ל', 'PassportCard <noreply@passportcard.co.il>', 'שלום דוד,\nמצורפת פוליסת ביטוח הנסיעות שלך. מספר פוליסה: 7781-2026-001\nכיסויים: הוצאות רפואיות, אובדן כבודה, ביטול נסיעה. השתתפות עצמית: 50 $\nמוקד חירום 24/7')), want: 'insurance', read: 'text' },
    { name: 'Hotel Artemide booking 4471.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo'), want: 'stay', read: 'none' },
    { name: 'IMG_0007.jpg', mimeType: 'image/jpeg', buffer: b64(blank.jpeg), want: 'other', read: 'ocr' },
  ];
  const t0 = Date.now();
  await page.setInputFiles('#docs-file', files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
  await page.waitForFunction((n) => document.querySelectorAll('.doc-tile').length === n, files.length, { timeout: 20000 });
  console.log('saved, name-based tags:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.doc-tile')].map((t) => t.querySelector('.dt-tags span').textContent))));
  console.log('tiles marked as being read:', await page.locator('.doc-tile.is-scanning').count(), '· status line:', await page.locator('.docs-scan').count());
  // the content pass: done when every stored record carries its verdict
  const readRows = () => page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('tripmaker-docs', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const q = req.result.transaction('docs').objectStore('docs').getAll();
      q.onsuccess = () => { req.result.close(); resolve(q.result.map((d) => ({ name: d.name, folder: d.folder, via: d.via, read: d.read, tags: d.tags, scanned: d.scanned, auto: d.auto }))); };
      q.onerror = () => reject(q.error);
    };
  }));
  let rows = [];
  for (let i = 0; i < 240; i++) {
    rows = await readRows();
    if (rows.length === files.length && rows.every((r) => r.scanned)) break;
    await page.waitForTimeout(1000);
  }
  console.log(`content pass done in ${((Date.now() - t0) / 1000).toFixed(1)}s · status line gone: ${(await page.locator('.docs-scan').count()) === 0}`);
  let bad = 0;
  for (const f of files) {
    const r = rows.find((x) => x.name === f.name);
    const ok = r && r.folder === f.want && r.scanned;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${f.name.padEnd(36)} → ${r ? r.folder.padEnd(9) : '(missing)'} via ${r?.via} read ${r?.read}${f.read && r?.read !== f.read ? ` (expected read ${f.read})` : ''}  [${(r?.tags || []).join(', ')}]${ok ? '' : `   WANT ${f.want}`}`);
  }

  // a manual pick is kept: file the blank photo under money, reload, and it stays there
  await page.click('.doc-tile:has-text("IMG_0007.jpg")');
  await page.waitForSelector('.tp-sheet.open #ds-folder');
  await page.selectOption('.tp-sheet.open #ds-folder', 'money');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('#days-container .item-card:not(.skl-stop)', { timeout: 15000 });
  await page.click('#docs-btn');
  await page.waitForSelector('.doc-tile');
  await page.waitForTimeout(800);
  const kept = await page.evaluate(() => [...document.querySelectorAll('.doc-tile')].find((t) => t.textContent.includes('IMG_0007.jpg'))?.querySelector('.dt-tags span').textContent);
  const keptOk = /כסף/.test(kept || '');
  if (!keptOk) bad++;
  console.log(`${keptOk ? '✓' : '✗'} manual folder survives a reload: ${kept}`);
  await page.screenshot({ path: process.env.SHOT || 'docs-check.png' });

  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  console.log(`${files.length + 1 - bad}/${files.length + 1} checks passed`);
  process.exit(bad || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
