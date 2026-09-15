// מסמכים — the trip's important papers: flight tickets, passport, bookings, insurance.
//
// Nothing here leaves the phone. Files live in IndexedDB on this device, keyed by the
// signed-in user AND the trip, and the folder tagging runs in the browser: first on the
// file NAME (instant, at save time), then on the document's own TEXT — a PDF's text
// layer, or OCR of a photo, read on the device by doc-text.js — never on a server.
// There is no upload path on purpose: a passport scan that never reaches us is a
// passport scan we never have to protect. The cost is real, and the page no longer
// spells it out: another phone, or cleared site data, and the documents are gone.
//
// The content pass is a background queue, one document at a time (OCR is memory), and
// it only ever touches documents the user hasn't filed by hand: a folder you picked is
// yours, whatever the text says. The rules live in doc-classify.js, with a fixture
// check in tools/docs-classify-check.js.
const TripDocs = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const DB_NAME = 'tripmaker-docs';
  const STORE = 'docs';
  const MAX_BYTES = 25 * 1024 * 1024;

  const { FOLDERS, folderOf } = DocClassify;

  const ICON = {
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    lock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    share: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>',
    open: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };

  // ---- storage: IndexedDB, one store, an index by owner (user:trip) ----

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('no-idb'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const st = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        st.createIndex('owner', 'owner');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb'));
      req.onblocked = () => reject(new Error('blocked'));
    });
  }

  async function run(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('abort'));
      });
    } finally { db.close(); }
  }
  const list = (owner) => run('readonly', (s) => s.index('owner').getAll(owner));
  const countOf = (owner) => run('readonly', (s) => s.index('owner').count(owner));
  const add = (doc) => run('readwrite', (s) => s.add(doc));
  const put = (doc) => run('readwrite', (s) => s.put(doc));
  const remove = (id) => run('readwrite', (s) => s.delete(id));

  const ownerKey = (ctx) => (TRIPMAKER.user ? `${TRIPMAKER.user.id}:${ctx.trip.share_code}` : null);

  // ---- helpers ----

  // the instant tag, from the name alone — what a document is filed under the moment
  // it's saved. The content pass may move it later.
  const classify = (file) => DocClassify.classify({ name: file.name });

  // a small JPEG of an image, for the tile — the original stays untouched
  function makeThumb(file) {
    return new Promise((resolve) => {
      if (!/^image\//.test(file.type)) return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
      img.onload = () => {
        try {
          const k = Math.min(1, 480 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          done(c.toDataURL('image/jpeg', 0.78));
        } catch { done(null); }
      };
      img.onerror = () => done(null);
      img.src = url;
    });
  }

  const fmtSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtDate = (t) => new Date(t).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
  const isImage = (d) => /^image\//.test(d.type);
  const isPdf = (d) => d.type === 'application/pdf' || /\.pdf$/i.test(d.name);
  const isTextish = (d) => /\.(docx|txt|md|html?|eml|csv|rtf)$/i.test(d.name) || /^text\//.test(d.type || '');
  const kindEmoji = (d) => (isPdf(d) ? '📕' : isImage(d) ? '🖼️' : isTextish(d) ? '📝' : '📄');
  const ACCEPT = 'image/*,application/pdf,.pdf,.txt,.md,.html,.htm,.eml,.docx';

  // how the text was read, for the sheet — honest about which rung did the work
  const READ_LABEL = { pdf: 'טקסט ה-PDF', 'pdf-ocr': 'OCR במכשיר', 'pdf-native': 'OCR במכשיר', ocr: 'OCR במכשיר', native: 'OCR במכשיר', text: 'הטקסט', docx: 'הטקסט' };

  const PRIVACY = `${ICON.lock}<span>שמור ומאובטח במכשיר הזה בלבד — לא עולה לשרת ולא נשלח לאף אחד.</span>`;

  // =================================================================
  //  RENDER
  // =================================================================

  function render(slots, ctx) {
    const { page, body, tools } = slots;
    page.classList.add('page-docs');
    const urls = []; // object URLs handed to the sheet — revoked when the page closes
    ctx.onDocsClose = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.length = 0; };

    if (!TRIPMAKER.user) {
      tools.innerHTML = '';
      body.innerHTML = `
        <div class="tp-inner">
          <div class="docs-empty glass">
            <div class="de-icons" aria-hidden="true">✈️ 🛂 🏨 🛡️</div>
            <h3>המסמכים של הטיול, במקום אחד</h3>
            <p>כרטיסי טיסה, דרכון, הזמנות מלון, ביטוח — מוסיפים פעם אחת, והם מסודרים לתיקיות אוטומטית. כדי שיישמרו לחשבון שלכם צריך להיות מחוברים.</p>
            <button type="button" class="btn btn-amber" id="docs-login">התחברות</button>
            <p class="de-privacy">🔒 המסמכים נשמרים במכשיר הזה בלבד, ולא עולים לשרת.</p>
          </div>
        </div>`;
      body.querySelector('#docs-login').onclick = () => openAuthModal(() => location.reload(), 'login', 'trip_docs');
      return;
    }

    const owner = ownerKey(ctx);
    let docs = [];
    let folder = 'all';

    tools.innerHTML = `
      <button type="button" class="btn btn-amber docs-add" id="docs-add">${ICON.plus}<span>הוספה</span></button>
      <input type="file" id="docs-file" multiple accept="${ACCEPT}" hidden>`;
    const fileInput = tools.querySelector('#docs-file');
    tools.querySelector('#docs-add').onclick = () => fileInput.click();
    fileInput.onchange = () => { importFiles([...fileInput.files]); fileInput.value = ''; };

    async function refresh() {
      try { docs = await list(owner); } catch {
        body.innerHTML = `<div class="tp-inner"><div class="docs-empty glass"><div class="de-icons">🙈</div>
          <h3>הדפדפן הזה לא מאפשר לשמור קבצים</h3><p>בגלישה פרטית, או כשאחסון האתר חסום, אין איפה לשמור את המסמכים במכשיר. נסו בחלון רגיל.</p></div></div>`;
        return;
      }
      docs.sort((a, b) => b.addedAt - a.addedAt);
      TripPages.badge('docs', docs.length);
      // anything still on its name-only tag gets the content pass — new documents, and
      // the ones saved before the page could read them. Queued before the paint, so the
      // tiles come up already marked as being read.
      docs.filter((d) => d.auto && !d.scanned).forEach(enqueue);
      paint();
    }

    function paint() {
      if (!docs.length) {
        body.innerHTML = `
          <div class="tp-inner">
            <div class="docs-empty glass">
              <div class="de-icons" aria-hidden="true">✈️ 🛂 🏨 🛡️</div>
              <h3>המסמכים של הטיול, במקום אחד</h3>
              <p>כרטיסי טיסה, דרכון, הזמנות מלון, ביטוח — מוסיפים פעם אחת, והתיוג החכם מסדר אותם לתיקיות. בשדה התעופה הכול במרחק לחיצה, גם בלי קליטה.</p>
              <button type="button" class="btn btn-amber" id="docs-first">${ICON.plus} הוספת מסמך ראשון</button>
              <p class="de-privacy">🔒 נשמר במכשיר הזה בלבד — לא עולה לשרת ולא נשלח לאף אחד.</p>
            </div>
          </div>`;
        body.querySelector('#docs-first').onclick = () => fileInput.click();
        return;
      }
      const counts = {};
      docs.forEach((d) => { counts[d.folder] = (counts[d.folder] || 0) + 1; });
      if (folder !== 'all' && !counts[folder]) folder = 'all';
      const shown = folder === 'all' ? docs : docs.filter((d) => d.folder === folder);
      body.innerHTML = `
        <div class="tp-inner">
          <div class="docs-privacy">${PRIVACY}</div>
          ${scanning.size ? `<div class="docs-scan" role="status"><span class="ds-spin" aria-hidden="true"></span><span class="docs-scan-text">${esc(scanStatus || 'מזהים את סוג המסמך לפי התוכן…')}</span></div>` : ''}
          <div class="docs-folders" role="tablist">
            <button type="button" role="tab" class="docs-folder${folder === 'all' ? ' on' : ''}" data-f="all">הכל<b>${docs.length}</b></button>
            ${FOLDERS.filter((f) => counts[f.key]).map((f) =>
              `<button type="button" role="tab" class="docs-folder${folder === f.key ? ' on' : ''}" data-f="${f.key}">${f.emoji} ${f.name}<b>${counts[f.key]}</b></button>`).join('')}
          </div>
          <div class="docs-grid">
            ${shown.map((d) => {
              const f = folderOf(d.folder);
              const mark = scanning.has(d.id) ? '<span class="scan" title="מזהים את סוג המסמך לפי התוכן">🔍</span>'
                : d.auto ? `<span class="auto" title="${d.via === 'content' ? 'תויג אוטומטית לפי התוכן' : 'תויג אוטומטית לפי שם הקובץ'}">✨</span>` : '';
              return `
                <button type="button" class="doc-tile${scanning.has(d.id) ? ' is-scanning' : ''}" data-id="${d.id}" aria-label="${esc(d.name)}">
                  <span class="dt-thumb">${d.thumb ? `<img src="${d.thumb}" alt="">` : `<span>${kindEmoji(d)}</span>`}</span>
                  <span class="dt-name">${esc(d.name)}</span>
                  <span class="dt-tags"><span>${f.emoji} ${f.name}</span>${mark}</span>
                </button>`;
            }).join('')}
          </div>
        </div>`;
      body.querySelectorAll('.docs-folder').forEach((b) => { b.onclick = () => { folder = b.dataset.f; paint(); }; });
      body.querySelectorAll('.doc-tile').forEach((t) => {
        t.onclick = () => { const d = docs.find((x) => x.id === +t.dataset.id); if (d) openDoc(d); };
      });
    }

    async function importFiles(files) {
      if (!files.length) return;
      let added = 0, skipped = 0;
      TripPages.toast(files.length > 1 ? `שומרים ${files.length} מסמכים…` : 'שומרים…');
      for (const f of files) {
        if (f.size > MAX_BYTES) { skipped++; continue; }
        try {
          const { folder: fk, tags, via } = classify(f);
          const thumb = await makeThumb(f);
          await add({ owner, name: f.name, type: f.type, size: f.size, addedAt: Date.now(), folder: fk, tags, via, auto: true, scanned: false, blob: f, thumb });
          added++;
        } catch { skipped++; }
      }
      // ask the browser to keep this origin's storage out of its eviction sweeps —
      // a boarding pass that vanishes at the gate is worse than no feature at all
      try { navigator.storage?.persist?.(); } catch { /* not offered — fine */ }
      await refresh();
      if (added && !skipped) TripPages.toast(added === 1 ? `נשמר ותויג: ${folderOf(classify(files[0]).folder).name} ✓` : `${added} מסמכים נשמרו ותויגו ✓`, 'ok');
      else if (added) TripPages.toast(`${added} נשמרו, ${skipped} דולגו (עד 25MB לקובץ)`);
      else TripPages.toast('לא נשמר — קובץ גדול מדי או לא נתמך');
      TRIPMAKER.track?.('docs_add', { code: ctx.trip.share_code, count: added });
    }

    // ---- the content pass: one document at a time, in the background ----
    //
    // A document is saved and on screen under its name-based tag before any of this
    // runs, so a slow OCR (or one that never finishes) costs nothing but the upgrade.

    const scanning = new Set(); // ids in the queue or under the engine right now
    const queue = [];
    let pumping = false;
    let scanStatus = '';

    function enqueue(d) {
      if (!d.auto || d.scanned || scanning.has(d.id)) return;
      scanning.add(d.id);
      queue.push(d.id);
      setTimeout(pump, 0); // after the paint that follows the enqueue loop
    }

    function setStatus(msg) {
      scanStatus = msg;
      const el = body.querySelector('.docs-scan-text');
      if (el) el.textContent = msg;
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      let changed = 0;
      let last = null;
      while (queue.length) {
        const id = queue.shift();
        const d = docs.find((x) => x.id === id);
        if (d) {
          setStatus(`מזהים את סוג המסמך: ${d.name}`);
          try {
            const moved = await analyze(d);
            if (moved) { changed++; last = moved; }
          } catch { /* the name-based tag stands */ }
        }
        scanning.delete(id);
        paint();
      }
      pumping = false;
      scanStatus = '';
      DocText.release(); // the OCR engine holds real memory; the batch is over
      if (changed === 1) TripPages.toast(`✨ תויג לפי התוכן: ${folderOf(last.folder).emoji} ${folderOf(last.folder).name}`, 'ok');
      else if (changed > 1) TripPages.toast(`✨ ${changed} מסמכים תויגו לפי התוכן`, 'ok');
    }

    // returns the document when the content pass moved it to another folder
    async function analyze(d) {
      const { text, via: read, kind } = await DocText.extract(d.blob, { onStatus: setStatus });
      // the list may have been reloaded, or the document deleted, while the engine ran
      const cur = docs.find((x) => x.id === d.id);
      if (!cur) return null;
      if (!cur.auto) { cur.scanned = true; await put(cur); return null; } // filed by hand meanwhile — their pick stands
      const c = DocClassify.classify({ name: cur.name, text });
      const moved = c.folder !== cur.folder;
      Object.assign(cur, { folder: c.folder, tags: c.tags, via: c.via, read, scanned: true });
      await put(cur);
      TRIPMAKER.track?.('docs_scan', { code: ctx.trip.share_code, kind, read, folder: c.folder, moved });
      return moved ? cur : null;
    }

    function autoLine(d) {
      if (scanning.has(d.id)) return '🔍 מזהים את סוג המסמך לפי התוכן…';
      if (!d.auto) return 'תיקייה שבחרתם ידנית';
      const reasons = d.tags?.length ? ` ("${d.tags.map(esc).join('", "')}")` : '';
      if (d.via === 'content') return `✨ תויג אוטומטית לפי תוכן המסמך${READ_LABEL[d.read] ? ` — ${READ_LABEL[d.read]}` : ''}${reasons} — אפשר לשנות`;
      if (d.folder === 'other') {
        if (!d.scanned) return 'עוד לא זוהה סוג המסמך — בחרו תיקייה';
        return d.read && d.read !== 'none' ? 'לא זוהה סוג המסמך מתוך התוכן — בחרו תיקייה' : 'לא הצלחנו לקרוא את המסמך במכשיר הזה — בחרו תיקייה';
      }
      return `✨ תויג אוטומטית לפי שם הקובץ${reasons} — אפשר לשנות`;
    }

    function openDoc(d) {
      const f = folderOf(d.folder);
      const file = d.blob;
      const url = URL.createObjectURL(file);
      urls.push(url);
      const canShare = !!(navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch { return false; } })());
      TripPages.sheet('doc-sheet', {
        title: esc(d.name),
        sub: `${kindEmoji(d)} ${fmtSize(d.size)} · נוסף ב-${fmtDate(d.addedAt)}`,
        html: `
          ${d.thumb ? `<img class="ds-preview" src="${d.thumb}" alt="" title="לחיצה להגדלה">` : `<div class="ds-file" aria-hidden="true">${kindEmoji(d)}</div>`}
          <div class="ds-row">
            <label for="ds-folder">תיקייה</label>
            <select id="ds-folder">${FOLDERS.map((x) => `<option value="${x.key}"${x.key === d.folder ? ' selected' : ''}>${x.emoji} ${x.name}</option>`).join('')}</select>
          </div>
          <div class="ds-auto">${autoLine(d)}</div>
          <div class="ds-actions">
            <a class="btn btn-amber" href="${url}" target="_blank" rel="noopener">${ICON.open} פתיחה</a>
            ${canShare ? `<button type="button" class="btn btn-ghost ds-share">${ICON.share} שיתוף</button>` : ''}
            <button type="button" class="btn btn-ghost ds-del">${ICON.trash} מחיקה</button>
          </div>
          <div class="ds-privacy">${PRIVACY}</div>`,
        onOpen: (bodyEl) => {
          bodyEl.querySelector('.ds-preview')?.addEventListener('click', () => TRIPMAKER.openLightbox(url));
          bodyEl.querySelector('#ds-folder').onchange = async (e) => {
            d.folder = e.target.value;
            d.auto = false; // from here on the content pass leaves this one alone
            try { await put(d); } catch { TripPages.toast('השינוי לא נשמר'); return; }
            bodyEl.querySelector('.ds-auto').textContent = `הועבר ל${folderOf(d.folder).name}`;
            paint();
          };
          bodyEl.querySelector('.ds-share')?.addEventListener('click', async () => {
            try { await navigator.share({ files: [file], title: d.name }); } catch { /* cancelled */ }
          });
          bodyEl.querySelector('.ds-del').onclick = async () => {
            if (!confirm(`למחוק את "${d.name}" מהמכשיר?`)) return;
            try { await remove(d.id); } catch { TripPages.toast('המחיקה נכשלה'); return; }
            TripPages.closeSheet(() => { refresh(); TripPages.toast('נמחק', 'ok'); });
          };
        },
      });
      TRIPMAKER.track?.('docs_open', { code: ctx.trip.share_code, folder: f.key });
    }

    refresh();
  }

  // how many documents this user keeps for this trip on this device — for the dock badge
  async function count(ctx) {
    const owner = ownerKey(ctx);
    if (!owner) return 0;
    try { return await countOf(owner); } catch { return 0; }
  }

  return { render, count, classify };
})();
