// Reading a document's text on the device, so the מסמכים tagging can look past the
// file name — without the file ever leaving the phone.
//
// The ladder, cheapest first; each rung is the fallback for the one above it:
//   1. a PDF's own text layer (pdf.js) — most tickets, bookings and policies are text
//      PDFs: a few MB of memory, done in about a second
//   2. plain-text formats read directly: .txt, .html and .eml (tags and MIME noise
//      stripped), .docx (the one XML inside the zip, inflated by the browser itself)
//   3. the browser's own OCR (TextDetector, the Shape Detection API) where the platform
//      offers it — the OS engine on a downscaled copy, no download, nearly free
//   4. tesseract.js — WASM OCR in a worker. Real memory (~100MB while it runs) and a
//      one-time download (engine + two language models, ~8MB, cached after), so only on
//      a device that looks up to it, on a downscaled copy of the image, under a time
//      budget. A phone that is slow, tight on memory or on a metered connection skips
//      this rung — the caller keeps the name-based tag and the manual picker.
//   5. nothing: `via: 'none'`, and the folder falls back to the name or to "אחר".
//
// The engines load from jsDelivr, pinned, and only when a rung actually needs them.
// That is a library download, not an upload: no byte of the document goes to the CDN
// or anywhere else, and the text that comes out stays in this page. A self-hosted
// mirror can be pointed at with window.TRIPMAKER_DOC_LIBS = { base, langPath } before
// this script loads (the end-to-end check does exactly that).
const DocText = (() => {
  const cfg = Object.assign({
    base: 'https://cdn.jsdelivr.net/npm',
    pdfjs: '6.3.289',
    tesseract: '7.0.0',
    tesseractCore: '7.0.0',
    langs: 'eng+heb',
    langPath: null,       // null → tesseract's own default: @tesseract.js-data on jsDelivr
    maxEdge: 1800,        // the OCR copy's long edge, px — plenty for a ticket, cheap on memory
    pdfBudgetMs: 15000,   // reading the text layer, per document
    ocrBudgetMs: 35000,   // engine download + recognition, per document
    idleMs: 20000,        // how long the WASM worker lingers after its last job
  }, window.TRIPMAKER_DOC_LIBS || {});

  // ---- what this device can afford ----

  function device() {
    const mem = navigator.deviceMemory;              // Chrome/Edge only — undefined is "unknown", not "small"
    const cores = navigator.hardwareConcurrency;
    const conn = navigator.connection || {};
    return {
      lowEnd: (mem !== undefined && mem <= 2) || (cores !== undefined && cores <= 2),
      frugal: !!conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''),
      wasm: typeof WebAssembly === 'object' && typeof Worker === 'function',
      native: typeof TextDetector === 'function',
    };
  }

  // { pdf, native, wasm, reason } — `wasm` is whether the heavy rung is allowed here,
  // `reason` says why not ('no-wasm' | 'low-end' | 'save-data')
  function capabilities() {
    const d = device();
    let reason = '';
    if (!d.wasm) reason = 'no-wasm';
    else if (d.lowEnd) reason = 'low-end';
    else if (d.frugal) reason = 'save-data';
    return { pdf: true, native: d.native, wasm: !reason, reason };
  }

  // ---- small utilities ----

  const letters = (s) => (String(s || '').match(/[A-Za-z֐-׿]/g) || []).length;

  function withTimeout(promise, ms, onTimeout) {
    let t;
    const timer = new Promise((_, reject) => { t = setTimeout(() => { onTimeout?.(); reject(new Error('timeout')); }, ms); });
    return Promise.race([promise, timer]).finally(() => clearTimeout(t));
  }

  // dynamic import() is syntax — spelled out here so a browser without it fails at
  // call time (caught, rung skipped) instead of refusing to parse this whole file
  const dynImport = (url) => new Function('u', 'return import(u)')(url); // eslint-disable-line no-new-func

  const scripts = {};
  function loadScript(url) {
    if (!scripts[url]) {
      scripts[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { delete scripts[url]; reject(new Error('script ' + url)); };
        document.head.appendChild(s);
      });
    }
    return scripts[url];
  }

  let status = null; // the current job's onStatus, for the worker's logger
  const say = (msg) => { try { status?.(msg); } catch { /* UI's problem, not ours */ } };

  // ---- what kind of file is this ----

  function kindOf(file) {
    const type = (file.type || '').toLowerCase();
    const ext = (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();
    if (type.startsWith('image/') || /^(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/.test(ext)) return 'image';
    if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') return 'docx';
    if (type === 'message/rfc822' || ext === 'eml') return 'eml';
    if (type === 'text/html' || /^html?$/.test(ext)) return 'html';
    if (type.startsWith('text/') || /^(txt|md|csv|json|ics|vcf|rtf)$/.test(ext)) return 'text';
    return 'none';
  }

  // ---- rung 1: a PDF's text layer (and, for a scan, its first page as an image) ----

  let pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) {
      const dir = `${cfg.base}/pdfjs-dist@${cfg.pdfjs}/legacy/build`;
      pdfjsP = dynImport(`${dir}/pdf.min.mjs`).then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = `${dir}/pdf.worker.min.mjs`;
        return lib;
      }).catch((e) => { pdfjsP = null; throw e; });
    }
    return pdfjsP;
  }

  async function readPdf(file, allowOcr) {
    say('קוראים את המסמך…');
    const lib = await pdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({
      data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false,
    }).promise;
    try {
      const parts = [];
      // the metadata is free and often names the sender outright ("Booking.com", "EL AL")
      try {
        const { info } = await doc.getMetadata();
        for (const k of ['Title', 'Subject', 'Author', 'Keywords', 'Creator', 'Producer']) {
          if (info && typeof info[k] === 'string' && info[k].trim()) parts.push(info[k].trim());
        }
      } catch { /* no metadata — fine */ }
      const pages = Math.min(doc.numPages, 4); // the type of a document is decided on its first pages
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        let line = '';
        for (const it of tc.items) {
          if (it.str) line += it.str;
          if (it.hasEOL) { parts.push(line); line = ''; } else if (it.str && !/\s$/.test(it.str)) line += ' ';
        }
        if (line) parts.push(line);
        page.cleanup();
      }
      const text = parts.join('\n');
      if (letters(text) >= 40) return { text, via: 'pdf' };
      // no text layer worth the name — a scan. The first page becomes an image and
      // takes the OCR ladder like a photo would.
      if (!allowOcr) return { text, via: letters(text) ? 'pdf' : 'none' };
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(3, cfg.maxEdge / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      const ocr = await ocrCanvas(canvas);
      canvas.width = canvas.height = 0;
      if (ocr.via === 'none') return { text, via: letters(text) ? 'pdf' : 'none' };
      return { text: [text, ocr.text].filter(Boolean).join('\n'), via: `pdf-${ocr.via}` };
    } finally {
      try { await doc.destroy(); } catch { /* already gone */ }
    }
  }

  // ---- rung 2: text formats ----

  function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#x?[0-9a-f]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      if (k === 'nbsp') return ' ';
      try { return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)); } catch { return m; }
    });
  }

  function htmlToText(html) {
    const withBreaks = html.replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/td|\/th)\b[^>]*>/gi, '$&\n');
    try {
      const doc = new DOMParser().parseFromString(withBreaks, 'text/html'); // inert: nothing in it runs
      doc.querySelectorAll('script,style,noscript,template').forEach((e) => e.remove());
      return `${doc.title || ''}\n${doc.body ? doc.body.textContent : ''}`;
    } catch {
      return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '));
    }
  }

  // quoted-printable → bytes → UTF-8; the input is 7-bit by definition
  function qpDecode(s) {
    const joined = s.replace(/=\r?\n/g, '');
    const bytes = new Uint8Array(joined.length);
    let n = 0;
    for (let i = 0; i < joined.length; i++) {
      const c = joined[i];
      if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.substr(i + 1, 2))) { bytes[n++] = parseInt(joined.substr(i + 1, 2), 16); i += 2; } else bytes[n++] = joined.charCodeAt(i) & 0xff;
    }
    try { return new TextDecoder('utf-8').decode(bytes.subarray(0, n)); } catch { return joined; }
  }

  // RFC 2047 "encoded words" in headers: =?UTF-8?B?...?= and =?UTF-8?Q?...?=
  function decodeWords(s) {
    return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, body) => {
      try {
        if (/b/i.test(enc)) {
          const bin = atob(body);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          return new TextDecoder(cs).decode(bytes);
        }
        return qpDecode(body.replace(/_/g, ' '));
      } catch { return m; }
    });
  }

  function emlToText(raw) {
    const header = (k) => decodeWords((new RegExp(`^${k}:[ \\t]*((?:.+(?:\\r?\\n[ \\t].*)*))`, 'im').exec(raw)?.[1] || '').replace(/\r?\n[ \t]+/g, ' '));
    let body = raw.replace(/^[A-Za-z0-9+/=]{60,}\r?$/gm, ''); // base64 attachment bodies — noise, and big
    if (/content-transfer-encoding:\s*quoted-printable/i.test(raw)) body = qpDecode(body);
    if (/<\/?(?:html|body|table|div|p)\b/i.test(body)) body = htmlToText(body);
    return `${header('Subject')}\n${header('From')}\n${body}`;
  }

  async function readText(file, kind) {
    const raw = await (file.text ? file.text() : new Response(file).text());
    if (kind === 'html') return { text: htmlToText(raw), via: 'text' };
    if (kind === 'eml') return { text: emlToText(raw), via: 'text' };
    return { text: raw, via: 'text' };
  }

  // a .docx is a zip; the text is one XML entry. The browser inflates it — no library.
  async function zipEntry(u8, wanted) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (name !== wanted) continue;
      if (dv.getUint32(off, true) !== 0x04034b50) throw new Error('zip');
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const data = u8.subarray(start, start + csize);
      if (method === 0) return td.decode(data);
      if (method !== 8) throw new Error('zip-method');
      const inflated = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(inflated).text();
    }
    throw new Error('zip-missing');
  }

  async function readDocx(file) {
    if (typeof DecompressionStream !== 'function') throw new Error('no-inflate');
    const xml = await zipEntry(new Uint8Array(await file.arrayBuffer()), 'word/document.xml');
    const text = decodeEntities(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, ''));
    return { text, via: 'docx' };
  }

  // ---- rungs 3 and 4: OCR on a canvas ----

  function loadImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  // decode once, straight into a downscaled canvas — the original may be a 12MP photo
  async function decodeToCanvas(file) {
    let bmp = null;
    try { bmp = await createImageBitmap(file); } catch { /* HEIC where unsupported, or a broken file — the <img> road next */ }
    const src = bmp || await loadImg(file);
    const w = bmp ? bmp.width : src.naturalWidth;
    const h = bmp ? bmp.height : src.naturalHeight;
    if (!w || !h) throw new Error('image');
    const k = Math.min(1, cfg.maxEdge / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, canvas.width, canvas.height);
    bmp?.close?.();
    return canvas;
  }

  let workerP = null;
  let idleTimer = null;

  const STATUS = {
    'loading tesseract core': 'מורידים מנוע זיהוי טקסט (פעם אחת)…',
    'initializing tesseract': 'מכינים מנוע זיהוי טקסט…',
    'loading language traineddata': 'מורידים מודל שפה (פעם אחת)…',
    'initializing api': 'מכינים זיהוי טקסט…',
    'recognizing text': 'מזהים טקסט…',
  };

  function worker() {
    if (!workerP) {
      workerP = (async () => {
        say('טוענים מנוע זיהוי טקסט…');
        await loadScript(`${cfg.base}/tesseract.js@${cfg.tesseract}/dist/tesseract.min.js`);
        const opts = {
          workerPath: `${cfg.base}/tesseract.js@${cfg.tesseract}/dist/worker.min.js`,
          corePath: `${cfg.base}/tesseract.js-core@${cfg.tesseractCore}`,
          logger: (m) => {
            const label = STATUS[m.status];
            if (!label) return;
            say(m.status === 'recognizing text' && m.progress ? `${label} ${Math.round(m.progress * 100)}%` : label);
          },
        };
        if (cfg.langPath) opts.langPath = cfg.langPath;
        return Tesseract.createWorker(cfg.langs, 1, opts); // 1 = LSTM only: the smaller core
      })().catch((e) => { workerP = null; throw e; });
    }
    return workerP;
  }

  // the worker holds ~100MB while alive; drop it once the batch has gone quiet
  function release() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const p = workerP;
    workerP = null;
    if (p) p.then((w) => w.terminate()).catch(() => {});
  }
  function touch() {
    clearTimeout(idleTimer);
    if (workerP) idleTimer = setTimeout(release, cfg.idleMs);
  }

  async function ocrCanvas(canvas) {
    const d = device();
    if (d.native) {
      try {
        say('מזהים טקסט…');
        const blocks = await withTimeout(new TextDetector().detect(canvas), 8000);
        const text = blocks.map((b) => b.rawValue).filter(Boolean).join('\n');
        if (letters(text) >= 12) return { text, via: 'native' };
      } catch { /* offered in name only, or failed on this image — the WASM rung is next */ }
    }
    if (!d.wasm || d.lowEnd || d.frugal) return { text: '', via: 'none' };
    try {
      const w = await withTimeout(worker(), cfg.ocrBudgetMs, release);
      const { data } = await withTimeout(w.recognize(canvas), cfg.ocrBudgetMs, release);
      touch();
      return { text: data?.text || '', via: 'ocr' };
    } catch {
      release(); // a wedged or timed-out worker is not reused
      return { text: '', via: 'none' };
    }
  }

  // ---- the entry point ----

  // { text, via, kind } — via: 'pdf' | 'pdf-native' | 'pdf-ocr' | 'text' | 'docx' |
  // 'native' | 'ocr' | 'none'. Never throws: a document we can't read is `via: 'none'`.
  async function extract(file, { onStatus } = {}) {
    status = onStatus || null;
    const kind = kindOf(file);
    const allowOcr = capabilities().native || capabilities().wasm;
    let out = { text: '', via: 'none' };
    try {
      if (kind === 'pdf') out = await withTimeout(readPdf(file, allowOcr), cfg.pdfBudgetMs + cfg.ocrBudgetMs * 2, release);
      else if (kind === 'image' && allowOcr) {
        const canvas = await decodeToCanvas(file);
        out = await ocrCanvas(canvas);
        canvas.width = canvas.height = 0;
      } else if (kind === 'docx') out = await readDocx(file);
      else if (kind === 'text' || kind === 'html' || kind === 'eml') out = await readText(file, kind);
    } catch {
      out = { text: '', via: 'none' };
    } finally {
      status = null;
      touch();
    }
    return { text: String(out.text || '').slice(0, 60000), via: out.via, kind };
  }

  return { extract, capabilities, kindOf, release, cfg };
})();
