// Calendar view for long trips: trip.js switches to it when the trip is longer
// than 7 days. Three sub-views (month / week / day), and every stop opens its
// details in a modal — a bottom sheet on phones.
// ctx = { trip, state, dayDate(day) -> Date|null, weather() -> { iso: forecast } }
const TripCalendar = (() => {
  const esc = (s) => TRIPI.esc(s);
  const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']; // Sunday-first, like every Hebrew calendar
  const CAT_EMOJI = {
    'אטרקציה': '🎡', 'אוכל': '🍜', 'טבע': '🌿', 'ים': '🏖️', 'תרבות': '🎭',
    'קניות': '🛍️', 'לינה': '🏨', 'נוף': '🌄', 'חיי לילה': '🌙',
  };

  // anchor = the trip day the day/week views center on; survives re-renders
  const view = { mode: 'month', anchor: 0, full: false };
  let lastContainer = null;
  let lastCtx = null;

  const AREA_COLORS = ['#ffb45f', '#8fd8c4', '#c9a7ff', '#7fb8ff', '#ff9db1', '#ffd166'];

  // every area of the trip, stable order: declared destinations first, then
  // free-text areas that only appear on stops (in first-appearance order)
  function tripAreas(ctx) {
    const names = (Array.isArray(ctx.trip.destinations) ? ctx.trip.destinations : [])
      .filter((d) => d && d.name).map((d) => d.name);
    const seen = new Set(names);
    for (const it of ctx.state.items) {
      if (it.area && !seen.has(it.area)) { seen.add(it.area); names.push(it.area); }
    }
    return names;
  }

  // the area a day belongs to, read off its non-travel stops: one clear area →
  // its name; travel-only, empty, or split between two areas → null (unmarked)
  function areaOfDay(items) {
    const areas = [...new Set(items.filter((it) => it.category !== 'נסיעה' && it.area).map((it) => it.area))];
    return areas.length === 1 ? areas[0] : null;
  }

  const chevPrev = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';  // points right = back in RTL
  const chevNext = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>'; // points left = forward in RTL
  const icExpand = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  const icShrink = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

  // fullscreen: the calendar covers the page (own scroll), Esc brings it back
  function setFull(on) {
    view.full = on;
    document.body.classList.toggle('cal-full-open', on);
    render(lastContainer, lastCtx);
  }

  // the list view replaces the calendar's markup (edit mode) — drop the page lock with it
  function exitFull() {
    view.full = false;
    document.body.classList.remove('cal-full-open');
  }

  function currentTripDay(ctx) {
    if (!ctx.trip.start_date) return null;
    const diff = Math.floor((Date.now() - new Date(ctx.trip.start_date).getTime()) / 86400000) + 1;
    return diff >= 1 && diff <= ctx.trip.days ? diff : null;
  }

  function itemsByDay(ctx) {
    const m = new Map();
    for (const it of ctx.state.items) {
      if (!m.has(it.day_number)) m.set(it.day_number, []);
      m.get(it.day_number).push(it);
    }
    return m;
  }

  function weatherOf(ctx, day) {
    const date = ctx.dayDate(day);
    if (!date) return null;
    return ctx.weather()[date.toISOString().slice(0, 10)] || null;
  }

  const stopEmoji = (it) => it.category === 'נסיעה' ? TripModals.travelIcon(it) : (CAT_EMOJI[it.category] || '📍');

  function render(container, ctx) {
    lastContainer = container;
    lastCtx = ctx;
    if (!view.anchor) view.anchor = currentTripDay(ctx) || 1;
    view.anchor = Math.min(Math.max(view.anchor, 1), ctx.trip.days);

    container.innerHTML = `
      <div class="cal-wrap${view.full ? ' cal-full' : ''}">
        <div class="cal-toolbar">
          <div class="seg cal-seg">
            <button type="button" data-v="day" class="${view.mode === 'day' ? 'active' : ''}">יומי</button>
            <button type="button" data-v="week" class="${view.mode === 'week' ? 'active' : ''}">שבועי</button>
            <button type="button" data-v="month" class="${view.mode === 'month' ? 'active' : ''}">חודשי</button>
          </div>
          <div class="cal-title">${calTitle(ctx)}</div>
          <button type="button" class="cal-fs-btn" aria-pressed="${view.full}"
            title="${view.full ? 'יציאה ממסך מלא (Esc)' : 'הגדלה למסך מלא'}"
            aria-label="${view.full ? 'יציאה ממסך מלא' : 'הגדלה למסך מלא'}">
            ${view.full ? icShrink : icExpand}
            <span>${view.full ? 'יציאה ממסך מלא' : 'מסך מלא'}</span>
          </button>
        </div>
        <div class="cal-body"></div>
      </div>`;
    container.querySelectorAll('.cal-seg button').forEach((b) => {
      b.onclick = () => { view.mode = b.dataset.v; render(container, ctx); };
    });
    container.querySelector('.cal-fs-btn').onclick = () => setFull(!view.full);
    // one listener for the page: Esc closes fullscreen, unless a stop modal is open on top
    if (!render.escBound) {
      render.escBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !view.full) return;
        if (document.getElementById('stop-modal')?.classList.contains('open')) return;
        setFull(false);
      });
    }

    const body = container.querySelector('.cal-body');
    if (view.mode === 'month') renderMonth(body, ctx);
    else if (view.mode === 'week') renderWeek(body, ctx);
    else renderDay(body, ctx);
  }

  function calTitle(ctx) {
    const first = ctx.dayDate(1);
    if (!first) return `${ctx.trip.days} ימים`;
    const last = ctx.dayDate(ctx.trip.days);
    const mf = (dt) => dt.toLocaleDateString('he-IL', { month: 'long' });
    return first.getMonth() === last.getMonth()
      ? `${mf(first)} ${first.getFullYear()}`
      : `${mf(first)} – ${mf(last)} ${last.getFullYear()}`;
  }

  // ---------- month: the whole trip as one continuous week grid ----------

  function renderMonth(body, ctx) {
    const { trip } = ctx;
    const byDay = itemsByDay(ctx);
    const hasDates = !!trip.start_date;
    const today = currentTripDay(ctx);
    const areas = tripAreas(ctx);
    const multiArea = areas.length > 1;
    const areaColor = (name) => AREA_COLORS[areas.indexOf(name) % AREA_COLORS.length];
    const cells = [];
    for (let d = 1; d <= trip.days; d++) {
      const date = ctx.dayDate(d);
      const w = weatherOf(ctx, d);
      const items = byDay.get(d) || [];
      const area = multiArea ? areaOfDay(items) : null;
      const styles = [];
      // align day 1 to its real weekday (grid column 1 = the right edge = Sunday)
      if (d === 1 && hasDates) styles.push(`grid-column-start:${date.getDay() + 1}`);
      if (area) styles.push(`--area-c:${areaColor(area)}`);
      const dateLabel = !date ? '' : (d === 1 || date.getDate() === 1)
        ? date.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })
        : date.getDate();
      cells.push(`
        <div class="cal-cell${d === today ? ' today' : ''}${items.length ? '' : ' free'}${area ? ' has-area' : ''}"
          data-day="${d}" role="button" tabindex="0" aria-label="יום ${d}${area ? ` · ${esc(area)}` : ''}"
          ${styles.length ? ` style="${styles.join(';')}"` : ''}>
          <span class="cc-head">
            <span class="cc-num">${d}</span>
            ${date ? `<span class="cc-date">${dateLabel}</span>` : '<span class="cc-date"></span>'}
            ${w ? `<span class="cc-weather" title="${GEO.weatherLabel(w.code)}">${GEO.weatherIcon(w.code)}</span>` : ''}
          </span>
          ${area ? `<span class="cc-area">${esc(area)}</span>` : ''}
          <span class="cc-evts">
            ${items.slice(0, 3).map((it) => `
              <span class="cal-evt${it.category === 'נסיעה' ? ' travel' : ''}" data-item="${it.id}" title="${esc(it.title)}">
                ${it.time_label ? `<b>${esc(it.time_label)}</b> ` : ''}${esc(it.title)}
              </span>`).join('')}
            ${items.length > 3 ? `<span class="cc-more">+${items.length - 3} עוד</span>` : ''}
          </span>
          <span class="cc-dots" aria-hidden="true">
            ${items.slice(0, 4).map((it) => `<i${it.category === 'נסיעה' ? ' class="travel"' : ''}></i>`).join('')}${items.length > 4 ? '<em>+</em>' : ''}
          </span>
        </div>`);
    }
    body.innerHTML = `
      ${multiArea ? `<div class="cal-legend">${areas.map((a) =>
        `<span class="cl-item"><i style="background:${areaColor(a)}"></i>${esc(a)}</span>`).join('')}</div>` : ''}
      ${hasDates ? `<div class="cal-dow-row" aria-hidden="true">${DOW.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
      <div class="cal-grid">${cells.join('')}</div>
      <div class="cal-hint">לחיצה על יום פותחת את התצוגה היומית שלו</div>`;

    body.querySelectorAll('.cal-cell').forEach((c) => {
      const open = (e) => {
        const evt = e.target.closest('.cal-evt');
        if (evt) { openStop(ctx, +evt.dataset.item); return; }
        view.mode = 'day';
        view.anchor = +c.dataset.day;
        render(lastContainer, ctx);
      };
      c.onclick = open;
      c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } };
    });
  }

  // ---------- week: 7-day chunk; columns on desktop, stacked rows on phones ----------

  function renderWeek(body, ctx) {
    const { trip } = ctx;
    const byDay = itemsByDay(ctx);
    const today = currentTripDay(ctx);
    const weeks = Math.ceil(trip.days / 7);
    const w = Math.ceil(view.anchor / 7);
    const from = (w - 1) * 7 + 1;
    const to = Math.min(w * 7, trip.days);

    const cols = [];
    for (let d = from; d <= to; d++) {
      const date = ctx.dayDate(d);
      const wf = weatherOf(ctx, d);
      const items = byDay.get(d) || [];
      cols.push(`
        <div class="cal-wday">
          <button type="button" class="cal-wday-head${d === today ? ' today' : ''}" data-day="${d}" title="לתצוגה היומית">
            <span class="wd-num">יום ${d}</span>
            ${date ? `<span class="wd-date">${DOW[date.getDay()]} ${date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}</span>` : ''}
            ${wf ? `<span class="wd-weather">${GEO.weatherIcon(wf.code)} ${wf.max}°</span>` : ''}
          </button>
          <div class="cal-wday-evts">
            ${items.map((it) => `
              <button type="button" class="cal-wevt${it.category === 'נסיעה' ? ' travel' : ''}" data-item="${it.id}">
                ${it.time_label ? `<span class="we-time">${esc(it.time_label)}</span>` : ''}
                <span class="we-title">${stopEmoji(it)} ${esc(it.title)}</span>
              </button>`).join('') || '<span class="wd-free">יום פנוי</span>'}
          </div>
        </div>`);
    }

    body.innerHTML = `
      <div class="cal-nav">
        <button type="button" class="cal-nav-btn" data-d="-1" aria-label="השבוע הקודם" ${w <= 1 ? 'disabled' : ''}>${chevPrev}</button>
        <span class="cal-nav-label">שבוע ${w} מתוך ${weeks} · ימים ${from}–${to}</span>
        <button type="button" class="cal-nav-btn" data-d="1" aria-label="השבוע הבא" ${w >= weeks ? 'disabled' : ''}>${chevNext}</button>
      </div>
      <div class="cal-week">${cols.join('')}</div>`;

    body.querySelectorAll('.cal-nav-btn').forEach((b) => {
      b.onclick = () => {
        view.anchor = Math.min(Math.max((w + +b.dataset.d - 1) * 7 + 1, 1), trip.days);
        render(lastContainer, ctx);
      };
    });
    body.querySelectorAll('.cal-wday-head').forEach((b) => {
      b.onclick = () => { view.mode = 'day'; view.anchor = +b.dataset.day; render(lastContainer, ctx); };
    });
    body.querySelectorAll('.cal-wevt').forEach((b) => {
      b.onclick = () => openStop(ctx, +b.dataset.item);
    });
  }

  // ---------- day: scrollable day strip + the full stop list of one day ----------

  function renderDay(body, ctx) {
    const { trip } = ctx;
    const d = view.anchor;
    const byDay = itemsByDay(ctx);
    const today = currentTripDay(ctx);
    const date = ctx.dayDate(d);
    const w = weatherOf(ctx, d);
    const items = byDay.get(d) || [];
    const cur = TripModals.curOf(ctx.state);
    const dayCost = TripModals.plannedByDay(ctx.state)[d];
    const hotelLines = TripModals.dayHotelLines(ctx.state, d);

    body.innerHTML = `
      <div class="cal-day-strip">
        ${Array.from({ length: trip.days }, (_, i) => i + 1).map((n) => {
          const dt = ctx.dayDate(n);
          return `
          <button type="button" class="cds-btn${n === d ? ' active' : ''}${n === today ? ' now' : ''}" data-day="${n}">
            ${dt ? `<span class="cds-dow">${DOW[dt.getDay()]}</span>` : ''}
            <span class="cds-num">${n}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="cal-day-head">
        <span class="day-badge">יום ${d}</span>
        ${date ? `<span class="day-date">${date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</span>` : ''}
        ${dayCost ? `<span class="day-cost" title="עלות משוערת של היום (בלי לינה)">${TripModals.fmt(dayCost, cur)}</span>` : ''}
        ${w ? `<span class="day-weather" title="${GEO.weatherLabel(w.code)}">${GEO.weatherIcon(w.code)} ${w.max}°</span>` : ''}
      </div>
      ${hotelLines.length ? `<div class="day-hotels">${hotelLines.map((l) =>
        `<span class="day-hotel ${l.cls}">${l.html}</span>`).join('')}</div>` : ''}
      <div class="cal-day-list">
        ${items.map((it) => `
          <button type="button" class="cal-devt glass${it.category === 'נסיעה' ? ' travel' : ''}" data-item="${it.id}">
            <span class="cd-emoji" aria-hidden="true">${stopEmoji(it)}</span>
            <span class="cd-main">
              <span class="cd-title">${esc(it.title)}</span>
              <span class="cd-meta">
                ${it.time_label ? `<span class="cd-time">${esc(it.time_label)}</span>` : ''}
                ${it.category ? `<span>${esc(it.category)}</span>` : ''}
                ${+it.cost > 0 ? `<span class="cd-cost">${TripModals.fmt(it.cost, cur)}</span>` : ''}
              </span>
              ${it.note ? `<span class="cd-note">${esc(it.note)}</span>` : ''}
            </span>
            <svg class="ic cd-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>`).join('') || '<div class="empty-day" style="border-radius:var(--radius-sm)">יום פנוי — זמן לאלתורים 🌴</div>'}
      </div>`;

    body.querySelector('.cds-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    body.querySelectorAll('.cds-btn').forEach((b) => {
      b.onclick = () => { view.anchor = +b.dataset.day; render(lastContainer, ctx); };
    });
    body.querySelectorAll('.cal-devt').forEach((b) => {
      b.onclick = () => openStop(ctx, +b.dataset.item);
    });
  }

  // ---------- stop details modal (bottom sheet on phones) ----------

  function openStop(ctx, itemId) {
    const it = ctx.state.items.find((x) => x.id === itemId);
    if (!it) return;
    let wrap = document.getElementById('stop-modal');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'stop-modal';
      wrap.className = 'modal-backdrop sheet';
      wrap.innerHTML = `
        <div class="modal glass modal-stop">
          <div class="sheet-grab" aria-hidden="true"></div>
          <button class="modal-close" aria-label="סגירה">✕</button>
          <div class="sm-body"></div>
        </div>`;
      document.body.appendChild(wrap);
      wrap.querySelector('.modal-close').onclick = () => wrap.classList.remove('open');
      wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.classList.remove('open'); });
    }

    const date = ctx.dayDate(it.day_number);
    const cur = TripModals.curOf(ctx.state);
    const hasMap = !!(it.place_query || (it.lat != null && it.lon != null));
    const body = wrap.querySelector('.sm-body');
    body.innerHTML = `
      <div class="sm-day">יום ${it.day_number}${date ? ` · ${date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}</div>
      <h2 class="sm-title">${stopEmoji(it)} ${esc(it.title)}</h2>
      <div class="sm-chips">
        ${it.time_label ? `<span class="item-time">${esc(it.time_label)}</span>` : ''}
        ${it.category ? `<span class="item-cat">${esc(it.category)}</span>` : ''}
        ${+it.cost > 0 ? `<span class="item-cost">${TripModals.fmt(it.cost, cur)}</span>` : ''}
        ${it.area ? `<span class="item-area">📍 ${esc(it.area)}</span>` : ''}
      </div>
      ${it.note ? `<div class="item-note">${esc(it.note)}</div>` : ''}
      ${it.place_query ? `<div class="item-more-place"><span class="imp-pin">📍</span><span class="imp-text">${esc(it.place_query)}</span></div>` : ''}
      ${hasMap ? `<iframe class="item-mini-map" loading="lazy" title="מפת התחנה" src="${TRIPI.mapsEmbedUrlExact(it)}"></iframe>` : ''}
      ${it.place_query ? '<div class="stop-gallery"></div>' : ''}
      ${hasMap ? `<a class="btn btn-ghost sm-maps" target="_blank" rel="noopener"
        href="${esc(TRIPI.mapsSearchUrl(it.place_query || `${it.lat},${it.lon}`))}">פתיחה בגוגל מפות ›</a>` : ''}`;
    const gal = body.querySelector('.stop-gallery');
    if (gal) GEO.renderGallery(gal, it.place_query);
    wrap.querySelector('.modal-stop').scrollTop = 0;
    wrap.classList.add('open');
  }

  return { render, exitFull };
})();
