// תזכורות — the trip's moments (lib/moments.js): the bus, the flight, the check-in, the QR
// at the border. Each one gets a push BEFORE it, and the tap on that push lands here — on
// the moment's own sheet, with its documents open — which has to work in the one place the
// traveller actually is: a bus stop with no signal. So the sheet is built from what the
// phone already holds: the trip (the service worker keeps the last answer of
// /api/trips/code/:code, moments included) and the documents (IndexedDB, trip-docs.js —
// the moment carries only their names). Nothing on this screen waits for the network
// except the things that are about the network: the Gmail scan and the AI reading.
//
// Three ways a moment arrives, all of them past a person: the chats write one when a
// ticket is handed to them (the same card as a hotel, with undo); the מסמכים sheet offers
// one for a document it read ("תזכורת מהמסמך"); and here — a form, or "ייבוא מהמייל",
// which reads the traveller's Gmail (with their switch on, lib/connectors.js) and PROPOSES
// what it found. A proposal is ticked or dismissed; it is never active on its own.
const TripMoments = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const { KINDS, KIND_KEYS, DETAIL_KEYS, DETAIL_LABELS, LEAD_OPTIONS, leadText } = MOMENT_KINDS;
  const HASH = /^#moment-(\d+)$/;

  const ICON = {
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    mail: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
    bell: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    open: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    edit: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    lock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  };

  let ctx = null;      // { trip, state, canEdit } from trip.js; state.moments is the list
  let tz = null;       // the trip's own clock, from the server
  let slots = null;    // the page's slots while it is open
  const urls = [];     // object URLs handed to sheets — revoked when the page closes

  const list = () => (ctx && Array.isArray(ctx.state.moments) ? ctx.state.moments : []);
  const api = (path, opts) => TRIPMAKER.api(`/api/trips/code/${ctx.trip.share_code}/moments${path}`, opts);
  const byId = (id) => list().find((m) => m.id === +id);

  // ---- time, as the traveller reads it ----

  // local_time is 'YYYY-MM-DDTHH:MM' on the clock where the moment happens; a Date built
  // from it as UTC is formatted with timeZone UTC, so the browser's own zone never leaks in
  const localDate = (m) => (m.local_time ? new Date(m.local_time.slice(0, 16) + ':00Z') : null);
  const clock = (m) => (m.local_time ? m.local_time.slice(11, 16) : '');
  const dayLabel = (m) => {
    const d = localDate(m);
    return d ? d.toLocaleDateString('he-IL', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }) : '';
  };
  const tripDay = (m) => {
    if (!ctx.trip.start_date || !m.local_time) return null;
    const start = new Date(TRIPMAKER.isoDate(new Date(ctx.trip.start_date)) + 'T00:00:00Z');
    const n = Math.round((new Date(m.local_time.slice(0, 10) + 'T00:00:00Z') - start) / 86400000) + 1;
    return n >= 1 && n <= (ctx.trip.days || 1) ? n : null;
  };
  const minutesLeft = (m) => (new Date(m.starts_at).getTime() - Date.now()) / 60000;
  const isPast = (m) => minutesLeft(m) < -180;
  // "עוד 3 שעות", "עכשיו", "עבר" — and, well ahead, the day
  function relative(m) {
    const left = minutesLeft(m);
    if (left < -180) return 'עבר';
    if (left < 0) return 'עכשיו';
    return leadText(left);
  }
  const tzLabel = (z) => (z === 'Asia/Jerusalem' ? 'שעון ישראל' : z ? `שעון ${z.split('/').pop().replace(/_/g, ' ')}` : '');
  const kindOf = (m) => KINDS[m.kind] || KINDS.other;
  const whenLine = (m) => [dayLabel(m), clock(m) && `בשעה ${clock(m)}`, m.tz && m.tz !== 'Asia/Jerusalem' ? tzLabel(m.tz) : ''].filter(Boolean).join(' · ');

  // ---- the documents: matched on the device, never fetched for the sheet ----

  async function docsFor(m) {
    const names = (m.docs || []).map((d) => d.name);
    if (!names.length || typeof TripDocs === 'undefined') return [];
    const have = await TripDocs.find(ctx, names).catch(() => []);
    return names.map((name) => ({ ref: (m.docs || []).find((d) => d.name === name), doc: have.find((d) => d.name === name) || null }));
  }

  // a document that lives in Gmail and not yet on this phone: fetched once through the
  // proxy (routes/moments.js), filed in IndexedDB, and from then on opened offline
  async function fetchFromGmail(ref) {
    if (!ref || !ref.message || !ref.attachment) return null;
    const p = new URLSearchParams({ message: ref.message, id: ref.attachment, type: ref.mime || '', name: ref.name });
    const res = await fetch(`/api/connectors/gmail/attachment?${p}`, { headers: { Authorization: 'Bearer ' + (TRIPMAKER.token || '') } });
    if (!res.ok) throw new Error('fetch');
    const blob = await res.blob();
    const file = new File([blob], ref.name, { type: ref.mime || blob.type || 'application/octet-stream' });
    await TripDocs.stash(ctx, file);
    return file;
  }

  // ---- the page ----

  function render(s) {
    slots = s;
    s.page.classList.add('page-moments');
    const { tools } = s;
    tools.innerHTML = `
      <button type="button" class="btn btn-ghost mo-scan" id="mo-scan" title="לקרוא מהמייל אישורי טיסה, מלון וכרטיסים">${ICON.mail}<span>מהמייל</span></button>
      <button type="button" class="btn btn-amber" id="mo-add">${ICON.plus}<span>הוספה</span></button>`;
    tools.querySelector('#mo-add').onclick = () => openForm(null);
    tools.querySelector('#mo-scan').onclick = scan;
    paint();
    if (!tz) api('').then((r) => { tz = r.tz || null; if (Array.isArray(r.moments)) { ctx.state.moments = r.moments; paint(); } }).catch(() => { /* offline: what the trip brought along stands */ });
  }

  function onClose() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.length = 0;
    slots = null;
  }

  function rowHtml(m) {
    const k = kindOf(m);
    const d = m.details || {};
    const docs = (m.docs || []).length;
    const sub = [d.code && `הזמנה ${d.code}`, d.number, d.platform && `רציף ${d.platform}`, d.gate && `שער ${d.gate}`, d.address].filter(Boolean).join(' · ');
    const left = minutesLeft(m);
    const soon = left >= 0 && left <= m.lead_minutes;
    return `
      <button type="button" class="mo-row${isPast(m) ? ' is-past' : ''}${soon ? ' is-soon' : ''}${m.status === 'proposed' ? ' is-proposed' : ''}" data-id="${m.id}">
        <span class="mo-em" aria-hidden="true">${k.emoji}</span>
        <span class="mo-text">
          <b>${esc(m.title)}</b>
          <small>${esc(whenLine(m))}${tripDay(m) ? ` · יום ${tripDay(m)}` : ''}</small>
          ${sub ? `<small class="mo-sub">${esc(sub)}</small>` : ''}
        </span>
        <span class="mo-side">
          <em>${esc(relative(m))}</em>
          ${docs ? `<i title="${docs === 1 ? 'מסמך אחד מצורף' : `${docs} מסמכים מצורפים`}">📎 ${docs}</i>` : ''}
          ${m.notified_at && !isPast(m) ? '<i title="ההתראה נשלחה">🔔</i>' : ''}
        </span>
      </button>`;
  }

  function paint() {
    if (!slots) return;
    const all = list();
    const proposed = all.filter((m) => m.status === 'proposed');
    const active = all.filter((m) => m.status !== 'proposed');
    const upcoming = active.filter((m) => !isPast(m));
    const past = active.filter(isPast);
    badge();
    if (!all.length) {
      slots.body.innerHTML = `
        <div class="tp-inner">
          <div class="docs-empty glass">
            <div class="de-icons" aria-hidden="true">🚌 ✈️ 🏨 🛂</div>
            <h3>שלא תפספסו את האוטובוס</h3>
            <p>כל כרטיס, טיסה או צ׳ק-אין נהיה תזכורת: הטלפון מצלצל בזמן הנכון, והמסמך — הכרטיס, האישור, ה-QR — נפתח בלחיצה אחת, גם בלי קליטה. צרפו כרטיס לצ׳אט, בקשו מה-AI לקרוא את המייל, או הוסיפו ידנית.</p>
            <div class="mo-empty-actions">
              <button type="button" class="btn btn-amber" id="mo-first">${ICON.plus} תזכורת ראשונה</button>
              <button type="button" class="btn btn-ghost" id="mo-first-scan">${ICON.mail} לקרוא מהמייל</button>
            </div>
            <p class="de-privacy">${ICON.lock} המסמכים נשארים במכשיר הזה; לשרת עולים רק השם, השעה ופרטי ההזמנה.</p>
          </div>
        </div>`;
      slots.body.querySelector('#mo-first').onclick = () => openForm(null);
      slots.body.querySelector('#mo-first-scan').onclick = scan;
      return;
    }
    slots.body.innerHTML = `
      <div class="tp-inner">
        ${proposed.length ? `
          <section class="mo-section mo-proposed glass">
            <div class="mo-head"><b>✉️ נמצאו במייל — לאישור</b><small>${proposed.length === 1 ? 'הזמנה אחת' : `${proposed.length} הזמנות`} שה-AI קרא מהמייל שלכם. אישור מפעיל את התזכורת ומוריד את המסמכים למכשיר.</small></div>
            <div class="mo-list">${proposed.map(rowHtml).join('')}</div>
            <div class="mo-foot">
              <button type="button" class="btn btn-amber" id="mo-approve-all">${ICON.check} אישור הכול</button>
              <button type="button" class="btn btn-ghost" id="mo-dismiss-all">לא רלוונטי</button>
            </div>
          </section>` : ''}
        <section class="mo-section">
          <div class="mo-head"><b>⏰ הקרובים</b><small>${upcoming.length ? 'ההתראה נשלחת לכל המשתתפים שהפעילו התראות, בזמן שכתוב ליד כל אחד' : 'אין תזכורות קרובות — הוסיפו אחת, או בקשו מה-AI לקרוא כרטיס'}</small></div>
          <div class="mo-list">${upcoming.map(rowHtml).join('')}</div>
        </section>
        ${past.length ? `<details class="mo-section mo-past"><summary>עברו · ${past.length}</summary><div class="mo-list">${past.map(rowHtml).join('')}</div></details>` : ''}
        <p class="mo-privacy">${ICON.lock} המסמכים עצמם נשארים במכשיר הזה בלבד; מי שמצטרף מטלפון אחר רואה את התזכורת ואת הפרטים, ואת המסמך רק אם הגיע מהמייל שלו.</p>
      </div>`;
    slots.body.querySelectorAll('.mo-row').forEach((r) => { r.onclick = () => { const m = byId(r.dataset.id); if (m) openSheet(m); }; });
    slots.body.querySelector('#mo-approve-all')?.addEventListener('click', () => approveMany(proposed));
    slots.body.querySelector('#mo-dismiss-all')?.addEventListener('click', async () => {
      if (!confirm(`להסיר ${proposed.length} הצעות? אפשר תמיד לסרוק את המייל שוב.`)) return;
      for (const m of proposed) await remove(m, { quiet: true });
      paint();
      TripPages.toast('ההצעות הוסרו');
    });
  }

  // the dock badge and the "עוד" line: what is pending, or what is next
  function badge() {
    const proposed = list().filter((m) => m.status === 'proposed').length;
    TripPages.badge('moments', proposed);
  }
  function moreDesc() {
    const all = list();
    const proposed = all.filter((m) => m.status === 'proposed').length;
    if (proposed) return `${proposed === 1 ? 'הזמנה אחת' : `${proposed} הזמנות`} מהמייל מחכות לאישור`;
    const next = all.filter((m) => m.status !== 'proposed' && minutesLeft(m) > -180).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
    if (next) return `הבא: ${kindOf(next).emoji} ${next.title} · ${relative(next)}`;
    return 'כרטיסים, טיסות וצ׳ק-אין — התראה לפני, עם המסמך פתוח';
  }

  // ---- the sheet: one moment, its details, its documents ----

  async function openSheet(m) {
    const k = kindOf(m);
    const d = m.details || {};
    const details = DETAIL_KEYS.filter((key) => d[key]).map((key) => {
      const v = d[key];
      const val = key === 'link' ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\//, '').slice(0, 40))}</a>`
        : key === 'phone' ? `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}">${esc(v)}</a>`
          : key === 'address' ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}" target="_blank" rel="noopener">${esc(v)}</a>`
            : esc(v);
      return `<div class="mo-detail"><span>${esc(DETAIL_LABELS[key])}</span><b>${val}</b></div>`;
    }).join('');
    const src = m.source || {};
    const srcLine = src.type === 'gmail' ? `נקרא מהמייל${src.subject ? `: "${esc(src.subject)}"` : ''}` : src.type === 'chat' ? 'נוצר בצ׳אט מתוך קובץ שצורף' : src.type === 'doc' ? `נקרא מתוך ${esc(src.name || 'מסמך')}` : src.type === 'scan' ? 'נמצא בסריקת המייל' : '';
    const lead = `ההתראה ${leadText(m.lead_minutes, { prefix: '' })} לפני${m.notified_at ? ' · נשלחה' : ''}`;
    TripPages.sheet('moment-sheet', {
      title: `${k.emoji} ${esc(m.title)}`,
      sub: `${esc(whenLine(m))}${tripDay(m) ? ` · יום ${tripDay(m)} בטיול` : ''}`,
      cls: 'moment-card',
      html: `
        <div class="mo-when${minutesLeft(m) >= 0 && minutesLeft(m) <= m.lead_minutes ? ' is-soon' : ''}">
          <b>${esc(relative(m))}</b>
          <small>${esc(lead)}</small>
        </div>
        <div class="mo-docs" id="mo-docs"><div class="mo-docs-loading">מחפשים את המסמכים במכשיר…</div></div>
        ${details ? `<div class="mo-details">${details}</div>` : ''}
        ${srcLine ? `<p class="mo-src">${srcLine}${src.link ? ` · <a href="${esc(src.link)}" target="_blank" rel="noopener">לפתיחה ב-Gmail</a>` : ''}</p>` : ''}
        <div class="ds-actions">
          ${m.status === 'proposed'
            ? `<button type="button" class="btn btn-amber mo-approve">${ICON.check} אישור והפעלה</button><button type="button" class="btn btn-ghost mo-del">לא רלוונטי</button>`
            : `<button type="button" class="btn btn-ghost mo-edit">${ICON.edit} עריכה</button>
               <button type="button" class="btn btn-ghost mo-test" title="לשלוח את ההתראה לטלפון שלכם עכשיו, לראות איך היא נראית ומה היא פותחת">${ICON.bell} לנסות עכשיו</button>
               <button type="button" class="btn btn-ghost mo-del">${ICON.trash} מחיקה</button>`}
        </div>`,
      onOpen: (body) => {
        paintDocs(body.querySelector('#mo-docs'), m);
        body.querySelector('.mo-edit')?.addEventListener('click', () => TripPages.closeSheet(() => openForm(m)));
        body.querySelector('.mo-approve')?.addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          await approveMany([m]);
          TripPages.closeSheet();
        });
        body.querySelector('.mo-test')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const state = typeof TRIPMAKER_PUSH !== 'undefined' ? await TRIPMAKER_PUSH.state() : 'unavailable';
            if (state === 'off') { await TRIPMAKER_PUSH.enable(); }
            else if (state !== 'on') throw new Error(state === 'blocked' ? 'ההתראות חסומות בדפדפן — אפשר להפעיל אותן בהגדרות האתר' : 'ההתראות לא זמינות במכשיר הזה (באייפון: להוסיף למסך הבית קודם)');
            const r = await api(`/${m.id}/preview`, { method: 'POST' });
            TripPages.toast(r.sent ? 'נשלח! בדקו את ההתראה בטלפון' : 'לא נמצא מכשיר רשום להתראות', r.sent ? 'ok' : undefined);
          } catch (err) { TripPages.toast(err.message || 'לא הצלחנו לשלוח'); }
          btn.disabled = false;
        });
        body.querySelector('.mo-del')?.addEventListener('click', async () => {
          if (m.status !== 'proposed' && !confirm(`למחוק את התזכורת "${m.title}"?`)) return;
          await remove(m);
          TripPages.closeSheet();
        });
      },
    });
    TRIPMAKER.track?.('moment_open', { code: ctx.trip.share_code, kind: m.kind, source: (m.source || {}).type || 'manual' });
  }

  // the documents a moment opens: from the phone, big enough to scan; a document the
  // phone does not hold says so — and offers Gmail when it came from there
  async function paintDocs(el, m) {
    if (!el) return;
    const refs = m.docs || [];
    if (!refs.length) { el.innerHTML = '<p class="mo-nodocs">אין מסמך מצורף לתזכורת — אפשר להוסיף בעריכה, או לצרף כרטיס בצ׳אט.</p>'; return; }
    const matched = await docsFor(m);
    const html = matched.map(({ ref, doc }, i) => {
      if (!doc) {
        return `<div class="mo-doc mo-doc-missing" data-i="${i}">
          <span class="mo-doc-ic" aria-hidden="true">📄</span>
          <span class="mo-doc-text"><b>${esc(ref.name)}</b><small>לא נמצא במכשיר הזה${ref.message ? '' : ' — נשמר במכשיר שממנו נוסף'}</small></span>
          ${ref.message ? '<button type="button" class="btn btn-ghost mo-doc-fetch">להוריד מהמייל</button>' : ''}
        </div>`;
      }
      const url = URL.createObjectURL(doc.blob);
      urls.push(url);
      const image = /^image\//.test(doc.type || '');
      return `<div class="mo-doc${image ? ' is-image' : ''}" data-i="${i}">
        ${image ? `<img class="mo-doc-img" src="${url}" alt="${esc(doc.name)}" title="לחיצה להגדלה">` : `<span class="mo-doc-ic" aria-hidden="true">${/pdf/i.test(doc.type || doc.name) ? '📕' : '📄'}</span>`}
        <span class="mo-doc-text"><b>${esc(doc.name)}</b><small>שמור במכשיר — נפתח גם בלי קליטה</small></span>
        <a class="btn btn-amber" href="${url}" target="_blank" rel="noopener">${ICON.open} פתיחה</a>
      </div>`;
    }).join('');
    el.innerHTML = html;
    el.querySelectorAll('.mo-doc-img').forEach((img) => { img.onclick = () => TRIPMAKER.openLightbox(img.src); });
    el.querySelectorAll('.mo-doc-fetch').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'מורידים…';
        try {
          await fetchFromGmail(matched[+b.closest('.mo-doc').dataset.i].ref);
          await paintDocs(el, m);
          TripPages.toast('המסמך נשמר במכשיר ✓', 'ok');
        } catch { b.disabled = false; b.textContent = 'להוריד מהמייל'; TripPages.toast('לא הצלחנו להוריד מהמייל — האם Gmail מחובר לחשבון הזה?'); }
      };
    });
  }

  // ---- writing ----

  function replaceRows(rows) {
    const cur = list();
    for (const r of rows) {
      const i = cur.findIndex((m) => m.id === r.id);
      if (i >= 0) cur[i] = r; else cur.push(r);
    }
    cur.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.id - b.id);
    ctx.state.moments = cur;
    paint();
  }

  async function remove(m, { quiet = false } = {}) {
    try {
      await api(`/${m.id}`, { method: 'DELETE' });
      ctx.state.moments = list().filter((x) => x.id !== m.id);
      paint();
      if (!quiet) TripPages.toast(m.status === 'proposed' ? 'ההצעה הוסרה' : 'התזכורת נמחקה', 'ok');
    } catch (err) { TripPages.toast(err.message || 'המחיקה נכשלה'); }
  }

  // a proposal becomes a live moment: its documents come down from Gmail to this phone
  // (when they can), then the row flips to active
  async function approveMany(rows) {
    let fetched = 0;
    for (const m of rows) {
      try {
        for (const ref of m.docs || []) {
          if (!ref.message) continue;
          const have = await TripDocs.find(ctx, [ref.name]).catch(() => []);
          if (!have.length) { await fetchFromGmail(ref).then(() => fetched++).catch(() => {}); }
        }
        const updated = await api(`/${m.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
        replaceRows([updated]);
      } catch (err) { TripPages.toast(err.message || 'האישור נכשל'); return; }
    }
    TripPages.toast(`${rows.length === 1 ? 'התזכורת הופעלה' : `${rows.length} תזכורות הופעלו`}${fetched ? ` · ${fetched} מסמכים נשמרו במכשיר` : ''} ✓`, 'ok');
    TRIPMAKER.track?.('moments_approved', { code: ctx.trip.share_code, count: rows.length, fetched });
  }

  // ---- the form ----

  const TZ_CHOICES = () => [...new Set([tz, 'Asia/Jerusalem', 'Europe/London', 'Europe/Paris', 'Europe/Athens', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Tokyo', 'America/New_York'].filter(Boolean))];

  async function openForm(existing, preset = null) {
    const m = existing || preset || {};
    const kind = KIND_KEYS.includes(m.kind) ? m.kind : 'other';
    const local = m.local_time || '';
    const date = local.slice(0, 10) || (ctx.trip.start_date ? TRIPMAKER.isoDate(new Date(ctx.trip.start_date)) : '');
    const time = local.slice(11, 16) || '';
    const zone = m.tz || tz || 'Asia/Jerusalem';
    const zones = TZ_CHOICES();
    if (!zones.includes(zone)) zones.unshift(zone);
    const d = m.details || {};
    const lead = Number.isInteger(m.lead_minutes) ? m.lead_minutes : KINDS[kind].lead;
    const leadOpts = LEAD_OPTIONS.some(([v]) => v === lead) ? LEAD_OPTIONS : [[lead, `${leadText(lead, { prefix: '' })} לפני`], ...LEAD_OPTIONS];
    const deviceDocs = typeof TripDocs !== 'undefined' ? await TripDocs.all(ctx).catch(() => []) : [];
    const chosen = new Set((m.docs || []).map((x) => x.name));
    TripPages.sheet('moment-form', {
      title: existing ? `${ICON.edit} עריכת תזכורת` : `${ICON.bell} תזכורת חדשה`,
      sub: 'הטלפון מצלצל לפני, והמסמכים שתבחרו נפתחים בלחיצה — גם בלי קליטה',
      cls: 'moment-card',
      html: `
        <form class="mo-form" id="mo-form">
          <label class="mo-field"><span>סוג</span>
            <select name="kind">${KIND_KEYS.map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${KINDS[k].emoji} ${KINDS[k].label}</option>`).join('')}</select></label>
          <label class="mo-field"><span>מה</span><input name="title" type="text" maxlength="120" required placeholder="אוטובוס מקיוטו לטוקיו" value="${esc(m.title || '')}"></label>
          <div class="mo-grid">
            <label class="mo-field"><span>תאריך</span><input name="date" type="date" required value="${esc(date)}"></label>
            <label class="mo-field"><span>שעה <small id="mo-hint">${esc(KINDS[kind].hint)}</small></span><input name="time" type="time" required value="${esc(time)}"></label>
          </div>
          <div class="mo-grid">
            <label class="mo-field"><span>אזור זמן</span>
              <select name="tz">${zones.map((z) => `<option value="${esc(z)}"${z === zone ? ' selected' : ''}>${esc(tzLabel(z))}${z === tz ? ' (היעד)' : ''}</option>`).join('')}<option value="__other">אחר…</option></select></label>
            <label class="mo-field"><span>התראה</span>
              <select name="lead">${leadOpts.map(([v, l]) => `<option value="${v}"${v === lead ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          </div>
          <input name="tz_other" type="text" class="mo-tz-other" placeholder="למשל Asia/Seoul" hidden>
          <details class="mo-more"${Object.keys(d).length ? ' open' : ''}><summary>פרטים שיופיעו בהתראה</summary>
            <div class="mo-grid">
              <label class="mo-field"><span>מספר הזמנה</span><input name="code" type="text" maxlength="120" value="${esc(d.code || '')}"></label>
              <label class="mo-field"><span>מספר טיסה / קו</span><input name="number" type="text" maxlength="120" value="${esc(d.number || '')}"></label>
            </div>
            <label class="mo-field"><span>כתובת</span><input name="address" type="text" maxlength="300" value="${esc(d.address || '')}"></label>
            <div class="mo-grid">
              <label class="mo-field"><span>מושב</span><input name="seat" type="text" maxlength="120" value="${esc(d.seat || '')}"></label>
              <label class="mo-field"><span>שער / רציף</span><input name="gate" type="text" maxlength="120" value="${esc(d.gate || d.platform || '')}"></label>
            </div>
            <label class="mo-field"><span>הערה</span><input name="note" type="text" maxlength="300" value="${esc(d.note || '')}"></label>
          </details>
          <div class="mo-field"><span>מסמכים לפתיחה בהתראה <small>מתוך המסמכים ששמורים במכשיר הזה</small></span>
            <div class="mo-doclist" id="mo-doclist">
              ${deviceDocs.map((x) => `<label class="mo-docpick"><input type="checkbox" name="doc" value="${esc(x.name)}"${chosen.has(x.name) ? ' checked' : ''}><span>${/^image\//.test(x.type || '') ? '🖼️' : /pdf/i.test(x.type || x.name) ? '📕' : '📄'} ${esc(x.name)}</span></label>`).join('')}
              ${[...chosen].filter((n) => !deviceDocs.some((x) => x.name === n)).map((n) => `<label class="mo-docpick is-missing"><input type="checkbox" name="doc" value="${esc(n)}" checked><span>📄 ${esc(n)} <small>לא במכשיר הזה</small></span></label>`).join('')}
              <label class="mo-docpick mo-docadd"><input type="file" id="mo-docfile" accept="image/*,application/pdf,.pdf" hidden><span>${ICON.plus} הוספת קובץ מהמכשיר</span></label>
              ${TripPages.canSnap ? `<button type="button" class="mo-docpick mo-docadd mo-docsnap"><span>📷 צילום</span></button>` : ''}
            </div>
          </div>
          <div class="ds-actions"><button type="submit" class="btn btn-amber">${existing ? 'שמירה' : 'יצירת התזכורת'}</button><button type="button" class="btn btn-ghost mo-cancel">ביטול</button></div>
        </form>`,
      onOpen: (body) => {
        const form = body.querySelector('#mo-form');
        const kindSel = form.elements.kind;
        kindSel.onchange = () => {
          body.querySelector('#mo-hint').textContent = KINDS[kindSel.value].hint;
          if (!existing) form.elements.lead.value = String(KINDS[kindSel.value].lead);
        };
        form.elements.tz.onchange = () => { form.elements.tz_other.hidden = form.elements.tz.value !== '__other'; };
        body.querySelector('.mo-cancel').onclick = () => TripPages.closeSheet();
        body.querySelector('.mo-docadd').onclick = () => body.querySelector('#mo-docfile').click();
        const addDoc = async (f) => {
          if (!f) return;
          const ok = await TripDocs.stash(ctx, f);
          const lab = document.createElement('label');
          lab.className = 'mo-docpick';
          lab.innerHTML = `<input type="checkbox" name="doc" value="${esc(f.name)}" checked><span>📎 ${esc(f.name)}</span>`;
          body.querySelector('.mo-docadd').before(lab);
          TripPages.toast(ok ? 'הקובץ נשמר במכשיר ✓' : 'הקובץ כבר במסמכים', 'ok');
        };
        body.querySelector('#mo-docfile').onchange = (e) => addDoc(e.target.files[0]);
        const snapBtn = body.querySelector('.mo-docsnap');
        if (snapBtn) snapBtn.onclick = () => TripPages.snap(addDoc);
        form.onsubmit = async (e) => {
          e.preventDefault();
          const f = form.elements;
          const zoneVal = f.tz.value === '__other' ? f.tz_other.value.trim() : f.tz.value;
          const docs = [...form.querySelectorAll('input[name=doc]:checked')].map((cb) => {
            const prev = (m.docs || []).find((x) => x.name === cb.value);
            const dev = deviceDocs.find((x) => x.name === cb.value);
            return { ...(prev || {}), name: cb.value, size: dev ? dev.size : (prev && prev.size) };
          });
          const payload = {
            kind: f.kind.value, title: f.title.value.trim(), local_time: `${f.date.value}T${f.time.value}`, tz: zoneVal,
            lead_minutes: parseInt(f.lead.value, 10),
            details: { code: f.code.value, number: f.number.value, address: f.address.value, seat: f.seat.value, gate: f.gate.value, note: f.note.value },
            docs,
          };
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            if (existing) {
              const row = await api(`/${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
              replaceRows([row]);
            } else {
              const r = await api('', { method: 'POST', body: JSON.stringify({ ...payload, source: preset && preset.source ? preset.source : { type: 'manual' } }) });
              replaceRows(r.moments || []);
            }
            TripPages.closeSheet(() => TripPages.toast(existing ? 'נשמר ✓' : 'התזכורת נוצרה — נזכיר לכם בזמן ✓', 'ok'));
            TRIPMAKER.track?.('moment_saved', { code: ctx.trip.share_code, kind: payload.kind, edit: !!existing, docs: docs.length });
          } catch (err) { btn.disabled = false; TripPages.toast(err.message || 'השמירה נכשלה'); }
        };
      },
    });
  }

  // ---- proposals: what the AI read, waiting for a tick ----

  // `onImport(selected)` writes the ticked ones; the sheet only collects the decision
  function proposalsSheet(proposals, { title, sub, onImport }) {
    const ok = proposals.filter((p) => !p.error);
    TripPages.sheet('moment-proposals', {
      title, sub, cls: 'moment-card',
      html: ok.length ? `
        <div class="mo-props">${proposals.map((p, i) => p.error
          ? `<div class="mo-prop is-error"><span>⚠️</span><span class="mo-prop-text"><b>${esc(p.title || 'רגע שלא הובן')}</b><small>${esc(p.error)}</small></span></div>`
          : `<label class="mo-prop"><input type="checkbox" data-i="${i}" checked>
              <span class="mo-prop-text"><b>${kindOf(p).emoji} ${esc(p.title)}</b>
                <small>${esc(whenLine(p))}${p.day ? ` · יום ${p.day}` : ''}</small>
                ${[p.details && p.details.code && `הזמנה ${p.details.code}`, p.details && p.details.number, p.hotel && 'המלון יתווסף לרשימת המלונות', p.day && (p.kind === 'flight' || p.kind === 'transport') && 'תחנת נסיעה תתווסף למסלול'].filter(Boolean).map((t) => `<small>${esc(t)}</small>`).join('')}
                ${(p.attachments || []).length ? `<small>📎 ${p.attachments.map((a) => esc(a.name)).join(', ')} — יישמרו במכשיר</small>` : ''}
              </span></label>`).join('')}</div>
        <div class="ds-actions"><button type="button" class="btn btn-amber mo-import">${ICON.check} <span>הפעלת ${ok.length === 1 ? 'התזכורת' : `${ok.length} התזכורות`}</span></button><button type="button" class="btn btn-ghost mo-cancel">לא עכשיו</button></div>`
        : `<p class="mo-nodocs">${proposals.length ? proposals.map((p) => esc(p.error)).join('<br>') : 'לא נמצאו כאן שעות של טיסה, נסיעה, כרטיס או צ׳ק-אין. אפשר להוסיף תזכורת ידנית.'}</p>
           <div class="ds-actions"><button type="button" class="btn btn-ghost mo-cancel">סגירה</button></div>`,
      onOpen: (body) => {
        body.querySelector('.mo-cancel').onclick = () => TripPages.closeSheet();
        const boxes = [...body.querySelectorAll('input[type=checkbox]')];
        const btn = body.querySelector('.mo-import');
        const sync = () => { const n = boxes.filter((b) => b.checked).length; btn.disabled = !n; btn.querySelector('span').textContent = `הפעלת ${n === 1 ? 'התזכורת' : `${n} התזכורות`}`; };
        boxes.forEach((b) => { b.onchange = sync; });
        if (btn) btn.onclick = async () => {
          btn.disabled = true;
          btn.querySelector('span').textContent = 'שומרים…';
          try {
            await onImport(boxes.filter((b) => b.checked).map((b) => proposals[+b.dataset.i]));
            TripPages.closeSheet();
          } catch (err) { btn.disabled = false; sync(); TripPages.toast(err.message || 'הייבוא נכשל'); }
        };
      },
    });
  }

  // the ticked proposals → moments: attachments down to the phone first (so the moment
  // knows which of them actually landed), then one POST, status active
  async function importProposals(selected, { fetchAttachments = true } = {}) {
    if (!selected.length) return;
    const payload = [];
    let fetched = 0;
    for (const p of selected) {
      const docs = [];
      for (const a of (p.attachments || []).slice(0, 6)) {
        const ref = { name: a.name, size: a.size, message: (p.source || {}).id, attachment: a.id, mime: a.mime };
        if (fetchAttachments && ref.message) {
          try { await fetchFromGmail(ref); fetched++; } catch { /* the name stays; the sheet offers Gmail again */ }
        }
        docs.push(ref);
      }
      if (p.docs) docs.push(...p.docs.filter((d) => !docs.some((x) => x.name === d.name)));
      payload.push({ kind: p.kind, title: p.title, local_time: p.local_time, tz: p.tz, lead_minutes: p.lead_minutes, details: p.details, hotel: p.hotel, docs, source: p.source, status: 'active' });
    }
    const r = await api('', { method: 'POST', body: JSON.stringify({ moments: payload }) });
    replaceRows(r.moments || []);
    const n = (r.moments || []).length;
    // a hotel or a travel stop may have landed on the trip too — the page re-reads it
    if (payload.some((p) => p.hotel || p.kind === 'flight' || p.kind === 'transport')) ctx.reload?.();
    TripPages.toast(`${n === 1 ? 'התזכורת הופעלה' : `${n} תזכורות הופעלו`}${fetched ? ` · ${fetched} מסמכים נשמרו במכשיר` : ''} ✓`, 'ok');
    TRIPMAKER.track?.('moments_imported', { code: ctx.trip.share_code, count: n, fetched, from: (payload[0] && payload[0].source && payload[0].source.type) || 'scan' });
  }

  // "מהמייל": the scan, and what to do when Gmail is not on yet
  async function scan() {
    const btn = slots && slots.tools.querySelector('#mo-scan');
    if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'קוראים…'; }
    try {
      const r = await api('/scan', { method: 'POST', body: '{}' });
      proposalsSheet(r.proposals || [], {
        title: `${ICON.mail} מה נמצא במייל`,
        sub: r.read ? `נקראו ${r.read} הודעות של הזמנות וכרטיסים מהחצי שנה האחרונה. סמנו מה שייך לטיול הזה.` : 'לא נמצאו הודעות של הזמנות או כרטיסים בחצי השנה האחרונה',
        onImport: (sel) => importProposals(sel),
      });
      TRIPMAKER.track?.('moments_scan', { code: ctx.trip.share_code, read: r.read, found: (r.proposals || []).filter((p) => !p.error).length });
    } catch (err) {
      if (err.status === 409) connectGmail(err.message);
      else if (err.quota) TripPages.toast(err.message);
      else TripPages.toast(err.message || 'הסריקה נכשלה');
    } finally {
      if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'מהמייל'; }
    }
  }

  function connectGmail(reason) {
    TripPages.sheet('moment-connect', {
      title: `${ICON.mail} לקרוא את המייל?`,
      sub: reason || 'Gmail לא מחובר',
      cls: 'moment-card',
      html: `
        <p class="mo-nodocs">ה-AI יחפש במייל אישורי טיסה, מלון, אוטובוס וכרטיסים, ויציע תזכורת לכל אחד — עם הקובץ המצורף שמור במכשיר. קריאה בלבד, באישורכם ב-Google, וניתוק בכל רגע מהחיבורים של הצ׳אט.</p>
        <div class="ds-actions"><button type="button" class="btn btn-amber mo-connect">חיבור Gmail</button><button type="button" class="btn btn-ghost mo-cancel">לא עכשיו</button></div>`,
      onOpen: (body) => {
        body.querySelector('.mo-cancel').onclick = () => TripPages.closeSheet();
        body.querySelector('.mo-connect').onclick = () => {
          const next = location.pathname + '#moments';
          const p = new URLSearchParams({ t: TRIPMAKER.token || '', services: 'gmail', next });
          TRIPMAKER.track?.('connector_start', { service: 'gmail', from: 'moments' });
          location.href = `/api/connectors/google/start?${p}`;
        };
      },
    });
  }

  // a document on the מסמכים page → "תזכורת מהמסמך": the device reads its text (the same
  // ladder the folder tagging climbs), the server proposes the moments, the person ticks
  async function fromDoc(doc) {
    TripPages.toast('קוראים את המסמך…');
    let text = '';
    try { text = (await DocText.extract(doc.blob)).text; } catch { /* nothing read */ }
    if (!text || text.replace(/\s+/g, '').length < 20) { TripPages.toast('לא הצלחנו לקרוא טקסט מהמסמך במכשיר הזה — אפשר להוסיף תזכורת ידנית ולצרף אותו'); return openForm(null, { docs: [{ name: doc.name, size: doc.size }] }); }
    try {
      const r = await api('/extract', { method: 'POST', body: JSON.stringify({ text, name: doc.name }) });
      const props = (r.proposals || []).map((p) => (p.error ? p : { ...p, docs: [{ name: doc.name, size: doc.size }] }));
      if (!TripPages.current() || TripPages.current() !== 'moments') { /* stays on the docs page; the sheet opens over it */ }
      proposalsSheet(props, {
        title: `${ICON.bell} תזכורות מתוך ${esc(doc.name)}`,
        sub: 'מה שה-AI קרא מהמסמך. אישור יוצר תזכורת שפותחת את המסמך הזה בזמן.',
        onImport: (sel) => importProposals(sel, { fetchAttachments: false }),
      });
    } catch (err) {
      if (err.quota) TripPages.toast(err.message);
      else { TripPages.toast(err.message || 'הקריאה נכשלה — אפשר להוסיף ידנית'); openForm(null, { docs: [{ name: doc.name, size: doc.size }], source: { type: 'doc', name: doc.name } }); }
    }
  }

  // ---- wiring ----

  // `pageCtx`: { trip, state, canEdit, reload } from trip.js. state.moments is the list
  // the trip arrived with, and stays the one list every surface reads.
  function init(pageCtx) {
    ctx = pageCtx;
    tz = null;
    if (!Array.isArray(ctx.state.moments)) ctx.state.moments = [];
    TripPages.register('moments', {
      title: '⏰ תזכורות',
      sub: 'כרטיסים, טיסות וצ׳ק-אין — הטלפון מצלצל לפני, והמסמך נפתח בלחיצה, גם בלי קליטה',
      render,
      onClose,
    });
    badge();
    openFromHash();
    window.addEventListener('popstate', openFromHash);
  }

  // /trip/CODE#moment-12 — the push's landing. The page opens first (it holds the list)
  // and the sheet over it; the hash becomes the page's, so back closes cleanly.
  function openFromHash() {
    const h = HASH.exec(location.hash);
    if (!h) return;
    const id = +h[1];
    history.replaceState(null, '', location.pathname + location.search);
    if (TripPages.current() !== 'moments') TripPages.open('moments', { still: true });
    const m = byId(id);
    if (m) setTimeout(() => openSheet(m), 60);
    else TripPages.toast('התזכורת הזו כבר לא בטיול');
  }

  // the chats changed the moments (lib/plan-actions.js sideState) or the trip reloaded
  function refresh(rows) {
    if (!ctx) return;
    if (Array.isArray(rows)) ctx.state.moments = rows;
    badge();
    paint();
  }

  return { init, refresh, moreDesc, fromDoc, openForm, scan, openSheet };
})();
