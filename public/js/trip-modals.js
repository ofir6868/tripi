// Trip page modals: hotels ("איפה ישנים"), budget ("ניהול תקציב"), and settle
// ("חלוקת הוצאות — מי חייב למי"). They operate on the trip.js state object:
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

  function actualTotals(expenses) {
    const byCat = Object.fromEntries(CATS.map((c) => [c.key, 0]));
    let total = 0;
    for (const e of expenses) {
      const a = +e.amount;
      if (!(a > 0)) continue;
      byCat[CATS.some((c) => c.key === e.category) ? e.category : 'אחר'] += a;
      total += a;
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

  function actualByDay(expenses) {
    const byDay = {};
    for (const e of expenses) {
      const a = +e.amount;
      if (a > 0 && e.day_number) byDay[e.day_number] = (byDay[e.day_number] || 0) + a;
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

  // ---- modal shell ----
  //
  // Panels answer the phone's back gesture, the way the budget page and the stop
  // sheet already do. Opening one pushes a history entry at the same URL, so back
  // closes the panel instead of leaving the trip — and in an installed PWA, where
  // back has nowhere else to go, the panel is no longer a dead end.

  const modalStack = [];

  window.addEventListener('popstate', () => {
    // we left a modal's entry: close it, and any stacked above it, topmost first
    while (modalStack.length) {
      const id = modalStack[modalStack.length - 1];
      if (history.state && history.state.tripmakerModal === id) break;
      modalStack.pop();
      document.getElementById(id)?.classList.remove('open');
    }
  });

  // dismissing goes back one entry so the panel and the history stay in step;
  // popstate is what actually hides it
  function dismissModal(wrap) {
    if (history.state && history.state.tripmakerModal === wrap.id) { history.back(); return; }
    const i = modalStack.indexOf(wrap.id);
    if (i >= 0) modalStack.splice(i, 1);
    wrap.classList.remove('open');
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !modalStack.length) return;
    const top = document.getElementById(modalStack[modalStack.length - 1]);
    if (top) dismissModal(top);
  });

  function shell(id, title, sub) {
    let wrap = document.getElementById(id);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = id;
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `
        <div class="modal glass modal-wide">
          <div class="mw-head">
            <button class="modal-close" aria-label="סגירה">✕</button>
            <h2>${title}</h2>
            <p class="modal-sub">${sub}</p>
            <div class="mw-controls"></div>
          </div>
          <div class="mw-body"></div>
        </div>`;
      document.body.appendChild(wrap);
      wrap.querySelector('.modal-close').onclick = () => dismissModal(wrap);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) dismissModal(wrap); });
    }
    // re-opening an already-open panel must not stack a second history entry
    if (!wrap.classList.contains('open')) {
      wrap.classList.add('open');
      modalStack.push(id);
      history.pushState({ tripmakerModal: id }, '', location.href);
    }
    return wrap;
  }

  // =================================================================
  //  HOTELS MODAL
  // =================================================================

  function openHotels(ctx, opts = {}) {
    const { state } = ctx;
    const wrap = shell('hotels-modal', '🏨 איפה ישנים?', '');
    const body = wrap.querySelector('.mw-body');
    wrap.querySelector('.mw-controls').innerHTML = '';
    let formState = null; // null | {editing: hotel|null, night_from, night_to}

    if (nightCount(state) === 0) {
      body.innerHTML = '<div class="empty-day">טיול של יום אחד — ישנים בבית 🙂</div>';
      return;
    }

    function nightLabel(n) { return `לילה ${n}`; }

    function overlapsOf(hotel) {
      if (hotel.status !== 'booked') return [];
      return bookedHotels(state).filter((h) =>
        h.id !== hotel.id && h.night_start <= hotel.night_end && hotel.night_start <= h.night_end);
    }

    function render() {
      const cover = nightCoverage(state);
      const runs = uncoveredRuns(state);
      const booked = bookedHotels(state);
      const ideas = state.hotels.filter((h) => h.status === 'idea');
      const blocks = destBlocks(state);

      // night strip + destination label row (flex-grow spans per block's nights)
      const stripSegs = [];
      for (let n = 1; n <= nightCount(state); n++) {
        const h = cover[n];
        stripSegs.push(`
          <button type="button" class="night-seg${h ? '' : ' empty'}" data-night="${n}"
            ${h ? `style="background:${hotelColor(state, h)}22;border-color:${hotelColor(state, h)}88" data-hotel="${h.id}"` : ''}
            title="${h ? esc(h.name) : 'עוד אין מלון ללילה הזה'}">
            <span class="ns-num">${n}</span>
            ${h ? `<span class="ns-dot" style="background:${hotelColor(state, h)}"></span>` : ''}
          </button>`);
      }
      const destRow = blocks.length > 1 ? `<div class="night-dests">${blocks.map((b) => {
        const nights = Math.max(Math.min(b.to, nightCount(state)) - b.from + 1, 0);
        return nights > 0 ? `<span style="flex-grow:${nights}">${esc(b.name)}</span>` : '';
      }).join('')}</div>` : '';

      const coverageLine = !booked.length ? '' :
        runs.length === 0
          ? '<div class="coverage-line ok">🎉 כל הלילות מסודרים!</div>'
          : `<div class="coverage-line">😴 ${runs.map((r) => r.from === r.to ? `לילה ${r.from}` : `לילות ${r.from}–${r.to}`).join(', ')} עדיין בלי מלון</div>`;

      const cardHtml = (h) => {
        const over = overlapsOf(h);
        const color = h.status === 'booked' ? hotelColor(state, h) : 'rgba(255,255,255,.25)';
        const checkout = h.night_end + 1;
        const block = blocks.find((b) => h.night_start >= b.from && h.night_start <= b.to);
        return `
        <div class="hotel-card" data-id="${h.id}" style="border-inline-start-color:${color}">
          <div class="hc-top">
            <span class="hc-name">🏨 ${esc(h.name)}${h.stars ? ` <span class="hotel-stars">${'★'.repeat(Math.min(h.stars, 5))}</span>` : ''}</span>
            <button type="button" class="hc-status ${h.status}" data-id="${h.id}" title="לחיצה מחליפה סטטוס">${h.status === 'booked' ? '✅ הוזמן' : '💡 רעיון'}</button>
          </div>
          <div class="hc-nights">${h.night_start === h.night_end ? `לילה ${h.night_start}` : `לילות ${h.night_start}–${h.night_end}`}${block ? ` · ${esc(block.name)}` : ''} <small>(צ'ק-אאוט ביום ${checkout})</small></div>
          ${state.canEdit && (h.price_total || h.note) ? `<div class="hc-details">${h.price_total ? fmt(h.price_total, curOf(state)) : ''}${h.price_total && h.note ? ' · ' : ''}${h.note ? esc(h.note) : ''}</div>` : ''}
          ${over.length ? `<div class="hc-warn">⚠️ ${over.map((o) => `יש חפיפה עם "${esc(o.name)}"`)[0]}</div>` : ''}
          <div class="hc-actions">
            <a target="_blank" rel="noopener" href="${esc(TRIPMAKER.mapsSearchUrl(h.name + (block ? ' ' + block.name : '')))}">${HICON.pin} מפה</a>
            <a target="_blank" rel="noopener" data-book="${h.id}" data-kind="${h.link ? 'custom_link' : 'booking_search'}" href="${esc(bookingUrl(state, h))}">${h.link ? `${HICON.link} להזמנה` : `${HICON.search} חיפוש בבוקינג`}</a>
            <span class="hc-spacer"></span>
            <button type="button" class="hc-edit" data-id="${h.id}">${HICON.pencil} עריכה</button>
            <button type="button" class="hc-del" data-id="${h.id}" title="הסרת המלון" aria-label="הסרת המלון">${HICON.trash}</button>
          </div>
        </div>`;
      };

      body.innerHTML = `
        <div class="night-strip">${stripSegs.join('')}</div>
        ${destRow}
        ${coverageLine}
        ${!state.hotels.length && !formState ? `
          <div class="empty-day" style="padding:26px 12px">
            עוד לא סגרתם איפה ישנים? 🛏️<br>
            <small>הוסיפו מלון לכל קטע של הטיול — גם אם רק הזמנתם בראש.</small>
          </div>` : ''}
        ${booked.map(cardHtml).join('')}
        ${ideas.length ? `<div class="hc-divider">💡 רעיונות שעוד מתלבטים עליהם</div>${ideas.map(cardHtml).join('')}` : ''}
        <div id="hotel-form-slot"></div>
        ${formState ? '' : `<button type="button" class="add-item-inline" id="hotel-add-btn">+ הוספת מלון</button>`}
        ${state.canEdit ? '' : `<div class="mw-footnote">רוצים לערוך? רק משתתפי הטיול יכולים — בקשו קישור הזמנה מהמארגנים</div>`}
      `;

      // strip interactions: empty run → open add form on that range; covered → scroll to card
      body.querySelectorAll('.night-seg').forEach((seg) => {
        seg.onclick = () => {
          const hid = seg.dataset.hotel;
          if (hid) {
            body.querySelector(`.hotel-card[data-id="${hid}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            const n = +seg.dataset.night;
            const run = uncoveredRuns(state).find((r) => n >= r.from && n <= r.to) || { from: n, to: n };
            openForm(null, run.from, run.to);
          }
        };
      });

      body.querySelector('#hotel-add-btn')?.addEventListener('click', () => {
        const run = uncoveredRuns(state)[0];
        openForm(null, run ? run.from : 1, run ? run.to : nightCount(state));
      });

      body.querySelectorAll('.hc-status').forEach((b) => {
        b.onclick = async () => {
          const h = state.hotels.find((x) => x.id === +b.dataset.id);
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          try {
            const updated = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels/${h.id}`, {
              method: 'PUT', headers,
              body: JSON.stringify({ ...h, status: h.status === 'booked' ? 'idea' : 'booked' }),
            });
            Object.assign(h, updated);
            render(); ctx.refresh();
          } catch (e) { alert(e.message); }
        };
      });
      body.querySelectorAll('.hc-edit').forEach((b) => {
        b.onclick = () => {
          const h = state.hotels.find((x) => x.id === +b.dataset.id);
          openForm(h, h.night_start, h.night_end);
        };
      });
      body.querySelectorAll('.hc-del').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('להסיר את המלון? (ההזמנה האמיתית לא תתבטל 😉)')) return;
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          try {
            await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/hotels/${b.dataset.id}`, { method: 'DELETE', headers });
            state.hotels = state.hotels.filter((x) => x.id !== +b.dataset.id);
            ctx.state.hotels = state.hotels;
            render(); ctx.refresh();
          } catch (e) { alert(e.message); }
        };
      });

      // outbound booking clicks are the revenue funnel — count them from day one
      body.querySelectorAll('a[data-book]').forEach((a) => {
        a.addEventListener('click', () => {
          const h = state.hotels.find((x) => x.id === +a.dataset.book);
          TRIPMAKER.track('hotel_link_click', {
            trip_id: state.trip.id, kind: a.dataset.kind, affiliate: !!TP.marker,
            night_start: h && h.night_start, night_end: h && h.night_end,
          });
        });
      });

      if (formState) renderForm();
    }

    function openForm(editing, from, to) {
      formState = { editing, from, to };
      render();
      body.querySelector('#hotel-form-slot')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function renderForm() {
      const slot = body.querySelector('#hotel-form-slot');
      const h = formState.editing;
      const cur = curOf(state);
      const opts = (sel) => Array.from({ length: nightCount(state) }, (_, i) =>
        `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>${nightLabel(i + 1)}</option>`).join('');
      slot.innerHTML = `
        <div class="inline-item-form glass" style="margin-top:14px">
          <div class="form-grid">
            <div class="field span-2"><label>שם המלון</label>
              <input type="text" class="hf-name" maxlength="160" autocomplete="off"
                placeholder="מלון, דירה, אכסניה — מה שסגרתם" value="${esc(h ? h.name : '')}">
            </div>
            <div class="field span-2"><label>אילו לילות?</label>
              <div class="night-range">
                <select class="hf-from">${opts(formState.from)}</select>
                <span>עד</span>
                <select class="hf-to">${opts(formState.to)}</select>
              </div>
            </div>
            <div class="field span-2"><label>סטטוס</label>
              <div class="seg hf-status">
                <button type="button" data-v="booked" class="${!h || h.status === 'booked' ? 'active' : ''}">✅ הוזמן</button>
                <button type="button" data-v="idea" class="${h && h.status === 'idea' ? 'active' : ''}">💡 רק רעיון</button>
              </div>
            </div>
            <div class="field"><label>מחיר כולל (${sym(cur)}, לא חובה)</label>
              <input type="number" min="0" step="1" class="hf-price" placeholder="לכל הלילות יחד" value="${h && h.price_total ? Math.round(+h.price_total) : ''}"></div>
            <div class="field"><label>קישור להזמנה (לא חובה)</label>
              <input type="url" class="hf-link" dir="ltr" placeholder="Booking, Airbnb, אתר המלון…" value="${esc(h && h.link ? h.link : '')}"></div>
          </div>
          <div class="form-error hf-err"></div>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn btn-amber hf-save" style="flex:1;justify-content:center">שמירה</button>
            <button type="button" class="btn btn-ghost hf-cancel">ביטול</button>
          </div>
        </div>`;

      let picked = h ? { stars: h.stars, lat: h.lat, lon: h.lon } : {};
      const nameInput = slot.querySelector('.hf-name');
      attachHotelSuggest(nameInput, () => {
        const block = blockOfNight(state, +slot.querySelector('.hf-from').value);
        return destCoords(state, block && block.name);
      }, (hp) => { picked = { stars: hp.stars ? +hp.stars : null, lat: hp.lat, lon: hp.lon }; });
      nameInput.addEventListener('input', () => { picked = {}; });

      slot.querySelectorAll('.hf-status button').forEach((b) => {
        b.onclick = () => {
          slot.querySelectorAll('.hf-status button').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
        };
      });
      slot.querySelector('.hf-cancel').onclick = () => { formState = null; render(); };
      slot.querySelector('.hf-save').onclick = async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        const name = nameInput.value.trim();
        if (!name) { slot.querySelector('.hf-err').textContent = 'איך קוראים למלון?'; return; }
        const from = +slot.querySelector('.hf-from').value;
        const to = +slot.querySelector('.hf-to').value;
        if (to < from) { slot.querySelector('.hf-err').textContent = 'טווח הלילות הפוך'; return; }
        const headers = await ctx.ensureEdit();
        if (!headers) return;
        btn.disabled = true;
        const payload = {
          name, night_start: from, night_end: to,
          status: slot.querySelector('.hf-status button.active').dataset.v,
          price_total: slot.querySelector('.hf-price').value || null,
          link: slot.querySelector('.hf-link').value.trim() || null,
          // the notes field is gone from the form; carry any existing note
          // through an edit rather than silently deleting what someone wrote
          note: (h && h.note) || null,
          stars: picked.stars ?? null, lat: picked.lat ?? null, lon: picked.lon ?? null,
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
          formState = null;
          render(); ctx.refresh();
        } catch (err) {
          slot.querySelector('.hf-err').textContent = err.message;
          btn.disabled = false;
        }
      };
    }

    // OSM hotel suggestions near the chosen destination — free text stays first-class
    function attachHotelSuggest(input, getCoords, onPick) {
      const wrapEl = document.createElement('div');
      wrapEl.className = 'autocomplete-wrap';
      input.parentNode.insertBefore(wrapEl, input);
      wrapEl.appendChild(input);
      const list = document.createElement('div');
      list.className = 'autocomplete-list glass';
      wrapEl.appendChild(list);
      let cache = null;
      const show = async () => {
        const coords = getCoords();
        if (!coords) return;
        if (!cache) cache = await GEO.hotelsNear(coords.lat, coords.lon).catch(() => []);
        const q = input.value.trim();
        const matches = cache.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
        if (!matches.length) { list.classList.remove('open'); return; }
        list.innerHTML = matches.map((m, i) => `
          <button type="button" class="autocomplete-item" data-i="${i}">
            <span class="ac-icon">🏨</span>
            <span class="ac-name">${esc(m.name)}</span>
            ${m.stars ? `<span class="ac-meta">${'★'.repeat(Math.min(+m.stars || 0, 5))}</span>` : ''}
          </button>`).join('');
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

    render();
    // arriving from a night card's "כבר הזמנתי" — open straight on that night
    if (opts.addNight) openForm(null, opts.addNight, opts.addNight);
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

  // The slim, settled version: one line in the hotel's own colour. A solved
  // night should take less room than an unsolved one, not more.
  function bookedNightHtml(state, night, hotel) {
    const color = hotelColor(state, hotel);
    const dates = nightDates(state, hotel);
    const meta = [
      dates ? `צ'ק-אין ${dm(dates.checkin)} · צ'ק-אאוט ${dm(dates.checkout)}` : null,
      hotel.price_total && state.canEdit ? fmt(hotel.price_total, curOf(state)) : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="night-booked" style="border-inline-start-color:${color}">
        <span style="color:${color}">${NC_ICON.bed}</span>
        <div class="nb-text">
          <div class="nb-name">לילה ${night} · ${esc(hotel.name)}</div>
          ${meta ? `<div class="nb-meta">${meta}</div>` : ''}
        </div>
        ${state.canEdit ? `<button type="button" class="nb-edit" data-open-night="${night}">שינוי</button>` : ''}
      </div>`;
  }

  // The rail starts as placeholders; mountNightCards fills it when the card
  // comes near the viewport, so a 14-night trip doesn't fire 13 lookups on load.
  // `suggest: false` keeps a booked night's strip but drops the hotel rail — under a
  // free day the itinerary shows the AI's picks for the day instead (trip-dayrecs.js)
  function nightCardHtml(state, night, { suggest = true } = {}) {
    if (night < 1 || night > nightCount(state)) return '';
    const booked = nightCoverage(state)[night];
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
    const wrap = shell('hotel-sheet', esc(hotel.name), hotel.address ? esc(hotel.address) : 'פרטי המלון');
    const body = wrap.querySelector('.mw-body');
    wrap.querySelector('.mw-controls').innerHTML = '';
    wrap.querySelector('h2').innerHTML = esc(hotel.name);
    wrap.querySelector('.modal-sub').innerHTML = hotel.address ? esc(hotel.address) : `לילה ${night}`;

    const hero = hotel.photo || hotel.thumb;
    const scoreLine = hotel.rating != null
      ? `<span class="hs-score">${hotel.rating}</span>${hotel.reviewCount ? `<span class="hs-reviews">${hotel.reviewCount.toLocaleString('he-IL')} ביקורות</span>` : ''}`
      : '';
    body.innerHTML = `
      <div class="hs-hero">${hero ? `<img src="${esc(hero)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
      <div class="hs-top">
        ${hotel.stars ? `<span class="hotel-stars">${'★'.repeat(Math.min(+hotel.stars, 5))}</span>` : ''}
        ${scoreLine}
        ${hotel.distance != null ? `<span class="hs-dist">${hotel.distance < 1000 ? `${hotel.distance} מ'` : `${(hotel.distance / 1000).toFixed(1)} ק"מ`} מסוף היום</span>` : ''}
      </div>
      <a class="btn btn-amber hs-book" target="_blank" rel="noopener"
         href="${esc(hotelSearchUrl(hotel.name))}" title="נפתח בגוגל, בחלון חדש">להזמנה ${TRIPMAKER.externalIcon}</a>
      <div class="hs-loading">טוען פרטים…</div>`;

    body.querySelector('.hs-book')?.addEventListener('click', () => TRIPMAKER.track('hotel_book_click', {
      trip_id: state.trip.id, night, provider: hotel.provider || null, from: 'hotel_sheet',
    }));

    GEO.hotelDetail(hotel.id).then((d) => {
      if (!wrap.classList.contains('open')) return; // closed while we waited
      const gallery = (d.images || []).slice(0, 6);
      const cat = (d.categories || []).map((c) =>
        `<div class="hs-cat"><span>${esc(catName(c.name))}</span><b>${c.rating.toFixed(1)}</b></div>`).join('');
      body.querySelector('.hs-loading').outerHTML = `
        ${gallery.length > 1 ? `<div class="hs-gallery">${gallery.slice(1).map((u) =>
          `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`).join('')}</div>` : ''}
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

    TRIPMAKER.track('hotel_sheet_open', { trip_id: state.trip.id, night, provider: hotel.provider || null });
  }

  // Wires every night card the itinerary just painted. Safe to call after each
  // re-render: cards are matched by night and each fills itself once.
  function mountNightCards(ctx, container) {
    const { state } = ctx;

    container.querySelectorAll('[data-open-night]').forEach((b) => {
      b.onclick = () => openHotels(ctx, { addNight: +b.dataset.openNight });
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

      loadPrices(state, night, picked, rail);

      rail.querySelectorAll('[data-book-i]').forEach((a) => {
        a.addEventListener('click', () => TRIPMAKER.track('hotel_book_click', {
          trip_id: state.trip.id, night, rank: +a.dataset.bookI + 1,
          provider: picked[+a.dataset.bookI].provider || null, from: 'night_card',
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
      // retyping a name we already have, coordinates and stars included
      rail.querySelectorAll('[data-save-i]').forEach((b) => {
        b.onclick = async () => {
          const h = picked[+b.dataset.saveI];
          if (b.disabled) return;
          b.disabled = true;
          // re-checked here too: the list can gain this hotel between paint and
          // tap (the modal, another device, a slow first tap)
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
              }),
            });
            state.hotels.push(created);
            state.hotels.sort((a, c) => a.night_start - c.night_start || a.id - c.id);
            b.classList.add('saved');
            b.innerHTML = NC_ICON.check;
            b.title = 'נשמר ברשימת המלונות';
            TRIPMAKER.track('night_card_save_idea', { trip_id: state.trip.id, night });
            // deliberately no ctx.refresh(): an idea changes nothing the itinerary
            // draws, and a repaint here would wipe the tick the user just earned
          } catch (e) {
            b.disabled = false;
            alert(e.message);
          }
        };
      });
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

  const budgetView = { mode: 'shared', view: 'plan', filter: null, openDays: new Set(), showSettings: false, skippedSetup: false };
  let budgetRender = null; // the open page's render(), so popstate can repaint it

  // stroke icons for the page — inherit currentColor like every .ic
  const BICON = {
    back: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    users: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    lock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    chev: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    x: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    wallet: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>',
    bed: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>',
  };

  const isBudgetHash = () => location.hash === '#budget' || location.hash === '#budget-settings';

  // one switch owns every "is the page open" side effect: the page itself, the body
  // scroll lock, and the dock's תקציב tab lighting up the way any other tab does.
  // Opening also dismisses whichever dock page was showing — the budget takes its place.
  function setBudgetOpen(open) {
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
  function personalPlannedTotals(state) {
    const byCat = Object.fromEntries(CATS.map((c) => [c.key, 0]));
    let total = 0;
    for (const p of loadPersonal(state).planned) {
      const a = +p.amount;
      if (!(a > 0)) continue;
      byCat[CATS.some((c) => c.key === p.category) ? p.category : 'אחר'] += a;
      total += a;
    }
    return { total, byCat };
  }

  // estimates that belong in this budget: shared reads item.cost, personal
  // reads this browser's planned list. Actual spending is those same rows
  // marked paid — never the estimate itself.
  function plannedCostItems(state, isPersonal) {
    if (isPersonal) {
      return loadPersonal(state).planned.filter((p) => +p.amount > 0).map((p) => ({
        item_id: p.item_id,
        title: p.title,
        amount: +p.amount,
        category: CATS.some((c) => c.key === p.category) ? p.category : 'אחר',
        day_number: p.day_number || null,
      }));
    }
    return state.items.filter((it) => +it.cost > 0).map((it) => ({
      item_id: it.id,
      title: it.title,
      amount: +it.cost,
      category: budgetCatOf(it.category),
      day_number: it.day_number,
    }));
  }
  function paidItemIds(state, isPersonal, personal) {
    if (isPersonal) {
      return new Set(Object.keys(personal.paid || {}).filter((k) => personal.paid[k]).map(Number));
    }
    return new Set((state.expenses || []).filter((e) => e.item_id).map((e) => +e.item_id));
  }
  function extraExpensesOf(state, isPersonal, personal) {
    const plannedIds = new Set(plannedCostItems(state, isPersonal).map((p) => p.item_id));
    const list = isPersonal ? personal.expenses : (state.expenses || []);
    return list.filter((e) => !e.item_id || !plannedIds.has(+e.item_id));
  }
  function actualBundle(state, isPersonal, personal) {
    const planned = plannedCostItems(state, isPersonal);
    const paid = paidItemIds(state, isPersonal, personal);
    const extras = extraExpensesOf(state, isPersonal, personal);
    const paidRows = planned.filter((p) => paid.has(p.item_id)).map((p) => ({
      amount: p.amount, category: p.category, day_number: p.day_number,
    }));
    return { planned, paid, extras, totals: actualTotals([...extras, ...paidRows]) };
  }

  function currentTripDay(state) {
    if (!state.trip.start_date) return null;
    const diff = Math.floor((Date.now() - new Date(state.trip.start_date).getTime()) / 86400000) + 1;
    return diff >= 1 && diff <= state.trip.days ? diff : null;
  }

  const catOf = (key) => CATS.find((c) => c.key === key) || CATS[CATS.length - 1];
  const currencyOptions = (selected) => Object.keys(CURRENCIES)
    .map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${CURRENCIES[c]} ${c}</option>`).join('');

  function openBudget(ctx, opts = {}) {
    const { state } = ctx;
    if (!state.canEdit) return;
    // callers (e.g. settle) can land straight on shared/actual without whatever
    // mode the user last left the budget page in
    if (opts.mode === 'shared' || opts.mode === 'personal') budgetView.mode = opts.mode;
    if (opts.view === 'plan' || opts.view === 'actual') budgetView.view = opts.view;
    let page = document.getElementById('budget-page');
    if (!page) {
      page = document.createElement('section');
      page.id = 'budget-page';
      page.className = 'trip-page budget-page';
      page.hidden = true;
      page.setAttribute('aria-label', 'תקציב');
      page.innerHTML = `
        <div class="tp-head">
          <button type="button" class="bp-back tp-back" aria-label="חזרה">${BICON.back}<span>חזרה</span></button>
          <div class="tp-titles">
            <h2 class="tp-title bp-title"></h2>
            <p class="tp-sub bp-sub"></p>
          </div>
          <div class="tp-tools">
            <button type="button" class="btn btn-ghost bp-settings-btn" title="הגדרות תקציב" aria-label="הגדרות תקציב">${BICON.gear}<span>הגדרות</span></button>
          </div>
        </div>
        <div class="tp-body">
          <div class="tp-inner bp-inner">
            <div class="bp-controls"></div>
            <div class="bp-body"></div>
          </div>
        </div>`;
      document.body.appendChild(page);
      page.querySelector('.tp-back').onclick = () => history.back();
    }
    const body = page.querySelector('.bp-body');
    const controls = page.querySelector('.bp-controls');
    const scroller = page.querySelector('.tp-body');

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

    const dToday = currentTripDay(state);
    if (dToday && !budgetView.openDays.size) budgetView.openDays.add(dToday);

    function openSettings() {
      budgetView.showSettings = true;
      history.pushState(null, '', '#budget-settings');
      render();
      scroller.scrollTop = 0;
    }
    page.querySelector('.bp-settings-btn').onclick = openSettings;

    function render() {
      const cur = curOf(state);
      const personal = loadPersonal(state);
      const isPersonal = budgetView.mode === 'personal';
      const isActual = budgetView.view === 'actual';
      const title = page.querySelector('.bp-title');
      const sub = page.querySelector('.bp-sub');
      const gear = page.querySelector('.bp-settings-btn');

      if (budgetView.showSettings) {
        title.textContent = 'הגדרות תקציב';
        sub.textContent = isPersonal
          ? 'התקציב האישי שלכם — נשמר בדפדפן הזה בלבד'
          : 'תקרה, מטבע ומספר מטיילים — משותפים לכל המשתתפים';
        gear.hidden = true;
        renderSettings(cur, personal, isPersonal);
        return;
      }
      title.textContent = 'תקציב';
      sub.textContent = isActual
        ? (isPersonal
          ? 'תחנות שתייחסתם לתקציב האישי — סמנו אם שולם. נשמר בדפדפן הזה בלבד'
          : 'הערכות מהמסלול — סמנו אם שולם, והוצאות נוספות לכל המשתתפים')
        : (isPersonal
          ? 'החלק שלכם מהתכנון וההוצאות שלכם — נשמר בדפדפן הזה בלבד'
          : 'הערכות לתחנות ולמלונות מול התקרה, וההוצאות בפועל — לכל המשתתפים');

      const planned = plannedTotals(state);
      const travelers = (state.budget && state.budget.travelers) || 1;
      const cap = isPersonal ? personal.total : (state.budget ? +state.budget.total || null : null);
      const needsSetup = isPersonal
        ? personal.total == null && !personal.expenses.length && !personal.planned.length
        : !state.budget && !budgetView.skippedSetup;
      gear.hidden = needsSetup;

      controls.innerHTML = `
        <div class="bp-switches">
          <div class="seg seg-sm bm-view" role="tablist" aria-label="תצוגה">
            <button type="button" data-v="plan" class="${!isActual ? 'active' : ''}">תכנון</button>
            <button type="button" data-v="actual" class="${isActual ? 'active' : ''}">בפועל</button>
          </div>
          <div class="seg seg-sm seg-quiet bm-mode" role="tablist" aria-label="תקציב משותף או אישי">
            <button type="button" data-v="shared" class="${!isPersonal ? 'active' : ''}">${BICON.users}<span>משותף</span></button>
            <button type="button" data-v="personal" class="${isPersonal ? 'active' : ''}">${BICON.lock}<span>אישי</span></button>
          </div>
        </div>`;
      controls.querySelectorAll('.bm-mode button').forEach((b) => {
        b.onclick = () => { budgetView.mode = b.dataset.v; budgetView.filter = null; render(); };
      });
      controls.querySelectorAll('.bm-view button').forEach((b) => {
        b.onclick = () => { budgetView.view = b.dataset.v; budgetView.filter = null; render(); };
      });

      // ---- setup states ----
      if (!isPersonal && needsSetup) {
        body.innerHTML = `
          <div class="bp-setup glass">
            <div class="bp-setup-ic">${BICON.wallet}</div>
            <h3>הגדרת תקציב לטיול</h3>
            <p>קובעים תקרה ומספר מטיילים. ההערכות על התחנות והמלונות מסתכמות מולה, וההוצאות בפועל נרשמות תוך כדי הטיול.</p>
            <div class="form-grid">
              <div class="field span-2"><label>תקציב כולל</label>
                <div class="money-field">
                  <input type="number" min="0" inputmode="decimal" class="bs-total" placeholder="10,000">
                  <select class="bs-cur" aria-label="מטבע">${currencyOptions('ILS')}</select>
                </div>
              </div>
              <div class="field span-2"><label>מספר מטיילים</label>
                <div class="stepper"><button type="button" class="step-btn bs-minus" aria-label="פחות">−</button>
                <input type="number" class="bs-trav" value="2" min="1" max="50">
                <button type="button" class="step-btn bs-plus" aria-label="יותר">+</button></div></div>
            </div>
            <div class="form-error bs-err"></div>
            <button type="button" class="btn btn-amber bs-go">קביעת תקציב</button>
            <button type="button" class="manual-link bs-skip">להמשיך בלי תקרה — רק לסכם הערכות</button>
          </div>`;
        const trav = body.querySelector('.bs-trav');
        body.querySelector('.bs-minus').onclick = () => { trav.value = Math.max(+trav.value - 1, 1); };
        body.querySelector('.bs-plus').onclick = () => { trav.value = Math.min(+trav.value + 1, 50); };
        body.querySelector('.bs-skip').onclick = () => { budgetView.skippedSetup = true; render(); };
        body.querySelector('.bs-go').onclick = async (e) => {
          const btn = e.currentTarget; // currentTarget is null after an await
          if (btn.disabled) return;
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          btn.disabled = true;
          try {
            state.budget = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/budget`, {
              method: 'PUT', headers,
              body: JSON.stringify({
                total: body.querySelector('.bs-total').value || null,
                currency: body.querySelector('.bs-cur').value,
                travelers: +trav.value,
              }),
            });
            render(); ctx.refresh();
          } catch (err) {
            body.querySelector('.bs-err').textContent = err.message;
            btn.disabled = false;
          }
        };
        return;
      }
      if (isPersonal && needsSetup) {
        body.innerHTML = `
          <div class="bp-setup glass">
            <div class="bp-setup-ic">${BICON.lock}</div>
            <h3>תקציב אישי</h3>
            <p>תקרה משלכם, לצד התקציב המשותף. נשמר בדפדפן הזה בלבד — רק אתם רואים אותו, והוא לא עובר למכשיר אחר.</p>
            <div class="field"><label>התקציב שלי (${sym(cur)})</label><input type="number" min="0" inputmode="decimal" class="bp-total" placeholder="4,000"></div>
            <div class="form-error bp-err"></div>
            <button type="button" class="btn btn-amber bp-go">קביעת תקציב אישי</button>
          </div>`;
        body.querySelector('.bp-go').onclick = () => {
          const v = +body.querySelector('.bp-total').value;
          if (!(v > 0)) { body.querySelector('.bp-err').textContent = 'צריך סכום'; return; }
          if (!savePersonal(state, { ...personal, total: v })) {
            body.querySelector('.bp-err').textContent = 'הדפדפן חוסם שמירה מקומית — תקציב אישי לא זמין כאן';
            return;
          }
          render();
        };
        return;
      }

      // ---- headline: the figure, the cap, and how the two compare ----
      const bundle = actualBundle(state, isPersonal, personal);
      const actual = bundle.totals;
      const personalPlan = personalPlannedTotals(state);
      const shareOf = (n) => n / Math.max(travelers, 1);
      const plannedValue = isPersonal ? shareOf(planned.total) + personalPlan.total : planned.total;
      const value = isActual ? actual.total : plannedValue;
      const pct = cap ? value / cap : 0;
      const tone = !cap ? '' : pct > 1 ? 'over' : pct >= 0.8 ? 'warn' : 'ok';
      let status;
      if (!cap) status = 'בלי תקרה';
      else if (pct > 1) status = `חריגה של ${fmt(value - cap, cur)}`;
      else status = `נשאר ${fmt(cap - value, cur)}`;
      const perPerson = !isPersonal && travelers > 1 && value > 0
        ? `<span>≈ ${fmt(value / travelers, cur)} לאדם · <button type="button" class="bs-link pp-edit">${travelers} מטיילים</button></span>`
        : '';
      const summaryHtml = `
        <section class="bp-summary glass${tone ? ' ' + tone : ''}" aria-live="polite">
          <div class="bs-row">
            <span class="bs-label">${isActual ? 'הוצאות בפועל' : 'סה"כ מתוכנן'}</span>
            ${cap ? `<span class="bs-pct">${Math.round(pct * 100)}%</span>` : ''}
          </div>
          <div class="bs-figure"><b>${fmt(value, cur)}</b>${cap ? `<span>מתוך ${fmt(cap, cur)}</span>` : ''}</div>
          ${cap ? `<div class="bs-track"><span class="bs-fill" style="width:${Math.min(pct, 1) * 100}%"></span></div>` : ''}
          <div class="bs-meta">
            <span>${status}${!cap && !isPersonal ? ` · <button type="button" class="bs-link pp-edit">הגדרת תקרה</button>` : ''}</span>
            ${perPerson}
          </div>
        </section>`;

      // ---- categories: share of the total, tap one to filter the lists below ----
      const catTotals = isActual
        ? actual.byCat
        : (isPersonal
          ? Object.fromEntries(CATS.map((c) => [c.key, shareOf(planned.byCat[c.key] || 0) + (personalPlan.byCat[c.key] || 0)]))
          : planned.byCat);
      const catSum = Object.values(catTotals).reduce((a, b) => a + b, 0);
      let catsHtml;
      if (catSum > 0) {
        catsHtml = `
        <section class="bp-section">
          <h3 class="bp-section-title">לפי קטגוריה
            ${budgetView.filter ? `<button type="button" class="bp-chip clear-filter" title="ביטול הסינון">${esc(budgetView.filter)} ${BICON.x}</button>` : ''}
          </h3>
          <div class="bp-card">${CATS.map((c) => {
            const v = catTotals[c.key] || 0;
            if (!v) return '';
            const share = v / catSum;
            return `
            <button type="button" class="bp-cat${budgetView.filter === c.key ? ' active' : ''}" data-cat="${c.key}" aria-pressed="${budgetView.filter === c.key}">
              <span class="bc-emoji">${c.emoji}</span>
              <span class="bc-main">
                <span class="bc-head"><span class="bc-name">${c.key}</span><span class="bc-amount">${fmt(v, cur)}</span></span>
                <span class="bc-track"><span class="bc-fill" style="width:${Math.max(Math.round(share * 100), 1)}%"></span></span>
              </span>
              <span class="bc-share">${Math.round(share * 100)}%</span>
            </button>`;
          }).join('')}</div>
        </section>`;
      } else if (isActual) {
        catsHtml = '<p class="bp-note">תחנות עם הערכה מופיעות למטה. סמנו «שולם» אחרי ששילמתם — רק הן נספרות בפועל.</p>';
      } else if (isPersonal) {
        catsHtml = '<p class="bp-note">החלק שלכם מהתכנון המשותף יופיע כאן, וגם עלויות שתייחסו לתקציב האישי כשמוסיפים תחנה.</p>';
      } else {
        catsHtml = '<p class="bp-note">עוד אין הערכות. מוסיפים סכום לכל תחנה בפירוט הימים למטה, או דרך סימן המטבע ליד התחנה במסלול.</p>';
      }

      // ---- quick add (בפועל only) ----
      const addHtml = isActual ? `
        <section class="bp-section">
          <h3 class="bp-section-title">הוספת הוצאה</h3>
          <div class="bp-card bp-add">
            <div class="ba-row">
              <label class="ba-amount"><span>${sym(cur)}</span><input type="number" min="0" inputmode="decimal" class="qa-amount" placeholder="0" aria-label="סכום"></label>
              <input type="text" class="qa-title" maxlength="160" placeholder="על מה? למשל: ארוחת ערב" aria-label="תיאור">
            </div>
            <div class="ba-row">
              <select class="qa-cat" aria-label="קטגוריה">${CATS.map((c) => `<option value="${c.key}"${c.key === 'אחר' ? ' selected' : ''}>${c.emoji} ${c.key}</option>`).join('')}</select>
              <select class="qa-day" aria-label="יום"><option value="">בלי יום</option>${Array.from({ length: state.trip.days }, (_, i) =>
                `<option value="${i + 1}"${dToday === i + 1 ? ' selected' : ''}>יום ${i + 1}</option>`).join('')}</select>
              <button type="button" class="btn btn-amber qa-add">${BICON.plus}<span>הוספה</span></button>
            </div>
            <div class="ba-hint qa-hint">${isPersonal ? 'הוצאה נוספת, מעבר לתחנות — נשמרת רק אצלכם' : 'הוצאה נוספת, מעבר לתחנות — נרשמת לכל המשתתפים'}</div>
          </div>
        </section>` : '';

      const listHtml = isActual
        ? actualPlanHtml(cur, personal, isPersonal, bundle)
        : (isPersonal ? personalPlanListHtml(personal, cur) : dayAccordionHtml(cur));

      body.innerHTML = `
        ${summaryHtml}
        ${catsHtml}
        ${addHtml}
        ${listHtml}
        ${!state.canEdit && !isPersonal ? '<p class="bp-note">רק משתתפי הטיול עורכים את התקציב — בקשו קישור הזמנה מהמארגנים.</p>' : ''}
      `;

      // ---- wiring ----
      body.querySelectorAll('.pp-edit').forEach((b) => { b.onclick = openSettings; });
      body.querySelectorAll('.bp-cat').forEach((b) => {
        b.onclick = () => { budgetView.filter = budgetView.filter === b.dataset.cat ? null : b.dataset.cat; render(); };
      });
      body.querySelector('.clear-filter')?.addEventListener('click', () => { budgetView.filter = null; render(); });

      const qaAdd = body.querySelector('.qa-add');
      if (qaAdd) qaAdd.onclick = async (e) => {
        const btn = e.currentTarget; // currentTarget is null after an await
        const amount = +body.querySelector('.qa-amount').value;
        const title = body.querySelector('.qa-title').value.trim();
        const err = (m) => { body.querySelector('.qa-hint').innerHTML = `<span class="ba-err">${m}</span>`; };
        if (!(amount > 0)) return err('חסר סכום');
        if (!title) return err('על מה ההוצאה?');
        const expense = {
          title, amount,
          category: body.querySelector('.qa-cat').value,
          day_number: +body.querySelector('.qa-day').value || null,
        };
        if (isPersonal) {
          personal.expenses.unshift({ ...expense, ts: Date.now() });
          if (!savePersonal(state, personal)) return err('הדפדפן חוסם שמירה מקומית');
          render();
          return;
        }
        if (btn.disabled) return;
        const headers = await ctx.ensureEdit();
        if (!headers) return;
        btn.disabled = true;
        try {
          const created = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses`, {
            method: 'POST', headers, body: JSON.stringify(expense),
          });
          state.expenses.unshift(created);
          render(); ctx.refresh();
        } catch (ex) { err(ex.message); btn.disabled = false; }
      };

      wireLists(cur, personal, isPersonal);
    }

    // settings sub-page: swaps the whole screen (back = history.back(), like the
    // page itself) — holds the total+currency form and the reset action
    function renderSettings(cur, personal, isPersonal) {
      controls.innerHTML = '';
      const resetSection = (hint) => `
        <section class="bp-section bp-danger">
          <h3 class="bp-section-title">איפוס</h3>
          <div class="bp-card">
            <p>${hint}</p>
            <button type="button" class="btn btn-danger st-reset">איפוס תקציב</button>
          </div>
        </section>`;
      const wireReset = (confirmMsg, doReset) => {
        body.querySelector('.st-reset').onclick = async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled || !confirm(confirmMsg)) return;
          btn.disabled = true;
          try { await doReset(); }
          catch (err) { alert(err.message); btn.disabled = false; }
        };
      };

      if (isPersonal) {
        body.innerHTML = `
          <section class="bp-section">
            <div class="bp-card bp-form">
              <div class="field"><label>התקציב האישי שלי (${sym(cur)})</label>
                <input type="number" min="0" inputmode="decimal" class="st-ptotal" value="${personal.total || ''}" placeholder="בלי תקרה"></div>
              <button type="button" class="btn btn-amber st-save">שמירה</button>
            </div>
          </section>
          ${resetSection('מוחק את התקציב וההוצאות האישיות ששמורים בדפדפן הזה.')}`;
        body.querySelector('.st-save').onclick = () => {
          savePersonal(state, { ...personal, total: +body.querySelector('.st-ptotal').value || null });
          history.back();
        };
        wireReset('לאפס את התקציב האישי? גם ההוצאות האישיות יימחקו', async () => {
          try { localStorage.removeItem(personalKey(state)); } catch { /* private mode */ }
          history.back();
        });
        return;
      }

      const b = state.budget || { total: null, currency: 'ILS', travelers: 2 };
      body.innerHTML = `
        <section class="bp-section">
          <div class="bp-card bp-form">
            <div class="form-grid">
              <div class="field span-2"><label>תקציב כולל</label>
                <div class="money-field">
                  <input type="number" min="0" inputmode="decimal" class="st-total" value="${b.total ? Math.round(+b.total) : ''}" placeholder="בלי תקרה">
                  <select class="st-cur" aria-label="מטבע">${currencyOptions(b.currency)}</select>
                </div>
              </div>
              <div class="field span-2"><label>מספר מטיילים</label>
                <div class="stepper"><button type="button" class="step-btn st-minus" aria-label="פחות">−</button>
                <input type="number" class="st-trav" value="${b.travelers}" min="1" max="50">
                <button type="button" class="step-btn st-plus" aria-label="יותר">+</button></div></div>
            </div>
            <div class="form-error st-err"></div>
            <button type="button" class="btn btn-amber st-save">שמירת הגדרות</button>
          </div>
        </section>
        ${resetSection('מוחק את התקרה, המטבע ומספר המטיילים לכל המשתתפים. ההערכות על התחנות וההוצאות נשארות.')}`;
      const trav = body.querySelector('.st-trav');
      body.querySelector('.st-minus').onclick = () => { trav.value = Math.max(+trav.value - 1, 1); };
      body.querySelector('.st-plus').onclick = () => { trav.value = Math.min(+trav.value + 1, 50); };
      body.querySelector('.st-save').onclick = async () => {
        const newCur = body.querySelector('.st-cur').value;
        if (state.budget && newCur !== state.budget.currency &&
            !confirm('שימו לב: הסכומים לא יומרו, רק המטבע יתחלף. להמשיך?')) return;
        const headers = await ctx.ensureEdit();
        if (!headers) return;
        try {
          state.budget = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/budget`, {
            method: 'PUT', headers,
            body: JSON.stringify({ total: body.querySelector('.st-total').value || null, currency: newCur, travelers: +trav.value }),
          });
          ctx.refresh();
          history.back();
        } catch (e) { body.querySelector('.st-err').textContent = e.message; }
      };
      wireReset('לאפס את התקציב המשותף? התקרה, המטבע ומספר המטיילים יימחקו לכולם', async () => {
        const headers = await ctx.ensureEdit();
        if (!headers) return;
        await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/budget`, { method: 'DELETE', headers });
        state.budget = null;
        budgetView.skippedSetup = false;
        ctx.refresh();
        history.back();
      });
    }

    // one expense line — the same row in the personal list and the day groups
    function expenseRowHtml(e, cur, delAttr) {
      return `
        <div class="bd-item bd-exp">
          <span class="bi-cat">${catOf(e.category).emoji}</span>
          <span class="bi-title">${esc(e.title)}${e.paid_by ? ` <small>· ${esc(e.paid_by)}</small>` : ''}${e.day_number && delAttr.startsWith('data-i') ? ` <small>· יום ${e.day_number}</small>` : ''}</span>
          <span class="bi-amount">${fmt(e.amount, cur)}</span>
          ${delAttr ? `<button type="button" class="er-del" ${delAttr} aria-label="מחיקה">${BICON.x}</button>` : ''}
        </div>`;
    }

    function personalPlanListHtml(personal, cur) {
      const list = personal.planned.filter((e) => !budgetView.filter || e.category === budgetView.filter);
      if (!list.length) {
        return budgetView.filter ? ''
          : '<p class="bp-note">עלויות שתייחסו לתקציב האישי יופיעו כאן. החלק שלכם מהתכנון המשותף כבר למעלה. משנים את הייחוס בעריכת התחנה.</p>';
      }
      return `
        <section class="bp-section">
          <h3 class="bp-section-title">מיוחס לתקציב האישי</h3>
          <div class="bp-card bp-list">${list.map((e) => `
            <div class="bd-item">
              <span class="bi-cat">${catOf(e.category).emoji}</span>
              <span class="bi-title">${esc(e.title)}${e.day_number ? ` <small>· יום ${e.day_number}</small>` : ''}</span>
              <span class="bi-amount">${fmt(e.amount, cur)}</span>
            </div>`).join('')}</div>
          <p class="bp-note">נשמר רק אצלכם, בדפדפן הזה. זה תכנון — ב«בפועל» מסמנים אם שולם.</p>
        </section>`;
    }

    function planPayRowHtml(p, cur, paidSet) {
      const on = paidSet.has(p.item_id);
      return `
        <div class="bd-item bd-plan${on ? ' is-paid' : ''}">
          <span class="bi-cat">${catOf(p.category).emoji}</span>
          <span class="bi-title">${esc(p.title)}</span>
          <span class="bi-amount">${fmt(p.amount, cur)}</span>
          <div class="bd-pay" role="group" aria-label="האם שולם עבור ${esc(p.title)}">
            <button type="button" class="pay-btn${on ? ' on' : ''}" data-item="${p.item_id}" data-paid="1">שולם</button>
            <button type="button" class="pay-btn unpaid${!on ? ' on' : ''}" data-item="${p.item_id}" data-paid="0">לא שולם</button>
          </div>
        </div>`;
    }

    function actualPlanHtml(cur, personal, isPersonal, bundle) {
      const { planned, paid, extras } = bundle;
      const match = (cat) => !budgetView.filter || cat === budgetView.filter;
      const items = planned.filter((p) => match(p.category));
      const extraList = extras.filter((e) => match(e.category));
      let planBlock;
      if (!items.length) {
        planBlock = '<p class="bp-note">עוד אין תחנות עם הערכה. מוסיפים עלות לתחנה ומשייכים אותה לתקציב — זה נכנס לתכנון, וכאן מסמנים אם שולם.</p>';
      } else {
        const days = [...new Set(items.map((p) => p.day_number || 0))].sort((a, b) => a - b);
        planBlock = `
          <section class="bp-section">
            <h3 class="bp-section-title">מהמסלול <small>סמנו אם שולם</small></h3>
            <div class="bp-card bp-list">${days.map((d) => {
              const slice = items.filter((p) => (p.day_number || 0) === d);
              return `<div class="bp-day-label">${d ? `יום ${d}` : 'בלי יום'}</div>
                ${slice.map((p) => planPayRowHtml(p, cur, paid)).join('')}`;
            }).join('')}</div>
          </section>`;
      }
      const extraBlock = extraList.length ? `
        <section class="bp-section">
          <h3 class="bp-section-title">הוצאות נוספות</h3>
          <div class="bp-card bp-list">${extraList.map((e) => expenseRowHtml(
            e, cur,
            isPersonal ? `data-i="${personal.expenses.indexOf(e)}"` : (state.canEdit ? `data-id="${e.id}"` : '')
          )).join('')}</div>
        </section>` : '';
      return planBlock + extraBlock;
    }

    function dayAccordionHtml(cur) {
      // each view owns its own rows: תכנון = estimates + booked hotels, בפועל = real expenses
      const isActual = budgetView.view === 'actual';
      const byDay = isActual ? actualByDay(state.expenses) : plannedByDay(state);
      const blocks = destBlocks(state);
      const rows = [];
      const generalExp = isActual ? state.expenses.filter((e) => !e.day_number || e.day_number > state.trip.days) : [];
      const delAttr = (e) => (state.canEdit ? `data-id="${e.id}"` : '');
      for (let d = 1; d <= state.trip.days; d++) {
        const items = isActual ? [] : state.items.filter((it) => it.day_number === d &&
          (!budgetView.filter || budgetCatOf(it.category) === budgetView.filter));
        const hotels = isActual ? [] : bookedHotels(state).filter((h) => h.night_start <= d && d <= h.night_end)
          .filter(() => !budgetView.filter || budgetView.filter === 'לינה');
        const exps = !isActual ? [] : state.expenses.filter((e) => e.day_number === d &&
          (!budgetView.filter || e.category === budgetView.filter));
        if (budgetView.filter && !items.length && !hotels.length && !exps.length) continue;
        const block = blocks.find((b) => d >= b.from && d <= b.to);
        const open = budgetView.openDays.has(d);
        rows.push(`
        <div class="bp-day${open ? ' open' : ''}${dToday === d ? ' today' : ''}" data-day="${d}">
          <button type="button" class="bd-head" aria-expanded="${open}">
            <span class="bd-chev">${BICON.chev}</span>
            <span class="bd-title">יום ${d}${block ? `<small>${esc(block.name)}</small>` : ''}${dToday === d ? '<small class="bd-today">היום</small>' : ''}</span>
            <span class="bd-total">${byDay[d] ? fmt(byDay[d], cur) : ''}</span>
          </button>
          ${open ? `<div class="bd-body">
            ${items.map((it) => `
              <div class="bd-item${it.category === 'נסיעה' ? ' travel' : ''}">
                <span class="bi-time">${it.time_label ? esc(it.time_label) : ''}</span>
                <span class="bi-title">${it.category === 'נסיעה' ? travelIcon(it) + ' ' : ''}${esc(it.title)}</span>
                ${state.canEdit
                  ? `<label class="bi-cost"><span>${sym(cur)}</span><input type="number" min="0" inputmode="decimal" class="cost-input" data-item="${it.id}" placeholder="הערכה" value="${it.cost ? Math.round(+it.cost) : ''}" title="עלות משוערת (${sym(cur)})"></label>`
                  : `<span class="bi-amount${it.cost ? '' : ' muted'}">${it.cost ? fmt(it.cost, cur) : '—'}</span>`}
              </div>`).join('')}
            ${hotels.map((h) => {
              const nights = h.night_end - h.night_start + 1;
              return `<button type="button" class="bd-hotel" data-open-hotels>
                ${BICON.bed}<span class="bh-name">${esc(h.name)}</span>
                <span class="bh-meta">${nights === 1 ? 'לילה אחד' : nights + ' לילות'}${h.price_total ? ` · ${fmt(+h.price_total / nights, cur)} ללילה` : ''}</span>
              </button>`;
            }).join('')}
            ${exps.map((e) => expenseRowHtml(e, cur, delAttr(e))).join('')}
            ${!items.length && !hotels.length && !exps.length ? `<div class="bd-empty">${isActual ? 'אין הוצאות ביום הזה' : 'אין תחנות ביום הזה'}</div>` : ''}
          </div>` : ''}
        </div>`);
      }
      const generalList = generalExp.filter((e) => !budgetView.filter || e.category === budgetView.filter);
      const generalHtml = generalList.length ? `
        <div class="bp-day open">
          <div class="bd-head static"><span class="bd-title">הוצאות כלליות<small>בלי יום</small></span>
            <span class="bd-total">${fmt(generalList.reduce((a, e) => a + (+e.amount || 0), 0), cur)}</span></div>
          <div class="bd-body">${generalList.map((e) => expenseRowHtml(e, cur, delAttr(e))).join('')}</div>
        </div>` : '';
      if (!rows.length && !generalHtml) return '';
      return `
        <section class="bp-section">
          <h3 class="bp-section-title">${isActual ? 'הוצאות לפי ימים' : 'הערכות לפי ימים'}</h3>
          <div class="bp-card bp-days">${rows.join('')}${generalHtml}</div>
        </section>`;
    }

    function wireLists(cur, personal, isPersonal) {
      body.querySelectorAll('.bd-head').forEach((h) => {
        const day = +h.closest('.bp-day').dataset.day;
        if (!day) return;
        h.onclick = () => {
          if (budgetView.openDays.has(day)) budgetView.openDays.delete(day);
          else budgetView.openDays.add(day);
          render();
        };
      });
      body.querySelectorAll('[data-open-hotels]').forEach((b) => {
        b.onclick = () => { history.back(); openHotels(ctx); }; // leave the page, open hotels on the trip
      });
      // inline planned-cost editing (save on change/blur)
      body.querySelectorAll('.cost-input').forEach((inp) => {
        inp.onchange = async () => {
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          const it = state.items.find((x) => x.id === +inp.dataset.item);
          try {
            const updated = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/items/${it.id}`, {
              method: 'PATCH', headers, body: JSON.stringify({ cost: inp.value || null }),
            });
            it.cost = updated.cost;
            if (+updated.cost > 0) clearItemPersonalCost(state, it.id);
            render(); ctx.refresh();
          } catch (e) { alert(e.message); }
        };
      });
      body.querySelectorAll('.er-del').forEach((b) => {
        b.onclick = async () => {
          if (isPersonal && b.dataset.i != null) {
            personal.expenses.splice(+b.dataset.i, 1);
            savePersonal(state, personal);
            render();
            return;
          }
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          try {
            await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses/${b.dataset.id}`, { method: 'DELETE', headers });
            state.expenses = state.expenses.filter((e) => e.id !== +b.dataset.id);
            render(); ctx.refresh();
          } catch (e) { alert(e.message); }
        };
      });
      body.querySelectorAll('.pay-btn').forEach((b) => {
        b.onclick = async () => {
          const itemId = +b.dataset.item;
          const wantPaid = b.dataset.paid === '1';
          const already = paidItemIds(state, isPersonal, personal).has(itemId);
          if (wantPaid === already) return;
          if (isPersonal) {
            personal.paid = personal.paid || {};
            if (wantPaid) personal.paid[itemId] = true;
            else delete personal.paid[itemId];
            if (!savePersonal(state, personal)) { alert('הדפדפן חוסם שמירה מקומית'); return; }
            render();
            return;
          }
          const headers = await ctx.ensureEdit();
          if (!headers) return;
          const row = plannedCostItems(state, false).find((p) => p.item_id === itemId);
          if (!row) return;
          try {
            if (wantPaid) {
              const created = await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses`, {
                method: 'POST', headers,
                body: JSON.stringify({
                  title: row.title, amount: row.amount, category: row.category,
                  day_number: row.day_number, item_id: itemId,
                }),
              });
              state.expenses.unshift(created);
            } else {
              const exp = state.expenses.find((e) => +e.item_id === itemId);
              if (exp) {
                await TRIPMAKER.api(`/api/trips/code/${state.trip.share_code}/expenses/${exp.id}`, { method: 'DELETE', headers });
                state.expenses = state.expenses.filter((e) => e.id !== exp.id);
              }
            }
            render(); ctx.refresh();
          } catch (e) { alert(e.message); }
        };
      });
    }

    budgetRender = render;
    render();
  }

  // ---- ambient state for the trip page (chips, buttons, day markers) ----

  function budgetButtonState(state) {
    const planned = plannedTotals(state);
    const cap = state.budget ? +state.budget.total || null : null;
    if (!cap || !planned.total) return { label: 'תקציב', cls: '' };
    const pct = planned.total / cap;
    return {
      label: `${Math.round(pct * 100)}%`,
      cls: pct > 1 ? 'over' : pct >= 0.8 ? 'warn' : '',
    };
  }

  function heroChip(state) {
    if (!state.canEdit) return null;
    const planned = plannedTotals(state);
    if (!state.budget && !planned.total) return null;
    const cur = curOf(state);
    const cap = state.budget ? +state.budget.total || null : null;
    return cap
      ? `💰 ${fmt(planned.total, cur)} מתוך ${fmt(cap, cur)}`
      : `💰 ${fmt(planned.total, cur)} מתוכנן`;
  }

  // day header hotel marker lines: checkout first, then check-in / covered
  function dayHotelLines(state, day) {
    const lines = [];
    for (const h of bookedHotels(state)) {
      if (h.night_end === day - 1) lines.push({ cls: 'checkout', html: `🧳 צ'ק-אאוט · ${esc(h.name)}` });
    }
    for (const h of bookedHotels(state)) {
      if (h.night_start === day) lines.push({ cls: 'checkin', html: `🏨 צ'ק-אין · ${esc(h.name)}`, link: h.link });
      else if (h.night_start < day && day <= h.night_end) lines.push({ cls: 'stay', html: `🏨 ${esc(h.name)}` });
    }
    return lines;
  }

  // =================================================================
  //  SETTLE — חלוקת הוצאות / מי חייב למי
  //  Available throughout the trip for participants (not only on the last day).
  //  Shared budget only: state.expenses (server) among trip participants.
  //  Personal budget (localStorage) is never read here.
  // =================================================================

  function syncSettleButton(state) {
    const btn = document.getElementById('settle-btn');
    if (!btn || !state || !state.trip) return;
    btn.classList.remove('is-locked');
    btn.title = 'חלוקת הוצאות — מי חייב למי (תקציב משותף)';
  }

  // shared-budget group: trip participants, plus anyone named as paid_by on a
  // shared expense (so a payer whose display name drifted still gets credit —
  // and the expense isn't dropped as "missing")
  function settlePeople(state) {
    const byKey = new Map(); // lowercased → display name
    const add = (name) => {
      const n = String(name || '').trim();
      if (!n) return;
      const key = n.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, n);
    };
    for (const p of state.participants || []) add(p.name);
    for (const e of state.expenses || []) add(e.paid_by);
    return [...byKey.values()];
  }

  // shared expenses only (state.expenses) → per-expense cards + whole-trip rollup.
  // personal budget is never read. settlements (שולם) clear a debtor's share so
  // they no longer owe the payer for that expense.
  function computeSettlement(state) {
    const keyOf = (name) => String(name || '').trim().toLowerCase();
    const all = (state.expenses || []).filter((e) => +e.amount > 0);
    const skipped = all.filter((e) => !String(e.paid_by || '').trim());
    const expenses = all.filter((e) => String(e.paid_by || '').trim());
    const people = settlePeople(state);
    const settled = new Set(
      (state.settlements || []).map((s) => `${s.expense_id}:${keyOf(s.debtor_key || s.debtor_name)}`)
    );
    const isSettled = (expenseId, debtorName) => settled.has(`${expenseId}:${keyOf(debtorName)}`);

    if (people.length < 2) {
      return { people, cards: [], balances: [], transfers: [], skipped, total: 0, openTotal: 0, error: 'need_people' };
    }
    if (!expenses.length) {
      return {
        people, cards: [], balances: [], transfers: [], skipped, total: 0, openTotal: 0,
        error: all.length ? 'no_payers' : 'no_expenses',
      };
    }

    const n = people.length;
    const total = expenses.reduce((s, e) => s + (+e.amount || 0), 0);
    const cards = expenses.map((e) => {
      const amount = +e.amount;
      const share = amount / n;
      const payerKey = keyOf(e.paid_by);
      const payerName = people.find((p) => keyOf(p) === payerKey) || String(e.paid_by).trim();
      const debtors = people
        .filter((p) => keyOf(p) !== payerKey)
        .map((name) => ({
          name,
          amount: share,
          settled: isSettled(e.id, name),
        }));
      const openDebtors = debtors.filter((d) => !d.settled);
      const refund = share * openDebtors.length;
      return {
        id: e.id,
        title: e.title,
        category: e.category || 'אחר',
        amount,
        share,
        payerName,
        refund,
        debtors,
        openDebtors,
        day_number: e.day_number || null,
        allSettled: debtors.length > 0 && openDebtors.length === 0,
      };
    });

    // whole-trip rollup from *unsettled* shares only — settled marks clear the debt
    const net = Object.fromEntries(people.map((p) => [keyOf(p), 0]));
    const paid = Object.fromEntries(people.map((p) => [keyOf(p), 0]));
    let openTotal = 0;
    for (const e of expenses) {
      const amount = +e.amount;
      const share = amount / n;
      const payerKey = keyOf(e.paid_by);
      paid[payerKey] = (paid[payerKey] || 0) + amount;
      for (const name of people) {
        const dk = keyOf(name);
        if (dk === payerKey) continue;
        if (isSettled(e.id, name)) continue;
        net[dk] -= share;
        net[payerKey] = (net[payerKey] || 0) + share;
        openTotal += share;
      }
    }

    const balances = people.map((name) => {
      const k = keyOf(name);
      return { name, paid: paid[k] || 0, share: total / n, net: net[k] || 0 };
    }).sort((a, b) => b.net - a.net);

    const debtors = balances.filter((b) => b.net < -0.005).map((b) => ({ name: b.name, amt: -b.net }));
    const creditors = balances.filter((b) => b.net > 0.005).map((b) => ({ name: b.name, amt: b.net }));
    debtors.sort((a, b) => b.amt - a.amt);
    creditors.sort((a, b) => b.amt - a.amt);
    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].amt, creditors[j].amt);
      if (pay >= 0.005) {
        transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: pay });
      }
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt < 0.005) i += 1;
      if (creditors[j].amt < 0.005) j += 1;
    }

    return { people, cards, balances, transfers, skipped, total, openTotal, error: null };
  }

  const MONEY_IC = '<svg class="ic settle-money-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M9.5 9.2c.6-1 1.7-1.5 2.7-1.5 1.3 0 2.3.7 2.3 1.8s-.9 1.5-2.4 1.8-2.6.7-2.6 1.8 1.1 1.8 2.6 1.8c1.1 0 2.1-.5 2.7-1.4"/></svg>';

  let settleView = 'by-expense'; // 'by-expense' | 'total'

  function openSharedActualBudget(ctx) {
    openBudget(ctx, { mode: 'shared', view: 'actual' });
  }

  function openSettle(ctx) {
    const { state } = ctx;
    if (!state.canEdit) return;
    syncSettleButton(state);

    const wrap = shell('settle-modal', 'חלוקת הוצאות', 'מי חייב למי — לפי התקציב המשותף בלבד');
    const body = wrap.querySelector('.mw-body');
    const controls = wrap.querySelector('.mw-controls');

    const cur = curOf(state);

    const openCards = new Set(); // expense ids expanded under their day
    const catEmoji = (key) => (CATS.find((c) => c.key === key) || {}).emoji || '✨';

    const dayLabel = (day) => {
      if (!day) return { title: 'בלי יום', sub: 'הוצאות שלא שויכו ליום במסלול' };
      let sub = '';
      if (state.trip.start_date) {
        const d = new Date(state.trip.start_date);
        d.setDate(d.getDate() + day - 1);
        sub = d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
      }
      return { title: `יום ${day}`, sub };
    };

    function groupByDay(cards) {
      const map = new Map();
      for (const c of cards) {
        const key = c.day_number >= 1 ? c.day_number : 0;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(c);
      }
      return [...map.entries()]
        .sort((a, b) => {
          if (a[0] === 0) return 1;
          if (b[0] === 0) return -1;
          return a[0] - b[0];
        })
        .map(([day, list]) => ({ day: day || null, cards: list, dayTotal: list.reduce((s, c) => s + c.amount, 0) }));
    }

    async function toggleSettled(expenseId, debtorName, currentlySettled) {
      const headers = await ctx.ensureEdit();
      if (!headers) return;
      const code = state.trip.share_code;
      try {
        if (currentlySettled) {
          await TRIPMAKER.api(
            `/api/trips/code/${code}/expenses/${expenseId}/settlements?debtor=${encodeURIComponent(debtorName)}`,
            { method: 'DELETE', headers }
          );
          state.settlements = (state.settlements || []).filter(
            (s) => !(+s.expense_id === +expenseId && String(s.debtor_key || s.debtor_name).trim().toLowerCase() === debtorName.trim().toLowerCase())
          );
        } else {
          const row = await TRIPMAKER.api(`/api/trips/code/${code}/expenses/${expenseId}/settlements`, {
            method: 'POST', headers,
            body: JSON.stringify({ debtor_name: debtorName }),
          });
          state.settlements = [...(state.settlements || []).filter(
            (s) => !(+s.expense_id === +expenseId && String(s.debtor_key).toLowerCase() === String(row.debtor_key).toLowerCase())
          ), row];
        }
        render();
      } catch (e) {
        alert(e.message || 'לא הצלחנו לעדכן');
      }
    }

    function attractionRowHtml(c) {
      const open = openCards.has(String(c.id));
      const payerLine = c.allSettled
        ? 'הכל הוחזר ✓'
        : c.refund > 0.005
          ? `להחזיר עוד ${fmt(c.refund, cur)}`
          : 'מאוזן';
      return `
        <div class="settle-acc${open ? ' open' : ''}${c.allSettled ? ' all-settled' : ''}" data-id="${c.id}">
          <button type="button" class="settle-acc-btn" aria-expanded="${open}">
            <span class="sc-emoji" aria-hidden="true">${catEmoji(c.category)}</span>
            <span class="settle-acc-text">
              <b>${esc(c.title)}</b>
              <small>${esc(c.payerName)} שילם · ${fmt(c.share, cur)} לכל אחד</small>
            </span>
            <span class="settle-acc-amt">${fmt(c.amount, cur)}</span>
            <span class="settle-acc-chev" aria-hidden="true">${BICON.chev}</span>
          </button>
          <div class="settle-acc-panel"${open ? '' : ' hidden'}>
            <div class="settle-card-body">
              <p class="sc-paid"><b>${esc(c.payerName)}</b> שילם על הכל · משותף ${fmt(c.amount, cur)}</p>
              <div class="sc-payer">
                <div class="sb-who">
                  <span class="sb-avatar">${esc((c.payerName.trim()[0] || '?').toUpperCase())}</span>
                  <span class="sb-name">${esc(c.payerName)}</span>
                </div>
                <div class="sb-nums">
                  <span class="sb-role">${c.allSettled ? 'הוחזר' : 'להחזיר'}</span>
                  <span class="sb-net refund">${c.allSettled ? '✓' : fmt(c.refund, cur)}</span>
                </div>
              </div>
              <div class="sc-debtors">
                <div class="sc-debtors-label">${payerLine}</div>
                ${c.debtors.map((d) => `
                  <div class="sc-debtor${d.settled ? ' is-settled' : ''}">
                    <span class="sd-name">${esc(d.name)}</span>
                    <span class="sd-actions">
                      ${d.settled
                        ? `<span class="sd-amt settled">שולם ✓</span>
                           <button type="button" class="settle-paid-btn undo" data-expense="${c.id}" data-debtor="${esc(d.name)}" data-settled="1">ביטול</button>`
                        : `<span class="sd-amt owes">${MONEY_IC}<span>${fmt(d.amount, cur)}</span></span>
                           <button type="button" class="settle-paid-btn" data-expense="${c.id}" data-debtor="${esc(d.name)}" data-settled="0">שולם</button>`}
                    </span>
                  </div>`).join('')}
              </div>
            </div>
          </div>
        </div>`;
    }

    function byDayHtml(result) {
      const cardsByDay = groupByDay(result.cards);
      return `
      <div class="settle-days">
        ${cardsByDay.map(({ day, cards, dayTotal }) => {
          const lab = dayLabel(day);
          return `
            <section class="settle-day">
              <header class="settle-day-head">
                <div class="settle-day-titles">
                  <h3 class="settle-day-title">${esc(lab.title)}</h3>
                  ${lab.sub ? `<p class="settle-day-sub">${esc(lab.sub)}</p>` : ''}
                </div>
                <div class="settle-day-sum">
                  <span class="settle-day-count">${cards.length} הוצאות</span>
                  <span class="settle-day-amt">${fmt(dayTotal, cur)}</span>
                </div>
              </header>
              <div class="settle-acc-list glass">${cards.map(attractionRowHtml).join('')}</div>
            </section>`;
        }).join('')}
      </div>`;
    }

    function totalHtml(result) {
      const balTone = (net) => (net > 0.5 ? 'owed' : net < -0.5 ? 'owes' : 'even');
      const balBlock = (b) => {
        if (Math.abs(b.net) < 0.5) {
          return `<span class="sb-role even">מאוזן</span><span class="sb-net even">—</span>`;
        }
        if (b.net > 0) {
          return `<span class="sb-role refund">להחזיר</span><span class="sb-net refund">${fmt(b.net, cur)}</span>`;
        }
        return `<span class="sb-role owes">נדרש להחזיר</span><span class="sb-net owes">${MONEY_IC}<span>${fmt(-b.net, cur)}</span></span>`;
      };

      return `
        ${result.transfers.length ? `
          <div class="settle-section">
            <h3 class="bp-section-title">מי חייב למי · לכל הטיול</h3>
            <div class="settle-transfers glass">
              ${result.transfers.map((t) => `
                <div class="settle-xfer">
                  <div class="sx-text"><b>${esc(t.from)}</b> משלם ל־<b>${esc(t.to)}</b></div>
                  <span class="sx-amt owes">${MONEY_IC}<span>${fmt(t.amount, cur)}</span></span>
                </div>`).join('')}
            </div>
          </div>` : `
          <div class="settle-even glass">
            <h3>הכל מאוזן 🎉</h3>
            <p>לפי ההחזרים שסומנו — אף אחד לא חייב לאף אחד.</p>
          </div>`}

        <div class="settle-section">
          <h3 class="bp-section-title">מאזן כולל לפי משתתף</h3>
          <div class="settle-balances glass">
            ${result.balances.map((b) => `
              <div class="settle-bal ${balTone(b.net)}">
                <div class="sb-who">
                  <span class="sb-avatar">${esc((b.name.trim()[0] || '?').toUpperCase())}</span>
                  <div class="sb-meta">
                    <span class="sb-name">${esc(b.name)}</span>
                    <span class="sb-paid">שילם ${fmt(b.paid, cur)} · חלק ${fmt(b.share, cur)}</span>
                  </div>
                </div>
                <div class="sb-nums">${balBlock(b)}</div>
              </div>`).join('')}
          </div>
        </div>`;
    }

    function wireInteractions() {
      body.querySelectorAll('.settle-acc-btn').forEach((btn) => {
        btn.onclick = () => {
          const id = String(btn.closest('.settle-acc')?.dataset.id || '');
          if (!id) return;
          if (openCards.has(id)) openCards.delete(id);
          else openCards.add(id);
          render();
        };
      });
      body.querySelectorAll('.settle-paid-btn').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const expenseId = +btn.dataset.expense;
          const debtor = btn.dataset.debtor;
          const settled = btn.dataset.settled === '1';
          if (!expenseId || !debtor) return;
          btn.disabled = true;
          toggleSettled(expenseId, debtor, settled);
        };
      });
    }

    function render() {
      const result = computeSettlement(state);

      if (result.error === 'need_people') {
        controls.innerHTML = '';
        body.innerHTML = `
          <div class="settle-empty glass">
            <div class="settle-locked-ic">${BICON.users}</div>
            <h3>צריך לפחות שני משתתפים</h3>
            <p>החלוקה היא בין משתתפי הטיול על התקציב המשותף. הזמינו מישהו לטיול כדי לחלק הוצאות.</p>
          </div>`;
        return;
      }

      if (result.error === 'no_expenses' || result.error === 'no_payers') {
        controls.innerHTML = '';
        body.innerHTML = `
          <div class="settle-empty glass">
            <div class="settle-locked-ic">${BICON.wallet}</div>
            <h3>${result.error === 'no_payers' ? 'חסר מי שילם' : 'עוד אין הוצאות משותפות'}</h3>
            <p>${result.error === 'no_payers'
              ? 'יש הוצאות בתקציב המשותף, אבל בלי שם משלם — אי אפשר לחלק. מחקו והוסיפו מחדש כשאתם מחוברים, או סמנו שולם ממסך התקציב המשותף.'
              : 'רשמו הוצאות בפועל בתקציב המשותף (מי שילם נשמר אוטומטית). תקציב אישי לא נכנס לחלוקה. אחר כך תחזרו לכאן ותקבלו מי חייב למי.'}</p>
            <button type="button" class="btn btn-amber settle-to-budget">לתקציב המשותף</button>
          </div>`;
        body.querySelector('.settle-to-budget').onclick = () => {
          dismissModal(wrap);
          openSharedActualBudget(ctx);
        };
        return;
      }

      const byExpense = settleView === 'by-expense';
      const skippedNote = result.skipped.length
        ? `${result.skipped.length} הוצאות בלי משלם — לא נכנסו לחלוקה`
        : '';

      controls.innerHTML = `
        <div class="seg seg-sm settle-seg" role="tablist" aria-label="תצוגת חלוקה">
          <button type="button" data-v="by-expense" class="${byExpense ? 'active' : ''}" aria-selected="${byExpense}">לפי יום</button>
          <button type="button" data-v="total" class="${!byExpense ? 'active' : ''}" aria-selected="${!byExpense}">כולל · כל הטיול</button>
        </div>`;
      controls.querySelectorAll('[data-v]').forEach((b) => {
        b.onclick = () => { settleView = b.dataset.v; render(); };
      });

      body.innerHTML = `
        <div class="settle-summary glass">
          <div class="bs-row">
            <span class="bs-label">סה״כ מהתקציב המשותף</span>
            <span class="settle-count">${result.cards.length} הוצאות · ${result.people.length} משתתפים</span>
          </div>
          <div class="bs-figure"><b>${fmt(result.total, cur)}</b><span>≈ ${fmt(result.total / result.people.length, cur)} לאדם</span></div>
          ${result.openTotal > 0.5
            ? `<p class="settle-open">עדיין פתוח להחזר: <b>${fmt(result.openTotal, cur)}</b></p>`
            : `<p class="settle-open ok">כל ההחזרים סומנו כשולמו ✓</p>`}
          <p class="settle-note">${byExpense
            ? 'לוחצים על אטרקציה לפירוט. ליד כל חייב — «שולם» מסמן שההחזר בוצע.'
            : 'סיכום לכל הטיול אחרי סימוני «שולם» — מי עדיין חייב למי.'}</p>
        </div>

        ${byExpense ? byDayHtml(result) : totalHtml(result)}
        ${skippedNote ? `<p class="settle-skipped">${esc(skippedNote)}</p>` : ''}
        <p class="mw-footnote">רוצים לתקן משהו? עדכנו הוצאות בתקציב המשותף ופתחו שוב את החלוקה.</p>
      `;
      if (byExpense) wireInteractions();
    }

    render();
  }

  return {
    openHotels, openBudget, closeBudget, openSettle, syncSettleButton, travelIcon, plannedTotals, plannedByDay,
    budgetButtonState, heroChip, dayHotelLines, uncoveredRuns, fmt, curOf,
    nightCardHtml, mountNightCards, itemCostInfo, setItemPersonalCost, clearItemPersonalCost,
  };
})();
