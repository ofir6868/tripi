// צ'קליסט — what has to happen before the plane.
//
// Two faces of one list. The WIDGET sits above the itinerary and shows the three things
// that must not be missed: an eSIM (Airalo), travel insurance (PassportCard) and the one
// destination-specific item the model picked for this trip. The PAGE (the first row of
// "עוד", or the toolbar button on desktop) is the whole list in three tabs:
//   משותף — one tick for everyone: the car, the table, the printed bookings. Shows who did it.
//   אישי  — everyone's own box on the same template: passport, meds, charger. Items you type
//           here are yours alone; the AI's are shared as a template, each with your own tick.
//   פרו   — the power view over both: colored tags (לקנות / למצוא אונליין / להזמין מראש /
//           להדפיס / לארוז / לברר / דחוף), a snooze tray, due dates counted back from
//           departure with overdue in red, an assignee per shared item, views by section /
//           by urgency / shopping list / by person, bulk ticks, filters, copy and WhatsApp.
// The server (routes/checklist.js) owns the list; every mutation answers with the full
// snapshot and the page repaints from it, so two travellers never drift apart.
const TripChecklist = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const T = CHECKLIST_TAGS;
  const POLL_MS = 3000;
  const POLL_MAX = 30; // ~90s of waiting on a generation someone else started

  const ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
    chev: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
    search: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    link: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    more: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    spark: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    refresh: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    copy: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eye: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    lock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    users: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    user: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  };

  // ---- state shared by the widget and the page ----
  let ctx = null; // { trip, state, canEdit, requireSignup }
  let data = null; // { meta, items }
  let prefetched = null;
  const painters = new Set(); // fn() — whoever is on screen repaints from `data`
  const CORE_KEYS = ['esim', 'insurance', 'top'];

  const base = () => `/api/trips/code/${ctx.trip.share_code}/checklist`;
  const me = () => (TRIPMAKER.user ? TRIPMAKER.user.id : null);
  const myName = () => (TRIPMAKER.user && TRIPMAKER.user.name) || 'אני';

  function prefetch(code) {
    prefetched = TRIPMAKER.api(`/api/trips/code/${code}/checklist`).catch(() => null);
  }
  function setData(d) {
    if (!d || !Array.isArray(d.items)) return;
    data = d;
    painters.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    syncBadge();
  }
  async function call(path, method, body) {
    const d = await TRIPMAKER.api(base() + path, { method, body: body ? JSON.stringify(body) : undefined });
    setData(d);
    return d;
  }
  async function reload() {
    try { setData(await TRIPMAKER.api(base())); } catch { /* the last snapshot stands */ }
  }

  // ---- derived facts ----
  const items = () => (data ? data.items : []);
  const isSnoozed = (it) => it.tags.includes('later');
  const coreItem = (key) => items().find((it) => it.key === key);
  const liveItems = () => items().filter((it) => !isSnoozed(it));
  const progress = (list) => ({ done: list.filter((it) => it.done).length, total: list.length });
  const participants = () => (ctx && ctx.state && Array.isArray(ctx.state.participants) ? ctx.state.participants : []);
  const nameOf = (id) => {
    if (id === me()) return myName();
    const p = participants().find((x) => x.id === id);
    return p ? p.name : null;
  };
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');

  function daysToTrip() {
    if (!ctx.trip.start_date) return null;
    const d = new Date(ctx.trip.start_date);
    if (Number.isNaN(d.getTime())) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }
  const fmtDay = (d) => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });

  // when an item is due, as a date when the trip has one — and how loudly to say it
  function dueInfo(it) {
    if (it.due_days === null || it.due_days === undefined) return null;
    const label = T.dueLabel(it.due_days);
    const start = ctx.trip.start_date ? new Date(ctx.trip.start_date) : null;
    if (!start || Number.isNaN(start.getTime())) return { label, text: label, cls: 'nodate', diff: null };
    const due = new Date(start); due.setHours(0, 0, 0, 0); due.setDate(due.getDate() - it.due_days);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((due - today) / 86400000);
    if (it.done) return { label, text: `עד ${fmtDay(due)}`, cls: 'done', diff };
    if (diff < 0) return { label, text: diff === -1 ? 'אתמול!' : `באיחור ${-diff} ימים`, cls: 'overdue', diff };
    if (diff === 0) return { label, text: 'היום', cls: 'today', diff };
    if (diff <= 7) return { label, text: `עוד ${diff} ימים`, cls: 'soon', diff };
    return { label, text: `עד ${fmtDay(due)}`, cls: 'later', diff };
  }
  const isUrgent = (it) => !it.done && (it.tags.includes('urgent') || (dueInfo(it) || {}).cls === 'overdue' || (dueInfo(it) || {}).cls === 'today');

  // sections in the order their first item appears; the headline section always leads
  function sectionsOf(list) {
    const map = new Map();
    for (const it of list) {
      if (!map.has(it.section)) map.set(it.section, []);
      map.get(it.section).push(it);
    }
    const out = [...map.entries()].map(([name, its]) => ({ name, items: its }));
    out.sort((a, b) => (a.items[0].source === 'core' ? -1 : 0) - (b.items[0].source === 'core' ? -1 : 0));
    return out;
  }
  const allSectionNames = () => [...new Set(items().map((it) => it.section))];

  function searchUrl(it) {
    const q = it.search || `${it.title} ${TRIPMAKER.destLine(ctx.trip, ' ')}`;
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
  }

  // the toolbar button's badge: what is on fire, not how long the list is
  function syncBadge() {
    const n = liveItems().filter(isUrgent).length;
    TripPages.badge('checklist', n);
    const el = document.getElementById('checklist-sub');
    if (el) el.textContent = moreDesc();
  }
  function moreDesc() {
    if (!data) return 'מה חייבים לסדר לפני היציאה — eSIM, ביטוח, ומה שה-AI אומר שחשוב';
    const p = progress(liveItems());
    const urgent = liveItems().filter(isUrgent).length;
    return `${p.done}/${p.total} בוצעו${urgent ? ` · ${urgent} דחופים` : ''}`;
  }

  // ---- mutations (optimistic where a tap should feel instant) ----
  async function toggle(it) {
    const next = !it.done;
    it.done = next;
    if (it.scope === 'shared') { it.done_by = next ? me() : null; it.done_by_name = next ? myName() : null; }
    painters.forEach((fn) => fn());
    try {
      const before = progress(liveItems()).done;
      await call(`/items/${it.id}`, 'PATCH', { done: next });
      const p = progress(liveItems());
      if (next && p.total && p.done === p.total && before < p.total) TripPages.toast('🎉 הכול מסומן — נסיעה טובה!', 'ok');
      TRIPMAKER.track?.('checklist_tick', { code: ctx.trip.share_code, done: next, scope: it.scope, key: it.key || null });
    } catch (e) {
      it.done = !next;
      painters.forEach((fn) => fn());
      TripPages.toast(e.message || 'השינוי לא נשמר');
    }
  }
  async function patch(it, fields) {
    try { await call(`/items/${it.id}`, 'PATCH', fields); return true; } catch (e) { TripPages.toast(e.message || 'השינוי לא נשמר'); return false; }
  }
  async function add(fields) {
    try { await call('/items', 'POST', fields); return true; } catch (e) { TripPages.toast(e.message || 'לא נוסף'); return false; }
  }
  async function remove(it) {
    try { await call(`/items/${it.id}`, 'DELETE'); return true; } catch (e) { TripPages.toast(e.message || 'המחיקה נכשלה'); return false; }
  }
  async function bulk(ids, done) {
    if (!ids.length) return;
    try { await call('/bulk', 'POST', { ids, done }); } catch (e) { TripPages.toast(e.message || 'לא נשמר'); }
  }

  // ---- the model's pick: asked once, polled while someone else's ask is in flight ----
  let topInFlight = null;
  async function ensureTop() {
    if (!data) return;
    const st = data.meta.top_status;
    const top = coreItem('top');
    if (top && st === 'ready') return;
    if (st === 'pending') return pollUntil(() => data.meta.top_status !== 'pending');
    if (st === 'failed' && top) return; // the old pick stands; the retry is explicit
    if (topInFlight) return topInFlight;
    topInFlight = call('/top', 'POST').catch(() => {}).finally(() => { topInFlight = null; });
    return topInFlight;
  }
  async function retryTop() {
    data.meta.top_status = 'pending';
    painters.forEach((fn) => fn());
    try { await call('/top', 'POST'); } catch { reload(); }
  }
  async function pollUntil(ok) {
    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      await reload();
      if (ok()) return;
    }
  }

  // =================================================================
  //  WIDGET — the three headline items, above the itinerary
  // =================================================================

  function initWidget(pageCtx) {
    ctx = pageCtx;
    // the trip page can swap itself over to another trip without a navigation (a visitor
    // copying the one they are reading): whatever list was here belongs to the old one
    data = null;
    painters.clear();
    const host = document.getElementById('checklist-widget');
    if (!host || !ctx.canEdit || !TRIPMAKER.user) return;
    host.hidden = false;
    host.innerHTML = widgetSkeleton();
    const paint = () => { host.innerHTML = widgetHtml(); wireWidget(host); };
    painters.add(paint);
    (async () => {
      let snap = prefetched ? await prefetched : null;
      prefetched = null;
      if (!snap) { try { snap = await TRIPMAKER.api(base()); } catch { host.hidden = true; return; } }
      setData(snap);
      ensureTop();
    })();
  }

  function widgetSkeleton() {
    return `<div class="clw-head"><div class="clw-title">✅ שלושת הדברים שחייבים לפני הטיול</div></div>
      <div class="clw-tiles">${[0, 1, 2].map(() => `<div class="clw-tile is-skl"><span class="skl clw-skl-check"></span><span class="clw-skl-text"><span class="skl"></span><span class="skl short"></span></span></div>`).join('')}</div>`;
  }

  function tileHtml(it, kind) {
    const linkLabel = it.key === 'esim' ? 'לרכישת eSIM' : it.key === 'insurance' ? 'להצעת ביטוח' : 'לפרטים';
    const href = it.link || searchUrl(it);
    const due = dueInfo(it);
    return `
      <div class="clw-tile kind-${kind}${it.done ? ' is-done' : ''}" data-id="${it.id}">
        <button type="button" class="cl-check" data-id="${it.id}" aria-pressed="${it.done}" aria-label="${it.done ? 'ביטול סימון' : 'סימון כבוצע'}: ${esc(it.title)}">${ICON.check}</button>
        <div class="clw-text">
          <b>${esc(it.title)}</b>
          <small>${esc(it.why || it.note || '')}</small>
          ${due && !it.done && (due.cls === 'overdue' || due.cls === 'today' || due.cls === 'soon') ? `<span class="cl-due ${due.cls}">${esc(due.text)}</span>` : ''}
        </div>
        <a class="clw-link" href="${esc(href)}" target="_blank" rel="noopener">${it.link ? ICON.link : ICON.search}<span>${linkLabel}</span></a>
      </div>`;
  }

  function widgetHtml() {
    const esim = coreItem('esim');
    const ins = coreItem('insurance');
    const top = coreItem('top');
    const core = [esim, ins, top].filter(Boolean);
    const p = progress(core);
    const full = progress(liveItems());
    const st = data.meta.top_status;
    const thirdTile = top && st !== 'pending'
      ? tileHtml(top, 'top')
      : st === 'failed'
        ? `<div class="clw-tile kind-top is-failed"><span class="clw-ai">${ICON.spark}</span><div class="clw-text"><b>לא הצלחנו לבחור הפעם</b><small>ה-AI לא ענה — אפשר לנסות שוב</small></div><button type="button" class="clw-retry btn btn-ghost">${ICON.refresh} שוב</button></div>`
        : `<div class="clw-tile kind-top is-skl"><span class="clw-ai pulse">${ICON.spark}</span><div class="clw-text"><b>ה-AI בוחר את הדבר השלישי…</b><small>מה שהכי חשוב דווקא ליעד הזה</small></div></div>`;
    return `
      <div class="clw-head">
        <div class="clw-title">✅ שלושת הדברים שחייבים לפני הטיול
          <span class="clw-count${p.done === core.length && core.length ? ' all' : ''}">${p.done}/${core.length || 3}</span></div>
        <button type="button" class="clw-open" id="clw-open">הצ'קליסט המלא ${ICON.chev}</button>
      </div>
      <div class="clw-tiles">
        ${esim ? tileHtml(esim, 'esim') : ''}
        ${ins ? tileHtml(ins, 'insurance') : ''}
        ${thirdTile}
      </div>
      ${full.total > 3 ? `<button type="button" class="clw-foot" id="clw-foot"><span class="clw-bar"><i style="--w:${Math.round(100 * full.done / full.total)}%"></i></span><span>${full.done}/${full.total} ברשימה המלאה</span>${ICON.chev}</button>`
        : `<button type="button" class="clw-foot muted" id="clw-foot">${ICON.spark}<span>הרשימה המלאה — מסמכים, הזמנות מראש, אריזה ועוד — נבנית בלחיצה</span>${ICON.chev}</button>`}`;
  }

  function wireWidget(host) {
    host.querySelectorAll('.cl-check').forEach((b) => {
      b.onclick = () => { const it = items().find((x) => x.id === +b.dataset.id); if (it) toggle(it); };
    });
    const open = () => TripPages.open('checklist');
    host.querySelector('#clw-open')?.addEventListener('click', open);
    host.querySelector('#clw-foot')?.addEventListener('click', open);
    host.querySelector('.clw-retry')?.addEventListener('click', retryTop);
    host.querySelectorAll('.clw-link').forEach((a) => {
      a.addEventListener('click', () => TRIPMAKER.track?.('checklist_link', { code: ctx.trip.share_code, key: a.closest('.clw-tile')?.dataset.id }));
    });
  }

  // =================================================================
  //  PAGE — the whole list, three tabs
  // =================================================================

  const PRO_VIEWS = [
    { key: 'section', label: 'לפי סעיף' },
    { key: 'due', label: 'לפי מועד' },
    { key: 'shop', label: '🛒 קניות' },
    { key: 'who', label: 'לפי אחראי' },
  ];

  function render(slots, pageCtx) {
    ctx = pageCtx;
    const { page, body, tools } = slots;
    page.classList.add('page-checklist');

    if (!ctx.canEdit || !TRIPMAKER.user) {
      tools.innerHTML = '';
      body.innerHTML = `<div class="tp-inner"><div class="docs-empty glass">
        <div class="de-icons" aria-hidden="true">✅ 📱 🛡️ 🛂</div>
        <h3>הצ'קליסט של הטיול</h3>
        <p>eSIM, ביטוח, אישורי כניסה, מה להזמין מראש ומה לארוז — רשימה אחת לכל המשתתפים. כדי לסמן ולהוסיף צריך להצטרף לטיול.</p>
        <button type="button" class="btn btn-amber" id="cl-join">הצטרפות לטיול</button></div></div>`;
      body.querySelector('#cl-join').onclick = () => ctx.requireSignup?.();
      return;
    }

    // what this device remembers: tab, pro view, hidden-done, collapsed sections, filters
    const PREF_KEY = `tm_checklist_${ctx.trip.share_code}`;
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { prefs = {}; }
    const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* fine */ } };
    let tab = ['shared', 'personal', 'pro'].includes(prefs.tab) ? prefs.tab : 'shared';
    let proView = PRO_VIEWS.some((v) => v.key === prefs.proView) ? prefs.proView : 'section';
    let hideDone = !!prefs.hideDone;
    const collapsed = new Set(prefs.collapsed || []);
    const filterTags = new Set();
    let filterMine = false;
    let filterOpen = false;
    let filterSection = '';
    let generating = false;

    tools.innerHTML = `<button type="button" class="cl-tool" id="cl-menu" aria-label="עוד פעולות ברשימה">${ICON.more}</button>`;
    tools.querySelector('#cl-menu').onclick = openMenu;

    const paint = () => paintPage();
    painters.add(paint);
    ctx.onChecklistClose = () => painters.delete(paint);

    (async () => {
      if (!data) {
        body.innerHTML = `<div class="tp-inner">${heroSkeleton()}</div>`;
        let snap = prefetched ? await prefetched : null;
        prefetched = null;
        if (!snap) { try { snap = await TRIPMAKER.api(base()); } catch (e) { body.innerHTML = `<div class="tp-inner"><div class="docs-empty glass"><div class="de-icons">🙈</div><h3>לא הצלחנו לטעון את הרשימה</h3><p>${esc(e.message || '')}</p></div></div>`; return; } }
        setData(snap);
      } else paintPage();
      ensureTop();
      await ensureList();
    })();

    // the first open asks for the whole list; while it builds, the headline items are
    // already on the page and the rest shimmers under a line that says what is happening
    async function ensureList() {
      const st = data.meta.status;
      if (st === 'ready') return;
      if (st === 'pending') { generating = true; paintPage(); await pollUntil(() => data.meta.status !== 'pending'); generating = false; paintPage(); return; }
      // a failed build waits for a tap on "לנסות שוב" — every open retrying by itself
      // would buy the same failure over and over
      if (st === 'failed') return;
      await generate(false);
    }

    async function generate(force) {
      if (generating) return;
      generating = true;
      paintPage();
      try {
        const d = await call('/generate', 'POST', { force });
        if (d.error) TripPages.toast(d.error);
        else if (force) TripPages.toast('✨ הרשימה נבנתה מחדש', 'ok');
        TRIPMAKER.track?.('checklist_generate', { code: ctx.trip.share_code, force, status: d.meta && d.meta.status });
      } catch (e) {
        if (e.quota) TripPages.toast('ניצלתם את רענוני הצ\'קליסט להיום — מחר יש מכסה חדשה');
        else TripPages.toast(e.message || 'הבנייה נכשלה');
        await reload();
      } finally {
        generating = false;
        paintPage();
      }
    }

    // ---------------- paint ----------------

    function paintPage() {
      if (!data) return;
      const live = liveItems();
      const shared = live.filter((it) => it.scope === 'shared');
      const personal = live.filter((it) => it.scope === 'personal');
      const openShared = shared.filter((it) => !it.done).length;
      const openPersonal = personal.filter((it) => !it.done).length;
      const urgent = live.filter(isUrgent).length;
      body.innerHTML = `
        <div class="tp-inner cl-page">
          ${heroHtml(live, shared, personal)}
          <div class="cl-tabs" role="tablist">
            <button type="button" role="tab" class="cl-tab${tab === 'shared' ? ' on' : ''}" data-tab="shared" aria-selected="${tab === 'shared'}">${ICON.users} משותף${openShared ? `<b>${openShared}</b>` : ''}</button>
            <button type="button" role="tab" class="cl-tab${tab === 'personal' ? ' on' : ''}" data-tab="personal" aria-selected="${tab === 'personal'}">${ICON.user} אישי${openPersonal ? `<b>${openPersonal}</b>` : ''}</button>
            <button type="button" role="tab" class="cl-tab pro${tab === 'pro' ? ' on' : ''}" data-tab="pro" aria-selected="${tab === 'pro'}">${ICON.spark} פרו${urgent ? `<b class="hot">${urgent}</b>` : ''}</button>
          </div>
          <div class="cl-pane" role="tabpanel">
            ${tab === 'pro' ? proHtml(live) : scopeHtml(tab === 'shared' ? shared : personal, tab)}
            ${generating ? generatingHtml() : ''}
            ${!generating && data.meta.status === 'failed' && !items().some((it) => it.source === 'ai') ? failedHtml() : ''}
            ${snoozedHtml(tab)}
          </div>
        </div>`;
      wirePage();
    }

    function heroSkeleton() {
      return `<div class="cl-hero glass"><span class="skl" style="width:40%;height:1.2em"></span><div class="cl-prog"><i style="--w:0%"></i></div></div>`;
    }

    function heroHtml(live, shared, personal) {
      const p = progress(live);
      const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
      const days = daysToTrip();
      const count = days === null ? '📅 עדיין בלי תאריכים — המועדים יופיעו כשתקבעו'
        : days > 1 ? `✈️ עוד ${days} ימים ליציאה` : days === 1 ? '✈️ יוצאים מחר!' : days === 0 ? '✈️ יוצאים היום!' : '🌴 הטיול כבר התחיל';
      const ps = progress(shared), pp = progress(personal);
      return `
        <div class="cl-hero glass${pct === 100 && p.total ? ' complete' : ''}">
          <div class="cl-hero-row"><div class="cl-count">${count}</div><div class="cl-pct">${pct}%</div></div>
          <div class="cl-prog"><i style="--w:${pct}%"></i></div>
          <div class="cl-hero-sub">${p.done} מתוך ${p.total} בוצעו · משותף ${ps.done}/${ps.total} · אישי ${pp.done}/${pp.total}</div>
        </div>`;
    }

    function generatingHtml() {
      const hints = ['בודקים אישורי כניסה ליעד…', 'מסמנים תחנות במסלול שצריך להזמין מראש…', 'מתאימים את האריזה לעונה…', 'מחלקים בין משותף לאישי…'];
      return `
        <div class="cl-gen glass" role="status">
          <div class="cl-gen-head"><span class="clw-ai pulse">${ICON.spark}</span><div><b>ה-AI בונה את הצ'קליסט לטיול הזה</b><small class="cl-gen-hint" data-hints='${esc(JSON.stringify(hints))}'>${hints[0]}</small></div></div>
          ${[0, 1, 2].map(() => `<div class="cl-skl-sec"><span class="skl" style="width:35%"></span>${[0, 1, 2].map(() => `<div class="cl-skl-row"><span class="skl cl-skl-box"></span><span class="skl" style="width:${55 + Math.round(Math.random() * 30)}%"></span></div>`).join('')}</div>`).join('')}
        </div>`;
    }

    function failedHtml() {
      return `<div class="cl-failed glass"><div class="de-icons">🫠</div><h3>הרשימה המלאה לא נבנתה הפעם</h3><p>אפשר לנסות שוב, או להוסיף פריטים ידנית בשורה למעלה.</p><button type="button" class="btn btn-amber" id="cl-retry-gen">${ICON.refresh} לנסות שוב</button></div>`;
    }

    function quickAddHtml(scope) {
      const ph = scope === 'personal' ? 'הוספה לרשימה שלי… (#לקנות, #לארוז, !דחוף)' : 'הוספה לרשימה המשותפת… (#להזמין, #אונליין, !דחוף)';
      return `
        <form class="cl-add" data-scope="${scope}" autocomplete="off">
          <input type="text" name="title" placeholder="${ph}" maxlength="120" aria-label="פריט חדש">
          <select name="section" aria-label="סעיף">${['', ...allSectionNames().filter((s) => !items().some((it) => it.section === s && it.source === 'core'))].map((s) => `<option value="${esc(s)}">${s ? esc(s) : 'סעיף…'}</option>`).join('')}<option value="__new">+ סעיף חדש</option></select>
          <button type="submit" class="btn btn-amber" aria-label="הוספה">${ICON.plus}</button>
        </form>`;
    }

    // ---- משותף / אישי ----

    function scopeHtml(list, scope) {
      const shown = hideDone ? list.filter((it) => !it.done) : list;
      const secs = sectionsOf(shown);
      const emptyLine = list.length
        ? `<div class="cl-empty-line">הכול כאן מסומן ✓${hideDone ? ' — "הצגת שבוצעו" בתפריט מחזירה אותם' : ''}</div>`
        : (data.meta.status === 'ready' ? `<div class="cl-empty-line">${scope === 'personal' ? 'אין עדיין פריטים אישיים — הוסיפו משהו שרק אתם צריכים' : 'אין עדיין פריטים משותפים — הוסיפו מה שמישהו אחד עושה בשם כולם'}</div>` : '');
      return `
        ${quickAddHtml(scope)}
        ${scope === 'personal' && participants().length > 1 ? `<div class="cl-note-line">${ICON.lock} הסימונים כאן הם שלכם בלבד; פריט שתוסיפו כאן רואים רק אתם</div>` : ''}
        ${secs.length ? secs.map((s) => sectionHtml(s, { pro: false })).join('') : emptyLine}`;
    }

    function sectionHtml(sec, { pro }) {
      const p = progress(sec.items);
      const isCore = sec.items[0].source === 'core';
      const off = collapsed.has(sec.name);
      const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
      return `
        <section class="cl-sec glass${isCore ? ' core' : ''}${off ? ' collapsed' : ''}${pct === 100 ? ' complete' : ''}" data-sec="${esc(sec.name)}">
          <header class="cl-sec-head">
            <button type="button" class="cl-sec-toggle" aria-expanded="${!off}">
              <span class="cl-sec-name">${isCore ? '⭐ ' : ''}${esc(sec.name)}</span>
              <span class="cl-sec-count">${p.done}/${p.total}</span>
              <span class="cl-sec-bar"><i style="--w:${pct}%"></i></span>
              <span class="cl-sec-chev">${ICON.chev}</span>
            </button>
            ${pro ? `<span class="cl-sec-bulk"><button type="button" class="cl-bulk" data-done="1" title="סימון כל הסעיף">✓ הכל</button><button type="button" class="cl-bulk" data-done="0" title="ניקוי הסימונים בסעיף">↺</button></span>` : ''}
          </header>
          <div class="cl-sec-body">${sec.items.map((it) => rowHtml(it, { pro })).join('')}</div>
        </section>`;
    }

    function tagChips(it, full) {
      return it.tags.filter((k) => k !== 'later' && T.byKey[k]).map((k) => {
        const t = T.byKey[k];
        return `<span class="cl-tag t-${k}" style="--c:${t.color}" title="${esc(t.hint)}">${t.emoji}${full ? ` ${esc(t.label)}` : ''}</span>`;
      }).join('');
    }

    function rowHtml(it, { pro, showSection = false }) {
      const due = dueInfo(it);
      const who = it.scope === 'shared' && it.done && it.done_by_name ? `<span class="cl-who" title="מי סימן">✓ ${esc(it.done_by === me() ? myName() : it.done_by_name)}</span>` : '';
      const ticks = it.scope === 'personal' && !it.mine && participants().length > 1 && it.tick_count
        ? `<span class="cl-ticks" title="כמה מהמשתתפים סימנו">${ICON.users} ${it.tick_count}/${participants().length}</span>` : '';
      const assignee = it.scope === 'shared' && it.assignee_id
        ? `<span class="cl-avatar${it.assignee_id === me() ? ' me' : ''}" title="אחראי: ${esc(nameOf(it.assignee_id) || it.assignee_name || '')}">${esc(initials(nameOf(it.assignee_id) || it.assignee_name))}</span>` : '';
      const stars = it.priority ? `<span class="cl-stars p${it.priority}" title="${it.priority === 2 ? 'קריטי' : 'חשוב'}">${'★'.repeat(it.priority)}</span>` : '';
      const scopeDot = pro ? `<span class="cl-scope ${it.scope}" title="${it.scope === 'shared' ? 'משותף — סימון אחד לכולם' : 'אישי — כל אחד מסמן לעצמו'}">${it.scope === 'shared' ? ICON.users : ICON.user}</span>` : '';
      const online = it.tags.includes('online') || it.search;
      return `
        <div class="cl-item${it.done ? ' is-done' : ''}${isUrgent(it) ? ' is-hot' : ''} p${it.priority}" data-id="${it.id}">
          <button type="button" class="cl-check" data-id="${it.id}" aria-pressed="${it.done}" aria-label="${it.done ? 'ביטול סימון' : 'סימון כבוצע'}: ${esc(it.title)}">${ICON.check}</button>
          <button type="button" class="cl-main" data-id="${it.id}" aria-label="פרטי הפריט: ${esc(it.title)}">
            <span class="cl-title">${scopeDot}${esc(it.title)}${stars}${it.mine ? `<span class="cl-private" title="רק אתם רואים את זה">${ICON.lock}</span>` : ''}</span>
            ${(it.note || it.why) && !it.done ? `<span class="cl-notetext">${esc(it.note || it.why)}</span>` : ''}
            <span class="cl-meta">
              ${showSection ? `<span class="cl-secchip">${esc(it.section)}</span>` : ''}
              ${tagChips(it, pro)}
              ${due ? `<span class="cl-due ${due.cls}" title="${esc(due.label)}">${esc(due.text)}</span>` : ''}
              ${assignee}${who}${ticks}
            </span>
          </button>
          <span class="cl-acts">
            ${it.link ? `<a class="cl-act" href="${esc(it.link)}" target="_blank" rel="noopener" title="פתיחת הקישור">${ICON.link}</a>` : ''}
            ${online && !it.link ? `<a class="cl-act" href="${esc(searchUrl(it))}" target="_blank" rel="noopener" title="חיפוש אונליין">${ICON.search}</a>` : ''}
            ${pro ? `<button type="button" class="cl-act cl-snooze" data-id="${it.id}" title="${isSnoozed(it) ? 'החזרה לרשימה' : 'לדחות להמשך'}">⏳</button>` : ''}
          </span>
        </div>`;
    }

    function snoozedHtml(which) {
      let list = items().filter(isSnoozed);
      if (which === 'shared') list = list.filter((it) => it.scope === 'shared');
      if (which === 'personal') list = list.filter((it) => it.scope === 'personal');
      if (!list.length) return '';
      const off = !collapsed.has('__later') ? true : false; // closed by default, remembered when opened
      return `
        <section class="cl-sec glass later${off ? ' collapsed' : ''}" data-sec="__later">
          <header class="cl-sec-head"><button type="button" class="cl-sec-toggle" aria-expanded="${!off}">
            <span class="cl-sec-name">⏳ נדחה להמשך</span><span class="cl-sec-count">${list.length}</span><span class="cl-sec-chev">${ICON.chev}</span></button></header>
          <div class="cl-sec-body">${list.map((it) => rowHtml(it, { pro: true, showSection: true })).join('')}</div>
        </section>`;
    }

    // ---- פרו ----

    function applyFilters(list) {
      let out = list;
      if (filterTags.size) out = out.filter((it) => it.tags.some((k) => filterTags.has(k)) || (filterTags.has('urgent') && isUrgent(it)));
      if (filterMine) out = out.filter((it) => it.assignee_id === me() || it.mine || it.scope === 'personal');
      if (filterOpen || hideDone) out = out.filter((it) => !it.done);
      if (filterSection) out = out.filter((it) => it.section === filterSection);
      return out;
    }

    function proHtml(live) {
      const counts = {};
      for (const it of live) for (const k of it.tags) counts[k] = (counts[k] || 0) + (it.done ? 0 : 1);
      const urgentN = live.filter(isUrgent).length;
      const shown = applyFilters(live);
      const stats = T.TAGS.filter((t) => t.key !== 'later' && counts[t.key]).map((t) => `<span class="cl-stat" style="--c:${t.color}">${t.emoji} ${counts[t.key]} ${esc(t.label)}</span>`).join('');
      return `
        ${quickAddHtml('shared')}
        <div class="cl-pro-bar glass">
          <div class="cl-views" role="tablist">${PRO_VIEWS.map((v) => `<button type="button" role="tab" class="cl-view${proView === v.key ? ' on' : ''}" data-view="${v.key}" aria-selected="${proView === v.key}">${v.label}</button>`).join('')}</div>
          <div class="cl-filters">
            <button type="button" class="cl-filter${filterOpen ? ' on' : ''}" data-f="open">${ICON.eye} פתוחים בלבד</button>
            <button type="button" class="cl-filter${filterMine ? ' on' : ''}" data-f="mine">${ICON.user} שלי</button>
            ${T.TAGS.filter((t) => t.key !== 'later').map((t) => {
              const n = t.key === 'urgent' ? urgentN : (counts[t.key] || 0);
              return `<button type="button" class="cl-filter tag${filterTags.has(t.key) ? ' on' : ''}" data-tag="${t.key}" style="--c:${t.color}">${t.emoji} ${esc(t.label)}${n ? `<b>${n}</b>` : ''}</button>`;
            }).join('')}
            <select class="cl-filter-sec" aria-label="סינון לפי סעיף"><option value="">כל הסעיפים</option>${allSectionNames().map((s) => `<option value="${esc(s)}"${filterSection === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
          </div>
          ${stats ? `<div class="cl-stats">${stats}</div>` : ''}
        </div>
        ${proView === 'section' ? proBySection(shown) : proView === 'due' ? proByDue(shown) : proView === 'shop' ? proShop(live) : proByWho(shown)}`;
    }

    const noMatch = () => `<div class="cl-empty-line">אין פריטים שמתאימים לסינון</div>`;

    function proBySection(shown) {
      const secs = sectionsOf(shown);
      return secs.length ? secs.map((s) => sectionHtml(s, { pro: true })).join('') : noMatch();
    }

    // groups by when, then by how loud; the flat row carries its section as a chip
    function proByDue(shown) {
      const hasDates = daysToTrip() !== null;
      const groups = hasDates
        ? [{ key: 'overdue', name: '🔥 באיחור', test: (d) => d && d.diff < 0 }, { key: 'week', name: '📍 השבוע', test: (d) => d && d.diff >= 0 && d.diff <= 7 },
          { key: 'month', name: '🗓️ החודש', test: (d) => d && d.diff > 7 && d.diff <= 30 }, { key: 'later', name: '🌊 אחר כך', test: (d) => d && d.diff > 30 }, { key: 'none', name: '∞ בלי מועד', test: (d) => !d }]
        : T.DUE_OPTIONS.slice(1).reverse().map((o) => ({ key: String(o.days), name: `⏱️ ${o.label}`, test: (d, it) => it.due_days === o.days })).concat([{ key: 'none', name: '∞ בלי מועד', test: (d) => !d }]);
      const sorted = shown.slice().sort((a, b) => (dueInfo(a)?.diff ?? 9999) - (dueInfo(b)?.diff ?? 9999) || b.priority - a.priority);
      const html = groups.map((g) => {
        const list = sorted.filter((it) => g.test(dueInfo(it), it));
        if (!list.length) return '';
        const p = progress(list);
        return `<section class="cl-sec glass due-${g.key}" data-sec="${g.key}"><header class="cl-sec-head"><div class="cl-sec-toggle static"><span class="cl-sec-name">${g.name}</span><span class="cl-sec-count">${p.done}/${p.total}</span></div></header>
          <div class="cl-sec-body">${list.map((it) => rowHtml(it, { pro: true, showSection: true })).join('')}</div></section>`;
      }).join('');
      return html || noMatch();
    }

    function proShop(live) {
      const list = live.filter((it) => it.tags.includes('buy'));
      const open = list.filter((it) => !it.done);
      if (!list.length) return `<div class="cl-empty-line">אין עדיין פריטים "לקנות" — מסמנים פריט בתגית 🛒 והוא מופיע כאן כרשימת קניות</div>`;
      return `
        <div class="cl-shop-head">
          <span>🛒 ${open.length} לקנות${list.length - open.length ? ` · ${list.length - open.length} נקנו` : ''}</span>
          <span class="cl-shop-acts"><button type="button" class="btn btn-ghost" id="cl-shop-copy">${ICON.copy} העתקה</button><button type="button" class="btn btn-ghost" id="cl-shop-wa">${TRIPMAKER.waIcon} וואטסאפ</button></span>
        </div>
        <section class="cl-sec glass"><div class="cl-sec-body">${list.slice().sort((a, b) => a.done - b.done).map((it) => rowHtml(it, { pro: true, showSection: true })).join('')}</div></section>`;
    }

    function proByWho(shown) {
      const shared = shown.filter((it) => it.scope === 'shared');
      const people = participants().length ? participants() : [{ id: me(), name: myName() }];
      const groups = people.map((p) => ({ key: p.id, name: `${esc(initials(p.id === me() ? myName() : p.name))}`, title: p.id === me() ? `${myName()} (אני)` : p.name, list: shared.filter((it) => it.assignee_id === p.id) }));
      const nobody = shared.filter((it) => !it.assignee_id);
      const sec = (title, list, avatar) => (list.length ? `<section class="cl-sec glass" data-sec="who"><header class="cl-sec-head"><div class="cl-sec-toggle static"><span class="cl-sec-name">${avatar ? `<span class="cl-avatar">${avatar}</span>` : '👤'} ${esc(title)}</span><span class="cl-sec-count">${progress(list).done}/${list.length}</span></div></header>
        <div class="cl-sec-body">${list.map((it) => rowHtml(it, { pro: true, showSection: true })).join('')}</div></section>` : '');
      const html = groups.map((g) => sec(g.title, g.list, g.name)).join('') + sec('עדיין בלי אחראי — לוחצים על פריט ובוחרים מי', nobody, '');
      return html || `<div class="cl-empty-line">אין פריטים משותפים לחלק</div>`;
    }

    // ---------------- wiring ----------------

    function wirePage() {
      body.querySelectorAll('.cl-tab').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; prefs.tab = tab; savePrefs(); paintPage(); TRIPMAKER.track?.('checklist_tab', { code: ctx.trip.share_code, tab }); }; });
      body.querySelectorAll('.cl-check').forEach((b) => { b.onclick = () => { const it = items().find((x) => x.id === +b.dataset.id); if (it) toggle(it); }; });
      body.querySelectorAll('.cl-main').forEach((b) => { b.onclick = () => { const it = items().find((x) => x.id === +b.dataset.id); if (it) openItem(it); }; });
      body.querySelectorAll('.cl-snooze').forEach((b) => {
        b.onclick = async () => {
          const it = items().find((x) => x.id === +b.dataset.id); if (!it) return;
          const tags = isSnoozed(it) ? it.tags.filter((k) => k !== 'later') : [...it.tags, 'later'];
          if (await patch(it, { tags })) TripPages.toast(isSnoozed(it) ? '⏳ נדחה להמשך' : 'חזר לרשימה', 'ok');
        };
      });
      body.querySelectorAll('.cl-sec-toggle:not(.static)').forEach((b) => {
        b.onclick = () => {
          const name = b.closest('.cl-sec').dataset.sec;
          if (name === '__later') { if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name); } // inverted: open is the remembered state
          else if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
          prefs.collapsed = [...collapsed]; savePrefs(); paintPage();
        };
      });
      body.querySelectorAll('.cl-bulk').forEach((b) => {
        b.onclick = () => {
          const sec = b.closest('.cl-sec');
          const ids = [...sec.querySelectorAll('.cl-item')].map((r) => +r.dataset.id);
          bulk(ids, b.dataset.done === '1');
        };
      });
      body.querySelectorAll('.cl-add').forEach((f) => {
        const sel = f.querySelector('select');
        sel.onchange = () => {
          if (sel.value !== '__new') return;
          const name = prompt('שם הסעיף החדש:');
          if (name && name.trim()) { const o = document.createElement('option'); o.value = o.textContent = name.trim().slice(0, 60); sel.insertBefore(o, sel.lastElementChild); sel.value = o.value; } else sel.value = '';
        };
        f.onsubmit = async (e) => {
          e.preventDefault();
          const input = f.querySelector('input');
          const { title, tags } = T.parseQuickAdd(input.value);
          if (!title) return;
          const scope = f.dataset.scope;
          const section = sel.value && sel.value !== '__new' ? sel.value : (scope === 'personal' ? 'שלי' : 'שונות');
          input.value = '';
          if (await add({ title, tags, scope, section })) {
            TripPages.toast(`נוסף${tags.length ? ` עם ${tags.map((k) => T.byKey[k].emoji).join('')}` : ''} ✓`, 'ok');
            TRIPMAKER.track?.('checklist_add', { code: ctx.trip.share_code, scope, tags });
          }
        };
      });
      body.querySelectorAll('.cl-view').forEach((b) => { b.onclick = () => { proView = b.dataset.view; prefs.proView = proView; savePrefs(); paintPage(); }; });
      body.querySelectorAll('.cl-filter').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.f === 'open') filterOpen = !filterOpen;
          else if (b.dataset.f === 'mine') filterMine = !filterMine;
          else if (filterTags.has(b.dataset.tag)) filterTags.delete(b.dataset.tag); else filterTags.add(b.dataset.tag);
          paintPage();
        };
      });
      const secSel = body.querySelector('.cl-filter-sec');
      if (secSel) secSel.onchange = () => { filterSection = secSel.value; paintPage(); };
      body.querySelector('#cl-retry-gen')?.addEventListener('click', () => generate(false));
      body.querySelector('#cl-shop-copy')?.addEventListener('click', () => copyText(items().filter((it) => it.tags.includes('buy')), '🛒 רשימת קניות'));
      body.querySelector('#cl-shop-wa')?.addEventListener('click', () => shareWa(items().filter((it) => it.tags.includes('buy')), '🛒 רשימת קניות'));
      // the hint under the generating line turns over while the model works
      const hintEl = body.querySelector('.cl-gen-hint');
      if (hintEl) {
        const hints = JSON.parse(hintEl.dataset.hints);
        let i = 0;
        const timer = setInterval(() => { if (!hintEl.isConnected) return clearInterval(timer); hintEl.textContent = hints[++i % hints.length]; }, 2800);
      }
    }

    // ---------------- the item sheet ----------------

    function openItem(it) {
      const core = it.source === 'core';
      const secNames = allSectionNames().filter((s) => !items().some((x) => x.section === s && x.source === 'core' && s !== it.section));
      const people = participants();
      const due = dueInfo(it);
      TripPages.sheet('cl-item-sheet', {
        title: core ? `⭐ ${esc(it.title)}` : 'פריט ברשימה',
        sub: core ? 'אחד משלושת הפריטים החשובים — אפשר לסמן ולתייג, לא למחוק' : `${it.scope === 'shared' ? 'משותף — סימון אחד לכולם' : it.mine ? 'אישי ופרטי — רק אתם רואים' : 'אישי — כל משתתף מסמן לעצמו'}${it.source === 'ai' ? ' · הוצע על ידי ה-AI' : ''}`,
        cls: 'cl-sheet',
        html: `
          <form id="cl-item-form" autocomplete="off">
            ${core ? '' : `<label class="cl-f"><span>כותרת</span><input name="title" value="${esc(it.title)}" maxlength="120" required></label>`}
            <label class="cl-f"><span>הערה</span><textarea name="note" rows="2" maxlength="300" placeholder="איפה, כמה, למה…">${esc(it.note || '')}</textarea></label>
            <div class="cl-f"><span>תגיות</span><div class="cl-tagpick">${T.TAGS.map((t) => `<button type="button" class="cl-tagbtn${it.tags.includes(t.key) ? ' on' : ''}" data-tag="${t.key}" style="--c:${t.color}" title="${esc(t.hint)}">${t.emoji} ${esc(t.label)}</button>`).join('')}</div></div>
            <div class="cl-f-row">
              <div class="cl-f"><span>עדיפות</span><div class="cl-prio" role="radiogroup">${[0, 1, 2].map((p) => `<button type="button" class="cl-prio-btn${it.priority === p ? ' on' : ''}" data-p="${p}" role="radio" aria-checked="${it.priority === p}">${p === 0 ? 'רגיל' : p === 1 ? '★ חשוב' : '★★ קריטי'}</button>`).join('')}</div></div>
              <label class="cl-f"><span>מועד</span><select name="due_days">${T.DUE_OPTIONS.map((o) => `<option value="${o.days === null ? '' : o.days}"${it.due_days === o.days ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${due && due.cls !== 'nodate' ? `<small class="cl-due ${due.cls}">${esc(due.text)}</small>` : ''}</label>
            </div>
            <div class="cl-f-row">
              ${core ? '' : `<div class="cl-f"><span>סוג</span><div class="cl-seg" role="radiogroup"><button type="button" class="cl-seg-btn${it.scope === 'shared' ? ' on' : ''}" data-scope="shared" role="radio" aria-checked="${it.scope === 'shared'}">${ICON.users} משותף</button><button type="button" class="cl-seg-btn${it.scope === 'personal' ? ' on' : ''}" data-scope="personal" role="radio" aria-checked="${it.scope === 'personal'}">${ICON.user} אישי</button></div></div>`}
              <label class="cl-f cl-f-assignee"${it.scope === 'shared' ? '' : ' hidden'}><span>אחראי/ת</span><select name="assignee_id"><option value="">— אין —</option>${(people.length ? people : [{ id: me(), name: myName() }]).map((p) => `<option value="${p.id}"${it.assignee_id === p.id ? ' selected' : ''}>${esc(p.id === me() ? `${myName()} (אני)` : p.name)}</option>`).join('')}</select></label>
            </div>
            ${core ? '' : `<label class="cl-f"><span>סעיף</span><input name="section" list="cl-sections" value="${esc(it.section)}" maxlength="60"><datalist id="cl-sections">${secNames.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>`}
            <div class="cl-f-row">
              ${core ? '' : `<label class="cl-f"><span>קישור</span><input name="link" type="url" inputmode="url" dir="ltr" placeholder="https://…" value="${esc(it.link || '')}"></label>`}
              <label class="cl-f"><span>מילות חיפוש</span><input name="search" value="${esc(it.search || '')}" maxlength="160" placeholder="${esc(it.title)}"></label>
            </div>
            <div class="cl-sheet-acts">
              <a class="btn btn-ghost" href="${esc(it.link || searchUrl(it))}" target="_blank" rel="noopener">${it.link ? ICON.link : ICON.search} ${it.link ? 'פתיחת הקישור' : 'חיפוש אונליין'}</a>
              <button type="button" class="btn btn-ghost" id="cl-sheet-snooze">⏳ ${isSnoozed(it) ? 'להחזיר לרשימה' : 'לדחות להמשך'}</button>
              ${core ? '' : `<button type="button" class="btn btn-ghost danger" id="cl-sheet-del">${ICON.trash} מחיקה</button>`}
            </div>
            <div class="cl-sheet-foot">
              <button type="button" class="btn btn-ghost" id="cl-sheet-toggle">${it.done ? '↺ ביטול הסימון' : '✓ סימון כבוצע'}</button>
              <button type="submit" class="btn btn-amber">שמירה</button>
            </div>
          </form>`,
        onOpen: (el) => {
          const form = el.querySelector('#cl-item-form');
          const tags = new Set(it.tags);
          let priority = it.priority;
          let scope = it.scope;
          el.querySelectorAll('.cl-tagbtn').forEach((b) => { b.onclick = () => { const k = b.dataset.tag; if (tags.has(k)) tags.delete(k); else tags.add(k); b.classList.toggle('on', tags.has(k)); }; });
          el.querySelectorAll('.cl-prio-btn').forEach((b) => { b.onclick = () => { priority = +b.dataset.p; el.querySelectorAll('.cl-prio-btn').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); }; });
          el.querySelectorAll('.cl-seg-btn').forEach((b) => {
            b.onclick = () => {
              scope = b.dataset.scope;
              el.querySelectorAll('.cl-seg-btn').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
              el.querySelector('.cl-f-assignee').hidden = scope !== 'shared';
            };
          });
          el.querySelector('#cl-sheet-snooze').onclick = async () => {
            const next = isSnoozed(it) ? it.tags.filter((k) => k !== 'later') : [...it.tags, 'later'];
            if (await patch(it, { tags: next })) TripPages.closeSheet(() => TripPages.toast(next.includes('later') ? '⏳ נדחה להמשך — יחכה בתחתית הרשימה' : 'חזר לרשימה', 'ok'));
          };
          el.querySelector('#cl-sheet-toggle').onclick = () => { toggle(it); TripPages.closeSheet(); };
          el.querySelector('#cl-sheet-del')?.addEventListener('click', async () => {
            if (!confirm(`למחוק את "${it.title}" מהרשימה${it.scope === 'shared' || !it.mine ? ' לכל המשתתפים' : ''}?`)) return;
            if (await remove(it)) TripPages.closeSheet(() => TripPages.toast('נמחק', 'ok'));
          });
          form.onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const fields = {
              note: fd.get('note'), tags: [...tags], priority, due_days: fd.get('due_days') === '' ? null : +fd.get('due_days'),
              search: fd.get('search'),
            };
            if (!core) {
              fields.title = fd.get('title'); fields.section = fd.get('section'); fields.link = fd.get('link'); fields.scope = scope;
            }
            if (scope === 'shared') fields.assignee_id = fd.get('assignee_id') || null;
            if (await patch(it, fields)) TripPages.closeSheet(() => TripPages.toast('נשמר ✓', 'ok'));
          };
        },
      });
    }

    // ---------------- the ⋯ menu ----------------

    function openMenu() {
      const rows = [
        { id: 'regen', ic: ICON.refresh, t: 'רענון מה-AI', d: 'בונה את הרשימה מחדש לפי המסלול הנוכחי — מה שהוספתם וסימנתם ידנית נשאר' },
        { id: 'hide', ic: ICON.eye, t: hideDone ? 'הצגת מה שבוצע' : 'הסתרת מה שבוצע', d: 'בכל הטאבים, במכשיר הזה' },
        { id: 'copy', ic: ICON.copy, t: 'העתקה כטקסט', d: 'כל הרשימה, להדבקה בכל מקום' },
        { id: 'wa', ic: TRIPMAKER.waIcon, t: 'שיתוף בוואטסאפ', d: 'הרשימה הפתוחה — למי שצריך לזכור' },
        { id: 'expand', ic: ICON.chev, t: collapsed.size ? 'פתיחת כל הסעיפים' : 'קיפול כל הסעיפים', d: 'תצוגה בלבד' },
        { id: 'reset', ic: ICON.trash, t: 'איפוס הסימונים', d: 'מנקה את כל הסימונים (שלכם, ושל הפריטים המשותפים) — הפריטים נשארים' },
      ];
      TripPages.sheet('cl-menu-sheet', {
        title: 'הצ\'קליסט',
        sub: moreDesc(),
        html: `<div class="more-list">${rows.map((r) => `<button type="button" class="more-row" data-act="${r.id}"><span class="mr-ic">${r.ic}</span><span class="mr-text"><b>${esc(r.t)}</b><small>${esc(r.d)}</small></span><span class="mr-chev" aria-hidden="true">‹</span></button>`).join('')}</div>`,
        onOpen: (el) => {
          el.querySelectorAll('.more-row').forEach((r) => {
            r.onclick = () => TripPages.closeSheet(() => act(r.dataset.act));
          });
        },
      });
    }

    async function act(id) {
      if (id === 'regen') {
        if (!confirm('לבנות את הרשימה מחדש? הפריטים שה-AI הציע יוחלפו; מה שהוספתם ידנית, שלושת החשובים והסימונים עליהם נשארים.')) return;
        generate(true);
      } else if (id === 'hide') { hideDone = !hideDone; prefs.hideDone = hideDone; savePrefs(); paintPage(); }
      else if (id === 'copy') copyText(items(), null);
      else if (id === 'wa') shareWa(items().filter((it) => !it.done), null);
      else if (id === 'expand') {
        if (collapsed.size) collapsed.clear(); else allSectionNames().forEach((s) => collapsed.add(s));
        prefs.collapsed = [...collapsed]; savePrefs(); paintPage();
      } else if (id === 'reset') {
        if (!confirm('לאפס את כל הסימונים ברשימה?')) return;
        await bulk(items().filter((it) => it.done).map((it) => it.id), false);
        TripPages.toast('הסימונים נוקו', 'ok');
      }
    }

    // ---------------- text out ----------------

    function asText(list, heading) {
      const lines = [`${heading || '✅ צ\'קליסט'} — ${ctx.trip.title}`];
      for (const s of sectionsOf(list.filter((it) => !isSnoozed(it)))) {
        lines.push('', `📌 ${s.name}`);
        for (const it of s.items) {
          const tags = it.tags.filter((k) => k !== 'later' && T.byKey[k]).map((k) => T.byKey[k].emoji).join('');
          const due = it.due_days !== null && it.due_days !== undefined ? ` (${T.dueLabel(it.due_days)})` : '';
          const who = it.scope === 'shared' && it.assignee_id ? ` — ${nameOf(it.assignee_id) || it.assignee_name || ''}` : '';
          lines.push(`${it.done ? '☑' : '☐'} ${it.title}${tags ? ' ' + tags : ''}${due}${who}`);
        }
      }
      lines.push('', `${location.origin}/trip/${ctx.trip.share_code}#checklist`);
      return lines.join('\n');
    }
    async function copyText(list, heading) {
      try { await navigator.clipboard.writeText(asText(list, heading)); TripPages.toast('הרשימה הועתקה ✓', 'ok'); } catch { TripPages.toast('ההעתקה לא הצליחה'); }
      TRIPMAKER.track?.('checklist_export', { code: ctx.trip.share_code, how: 'copy' });
    }
    function shareWa(list, heading) {
      window.open('https://wa.me/?text=' + encodeURIComponent(asText(list, heading)), '_blank', 'noopener');
      TRIPMAKER.track?.('checklist_export', { code: ctx.trip.share_code, how: 'whatsapp' });
    }

    TRIPMAKER.track?.('checklist_open', { code: ctx.trip.share_code });
  }

  return { prefetch, initWidget, render, moreDesc };
})();
