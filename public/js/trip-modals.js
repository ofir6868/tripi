// Trip page modals: hotels ("איפה ישנים") and the money page ("מי חייב למי" — the
// shared expenses, Splitwise-style, with an optional budget). They operate on the trip.js state object:
// { trip, items, hotels, budget, expenses, participants, canEdit }.
// ctx = { state, ensureEdit(), refresh() } — ensureEdit resolves edit headers (routing
// invite holders through signup when needed) or null; refresh() re-renders the trip page.
const TripModals = (() => {
  const CURRENCIES = { ILS: '₪', USD: '$', EUR: '€', GBP: '£', JPY: '¥', THB: '฿', CHF: '₣' };
  const HOTEL_COLORS = ['#ffb45f', '#8fd8c4', '#c9a7ff', '#7fb8ff'];
  const CATS = [
    { key: 'לינה', emoji: '🏨' },
    { key: 'אוכל', emoji: '🍜' },
    { key: 'נסיעות', emoji: '🚆' },
    { key: 'אטרקציות', emoji: '🎡' },
    { key: 'קניות', emoji: '🛍️' },
    { key: 'אחר', emoji: '✨' },
  ];

  const esc = (s) => TRIPMAKER.esc(s);
  const sym = (cur) => CURRENCIES[cur] || '₪';
  const fmt = (n, cur) => `${sym(cur)}${Math.round(+n || 0).toLocaleString('he-IL')}`;
  const curOf = (state) => (state.budget && state.budget.currency) || 'ILS';

  // ---- shared math ----

  // itinerary category → budget category
  function budgetCatOf(category) {
    if (category === 'לינה') return 'לינה';
    if (category === 'אוכל') return 'אוכל';
    if (category === 'נסיעה') return 'נסיעות';
    if (category === 'קניות') return 'קניות';
    if (!category) return 'אחר';
    return ['אטרקציה', 'תרבות', 'היסטוריה', 'אמנות', 'ים', 'טבע', 'נוף', 'חיי לילה', 'עיר'].includes(category)
      ? 'אטרקציות' : 'אחר';
  }

  // travel stops: icon inferred from the actual mode, not assumed to be a flight
  function travelIcon(it) {
    const s = `${it.title || ''} ${it.note || ''}`;
    if (/טיס|מטוס|flight|✈/.test(s)) return '✈️';
    if (/רכבת|train|shinkansen|שינקנסן/i.test(s)) return '🚆';
    if (/אוטובוס|bus/i.test(s)) return '🚌';
    if (/מעבורת|שיט|סירה|ferry|boat/i.test(s)) return '⛴️';
    if (/רכב|נהיגה|השכר|drive|car/i.test(s)) return '🚗';
    return '🧳';
  }

  const bookedHotels = (state) => state.hotels.filter((h) => h.status === 'booked');

  // planned money: stop estimates + booked hotel prices (the lodging category)
  function plannedTotals(state) {
    const byCat = Object.fromEntries(CATS.map((c) => [c.key, 0]));
    let total = 0;
    for (const it of state.items) {
      const c = +it.cost;
      if (!(c > 0)) continue;
      byCat[budgetCatOf(it.category)] += c;
      total += c;
    }
    for (const h of bookedHotels(state)) {
      const p = +h.price_total;
      if (!(p > 0)) continue;
      byCat['לינה'] += p;
      total += p;
    }
    return { total, byCat };
  }

  // activity money per day (stop estimates only — lodging reads on the night markers)
  function plannedByDay(state) {
    const byDay = {};
    for (const it of state.items) {
      const c = +it.cost;
      if (c > 0) byDay[it.day_number] = (byDay[it.day_number] || 0) + c;
    }
    return byDay;
  }

  // ---- nights (night N = sleeping between day N and N+1) ----

  const nightCount = (state) => Math.max(state.trip.days - 1, 0);

  function hotelColor(state, hotel) {
    const idx = state.hotels.filter((h) => h.status === 'booked').findIndex((h) => h.id === hotel.id);
    return HOTEL_COLORS[(idx >= 0 ? idx : 0) % HOTEL_COLORS.length];
  }

  function nightCoverage(state) {
    const cover = {}; // night → hotel
    for (const h of bookedHotels(state)) {
      for (let n = h.night_start; n <= h.night_end; n++) if (!cover[n]) cover[n] = h;
    }
    return cover;
  }

  // the hotel a night is slept in, as the itinerary and the map draw it: the booked
  // stay, or — while nothing is booked — the idea saved for that night (an AI's pick
  // lands as one), so the day still ends somewhere
  function nightHotel(state, night) {
    const booked = nightCoverage(state)[night];
    if (booked) return booked;
    return (state.hotels || []).find((h) => h.status === 'idea' && h.night_start <= night && night <= h.night_end) || null;
  }

  function uncoveredRuns(state) {
    const cover = nightCoverage(state);
    const runs = [];
    let run = null;
    for (let n = 1; n <= nightCount(state); n++) {
      if (cover[n]) { run = null; continue; }
      if (!run) { run = { from: n, to: n }; runs.push(run); } else run.to = n;
    }
    return runs;
  }

  // destination blocks by day, derived from the itinerary's areas (fallback: even split)
  function destBlocks(state) {
    const days = state.trip.days;
    const dests = Array.isArray(state.trip.destinations) ? state.trip.destinations.filter((d) => d && d.name) : [];
    const byArea = new Map();
    for (const it of state.items) {
      if (!it.area) continue;
      const b = byArea.get(it.area) || { name: it.area, from: it.day_number, to: it.day_number };
      b.from = Math.min(b.from, it.day_number);
      b.to = Math.max(b.to, it.day_number);
      byArea.set(it.area, b);
    }
    let blocks = [...byArea.values()].sort((a, b) => a.from - b.from);
    if (!blocks.length && dests.length) {
      const per = Math.max(Math.floor(days / dests.length), 1);
      blocks = dests.map((d, i) => ({
        name: d.name, from: i * per + 1,
        to: i === dests.length - 1 ? days : (i + 1) * per,
      })).filter((b) => b.from <= days);
    }
    return blocks;
  }

  function blockOfNight(state, night) {
    return destBlocks(state).find((b) => night >= b.from && night <= Math.max(b.to - 0, b.from)) ||
      destBlocks(state).find((b) => night <= b.to) || null;
  }

  function destCoords(state, areaName) {
    const dests = Array.isArray(state.trip.destinations) ? state.trip.destinations : [];
    return dests.find((d) => d && d.name === areaName && d.lat != null) || dests.find((d) => d && d.lat != null) || null;
  }

  function nightDates(state, h) {
    if (!state.trip.start_date) return null;
    const mk = (offsetDays) => {
      const d = new Date(state.trip.start_date);
      d.setDate(d.getDate() + offsetDays);
      return TRIPMAKER.isoDate(d);
    };
    return { checkin: mk(h.night_start - 1), checkout: mk(h.night_end) };
  }

  // Travelpayouts wrapping (Booking.com program). The three ids come from one
  // link generated in the TP dashboard — it looks like
  // https://tp.media/r?marker=123456&trs=98765&p=4132&u=https%3A%2F%2Fwww.booking.com...
  // Empty marker = affiliate off, links stay bare booking.com URLs.
  const TP = { marker: '', trs: '', p: '' };

  function tpWrap(state, h, url) {
    let host = '';
    try { host = new URL(url).hostname; } catch { return url; }
    if (!TP.marker || !/(^|\.)booking\.com$/i.test(host)) return url;
    return `https://tp.media/r?marker=${TP.marker}&trs=${TP.trs}&p=${TP.p}` +
      `&sub_id=${encodeURIComponent(`t${state.trip.id}-n${h.night_start}`)}&u=${encodeURIComponent(url)}`;
  }

  // stroke icons for the hotel-card action row — inherit currentColor like every .ic
  const HICON = {
    pin: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    link: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    search: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    pencil: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6h17M9.5 6V4.4A1.4 1.4 0 0 1 10.9 3h2.2a1.4 1.4 0 0 1 1.4 1.4V6"/><path d="M18.4 6l-.8 12.7A2 2 0 0 1 15.6 20.6H8.4a2 2 0 0 1-2-1.9L5.6 6"/><path d="M10.3 10.4v5.9M13.7 10.4v5.9"/></svg>',
  };

  function bookingUrl(state, h) {
    if (h.link) return tpWrap(state, h, h.link);
    const block = destBlocks(state).find((b) => h.night_start >= b.from && h.night_start <= b.to);
    // trimmed: a night card searches the area with no hotel name, and an
    // untrimmed join leaves a leading space in the query
    let url = 'https://www.booking.com/searchresults.he.html?ss=' +
      encodeURIComponent(`${h.name} ${block ? block.name : state.trip.destination}`.trim());
    const dates = nightDates(state, h);
    if (dates) url += `&checkin=${dates.checkin}&checkout=${dates.checkout}`;
    url += `&group_adults=${(state.budget && state.budget.travelers) || 2}&no_rooms=1&group_children=0`;
    url += `&selected_currency=${curOf(state)}`; // prices land in the same currency as the trip's budget
    return tpWrap(state, h, url);
  }

  // =================================================================
  //  HOTELS PAGE — "איפה ישנים"
  //
  //  A full page like the other dock pages (#hotels, back closes it), built
  //  phone-first the way travel apps lay out a stay: the trip's nights as a row
  //  of dated chips, then every stretch of the trip in order — a booked stay as
  //  a card with its photo, check-in and check-out; a night nobody solved as an
  //  open card with the hotels nearest where that day ends. Adding and editing
  //  happen in a bottom sheet, and the nights are picked by tapping them.
  // =================================================================

  const WEEKDAY = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

  // the evening of `offset` days after the trip starts, as { wd, dm } — or null with no dates
  function tripDay(state, offset) {
    const iso = String(state.trip.start_date || '').slice(0, 10);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3] + offset);
    return { wd: WEEKDAY[d.getDay()], dm: `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}` };
  }
  // night N is the evening of day N; its check-out is the morning of day N+1
  const nightDay = (state, n) => tripDay(state, n - 1);

  // the map's colour for a day — one colour per day across the pin, the line and here
  const dayTint = (day) => (typeof TripMap !== 'undefined' && TripMap.dayColor ? TripMap.dayColor(day) : '#ffb45f');

  const nightsWord = (k) => (k === 1 ? 'לילה אחד' : `${k} לילות`);
  // the range is isolated left-to-right: in a Hebrew line, "1–4" would otherwise read as "4–1"
  const rangeWord = (a, b) => (a === b ? `לילה ${a}` : `לילות \u2066${a}–${b}\u2069`);

  // the stay's picture: its own when it came from a suggestion, else its city's
  function stayPhoto(state, h, areaName) {
    if (h.photo) return h.photo;
    if (typeof DEST_PHOTOS === 'undefined') return null;
    const dests = Array.isArray(state.trip.destinations) ? state.trip.destinations : [];
    const d = dests.find((x) => x && x.name === areaName) || dests[0] || { name: state.trip.destination, country: state.trip.country };
    const f = DEST_PHOTOS.find(d) || DEST_PHOTOS.find({ name: state.trip.destination, country: state.trip.country });
    return DEST_PHOTOS.img(f ? f.id : DEST_PHOTOS.generic[(state.trip.id || 0) % DEST_PHOTOS.generic.length], 900);
  }

  // The trip cut into stretches, in order: a booked stay covering consecutive nights,
  // or a run of nights with nothing booked. Ideas sit with the stretch they start in.
  function hotelSegments(state) {
    const cover = nightCoverage(state);
    const segs = [];
    for (let n = 1; n <= nightCount(state); n++) {
      const h = cover[n] || null;
      // an open night is split by the idea saved for it: the AI's picks for a 22-night
      // trip are a stay each, not one "nights 1–22, nowhere to sleep" heap (2026-11-03)
      const idea = h ? null : nightHotel(state, n);
      const last = segs[segs.length - 1];
      if (last && last.hotel === h && last.idea === idea && last.to === n - 1) { last.to = n; continue; }
      segs.push({ hotel: h, idea, from: n, to: n, ideas: [] });
    }
    for (const idea of state.hotels.filter((x) => x.status === 'idea')) {
      const seg = segs.find((s) => idea.night_start >= s.from && idea.night_start <= s.to) || segs[segs.length - 1];
      if (seg) seg.ideas.push(idea);
    }
    return segs;
  }

  const HP_ICON = {
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    nav: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 19-9-9 19-2-8-8-2z"/></svg>',
    ticket: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/></svg>',
    info: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    tag: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  };

  let hotelsCtx = null;
  const railCache = new Map(); // anchor → nearby hotels, for this visit
  let hotelsRender = null; // the open page's render(), so a change elsewhere can repaint it

  // the page is registered once the trip knows it has nights; reload on #hotels lands on it
  function initHotels(ctx) {
    hotelsCtx = ctx;
    if (typeof TripPages === 'undefined') return;
    TripPages.register('hotels', {
      title: '🏨 איפה ישנים',
      sub: 'כל לילה בטיול — מה כבר הוזמן, מה עוד פתוח, ומלונות ליד המקום שבו היום נגמר',
      render: (slots) => renderHotelsPage(slots, hotelsCtx),
      onClose: () => { hotelsRender = null; },
    });
  }

  // opts.addNight: arriving from a night in the itinerary — a booked night opens its
  // stay for editing, an open one opens the add sheet on that night
  function openHotels(ctx, opts = {}) {
    if (!hotelsCtx || hotelsCtx !== ctx) initHotels(ctx);
    const { state } = ctx;
    if (typeof TripPages === 'undefined') return;
    if (TripPages.current() === 'hotels') hotelsRender?.();
    else TripPages.open('hotels');
    if (opts.addNight && nightCount(state) > 0) {
      const h = nightHotel(state, opts.addNight);
      if (h) openStaySheet(ctx, h, h.night_start, h.night_end);
      else openStaySheet(ctx, null, opts.addNight, opts.addNight);
    }
    // the overnight point in the itinerary or on the map: the page opens on that
    // night's stay card, lit up for a moment so the eye finds it
    if (opts.focusNight && nightCount(state) > 0) {
      const seg = hotelSegments(state).find((x) => opts.focusNight >= x.from && opts.focusNight <= x.to);
      let tries = 0;
      const focus = () => {
        const el = seg && document.getElementById(`hp-seg-${seg.from}`);
        if (!el) { if (seg && ++tries < 20) requestAnimationFrame(focus); return; }
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
        el.classList.remove('hp-flash');
        void el.offsetWidth;
        el.classList.add('hp-flash');
      };
      requestAnimationFrame(focus);
    }
  }

  // a stay saved from outside the hotels page — a lodging card from the recommendations
  // chat — goes where every hotel goes: an idea for its night on the hotels page, drawn
  // in the itinerary and on the map as where that day ends. Never a stop.
  async function saveStayIdea(state, { name, night, lat = null, lon = null, photo = null, headers = {} }) {
    const last = nightCount(state);
    if (last < 1) throw new Error('בטיול של יום אחד ישנים בבית');
    const n = Math.min(Math.max(parseInt(night, 10) || 1, 1), last);
    const key = String(name || '').trim().toLowerCase();
    const dup = state.hotels.find((x) => x.night_start <= n && n <= x.night_end && String(x.name || '').trim().toLowerCase() === key);
    if (dup) return { hotel: dup, night: n };
    const row = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels`, {
      method: 'POST', headers,
      body: JSON.stringify({ name, night_start: n, night_end: n, status: 'idea', lat, lon, photo }),
    });
    state.hotels.push(row);
    hotelsRender?.();
    TRIPMAKER.track('hotel_idea_saved', { trip_id: state.trip.id, night: n, from: 'recs' });
    return { hotel: row, night: n };
  }

  function renderHotelsPage(slots, ctx) {
    const { state } = ctx;
    const { body, foot } = slots;

    if (nightCount(state) === 0) {
      body.innerHTML = '<div class="tp-inner"><div class="hp-empty glass"><div class="hp-empty-ic">🏡</div><h3>טיול של יום אחד</h3><p>ישנים בבית 🙂</p></div></div>';
      foot.innerHTML = '';
      return;
    }

    foot.innerHTML = state.canEdit
      ? `<button type="button" class="hp-fab" id="hp-add">${HP_ICON.plus}<span>הוספת מלון</span></button>`
      : '';
    // the button shrinks to its icon once the page scrolls, so it never sits on a card's buttons
    const fab = foot.querySelector('#hp-add');
    // (and starts as one when there are stays on screen already: the label is for the empty page)
    if (fab) {
      const mini = () => fab.classList.toggle('is-mini', state.hotels.length > 0 || body.scrollTop > 40);
      body.onscroll = mini;
      fab.setAttribute('aria-label', 'הוספת מלון');
      requestAnimationFrame(mini);
    }
    fab?.addEventListener('click', () => {
      const run = uncoveredRuns(state)[0];
      openStaySheet(ctx, null, run ? run.from : 1, run ? run.to : nightCount(state));
    });

    function overlapsOf(hotel) {
      if (hotel.status !== 'booked') return [];
      return bookedHotels(state).filter((h) =>
        h.id !== hotel.id && h.night_start <= hotel.night_end && hotel.night_start <= h.night_end);
    }

    function summaryHtml() {
      const total = nightCount(state);
      const cover = nightCoverage(state);
      const done = Object.keys(cover).filter((n) => +n <= total).length;
      const runs = uncoveredRuns(state);
      const cur = curOf(state);
      const spend = bookedHotels(state).reduce((s, h) => s + (+h.price_total || 0), 0);
      const pricedNights = bookedHotels(state).filter((h) => +h.price_total > 0)
        .reduce((s, h) => s + (h.night_end - h.night_start + 1), 0);
      const R = 26, C = 2 * Math.PI * R;
      const frac = total ? done / total : 0;
      const title = done === total ? 'כל הלילות מסודרים'
        : done === 0 ? 'עוד לא סגרתם איפה ישנים' : `${done} מתוך ${total} לילות מסודרים`;
      const sub = done === total
        ? 'אפשר לישון בשקט 🎉'
        : `${runs.map((r) => rangeWord(r.from, r.to)).join(', ')} — עדיין פתוח`;
      return `
        <section class="hp-summary glass${done === total ? ' all-done' : ''}">
          <div class="hp-ring" role="img" aria-label="${done} מתוך ${total} לילות מסודרים">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="${R}" class="hr-track"/>
              ${done ? `<circle cx="32" cy="32" r="${R}" class="hr-fill" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}"/>` : ''}
            </svg>
            <span class="hr-num"><b>${done}</b>/${total}</span>
          </div>
          <div class="hp-sum-text">
            <h3>${title}</h3>
            <p>${sub}</p>
            ${spend > 0 && state.canEdit ? `<p class="hp-sum-money">${HP_ICON.tag}${fmt(spend, cur)} על לינה${pricedNights > 1 ? ` · ${fmt(spend / pricedNights, cur)} ללילה` : ''}</p>` : ''}
          </div>
          ${runs.length && done > 0 ? `<button type="button" class="hp-sum-go" data-go="${runs[0].from}">לילה ${runs[0].from} ‹</button>` : ''}
        </section>`;
    }

    function nightsHtml(segs) {
      const blocks = destBlocks(state);
      const total = nightCount(state);
      const chip = (n) => {
        const seg = segs.find((s) => n >= s.from && n <= s.to);
        const h = seg && seg.hotel;
        const hasIdea = !h && state.hotels.some((x) => x.status === 'idea' && x.night_start <= n && n <= x.night_end);
        const d = nightDay(state, n);
        const color = h ? hotelColor(state, h) : null;
        return `
          <button type="button" class="hp-night ${h ? 'is-booked' : hasIdea ? 'is-idea' : 'is-gap'}" data-go="${seg ? seg.from : n}"
            ${color ? `style="--c:${color}"` : ''} aria-label="לילה ${n}${d ? ` · ${d.wd} ${d.dm}` : ''} · ${h ? esc(h.name) : 'עוד אין מלון'}">
            <span class="hn-top">${d ? d.wd : 'לילה'}</span>
            <span class="hn-big">${d ? d.dm : n}</span>
            <span class="hn-bar" aria-hidden="true"></span>
          </button>`;
      };
      // grouped under each destination, so a two-city trip reads as two stretches
      const groups = [];
      if (blocks.length > 1) {
        for (const b of blocks) {
          const from = Math.max(b.from, groups.length ? groups[groups.length - 1].to + 1 : 1);
          const to = Math.min(Math.max(b.to, from), total);
          if (from > total || from > to) continue;
          groups.push({ name: b.name, from, to });
        }
        if (groups.length && groups[groups.length - 1].to < total) groups[groups.length - 1].to = total;
      }
      if (!groups.length) groups.push({ name: null, from: 1, to: total });
      return `
        <div class="hp-nights" role="group" aria-label="הלילות בטיול">
          ${groups.map((g) => `
            <div class="hn-group">
              ${g.name ? `<div class="hn-area">${esc(g.name)}</div>` : ''}
              <div class="hn-row">${Array.from({ length: g.to - g.from + 1 }, (_, i) => chip(g.from + i)).join('')}</div>
            </div>`).join('')}
        </div>`;
    }

    function dateCell(label, dayNum) {
      const d = tripDay(state, dayNum - 1);
      return `
        <div class="std">
          <small>${label}</small>
          <b>${d ? `${d.wd} ${d.dm}` : `יום ${dayNum}`}</b>
          <span><i style="background:${dayTint(dayNum)}"></i>יום ${dayNum}</span>
        </div>`;
    }

    function ideaRow(h) {
      return `
        <div class="hp-idea" data-edit="${h.id}" role="button" tabindex="0">
          <span class="hi-thumb">${h.photo ? `<img src="${esc(h.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '💡'}</span>
          <span class="hi-text">
            <b>${esc(h.name)}</b>
            <small>${rangeWord(h.night_start, h.night_end)}${h.stars ? ` · <span class="hotel-stars">${'★'.repeat(Math.min(h.stars, 5))}</span>` : ''}${h.price_total && state.canEdit ? ` · ${fmt(h.price_total, curOf(state))}` : ''}</small>
          </span>
          ${state.canEdit ? `<button type="button" class="hi-book" data-booked="${h.id}" aria-label="סימון ${esc(h.name)} כמלון שהזמנתם">הזמנתי</button>` : ''}
        </div>`;
    }

    function stayHtml(seg) {
      const h = seg.hotel;
      const color = hotelColor(state, h);
      const block = blockOfNight(state, h.night_start);
      const area = block ? block.name : state.trip.destination;
      const photo = stayPhoto(state, h, area);
      const nights = h.night_end - h.night_start + 1;
      const over = overlapsOf(h);
      const price = +h.price_total > 0 && state.canEdit
        ? `<div class="st-money">${HP_ICON.tag}<b>${fmt(h.price_total, curOf(state))}</b> סה״כ${nights > 1 ? ` · ${fmt(h.price_total / nights, curOf(state))} ללילה` : ''}</div>` : '';
      return `
        <article class="hp-stay" id="hp-seg-${seg.from}" style="--c:${color}">
          <div class="st-cover${h.photo ? '' : ' is-city'}">
            ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
            <span class="stc-status">${NC_ICON.check} הוזמן</span>
            <span class="stc-nights">${nightsWord(nights)}</span>
            <div class="stc-title">
              <h3>${esc(h.name)}</h3>
              <p>${h.stars ? `<span class="hotel-stars">${'★'.repeat(Math.min(h.stars, 5))}</span> · ` : ''}${esc(area || '')}</p>
            </div>
          </div>
          <div class="st-body">
          <div class="st-dates">
            ${dateCell('צ׳ק-אין', h.night_start)}
            <div class="std-mid" aria-hidden="true"><span>${NC_ICON.moon}${nights}</span></div>
            ${dateCell('צ׳ק-אאוט', h.night_end + 1)}
          </div>
          ${price}
          ${over.length ? `<div class="st-warn">⚠️ חופף ל"${esc(over[0].name)}" — כדאי לבדוק את הלילות</div>` : ''}
          <div class="st-actions">
            <a class="st-act" target="_blank" rel="noopener" href="${esc(TRIPMAKER.mapsSearchUrl(h.name + (area ? ' ' + area : '')))}">${HP_ICON.nav}<span>ניווט</span></a>
            ${h.link
              ? `<a class="st-act" target="_blank" rel="noopener" data-book="${h.id}" data-kind="custom_link" href="${esc(tpWrap(state, h, h.link))}">${HP_ICON.ticket}<span>ההזמנה</span></a>`
              : `<a class="st-act" target="_blank" rel="noopener" data-book="${h.id}" data-kind="google_hotels" href="${esc(hotelSearchUrl(h.name))}">${NC_ICON.search}<span>מחירים</span></a>`}
            ${h.ref ? `<button type="button" class="st-act" data-detail="${h.id}">${HP_ICON.info}<span>פרטים</span></button>` : ''}
            ${state.canEdit ? `<button type="button" class="st-act" data-edit="${h.id}">${HICON.pencil}<span>עריכה</span></button>` : ''}
          </div>
          ${seg.ideas.length ? `<div class="st-alts"><div class="st-alts-t">💡 עוד אפשרויות שעלו</div>${seg.ideas.map(ideaRow).join('')}</div>` : ''}
          </div>
        </article>`;
    }

    function gapHtml(seg) {
      const d = nightDay(state, seg.from);
      const anchor = nightAnchor(state, seg.from);
      const area = (anchor && anchor.area) || state.trip.destination || '';
      const when = d ? `${d.wd} ${d.dm}` : '';
      return `
        <article class="hp-gap" id="hp-seg-${seg.from}" data-night="${seg.from}" style="--d:${dayTint(seg.from)}">
          <div class="hg-head">
            <span class="hg-moon">${NC_ICON.moon}</span>
            <div class="hg-titles">
              <h3>${rangeWord(seg.from, seg.to)}${when ? ` <small>· ${when}</small>` : ''}</h3>
              <p>${area ? `${esc(area)} · ` : ''}${seg.idea ? 'יש רעיון — עוד לא הוזמן' : 'עוד אין איפה לישון'}</p>
            </div>
          </div>
          ${seg.ideas.length ? `<div class="hg-ideas">${seg.ideas.map(ideaRow).join('')}</div>` : ''}
          ${anchor ? `
            <div class="hg-sugg">${anchor.after
              ? `היום מסתיים ב<b>${esc(anchor.after)}</b> — הכי קרובים לשם`
              : `מלונות ב${esc(area)}`}</div>
            <div class="nc-rail hg-rail">${'<div class="nc-skel"></div>'.repeat(3)}</div>` : ''}
          ${state.canEdit ? `
            <div class="hg-actions">
              <button type="button" class="hg-have" data-add-from="${seg.from}" data-add-to="${seg.to}">${NC_ICON.check} כבר הזמנתי</button>
              <a class="hg-search" target="_blank" rel="noopener" href="${esc(hotelSearchUrl(`מלונות ${area}`))}">${NC_ICON.search} חיפוש בגוגל</a>
            </div>` : ''}
        </article>`;
    }

    function render() {
      const segs = hotelSegments(state);
      body.innerHTML = `
        <div class="tp-inner hp">
          ${summaryHtml()}
          ${nightsHtml(segs)}
          <div class="hp-list">${segs.map((s) => (s.hotel ? stayHtml(s) : gapHtml(s))).join('')}</div>
        </div>`;
      wire(segs);
    }
    hotelsRender = render;

    function wire(segs) {
      body.querySelectorAll('[data-go]').forEach((b) => {
        b.onclick = () => {
          const el = body.querySelector(`#hp-seg-${b.dataset.go}`);
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.remove('hp-flash');
          void el.offsetWidth;
          el.classList.add('hp-flash');
        };
      });
      const byId = (id) => state.hotels.find((x) => x.id === +id);
      body.querySelectorAll('[data-edit]').forEach((el) => {
        const open = (e) => {
          if (e.target.closest('[data-booked]')) return;
          const h = byId(el.dataset.edit);
          if (h && state.canEdit) openStaySheet(ctx, h, h.night_start, h.night_end);
        };
        el.addEventListener('click', open);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
      });
      body.querySelectorAll('[data-booked]').forEach((b) => {
        b.onclick = async () => {
          const h = byId(b.dataset.booked);
          if (!h) return;
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          b.disabled = true;
          try {
            const updated = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels/${h.id}`, {
              method: 'PUT', headers, body: JSON.stringify({ ...h, status: 'booked' }),
            });
            Object.assign(h, updated);
            TRIPMAKER.track('hotel_idea_booked', { trip_id: state.trip.id });
            render(); ctx.refresh();
          } catch (e) { b.disabled = false; alert(e.message); }
        };
      });
      body.querySelectorAll('[data-detail]').forEach((b) => {
        b.onclick = () => {
          const h = byId(b.dataset.detail);
          if (h && h.ref) openHotelSheet(ctx, h.night_start, { id: h.ref, name: h.name, photo: h.photo, stars: h.stars });
        };
      });
      body.querySelectorAll('[data-add-from]').forEach((b) => {
        b.onclick = () => openStaySheet(ctx, null, +b.dataset.addFrom, +b.dataset.addTo);
      });
      // outbound booking clicks are the revenue funnel — count them from day one
      body.querySelectorAll('a[data-book]').forEach((a) => {
        a.addEventListener('click', () => {
          const h = byId(a.dataset.book);
          TRIPMAKER.track('hotel_link_click', {
            trip_id: state.trip.id, kind: a.dataset.kind, affiliate: !!TP.marker,
            night_start: h && h.night_start, night_end: h && h.night_end,
          });
        });
      });

      // each open night fills its rail when it scrolls near — a two-week trip with
      // eight open nights doesn't fire eight lookups the moment the page opens
      const gaps = [...body.querySelectorAll('.hp-gap')];
      const fill = async (card) => {
        if (card.dataset.loaded) return;
        card.dataset.loaded = '1';
        const night = +card.dataset.night;
        const rail = card.querySelector('.hg-rail');
        const anchor = nightAnchor(state, night);
        if (!rail || !anchor) return;
        // kept per anchor for the visit: saving an idea repaints the page, and the
        // repaint must not ask the provider again for the hotels it just showed
        const key = `${anchor.lat.toFixed(3)},${anchor.lon.toFixed(3)}`;
        let hotels = railCache.get(key);
        if (!hotels) {
          try {
            hotels = await GEO.hotelsNear(anchor.lat, anchor.lon, { country: state.trip.country || null, limit: 12, radius: 4000 });
            railCache.set(key, hotels || []);
          } catch { hotels = []; /* upstream trouble — the card still offers "כבר הזמנתי" */ }
        }
        const picked = pickForRail(hotels || []);
        if (!picked.length) {
          rail.outerHTML = '<div class="nc-empty">לא מצאנו מלונות בקרבת מקום — אפשר לחפש בגוגל או להוסיף ידנית</div>';
          card.querySelector('.hg-sugg')?.remove();
          return;
        }
        rail.innerHTML = railHtml(state, night, picked);
        wireRail(ctx, night, picked, rail, { from: 'hotels_page', onSaved: () => render() });
      };
      if (!('IntersectionObserver' in window)) { gaps.forEach(fill); return; }
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.unobserve(e.target);
          fill(e.target);
        }
      }, { rootMargin: '400px 0px' });
      gaps.forEach((g) => io.observe(g));
    }

    render();
    TRIPMAKER.track('hotels_page_open', {
      trip_id: state.trip.id, nights: nightCount(state),
      covered: Object.keys(nightCoverage(state)).length, ideas: state.hotels.filter((h) => h.status === 'idea').length,
    });
  }

  // ---- the stay sheet: add or edit one stay ----

  function openStaySheet(ctx, h, from, to) {
    const { state } = ctx;
    if (typeof TripPages === 'undefined') return;
    const total = nightCount(state);
    let sel = { from: Math.min(Math.max(from, 1), total), to: Math.min(Math.max(to, from), total) };
    let picking = false; // true after a first tap: the next tap closes the range
    let picked = h ? { stars: h.stars, lat: h.lat, lon: h.lon, photo: h.photo || null, ref: h.ref || null } : {};
    const cur = curOf(state);
    const cover = nightCoverage(state);

    const chips = () => Array.from({ length: total }, (_, i) => {
      const n = i + 1;
      const d = nightDay(state, n);
      const other = cover[n] && (!h || cover[n].id !== h.id) ? cover[n] : null;
      const cls = [
        'he-night',
        n >= sel.from && n <= sel.to ? 'on' : '',
        n === sel.from ? 'first' : '', n === sel.to ? 'last' : '',
        other ? 'taken' : '',
      ].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-n="${n}" aria-pressed="${n >= sel.from && n <= sel.to}"
        ${other ? `title="כבר יש מלון ללילה הזה: ${esc(other.name)}"` : ''}>
        <small>${d ? d.wd : 'לילה'}</small><b>${d ? d.dm : n}</b>${other ? '<i aria-hidden="true"></i>' : ''}</button>`;
    }).join('');

    const rangeText = () => {
      const k = sel.to - sel.from + 1;
      const ci = tripDay(state, sel.from - 1);
      const co = tripDay(state, sel.to);
      return `<b>${nightsWord(k)}</b>${ci && co ? ` · צ׳ק-אין ${ci.wd} ${ci.dm} · צ׳ק-אאוט ${co.wd} ${co.dm}` : ` · ${rangeWord(sel.from, sel.to)}`}`;
    };

    const html = `
      <div class="he">
        <label class="he-l" for="he-name">שם המקום</label>
        <input type="text" id="he-name" class="hf-name" maxlength="160" autocomplete="off" enterkeyhint="done"
          placeholder="מלון, דירה, אכסניה — מה שסגרתם" value="${esc(h ? h.name : '')}">
        <div class="he-l">אילו לילות? <small>לחיצה על הראשון ואז על האחרון</small></div>
        <div class="he-nights">${chips()}</div>
        <p class="he-range">${rangeText()}</p>
        <div class="he-l">סטטוס</div>
        <div class="seg hf-status">
          <button type="button" data-v="booked" class="${!h || h.status === 'booked' ? 'active' : ''}">✅ הוזמן</button>
          <button type="button" data-v="idea" class="${h && h.status === 'idea' ? 'active' : ''}">💡 רק רעיון</button>
        </div>
        <div class="he-row">
          <div><label class="he-l" for="he-price">מחיר כולל <small>${sym(cur)}, לא חובה</small></label>
            <input type="number" id="he-price" class="hf-price" min="0" step="1" inputmode="numeric" placeholder="לכל הלילות יחד" value="${h && h.price_total ? Math.round(+h.price_total) : ''}"></div>
          <div><label class="he-l" for="he-link">קישור להזמנה <small>לא חובה</small></label>
            <input type="url" id="he-link" class="hf-link" dir="ltr" inputmode="url" placeholder="Booking, Airbnb…" value="${esc(h && h.link ? h.link : '')}"></div>
        </div>
        <div class="form-error hf-err"></div>
        <div class="he-foot">
          <button type="button" class="btn btn-amber hf-save">${h ? 'שמירת השינויים' : 'הוספה לטיול'}</button>
          ${h ? `<button type="button" class="he-del">${HICON.trash}<span>הסרה</span></button>` : ''}
        </div>
      </div>`;

    TripPages.sheet('hotel-stay-sheet', {
      title: h ? 'עריכת מלון' : 'הוספת מלון',
      sub: h ? '' : 'מה שסגרתם, או רעיון שעוד מתלבטים עליו',
      cls: 'stay-card',
      html,
      onOpen: (box) => {
        const nameInput = box.querySelector('.hf-name');
        const nightsEl = box.querySelector('.he-nights');
        const paint = () => {
          nightsEl.innerHTML = chips();
          box.querySelector('.he-range').innerHTML = rangeText();
        };
        nightsEl.addEventListener('click', (e) => {
          const b = e.target.closest('[data-n]');
          if (!b) return;
          const n = +b.dataset.n;
          if (picking && n >= sel.from) { sel.to = n; picking = false; } else { sel = { from: n, to: n }; picking = true; }
          paint();
        });
        attachHotelSuggest(nameInput, () => {
          const block = blockOfNight(state, sel.from);
          return destCoords(state, block && block.name);
        }, (hp) => {
          picked = {
            stars: hp.stars ? +hp.stars : null, lat: hp.lat, lon: hp.lon,
            photo: hp.photo || hp.thumb || null, ref: hp.id || null,
          };
        });
        nameInput.addEventListener('input', () => { picked = {}; });

        box.querySelectorAll('.hf-status button').forEach((b) => {
          b.onclick = () => {
            box.querySelectorAll('.hf-status button').forEach((x) => x.classList.remove('active'));
            b.classList.add('active');
          };
        });

        const err = box.querySelector('.hf-err');
        const done = () => TripPages.closeSheet(() => { hotelsRender?.(); ctx.refresh(); });

        box.querySelector('.he-del')?.addEventListener('click', async () => {
          if (!confirm('להסיר את המלון מהטיול? (ההזמנה האמיתית לא תתבטל 😉)')) return;
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          try {
            await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels/${h.id}`, { method: 'DELETE', headers });
            state.hotels = state.hotels.filter((x) => x.id !== h.id);
            ctx.state.hotels = state.hotels;
            done();
          } catch (e) { err.textContent = e.message; }
        });

        box.querySelector('.hf-save').onclick = async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled) return;
          const name = nameInput.value.trim();
          if (!name) { err.textContent = 'איך קוראים למקום?'; nameInput.focus(); return; }
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          btn.disabled = true;
          const payload = {
            name, night_start: sel.from, night_end: sel.to,
            status: box.querySelector('.hf-status button.active').dataset.v,
            price_total: box.querySelector('.hf-price').value || null,
            link: box.querySelector('.hf-link').value.trim() || null,
            // the notes field is gone from the form; carry any existing note
            // through an edit rather than silently deleting what someone wrote
            note: (h && h.note) || null,
            stars: picked.stars ?? null, lat: picked.lat ?? null, lon: picked.lon ?? null,
            photo: picked.photo ?? null, ref: picked.ref ?? null,
          };
          try {
            if (h) {
              const updated = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels/${h.id}`, {
                method: 'PUT', headers, body: JSON.stringify(payload),
              });
              Object.assign(h, updated);
            } else {
              const created = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels`, {
                method: 'POST', headers, body: JSON.stringify(payload),
              });
              state.hotels.push(created);
              state.hotels.sort((a, b) => a.night_start - b.night_start || a.id - b.id);
            }
            TRIPMAKER.track(h ? 'hotel_edit' : 'hotel_add', { trip_id: state.trip.id, status: payload.status, from_suggest: !!payload.ref });
            done();
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        };
      },
    });
  }

  // OSM / provider hotel suggestions near the chosen destination — free text stays first-class
  function attachHotelSuggest(input, getCoords, onPick) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'autocomplete-wrap';
    input.parentNode.insertBefore(wrapEl, input);
    wrapEl.appendChild(input);
    const list = document.createElement('div');
    list.className = 'autocomplete-list glass';
    wrapEl.appendChild(list);
    let cache = null;
    let cacheKey = '';
    const show = async () => {
      const coords = getCoords();
      if (!coords) return;
      const key = `${coords.lat},${coords.lon}`;
      if (!cache || cacheKey !== key) {
        cacheKey = key;
        cache = await GEO.hotelsNear(coords.lat, coords.lon).catch(() => []);
      }
      const q = input.value.trim();
      const matches = cache.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
      if (!matches.length || document.activeElement !== input) { list.classList.remove('open'); return; }
      list.innerHTML = matches.map((m, i) => {
        const img = m.thumb || m.photo;
        return `
        <button type="button" class="autocomplete-item" data-i="${i}">
          <span class="ac-icon">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith('🏨')">` : '🏨'}</span>
          <span class="ac-name">${esc(m.name)}</span>
          ${m.stars ? `<span class="ac-meta">${'★'.repeat(Math.min(+m.stars || 0, 5))}</span>` : ''}
        </button>`;
      }).join('');
      list.classList.add('open');
      list.querySelectorAll('.autocomplete-item').forEach((b) => {
        b.onclick = () => {
          const m = matches[+b.dataset.i];
          input.value = m.name;
          onPick(m);
          list.classList.remove('open');
        };
      });
    };
    input.addEventListener('focus', show);
    input.addEventListener('input', show);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.classList.remove('open'); });
    document.addEventListener('click', (e) => { if (!wrapEl.contains(e.target)) list.classList.remove('open'); });
  }

  // =================================================================
  //  NIGHT CARDS — the lodging surface inside the itinerary
  //
  //  A night nobody has solved renders between the day it follows and the
  //  next one, so it reads as an unfinished plan rather than a feature you
  //  have to go find. Suggestions are anchored on where the day actually
  //  ended — the one ranking no booking site can compute, because only we
  //  know the itinerary. Booking itself still happens on Booking.com:
  //  nothing here quotes a price or takes a payment.
  // =================================================================

  const NC_ICON = {
    moon: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
    bed: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-5h18v5"/><path d="M3 13V6"/><path d="M7 13v-3h4v3"/></svg>',
    photo: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/></svg>',
    save: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    search: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    chevron: '<svg class="ic nc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  };

  // Every night starts collapsed — thirteen open hotel rails on a two-week trip
  // bury the itinerary they sit between. A night someone opened stays open on the
  // next visit, so a hotel still being chosen doesn't have to be dug out again.
  // Per trip, per night, in localStorage; the set stored is the OPEN nights.
  const openKey = (state) => 'tripmaker_nights_open_' + state.trip.share_code;

  function openNights(state) {
    try { return new Set(JSON.parse(localStorage.getItem(openKey(state)) || '[]')); } catch { return new Set(); }
  }

  const isNightCollapsed = (state, night) => !openNights(state).has(night);

  function setNightCollapsed(state, night, on) {
    const s = openNights(state);
    if (on) s.delete(night); else s.add(night);
    try { localStorage.setItem(openKey(state), JSON.stringify([...s])); } catch { /* private mode — the toggle still works for this visit */ }
  }

  const dm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');

  // Where "להזמנה" goes. Booking.com search could not reliably find the hotel it
  // was named after; Google's hotel search resolves a property by name and lists
  // who sells it, so the traveler lands on their own choice of seller.
  const hotelSearchUrl = (name) =>
    'https://www.google.com/travel/hotels?q=' + encodeURIComponent(String(name || '').trim());

  // Where the night is really anchored: the last stop of that day carrying
  // coordinates. Only if the day has none do we fall back to the destination's
  // own centre, which is what a booking site would have guessed anyway.
  function nightAnchor(state, night) {
    const block = blockOfNight(state, night);
    const area = (block && block.name) || state.trip.destination || '';
    const stops = (state.items || [])
      .filter((it) => it.day_number === night && it.lat != null && it.lon != null);
    const last = stops[stops.length - 1];
    if (last) return { lat: +last.lat, lon: +last.lon, after: last.title, area };
    const d = destCoords(state, area);
    return d ? { lat: +d.lat, lon: +d.lon, after: null, area: d.name || area } : null;
  }

  // Where the day ends: one line in the hotel's own colour, under the day's last stop —
  // the hotel itself lives on the hotels page, and this is its overnight point in the
  // itinerary (the map draws the same point, trip-map.js). A tap opens its card there.
  // An idea (saved, not booked yet — what the AI adds) shows the same way, dashed.
  function bookedNightHtml(state, night, hotel) {
    const idea = hotel.status === 'idea';
    const color = idea ? 'var(--paper-dim)' : hotelColor(state, hotel);
    const dates = nightDates(state, { night_start: night, night_end: night });
    const meta = [
      `לילה ${night}`,
      dates ? `${dm(dates.checkin)} ← ${dm(dates.checkout)}` : null,
      // the stay's price once, on its first night — not the total again under every night
      hotel.price_total && state.canEdit && !idea && night === hotel.night_start ? fmt(hotel.price_total, curOf(state)) : null,
    ].filter(Boolean).join(' · ');
    const tap = state.canEdit;
    return `
      <div class="night-booked${idea ? ' is-idea' : ''}${tap ? ' is-tap' : ''}" style="border-inline-start-color:${color}"
        ${tap ? `data-hotel-card="${night}" role="button" tabindex="0" aria-label="לינה בלילה ${night}: ${esc(hotel.name)} — פתיחת כרטיס המלון"` : ''}>
        <span class="nb-ic" style="color:${color}">${hotel.photo
          ? `<img src="${esc(hotel.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${NC_ICON.bed}</span>
        <div class="nb-text">
          <div class="nb-name"><span class="nb-kind">לינה</span>${esc(hotel.name)}${idea ? '<span class="nb-idea">רעיון</span>' : ''}</div>
          <div class="nb-meta">${meta}</div>
        </div>
        ${tap ? '<span class="nb-chev" aria-hidden="true">‹</span>' : ''}
      </div>`;
  }

  // The rail starts as placeholders; mountNightCards fills it when the card
  // comes near the viewport, so a 14-night trip doesn't fire 13 lookups on load.
  // `suggest: false` keeps a booked night's strip but drops the hotel rail — under a
  // free day the itinerary shows the AI's picks for the day instead (trip-dayrecs.js)
  function nightCardHtml(state, night, { suggest = true } = {}) {
    if (night < 1 || night > nightCount(state)) return '';
    const booked = nightHotel(state, night);
    if (booked) return bookedNightHtml(state, night, booked);
    if (!suggest) return '';

    const anchor = nightAnchor(state, night);
    const hint = anchor && anchor.after
      ? `היום מסתיים ב${esc(anchor.after)} — אלה המלונות הקרובים ביותר`
      : `מלונות ב${esc((anchor && anchor.area) || state.trip.destination || '')}`;

    const shut = isNightCollapsed(state, night);
    return `
      <div class="night-card${shut ? ' collapsed' : ''}" data-night="${night}">
        <button type="button" class="nc-head" data-toggle-night="${night}" aria-expanded="${!shut}">
          ${NC_ICON.moon}
          <span class="nc-title">לילה ${night} — איפה ישנים?</span>
          ${anchor && anchor.area ? `<span class="nc-where">${esc(anchor.area)}</span>` : ''}
          ${NC_ICON.chevron}
        </button>
        <div class="nc-hint">${hint}</div>
        ${anchor ? `<div class="nc-rail">${'<div class="nc-skel"></div>'.repeat(3)}</div>` : ''}
        ${state.canEdit ? `<div class="nc-foot">
          <button type="button" data-open-night="${night}">${NC_ICON.check} כבר הזמנתי</button>
        </div>` : ''}
      </div>`;
  }

  // Photos first when there are enough of them — a rail of grey boxes reads as
  // broken — but never at the cost of the distance ordering the server applied.
  function pickForRail(hotels) {
    const withPhoto = hotels.filter((h) => h.thumb || h.photo);
    return (withPhoto.length >= 3 ? withPhoto : hotels).slice(0, 6);
  }

  // already on the trip's hotel list for this night? The rail then shows a tick
  // instead of a save button — a second tap (or a tap after a repaint) must not
  // add the same hotel twice.
  function alreadySaved(state, night, name) {
    const key = String(name || '').trim().toLowerCase();
    return (state.hotels || []).some((x) =>
      x.night_start <= night && night <= x.night_end &&
      String(x.name || '').trim().toLowerCase() === key);
  }

  function railHtml(state, night, hotels) {
    return hotels.map((h, i) => {
      const img = h.thumb || h.photo;
      const score = h.rating != null
        ? `${h.rating}${h.reviewCount ? ` <span>· ${h.reviewCount.toLocaleString('he-IL')} ביקורות</span>` : ''}`
        : (h.stars ? '★'.repeat(Math.min(+h.stars, 5)) : '');
      const dist = h.distance != null
        ? (h.distance < 1000 ? `${h.distance} מ' מסוף היום` : `${(h.distance / 1000).toFixed(1)} ק"מ מסוף היום`)
        : '';
      return `
        <div class="nc-hotel" data-i="${i}" data-detail="${esc(h.id || '')}"
             role="button" tabindex="0" title="לחיצה לפרטי המלון">
          <div class="nc-photo">
            ${NC_ICON.photo}
            ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
          </div>
          <div class="nc-body">
            <div class="nc-name" title="${esc(h.name)}">${esc(h.name)}</div>
            ${score ? `<div class="nc-score">${score}</div>` : ''}
            ${dist ? `<div class="nc-dist">${dist}</div>` : ''}
            <div class="nc-price" data-price-for="${esc(h.id || '')}"></div>
            <div class="nc-actions">
              <a class="nc-cta" target="_blank" rel="noopener" data-book-i="${i}"
                 href="${esc(hotelSearchUrl(h.name))}"
                 title="נפתח בגוגל, בחלון חדש">להזמנה</a>
              ${state.canEdit ? (alreadySaved(state, night, h.name)
                ? `<button type="button" class="nc-save saved" disabled
                     aria-label="${esc(h.name)} כבר ברשימת המלונות"
                     title="כבר ברשימת המלונות">${NC_ICON.check}</button>`
                : `<button type="button" class="nc-save" data-save-i="${i}"
                     aria-label="שמירת ${esc(h.name)} כרעיון ללילה ${night}"
                     title="שמירה כרעיון">${NC_ICON.save}</button>`) : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // Prices arrive in a second pass: the rate lookup takes 5-7s against LiteAPI
  // while content is instant, so tiles paint immediately and gain a price line
  // when it lands. A card that can't be priced simply never grows one.
  async function loadPrices(state, night, picked, rail) {
    const dates = nightDates(state, { night_start: night, night_end: night });
    if (!dates) { // no trip dates yet — say why rather than showing nothing
      rail.querySelectorAll('.nc-price').forEach((el) => {
        el.className = 'nc-price muted';
        el.textContent = 'הוסיפו תאריכים למחירים';
      });
      return;
    }
    const ids = picked.map((h) => h.id).filter(Boolean);
    if (!ids.length) return;

    rail.querySelectorAll('.nc-price').forEach((el) => { el.className = 'nc-price loading'; el.textContent = '···'; });

    let prices = {};
    try {
      prices = await GEO.hotelPrices(ids, {
        checkin: dates.checkin, checkout: dates.checkout,
        adults: (state.budget && state.budget.travelers) || 2,
        currency: curOf(state),
      });
    } catch { /* leave the tiles priceless rather than wrong */ }

    let priced = 0;
    for (const h of picked) {
      const el = rail.querySelector(`.nc-price[data-price-for="${CSS.escape(h.id || '')}"]`);
      if (!el) continue;
      const p = prices[h.id];
      if (p && Number.isFinite(p.amount)) {
        priced++;
        // the card covers exactly one night, so the range total IS the nightly price
        el.className = 'nc-price';
        el.innerHTML = `<span class="ncp-from">החל מ־</span>${esc(fmt(p.amount, p.currency || curOf(state)))}<span class="ncp-per"> ללילה</span>`;
      } else {
        el.className = 'nc-price muted';
        el.textContent = 'אין מחיר לתאריך הזה';
      }
    }
    TRIPMAKER.track('night_card_prices', { trip_id: state.trip.id, night, asked: ids.length, priced });
  }

  // LiteAPI scores a fixed set of categories, in English. Guest pros/cons stay
  // in whatever language they were written — those are quotes, not labels.
  const HS_CATEGORY = {
    'cleanliness': 'ניקיון', 'service': 'שירות', 'location': 'מיקום',
    'room quality': 'איכות החדר', 'amenities': 'שירותים במלון', 'facilities': 'מתקנים',
    'value for money': 'תמורה למחיר', 'comfort': 'נוחות', 'staff': 'צוות',
    'food': 'אוכל', 'breakfast': 'ארוחת בוקר', 'wifi': 'אינטרנט', 'value': 'תמורה למחיר',
  };
  const catName = (n) => HS_CATEGORY[String(n || '').trim().toLowerCase()] || n;

  // "03:00 PM" → "15:00"; anything already 24h or unparseable passes through
  function hhmm(t) {
    const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return t;
    let h = +m[1] % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }

  // Everything worth knowing before picking a bed: the gallery, what guests
  // consistently praise and complain about, the facilities, and the times.
  function openHotelSheet(ctx, night, hotel) {
    const { state } = ctx;
    const hero = hotel.photo || hotel.thumb;
    const scoreLine = hotel.rating != null
      ? `<span class="hs-score">${hotel.rating}</span>${hotel.reviewCount ? `<span class="hs-reviews">${hotel.reviewCount.toLocaleString('he-IL')} ביקורות</span>` : ''}`
      : '';
    const html = `
      <div class="hd">
        <div class="hd-gallery">${hero ? `<img src="${esc(hero)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="hd-noimg">${NC_ICON.photo}</span>`}</div>
        <div class="hs-top">
          ${hotel.stars ? `<span class="hotel-stars">${'★'.repeat(Math.min(+hotel.stars, 5))}</span>` : ''}
          ${scoreLine}
          ${hotel.distance != null ? `<span class="hs-dist">${hotel.distance < 1000 ? `${hotel.distance} מ'` : `${(hotel.distance / 1000).toFixed(1)} ק"מ`} מסוף היום</span>` : ''}
        </div>
        <div class="hs-loading">טוען פרטים…</div>
        <div class="hd-foot">
          <a class="btn btn-amber hs-book" target="_blank" rel="noopener"
             href="${esc(hotelSearchUrl(hotel.name))}" title="נפתח בגוגל, בחלון חדש">מחירים והזמנה ${TRIPMAKER.externalIcon}</a>
        </div>
      </div>`;

    TripPages.sheet('hotel-detail-sheet', {
      title: esc(hotel.name),
      sub: hotel.address ? esc(hotel.address) : `לילה ${night}`,
      cls: 'hotel-detail-card',
      html,
      onOpen: (body, wrap) => {
        body.querySelector('.hs-book')?.addEventListener('click', () => TRIPMAKER.track('hotel_book_click', {
          trip_id: state.trip.id, night, provider: hotel.provider || null, from: 'hotel_sheet',
        }));
        GEO.hotelDetail(hotel.id).then((d) => {
          if (!wrap.classList.contains('open') || !body.contains(body.querySelector('.hs-loading'))) return; // closed while we waited
          // the gallery swipes sideways, the way every booking app shows a room
          const gallery = [...new Set([hero, ...(d.images || [])].filter(Boolean))].slice(0, 8);
          if (gallery.length > 1) {
            body.querySelector('.hd-gallery').innerHTML = gallery.map((u) =>
              `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`).join('');
            body.querySelector('.hd-gallery').insertAdjacentHTML('afterend',
              `<div class="hd-count">${gallery.length} תמונות · החליקו הצידה</div>`);
          }
          const cat = (d.categories || []).map((c) =>
            `<div class="hs-cat"><span>${esc(catName(c.name))}</span><b>${c.rating.toFixed(1)}</b><i style="--w:${Math.min(Math.max(c.rating * 10, 0), 100)}%"></i></div>`).join('');
          body.querySelector('.hs-loading').outerHTML = `
            ${cat ? `<div class="hs-cats">${cat}</div>` : ''}
            ${(d.pros || []).length ? `<div class="hs-sec"><h3>מה אהבו</h3><ul class="hs-pros">${
              d.pros.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
            ${(d.cons || []).length ? `<div class="hs-sec"><h3>מה פחות</h3><ul class="hs-cons">${
              d.cons.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
            ${(d.facilities || []).length ? `<div class="hs-sec"><h3>בבית המלון</h3><div class="hs-fac">${
              d.facilities.map((f) => `<span>${esc(f)}</span>`).join('')}</div></div>` : ''}
            ${d.checkin || d.checkout ? `<div class="hs-times">${
              d.checkin ? `צ'ק-אין מ־${esc(hhmm(d.checkin))}` : ''}${d.checkin && d.checkout ? ' · ' : ''}${
              d.checkout ? `צ'ק-אאוט עד ${esc(hhmm(d.checkout))}` : ''}</div>` : ''}`;
        }).catch(() => {
          const l = body.querySelector('.hs-loading');
          if (l) l.textContent = 'לא הצלחנו לטעון פרטים נוספים';
        });
      },
    });

    TRIPMAKER.track('hotel_sheet_open', { trip_id: state.trip.id, night, provider: hotel.provider || null });
  }

  // A rail of suggestions just painted (a night card in the itinerary, or an open
  // night on the hotels page): booking clicks are counted, the tile opens its sheet,
  // and the bookmark turns a suggestion into an idea on the trip's hotel list.
  function wireRail(ctx, night, picked, rail, { from, onSaved } = {}) {
    const { state } = ctx;
    loadPrices(state, night, picked, rail);

    rail.querySelectorAll('[data-book-i]').forEach((a) => {
      a.addEventListener('click', () => TRIPMAKER.track('hotel_book_click', {
        trip_id: state.trip.id, night, rank: +a.dataset.bookI + 1,
        provider: picked[+a.dataset.bookI].provider || null, from,
      }));
    });

    // the tile itself opens the sheet; the controls inside it must not
    const openSheet = (tile) => {
      const h = picked[+tile.dataset.i];
      if (h) openHotelSheet(ctx, night, h);
    };
    rail.querySelectorAll('.nc-hotel[data-detail]').forEach((tile) => {
      tile.addEventListener('click', (e) => { if (!e.target.closest('.nc-save, a')) openSheet(tile); });
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(tile); }
      });
    });

    // one tap turns a suggestion into an idea on the real hotel list — no
    // retyping a name we already have; coordinates, stars and the photo come along
    rail.querySelectorAll('[data-save-i]').forEach((b) => {
      b.onclick = async () => {
        const h = picked[+b.dataset.saveI];
        if (b.disabled) return;
        b.disabled = true;
        // re-checked here too: the list can gain this hotel between paint and
        // tap (the page, another device, a slow first tap)
        if (alreadySaved(state, night, h.name)) {
          b.classList.add('saved');
          b.innerHTML = NC_ICON.check;
          b.title = 'כבר ברשימת המלונות';
          return;
        }
        const headers = await ctx.ensureEdit();
        if (!headers) { b.disabled = false; return; }
        try {
          const created = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels`, {
            method: 'POST', headers,
            body: JSON.stringify({
              name: h.name, night_start: night, night_end: night, status: 'idea',
              stars: h.stars || null, lat: h.lat ?? null, lon: h.lon ?? null,
              photo: h.photo || h.thumb || null, ref: h.id || null,
            }),
          });
          state.hotels.push(created);
          state.hotels.sort((a, c) => a.night_start - c.night_start || a.id - c.id);
          b.classList.add('saved');
          b.innerHTML = NC_ICON.check;
          b.title = 'נשמר ברשימת המלונות';
          TRIPMAKER.track('night_card_save_idea', { trip_id: state.trip.id, night, from });
          onSaved?.(created);
        } catch (e) {
          b.disabled = false;
          alert(e.message);
        }
      };
    });
  }

  // Wires every night card the itinerary just painted. Safe to call after each
  // re-render: cards are matched by night and each fills itself once.
  function mountNightCards(ctx, container) {
    const { state } = ctx;

    container.querySelectorAll('[data-open-night]').forEach((b) => {
      b.onclick = () => openHotels(ctx, { addNight: +b.dataset.openNight });
    });
    container.querySelectorAll('[data-hotel-card]').forEach((el) => {
      const go = () => {
        TRIPMAKER.track('overnight_open', { trip_id: state.trip.id, night: +el.dataset.hotelCard, from: 'itinerary' });
        openHotels(ctx, { focusNight: +el.dataset.hotelCard });
      };
      el.onclick = go;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });

    container.querySelectorAll('[data-toggle-night]').forEach((b) => {
      b.onclick = () => {
        const card = b.closest('.night-card');
        const night = +b.dataset.toggleNight;
        const shut = card.classList.toggle('collapsed');
        b.setAttribute('aria-expanded', String(!shut));
        setNightCollapsed(state, night, shut);
        if (!shut) fill(card); // opened for the first time — go get the hotels
        TRIPMAKER.track('night_card_toggle', { trip_id: state.trip.id, night, collapsed: shut });
      };
    });
    const fill = async (el) => {
      // a collapsed night costs nothing: no lookup, and no "loaded" mark either,
      // so opening it later still fetches
      if (el.classList.contains('collapsed') || el.dataset.loaded) return;
      el.dataset.loaded = '1';
      const night = +el.dataset.night;
      const rail = el.querySelector('.nc-rail');
      const anchor = nightAnchor(state, night);
      if (!rail || !anchor) return;

      let hotels = [];
      try {
        hotels = await GEO.hotelsNear(anchor.lat, anchor.lon, {
          country: state.trip.country || null, limit: 12, radius: 4000,
        });
      } catch { /* upstream trouble — the card still offers "כבר הזמנתי" */ }

      const picked = pickForRail(hotels || []);
      if (!picked.length) {
        rail.remove();
        el.querySelector('.nc-hint').insertAdjacentHTML('afterend',
          '<div class="nc-empty">לא מצאנו מלונות בקרבת מקום ללילה הזה</div>');
        return;
      }
      rail.innerHTML = railHtml(state, night, picked);
      TRIPMAKER.track('night_card_shown', {
        trip_id: state.trip.id, night, count: picked.length,
        provider: picked[0].provider || null, with_photo: picked.filter((h) => h.thumb || h.photo).length,
      });

      // deliberately no ctx.refresh() on save: an idea changes nothing the itinerary
      // draws, and a repaint here would wipe the tick the user just earned
      wireRail(ctx, night, picked, rail, { from: 'night_card' });
    };

    const cards = [...container.querySelectorAll('.night-card[data-night]')];
    if (!cards.length) return;
    if (!('IntersectionObserver' in window)) { cards.forEach(fill); return; }
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        fill(e.target);
      }
    }, { rootMargin: '300px 0px' });
    cards.forEach((c) => io.observe(c));
  }

  // =================================================================
  //  BUDGET PAGE
  //  A full page over the trip, laid out like the other dock pages (המלצות /
  //  מסמכים): the same head, the dock underneath on phones with the תקציב tab
  //  lit. It rides the URL hash (#budget / #budget-settings) so the browser
  //  and phone back buttons walk out of it naturally — and settings is a
  //  sub-page, not an inline div.
  // =================================================================


  const budgetView = { showSettings: false };
  let budgetRender = null; // the open page's render(), so popstate can repaint it

  // stroke icons for the page — inherit currentColor like every .ic
  const BICON = {
    back: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    wallet: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>',
  };

  const isBudgetHash = () => location.hash === '#budget' || location.hash === '#budget-settings';

  // one switch owns every "is the page open" side effect: the page itself, the body
  // scroll lock, and the dock's תקציב tab lighting up the way any other tab does.
  // Opening also dismisses whichever dock page was showing — the budget takes its place.
  function setBudgetOpen(open) {
    const apply = () => {
      const page = document.getElementById('budget-page');
      if (page) page.hidden = !open;
      document.body.classList.toggle('budget-open', open);
      if (typeof TripPages !== 'undefined') {
        // the dock lights one tab: ours while we're open (the itinerary's goes dark), and
        // whatever page is left — usually the itinerary — once we close
        if (open) { TripPages.dismiss(); TripPages.activate('budget'); }
        else TripPages.activate(TripPages.current());
      }
      const tab = document.getElementById('budget-btn');
      if (tab) {
        tab.classList.toggle('is-active', open);
        if (open) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
      }
    };
    if (typeof TripPages === 'undefined') { apply(); return; }
    // the budget is a dock tab like the others, and slides in from its neighbour the same way
    const was = document.body.classList.contains('budget-open');
    const page = TripPages.current() || '';
    TripPages.move(was ? 'budget' : page, open ? 'budget' : page, apply);
  }
  // trip-pages.js calls this when a dock tab takes over the screen from the budget
  const closeBudget = () => setBudgetOpen(false);

  window.addEventListener('popstate', () => {
    const page = document.getElementById('budget-page');
    if (!page || !budgetRender) return;
    if (isBudgetHash()) {
      budgetView.showSettings = location.hash === '#budget-settings';
      setBudgetOpen(true);
      budgetRender();
    } else {
      setBudgetOpen(false);
    }
  });

  const personalKey = (state) => 'tripmaker_personal_budget_' + state.trip.share_code;
  const emptyPersonal = () => ({ total: null, expenses: [], planned: [], paid: {} });
  function loadPersonal(state) {
    try {
      const p = JSON.parse(localStorage.getItem(personalKey(state)) || 'null');
      if (!p || typeof p !== 'object') return emptyPersonal();
      return {
        total: +p.total || null,
        expenses: Array.isArray(p.expenses) ? p.expenses : [],
        planned: Array.isArray(p.planned) ? p.planned : [],
        paid: p.paid && typeof p.paid === 'object' && !Array.isArray(p.paid) ? p.paid : {},
      };
    } catch { return emptyPersonal(); }
  }
  function savePersonal(state, p) {
    try { localStorage.setItem(personalKey(state), JSON.stringify(p)); return true; }
    catch { return false; }
  }

  // a stop's estimate is either on the shared itinerary (item.cost, participants
  // only) or in this browser's personal plan. The two never share a number —
  // personal stays off the server so the rest of the group doesn't see it.
  function itemCostInfo(state, it) {
    if (!it) return null;
    const mine = loadPersonal(state).planned.find((p) => p.item_id === it.id);
    if (mine && +mine.amount > 0) return { amount: +mine.amount, scope: 'personal' };
    if (+it.cost > 0) return { amount: +it.cost, scope: 'shared' };
    return null;
  }
  function setItemPersonalCost(state, item, amount) {
    const personal = loadPersonal(state);
    personal.planned = personal.planned.filter((p) => p.item_id !== item.id);
    if (+amount > 0) {
      personal.planned.push({
        item_id: item.id,
        title: item.title,
        amount: +amount,
        category: budgetCatOf(item.category),
        day_number: item.day_number,
      });
    }
    return savePersonal(state, personal);
  }
  function clearItemPersonalCost(state, itemId) {
    const personal = loadPersonal(state);
    const hadPlan = personal.planned.some((p) => p.item_id === itemId);
    const hadPaid = !!(personal.paid && personal.paid[itemId]);
    if (!hadPlan && !hadPaid) return true;
    personal.planned = personal.planned.filter((p) => p.item_id !== itemId);
    if (personal.paid) delete personal.paid[itemId];
    return savePersonal(state, personal);
  }
  function currentTripDay(state) {
    if (!state.trip.start_date) return null;
    const diff = Math.floor((Date.now() - new Date(state.trip.start_date).getTime()) / 86400000) + 1;
    return diff >= 1 && diff <= state.trip.days ? diff : null;
  }

  const currencyOptions = (selected) => Object.keys(CURRENCIES)
    .map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${CURRENCIES[c]} ${c}</option>`).join('');

  // =================================================================
  //  WHO OWES WHOM — the money math
  //  Splitwise's model, nearly to the letter: an expense is an amount, who paid
  //  it, and who it is split between (equally). A payment (paid_to set) is one
  //  person handing another money back. Everyone's balance is what they paid
  //  minus their shares, plus payments sent, minus payments received; the
  //  transfers are the fewest that bring every balance to zero (biggest debtor
  //  pays biggest creditor, repeat). The budget is a side note: the total of the
  //  expenses against a number, when somebody set one.
  // =================================================================

  const keyOf = (name) => String(name || '').trim().toLowerCase();
  const isPayment = (e) => !!String(e.paid_to || '').trim();
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '?';
  const initialsOf = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') || '?';
  // cents show only where a split leaves them: ₪150, but $33.33
  function money(n, cur) {
    const v = Math.round((+n || 0) * 100) / 100;
    const whole = Math.abs(v - Math.round(v)) < 0.005;
    return `${sym(cur)}${v.toLocaleString('he-IL', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // the trip's people: the participants first (owner on top), then anyone a row names
  // who has since left the trip or whose name drifted — their money still counts
  function moneyPeople(state) {
    const byKey = new Map();
    const add = (name) => { const n = String(name || '').trim(); if (n && !byKey.has(keyOf(n))) byKey.set(keyOf(n), n); };
    for (const p of state.participants || []) add(p.name);
    for (const e of state.expenses || []) {
      add(e.paid_by); add(e.paid_to);
      if (Array.isArray(e.split_among)) e.split_among.forEach(add);
    }
    return [...byKey.values()];
  }
  const participantNames = (state) => (state.participants || []).map((p) => String(p.name || '').trim()).filter(Boolean);

  // who an expense is split between: its own list, or (old rows) everyone on the trip now
  function splitOf(state, e) {
    const list = Array.isArray(e.split_among) ? e.split_among.map((n) => String(n || '').trim()).filter(Boolean) : [];
    return list.length ? list : participantNames(state);
  }

  // the signed-in traveller, by the name the participants list knows them by
  function meName(state) {
    const u = TRIPMAKER.user;
    if (!u) return null;
    const p = (state.participants || []).find((x) => +x.id === +u.id);
    return String((p && p.name) || u.name || '').trim() || null;
  }

  function computeMoney(state) {
    const people = moneyPeople(state);
    const net = new Map(people.map((p) => [keyOf(p), 0]));
    const paid = new Map(people.map((p) => [keyOf(p), 0]));
    const owedShare = new Map(people.map((p) => [keyOf(p), 0]));
    const bump = (m, name, d) => m.set(keyOf(name), (m.get(keyOf(name)) || 0) + d);
    const rows = (state.expenses || []).filter((e) => +e.amount > 0 && String(e.paid_by || '').trim());
    let spent = 0;
    let count = 0;
    for (const e of rows) {
      const a = +e.amount;
      if (isPayment(e)) { bump(net, e.paid_by, a); bump(net, e.paid_to, -a); continue; }
      const among = splitOf(state, e);
      if (!among.length) continue;
      spent += a; count += 1;
      bump(net, e.paid_by, a); bump(paid, e.paid_by, a);
      for (const m of among) { bump(net, m, -a / among.length); bump(owedShare, m, a / among.length); }
    }
    // the old "שולם" marks (one debtor paid back their share of one expense) still count
    const byId = new Map(rows.map((e) => [+e.id, e]));
    for (const s of state.settlements || []) {
      const e = byId.get(+s.expense_id);
      if (!e || isPayment(e)) continue;
      const among = splitOf(state, e);
      const debtor = s.debtor_name || s.debtor_key;
      if (!among.length || keyOf(debtor) === keyOf(e.paid_by) || !among.some((m) => keyOf(m) === keyOf(debtor))) continue;
      bump(net, debtor, +e.amount / among.length);
      bump(net, e.paid_by, -(+e.amount / among.length));
    }

    const nameOf = (k) => people.find((p) => keyOf(p) === k) || k;
    const balances = [...net.entries()].map(([k, v]) => ({
      name: nameOf(k), net: Math.round(v * 100) / 100, paid: paid.get(k) || 0, share: owedShare.get(k) || 0,
    }));
    const debtors = balances.filter((b) => b.net < -0.009).map((b) => ({ name: b.name, amt: -b.net })).sort((a, b) => b.amt - a.amt);
    const creditors = balances.filter((b) => b.net > 0.009).map((b) => ({ name: b.name, amt: b.net })).sort((a, b) => b.amt - a.amt);
    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].amt, creditors[j].amt);
      if (pay >= 0.01) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: Math.round(pay * 100) / 100 });
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt < 0.01) i += 1;
      if (creditors[j].amt < 0.01) j += 1;
    }
    return { people, balances, transfers, spent, count };
  }

  // =================================================================
  //  THE MONEY PAGE (#budget) — "מי חייב למי"
  //  A full page like the other dock pages. Top: what you owe or are owed, then the
  //  transfers that settle everything (one tap records one as done). Below: the
  //  expenses, newest first; tapping one edits it. "הוספת הוצאה" is a sheet with
  //  three things — how much, who paid, what for — and who it is split between,
  //  everyone by default. The budget is optional and lives behind the gear.
  // =================================================================

  function openBudget(ctx, opts = {}) {
    const { state } = ctx;
    if (!state.canEdit) return;
    let page = document.getElementById('budget-page');
    if (!page) {
      page = document.createElement('section');
      page.id = 'budget-page';
      page.className = 'trip-page budget-page';
      page.hidden = true;
      page.setAttribute('aria-label', 'הוצאות');
      page.innerHTML = `
        <div class="tp-head">
          <button type="button" class="bp-back tp-back" aria-label="חזרה">${BICON.back}<span>חזרה</span></button>
          <div class="tp-titles">
            <h2 class="tp-title bp-title"></h2>
            <p class="tp-sub bp-sub"></p>
          </div>
          <div class="tp-tools">
            <button type="button" class="btn btn-ghost bp-settings-btn" title="תקציב ומטבע" aria-label="תקציב ומטבע">${BICON.gear}<span>תקציב</span></button>
          </div>
        </div>
        <div class="tp-body">
          <div class="tp-inner bp-inner">
            <div class="bp-body"></div>
          </div>
        </div>
        <button type="button" class="btn btn-amber mx-fab">${BICON.plus}<span>הוספת הוצאה</span></button>`;
      document.body.appendChild(page);
      page.querySelector('.tp-back').onclick = () => history.back();
    }
    const body = page.querySelector('.bp-body');
    const scroller = page.querySelector('.tp-body');
    budgetRender = render;

    budgetView.showSettings = false;
    // opened from another dock page: swap that page for this one, the way the tabs swap
    // among themselves — back returns to the itinerary, not to the page left behind
    const swapping = !!(history.state && history.state.tripmakerPage);
    setBudgetOpen(true);
    scroller.scrollTop = 0;
    if (swapping) {
      history.replaceState(null, '', '#budget');
    } else {
      // one clean history entry per open — a reload that kept the hash is normalized first
      if (isBudgetHash()) history.replaceState(null, '', location.pathname + location.search);
      history.pushState(null, '', '#budget');
    }

    page.querySelector('.bp-settings-btn').onclick = () => {
      budgetView.showSettings = true;
      history.pushState(null, '', '#budget-settings');
      render();
      scroller.scrollTop = 0;
    };
    page.querySelector('.mx-fab').onclick = () => openExpenseSheet(ctx, null, render);

    function render() {
      const cur = curOf(state);
      const title = page.querySelector('.bp-title');
      const sub = page.querySelector('.bp-sub');
      const gear = page.querySelector('.bp-settings-btn');
      const fab = page.querySelector('.mx-fab');
      if (budgetView.showSettings) {
        title.textContent = 'תקציב ומטבע';
        sub.textContent = 'לא חובה — אם יש מספר, ההוצאות נבדקות מולו';
        gear.hidden = true;
        fab.hidden = true;
        renderSettings(cur);
        return;
      }
      title.textContent = 'מי חייב למי';
      sub.textContent = 'מי שילם על מה, ומי מעביר כמה למי';
      gear.hidden = false;
      fab.hidden = false;

      const m = computeMoney(state);
      const me = meName(state);
      const meBal = me ? m.balances.find((b) => keyOf(b.name) === keyOf(me)) : null;
      const cap = state.budget ? +state.budget.total || 0 : 0;
      const rows = (state.expenses || []).filter((e) => +e.amount > 0);
      const lonely = participantNames(state).length < 2;

      // ---- you: the one line Splitwise opens with ----
      let meHtml = '';
      if (meBal && m.count) {
        meHtml = meBal.net > 0.009
          ? `<div class="mx-me owed"><small>בסך הכל</small><b>מגיע לך ${money(meBal.net, cur)}</b></div>`
          : meBal.net < -0.009
            ? `<div class="mx-me owes"><small>בסך הכל</small><b>עליך להעביר ${money(-meBal.net, cur)}</b></div>`
            : '<div class="mx-me even"><small>בסך הכל</small><b>אצלך הכל סגור ✓</b></div>';
      }

      // ---- the transfers that settle everything ----
      const ava = (n) => `<span class="mx-ava" aria-hidden="true">${esc(initialsOf(n))}</span>`;
      let settleHtml;
      if (!m.count) {
        settleHtml = `
          <div class="mx-empty glass">
            <div class="mx-empty-ic">${BICON.wallet}</div>
            <h3>עוד אין הוצאות</h3>
            <p>מי ששילם על משהו לכולם מוסיף אותו כאן: סכום, מי שילם, ועל מה. אנחנו כבר נחשב מי מעביר כמה למי.</p>
            ${lonely ? '<p class="mx-hint">כדי לחלק צריך עוד אנשים בטיול — מזמינים אותם מ"חברים".</p>' : ''}
          </div>`;
      } else if (!m.transfers.length) {
        settleHtml = '<div class="mx-even glass"><b>כולם מאוזנים 🎉</b><span>אף אחד לא חייב לאף אחד</span></div>';
      } else {
        settleHtml = `
          <div class="mx-xfers glass">
            ${m.transfers.map((t, ix) => {
              const mine = me && (keyOf(t.from) === keyOf(me) || keyOf(t.to) === keyOf(me));
              return `
              <div class="mx-xfer${mine ? ' mine' : ''}">
                <div class="mx-xfer-who">
                  ${ava(t.from)}
                  <span class="mx-xfer-text"><b>${esc(t.from)}</b><span class="mx-arrow" aria-label="מעביר/ה ל">←</span><b>${esc(t.to)}</b></span>
                </div>
                <span class="mx-xfer-amt">${money(t.amount, cur)}</span>
                <button type="button" class="mx-paid" data-ix="${ix}">הועבר</button>
              </div>`;
            }).join('')}
          </div>
          <p class="mx-foot-note">מינימום העברות — כל אחד מעביר לכל היותר פעם או פעמיים. כשהעברה בוצעה, לוחצים "הועבר".</p>`;
      }

      // ---- the budget, only when somebody set one ----
      let budgetHtml = '';
      if (cap) {
        const pct = Math.round((m.spent / cap) * 100);
        const tone = m.spent > cap ? 'over' : pct >= 80 ? 'warn' : '';
        budgetHtml = `
          <button type="button" class="mx-budget glass ${tone}" data-act="settings">
            <div class="mx-budget-row"><span>הוצאתם <b>${money(m.spent, cur)}</b> מתוך ${money(cap, cur)}</span><span class="mx-budget-pct">${pct}%</span></div>
            <div class="mx-meter"><i style="width:${Math.min(100, pct)}%"></i></div>
            <small>${m.spent > cap ? `חריגה של ${money(m.spent - cap, cur)}` : `נשארו ${money(cap - m.spent, cur)}`}</small>
          </button>`;
      }

      // ---- the expenses, newest first, grouped by the day they were added ----
      const dayKey = (e) => String(e.created_at || '').slice(0, 10);
      const groups = [];
      for (const e of rows) {
        const k = dayKey(e);
        const g = groups[groups.length - 1];
        if (g && g.k === k) g.list.push(e); else groups.push({ k, list: [e] });
      }
      const dayTitle = (k) => {
        if (!k) return '';
        const d = new Date(k + 'T12:00:00');
        if (Number.isNaN(d.getTime())) return '';
        const today = new Date(); today.setHours(12, 0, 0, 0);
        const diff = Math.round((today - d) / 86400000);
        if (diff === 0) return 'היום';
        if (diff === 1) return 'אתמול';
        return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
      };
      const rowHtml = (e) => {
        if (isPayment(e)) {
          return `
            <button type="button" class="mx-row pay" data-id="${e.id}">
              <span class="mx-row-ic" aria-hidden="true">⇄</span>
              <span class="mx-row-text"><b>החזר: ${esc(firstName(e.paid_by))} ← ${esc(firstName(e.paid_to))}</b><small>הכסף עבר ביניהם</small></span>
              <span class="mx-row-amt">${money(e.amount, cur)}</span>
            </button>`;
        }
        const among = splitOf(state, e);
        const everyone = among.length >= participantNames(state).length;
        let mineLine = '';
        if (me) {
          const iPaid = keyOf(e.paid_by) === keyOf(me);
          const inIt = among.some((n) => keyOf(n) === keyOf(me));
          const share = among.length ? +e.amount / among.length : 0;
          if (iPaid) mineLine = `<span class="mx-mine owed">${inIt ? `הלווית ${money(+e.amount - share, cur)}` : `הלווית ${money(e.amount, cur)}`}</span>`;
          else if (inIt) mineLine = `<span class="mx-mine owes">החלק שלך ${money(share, cur)}</span>`;
          else mineLine = '<span class="mx-mine">לא בהוצאה</span>';
        }
        return `
          <button type="button" class="mx-row" data-id="${e.id}">
            <span class="mx-row-ic" aria-hidden="true">${e.category && e.category !== 'אחר' ? (CATS.find((c) => c.key === e.category) || {}).emoji || '🧾' : '🧾'}</span>
            <span class="mx-row-text">
              <b>${esc(e.title || 'הוצאה')}</b>
              <small>שולם ע״י ${esc(firstName(e.paid_by))} · ${everyone ? 'מתחלק בין כולם' : `בין ${among.map(firstName).map(esc).join(', ')}`}</small>
            </span>
            <span class="mx-row-end"><span class="mx-row-amt">${money(e.amount, cur)}</span>${mineLine}</span>
          </button>`;
      };
      const listHtml = rows.length ? `
        <div class="mx-sec-head"><h3>הוצאות</h3><span>${m.count} · ${money(m.spent, cur)}${m.people.length ? ` · ≈ ${money(m.spent / Math.max(participantNames(state).length, 1), cur)} לאדם` : ''}</span></div>
        ${groups.map((g) => `
          <div class="mx-day">${esc(dayTitle(g.k))}</div>
          <div class="mx-list glass">${g.list.map(rowHtml).join('')}</div>`).join('')}` : '';

      body.innerHTML = `
        <div class="mx">
          ${meHtml}
          <div class="mx-sec-head"><h3>מי מעביר למי</h3>${m.transfers.length ? `<span>${m.transfers.length} ${m.transfers.length === 1 ? 'העברה' : 'העברות'}</span>` : ''}</div>
          ${settleHtml}
          ${budgetHtml}
          ${listHtml}
          ${cap ? '' : `<button type="button" class="mx-set-budget" data-act="settings">${BICON.wallet}<span>רוצים תקציב? אפשר להגדיר מספר ולראות את ההוצאות מולו (לא חובה)</span></button>`}
        </div>`;

      body.querySelectorAll('[data-act="settings"]').forEach((b) => { b.onclick = () => page.querySelector('.bp-settings-btn').click(); });
      body.querySelectorAll('.mx-row').forEach((b) => {
        b.onclick = () => {
          const e = (state.expenses || []).find((x) => +x.id === +b.dataset.id);
          if (e) openExpenseSheet(ctx, e, render);
        };
      });
      body.querySelectorAll('.mx-paid').forEach((b) => {
        b.onclick = async () => {
          const t = m.transfers[+b.dataset.ix];
          if (!t || b.disabled) return;
          if (!confirm(`לסמן שההעברה בוצעה?\n${t.from} ← ${t.to} · ${money(t.amount, cur)}`)) return;
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          b.disabled = true;
          try {
            const row = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses`, {
              method: 'POST', headers,
              body: JSON.stringify({ amount: t.amount, paid_by: t.from, paid_to: t.to, title: '' }),
            });
            state.expenses = [row, ...(state.expenses || [])];
            TRIPMAKER.track('expense_settle', { trip_id: state.trip.id });
            render(); ctx.refresh();
          } catch (ex) {
            alert(ex.message || 'לא הצלחנו לשמור');
            b.disabled = false;
          }
        };
      });
    }

    function renderSettings(cur) {
      const b = state.budget || {};
      body.innerHTML = `
        <div class="mx-settings glass he">
          <label class="he-l" for="mx-cap">תקציב לטיול <small>לא חובה</small></label>
          <div class="money-field">
            <input type="number" id="mx-cap" class="mx-cap" min="0" inputmode="decimal" placeholder="למשל 10,000" value="${b.total ? Math.round(+b.total) : ''}">
            <select class="mx-cur" aria-label="מטבע">${currencyOptions(cur)}</select>
          </div>
          <p class="mx-hint">כל ההוצאות שנרשמות נספרות מול המספר הזה. בלי מספר — פשוט לא מציגים תקציב.</p>
          <div class="form-error mx-err"></div>
          <button type="button" class="btn btn-amber mx-save-budget">שמירה</button>
          ${b.total ? '<button type="button" class="manual-link mx-clear-budget">בלי תקציב</button>' : ''}
        </div>`;
      const err = body.querySelector('.mx-err');
      const save = async (total) => {
        const headers = await ctx.ensureEdit();
        if (!headers) return;
        try {
          state.budget = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/budget`, {
            method: 'PUT', headers,
            body: JSON.stringify({
              total, currency: body.querySelector('.mx-cur').value,
              travelers: (state.budget && state.budget.travelers) || Math.max(participantNames(state).length, 1),
            }),
          });
          ctx.refresh();
          history.back();
        } catch (ex) { err.textContent = ex.message; }
      };
      body.querySelector('.mx-save-budget').onclick = () => {
        const v = body.querySelector('.mx-cap').value;
        if (v !== '' && !(+v > 0)) { err.textContent = 'סכום לא תקין'; return; }
        save(v === '' ? null : +v);
      };
      body.querySelector('.mx-clear-budget')?.addEventListener('click', () => save(null));
    }

    render();
    if (opts.add) openExpenseSheet(ctx, null, render);
  }

  // ---- add / edit one expense (or a recorded payment) ----
  function openExpenseSheet(ctx, e, onDone) {
    const { state } = ctx;
    if (typeof TripPages === 'undefined') return;
    const cur = curOf(state);
    const payment = !!(e && isPayment(e));
    const crew = participantNames(state);
    // a row can name someone who has since left the trip — they stay pickable on it
    const names = [...crew];
    const addName = (n) => { const t = String(n || '').trim(); if (t && !names.some((x) => keyOf(x) === keyOf(t))) names.push(t); };
    if (e) { addName(e.paid_by); addName(e.paid_to); if (Array.isArray(e.split_among)) e.split_among.forEach(addName); }
    const me = meName(state);
    let payer = e ? String(e.paid_by || '').trim() : (me && names.some((n) => keyOf(n) === keyOf(me)) ? names.find((n) => keyOf(n) === keyOf(me)) : names[0] || me || '');
    let payee = payment ? String(e.paid_to).trim() : '';
    let among = new Set((e && !payment ? splitOf(state, e) : names.filter((n) => crew.includes(n))).map(keyOf));
    if (!e && !among.size) among = new Set(names.map(keyOf));

    const chip = (n, on, attr) => `<button type="button" class="mx-chip${on ? ' on' : ''}" ${attr}="${esc(n)}" aria-pressed="${on}"><span class="mx-ava" aria-hidden="true">${esc(initialsOf(n))}</span><span>${esc(firstName(n))}</span></button>`;
    const html = `
      <div class="he mx-form">
        <div class="mx-amount">
          <span class="mx-amount-sym">${esc(sym(cur))}</span>
          <input type="number" class="mx-amt" min="0" step="0.01" inputmode="decimal" placeholder="0" aria-label="סכום" value="${e ? +e.amount : ''}">
        </div>
        <div class="he-l">${payment ? 'מי העביר' : 'מי שילם'}</div>
        <div class="mx-chips mx-payer">${names.map((n) => chip(n, keyOf(n) === keyOf(payer), 'data-payer')).join('')}</div>
        ${payment ? `
          <div class="he-l">למי</div>
          <div class="mx-chips mx-payee">${names.map((n) => chip(n, keyOf(n) === keyOf(payee), 'data-payee')).join('')}</div>` : `
          <label class="he-l" for="mx-what">על מה <small>לא חובה</small></label>
          <input type="text" id="mx-what" class="mx-what" maxlength="160" autocomplete="off" enterkeyhint="done" placeholder="ארוחת ערב, מונית, כרטיסים…" value="${esc(e ? e.title || '' : '')}">
          <div class="he-l">מתחלק בין <small class="mx-split-sum"></small></div>
          <div class="mx-chips mx-among">${names.map((n) => chip(n, among.has(keyOf(n)), 'data-among')).join('')}</div>`}
        <div class="form-error mx-err"></div>
        <div class="he-foot">
          <button type="button" class="btn btn-amber mx-save">${e ? 'שמירה' : 'הוספה'}</button>
          ${e ? `<button type="button" class="he-del mx-del">${HICON.trash}<span>מחיקה</span></button>` : ''}
        </div>
      </div>`;

    TripPages.sheet('expense-sheet', {
      title: payment ? 'החזר' : e ? 'עריכת הוצאה' : 'הוצאה חדשה',
      sub: payment ? '' : e ? '' : 'מתחלק שווה בשווה — מי חייב למי מתעדכן לבד',
      cls: 'mx-sheet',
      html,
      onOpen: (box) => {
        const amtIn = box.querySelector('.mx-amt');
        const err = box.querySelector('.mx-err');
        const paintSplit = () => {
          const s = box.querySelector('.mx-split-sum');
          if (!s) return;
          const n = among.size;
          const a = +amtIn.value;
          s.textContent = n ? `${n === names.length ? 'כולם' : `${n} אנשים`}${a > 0 ? ` · ${money(a / n, cur)} לאחד` : ''}` : '';
        };
        const wireChips = (sel, attr, onPick) => {
          box.querySelectorAll(`${sel} [${attr}]`).forEach((b) => {
            b.onclick = () => { onPick(b.getAttribute(attr)); };
          });
        };
        const repaint = (sel, attr, isOn) => {
          box.querySelectorAll(`${sel} [${attr}]`).forEach((b) => {
            const on = isOn(b.getAttribute(attr));
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on);
          });
        };
        wireChips('.mx-payer', 'data-payer', (n) => { payer = n; repaint('.mx-payer', 'data-payer', (x) => keyOf(x) === keyOf(payer)); });
        wireChips('.mx-payee', 'data-payee', (n) => { payee = n; repaint('.mx-payee', 'data-payee', (x) => keyOf(x) === keyOf(payee)); });
        wireChips('.mx-among', 'data-among', (n) => {
          const k = keyOf(n);
          if (among.has(k)) among.delete(k); else among.add(k);
          repaint('.mx-among', 'data-among', (x) => among.has(keyOf(x)));
          paintSplit();
        });
        amtIn.addEventListener('input', paintSplit);
        paintSplit();
        if (!e) setTimeout(() => amtIn.focus(), 60);

        const done = () => TripPages.closeSheet(() => { onDone?.(); ctx.refresh(); });

        box.querySelector('.mx-del')?.addEventListener('click', async () => {
          if (!confirm(payment ? 'למחוק את ההחזר?' : 'למחוק את ההוצאה?')) return;
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          try {
            await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses/${e.id}`, { method: 'DELETE', headers });
            state.expenses = (state.expenses || []).filter((x) => x.id !== e.id);
            state.settlements = (state.settlements || []).filter((s) => +s.expense_id !== +e.id);
            done();
          } catch (ex) { err.textContent = ex.message; }
        });

        box.querySelector('.mx-save').onclick = async (ev) => {
          const btn = ev.currentTarget;
          if (btn.disabled) return;
          const amount = +amtIn.value;
          if (!(amount > 0)) { err.textContent = 'כמה זה עלה?'; amtIn.focus(); return; }
          if (!payer) { err.textContent = payment ? 'מי העביר?' : 'מי שילם?'; return; }
          if (payment && (!payee || keyOf(payee) === keyOf(payer))) { err.textContent = 'למי הועבר הכסף?'; return; }
          if (!payment && !among.size) { err.textContent = 'בין מי זה מתחלק?'; return; }
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          btn.disabled = true;
          const payload = payment
            ? { amount, paid_by: payer, paid_to: payee, title: '' }
            : {
              amount, paid_by: payer,
              title: box.querySelector('.mx-what').value.trim(),
              split_among: names.filter((n) => among.has(keyOf(n))),
              category: e ? e.category : undefined,
              day_number: e ? e.day_number : currentTripDay(state),
              item_id: e ? e.item_id : undefined,
            };
          try {
            if (e) {
              const updated = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses/${e.id}`, {
                method: 'PUT', headers, body: JSON.stringify(payload),
              });
              Object.assign(e, updated);
            } else {
              const created = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses`, {
                method: 'POST', headers, body: JSON.stringify(payload),
              });
              state.expenses = [created, ...(state.expenses || [])];
            }
            TRIPMAKER.track(e ? 'expense_edit' : 'expense_add', { trip_id: state.trip.id, split: payload.split_among ? payload.split_among.length : null });
            done();
          } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
          }
        };
      },
    });
  }

  // ---- ambient state for the trip page (chips, buttons, day markers) ----

  // the money button and the hero chip read the expenses — what was actually spent —
  // against the budget when there is one. Stop estimates no longer count toward it.
  function budgetButtonState(state) {
    const cap = state.budget ? +state.budget.total || null : null;
    const spent = computeMoney(state).spent;
    if (!cap || !spent) return { label: 'הוצאות', cls: '' };
    const pct = spent / cap;
    return {
      label: `${Math.round(pct * 100)}%`,
      cls: pct > 1 ? 'over' : pct >= 0.8 ? 'warn' : '',
    };
  }

  function heroChip(state) {
    if (!state.canEdit) return null;
    const spent = computeMoney(state).spent;
    const cur = curOf(state);
    const cap = state.budget ? +state.budget.total || null : null;
    if (cap) return `💰 ${fmt(spent, cur)} מתוך ${fmt(cap, cur)}`;
    return spent ? `💰 ${fmt(spent, cur)} הוצאות` : null;
  }

  // day header hotel marker lines: checkout first, then check-in / covered
  function dayHotelLines(state, day) {
    const lines = [];
    for (const h of bookedHotels(state)) {
      if (h.night_end === day - 1) lines.push({ cls: 'checkout', html: `🧳 צ'ק-אאוט · ${esc(h.name)}` });
    }
    for (const h of bookedHotels(state)) {
      // a middle night needs no header line: the overnight point under the day says it
      if (h.night_start === day) lines.push({ cls: 'checkin', html: `🏨 צ'ק-אין · ${esc(h.name)}`, link: h.link });
    }
    return lines;
  }

  return {
    initHotels, openHotels, openBudget, closeBudget, travelIcon, computeMoney, plannedTotals, plannedByDay,
    budgetButtonState, heroChip, dayHotelLines, uncoveredRuns, fmt, curOf,
    nightCardHtml, mountNightCards, itemCostInfo, setItemPersonalCost, clearItemPersonalCost,
    nightHotel, saveStayIdea, nightCount,
  };
})();
