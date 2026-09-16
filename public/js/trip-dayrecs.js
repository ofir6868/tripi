// המלצות ליום פנוי — what a free day shows in the itinerary instead of "יום פנוי".
//
// Three picks per free day, drawn as wide, short rows (photo · name · line · הוספה),
// not the tall tiles of the recommendations chat: the itinerary is a column, and a
// free day should read as three lines you can drop in, not as a second chat. The
// picks come from the server (routes/day-recs.js), which keeps one set per free day
// for the whole trip.
//
// The server fills a long trip day by day — area by area, earliest day first — and
// writes each day the moment it is ready. So this side does not wait for one big
// answer any more: it starts reading the picks while the page is still loading
// (prefetch, from trip.js), asks the server to fill whatever is missing, and then
// watches the snapshot fill in, repainting only the days that actually changed. A
// 30-day trip fills from day 1 down, in front of the traveller, instead of showing
// thirty skeletons for two minutes and then giving up on them.
//
// Any change to the trip — a chat turn (replaceItems → reloadAll) or a stop moved by
// hand (renderItinerary → sync) — sends the picks back to the server, which keeps
// every day whose surroundings did not change and remakes the rest. "המלצות אחרות"
// swaps one day's picks for others, and answers when it is done: it is one call.
// Only editors see any of this — a viewer's free day just says "יום פנוי".
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
  // the picks land in batches — quick reads while the first ones are landing, easing
  // off as the wait gets long, so watching a month-long trip is tens of reads, not hundreds
  const POLL_FIRST_MS = 2500;
  const POLL_STEP_MS = 600;
  const POLL_MAX_MS = 12000;
  const WATCH_MS = 12 * 60 * 1000; // the wall: a 30-day pass is minutes of model calls, not hours
  const SYNC_MS = 1500; // a drag that moves three stops is one change, not three

  let ctx = null;
  let byDay = {}; // day → {status, cards} as the server last told us
  let loaded = false; // the first read answered
  let running = false; // the server says a whole-trip pass is under way
  let counts = { ready: 0, waiting: 0 }; // how much of the trip has landed, for the waiting line
  let asking = false; // a refresh is in flight from this page
  const loadingDays = new Set(); // "other picks" in flight, per day
  const sticky = new Set(); // days that took a pick from here: the rows stay until a reload
  let sig = ''; // the itinerary as of the last time the picks were sent back
  let pollTimer = null;
  let polls = 0;
  let watchUntil = 0;
  let syncTimer = null;
  let prefetched = null; // the first read, started while the page was still loading

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

  // the picks are read while the trip itself is still on its way — the loading screen
  // is two seconds of brand mark, and this fits inside it. By the time the itinerary
  // paints, a day that already has picks draws them instead of a skeleton.
  function prefetch(code) {
    prefetched = TRIPMAKER.api(`/api/trips/code/${encodeURIComponent(code)}/day-recs`).catch(() => null);
    return prefetched;
  }

  function init(c) {
    ctx = c;
    sig = signature(ctx.state.items);
    document.addEventListener('click', onClick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) watch(true); });
    if (ctx.canEdit) load();
    else prefetched = null;
  }

  async function load() {
    const r = await (prefetched || TRIPMAKER.api(base()).catch(() => null));
    prefetched = null;
    apply(r);
    loaded = true;
    repaint();
    ask();
  }

  // the snapshot → what is on screen. Returns the days whose block has to be redrawn,
  // so a poll on a 30-day trip repaints the two days that landed, not thirty blocks.
  const stamp = (e) => (e ? `${e.status}|${e.updated_at || ''}|${(e.cards || []).length}` : '');
  function apply(r) {
    if (!r || !r.days) return [];
    const next = { ...r.days };
    // a day that took a pick from here is no longer free, so the server stops keeping
    // it — but the other two rows stay on screen until a reload, and they need a row
    for (const d of sticky) if (!next[d] && byDay[d]) next[d] = byDay[d];
    const changed = [];
    for (const d of new Set([...Object.keys(byDay), ...Object.keys(next)])) {
      if (stamp(byDay[d]) !== stamp(next[d])) changed.push(+d);
    }
    byDay = next;
    running = !!r.running;
    counts = { ready: r.ready || 0, waiting: r.waiting || 0 };
    return changed;
  }

  // ask the server to fill what it has no answer for. It decides what that is — days
  // with nothing, days whose surroundings changed — and answers the moment the pass is
  // under way, not when it ends; watch() reads the result as it lands.
  async function ask({ force = false } = {}) {
    if (!ctx || !ctx.canEdit || !loaded || asking) return;
    const missing = freeDays().filter((d) => !byDay[d]);
    if (!force && !missing.length) { watch(true); return; }
    asking = true;
    if (missing.length) repaint(missing); // they are waiting from this moment, not from the answer
    try {
      // the answer is the snapshot the pass starts from: days it has not marked yet
      // are simply absent, and watch() keeps reading until they are all in
      repaint(apply(await TRIPMAKER.api(`${base()}/refresh`, { method: 'POST', body: JSON.stringify({ scope: 'auto' }) })));
    } catch (err) {
      // nothing came back: the days with no picks say so, and offer the retry button
      const hit = missing.filter((d) => !byDay[d]);
      hit.forEach((d) => { byDay[d] = { status: 'failed', cards: [], message: failText(err) }; });
      repaint(hit);
    }
    asking = false;
    watch(true);
  }

  // an AI chat changed the trip, or a stop was moved by hand: the picks are chosen
  // around the neighbouring days, so the server is told. It keeps the days whose
  // surroundings are unchanged and remakes the rest — on a long trip that is the
  // difference between a couple of model calls and thirty.
  function sync({ force = false } = {}) {
    if (!ctx || !ctx.canEdit || !loaded) return;
    const s = signature(ctx.state.items);
    if (!force && s === sig) return;
    sig = s;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => ask({ force: true }), SYNC_MS);
  }
  const reloadAll = () => { sticky.clear(); sync({ force: true }); };

  async function refreshDay(day) {
    if (!ctx || loadingDays.has(day)) return;
    loadingDays.add(day);
    repaint([day]);
    try {
      const r = await TRIPMAKER.api(`${base()}/refresh`, { method: 'POST', body: JSON.stringify({ day }) });
      const fresh = (r.days || {})[day];
      byDay[day] = fresh || { status: 'failed', cards: [] };
      running = !!r.running;
      TRIPMAKER.track?.('dayrecs_refresh', { code: ctx.trip.share_code, day });
    } catch (err) {
      // the old picks stay — a failed swap is not a reason to show nothing
      TripPages.toast(err && err.quota ? 'ניצלתם את רענוני ההמלצות להיום — מחר יש מכסה חדשה' : failText(err));
    }
    loadingDays.delete(day);
    repaint([day]);
    watch(true);
  }

  // the picks land one batch at a time — this reads them as they do. It stops when
  // the server has nothing left in flight, and it stops watching a tab nobody is
  // looking at (the next look starts it again).
  function watch(restart = false) {
    clearTimeout(pollTimer);
    if (!ctx || !ctx.canEdit) return;
    if (restart) { polls = 0; watchUntil = Date.now() + WATCH_MS; }
    const pending = freeDays().some((d) => !byDay[d] || byDay[d].status === 'pending');
    if (!running && !pending) { polls = 0; return; }
    if (Date.now() > watchUntil) { giveUp(); return; }
    if (document.hidden) return; // visibilitychange picks it back up
    pollTimer = setTimeout(async () => {
      polls++;
      const r = await TRIPMAKER.api(base()).catch(() => null);
      if (r) repaint(apply(r));
      watch();
    }, Math.min(POLL_FIRST_MS + polls * POLL_STEP_MS, POLL_MAX_MS));
  }

  // the wall: whatever is still on its way after all this time is not coming. A day
  // that says so with a button beats a skeleton that spins forever.
  function giveUp() {
    const stuck = freeDays().filter((d) => !byDay[d] || byDay[d].status === 'pending');
    stuck.forEach((d) => { byDay[d] = { status: 'failed', cards: [], message: 'ההמלצות ליום הזה מתעכבות' }; });
    running = false;
    repaint(stuck);
  }

  const failText = (err) => (err && err.message) || 'לא הצלחתי להביא המלצות — נסו שוב';

  // the picks are started behind the build's loading screen (trip-plan.js) — and the
  // screen waits for the first of them, not for all thirty: the rest land on the
  // itinerary itself, day after day, while the traveller is already reading it.
  const hasFreeDays = (items, days) => freeDaysOf(items || [], days).length > 0;
  async function prepare(trip, { waitMs = 15000, onProgress = null } = {}) {
    const url = `/api/trips/code/${trip.share_code}/day-recs`;
    await TRIPMAKER.api(`${url}/refresh`, { method: 'POST', body: JSON.stringify({ scope: 'auto' }) });
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      const snap = await TRIPMAKER.api(url).catch(() => null);
      if (!snap) continue;
      if (onProgress) onProgress(snap);
      const days = Object.values(snap.days || {});
      // the first day is on screen the moment the itinerary opens; the rest stream in
      if (days.some((d) => d.status === 'ready')) return snap;
      if (!snap.running && !days.some((d) => d.status === 'pending')) return snap;
    }
    return null;
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
      : loadingDays.has(day) ? (r && r.status === 'ready' && r.cards.length ? 'מחליפים להמלצות אחרות…' : `ה-AI מכין המלצות ליום ${day}…`)
        : (!r || r.status === 'pending') ? `ה-AI מכין המלצות ליום ${day}…${progressText()}` : null;
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

  // a long trip fills day after day, from its first — so a day still waiting says how
  // far the trip has got. Silence here is what made thirty skeletons look stuck.
  function progressText() {
    const total = counts.ready + counts.waiting;
    if (!running || total < 2 || !counts.ready) return '';
    return ` · ${counts.ready} מתוך ${total} ימים מוכנים`;
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

  return { init, prefetch, blockHtml, sync, reloadAll, refreshDay, prepare, hasFreeDays };
})();
