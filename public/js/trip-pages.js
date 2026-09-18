// Trip pages + the bottom dock.
//
// On a phone the dock is a tab bar: מסלול / המלצות / מסמכים / תקציב, the draft "שמירה"
// pill while there is one, and "עוד" for everything else. Every tab but the itinerary
// opens a full-screen page over the trip; the dock stays on top of the page, so moving
// between pages is one tap and "מסלול" brings the itinerary back. Each open page is one
// history entry — the phone's back gesture closes it, exactly like the budget page.
// On desktop the same buttons sit in the sticky toolbar and the pages open full-screen
// with their own back button.
const TripPages = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const pages = {}; // name → { title, sub, render(slots), onClose(), el }
  let current = null;

  const ICON = {
    back: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  };

  // A page can be registered again with a fresh definition: the trip page can swap
  // itself over to another trip without a navigation (a gallery visitor copying the
  // trip they are reading), and every page's context goes with it. The element stays —
  // dropping it would blank the screen under whoever is standing on that page — and
  // `dirty` tells the next show() to paint it from the new definition rather than
  // trust what the old one left behind.
  function register(name, def) {
    const prev = pages[name];
    pages[name] = { ...def, el: prev ? prev.el : null, dirty: !!(prev && prev.el) };
    if (prev && prev.el) {
      prev.el.querySelector('.tp-title').innerHTML = def.title;
      const sub = prev.el.querySelector('.tp-sub');
      if (sub) sub.innerHTML = def.sub || '';
    }
  }

  function ensure(name) {
    const p = pages[name];
    if (p.el) return p.el;
    const el = document.createElement('section');
    el.id = `page-${name}`;
    el.className = `trip-page page-${name}`;
    el.hidden = true;
    el.setAttribute('aria-label', p.title.replace(/<[^>]+>/g, ''));
    el.innerHTML = `
      <div class="tp-head">
        <button type="button" class="bp-back tp-back" aria-label="חזרה למסלול">${ICON.back}<span>חזרה</span></button>
        <div class="tp-titles">
          <h2 class="tp-title">${p.title}</h2>
          ${p.sub ? `<p class="tp-sub">${p.sub}</p>` : ''}
        </div>
        <div class="tp-tools"></div>
      </div>
      <div class="tp-body"></div>
      <div class="tp-foot"></div>`;
    document.body.appendChild(el);
    el.querySelector('.tp-back').onclick = () => close();
    p.el = el;
    return el;
  }

  function setActive(name) {
    document.querySelectorAll('.action-bar .tab-btn[data-page]').forEach((b) => {
      const on = (b.dataset.page || '') === (name || '');
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  // paint a page (no history) — open() and popstate both land here
  function show(name) {
    if (!pages[name]) return;
    for (const n in pages) if (pages[n].el && n !== name) pages[n].el.hidden = true;
    const el = ensure(name);
    const fresh = current !== name || pages[name].dirty;
    if (current && current !== name) pages[current].onClose?.();
    el.hidden = false;
    current = name;
    document.body.classList.add('page-open');
    setActive(name);
    if (fresh) {
      pages[name].dirty = false;
      pages[name].render({
        page: el,
        body: el.querySelector('.tp-body'),
        foot: el.querySelector('.tp-foot'),
        tools: el.querySelector('.tp-tools'),
      });
    }
  }

  function hide() {
    if (!current) return;
    pages[current].el.hidden = true;
    pages[current].onClose?.();
    current = null;
    document.body.classList.remove('page-open');
    setActive(null);
    // the chat that veiled the dock is gone: whether it settled the basics or the
    // traveller just left, the dock is on screen from here on
    if (!dockShown) revealDock();
    else if (sparkOwed) { sparkOwed = false; sparkle(dockEl()); }
  }

  // the budget page (trip-modals.js) is a sibling of ours with its own hash and
  // listener; it takes over the screen the same way a tab does, and leaves it the same way
  const budgetOpen = () => document.body.classList.contains('budget-open');

  function open(name) {
    if (!pages[name] || current === name) return;
    const state = { tripmakerPage: name };
    if (current || budgetOpen()) {
      // tab to tab swaps the entry rather than stacking one — back returns to the itinerary
      if (budgetOpen() && typeof TripModals !== 'undefined') TripModals.closeBudget();
      history.replaceState(state, '', `#${name}`);
    } else {
      // a reload that kept the hash is normalized first: one clean entry per open
      if (location.hash === `#${name}`) history.replaceState(null, '', location.pathname + location.search);
      history.pushState(state, '', `#${name}`);
    }
    show(name);
  }

  function close() {
    if (!current) return;
    if (history.state && history.state.tripmakerPage === current) history.back();
    else hide();
  }

  window.addEventListener('popstate', () => {
    const name = location.hash.slice(1);
    if (pages[name]) { show(name); return; }
    // the budget page stacks on top of ours with its own hash and its own listener —
    // a page underneath stays put until the hash comes back to us or goes away entirely
    if (/^#budget/.test(location.hash)) return;
    hide();
  });

  // a /trip/CODE#recs link (or a reload mid-page) lands straight on that page
  function openFromHash() {
    const name = location.hash.slice(1);
    if (pages[name]) open(name);
  }

  // ---- dock ----

  function initDock({ onItinerary } = {}) {
    document.querySelectorAll('.action-bar .tab-btn[data-page]').forEach((b) => {
      b.onclick = () => {
        const name = b.dataset.page;
        if (!name) {
          if (current) close();
          else if (budgetOpen()) history.back(); // the budget holds the top history entry
          else onItinerary?.();
          return;
        }
        open(name);
      };
    });
    document.getElementById('more-btn')?.addEventListener('click', openMore);
  }

  // ---- the dock's arrival ----
  //
  // A trip created with the AI opens on the planning chat (the wizard sends it straight
  // to #plan) with the dock veiled: at that moment the itinerary is empty and there is
  // nothing to recommend, so a tab bar is five ways out of a conversation that hasn't
  // started. The dock arrives when the chat settles the basics — a spark runs the bar's
  // length, left to right, and leaves the tabs behind it — and once it has arrived it
  // never hides again, on any page.
  //
  // The spark is only worth playing where it can be seen: on a phone the dock floats
  // OVER an open page, on desktop the page covers the toolbar entirely. So a reveal that
  // lands behind a page keeps the spark owed, and spends it when the page closes.

  let dockShown = true;
  let sparkOwed = false;
  const dockEl = () => document.getElementById('action-bar');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function veilDock() {
    const el = dockEl();
    if (!el || !dockShown) return;
    dockShown = false;
    el.classList.add('dock-veiled');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.add('dock-veiled');
  }

  function sparkle(el) {
    if (!el) return;
    const s = document.createElement('span');
    s.className = 'dock-spark';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<i class="ds-core"></i><i class="ds-tw"></i><i class="ds-tw"></i><i class="ds-tw"></i>';
    // the run is the bar's own width, handed to a transform — the spark crosses the
    // dock without the dock (or the page under it) being laid out again
    s.style.setProperty('--run', el.offsetWidth + 'px');
    el.classList.add('dock-arriving');
    el.appendChild(s);
    setTimeout(() => { el.classList.remove('dock-arriving'); s.remove(); }, 1400);
  }

  function revealDock({ spark = false } = {}) {
    const el = dockEl();
    if (!el || dockShown) return;
    dockShown = true;
    el.classList.remove('dock-veiled');
    el.removeAttribute('aria-hidden');
    document.body.classList.remove('dock-veiled');
    if (!spark || reduced()) return;
    // phones only: elsewhere the open page is on top of the dock, so the spark waits
    if (current && !matchMedia('(max-width: 640px)').matches) { sparkOwed = true; return; }
    sparkle(el);
  }

  // a small count on a tab's icon (documents saved, …); 0 removes it
  function badge(name, n) {
    const btn = document.getElementById(`${name}-btn`);
    if (!btn) return;
    let b = btn.querySelector('.ab-badge');
    if (!n) { b?.remove(); return; }
    if (!b) {
      b = document.createElement('span');
      b.className = 'ab-badge';
      btn.querySelector('.ab-ic').appendChild(b);
    }
    b.textContent = n > 99 ? '99+' : String(n);
  }

  // ---- toast ----

  let toastTimer = null;
  function toast(msg, kind) {
    let el = document.getElementById('tm-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tm-toast';
      el.className = 'tm-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('ok', kind === 'ok');
    el.classList.add('in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('in'), 2600);
  }

  // ---- sheets: a bottom sheet on phones, a centered card on desktop ----
  //
  // One at a time, one history entry each, so back closes the sheet and never the
  // page underneath it. The page's own state rides along in the entry.

  let openSheet = null;

  function sheet(id, { title, sub, html, onOpen, cls } = {}) {
    let wrap = document.getElementById(id);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = id;
      wrap.className = 'tp-sheet';
      wrap.innerHTML = `
        <div class="tp-sheet-card glass" role="dialog" aria-modal="true">
          <div class="tp-sheet-grip" aria-hidden="true"></div>
          <button type="button" class="tp-sheet-close" aria-label="סגירה">✕</button>
          <div class="tp-sheet-head"><h3 class="tp-sheet-title"></h3><p class="tp-sheet-sub"></p></div>
          <div class="tp-sheet-body"></div>
        </div>`;
      document.body.appendChild(wrap);
      wrap.querySelector('.tp-sheet-close').onclick = () => closeSheet();
      wrap.addEventListener('click', (e) => { if (e.target === wrap) closeSheet(); });
    }
    const card = wrap.querySelector('.tp-sheet-card');
    card.className = `tp-sheet-card glass${cls ? ' ' + cls : ''}`;
    wrap.querySelector('.tp-sheet-title').innerHTML = title || '';
    const subEl = wrap.querySelector('.tp-sheet-sub');
    subEl.innerHTML = sub || '';
    subEl.hidden = !sub;
    const body = wrap.querySelector('.tp-sheet-body');
    body.innerHTML = html || '';
    if (openSheet && openSheet !== wrap) openSheet.classList.remove('open');
    if (!wrap.classList.contains('open')) {
      wrap.classList.add('open');
      const state = { ...(history.state || {}), tripmakerSheet: id };
      if (openSheet) history.replaceState(state, '', location.href);
      else history.pushState(state, '', location.href);
    }
    openSheet = wrap;
    card.scrollTop = 0;
    onOpen?.(body, wrap);
    return wrap;
  }

  function hideSheet() {
    if (!openSheet) return;
    openSheet.classList.remove('open');
    openSheet = null;
  }

  // `then` runs once the sheet is really gone — after the history entry it holds has
  // been popped, so whatever `then` opens next can push its own entry safely
  function closeSheet(then) {
    const w = openSheet;
    if (!w) { then?.(); return; }
    if (history.state && history.state.tripmakerSheet === w.id) {
      if (then) window.addEventListener('popstate', () => setTimeout(then, 0), { once: true });
      history.back();
    } else {
      hideSheet();
      then?.();
    }
  }

  window.addEventListener('popstate', () => {
    if (openSheet && !(history.state && history.state.tripmakerSheet === openSheet.id)) hideSheet();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSheet) closeSheet();
  });

  // ---- "עוד": the secondary actions, one tap away on a phone ----
  //
  // The rows mirror the toolbar buttons that are hidden on phones — each row clicks
  // its button, so every action keeps the exact wiring (and visibility rules) trip.js
  // gives it. A row only shows while its button is offered *and* the dock isn't already
  // showing it: the budget tab, say, sits in the dock until the draft's save pill needs
  // the room, and then it lives here instead.

  const MORE_ACTIONS = [
    { id: 'budget-btn', title: 'תקציב', cls: (el) => (el.classList.contains('over') ? 'over' : el.classList.contains('warn') ? 'warn' : ''),
      desc: () => { const l = document.getElementById('budget-label')?.textContent; return l && l !== 'תקציב' ? `${l} מהתקציב כבר מתוכנן` : 'כמה זה עולה — התקרה, ההוצאות והחלוקה'; } },
    { id: 'hotels-btn', title: 'מלונות', desc: 'איפה ישנים — לילות, הזמנות ומחירים' },
    { id: 'participants-btn', title: () => document.getElementById('participants-label')?.textContent || 'משתתפים', desc: 'מי מתכנן איתכם, וקישור ההזמנה' },
    { id: 'settle-btn', title: 'חלוקת הוצאות',
      desc: 'מי חייב למי — לפי התקציב המשותף בלבד' },
    { id: 'wa-share', title: 'שיתוף בוואטסאפ', desc: 'שולחים את המסלול לחברים' },
    { id: 'copy-link', title: 'העתקת קישור', desc: 'קישור למסלול, להדבקה בכל מקום' },
    { id: 'ics-btn', title: 'ייצוא ליומן', desc: 'קובץ ICS — גוגל קלנדר, אאוטלוק או יומן אפל' },
    { id: 'print-btn', title: 'PDF / הדפסה', desc: 'המסלול המלא כמסמך' },
    { id: 'clone-btn', title: 'שכפול הטיול', desc: 'עותק אישי שאפשר לערוך בחופשיות' },
  ];

  function isOffered(el) {
    if (!el || el.style.display === 'none') return false;
    return !el.closest('[style*="display: none"], [style*="display:none"], [hidden]');
  }
  // offered, but folded away by the dock's CSS rather than shown as a tab
  function isFolded(el) {
    return isOffered(el) && getComputedStyle(el).display === 'none';
  }

  function openMore() {
    const rows = MORE_ACTIONS.filter((a) => isFolded(document.getElementById(a.id)));
    const html = `<div class="more-list">${rows.map((a) => {
      const src = document.getElementById(a.id);
      const svg = src.querySelector('svg')?.cloneNode(true);
      if (svg) svg.setAttribute('class', 'ic');
      const t = typeof a.title === 'function' ? a.title() : a.title;
      const d = typeof a.desc === 'function' ? a.desc() : a.desc;
      const extra = [src.classList.contains('liked') ? 'liked' : '', a.cls ? a.cls(src) : ''].filter(Boolean).map((c) => ' ' + c).join('');
      return `
        <button type="button" class="more-row${extra}" data-for="${a.id}">
          <span class="mr-ic">${svg ? svg.outerHTML : ''}</span>
          <span class="mr-text"><b>${esc(t)}</b><small>${esc(d)}</small></span>
          <span class="mr-chev" aria-hidden="true">‹</span>
        </button>`;
    }).join('')}</div>`;
    sheet('more-sheet', {
      title: 'עוד פעולות',
      html,
      onOpen: (body) => {
        body.querySelectorAll('.more-row').forEach((r) => {
          r.onclick = () => closeSheet(() => document.getElementById(r.dataset.for)?.click());
        });
      },
    });
  }

  // hide the open page without touching history — for a sibling page taking its place
  const dismiss = () => hide();

  // a sibling page taking the open one's place AND its history entry — saving a draft
  // turns the planning chat into the recommendations chat under the same tab, and
  // back should still close the tab, not reopen the page that no longer applies
  function replace(name) {
    if (!pages[name]) return;
    history.replaceState({ tripmakerPage: name }, '', `#${name}`);
    show(name);
  }

  return {
    register, open, close, dismiss, replace, activate: setActive, current: () => current,
    openFromHash, initDock, badge, toast, sheet, closeSheet, veilDock, revealDock,
  };
})();
