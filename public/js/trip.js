// Trip page: loads a trip by its 6-digit share code from the URL (/trip/123456).
(() => {
  const code = location.pathname.split('/').pop();

  const heDate = (d) => d ? new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' }) : null;

  // on a phone the description clamps to 2 lines (CSS) so the itinerary is visible
  // without scrolling on first paint; the toggle only appears if text actually overflows
  function setupDescToggle() {
    const textEl = document.getElementById('trip-desc-text');
    const toggleEl = document.getElementById('trip-desc-toggle');
    if (!textEl || !toggleEl) return;
    const sync = () => {
      textEl.classList.remove('expanded');
      toggleEl.textContent = 'הצג עוד';
      const overflows = textEl.scrollHeight > textEl.clientHeight + 1;
      toggleEl.classList.toggle('show', overflows);
    };
    toggleEl.onclick = () => {
      const expanded = textEl.classList.toggle('expanded');
      toggleEl.textContent = expanded ? 'הצג פחות' : 'הצג עוד';
    };
    sync();
    window.addEventListener('resize', sync);
  }

  // edit rights: trip participants (owner included). A ?join=TOKEN invite link makes
  // a visitor a participant-in-waiting — the token is stashed per-trip so it survives
  // the register/login round trip, and is redeemed the moment there's a logged-in user.
  const savedInvites = JSON.parse(localStorage.getItem('tripi_invites') || '{}');
  const urlToken = new URLSearchParams(location.search).get('join');
  if (urlToken) {
    savedInvites[code] = urlToken;
    localStorage.setItem('tripi_invites', JSON.stringify(savedInvites));
    history.replaceState(null, '', location.pathname); // the token shouldn't linger in the address bar
  }
  let inviteToken = savedInvites[code] || null;

  // A long trip is calendar-only, for everyone, so the list-shaped placeholder in the
  // HTML is the wrong shape for it. The server marks the day count on the container for
  // exactly those trips — enough to lay the month grid out before the fetch, with no
  // guessing about who's looking.
  (function calendarPlaceholder() {
    const container = document.getElementById('days-container');
    const days = +container.dataset.sklDays;
    if (!days) return;
    const dow = container.dataset.sklDow; // weekday of day 1 — absent on trips without dates
    const areaCount = +container.dataset.sklAreas || 0; // destinations, when the trip has more than one
    const area = areaCount ? '<span class="cc-area"><span class="skl skl-cc-area"></span></span>' : '';
    // a month cell shows at most three stops, then a "+N more" line
    const cells = Array.from({ length: days }, (_, i) => `
      <div class="cal-cell skl-cell${area ? ' has-area' : ''}"${i === 0 && dow ? ` style="grid-column-start:${+dow + 1}"` : ''}>
        <span class="cc-head"><span class="skl skl-cc-num"></span></span>
        ${area}
        <span class="cc-evts">
          ${'<span class="skl skl-cc-evt"></span>'.repeat(3)}
          <span class="cc-more"><span class="skl skl-cc-more"></span></span>
        </span>
        <span class="cc-dots">${'<i></i>'.repeat(3)}</span>
      </div>`).join('');
    container.innerHTML = `
      <div class="cal-wrap">
        <div class="cal-toolbar">
          <span class="skl skl-cal-seg"></span>
          <span class="cal-title"><span class="skl skl-cal-title"></span></span>
          <span class="skl skl-cal-fs"></span>
        </div>
        <div class="cal-body">
          ${areaCount ? `<div class="cal-legend skl-legend">${
            '<span class="cl-item"><i class="skl"></i><span class="skl skl-cl-name"></span></span>'.repeat(areaCount)
          }</div>` : ''}
          ${dow ? `<div class="cal-dow-row skl-dow-row">${'<span class="skl skl-cal-dow"></span>'.repeat(7)}</div>` : ''}
          <div class="cal-grid">${cells}</div>
          <div class="cal-hint"><span class="skl skl-cal-hint"></span></div>
        </div>
      </div>`;
  })();

  let editMode = false;
  let canEditHeaders = null; // truthy = edit calls allowed (auth rides on the JWT)

  function forgetInvite() {
    inviteToken = null;
    delete savedInvites[code];
    localStorage.setItem('tripi_invites', JSON.stringify(savedInvites));
  }

  // one shot per token: joined or rejected, it's no longer pending
  async function redeemInvite() {
    if (!inviteToken || !TRIPI.user) return false;
    try {
      await TRIPI.api('/api/trips/code/' + encodeURIComponent(code) + '/join', {
        method: 'POST', body: JSON.stringify({ token: inviteToken }),
      });
      forgetInvite();
      return true;
    } catch {
      forgetInvite(); // stale or regenerated token — stop offering it
      return false;
    }
  }

  // the route loader plays at least one beat before fading out, so a fast
  // response doesn't flash it on and off
  const loaderT0 = Date.now();
  function hideTripLoader() {
    const el = document.getElementById('trip-loader');
    if (!el) return;
    setTimeout(() => {
      el.classList.add('done');
      setTimeout(() => el.remove(), 500);
    }, Math.max(0, 1200 - (Date.now() - loaderT0)));
  }

  async function load() {
    // an invite link + a logged-in user = redeem first, so the page arrives unlocked
    if (TRIPI.user && inviteToken) await redeemInvite();
    let data;
    try {
      data = await TRIPI.api('/api/trips/code/' + encodeURIComponent(code));
    } catch {
      hideTripLoader();
      document.querySelector('.trip-hero').style.display = 'none';
      document.querySelector('.action-bar').style.display = 'none';
      document.getElementById('trip-layout').style.display = 'none';
      document.getElementById('not-found').style.display = '';
      return;
    }
    hideTripLoader();
    const { trip, items, isOwner } = data;
    const isAdmin = !!data.isAdmin; // admins edit any trip
    const canEdit = !!data.canEdit;
    let participants = data.participants || [];
    editMode = canEdit; // participants edit inline — there's no separate mode to enter

    document.title = `${trip.title} · TRIP MAKER`;
    if (trip.cover_image) {
      document.getElementById('trip-cover').style.backgroundImage = `url('${trip.cover_image.replace(/'/g, '')}')`;
    }
    // flags render per-platform (emoji mobile / SVG desktop) from the trip's
    // destination countries — never baked into the stored title text
    const tripFlags = [...new Set(
      (Array.isArray(trip.destinations) ? trip.destinations : [])
        .concat(trip.country ? [{ country: trip.country }] : [])
        .map((d) => d.cc || COUNTRIES.ccByName(d.country || d.name))
        .filter(Boolean)
    )].map((cc) => COUNTRIES.flagHtml(cc)).join(' ');
    document.getElementById('trip-title').innerHTML =
      `${trip.emoji || '🧭'} ${TRIPI.esc(trip.title)}${tripFlags ? ' ' + tripFlags : ''}`;

    const meta = [];
    meta.push(`<span class="chip"><span class="dot">●</span> ${TRIPI.esc(trip.destination)}${trip.country ? ', ' + TRIPI.esc(trip.country) : ''}</span>`);
    meta.push(`<span class="chip"><span class="dot">●</span> ${trip.days} ימים</span>`);
    if (trip.start_date) {
      const range = trip.end_date ? `${heDate(trip.start_date)} – ${heDate(trip.end_date)}` : heDate(trip.start_date);
      meta.push(`<span class="chip"><span class="dot">●</span> ${range}</span>`);
    }
    // the code is minted at creation but only revealed once planning is finished —
    // applyDraftState() keeps this chip hidden until then
    meta.push(`<span class="chip copyable" id="code-chip" dir="ltr" title="לחיצה מעתיקה את קוד הטיול"
      data-copy="${trip.share_code}" style="letter-spacing:.2em;color:var(--amber)">#${trip.share_code}</span>`);
    document.getElementById('trip-meta').innerHTML = meta.join('');

    document.getElementById('trip-layout').style.display = '';
    // re-rendered when an AI edit rewrites a description the change made untrue
    function renderDesc() {
      document.getElementById('trip-desc').innerHTML =
        `<div class="trip-desc-text" id="trip-desc-text">${
          trip.description ? TRIPI.esc(trip.description) : 'עוד אין תיאור לטיול הזה — אבל המסלול מדבר בעד עצמו 🙂'
        }</div>` +
        `<button type="button" class="trip-desc-toggle" id="trip-desc-toggle" hidden>הצג עוד</button>`;
      setupDescToggle();
    }
    renderDesc();

    // itinerary grouped by day (weatherByDate is filled by loadWeather when dates align)
    let tripItems = items.slice();
    let weatherByDate = {};
    // one-level AI-edit undo: {snap, snapDesc} while the last smart edit is reversible.
    // Any manual mutation clears it — the snapshot no longer describes what's on screen.
    let aiUndo = null;

    // ---- stop votes (experimental group mode): one thumbs-up/down per participant
    // per stop. Solo planners never see it — a ballot with one voter is noise. ----
    const votesOn = canEdit && participants.length > 1;
    let votesByItem = {}; // item_id → {up, down, my_vote}
    if (votesOn) {
      TRIPI.api(`/api/trips/code/${trip.share_code}/votes`).then((rows) => {
        votesByItem = Object.fromEntries(rows.map((r) => [r.item_id, r]));
        if (rows.length) renderItinerary();
      }).catch(() => {});
    }

    // shared state for the hotels/budget modals (trip-modals.js) and the ambient UI
    const state = {
      trip,
      hotels: data.hotels || [],
      budget: data.budget || null,
      expenses: data.expenses || [],
      canEdit: !!data.canEdit,
    };
    Object.defineProperty(state, 'items', { get: () => tripItems });
    canEditHeaders = canEdit ? {} : null;
    const container = document.getElementById('days-container');
    const tripDests = Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [];
    const multiDest = () => tripDests.length > 1;

    // same default rule as the wizard: last stop of the day, else the closest previous day's last stop
    function defaultAreaForDay(day) {
      const same = tripItems.filter((it) => it.day_number === day);
      if (same.length) return same[same.length - 1].area || tripDests[0]?.name;
      for (let d = day - 1; d >= 1; d--) {
        const prev = tripItems.filter((it) => it.day_number === d);
        if (prev.length) return prev[prev.length - 1].area || tripDests[0]?.name;
      }
      return tripDests[0]?.name;
    }

    const dayDate = (day) => {
      if (!trip.start_date) return null;
      const d = new Date(trip.start_date);
      d.setDate(d.getDate() + day - 1);
      return d;
    };

    // ---- view mode: a long trip is always a calendar, no toggle. A short trip is a
    // list, with a toggle over to the calendar. The choice can't ride on editMode —
    // participants are always in edit mode, so that would pin them to one view. ----
    const savedViewModes = JSON.parse(localStorage.getItem('tripi_view_modes') || '{}');
    const longTrip = trip.days > 7;
    let viewMode = longTrip ? 'calendar' : (savedViewModes[trip.share_code] || 'list');
    const viewToggle = document.getElementById('view-toggle');
    if (!longTrip) {
      viewToggle.innerHTML = `
        <div class="seg view-seg">
          <button type="button" data-v="list">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            רשימה
          </button>
          <button type="button" data-v="calendar">
            <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>
            לוח שנה
          </button>
        </div>`;
      viewToggle.style.display = '';
      viewToggle.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          viewMode = b.dataset.v;
          savedViewModes[trip.share_code] = viewMode;
          localStorage.setItem('tripi_view_modes', JSON.stringify(savedViewModes));
          renderItinerary();
        };
      });
    }

    // day order first, then the clock, then the stored slot — the order both views
    // read stops in. The slot tiebreak matches the server's own ORDER BY, and it is
    // what makes an arrange-mode swap of two unclocked stops actually visible.
    const sortItems = () => tripItems.sort((a, b) =>
      a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || ''))
      || (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
    // the server orders by slot only (day, sort_order, id) — run the clock-first
    // comparator once on load too, or a stop added at 15:30 yesterday renders
    // after the 17:00 one today
    sortItems();

    // the one write path for a stop: patch, fold the server's row back into the
    // item both views already hold, and repaint. Throws on failure — callers show it.
    async function saveItem(item, patch) {
      const updated = await TRIPI.api(`/api/trips/code/${trip.share_code}/items/${item.id}`, {
        method: 'PATCH', headers: canEditHeaders, body: JSON.stringify(patch),
      });
      Object.assign(item, updated);
      aiUndo = null;
      sortItems();
      renderItinerary();
      updateAmbient();
      return item;
    }

    async function addItem(data) {
      const item = await TRIPI.api(`/api/trips/code/${trip.share_code}/items`, {
        method: 'POST', headers: canEditHeaders, body: JSON.stringify(data),
      });
      tripItems.push(item);
      aiUndo = null;
      sortItems();
      renderItinerary();
      updateAmbient();
      return item;
    }

    async function deleteItem(item) {
      await TRIPI.api(`/api/trips/code/${trip.share_code}/items/${item.id}`, {
        method: 'DELETE', headers: canEditHeaders,
      });
      tripItems = tripItems.filter((x) => x.id !== item.id);
      aiUndo = null;
      renderItinerary();
      updateAmbient();
    }

    // arrange-mode commit: the DOM order of each visible day, exactly as the drag
    // preview left it. Each day keeps its own set of hours and deals them back to
    // its stops in the new order (nulls first, same comparator as sortItems), so the
    // schedule's shape survives, only the content moves — and day+time+slot sorting
    // is guaranteed to reproduce the visual order that was committed.
    async function applyArrangement(layout) {
      const cmp = (a, b) => String(a || '').localeCompare(String(b || ''));
      const jobs = [];
      for (const { day, ids } of layout) {
        const stops = ids.map((id) => tripItems.find((it) => it.id === id)).filter(Boolean);
        const slots = stops.map((s) => s.time_label).sort(cmp);
        stops.forEach((s, i) => {
          const patch = {};
          if (s.day_number !== day) patch.day_number = day;
          if (cmp(s.time_label, slots[i])) patch.time_label = slots[i];
          if (s.sort_order !== i) patch.sort_order = i;
          if (Object.keys(patch).length) jobs.push({ item: s, patch });
        });
      }
      if (!jobs.length) return;
      aiUndo = null;
      // all PATCHes first, ONE repaint after — painting between them would flash the
      // half-moved arrangement the drag preview has already replaced on screen
      try {
        for (const { item, patch } of jobs) {
          const updated = await TRIPI.api(`/api/trips/code/${trip.share_code}/items/${item.id}`, {
            method: 'PATCH', headers: canEditHeaders, body: JSON.stringify(patch),
          });
          Object.assign(item, updated);
        }
      } finally {
        sortItems();
        renderItinerary();
        updateAmbient();
      }
    }

    async function moveStopToDay(id, day) {
      const it = tripItems.find((x) => x.id === id);
      if (!it || it.day_number === day) return;
      await saveItem(it, { day_number: day });
    }

    registerTripTools({ trip, state, canEdit, addItem, saveItem, deleteItem, items: () => tripItems });

    // one context for the calendar AND for the stop sheet the list view opens —
    // the sheet is the single details/edit surface for a stop in both views
    const calCtx = {
      trip, state, dayDate, weather: () => weatherByDate,
      canEdit: editMode,
      // a stop's own coordinates beat the trip's, so the picker searches near it
      bias: (it) => ({ lat: it?.lat ?? dests[0]?.lat, lon: it?.lon ?? dests[0]?.lon }),
      defaultArea: (day) => (multiDest() ? defaultAreaForDay(day) : tripDests[0]?.name || null),
      saveItem, addItem, deleteItem,
      // arrange mode (long-press drag) — the calendar views hand these to TripArrange
      arrangeCommit: applyArrangement, moveItemToDay: moveStopToDay,
    };

    // every existing call site funnels through here, so both views stay fresh
    function renderItinerary() {
      if (!longTrip) {
        viewToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === viewMode));
      }
      // the sidebar map lives outside #days-container, so this is its one repaint
      // hook — add/edit/delete/drag all pass through here (no-op before init)
      TripMap.refresh();
      if (viewMode === 'calendar') {
        TripCalendar.render(container, calCtx);
        return;
      }
      TripCalendar.exitFull(); // the list can't live inside the fullscreen calendar
      renderListView();
    }

    // lists longer than 2 days start folded — day 2 fades out into a reveal
    // button — so the page ends near the AI editor instead of ten screens down
    let listExpanded = false;
    function applyListCollapse() {
      const blocks = [...container.querySelectorAll('.day-block')];
      if (listExpanded || blocks.length <= 2) return;
      blocks.slice(2).forEach((b) => b.classList.add('day-folded'));
      blocks[1].classList.add('day-fade');
      const rest = blocks.length - 2;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'show-rest-btn';
      btn.textContent = rest === 1 ? '▾ לכל המסלול — עוד יום אחד' : `▾ לכל המסלול — עוד ${rest} ימים`;
      btn.onclick = () => { listExpanded = true; renderItinerary(); };
      container.appendChild(btn);
    }

    // lucide thumbs — stroke icons, currentColor, same convention as every control
    const VOTE_ICONS = {
      up: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
      down: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>',
    };
    const voteHtml = (it) => {
      if (!votesOn) return '';
      const v = votesByItem[it.id] || { up: 0, down: 0, my_vote: 0 };
      return `<span class="stop-votes">
        <button type="button" class="vote-btn${v.my_vote === 1 ? ' on' : ''}" data-id="${it.id}" data-v="1"
          title="בעד התחנה" aria-label="בעד התחנה">${VOTE_ICONS.up}${v.up ? `<b>${v.up}</b>` : ''}</button>
        <button type="button" class="vote-btn down${v.my_vote === -1 ? ' on' : ''}" data-id="${it.id}" data-v="-1"
          title="נגד התחנה" aria-label="נגד התחנה">${VOTE_ICONS.down}${v.down ? `<b>${v.down}</b>` : ''}</button>
      </span>`;
    };

    // ---- travel legs: real driving times between consecutive stops (OSRM) ----
    // injected into the rendered list once routing resolves, so the itinerary never
    // waits on the network; GEO caches per chain, so re-renders land instantly
    const carIcon = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>';
    const fmtDrive = (min) => (min < 60 ? `${min} דק׳` : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} שע׳`);
    async function annotateTravel(byDay) {
      for (const [day, stops] of byDay) {
        // consecutive runs of stops with coordinates — a coordless stop breaks the chain
        const runs = [];
        let run = [];
        for (const it of stops) {
          if (it.lat != null && it.lon != null) run.push(it);
          else { if (run.length > 1) runs.push(run); run = []; }
        }
        if (run.length > 1) runs.push(run);
        if (!runs.length) continue;
        let totalMin = 0;
        await Promise.all(runs.map(async (r) => {
          const legs = await GEO.routeLegs(r).catch(() => null);
          if (!legs) return;
          legs.forEach((leg, i) => {
            totalMin += leg.minutes;
            if (leg.minutes < 3) return; // a hop across the street isn't worth a row
            const card = container.querySelector(`.item-card[data-item-id="${r[i].id}"]`);
            // the list may have re-rendered since this fetch began — the fresh pass
            // annotates the new cards; the sibling check stops a double insert
            if (!card || card.nextElementSibling?.classList.contains('travel-leg')) return;
            const el = document.createElement('div');
            el.className = 'travel-leg';
            el.innerHTML = `${carIcon} ${fmtDrive(leg.minutes)} · ${leg.km} ק״מ`;
            card.insertAdjacentElement('afterend', el);
          });
        }));
        // three hours behind the wheel is where a day out becomes a road day
        if (totalMin >= 180) {
          const title = container.querySelector(`.day-block[data-day="${day}"] .day-title`);
          if (title && !title.querySelector('.day-load')) {
            const chip = document.createElement('span');
            chip.className = 'day-load';
            chip.title = 'יום עמוס בנסיעות — אולי שווה לפצל אותו';
            chip.innerHTML = `${carIcon} ${fmtDrive(totalMin)} נסיעה`;
            title.appendChild(chip);
          }
        }
      }
    }

    function renderListView() {
      const byDay = new Map();
      for (let d = 1; d <= (editMode ? trip.days : 0); d++) byDay.set(d, []); // edit mode shows all days
      for (const it of tripItems) {
        if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
        byDay.get(it.day_number).push(it);
      }
      if (!byDay.size) {
        container.innerHTML = '<div class="empty-day glass" style="margin-top:20px;border-radius:var(--radius)">המסלול עדיין ריק — בעל הטיול עוד לא הוסיף תחנות</div>';
        return;
      }
      const dayCosts = TripModals.plannedByDay(state);
      const cur = TripModals.curOf(state);
      container.innerHTML = [...byDay.keys()].sort((a, b) => a - b).map((day) => {
        const date = dayDate(day);
        const iso = date ? TRIPI.isoDate(date) : null;
        const w = iso && weatherByDate[iso];
        const hotelLines = TripModals.dayHotelLines(state, day);
        const routeUrl = TRIPI.mapsRouteUrl(byDay.get(day));
        return `
        <div class="day-block" data-day="${day}">
          <div class="day-title">
            <span class="day-badge">יום ${day}</span>
            ${date ? `<span class="day-date">${date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</span>` : ''}
            ${dayCosts[day] ? `<span class="day-cost" title="עלות משוערת של היום (בלי לינה)">${TripModals.fmt(dayCosts[day], cur)}</span>` : ''}
            ${routeUrl ? `<a class="day-route" target="_blank" rel="noopener" href="${TRIPI.esc(routeUrl)}"
              title="נפתח בגוגל מפות, בחלון חדש">${TRIPI.routeIcon} מסלול בגוגל מפות ${TRIPI.externalIcon}</a>` : ''}
            ${w ? `<span class="day-weather" title="${GEO.weatherLabel(w.code)}${w.est ? ' · ממוצע היסטורי' : ''}">${GEO.weatherIcon(w.code)} ${w.est ? '≈' : ''}${w.max}°</span>` : ''}
          </div>
          ${hotelLines.length ? `<div class="day-hotels">${hotelLines.map((l) =>
            `<span class="day-hotel ${l.cls}">${l.html}</span>`).join('')}</div>` : ''}
          <div class="timeline">
            ${byDay.get(day).map((it) => {
              const isTravel = it.category === 'נסיעה';
              return `
              <div class="item-card glass tappable${isTravel ? ' travel' : ''}"
                ${isTravel ? `data-ticon="${TripModals.travelIcon(it)}"` : ''} data-item-id="${it.id}"
                role="button" tabindex="0" title="לחיצה לפרטי התחנה">
                <div class="item-top">
                  ${it.time_label ? `<span class="item-time">${TRIPI.esc(it.time_label)}</span>` : ''}
                  <span class="item-title">${TRIPI.esc(it.title)}</span>
                  <span class="item-badges">
                    ${voteHtml(it)}
                    ${+it.cost > 0 ? `<span class="item-cost">${TripModals.fmt(it.cost, TripModals.curOf(state))}</span>` : ''}
                    ${multiDest() && it.area ? `<span class="item-area">📍 ${TRIPI.esc(it.area)}</span>` : ''}
                    ${it.category ? `<span class="item-cat">${TRIPI.esc(it.category)}</span>` : ''}
                    ${editMode ? `<button class="item-del" data-id="${it.id}" title="מחיקת תחנה">✕</button>` : ''}
                  </span>
                </div>
                ${it.note ? `<div class="item-note">${TRIPI.esc(it.note)}</div>` : ''}
              </div>`;
            }).join('')}
            ${byDay.get(day).length === 0 && editMode ? '<div class="empty-day">יום פנוי — מוסיפים תחנה למטה ↓</div>' : ''}
            ${editMode ? `<button class="add-item-inline" data-day="${day}">+ הוספת תחנה ליום ${day}</button>` : ''}
          </div>
        </div>
        ${TripModals.nightCardHtml(state, day)}`;
      }).join('');

      // night N is the night after day N, so the card lands between the two days
      // it separates — the suggestions inside load lazily as they scroll near.
      // Built inline rather than reusing modalCtx: that const is declared much
      // further down and a repaint can fire before it exists.
      TripModals.mountNightCards({
        state,
        ensureEdit: () => ensureEditRights(),
        refresh: () => renderItinerary(),
      }, container);

      // a tap anywhere on the card opens the stop sheet — the same details/edit
      // popover the calendar uses. One surface for a stop, whichever view it's in.
      container.querySelectorAll('.item-card.tappable').forEach((card) => {
        const open = (e) => {
          if (e.target.closest('.item-del') || e.target.closest('.stop-votes') || e.target.closest('a')) return;
          TripCalendar.openStop(calCtx, +card.dataset.itemId);
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
        });
      });

      // vote taps: same vote again takes it back; the server answers with the
      // stop's fresh tally, and the repaint folds it in
      container.querySelectorAll('.vote-btn').forEach((b) => {
        b.onclick = async () => {
          if (b.disabled) return;
          b.disabled = true;
          const id = +b.dataset.id;
          const mine = (votesByItem[id] || {}).my_vote || 0;
          const next = mine === +b.dataset.v ? 0 : +b.dataset.v;
          try {
            votesByItem[id] = await TRIPI.api(`/api/trips/code/${trip.share_code}/items/${id}/vote`, {
              method: 'PUT', headers: canEditHeaders || {}, body: JSON.stringify({ vote: next }),
            });
            renderItinerary();
          } catch (err) { alert(err.message); b.disabled = false; }
        };
      });

      if (editMode) {
        container.querySelectorAll('.item-del').forEach((b) => {
          b.onclick = async () => {
            if (b.disabled) return;
            if (!confirm('למחוק את התחנה?')) return;
            b.disabled = true;
            try {
              await deleteItem(tripItems.find((it) => it.id === +b.dataset.id));
            } catch (e) { alert(e.message); b.disabled = false; }
          };
        });
        container.querySelectorAll('.add-item-inline').forEach((b) => {
          b.onclick = () => TripCalendar.openNewStop(calCtx, +b.dataset.day);
        });
      }
      applyListCollapse();
      annotateTravel(byDay);
      // long-press a card → jiggle & live drag; each day's timeline is a preview
      // surface, the day header still takes a plain drop (→ end of that day)
      TripArrange.attach(container, {
        canEdit: editMode,
        cards: '.item-card',
        idOf: (el) => +el.dataset.itemId,
        containers: '.day-block .timeline',
        dayOf: (el) => +(el.closest('.day-block')?.dataset.day),
        commit: applyArrangement,
        dayTargets: [{ selector: '.day-block', getDay: (el) => +el.dataset.day }],
        moveToDay: moveStopToDay,
        rerender: renderItinerary,
      });
    }

    renderItinerary();

    // ---- participants: who edits the trip, the invite link, and publishing ----
    // "privileged" = a participant, or someone holding an invite link who's one signup
    // away from becoming one. Plain viewers never see these tools.
    const privileged = canEdit || !!inviteToken;

    // signup gate for invite holders: register/login, redeem the invite, reload unlocked
    function requireSignup(mode = 'register') {
      openAuthModal(async () => {
        await redeemInvite();
        location.reload();
      }, mode);
    }

    // one gate for every edit-protected action (stops, hotels, budget)
    async function ensureEditRights() {
      if (canEditHeaders) return canEditHeaders;
      if (inviteToken) requireSignup();
      return null;
    }

    const participantsBtn = document.getElementById('participants-btn');
    participantsBtn.style.display = privileged ? '' : 'none';
    document.getElementById('participants-label').textContent =
      participants.length > 1 ? `${participants.length} משתתפים` : 'משתתפים';
    participantsBtn.onclick = () => (canEdit ? openParticipants() : requireSignup());

    // hero badge next to the "X ימים" chip: pull co-planners in from the top of
    // the page — clicking opens the participants screen
    if (privileged) {
      const pChip = document.createElement('button');
      pChip.type = 'button';
      pChip.id = 'participants-chip';
      pChip.className = 'chip chip-action';
      pChip.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg> הוספת משתתפים`;
      document.getElementById('trip-meta').appendChild(pChip);
      pChip.onclick = () => (canEdit ? openParticipants() : requireSignup());
    }

    const inviteLink = () => `${location.origin}/trip/${trip.share_code}?join=${trip.invite_token}`;

    // stroke icons for the participants modal — currentColor keeps them in step
    // with row hover, danger tints and disabled states
    const PT_ICON = {
      leave: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
      remove: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    };

    function renderParticipantsList(wrap) {
      const me = TRIPI.user ? TRIPI.user.id : null;
      wrap.querySelector('#pt-count').textContent = participants.length;
      wrap.querySelector('#participants-list').innerHTML = participants.map((p) => {
        const self = p.id === me;
        const action = self ? 'עזיבת הטיול' : `הסרת ${p.name} מהטיול`;
        return `
        <div class="pt-row${p.is_owner ? ' owner' : ''}">
          <span class="pt-avatar">${TRIPI.esc((String(p.name || '?').trim()[0] || '?').toUpperCase())}</span>
          <span class="pt-id">
            <span class="pt-name"><span class="pt-name-t">${TRIPI.esc(p.name)}</span>${self ? '<span class="pt-me">אני</span>' : ''}</span>
            <span class="pt-role">${p.is_owner ? 'מארגן הטיול' : 'עורך את הטיול'}</span>
          </span>
          ${p.is_owner ? '' : `<button type="button" class="pt-remove" data-id="${p.id}"
            title="${TRIPI.esc(action)}" aria-label="${TRIPI.esc(action)}">${self ? PT_ICON.leave : PT_ICON.remove}</button>`}
        </div>`;
      }).join('');
      wrap.querySelectorAll('.pt-remove').forEach((b) => {
        b.onclick = async () => {
          const uid = +b.dataset.id;
          const self = uid === me;
          if (!confirm(self
            ? 'לעזוב את הטיול? אפשר תמיד לחזור עם קישור הזמנה'
            : 'להסיר את המשתתף? הוא יאבד את הרשאת העריכה')) return;
          try {
            await TRIPI.api(`/api/trips/code/${trip.share_code}/participants/${uid}`, { method: 'DELETE' });
            if (self) { location.reload(); return; }
            participants = participants.filter((p) => p.id !== uid);
            document.getElementById('participants-label').textContent =
              participants.length > 1 ? `${participants.length} משתתפים` : 'משתתפים';
            renderParticipantsList(wrap);
          } catch (e) { alert(e.message); }
        };
      });
    }

    let syncPushSection = null; // set when the modal is first built

    function openParticipants() {
      let wrap = document.getElementById('participants-modal');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'participants-modal';
        wrap.className = 'modal-backdrop';
        wrap.innerHTML = `
          <div class="modal glass modal-people">
            <div class="pm-head">
              <button class="modal-close" aria-label="סגירה">
                <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
              <h2>מי מתכנן את הטיול</h2>
              <p class="modal-sub">כל מי שברשימה עורך את המסלול, המלונות והתקציב</p>
            </div>
            <div class="pm-body">
              <section class="pm-sec">
                <div class="pm-sec-head">
                  <span class="pm-sec-title">משתתפים</span>
                  <span class="pm-count" id="pt-count"></span>
                </div>
                <div id="participants-list" class="pt-list"></div>
              </section>

              <section class="pm-sec pm-invite">
                <div class="pm-sec-head"><span class="pm-sec-title">הזמנת חברים</span></div>
                <p class="pm-sec-sub">שולחים קישור — מי שנרשם דרכו מצטרף ומקבל הרשאת עריכה</p>
                <div class="pm-actions">
                  <button type="button" class="btn btn-amber" id="invite-wa">
                    <svg class="wa-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
                    שליחה בוואטסאפ</button>
                  <button type="button" class="btn btn-ghost" id="invite-copy">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    העתקת קישור</button>
                </div>
                <div class="copy-feedback" id="invite-feedback" role="status"></div>
                <div class="pm-quiet-row">
                  <button type="button" class="pm-quiet" id="invite-regen">
                    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
                    חידוש הקישור</button>
                  <span class="pm-quiet-hint">קישורים שכבר נשלחו יפסיקו לעבוד</span>
                </div>
              </section>

              <!-- notifications live next to the invite: the moment you send one is
                   exactly when you want to know whether anyone walked through it -->
              <section class="pm-sec pm-notif" id="push-sec" style="display:none">
                <label class="pm-setting" for="push-toggle">
                  <span class="pm-setting-ic">${PUSH_BELL}</span>
                  <span class="pm-setting-text">
                    <span class="pm-setting-title">התראות על הטיול</span>
                    <span class="pm-setting-desc" id="push-desc">שנדע לכם כשחבר מצטרף לתכנון או משנה משהו במסלול</span>
                  </span>
                  <span class="pm-switch">
                    <input type="checkbox" id="push-toggle">
                    <span class="pm-switch-track" aria-hidden="true"><span class="pm-switch-knob"></span></span>
                  </span>
                </label>
              </section>
            </div>
          </div>`;
        document.body.appendChild(wrap);
        wrap.querySelector('.modal-close').onclick = () => wrap.classList.remove('open');
        wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.classList.remove('open'); });

        const flash = (msg) => {
          const el = wrap.querySelector('#invite-feedback');
          el.textContent = msg;
          setTimeout(() => { el.textContent = ''; }, 2500);
        };
        wrap.querySelector('#invite-wa').onclick = () => {
          const text = `${trip.emoji || '🧭'} בואו לתכנן איתי את "${trip.title}"!\nנכנסים לקישור, נרשמים בשנייה — ועורכים את הטיול יחד:\n${inviteLink()}`;
          window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
        };
        wrap.querySelector('#invite-copy').onclick = async () => {
          await TRIPI.copy(inviteLink());
          flash('קישור ההזמנה הועתק! ✓');
        };
        wrap.querySelector('#invite-regen').onclick = async (e) => {
          if (!confirm('לחדש את קישור ההזמנה? מי שקיבל את הקישור הישן ועוד לא נרשם — לא יוכל להצטרף איתו')) return;
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await TRIPI.api(`/api/trips/code/${trip.share_code}/invite/regenerate`, { method: 'POST' });
            trip.invite_token = r.invite_token;
            flash('נוצר קישור חדש ✓');
          } catch (err) { alert(err.message); }
          btn.disabled = false;
        };

        // the switch reflects the browser's real subscription state, not a stored
        // preference — permission can be revoked in site settings at any time
        const pushSec = wrap.querySelector('#push-sec');
        const pushToggle = wrap.querySelector('#push-toggle');
        const pushDesc = wrap.querySelector('#push-desc');
        syncPushSection = async () => {
          const st = await TRIPI_PUSH.state();
          if (st === 'unavailable' && !TRIPI_PUSH.needsInstall) { pushSec.style.display = 'none'; return; }
          pushSec.style.display = '';
          if (TRIPI_PUSH.needsInstall) {
            pushToggle.checked = false;
            pushToggle.disabled = true;
            pushDesc.textContent = 'באייפון צריך קודם להוסיף את TRIP MAKER למסך הבית — ואז אפשר להפעיל התראות';
            return;
          }
          if (st === 'blocked') {
            pushToggle.checked = false;
            pushToggle.disabled = true;
            pushDesc.textContent = 'ההתראות חסומות בהגדרות הדפדפן לאתר הזה';
            return;
          }
          pushToggle.disabled = false;
          pushToggle.checked = st === 'on';
          pushDesc.textContent = 'שנדע לכם כשחבר מצטרף לתכנון או משנה משהו במסלול';
        };
        pushToggle.onchange = async () => {
          pushToggle.disabled = true;
          try {
            if (pushToggle.checked) await TRIPI_PUSH.enable();
            else await TRIPI_PUSH.disable();
            localStorage.setItem('tm_push_asked', '1'); // decided here — don't ask again elsewhere
          } catch (err) {
            pushDesc.textContent = err.message;
          }
          await syncPushSection();
        };
      }
      renderParticipantsList(wrap);
      syncPushSection?.();
      wrap.classList.add('open');
    }

    // co-planners get asked once, from a card of ours, whether to be told when
    // someone joins — never a bare browser prompt on load
    if (canEdit) offerPushOptIn(document.querySelector('.action-bar'));

    // bottom banner for invite holders who aren't signed in yet: they can look
    // around freely, and one quick signup makes them a participant
    if (inviteToken && !canEdit && !TRIPI.user) {
      const banner = document.createElement('div');
      banner.className = 'join-banner glass';
      banner.innerHTML = `
        <span class="jb-text">🎒 הוזמנתם להשתתף בטיול! נרשמים במהירות — ומתכננים אותו יחד</span>
        <button type="button" class="btn btn-amber jb-cta">הרשמה מהירה</button>`;
      document.body.appendChild(banner);
      banner.querySelector('.jb-cta').onclick = () => requireSignup('register');
    }

    // ---- AI edit box: free-text itinerary changes for anyone with edit rights ----
    const aiCard = document.getElementById('ai-edit-card');
    const aiInput = document.getElementById('ai-edit-input');
    const aiBtn = document.getElementById('ai-edit-btn');
    const aiCount = document.getElementById('ai-edit-count');
    const aiResult = document.getElementById('ai-edit-result');
    // the card lives below the itinerary now, so it no longer needs the compact
    // hero it used to force when it sat above the fold
    if (canEditHeaders) aiCard.style.display = '';

    // area + day-range scope (multi-destination trips only) — same controls the
    // plan wizard had; the server enforces the range on every op it applies
    const aiArea = document.getElementById('trip-ai-area');
    const aiRange = document.getElementById('trip-ai-range');
    // picking an area reveals its day range, pre-filled with where that area sits today
    function syncAiScopeRange() {
      const area = aiArea.value;
      aiRange.style.display = area ? '' : 'none';
      if (!area) return;
      const fromInp = document.getElementById('trip-ai-from');
      const toInp = document.getElementById('trip-ai-to');
      fromInp.max = toInp.max = trip.days;
      const areaDays = tripItems.filter((it) => it.area === area).map((it) => it.day_number);
      fromInp.value = areaDays.length ? Math.min(...areaDays) : 1;
      toInp.value = areaDays.length ? Math.min(Math.max(...areaDays), trip.days) : trip.days;
    }
    if (multiDest()) {
      document.getElementById('trip-ai-scope').style.display = '';
      aiArea.innerHTML = '<option value="">כל הטיול</option>' +
        tripDests.map((d) => `<option>${TRIPI.esc(d.name)}</option>`).join('');
      aiArea.onchange = syncAiScopeRange;
    }
    aiInput.addEventListener('input', () => { aiCount.textContent = `${aiInput.value.length}/200`; });
    document.getElementById('ai-edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const prompt = aiInput.value.trim();
      if (!prompt || aiBtn.disabled) return;
      aiBtn.disabled = true;
      aiInput.disabled = true;
      const prevLabel = aiBtn.textContent;
      aiBtn.textContent = 'רגע… ⏳';
      aiResult.hidden = true;
      aiResult.className = 'ai-edit-result';
      try {
        const scope = aiArea.value
          ? { area: aiArea.value,
              day_from: +document.getElementById('trip-ai-from').value || 1,
              day_to: +document.getElementById('trip-ai-to').value || trip.days }
          : {};
        const snapDesc = trip.description; // for the undo — the item inverse comes from the server
        const r = await TRIPI.api(`/api/trips/code/${trip.share_code}/ai-edit`, {
          method: 'POST', headers: canEditHeaders || {},
          body: JSON.stringify({ prompt, ...scope }),
        });
        tripItems = r.items;
        sortItems(); // the server returns slot order — a stop the AI added mid-day must land at its clock position
        renderItinerary();
        syncAiScopeRange(); // the area's day span may have moved
        if (r.description) { trip.description = r.description; renderDesc(); }
        const changed = r.added + r.updated + r.removed > 0;
        aiResult.classList.add(changed ? 'ok' : 'info');
        aiResult.textContent = r.summary;
        if (changed && r.undo) {
          aiInput.value = '';
          aiCount.textContent = '0/200';
          aiUndo = { ops: r.undo, snapDesc };
          const undoBtn = document.createElement('button');
          undoBtn.type = 'button';
          undoBtn.className = 'ai-undo-btn';
          undoBtn.textContent = 'ביטול השינוי';
          undoBtn.onclick = () => undoAiEdit(undoBtn);
          aiResult.append(' ', undoBtn);
        }
      } catch (err) {
        aiResult.classList.add('err');
        aiResult.textContent = err.message;
      } finally {
        aiResult.hidden = false;
        aiBtn.disabled = false;
        aiInput.disabled = false;
        aiBtn.textContent = prevLabel;
      }
    });

    // reverse the last smart edit with plain item CRUD — no model call, no quota.
    // The inverse comes from the server (exactly the rows the edit touched, with
    // their pre-edit values), so a stop a co-planner added or changed in the
    // meantime is never confused for the AI's work. Per-op failures are tolerated:
    // restoring the rest still beats nothing. One level only — re-created stops
    // get fresh ids, so there is no redo.
    async function undoAiEdit(btn) {
      if (btn.disabled) return;
      if (!aiUndo) {
        // a manual edit since the AI ran invalidated the undo — say so instead
        // of a button that silently does nothing
        btn.remove();
        aiResult.className = 'ai-edit-result info';
        aiResult.textContent = 'המסלול השתנה מאז — אי אפשר לבטל את שינוי ה-AI אוטומטית';
        return;
      }
      const { ops, snapDesc } = aiUndo;
      aiUndo = null;
      btn.disabled = true;
      btn.textContent = 'רגע, מחזירים…';
      const H = canEditHeaders || {};
      const base = `/api/trips/code/${trip.share_code}`;
      try {
        for (const id of ops.added) {
          await TRIPI.api(`${base}/items/${id}`, { method: 'DELETE', headers: H }).catch(() => {});
        }
        for (const u of ops.updated) {
          // exactly the columns the edit touched, back to their pre-edit values
          await TRIPI.api(`${base}/items/${u.id}`, {
            method: 'PATCH', headers: H, body: JSON.stringify(u.fields),
          }).catch(() => {});
        }
        for (const it of ops.deleted) {
          try {
            const row = await TRIPI.api(`${base}/items`, {
              method: 'POST', headers: H,
              body: JSON.stringify({
                day_number: it.day_number, time_label: it.time_label, title: it.title,
                note: it.note, place_query: it.place_query, category: it.category,
                area: it.area, lat: it.lat, lon: it.lon, cost: it.cost,
              }),
            });
            // POST assigns MAX(sort_order)+1 — pin the original slot back so an
            // unclocked stop returns to where it stood, not to the day's end
            if ((row.sort_order ?? 0) !== (it.sort_order ?? 0)) {
              await TRIPI.api(`${base}/items/${row.id}`, {
                method: 'PATCH', headers: H, body: JSON.stringify({ sort_order: it.sort_order ?? 0 }),
              }).catch(() => {});
            }
          } catch { /* trip-level failure on one stop — restore the rest */ }
        }
        if ((snapDesc ?? '') !== (trip.description ?? '')) {
          // the AI rewrote the trip description too — restore it server-side
          await TRIPI.api('/api/trips/' + trip.id, {
            method: 'PATCH', body: JSON.stringify({ description: snapDesc || null }),
          }).catch(() => {});
        }
      } finally {
        // one re-fetch is the source of truth after the inverse ops — it also folds
        // in whatever co-planners changed meanwhile instead of guessing at it
        try {
          const fresh = await TRIPI.api(`/api/trips/code/${trip.share_code}`);
          tripItems = fresh.items;
          trip.description = fresh.trip.description;
          renderDesc();
        } catch { /* offline mid-undo — keep the local state we have */ }
        sortItems();
        renderItinerary();
        updateAmbient();
        syncAiScopeRange();
        aiResult.className = 'ai-edit-result info';
        aiResult.textContent = 'השינוי בוטל — המסלול חזר לקדמותו';
      }
    }

    // ---- clone button: anyone holding the code can copy the trip into their account ----
    // (the API has never gated this on is_public — the share code already grants a
    // full read, so hiding the button only stranded viewers with no next step)
    const cloneBtn = document.getElementById('clone-btn');
    // `from` is whichever control was pressed — the action-bar button or the end-cap
    // CTA — so the wait shows up where the finger actually landed
    async function doClone(from) {
      if (cloneBtn.disabled) return;
      cloneBtn.disabled = true;
      const busy = from instanceof HTMLElement ? from : cloneBtn;
      const label = busy === cloneBtn ? document.getElementById('clone-label') : busy;
      const prevLabel = label.innerHTML;
      busy.disabled = true;
      label.textContent = 'משכפלים…';
      try {
        const copy = await TRIPI.api(`/api/trips/code/${trip.share_code}/clone`, { method: 'POST' });
        location.href = '/trip/' + copy.share_code;
      } catch (e) {
        alert(e.message);
        cloneBtn.disabled = false;
        busy.disabled = false;
        label.innerHTML = prevLabel;
      }
    }
    cloneBtn.onclick = () => {
      // cloning needs an account to own the copy — register, then clone right away
      if (!TRIPI.user) { openAuthModal(doClone, 'register'); return; }
      doClone();
    };

    // ---- like button ----
    const likedTrips = JSON.parse(localStorage.getItem('tripi_likes') || '{}');
    const likeBtn = document.getElementById('like-btn');
    const likeCount = document.getElementById('like-count');
    likeCount.textContent = trip.likes || 0;

    // likes are a gallery feature — they follow the publish toggle live. Cloning is
    // not: it's the only thing a plain viewer can *do* here, and hiding it on
    // unpublished trips (nearly all of them) left every shared link a dead end.
    function syncPublicUI() {
      likeBtn.style.display = trip.is_public ? '' : 'none';
      cloneBtn.style.display = '';
    }
    // participants already own the trip — for them this is "make me a variant";
    // for a viewer it's the takeaway, so it says so
    if (!canEdit) {
      document.getElementById('clone-label').textContent = 'העתקה לעצמי';
      cloneBtn.title = 'יוצר עותק אישי בחשבון שלכם — אפשר לשנות בו הכל';
    }
    syncPublicUI();

    // ---- end-cap: the viewer finished reading the itinerary, and until now that
    // was the end of the road. This is the highest-intent spot on the page. ----
    if (!privileged) {
      const endcap = document.createElement('section');
      endcap.className = 'trip-endcap glass';
      endcap.innerHTML = `
        <span class="te-emoji">🧳</span>
        <h3 class="te-title">אהבתם את המסלול?</h3>
        <p class="te-sub">קחו אותו לעצמכם — התחנות, המלונות והתאריכים עוברים לחשבון שלכם,
          ומשם אפשר לשנות הכל ולתכנן אותו עם מי שנוסע איתכם.</p>
        <button type="button" class="btn btn-amber btn-lg te-cta">
          <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          העתקת הטיול אליי
        </button>
        <span class="te-note">חינם · נשמר ב"הטיולים שלי" · אפשר לשתף הלאה</span>`;
      document.getElementById('days-container').insertAdjacentElement('afterend', endcap);
      const teCta = endcap.querySelector('.te-cta');
      teCta.onclick = () => {
        // no account yet? register first — that signup is the whole point of this card
        if (!TRIPI.user) { openAuthModal(() => doClone(teCta), 'register'); return; }
        doClone(teCta);
      };
    }

    // publishing lives on the TRIPI PASS card — it's a sharing decision, next to
    // the public code and the share buttons. Participants only.
    const publishRow = document.getElementById('publish-row');
    const publishToggle = document.getElementById('publish-toggle');
    publishRow.style.display = canEdit ? '' : 'none';
    publishToggle.checked = !!trip.is_public;
    publishToggle.onchange = async () => {
      publishToggle.disabled = true;
      try {
        const updated = await TRIPI.api('/api/trips/' + trip.id, {
          method: 'PATCH', body: JSON.stringify({ is_public: publishToggle.checked }),
        });
        trip.is_public = updated.is_public;
        syncPublicUI();
      } catch (e) { publishToggle.checked = !publishToggle.checked; alert(e.message); }
      publishToggle.disabled = false;
    };

    if (likedTrips[trip.id]) likeBtn.classList.add('liked');
    let likeBusy = false; // rapid double-tap must not double-count
    likeBtn.onclick = async () => {
      if (likeBusy) return;
      likeBusy = true;
      const undo = !!likedTrips[trip.id];
      try {
        const r = await TRIPI.api(`/api/trips/${trip.id}/like`, { method: 'POST', body: JSON.stringify({ undo }) });
        likeCount.textContent = r.likes;
        if (undo) delete likedTrips[trip.id]; else likedTrips[trip.id] = 1;
        localStorage.setItem('tripi_likes', JSON.stringify(likedTrips));
        likeBtn.classList.toggle('liked', !!likedTrips[trip.id]);
      } catch { /* ignore */ } finally { likeBusy = false; }
    };

    // ---- hotels + budget modals + ambient budget UI ----
    const modalCtx = {
      state,
      ensureEdit: ensureEditRights,
      refresh: () => { updateAmbient(); renderItinerary(); },
    };
    const hotelsBtn = document.getElementById('hotels-btn');
    const budgetBtn = document.getElementById('budget-btn');
    // trip tools are for participants (and invite holders, one signup away);
    // one-day trips skip hotels either way — sleeping at home
    budgetBtn.style.display = privileged ? '' : 'none';
    hotelsBtn.style.display = privileged && trip.days >= 2 ? '' : 'none';
    hotelsBtn.onclick = () => (canEdit ? TripModals.openHotels(modalCtx) : requireSignup());
    budgetBtn.onclick = () => (canEdit ? TripModals.openBudget(modalCtx) : requireSignup());

    function updateAmbient() {
      // the budget button doubles as the ambient alert: % of budget planned
      const st = TripModals.budgetButtonState(state);
      document.getElementById('budget-label').textContent = st.label;
      budgetBtn.classList.toggle('warn', st.cls === 'warn');
      budgetBtn.classList.toggle('over', st.cls === 'over');

      // hero chip: planned vs cap, tap opens the modal
      let chipEl = document.getElementById('budget-chip');
      const chipText = TripModals.heroChip(state);
      if (chipText) {
        if (!chipEl) {
          chipEl = document.createElement('span');
          chipEl.id = 'budget-chip';
          chipEl.className = 'chip budget-chip';
          // the participants chip stays last in the hero row; insertBefore(null) appends
          document.getElementById('trip-meta')
            .insertBefore(chipEl, document.getElementById('participants-chip'));
          chipEl.onclick = () => TripModals.openBudget(modalCtx);
        }
        chipEl.textContent = chipText;
      } else chipEl?.remove();

      // sidebar nudge: nights that still have no hotel (only once hotels exist)
      const nudgeSlot = document.getElementById('nudge-slot');
      let nudge = document.getElementById('nights-nudge');
      const runs = state.hotels.some((h) => h.status === 'booked') ? TripModals.uncoveredRuns(state) : [];
      if (runs.length) {
        if (!nudge) {
          nudge = document.createElement('button');
          nudge.id = 'nights-nudge';
          nudge.type = 'button';
          nudge.className = 'nights-nudge';
          nudgeSlot.appendChild(nudge);
          nudge.onclick = () => TripModals.openHotels(modalCtx);
        }
        nudge.textContent = `😴 ${runs.map((r) => r.from === r.to ? `לילה ${r.from}` : `לילות ${r.from}–${r.to}`).join(', ')} עדיין בלי מלון ›`;
      } else nudge?.remove();
    }
    updateAmbient();

    // a /trip/CODE#budget link (or a reload mid-budget) lands straight on the budget page
    if ((location.hash === '#budget' || location.hash === '#budget-settings') && canEdit) {
      TripModals.openBudget(modalCtx);
    }

    // ---- print / WhatsApp ----
    // the PDF is always the full list, whatever view is on screen — swap the
    // calendar out before the print snapshot and put it back after
    let printSwapped = false;
    window.addEventListener('beforeprint', () => {
      if (viewMode !== 'calendar') return;
      printSwapped = true;
      TripCalendar.exitFull();
      renderListView();
    });
    window.addEventListener('afterprint', () => {
      if (!printSwapped) return;
      printSwapped = false;
      renderItinerary();
    });
    document.getElementById('print-btn').onclick = () => window.print();

    // calendar export (.ics) — needs real dates to anchor the events; visible to
    // viewers too, same as PDF (an itinerary you can read, you can put in a calendar).
    // Fetched as a blob rather than navigated to: an error answers as JSON, and a
    // navigation would strand the user on a raw error page (worse in the installed PWA).
    const icsBtn = document.getElementById('ics-btn');
    if (trip.start_date) {
      icsBtn.style.display = '';
      icsBtn.onclick = async () => {
        if (icsBtn.disabled) return;
        icsBtn.disabled = true;
        TRIPI.track('calendar_export', { trip_id: trip.id });
        try {
          const res = await fetch(`/api/trips/code/${trip.share_code}/calendar.ics`);
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'הייצוא ליומן נכשל — נסו שוב עוד רגע');
          }
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement('a');
          a.href = url;
          a.download = `tripmaker-${trip.share_code}.ics`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (e) { alert(e.message); }
        icsBtn.disabled = false;
      };
    }

    // ---- share: the invite leads ----
    // this trip is something people build together, so a participant's big button
    // hands out the invite link — one signup and the friend is a co-planner — and
    // the view-only link steps down to a quiet third row. Same order the wizard's
    // last step uses. A viewer has no invite to give, so they share what they see.
    const feedback = document.getElementById('copy-feedback');
    const flash = (msg) => { feedback.textContent = msg; setTimeout(() => { feedback.textContent = ''; }, 2200); };
    const tripLink = () => `${location.origin}/trip/${trip.share_code}`;
    // the server backfills a token for every participant, but a share that quietly
    // links to `undefined` is worse than one that only offers the view link
    const shareInvite = canEdit && !!trip.invite_token;
    if (shareInvite) {
      document.getElementById('wa-share-label').textContent = 'הזמנה לתכנון בוואטסאפ';
      document.getElementById('copy-link-label').textContent = 'העתקת קישור הזמנה';
      document.getElementById('view-link-row').style.display = '';
      document.getElementById('copy-view-link').onclick = async () => {
        await TRIPI.copy(tripLink());
        flash('קישור הצפייה הועתק! ✓');
      };
    }
    document.getElementById('wa-share').onclick = () => {
      const text = shareInvite
        ? `${trip.emoji || '🧭'} בואו לתכנן איתי את "${trip.title}"!\nנכנסים לקישור, נרשמים בשנייה — ועורכים את הטיול יחד:\n${inviteLink()}`
        : `${trip.emoji || '🧭'} ${trip.title}\n${trip.destination} · ${trip.days} ימים\nקוד טיול: ${trip.share_code}\n${tripLink()}`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    };
    document.getElementById('copy-link').onclick = async () => {
      await TRIPI.copy(shareInvite ? inviteLink() : tripLink());
      flash(shareInvite ? 'קישור ההזמנה הועתק! ✓' : 'הקישור הועתק! ✓');
    };

    // ---- draft state: the trip exists from the moment it was built; "שמירת הטיול"
    // is the ceremony that reveals the code and the sharing surfaces. One function
    // owns every toggle so publishing can transition in place, no reload. ----
    const finishBtn = document.getElementById('finish-btn');
    const draftCard = document.getElementById('draft-card');
    function applyDraftState() {
      const isDraft = !!trip.is_draft;
      document.querySelector('.ticket').style.display = isDraft ? 'none' : '';
      draftCard.style.display = isDraft && canEdit ? '' : 'none';
      finishBtn.style.display = isDraft && (isOwner || isAdmin) ? '' : 'none';
      document.getElementById('code-chip').style.display = isDraft ? 'none' : '';
      // no cloning something half-planned — the button (and the viewer end-cap
      // that fronts it) come back the moment planning is finished
      cloneBtn.style.display = isDraft ? 'none' : '';
      const endcap = document.querySelector('.trip-endcap');
      if (endcap) endcap.style.display = isDraft ? 'none' : '';
    }
    applyDraftState();

    let publishing = false;
    async function publishTrip() {
      if (publishing) return;
      publishing = true;
      try {
        const updated = await TRIPI.api(`/api/trips/code/${trip.share_code}/publish`, {
          method: 'POST', headers: canEditHeaders || {},
        });
        Object.assign(trip, updated); // no invite_token in the response — the loaded one survives
        applyDraftState();
        openCelebration();
      } catch (e) {
        alert('⚠️ ' + e.message);
      }
      publishing = false;
    }
    finishBtn.onclick = publishTrip;
    document.getElementById('draft-finish-btn').onclick = publishTrip;

    // the celebration: the reveal of the TRIP MAKER PASS. The ticket behind the
    // modal is already visible, so closing it lands on the updated page.
    function openCelebration() {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop open';
      wrap.innerHTML = `
        <div class="modal glass celebrate">
          <div class="big-emoji">🎉</div>
          <h2>הטיול מוכן לדרך!</h2>
          <p class="modal-sub">זה קוד הטיול שלכם — משתפים אותו עם מי שרוצים, ושולחים לחברים קישור הזמנה לתכנון משותף</p>
          <div class="ticket glass" style="max-width:340px;margin:0 auto">
            <div class="ticket-label">✈ TRIP MAKER PASS ✈</div>
            <div class="code copyable" data-copy="${trip.share_code}" title="לחיצה מעתיקה את קוד הטיול">${trip.share_code}</div>
            <div class="ticket-sub">${TRIPI.esc(trip.title)}</div>
            <hr class="divider">
            <button class="btn btn-amber" id="cele-wa" style="width:100%;justify-content:center">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>
              ${shareInvite ? 'הזמנה לתכנון בוואטסאפ' : 'שיתוף בוואטסאפ'}</button>
            <button class="btn btn-ghost" id="cele-copy" style="width:100%;justify-content:center;margin-top:8px">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              ${shareInvite ? 'העתקת קישור הזמנה' : 'העתקת קישור'}</button>
            <div class="copy-feedback" id="cele-feedback"></div>
          </div>
          <button class="btn btn-ghost" id="cele-close" style="margin-top:16px">לטיול ›</button>
        </div>`;
      document.body.appendChild(wrap);
      const celeFlash = (msg) => {
        const f = wrap.querySelector('#cele-feedback');
        f.textContent = msg;
        setTimeout(() => { f.textContent = ''; }, 2200);
      };
      wrap.querySelector('#cele-wa').onclick = () => document.getElementById('wa-share').onclick();
      wrap.querySelector('#cele-copy').onclick = async () => {
        await TRIPI.copy(shareInvite ? inviteLink() : tripLink());
        celeFlash(shareInvite ? 'קישור ההזמנה הועתק! ✓' : 'הקישור הועתק! ✓');
      };
      wrap.querySelector('#cele-close').onclick = () => wrap.remove();
      wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    }

    // ---- destinations: map, weather, hotels (with a switcher for multi-city trips) ----
    let dests = Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [];
    if (!dests.length) dests = [{ name: trip.destination, country: trip.country, lat: null, lon: null }];

    const switcher = document.getElementById('dest-switcher');
    if (dests.length > 1) {
      switcher.style.display = '';
      switcher.innerHTML = '<div class="side-card-title" style="margin-bottom:8px">🧳 תחנות בטיול</div>' +
        dests.map((d, i) => `<button class="day-tab${i === 0 ? ' active' : ''}" data-i="${i}">${TRIPI.esc(d.name)}</button>`).join('');
      switcher.querySelectorAll('.day-tab').forEach((b) => {
        b.onclick = () => {
          switcher.querySelectorAll('.day-tab').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          showDestination(dests[+b.dataset.i]);
        };
      });
    }

    // the trip day "today" falls on, else day 1 — where the map opens
    const liveTripDay = () => {
      if (!trip.start_date) return 1;
      const diff = Math.floor((Date.now() - new Date(trip.start_date).getTime()) / 86400000) + 1;
      return diff >= 1 && diff <= trip.days ? diff : 1;
    };

    let currentDest = dests[0];
    let tripMapReady = false;

    async function showDestination(d) {
      // resolve coordinates once if this destination has none (old or free-text trips)
      if (d.lat == null) {
        const found = await GEO.searchPlaces(d.name).catch(() => []);
        if (found[0]) { d.lat = found[0].lat; d.lon = found[0].lon; if (!d.country) d.country = found[0].country; }
      }
      currentDest = d;
      paintMap(d);
      loadWeather(d);
    }

    // the map half of showDestination, on its own so the geocode backfill below can
    // bring the map up (or repaint it) without re-running the weather fetch
    function paintMap(d) {
      const mapQuery = `${d.name}${d.country && d.country !== d.name ? ', ' + d.country : ''}`;
      document.getElementById('map-caption').textContent = `📍 ${mapQuery}`;
      // a Leaflet map with nothing to frame (unresolvable free-text destination AND
      // no located stops) is a blank canvas — the name-keyed embed still shows a map
      const anythingLocated = d.lat != null || tripItems.some((it) => it.lat != null);
      if (TripMap.available() && (tripMapReady || anythingLocated)) {
        if (!tripMapReady) {
          document.getElementById('trip-map').innerHTML = ''; // may hold the iframe fallback
          tripMapReady = TripMap.init({
            trip,
            items: () => tripItems,
            currentDest: () => currentDest,
            openStop: (id) => TripCalendar.openStop(calCtx, id),
            initialDay: liveTripDay(),
          });
        } else {
          TripMap.showDest(d);
        }
      } else {
        // Leaflet didn't load (stale cache, blocked vendor file) or there are no
        // coordinates anywhere — the old destination embed beats a dead box
        document.getElementById('trip-map').innerHTML =
          `<iframe title="מפת היעד" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
             src="${TRIPI.esc(TRIPI.mapsEmbedUrl(mapQuery))}"></iframe>`;
      }
    }

    // Stops built before the AI kept its verified coordinates (and any the geocoder
    // missed on build day) carry a place name and no pin — the map would open on the
    // destination alone. The server geocodes them a batch at a time and stores what it
    // resolves, so this runs once in a trip's life; the pins appear as the batches land.
    // How far a geocoder hit may sit from the area it belongs to before it's the wrong
    // place with the right name — "Benny HaDayag, Eilat" resolves to a Rishon LeZion
    // branch 250km up the coast. 80km still clears a day-trip's outskirts.
    const LOCATE_MAX_KM = 80;
    const kmApart = (a, b) => {
      const rad = Math.PI / 180;
      return Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(b.lat * rad));
    };
    const destForItem = (it) =>
      tripDests.find((d) => d.name === it.area && d.lat != null) ||
      tripDests.find((d) => d.lat != null) || (currentDest.lat != null ? currentDest : null);

    // Photon refuses Render's datacenter IP, so the server-side pass comes back empty
    // in production while the very same lookup answers from here — the place picker
    // has always used it from the browser. A planner's own page does the geocoding
    // and posts the coordinates back; viewers still get whatever the server can place.
    async function locateInBrowser() {
      const todo = tripItems.filter((it) => it.lat == null && it.place_query).slice(0, 120);
      const found = [];
      for (const it of todo) {
        const dest = destForItem(it);
        const hits = await GEO.searchPois(it.place_query, dest && dest.lat, dest && dest.lon).catch(() => []);
        // Photon's bias only re-ranks — the distance check is what rejects a same-name
        // place in another city, and without a located area nothing can be checked
        const hit = hits.find((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon) &&
          (!dest || kmApart(h, dest) <= LOCATE_MAX_KM));
        if (!hit) continue;
        it.lat = hit.lat; it.lon = hit.lon;
        found.push({ id: it.id, lat: hit.lat, lon: hit.lon });
        if (tripMapReady) TripMap.refresh(); else paintMap(currentDest); // pins land one by one
      }
      if (!found.length) return;
      try {
        await TRIPI.api(`/api/trips/code/${trip.share_code}/locate`, {
          method: 'POST', headers: canEditHeaders, body: JSON.stringify({ coords: found }),
        });
      } catch { /* the map is right for this visit either way; the next load retries */ }
    }

    async function locateStops() {
      let skip = 0; // stops already asked about — a name the geocoder can't place stays null
      for (let round = 0; round < 8; round++) {
        if (!tripItems.some((it) => it.lat == null && it.place_query)) return;
        let r;
        try {
          r = await TRIPI.api(`/api/trips/code/${trip.share_code}/locate`, {
            method: 'POST', body: JSON.stringify({ skip }),
          });
        } catch { return; } // a viewer's map is not worth an error toast
        const byId = new Map(tripItems.map((it) => [it.id, it]));
        for (const l of r.located || []) {
          const it = byId.get(l.id);
          if (it) { it.lat = l.lat; it.lon = l.lon; }
        }
        // repaint the map only — the list and calendar key their map links off
        // place_query, so nothing else changes under the user's hands mid-visit
        if ((r.located || []).length) {
          if (tripMapReady) TripMap.refresh(); else paintMap(currentDest);
        }
        skip += (r.attempted || 0) - (r.located || []).length; // the failures, kept behind us
        if (!r.remaining) return;
      }
    }

    const weatherDayHtml = (w) => `
          <div class="weather-day" title="${GEO.weatherLabel(w.code)}${w.est ? ' · ממוצע היסטורי' : ''}">
            <div class="wd-name">${new Date(w.date + 'T00:00').toLocaleDateString('he-IL', { weekday: 'short' })}</div>
            <div class="wd-icon">${GEO.weatherIcon(w.code)}</div>
            <div class="wd-temp">${w.est ? '≈' : ''}${w.max}°<span>${w.min}°</span></div>
          </div>`;

    async function loadWeather(d) {
      const card = document.getElementById('weather-card');
      const sub = document.getElementById('weather-sub');
      card.classList.remove('wx-trip', 'wx-est');
      sub.hidden = true;
      if (d.lat == null) { card.style.display = 'none'; return; }
      card.style.display = '';
      document.getElementById('weather-row').innerHTML = `
        <div class="weather-day">
          <span class="skl skl-wd-name"></span><span class="skl skl-wd-icon"></span><span class="skl skl-wd-temp"></span>
        </div>`.repeat(7);
      try {
        // beyond the 16-day horizon no forecast can reach the trip — say what the
        // trip's dates are TYPICALLY like there (last two years, averaged) instead
        // of showing this week's weather for a trip that starts next month
        const startD = dayDate(1);
        const daysUntil = startD
          ? Math.round((startD - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000) : null;
        if (daysUntil != null && daysUntil > 15) {
          const tripDates = Array.from({ length: trip.days }, (_, i) => TRIPI.isoDate(dayDate(i + 1)));
          const est = await GEO.typicalWeather(d.lat, d.lon, tripDates).catch(() => []);
          if (est.length) {
            weatherByDate = {};
            for (const w of est) weatherByDate[w.date] = w;
            renderItinerary(); // day headers get their ≈typical badge
            card.classList.add('wx-est');
            document.getElementById('weather-title').textContent = '🌤️ מזג האוויר הטיפוסי בימי הטיול';
            sub.textContent = 'ממוצע השנתיים האחרונות בתאריכים האלה · תחזית אמיתית תופיע כשמתקרבים';
            sub.hidden = false;
            document.getElementById('weather-row').innerHTML = est.slice(0, 7).map(weatherDayHtml).join('');
            return;
          }
          // archive unavailable — fall through to the plain forecast strip below
        }
        // when the trip has dates in the next 16 days, fetch far enough to align per itinerary day
        const wantDates = !!trip.start_date;
        const days = await GEO.forecast(d.lat, d.lon, wantDates ? 16 : 7);
        weatherByDate = {};
        if (wantDates) {
          for (const w of days) weatherByDate[w.date] = w;
          renderItinerary(); // stamp each day header with its own forecast
        }
        // the strip is always a forecast from today, so it only says something
        // about *this trip* when the horizon actually reaches the trip's days.
        // When it does, the strip becomes the trip's own days and says so; when
        // it doesn't it stays "the coming week at the destination" — true, but
        // not about this trip, so the printed sheet drops it (see .wx-trip).
        const tripDays = wantDates
          ? Array.from({ length: trip.days }, (_, i) => dayDate(i + 1))
            .map((d2) => d2 && weatherByDate[TRIPI.isoDate(d2)])
            .filter(Boolean)
          : [];
        card.classList.toggle('wx-trip', tripDays.length > 0);
        document.getElementById('weather-title').textContent =
          tripDays.length ? '🌤️ מזג האוויר בימי הטיול' : '🌤️ מזג האוויר בשבוע הקרוב';
        document.getElementById('weather-row').innerHTML =
          (tripDays.length ? tripDays : days).slice(0, 7).map(weatherDayHtml).join('');
        card.style.display = '';
      } catch { card.style.display = 'none'; }
    }

    showDestination(dests[0]);
    if (canEdit) locateInBrowser(); else locateStops();
    const ticketCode = document.getElementById('ticket-code');
    ticketCode.textContent = trip.share_code;
    ticketCode.classList.add('copyable');
    ticketCode.title = 'לחיצה מעתיקה את קוד הטיול';
  }

  // ---------- WebMCP: the tools that only exist while a trip is open ----------
  // These go through the page's own addItem/saveItem/deleteItem rather than calling the
  // API directly, so an agent's edit lands in both views and the ambient UI exactly as a
  // human's would. A tool that wrote straight to the server would leave the open page
  // showing an itinerary that no longer exists.
  function registerTripTools(ctx) {
    if (typeof TRIPI === 'undefined' || !TRIPI.mcp || !TRIPI.mcp.stopProps) return;
    const { register, ok, fail } = TRIPI.mcp;
    const stopProps = TRIPI.mcp.stopProps;
    const { trip, state, canEdit, addItem, saveItem, deleteItem, items } = ctx;

    // stop ids come from tripmaker_current_trip / tripmaker_get_trip; resolving here
    // means a stale id is a readable tool error instead of a crash
    const findStop = (id) => items().find((it) => String(it.id) === String(id));
    const readOnly = () => fail(
      'This trip is read-only for the current user. Only the owner and trip participants can edit it — a participant joins through an invite link.'
    );
    const publicStop = (it) => ({
      id: it.id,
      day_number: it.day_number,
      title: it.title,
      time_label: it.time_label || null,
      category: it.category || null,
      area: it.area || null,
      note: it.note || null,
      place_query: it.place_query || null,
      lat: it.lat ?? null,
      lon: it.lon ?? null,
      cost: it.cost ?? null,
    });
    // only the fields the API accepts on a stop, and only the ones actually supplied —
    // the PATCH endpoint treats a present key as an instruction to write it, so passing
    // undefined through would blank out fields the agent never mentioned
    const pickStopFields = (input) => {
      const out = {};
      for (const key of Object.keys(stopProps)) {
        if (input[key] !== undefined) out[key] = input[key];
      }
      return out;
    };

    register({
      name: 'tripmaker_current_trip',
      title: 'The trip on screen',
      description: 'The trip currently open in the browser, with every stop and its id, straight from the page state. Use this instead of tripmaker_get_trip while a trip page is open — it reflects unsaved-to-your-view edits made moments ago.',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const byDay = new Map();
        for (const it of items()) {
          if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
          byDay.get(it.day_number).push(publicStop(it));
        }
        return ok({
          code: trip.share_code,
          url: location.origin + '/trip/' + trip.share_code,
          title: trip.title,
          destination: trip.destination,
          destinations: Array.isArray(trip.destinations) ? trip.destinations : [],
          days: trip.days,
          start_date: trip.start_date || null,
          end_date: trip.end_date || null,
          is_draft: !!trip.is_draft,
          can_edit: !!canEdit,
          stop_count: items().length,
          itinerary: Array.from({ length: trip.days }, (_, i) => i + 1)
            .map((day) => ({ day, stops: byDay.get(day) || [] })),
          hotels: state.hotels || [],
          budget: state.budget || null,
        });
      },
    });

    register({
      name: 'tripmaker_add_stop',
      title: 'Add a stop',
      description: 'Add one stop to a day of the open trip. The page repaints immediately. Adding many stops means many calls — to build a whole itinerary at once, use tripmaker_create_trip with its items array instead.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: stopProps,
        required: ['day_number', 'title'],
      },
      execute: async (input) => {
        if (!canEdit) return readOnly();
        if (!String(input.title || '').trim()) return fail('title is required');
        const day = parseInt(input.day_number, 10);
        if (!(day >= 1 && day <= trip.days)) return fail(`day_number must be between 1 and ${trip.days}`);
        const item = await addItem({ ...pickStopFields(input), day_number: day });
        return ok({ added: true, stop: publicStop(item) });
      },
    });

    register({
      name: 'tripmaker_update_stop',
      title: 'Edit a stop',
      description: 'Change fields on an existing stop of the open trip. Only the fields you pass are touched — everything else keeps its value. Pass day_number to move a stop to a different day.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          stop_id: { type: 'integer', description: 'id of the stop, from tripmaker_current_trip.' },
          ...stopProps,
        },
        required: ['stop_id'],
      },
      execute: async (input) => {
        if (!canEdit) return readOnly();
        const item = findStop(input.stop_id);
        if (!item) return fail('no stop with id ' + input.stop_id + ' in this trip');
        const patch = pickStopFields(input);
        if (!Object.keys(patch).length) return fail('nothing to update — pass at least one field besides stop_id');
        if (patch.day_number !== undefined) {
          const day = parseInt(patch.day_number, 10);
          if (!(day >= 1 && day <= trip.days)) return fail(`day_number must be between 1 and ${trip.days}`);
          patch.day_number = day;
        }
        const updated = await saveItem(item, patch);
        return ok({ updated: true, stop: publicStop(updated) });
      },
    });

    register({
      name: 'tripmaker_delete_stop',
      title: 'Delete a stop',
      description: 'Remove a stop from the open trip. This cannot be undone — read the stop with tripmaker_current_trip and confirm it is the right one before calling.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: 'object',
        properties: { stop_id: { type: 'integer', description: 'id of the stop, from tripmaker_current_trip.' } },
        required: ['stop_id'],
      },
      execute: async ({ stop_id }) => {
        if (!canEdit) return readOnly();
        const item = findStop(stop_id);
        if (!item) return fail('no stop with id ' + stop_id + ' in this trip');
        const removed = publicStop(item);
        await deleteItem(item);
        return ok({ deleted: true, stop: removed });
      },
    });
  }

  load();
})();
