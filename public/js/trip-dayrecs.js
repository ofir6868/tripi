// המלצות ליום פנוי — what a free day shows in the itinerary instead of "יום פנוי".
//
// Three picks per free day, drawn as wide, short rows (photo · name · line · הוספה),
// not the tall tiles of the recommendations chat: the itinerary is a column, and a
// free day should read as three lines you can drop in, not as a second chat. The
// picks come from the server (routes/day-recs.js), which keeps one set per free day
// for the whole trip; this side draws them, asks for the ones that are missing, asks
// again for every free day when an AI chat changes the trip (replaceItems →
// reloadAll), and swaps one day's picks for others on the "המלצות אחרות" button.
// While anything is on its way the day shows a skeleton and says what it is waiting
// for. Only editors see any of this — a viewer's free day just says "יום פנוי".
const TripDayRecs = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const CAT_EMOJI = {
    'אטרקציה': '🎡', 'אוכל': '🍜', 'טבע': '🌿', 'ים': '🏖️', 'תרבות': '🎭',
    'קניות': '🛍️', 'לינה': '🏨', 'נוף': '🌄', 'חיי לילה': '🌙',
  };
  const ICON = {
    refresh: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    map: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  };
  const POLL_MS = 5000;
  const POLL_MAX = 30; // two and a half minutes of watching another tab's generation

  let ctx = null;
  let byDay = {}; // day → {status, cards} as the server last told us
  let loaded = false; // the first read answered
  let loadingAll = false; // a whole-trip pass is on its way — every free day waits
  let gen = 0; // whole-trip passes, so a superseded one drops its answer
  const loadingDays = new Set(); // "other picks" in flight, per day
  const requested = new Set(); // days this page already asked 'missing' for
  const sticky = new Set(); // days that took a pick from here: the rows stay until a reload
  let sig = ''; // the itinerary as of the last whole-trip pass
  let pollTimer = null;
  let polls = 0;

  const base = () => `/api/trips/code/${ctx.trip.share_code}/day-recs`;
  const dayItems = (d) => ctx.state.items.filter((it) => it.day_number === d);
  const signature = (items) => items.map((it) => `${it.id}:${it.day_number}:${it.title}`).sort().join('|');
  function freeDaysOf(items, days) {
    const has = new Set(items.map((it) => it.day_number));
    const out = [];
    for (let d = 1; d <= days; d++) if (!has.has(d)) out.push(d);
    return out;
  }
  const freeDays = () => freeDaysOf(ctx.state.items, ctx.trip.days);

  // =================================================================
  //  STATE
  // =================================================================

  function init(c) {
    ctx = c;
    sig = signature(ctx.state.items);
    document.addEventListener('click', onClick);
    if (ctx.canEdit) load();
  }

  async function load() {
    try {
      const r = await TRIPMAKER.api(base());
      byDay = r.days || {};
    } catch { byDay = {}; }
    loaded = true;
    repaint();
    ensure();
    watchPending();
  }

  // free days with nothing on the server get their picks now — once per day per page,
  // so a pass that fails leaves a retry button, not a loop
  async function ensure() {
    if (!ctx || !ctx.canEdit || !loaded || loadingAll) return;
    const days = freeDays().filter((d) => !byDay[d] && !requested.has(d));
    if (!days.length) return;
    days.forEach((d) => { requested.add(d); loadingDays.add(d); });
    repaint();
    try {
      const r = await TRIPMAKER.api(`${base()}/refresh`, { method: 'POST', body: JSON.stringify({ scope: 'missing' }) });
      if (r.days) byDay = r.days;
    } catch (err) {
      days.forEach((d) => { byDay[d] = { status: 'failed', cards: [], message: failText(err) }; });
    }
    days.forEach((d) => loadingDays.delete(d));
    repaint();
    watchPending();
  }

  // an AI chat changed the trip: every free day's picks are made again. A turn that
  // changed nothing (a rejected proposal) is skipped — the itinerary is the same.
  async function reloadAll() {
    if (!ctx || !ctx.canEdit) return;
    const s = signature(ctx.state.items);
    if (s === sig) return;
    sig = s;
    sticky.clear();
    const free = freeDays();
    if (!free.length) { byDay = {}; repaint(); return; }
    const mine = ++gen;
    loadingAll = true;
    repaint();
    try {
      const r = await TRIPMAKER.api(`${base()}/refresh`, { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
      if (mine !== gen) return;
      byDay = r.days || {};
    } catch (err) {
      if (mine !== gen) return;
      byDay = {};
      free.forEach((d) => { byDay[d] = { status: 'failed', cards: [], message: failText(err) }; });
    }
    loadingAll = false;
    free.forEach((d) => requested.add(d));
    repaint();
    watchPending();
  }

  async function refreshDay(day) {
    if (!ctx || loadingDays.has(day) || loadingAll) return;
    loadingDays.add(day);
    repaint([day]);
    try {
      const r = await TRIPMAKER.api(`${base()}/refresh`, { method: 'POST', body: JSON.stringify({ day }) });
      byDay[day] = (r.days || {})[day] || { status: 'failed', cards: [] };
      TRIPMAKER.track?.('dayrecs_refresh', { code: ctx.trip.share_code, day });
    } catch (err) {
      // the old picks stay — a failed swap is not a reason to show nothing
      TripPages.toast(err && err.quota ? 'ניצלתם את רענוני ההמלצות להיום — מחר יש מכסה חדשה' : failText(err));
    }
    loadingDays.delete(day);
    repaint([day]);
  }

  // another tab (or the post-build pass) is still generating: read again until it lands
  function watchPending() {
    clearTimeout(pollTimer);
    const pending = freeDays().some((d) => byDay[d] && byDay[d].status === 'pending');
    if (!pending || polls >= POLL_MAX) { polls = 0; return; }
    pollTimer = setTimeout(async () => {
      polls++;
      try {
        const r = await TRIPMAKER.api(base());
        if (!loadingAll) { byDay = r.days || byDay; repaint(); }
      } catch { /* the next tick tries again */ }
      watchPending();
    }, POLL_MS);
  }

  const failText = (err) => (err && err.message) || 'לא הצלחתי להביא המלצות — נסו שוב';

  // the day's picks are made behind the build's loading screen (trip-plan.js) —
  // before the itinerary is ever shown, so it opens with them in place
  const hasFreeDays = (items, days) => freeDaysOf(items || [], days).length > 0;
  function prepare(trip) {
    return TRIPMAKER.api(`/api/trips/code/${trip.share_code}/day-recs/refresh`, {
      method: 'POST', body: JSON.stringify({ scope: 'all' }),
    });
  }

  // =================================================================
  //  RENDER — called from both itinerary views; '' when the day needs no block
  // =================================================================

  function blockHtml(day) {
    if (!ctx || !ctx.canEdit) return '';
    const hasStops = dayItems(day).length > 0;
    if (hasStops && !sticky.has(day)) return '';
    const r = byDay[day];
    const area = ctx.defaultArea(day);
    const waiting = !loaded ? 'טוענים המלצות…'
      : loadingAll ? `המסלול השתנה — ה-AI מכין המלצות חדשות ליום ${day}…`
        : loadingDays.has(day) ? (r && r.status === 'ready' && r.cards.length ? 'מחליפים להמלצות אחרות…' : `ה-AI מכין המלצות ליום ${day}…`)
          : (!r || r.status === 'pending') ? `ה-AI מכין המלצות ליום ${day}…` : null;
    const busy = !!waiting;
    let body;
    if (waiting) {
      body = `
        <div class="dr-wait" role="status" aria-live="polite">✨ ${esc(waiting)}</div>
        ${Array.from({ length: 3 }, () => `
        <div class="dr-card dr-skel" aria-hidden="true">
          <div class="dr-media"></div>
          <div class="dr-body"><span class="skl" style="width:38%"></span><span class="skl" style="width:88%"></span><span class="skl" style="width:26%"></span></div>
        </div>`).join('')}`;
    } else if (r.status !== 'ready' || !r.cards.length) {
      body = `
        <div class="dr-empty">
          <span>${esc(r.status === 'ready' ? 'לא מצאתי מקומות שאני בטוח בהם ליום הזה' : (r.message || 'לא הצלחתי להביא המלצות ליום הזה'))}</span>
          <button type="button" class="dr-retry" data-day="${day}">לנסות שוב</button>
        </div>`;
    } else {
      body = r.cards.map((c, j) => cardHtml(c, day, j)).join('');
    }
    return `
      <div class="dr-block" data-day="${day}">
        <div class="dr-head">
          <span class="dr-title">✨ המלצות ליום ${day}${area ? ` · ${esc(area)}` : ''}</span>
          <button type="button" class="dr-refresh" data-day="${day}" ${busy ? 'disabled' : ''}
            title="להחליף להמלצות אחרות ליום הזה">${ICON.refresh}<span>המלצות אחרות</span></button>
        </div>
        <div class="dr-list">${body}</div>
      </div>`;
  }

  function cardHtml(raw, day, j) {
    const c = TripRecs.fromServerCard(raw, ctx);
    const em = CAT_EMOJI[c.cat] || '📍';
    return `
      <article class="dr-card" data-day="${day}" data-j="${j}">
        <div class="dr-media" data-emoji="${em}">
          <img src="${esc(c.photos[0])}" alt="" loading="lazy" onerror="this.style.opacity=0">
        </div>
        <div class="dr-body">
          <div class="dr-top">
            ${c.time ? `<span class="dr-time">${esc(c.time)}</span>` : ''}
            <h4 class="dr-name">${esc(c.title)}</h4>
            <span class="dr-cat">${em} ${esc(c.cat)}</span>
          </div>
          <p class="dr-blurb">${esc(c.blurb)}</p>
          <div class="dr-meta"><span>⏱ ${esc(c.dur)}</span><span>💸 ${esc(c.cost)}</span></div>
        </div>
        <div class="dr-actions">
          ${raw.added
            ? `<span class="dr-added">✓ נוסף</span>`
            : `<button type="button" class="dr-add" data-day="${day}" data-j="${j}">${ICON.plus} הוספה</button>`}
          <a class="dr-map" href="${TRIPMAKER.mapsSearchUrl(c.place_query || `${c.title} ${c.area}`, c.google_place_id)}"
            target="_blank" rel="noopener" title="נפתח בגוגל מפות, בחלון חדש">${ICON.map} מפה</a>
        </div>
      </article>`;
  }

  // redraw the blocks already on screen in place (both views), no full repaint — a
  // block that isn't there yet appears with the next itinerary render anyway
  function repaint(days = null) {
    document.querySelectorAll('.dr-block[data-day]').forEach((el) => {
      const d = +el.dataset.day;
      if (days && !days.includes(d)) return;
      const html = blockHtml(d);
      if (!html) { el.remove(); return; }
      el.outerHTML = html;
    });
  }

  // =================================================================
  //  TAPS — one delegated handler for every block on the page
  // =================================================================

  function onClick(e) {
    const refresh = e.target.closest('.dr-refresh, .dr-retry');
    if (refresh) { refreshDay(+refresh.dataset.day); return; }
    const add = e.target.closest('.dr-add');
    if (add) { addPick(+add.dataset.day, +add.dataset.j, add); }
  }

  // straight into that day — the day is known, so there's no "מתי?" to ask
  async function addPick(day, j, btn) {
    const raw = ((byDay[day] || {}).cards || [])[j];
    if (!raw || raw.added || btn.disabled) return;
    btn.disabled = true;
    const c = TripRecs.fromServerCard(raw, ctx);
    try {
      // the rows stay after the day stops being free, so the other two are still there
      sticky.add(day);
      await ctx.addItem({
        day_number: day, title: c.title, category: c.cat, area: c.area, note: c.blurb,
        time_label: c.time || null, place_query: c.place_query || `${c.title}, ${c.area}`,
        lat: c.lat, lon: c.lon, google_place_id: c.google_place_id,
      });
      raw.added = true;
      repaint([day]);
      TripPages.toast(`נוסף ליום ${day} ✓`, 'ok');
      TRIPMAKER.track?.('dayrecs_add', { code: ctx.trip.share_code, day });
    } catch (err) {
      btn.disabled = false;
      TripPages.toast((err && err.message) || 'ההוספה נכשלה — נסו שוב');
    }
  }

  return { init, blockHtml, reloadAll, refreshDay, prepare, hasFreeDays };
})();
