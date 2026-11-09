// The trip page as tabs and panels — the trip page for everyone since 2026-11-04 (it was an
// admin-only preview for a day before that).
//
// The trip page is four places a traveller goes to, plus a gear, instead of one long
// scroll with a toolbar of fourteen actions.
//
//   מסלול    the itinerary itself. What used to be loose widgets above and beside it
//            (the pre-flight checklist, the weather, the map) are panels that fold to
//            one summary line, and every day folds the same way under one compact bar.
//   חברים    who is coming, the money between them — who owes whom, Splitwise-style,
//            with an optional budget — and the invite. Money lives with the people it is split
//            between, not in a tab of its own.
//   מלונות   the hotels page, unchanged — it already is a page of panels.
//   תחבורה   every flight, train and drive in the trip in one list, with the tickets
//            (documents) and the reminders that ring before them.
//   ✨       the AI keeps its tab (המלצות / תכנון), so it is never more than a tap away.
//
// חברים, מלונות and תחבורה are for the trip's people; a gallery visitor's dock is the
// itinerary and the AI. The gear in the hero holds what is set once or done rarely:
// sharing, publishing to the gallery, export (PDF, calendar) and copying the trip.
// "עוד" is gone: everything it held now has a place.
//
// Nothing here owns data or logic. The tabs are TripPages pages like every other one
// (same history, same back gesture, same dock), and every action clicks the button
// trip.js already wires — exactly as the "עוד" sheet does — so permissions, sign-up
// walls and the modals behind them behave as they do on the classic page. If this file
// fails to load, the page is the classic one: the toolbar and "עוד" are still there.
const TripTabs = (() => {
  try { localStorage.removeItem('tm_trip_tabs'); } catch { /* the old preview switch means nothing now */ }
  const PANELS_KEY = 'tm_tt_panels';   // { panelId: true|false } — folded or open
  const esc = (s) => TRIPMAKER.esc(s);
  let ctx = null;
  let active = false;

  const IC = {
    friends: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    transport: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    chev: '<svg class="ic tt-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    wallet: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>',
    share: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/></svg>',
    doc: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>',
    bell: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    sun: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    map: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg>',
    globe: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>',
  };

  // ---------- panel memory ----------
  function panelMem() { try { return JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') || {}; } catch { return {}; } }
  function isOpen(id, dflt) { const m = panelMem(); return id in m ? !!m[id] : dflt; }
  function remember(id, on) {
    const m = panelMem(); m[id] = !!on;
    try { localStorage.setItem(PANELS_KEY, JSON.stringify(m)); } catch { /* this visit only */ }
  }

  // A panel: a glass card whose head is one button — icon, title, the line that says
  // what is inside, and a chevron. Folded, the summary line is the whole panel.
  function panelHtml({ id, ic, title, sum = '', body = '', open = true, tone = '' }) {
    return `
      <section class="tt-panel glass${tone ? ' tt-' + tone : ''}${open ? ' is-open' : ''}" data-panel="${id}">
        <button type="button" class="tt-head" aria-expanded="${open}">
          <span class="tt-ic">${ic}</span>
          <span class="tt-titles"><b>${title}</b><small class="tt-sum">${sum}</small></span>
          ${IC.chev}
        </button>
        <div class="tt-body">${body}</div>
      </section>`;
  }
  function wirePanels(root) {
    root.querySelectorAll('.tt-panel > .tt-head').forEach((h) => {
      if (h.dataset.wired) return;
      h.dataset.wired = '1';
      h.addEventListener('click', () => {
        const p = h.parentElement;
        const on = !p.classList.contains('is-open');
        p.classList.toggle('is-open', on);
        h.setAttribute('aria-expanded', on);
        remember(p.dataset.panel, on);
      });
    });
  }

  // an existing element of the page, moved into a panel (its owner keeps painting it)
  function wrapExisting(el, def, before) {
    if (!el || el.closest('.tt-panel')) return null;
    const holder = document.createElement('div');
    holder.innerHTML = panelHtml({ ...def, open: isOpen(def.id, def.open !== false) });
    const panel = holder.firstElementChild;
    panel.classList.add('tt-wrap');
    before.parentNode.insertBefore(panel, before);
    panel.querySelector('.tt-body').appendChild(el);
    return panel;
  }

  const click = (id) => document.getElementById(id)?.click();
  const shown = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== 'none'; };
  const money = (n) => TripModals.fmt(n, TripModals.curOf(ctx.state));
  const dayDate = (day) => {
    const s = ctx.state.trip.start_date;
    if (!s) return null;
    const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
    d.setDate(d.getDate() + day - 1);
    return d;
  };
  const dayLabel = (day) => {
    const d = dayDate(day);
    return `יום ${day}${d ? ' · ' + d.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short' }) : ''}`;
  };
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');

  // ---------- חברים ----------
  function renderFriends(slots) {
    const s = ctx.state;
    const people = s.participants || [];
    // the money: who owes whom first (the point of it), the budget only if someone set one
    const mx = TripModals.computeMoney(s);
    const cap = s.budget ? +s.budget.total || 0 : 0;
    const spent = mx.spent;
    const pct = cap ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
    const tone = cap && spent > cap ? 'over' : cap && spent >= cap * 0.8 ? 'warn' : '';

    const crew = `
      <div class="tt-crew">
        ${people.map((p) => `<span class="tt-person"><span class="tt-ava">${esc(initials(p.name))}</span><span>${esc(p.name)}${p.is_owner ? ' <em>מארגן/ת</em>' : ''}</span></span>`).join('')}
      </div>
      <div class="tt-actions">
        <button type="button" class="btn btn-amber tt-btn" data-click="participants-btn">הזמנת חברים וניהול</button>
      </div>`;

    const xfers = mx.transfers.slice(0, 3);
    const moneyBody = `
      ${!mx.count
        ? `<p class="tt-note">${people.length > 1 ? 'מי ששילם על משהו לכולם מוסיף אותו כאן — ואנחנו מחשבים מי מעביר כמה למי.' : 'כשיהיו עוד אנשים בטיול, מוסיפים כאן הוצאות ומקבלים מי חייב למי.'}</p>`
        : xfers.length
          ? `<div class="tt-xfers">${xfers.map((t) => `<div class="tt-xfer"><span><b>${esc(t.from.split(' ')[0])}</b> ← <b>${esc(t.to.split(' ')[0])}</b></span><b class="tt-xfer-amt">${money(t.amount)}</b></div>`).join('')}
             ${mx.transfers.length > xfers.length ? `<p class="tt-note">ועוד ${mx.transfers.length - xfers.length}…</p>` : ''}</div>`
          : '<p class="tt-note">כולם מאוזנים 🎉 אף אחד לא חייב לאף אחד</p>'}
      ${cap ? `
        <div class="tt-meter ${tone}"><i style="width:${pct}%"></i></div>
        <div class="tt-meter-row"><span>הוצאתם <b>${money(spent)}</b></span><span>מתוך <b>${money(cap)}</b></span></div>` : ''}
      <div class="tt-actions">
        <button type="button" class="btn btn-amber tt-btn" data-click="expense-add-btn">+ הוספת הוצאה</button>
        <button type="button" class="btn btn-ghost tt-btn" data-click="budget-btn">${IC.wallet} ${mx.count ? `כל ההוצאות (${mx.count})` : 'מי חייב למי'}</button>
      </div>`;

    const code = s.trip.share_code;
    const shareBody = `
      <div class="tt-code" dir="ltr">#${esc(code)}</div>
      <div class="tt-actions">
        <button type="button" class="btn btn-amber tt-btn" data-click="wa-share">שליחה בוואטסאפ</button>
        <button type="button" class="btn btn-ghost tt-btn" data-click="copy-link">העתקת קישור</button>
      </div>`;

    slots.body.innerHTML = `<div class="tp-inner tt-page">
      ${panelHtml({ id: 'crew', ic: IC.friends, title: 'מי בטיול', sum: people.length ? `${people.length} ${people.length === 1 ? 'מטייל' : 'מטיילים'} · ${esc(people.map((p) => p.name.split(' ')[0]).join(', '))}` : 'עוד אין משתתפים', body: crew, open: isOpen('crew', true) })}
      ${panelHtml({ id: 'money', ic: IC.wallet, title: 'מי חייב למי', tone, sum: mx.transfers.length ? `${mx.transfers.length} ${mx.transfers.length === 1 ? 'העברה' : 'העברות'} לסגירה${cap ? ` · ${pct}% מהתקציב` : ''}` : mx.count ? `${money(spent)} · כולם מאוזנים${cap ? ` · ${pct}% מהתקציב` : ''}` : 'עוד אין הוצאות', body: moneyBody, open: isOpen('money', true) })}
      ${s.trip.is_draft ? '' : panelHtml({ id: 'share', ic: IC.share, title: 'שיתוף הטיול', sum: `קוד ${esc(code)} · וואטסאפ או קישור`, body: shareBody, open: isOpen('share', false) })}
    </div>`;
    wireBody(slots.body);
  }

  // ---------- תחבורה ----------
  function renderTransport(slots) {
    const s = ctx.state;
    const legs = s.items.filter((it) => it.category === 'נסיעה')
      .sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')));
    const byDay = new Map();
    for (const it of legs) { if (!byDay.has(it.day_number)) byDay.set(it.day_number, []); byDay.get(it.day_number).push(it); }
    const legsBody = legs.length ? [...byDay].map(([day, its]) => `
        <div class="tt-legday"><span class="tt-legdate">${esc(dayLabel(day))}</span>
          ${its.map((it) => `
            <button type="button" class="tt-leg" data-item="${it.id}">
              <span class="tt-leg-ic">${TripModals.travelIcon(it)}</span>
              <span class="tt-leg-t"><b>${esc(it.title)}</b>${it.note ? `<small>${esc(it.note)}</small>` : ''}</span>
              <span class="tt-leg-m">${it.time_label ? `<b dir="ltr">${esc(it.time_label)}</b>` : ''}${+it.cost > 0 ? `<small>${money(+it.cost)}</small>` : ''}</span>
            </button>`).join('')}
        </div>`).join('')
      : '<p class="tt-note">אין עדיין טיסות, רכבות או נסיעות במסלול. אפשר לבקש מה-AI להוסיף אותן, או להוסיף תחנה מסוג נסיעה.</p>';
    const flights = legs.filter((it) => TripModals.travelIcon(it) === '✈️').length;
    const sum = legs.length
      ? [flights ? `${flights} ${flights === 1 ? 'טיסה' : 'טיסות'}` : '', legs.length - flights ? `${legs.length - flights} נסיעות` : ''].filter(Boolean).join(' · ')
      : 'עוד ריק';

    const docsN = +(document.querySelector('#docs-btn .ab-badge')?.textContent || 0) || 0;
    const momentsSum = typeof TripMoments !== 'undefined' ? TripMoments.moreDesc() : '';
    slots.body.innerHTML = `<div class="tp-inner tt-page">
      ${panelHtml({ id: 'legs', ic: IC.transport, title: 'טיסות ונסיעות', sum, body: legsBody, open: isOpen('legs', true) })}
      ${shown('docs-btn') ? panelHtml({ id: 'tickets', ic: IC.doc, title: 'כרטיסים ומסמכים', sum: docsN ? `${docsN} מסמכים שמורים במכשיר` : 'כרטיסי טיסה, דרכון, ביטוח', body: `<p class="tt-note">כרטיסי עלייה למטוס, דרכונים, הזמנות וביטוח — נשמרים במכשיר הזה בלבד.</p><div class="tt-actions"><button type="button" class="btn btn-ghost tt-btn" data-click="docs-btn">${IC.doc} פתיחת המסמכים</button></div>`, open: isOpen('tickets', false) }) : ''}
      ${shown('moments-btn') ? panelHtml({ id: 'moments', ic: IC.bell, title: 'תזכורות', sum: esc(momentsSum), body: `<p class="tt-note">הטלפון מצלצל לפני כל טיסה, רכבת וצ׳ק-אין — והמסמך נפתח בלחיצה.</p><div class="tt-actions"><button type="button" class="btn btn-ghost tt-btn" data-click="moments-btn">${IC.bell} כל התזכורות</button></div>`, open: isOpen('moments', false) }) : ''}
    </div>`;
    wireBody(slots.body);
    slots.body.querySelectorAll('.tt-leg').forEach((b) => {
      b.onclick = () => document.querySelector(`#days-container .item-card[data-item-id="${b.dataset.item}"]`)?.click();
    });
  }

  function wireBody(root) {
    wirePanels(root);
    root.querySelectorAll('[data-click]').forEach((b) => { b.onclick = () => click(b.dataset.click); });
  }

  // ---------- מסלול: the widgets become panels, the days fold ----------
  function panelizeItinerary() {
    const main = document.querySelector('#trip-layout > main');
    const days = document.getElementById('days-container');
    if (!main || !days) return;
    let rail = document.getElementById('tt-rail');
    if (!rail) {
      rail = document.createElement('div');
      rail.id = 'tt-rail';
      rail.className = 'tt-rail';
      const toggle = document.getElementById('view-toggle');
      main.insertBefore(rail, toggle || days);
    }
    // the draft's save card first — on a draft it is the one thing to do here
    const draft = document.getElementById('draft-card');
    if (draft && !draft.closest('.tt-rail')) rail.appendChild(draft);
    const cl = document.getElementById('checklist-widget');
    if (cl) wrapExisting(cl, { id: 'checklist', ic: IC.check, title: 'לפני הטיול', sum: typeof TripChecklist !== 'undefined' ? esc(TripChecklist.moreDesc()) : '', open: true }, rail.appendChild(document.createElement('i')));
    const wx = document.getElementById('weather-card');
    if (wx) wrapExisting(wx, { id: 'weather', ic: IC.sun, title: 'מזג אוויר', sum: '', open: false }, rail.appendChild(document.createElement('i')));
    const map = document.querySelector('.map-card');
    if (map) wrapExisting(map, { id: 'map', ic: IC.map, title: 'מפה', sum: 'כל התחנות, יום אחרי יום', open: false }, rail.appendChild(document.createElement('i')));
    rail.querySelectorAll(':scope > i').forEach((i) => i.remove());
    // the rest of the side column (the share ticket lives in חברים now)
    const nudge = document.getElementById('nudge-slot');
    if (nudge) main.appendChild(nudge);
    wirePanels(rail);
    refreshSums();

    // the days: a chevron on each header, and the stops fold under it
    let foldBar = document.getElementById('tt-foldbar');
    if (!foldBar) {
      foldBar = document.createElement('div');
      foldBar.id = 'tt-foldbar';
      foldBar.className = 'tt-foldbar';
      foldBar.innerHTML = '<button type="button" class="tt-foldall"></button>';
      days.parentNode.insertBefore(foldBar, days);
      // the list / calendar switch rides the same row, small, instead of a bar of its own
      const vt = document.getElementById('view-toggle');
      if (vt) foldBar.prepend(vt);
      foldBar.querySelector('button').onclick = () => {
        const all = [...days.querySelectorAll('.day-block')];
        const anyOpen = all.some((b) => !b.classList.contains('tt-folded'));
        all.forEach((b) => setDayFolded(b, anyOpen));
        syncFoldAll();
      };
    }
    decorateDays();
    new MutationObserver(() => { decorateDays(); refreshSums(); }).observe(days, { childList: true });
  }

  // { day: true|false } per trip. A day nobody folded or opened follows the classic
  // page's rule for a long list — the first two days open, the rest folded — so the
  // page still ends near the top, but every day keeps its header and its one line.
  const foldKey = () => `tm_tt_days_${ctx.state.trip.share_code}`;
  function foldMem() { try { const m = JSON.parse(localStorage.getItem(foldKey()) || '{}'); return m && !Array.isArray(m) ? m : {}; } catch { return {}; } }
  const isFolded = (mem, day, total) => (day in mem ? !!mem[day] : total > 2 && day > 2);
  function setDayFolded(block, on) {
    block.classList.toggle('tt-folded', on);
    block.querySelector('.tt-dayfold')?.setAttribute('aria-expanded', !on);
    const mem = foldMem();
    mem[+block.dataset.day] = !!on;
    try { localStorage.setItem(foldKey(), JSON.stringify(mem)); } catch { /* this visit only */ }
  }
  function syncFoldAll() {
    const btn = document.querySelector('#tt-foldbar .tt-foldall');
    const days = document.getElementById('days-container');
    if (!btn || !days) return;
    const blocks = [...days.querySelectorAll('.day-block')];
    btn.hidden = !blocks.length; // the calendar has no days to fold
    btn.textContent = blocks.some((b) => !b.classList.contains('tt-folded')) ? 'כיווץ כל הימים' : 'פתיחת כל הימים';
  }
  function decorateDays() {
    const days = document.getElementById('days-container');
    const mem = foldMem();
    // the classic page's 3-day teaser (fade + "לכל המסלול") gives way to the folds
    days.querySelectorAll('.day-folded, .day-fade').forEach((el) => el.classList.remove('day-folded', 'day-fade'));
    days.querySelector(':scope > .show-rest-btn')?.remove();
    const total = days.querySelectorAll('.day-block[data-day]').length;
    days.querySelectorAll('.day-block[data-day]').forEach((block) => {
      const title = block.querySelector('.day-title');
      if (!title || title.querySelector('.tt-dayfold')) return;
      const day = +block.dataset.day;
      const stops = ctx.state.items.filter((it) => it.day_number === day);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tt-dayfold';
      btn.setAttribute('aria-label', `קיפול יום ${day}`);
      btn.innerHTML = IC.chev;
      title.appendChild(btn);
      // a short date and a short route label keep the bar on one line on a phone
      const dd = title.querySelector('.day-date');
      const date = dayDate(day);
      if (dd && date) dd.textContent = date.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short' });
      const route = title.querySelector('.day-route');
      if (route) route.innerHTML = `${TRIPMAKER.routeIcon}<span>ניווט</span>`;
      // the whole bar folds the day — its links and buttons keep their own taps
      title.addEventListener('click', (e) => {
        if (e.target.closest('a, button, .day-cost')) return;
        setDayFolded(block, !block.classList.contains('tt-folded')); syncFoldAll();
      });
      const sum = document.createElement('div');
      sum.className = 'tt-daysum';
      sum.textContent = stops.length
        ? `${stops.length} ${stops.length === 1 ? 'תחנה' : 'תחנות'} · ${stops.slice(0, 3).map((s) => s.title.split(/[—–-]/)[0].trim()).join(' · ')}${stops.length > 3 ? '…' : ''}`
        : 'יום פנוי';
      title.appendChild(sum); // inside the bar: a folded day is one card
      btn.onclick = (e) => { e.stopPropagation(); setDayFolded(block, !block.classList.contains('tt-folded')); syncFoldAll(); };
      const f = isFolded(mem, day, total);
      block.classList.toggle('tt-folded', f);
      btn.setAttribute('aria-expanded', !f);
    });
    syncFoldAll();
  }

  function refreshSums() {
    const set = (id, txt) => { const el = document.querySelector(`.tt-panel[data-panel="${id}"] .tt-sum`); if (el && txt != null) el.textContent = txt; };
    if (typeof TripChecklist !== 'undefined') set('checklist', TripChecklist.moreDesc());
    const wx = document.getElementById('weather-row');
    if (wx) {
      const first = [...wx.children].slice(0, 4).map((d) => d.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      set('weather', document.getElementById('weather-sub')?.textContent?.trim() || (first.length ? first.join(' · ') : 'התחזית לימי הטיול'));
    }
    const pins = ctx.state.items.filter((it) => it.lat != null).length || ctx.state.items.length;
    set('map', pins ? `${pins === 1 ? 'תחנה אחת' : `${pins} תחנות`} על המפה · יום אחרי יום` : 'התחנות יופיעו כאן כשיתווספו למסלול');
  }

  // ---------- the gear ----------
  function openSettings() {
    const rows = [
      { id: 'publish-toggle', ic: IC.globe, t: 'פרסום בגלריית הטיולים', d: () => (document.getElementById('publish-toggle')?.checked ? 'פורסם — מופיע בעמוד הבית' : 'לא מפורסם'), when: () => document.getElementById('publish-row')?.style.display !== 'none' },
      { id: 'wa-share', t: 'שיתוף בוואטסאפ', d: 'שולחים את המסלול לחברים' },
      { id: 'copy-link', ic: IC.share, t: 'העתקת קישור', d: 'קישור למסלול, להדבקה בכל מקום' },
      { id: 'checklist-btn', ic: IC.check, t: 'צ\'קליסט מלא', d: () => (typeof TripChecklist !== 'undefined' ? TripChecklist.moreDesc() : '') },
      { id: 'print-btn', t: 'PDF / הדפסה', d: 'המסלול המלא כמסמך' },
      { id: 'ics-btn', t: 'ייצוא ליומן', d: 'קובץ ICS — גוגל, אאוטלוק או אפל' },
      { id: 'clone-btn', t: 'שכפול הטיול', d: 'עותק אישי שאפשר לערוך בחופשיות' },
    ].filter((r) => (r.when ? r.when() : shown(r.id)));
    const row = (r) => {
      const svg = r.ic || document.getElementById(r.id)?.querySelector('svg')?.outerHTML || '';
      const d = typeof r.d === 'function' ? r.d() : r.d;
      return `<button type="button" class="more-row" data-for="${r.id}"><span class="mr-ic">${svg}</span>
        <span class="mr-text"><b>${esc(r.t)}</b><small>${esc(d || '')}</small></span><span class="mr-chev" aria-hidden="true">‹</span></button>`;
    };
    TripPages.sheet('tt-settings', {
      title: 'שיתוף והגדרות',
      html: `<div class="more-list">${rows.map(row).join('')}</div>`,
      onOpen: (body) => {
        body.querySelectorAll('.more-row[data-for]').forEach((r) => {
          r.onclick = () => TripPages.closeSheet(() => click(r.dataset.for));
        });
      },
    });
  }

  // ---------- turning it on ----------
  function tabButton(id, page, ic, label) {
    let b = document.getElementById(id);
    if (b) return b;
    b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'action-btn tab-btn tt-tab';
    b.dataset.page = page;
    b.innerHTML = `<span class="ab-ic">${ic}</span><span class="ab-label">${label}</span>`;
    b.onclick = () => TripPages.open(page);
    return b;
  }

  // the dock — again whenever the page swaps trips: a visitor who copies the trip they
  // were reading becomes its owner, and the owner's tabs arrive with it
  function buildDock() {
    const row = document.getElementById('action-row');
    const it = document.getElementById('itinerary-btn');
    const recs = document.getElementById('recs-btn');
    const hotels = document.getElementById('hotels-btn');
    const privileged = ctx.privileged;
    // the dock: מסלול · חברים · מלונות · תחבורה · ✨ — in that order, right to left
    const order = [it];
    if (privileged) {
      TripPages.register('friends', {
        title: '👥 חברים',
        sub: 'מי נוסע, ומי חייב למי',
        render: renderFriends,
      });
      TripPages.register('transport', {
        title: '✈️ תחבורה',
        sub: 'כל הטיסות, הרכבות והנסיעות בטיול — עם הכרטיסים והתזכורות',
        render: renderTransport,
      });
      order.push(tabButton('tt-friends-btn', 'friends', IC.friends, 'חברים'));
      if (hotels && hotels.style.display !== 'none') {
        hotels.classList.add('tab-btn');
        hotels.dataset.page = 'hotels';
        order.push(hotels);
      }
      order.push(tabButton('tt-transport-btn', 'transport', IC.transport, 'תחבורה'));
    }
    order.push(recs);
    // a visitor's dock is the itinerary and the AI — and copying the trip, the one thing
    // a gallery visitor came to do, rides there too instead of behind the gear
    const clone = document.getElementById('clone-btn');
    if (!privileged && clone && clone.style.display !== 'none') { clone.classList.add('tt-tab', 'tt-act'); order.push(clone); }
    for (const b of order.reverse()) if (b) row.prepend(b);
  }

  function turnOn() {
    document.body.classList.add('tt-on');
    buildDock();

    // the gear, in the hero's corner
    const hero = document.querySelector('.trip-hero-inner');
    if (hero && !document.getElementById('tt-gear')) {
      const g = document.createElement('button');
      g.type = 'button';
      g.id = 'tt-gear';
      g.className = 'tt-gear';
      g.setAttribute('aria-label', 'שיתוף והגדרות');
      g.title = 'שיתוף והגדרות';
      g.innerHTML = IC.gear;
      g.onclick = openSettings;
      hero.appendChild(g);
    }
    panelizeItinerary();
    // a reload on #friends / #transport lands back on it
    if (['#friends', '#transport'].includes(location.hash)) TripPages.openFromHash();
  }

  // trip.js calls this once the dock is wired (and again when the page swaps trips)
  function init(c) {
    ctx = c;
    if (!active) { active = true; turnOn(); } else { buildDock(); refreshSums(); }
  }

  return { init, on: () => active };
})();
