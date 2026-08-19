// Trip page modals: hotels ("איפה ישנים") + budget ("ניהול תקציב").
// Both operate on the trip.js state object: { trip, items, hotels, budget, expenses, canEdit }.
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

  const esc = (s) => TRIPI.esc(s);
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
      return TRIPI.isoDate(d);
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
      wrap.querySelector('.modal-close').onclick = () => wrap.classList.remove('open');
      wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.classList.remove('open'); });
    }
    wrap.classList.add('open');
    return wrap;
  }

  // =================================================================
  //  HOTELS MODAL
  // =================================================================

  function openHotels(ctx, opts = {}) {
    const { state } = ctx;
    const wrap = shell('hotels-modal', '🏨 איפה ישנים?', 'לילה 3 = הלילה שאחרי יום 3');
    const body = wrap.querySelector('.mw-body');
    wrap.querySelector('.mw-controls').innerHTML = '';
    let formState = null; // null | {editing: hotel|null, night_from, night_to}

    if (nightCount(state) === 0) {
      body.innerHTML = '<div class="empty-day">טיול של יום אחד — ישנים בבית 🙂</div>';
      return;
    }

    function nightLabel(n) { return `לילה ${n} (אחרי יום ${n})`; }

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
            <a target="_blank" rel="noopener" href="${esc(TRIPI.mapsSearchUrl(h.name + (block ? ' ' + block.name : '')))}">${HICON.pin} מפה</a>
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
            const updated = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/hotels/${h.id}`, {
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
            await TRIPI.api(`/api/trips/code/${state.trip.share_code}/hotels/${b.dataset.id}`, { method: 'DELETE', headers });
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
          TRIPI.track('hotel_link_click', {
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
            <div class="field"><label>מאיזה לילה?</label><select class="hf-from">${opts(formState.from)}</select></div>
            <div class="field"><label>עד איזה לילה?</label><select class="hf-to">${opts(formState.to)}</select></div>
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
            <div class="field span-2"><label>הערות</label>
              <input type="text" class="hf-note" maxlength="300" placeholder="מספר אישור, שעת צ'ק-אין, קומה גבוהה בבקשה 🙏" value="${esc(h && h.note ? h.note : '')}"></div>
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
          note: slot.querySelector('.hf-note').value.trim() || null,
          stars: picked.stars ?? null, lat: picked.lat ?? null, lon: picked.lon ?? null,
        };
        try {
          if (h) {
            const updated = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/hotels/${h.id}`, {
              method: 'PUT', headers, body: JSON.stringify(payload),
            });
            Object.assign(h, updated);
          } else {
            const created = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/hotels`, {
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
  };

  const dm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');

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
      hotel.price_total ? fmt(hotel.price_total, curOf(state)) : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="night-booked" style="border-inline-start-color:${color}">
        <span style="color:${color}">${NC_ICON.bed}</span>
        <div class="nb-text">
          <div class="nb-name">לילה ${night} · ${esc(hotel.name)}</div>
          ${meta ? `<div class="nb-meta">${meta}</div>` : ''}
        </div>
        <button type="button" class="nb-edit" data-open-night="${night}">שינוי</button>
      </div>`;
  }

  // The rail starts as placeholders; mountNightCards fills it when the card
  // comes near the viewport, so a 14-night trip doesn't fire 13 lookups on load.
  function nightCardHtml(state, night) {
    if (night < 1 || night > nightCount(state)) return '';
    const booked = nightCoverage(state)[night];
    if (booked) return bookedNightHtml(state, night, booked);

    const anchor = nightAnchor(state, night);
    const hint = anchor && anchor.after
      ? `היום מסתיים ב${esc(anchor.after)} — אלה המלונות הקרובים ביותר`
      : `מלונות ב${esc((anchor && anchor.area) || state.trip.destination || '')}`;

    return `
      <div class="night-card" data-night="${night}">
        <div class="nc-head">
          ${NC_ICON.moon}
          <span class="nc-title">לילה ${night} — איפה ישנים?</span>
          ${anchor && anchor.area ? `<span class="nc-where">${esc(anchor.area)}</span>` : ''}
        </div>
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
    TRIPI.track('night_card_prices', { trip_id: state.trip.id, night, asked: ids.length, priced });
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
      <div class="hs-loading">טוען פרטים…</div>`;

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

    TRIPI.track('hotel_sheet_open', { trip_id: state.trip.id, night, provider: hotel.provider || null });
  }

  // Wires every night card the itinerary just painted. Safe to call after each
  // re-render: cards are matched by night and each fills itself once.
  function mountNightCards(ctx, container) {
    const { state } = ctx;

    container.querySelectorAll('[data-open-night]').forEach((b) => {
      b.onclick = () => openHotels(ctx, { addNight: +b.dataset.openNight });
    });
    const fill = async (el) => {
      if (el.dataset.loaded) return;
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
      TRIPI.track('night_card_shown', {
        trip_id: state.trip.id, night, count: picked.length,
        provider: picked[0].provider || null, with_photo: picked.filter((h) => h.thumb || h.photo).length,
      });

      loadPrices(state, night, picked, rail);

      // the tile itself opens the sheet; the save button inside it must not
      const openSheet = (tile) => {
        const h = picked[+tile.dataset.i];
        if (h) openHotelSheet(ctx, night, h);
      };
      rail.querySelectorAll('.nc-hotel[data-detail]').forEach((tile) => {
        tile.addEventListener('click', (e) => { if (!e.target.closest('.nc-save')) openSheet(tile); });
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
            const created = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/hotels`, {
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
            TRIPI.track('night_card_save_idea', { trip_id: state.trip.id, night });
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
  //  A full page, not a modal: it rides the URL hash (#budget /
  //  #budget-settings) so the browser and phone back buttons walk out
  //  of it naturally — and settings is a sub-page, not an inline div.
  // =================================================================

  const budgetView = { mode: 'shared', view: 'plan', filter: null, openDays: new Set(), showSettings: false, skippedSetup: false };
  let budgetRender = null; // the open page's render(), so popstate can repaint it

  // stroke icons for the page controls — inherit currentColor like every .ic
  const BICON = {
    back: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    users: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    lock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  };

  // hash → screen: the back buttons only ever call history.back(); this listener
  // is the single place that opens, closes and repaints the page afterwards
  window.addEventListener('popstate', () => {
    const page = document.getElementById('budget-page');
    if (!page || !budgetRender) return;
    if (location.hash === '#budget' || location.hash === '#budget-settings') {
      budgetView.showSettings = location.hash === '#budget-settings';
      page.classList.add('open');
      document.body.classList.add('budget-open');
      budgetRender();
      page.scrollTop = 0;
    } else {
      page.classList.remove('open');
      document.body.classList.remove('budget-open');
    }
  });

  const personalKey = (state) => 'tripi_personal_budget_' + state.trip.share_code;
  function loadPersonal(state) {
    try {
      const p = JSON.parse(localStorage.getItem(personalKey(state)) || 'null');
      return p && typeof p === 'object' ? { total: +p.total || null, expenses: Array.isArray(p.expenses) ? p.expenses : [] } : { total: null, expenses: [] };
    } catch { return { total: null, expenses: [] }; }
  }
  function savePersonal(state, p) {
    try { localStorage.setItem(personalKey(state), JSON.stringify(p)); return true; }
    catch { return false; }
  }

  function currentTripDay(state) {
    if (!state.trip.start_date) return null;
    const diff = Math.floor((Date.now() - new Date(state.trip.start_date).getTime()) / 86400000) + 1;
    return diff >= 1 && diff <= state.trip.days ? diff : null;
  }

  function ringSvg(pct, colorVar, centerTop, centerBottom) {
    const r = 62, c = 2 * Math.PI * r;
    const fill = Math.min(Math.max(pct || 0, 0), 1);
    return `
      <div class="ring-wrap">
        <svg viewBox="0 0 150 150" class="budget-ring" aria-hidden="true">
          <circle cx="75" cy="75" r="${r}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="11"/>
          <circle cx="75" cy="75" r="${r}" fill="none" stroke="${colorVar}" stroke-width="11"
            stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - fill)}"
            transform="rotate(-90 75 75)"/>
        </svg>
        <div class="ring-center">
          <div class="rc-top">${centerTop}</div>
          ${centerBottom ? `<div class="rc-bottom">${centerBottom}</div>` : ''}
        </div>
      </div>`;
  }

  function openBudget(ctx) {
    const { state } = ctx;
    let page = document.getElementById('budget-page');
    if (!page) {
      page = document.createElement('div');
      page.id = 'budget-page';
      page.className = 'budget-page';
      page.innerHTML = `
        <div class="bp-head">
          <button type="button" class="bp-back" aria-label="חזרה">${BICON.back}<span>חזרה</span></button>
          <h2 class="bp-title"></h2>
        </div>
        <div class="bp-inner">
          <div class="bp-controls"></div>
          <div class="bp-body"></div>
        </div>`;
      document.body.appendChild(page);
      page.querySelector('.bp-back').onclick = () => history.back();
    }
    const body = page.querySelector('.bp-body');
    const controls = page.querySelector('.bp-controls');

    budgetView.showSettings = false;
    page.classList.add('open');
    document.body.classList.add('budget-open');
    page.scrollTop = 0;
    // one clean history entry per open — a reload that kept the hash is normalized first
    if (location.hash === '#budget' || location.hash === '#budget-settings') {
      history.replaceState(null, '', location.pathname + location.search);
    }
    history.pushState(null, '', '#budget');

    const dToday = currentTripDay(state);
    if (dToday && !budgetView.openDays.size) budgetView.openDays.add(dToday);

    function openSettings() {
      budgetView.showSettings = true;
      history.pushState(null, '', '#budget-settings');
      render();
      page.scrollTop = 0;
    }

    function render() {
      const cur = curOf(state);
      const personal = loadPersonal(state);
      const isPersonal = budgetView.mode === 'personal';
      // a draft is all planning — there's no "בפועל" yet, so that view (and the
      // toggle to reach it) only exists once the trip is published
      const isDraft = !!state.trip.is_draft;
      if (isDraft) budgetView.view = 'plan';
      const isActual = budgetView.view === 'actual';
      page.querySelector('.bp-title').textContent = budgetView.showSettings ? 'הגדרות תקציב' : '💰 התקציב של הטיול';
      if (budgetView.showSettings) { renderSettings(cur, personal, isPersonal); return; }
      const planned = plannedTotals(state);
      const travelers = (state.budget && state.budget.travelers) || 1;

      controls.innerHTML = `
        <div class="seg bm-mode">
          <button type="button" data-v="shared" class="${!isPersonal ? 'active' : ''}">${BICON.users} משותף</button>
          <button type="button" data-v="personal" class="${isPersonal ? 'active' : ''}">${BICON.lock} אישי</button>
        </div>
        <div class="mode-hint">${isPersonal ? 'נשמר רק בדפדפן הזה — רק אתם רואים' : 'כל משתתפי הטיול רואים ועורכים'}</div>
        ${isDraft ? '' : `
        <div class="seg bm-view">
          <button type="button" data-v="plan" class="${budgetView.view === 'plan' ? 'active' : ''}">תכנון</button>
          <button type="button" data-v="actual" class="${budgetView.view === 'actual' ? 'active' : ''}">בפועל</button>
        </div>`}`;
      controls.querySelectorAll('.bm-mode button').forEach((b) => {
        b.onclick = () => { budgetView.mode = b.dataset.v; render(); };
      });
      controls.querySelectorAll('.bm-view button').forEach((b) => {
        b.onclick = () => { budgetView.view = b.dataset.v; render(); };
      });

      // ---- setup states ----
      if (!isPersonal && !state.budget && !budgetView.skippedSetup) {
        body.innerHTML = `
          <div class="budget-setup">
            <h3>כמה הטיול הזה הולך לעלות? 🤔</h3>
            <p>קבעו תקציב, פזרו הערכות על הימים, ותדעו לפני כולם.</p>
            <div class="form-grid">
              <div class="field span-2"><label>תקציב כולל</label>
                <div class="money-field">
                  <input type="number" min="0" class="bs-total" placeholder="10,000">
                  <select class="bs-cur" aria-label="מטבע">
                    ${Object.keys(CURRENCIES).map((c) => `<option value="${c}"${c === 'ILS' ? ' selected' : ''}>${CURRENCIES[c]} ${c}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="field span-2"><label>כמה מטיילים?</label>
                <div class="stepper"><button type="button" class="step-btn bs-minus">−</button>
                <input type="number" class="bs-trav" value="2" min="1" max="50">
                <button type="button" class="step-btn bs-plus">+</button></div></div>
            </div>
            <div class="form-error bs-err"></div>
            <button type="button" class="btn btn-amber btn-lg bs-go" style="width:100%;justify-content:center">יאללה, קובעים תקציב 💪</button>
            <button type="button" class="manual-link bs-skip">אפשר גם בלי תקציב — סתם לסמן מחירים על תחנות ולראות סכום</button>
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
            state.budget = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/budget`, {
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
      if (isPersonal && personal.total == null && !personal.expenses.length) {
        body.innerHTML = `
          <div class="budget-setup">
            <h3>תקציב אישי — רק שלכם 🔒</h3>
            <p>שימו לב: נשמר בדפדפן הזה בלבד. מחליפים מכשיר — הוא לא עובר.</p>
            <div class="field"><label>התקציב שלי (${sym(cur)})</label><input type="number" min="0" class="bp-total" placeholder="למשל: 4,000"></div>
            <div class="form-error bp-err"></div>
            <button type="button" class="btn btn-amber btn-lg bp-go" style="width:100%;justify-content:center">קביעת תקציב אישי</button>
          </div>`;
        body.querySelector('.bp-go').onclick = () => {
          const v = +body.querySelector('.bp-total').value;
          if (!(v > 0)) { body.querySelector('.bp-err').textContent = 'כמה? צריך סכום'; return; }
          if (!savePersonal(state, { total: v, expenses: [] })) {
            body.querySelector('.bp-err').textContent = 'הדפדפן חוסם שמירה מקומית — תקציב אישי לא זמין כאן 🙈';
            return;
          }
          render();
        };
        return;
      }

      // ---- computed headline ----
      const actual = actualTotals(isPersonal ? personal.expenses : state.expenses);
      const plannedValue = isPersonal ? planned.total / Math.max(travelers, 1) : planned.total;
      const value = budgetView.view === 'plan' ? plannedValue : actual.total;
      const cap = isPersonal ? personal.total : (state.budget ? +state.budget.total || null : null);
      const pct = cap ? value / cap : 0;
      const color = !cap ? 'var(--mint)' : pct > 1 ? 'var(--danger)' : pct >= 0.8 ? 'var(--amber)' : 'var(--mint)';
      let caption;
      if (!cap) caption = budgetView.view === 'plan' ? 'סה"כ מתוכנן (בלי תקרה)' : 'סה"כ הוצאות (בלי תקרה)';
      else if (pct > 1) caption = `חריגה של ${Math.round((pct - 1) * 100)}% מהתקציב 😅`;
      else if (pct >= 0.8) caption = `נשאר לכם רק ${Math.round((1 - pct) * 100)}% מהתקציב 👀`;
      else caption = `מתוך ${fmt(cap, cur)} · נשאר ${fmt(cap - value, cur)}`;

      const catTotals = budgetView.view === 'plan'
        ? (isPersonal ? Object.fromEntries(Object.entries(planned.byCat).map(([k, v]) => [k, v / Math.max(travelers, 1)])) : planned.byCat)
        : actual.byCat;
      const maxCat = Math.max(...Object.values(catTotals), 1);
      const hasCosts = Object.values(catTotals).some((v) => v > 0);

      body.innerHTML = `
        <div class="ring-section">
          ${ringSvg(cap ? pct : (value > 0 ? 1 : 0), color, fmt(value, cur), caption)}
          ${!isPersonal && travelers > 1 && value > 0 ? `<div class="per-person">≈ ${fmt(value / travelers, cur)} לאדם <button type="button" class="pp-edit">(${travelers} מטיילים)</button></div>` : ''}
          <button type="button" class="bm-settings-btn" title="הגדרות תקציב" aria-label="הגדרות תקציב">${BICON.gear}</button>
        </div>
        ${hasCosts ? `<div class="cat-bars">${CATS.map((c) => {
          const v = catTotals[c.key] || 0;
          if (!v) return '';
          return `
          <button type="button" class="cat-bar${budgetView.filter === c.key ? ' active' : ''}" data-cat="${c.key}">
            <span class="cb-label">${c.emoji} ${c.key}</span>
            <span class="cb-track"><span class="cb-fill" style="width:${Math.round((v / maxCat) * 100)}%"></span></span>
            <span class="cb-amount">${fmt(v, cur)}</span>
          </button>`;
        }).join('')}</div>` : (budgetView.view === 'plan' && !isPersonal ? '<div class="mw-footnote">לחצו על ₪ — ליד כל תחנה כדי להוסיף הערכה ✍️</div>' : '')}
        ${budgetView.filter ? `<button type="button" class="day-tab clear-filter">סינון: ${esc(budgetView.filter)} ✕</button>` : ''}
        ${isActual ? `
        <div class="qa-row">
          <input type="number" min="0" class="qa-amount" placeholder="${sym(cur)} סכום">
          <input type="text" class="qa-title" maxlength="160" placeholder="על מה? ראמן ששווה כל שקל 🍜">
          <select class="qa-cat">${CATS.map((c) => `<option value="${c.key}"${c.key === 'אחר' ? ' selected' : ''}>${c.emoji} ${c.key}</option>`).join('')}</select>
          <select class="qa-day"><option value="">בלי יום</option>${Array.from({ length: state.trip.days }, (_, i) =>
            `<option value="${i + 1}"${dToday === i + 1 ? ' selected' : ''}>יום ${i + 1}</option>`).join('')}</select>
          <button type="button" class="btn btn-amber qa-add">הוספה</button>
        </div>
        <div class="qa-hint">${isPersonal ? 'הוצאה אישית — נשמרת רק אצלכם' : 'הוצאה בפועל — נכנסת ל"בפועל" של כולם'}</div>` : ''}
        ${isPersonal
          ? (isActual ? personalListHtml(personal, cur) : '<div class="mw-footnote">ההערכות מנוהלות במצב 👥 משותף — כאן רואים כמה מהתכנון נופל עליכם</div>')
          : dayAccordionHtml(cur)}
        ${!state.canEdit && !isPersonal ? '<div class="mw-footnote">רק משתתפי הטיול עורכים את התקציב — בקשו קישור הזמנה מהמארגנים</div>' : ''}
      `;

      // ---- wiring ----
      body.querySelector('.bm-settings-btn').onclick = openSettings;
      body.querySelector('.pp-edit')?.addEventListener('click', openSettings);
      body.querySelectorAll('.cat-bar').forEach((b) => {
        b.onclick = () => { budgetView.filter = budgetView.filter === b.dataset.cat ? null : b.dataset.cat; render(); };
      });
      body.querySelector('.clear-filter')?.addEventListener('click', () => { budgetView.filter = null; render(); });

      const qaAdd = body.querySelector('.qa-add');
      if (qaAdd) qaAdd.onclick = async (e) => {
        const btn = e.currentTarget; // currentTarget is null after an await
        const amount = +body.querySelector('.qa-amount').value;
        const title = body.querySelector('.qa-title').value.trim();
        const err = (m) => { body.querySelector('.qa-hint').innerHTML = `<span style="color:var(--danger)">${m}</span>`; };
        if (!(amount > 0)) return err('חסר סכום');
        if (!title) return err('על מה הוצאתם?');
        const expense = {
          title, amount,
          category: body.querySelector('.qa-cat').value,
          day_number: +body.querySelector('.qa-day').value || null,
        };
        if (isPersonal) {
          personal.expenses.unshift({ ...expense, ts: Date.now() });
          if (!savePersonal(state, personal)) return err('הדפדפן חוסם שמירה מקומית 🙈');
          render();
          return;
        }
        if (btn.disabled) return;
        const headers = await ctx.ensureEdit();
        if (!headers) return;
        btn.disabled = true;
        try {
          const created = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/expenses`, {
            method: 'POST', headers, body: JSON.stringify(expense),
          });
          state.expenses.unshift(created);
          render(); ctx.refresh();
        } catch (ex) { err(ex.message); btn.disabled = false; }
      };

      wireLists(cur, personal, isPersonal);
    }

    // settings sub-page: swaps the whole screen (back = history.back(), like the
    // page itself) — holds the total+currency form and the "אפס תקציב" action
    function renderSettings(cur, personal, isPersonal) {
      controls.innerHTML = '';
      const resetRow = (hint) => `
        <div class="bp-danger">
          <button type="button" class="btn btn-danger st-reset">אפס תקציב</button>
          <span class="bp-danger-hint">${hint}</span>
        </div>`;
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
          <div class="bm-settings glass">
            <div class="field"><label>התקציב האישי שלי (${sym(cur)})</label>
              <input type="number" min="0" class="st-ptotal" value="${personal.total || ''}"></div>
            <button type="button" class="btn btn-amber st-save" style="width:100%;justify-content:center">שמירה</button>
          </div>
          ${resetRow('מוחק את התקציב וההוצאות האישיות ששמורים בדפדפן הזה')}`;
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
        <div class="bm-settings glass">
          <div class="form-grid">
            <div class="field span-2"><label>תקציב כולל</label>
              <div class="money-field">
                <input type="number" min="0" class="st-total" value="${b.total ? Math.round(+b.total) : ''}" placeholder="בלי תקרה">
                <select class="st-cur" aria-label="מטבע">
                  ${Object.keys(CURRENCIES).map((c) => `<option value="${c}"${c === b.currency ? ' selected' : ''}>${CURRENCIES[c]} ${c}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="field span-2"><label>כמה מטיילים?</label>
              <div class="stepper"><button type="button" class="step-btn st-minus">−</button>
              <input type="number" class="st-trav" value="${b.travelers}" min="1" max="50">
              <button type="button" class="step-btn st-plus">+</button></div></div>
          </div>
          <div class="form-error st-err"></div>
          <button type="button" class="btn btn-amber st-save" style="width:100%;justify-content:center">שמירת הגדרות</button>
        </div>
        ${resetRow('מוחק את התקרה, המטבע ומספר המטיילים — ההערכות על התחנות וההוצאות נשארות')}`;
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
          state.budget = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/budget`, {
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
        await TRIPI.api(`/api/trips/code/${state.trip.share_code}/budget`, { method: 'DELETE', headers });
        state.budget = null;
        budgetView.skippedSetup = false;
        ctx.refresh();
        history.back();
      });
    }

    function personalListHtml(personal, cur) {
      const list = personal.expenses.filter((e) => !budgetView.filter || e.category === budgetView.filter);
      if (!list.length) return '<div class="empty-day">עוד אין הוצאות אישיות — מוסיפים למעלה ⤴</div>';
      return `<div class="expense-list">${list.map((e, i) => `
        <div class="expense-row">
          <span class="er-cat">${(CATS.find((c) => c.key === e.category) || CATS[5]).emoji}</span>
          <span class="er-title">${esc(e.title)}${e.day_number ? ` <small>· יום ${e.day_number}</small>` : ''}</span>
          <span class="er-amount">${fmt(e.amount, cur)}</span>
          <button type="button" class="er-del" data-i="${i}">✕</button>
        </div>`).join('')}</div>`;
    }

    function dayAccordionHtml(cur) {
      // each view owns its own rows: תכנון = estimates + booked hotels, בפועל = real expenses
      const isActual = budgetView.view === 'actual';
      const byDay = isActual ? actualByDay(state.expenses) : plannedByDay(state);
      const blocks = destBlocks(state);
      const rows = [];
      const generalExp = isActual ? state.expenses.filter((e) => !e.day_number || e.day_number > state.trip.days) : [];
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
        <div class="bday${open ? ' open' : ''}" data-day="${d}">
          <button type="button" class="bday-head">
            <span class="bd-caret">${open ? '▾' : '◂'}</span>
            <span class="bd-title">יום ${d}${block ? ` · ${esc(block.name)}` : ''}</span>
            <span class="bd-total">${byDay[d] ? fmt(byDay[d], cur) : ''}</span>
          </button>
          ${open ? `<div class="bday-body">
            ${items.map((it) => `
              <div class="bitem-row${it.category === 'נסיעה' ? ' travel' : ''}">
                ${it.time_label ? `<span class="bi-time">${esc(it.time_label)}</span>` : ''}
                <span class="bi-title">${it.category === 'נסיעה' ? travelIcon(it) + ' ' : ''}${esc(it.title)}</span>
                ${state.canEdit
                  ? `<input type="number" min="0" class="cost-input" data-item="${it.id}" placeholder="הערכה" value="${it.cost ? Math.round(+it.cost) : ''}" title="עלות משוערת (${sym(cur)})">`
                  : `<span class="bi-cost">${it.cost ? fmt(it.cost, cur) : `${sym(cur)} —`}</span>`}
              </div>`).join('')}
            ${hotels.map((h) => {
              const nights = h.night_end - h.night_start + 1;
              return `<button type="button" class="bhotel-row" data-open-hotels>
                🏨 ${esc(h.name)} · ${nights === 1 ? 'לילה אחד' : nights + ' לילות'}${h.price_total ? ` · ${fmt(+h.price_total / nights, cur)} ללילה בממוצע` : ''}
              </button>`;
            }).join('')}
            ${exps.map((e) => `
              <div class="expense-row">
                <span class="er-cat">💸</span>
                <span class="er-title">${esc(e.title)}${e.paid_by ? ` <small>· ${esc(e.paid_by)}</small>` : ''}</span>
                <span class="er-amount">${fmt(e.amount, cur)}</span>
                ${state.canEdit ? `<button type="button" class="er-del" data-id="${e.id}">✕</button>` : ''}
              </div>`).join('')}
            ${!items.length && !hotels.length && !exps.length ? `<div class="empty-day" style="padding:8px">${isActual ? 'יום בלי הוצאות' : 'יום בלי הערכות'}</div>` : ''}
          </div>` : ''}
        </div>`);
      }
      const generalHtml = generalExp.length && (!budgetView.filter || generalExp.some((e) => e.category === budgetView.filter)) ? `
        <div class="bday open">
          <div class="bday-head" style="cursor:default"><span class="bd-title">הוצאות כלליות</span></div>
          <div class="bday-body">${generalExp
            .filter((e) => !budgetView.filter || e.category === budgetView.filter)
            .map((e) => `
            <div class="expense-row">
              <span class="er-cat">💸</span>
              <span class="er-title">${esc(e.title)}${e.paid_by ? ` <small>· ${esc(e.paid_by)}</small>` : ''}</span>
              <span class="er-amount">${fmt(e.amount, cur)}</span>
              ${state.canEdit ? `<button type="button" class="er-del" data-id="${e.id}">✕</button>` : ''}
            </div>`).join('')}</div>
        </div>` : '';
      return `<div class="bday-list">${rows.join('')}${generalHtml}</div>`;
    }

    function wireLists(cur, personal, isPersonal) {
      body.querySelectorAll('.bday-head').forEach((h) => {
        const day = +h.closest('.bday').dataset.day;
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
            const updated = await TRIPI.api(`/api/trips/code/${state.trip.share_code}/items/${it.id}`, {
              method: 'PATCH', headers, body: JSON.stringify({ cost: inp.value || null }),
            });
            it.cost = updated.cost;
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
            await TRIPI.api(`/api/trips/code/${state.trip.share_code}/expenses/${b.dataset.id}`, { method: 'DELETE', headers });
            state.expenses = state.expenses.filter((e) => e.id !== +b.dataset.id);
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

  return { openHotels, openBudget, travelIcon, plannedTotals, plannedByDay, budgetButtonState, heroChip, dayHotelLines, uncoveredRuns, fmt, curOf, nightCardHtml, mountNightCards };
})();
