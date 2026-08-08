// Trip page: loads a trip by its 6-digit share code from the URL (/trip/123456).
(() => {
  const code = location.pathname.split('/').pop();

  const heDate = (d) => d ? new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' }) : null;

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

  // A long trip opens as a calendar for everyone who can't edit it, so the list-shaped
  // placeholder in the HTML is the wrong shape for it. The server marks the day count on
  // the container when the trip is a long one — enough to lay the month grid out before
  // the fetch. Which shape a trip settled on is remembered (rememberShape below), because
  // edit rights only come back with the trip itself; until then a signed-out visitor is
  // the one case we can be sure about.
  const savedShapes = JSON.parse(localStorage.getItem('tripi_view_shapes') || '{}');
  function rememberShape(shape) {
    if (savedShapes[code] === shape) return;
    savedShapes[code] = shape;
    localStorage.setItem('tripi_view_shapes', JSON.stringify(savedShapes));
  }
  (function calendarPlaceholder() {
    const container = document.getElementById('days-container');
    const days = +container.dataset.sklDays;
    if (!days) return;
    const opensAsCalendar = savedShapes[code] ? savedShapes[code] === 'calendar' : !TRIPI.user;
    if (!opensAsCalendar) return;
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

  async function load() {
    // an invite link + a logged-in user = redeem first, so the page arrives unlocked
    if (TRIPI.user && inviteToken) await redeemInvite();
    let data;
    try {
      data = await TRIPI.api('/api/trips/code/' + encodeURIComponent(code));
    } catch {
      document.querySelector('.trip-hero').style.display = 'none';
      document.getElementById('trip-layout').style.display = 'none';
      document.getElementById('not-found').style.display = '';
      return;
    }
    const { trip, items, isOwner } = data;
    const isAdmin = !!data.isAdmin; // admins edit any trip
    const canEdit = !!data.canEdit;
    let participants = data.participants || [];
    editMode = canEdit; // participants edit inline — there's no separate mode to enter

    document.title = `${trip.title} · TRIPI`;
    if (trip.cover_image) {
      document.getElementById('trip-cover').style.backgroundImage = `url('${trip.cover_image.replace(/'/g, '')}')`;
    }
    document.getElementById('trip-title').textContent = `${trip.emoji || '🧭'} ${trip.title}`;

    const meta = [];
    meta.push(`<span class="chip"><span class="dot">●</span> ${TRIPI.esc(trip.destination)}${trip.country ? ', ' + TRIPI.esc(trip.country) : ''}</span>`);
    meta.push(`<span class="chip"><span class="dot">●</span> ${trip.days} ימים</span>`);
    if (trip.start_date) {
      const range = trip.end_date ? `${heDate(trip.start_date)} – ${heDate(trip.end_date)}` : heDate(trip.start_date);
      meta.push(`<span class="chip"><span class="dot">●</span> ${range}</span>`);
    }
    meta.push(`<span class="chip copyable" dir="ltr" title="לחיצה מעתיקה את קוד הטיול"
      data-copy="${trip.share_code}" style="letter-spacing:.2em;color:var(--amber)">#${trip.share_code}</span>`);
    document.getElementById('trip-meta').innerHTML = meta.join('');

    document.getElementById('trip-layout').style.display = '';
    document.getElementById('trip-desc').innerHTML = trip.description
      ? TRIPI.esc(trip.description)
      : 'עוד אין תיאור לטיול הזה — אבל המסלול מדבר בעד עצמו 🙂';

    // itinerary grouped by day (weatherByDate is filled by loadWeather when dates align)
    let tripItems = items.slice();
    let weatherByDate = {};

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

    // every existing call site funnels through here, so both views stay fresh
    function renderItinerary() {
      if (!longTrip) {
        viewToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === viewMode));
      }
      if (viewMode === 'calendar') {
        rememberShape('calendar'); // so the next visit starts on a calendar-shaped placeholder
        TripCalendar.render(container, { trip, state, dayDate, weather: () => weatherByDate });
        return;
      }
      rememberShape('list'); // only short trips reach here — a long trip is calendar-only
      TripCalendar.exitFull(); // the list can't live inside the fullscreen calendar
      renderListView();
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
        const iso = date ? date.toISOString().slice(0, 10) : null;
        const w = iso && weatherByDate[iso];
        const hotelLines = TripModals.dayHotelLines(state, day);
        return `
        <div class="day-block">
          <div class="day-title">
            <span class="day-badge">יום ${day}</span>
            ${date ? `<span class="day-date">${date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</span>` : ''}
            ${dayCosts[day] ? `<span class="day-cost" title="עלות משוערת של היום (בלי לינה)">${TripModals.fmt(dayCosts[day], cur)}</span>` : ''}
            ${w ? `<span class="day-weather" title="${GEO.weatherLabel(w.code)}">${GEO.weatherIcon(w.code)} ${w.max}°</span>` : ''}
          </div>
          ${hotelLines.length ? `<div class="day-hotels">${hotelLines.map((l) =>
            `<span class="day-hotel ${l.cls}">${l.html}</span>`).join('')}</div>` : ''}
          <div class="timeline">
            ${byDay.get(day).map((it) => {
              const hasMap = !!(it.place_query || (it.lat != null && it.lon != null));
              const expandable = hasMap || editMode; // edit mode: every stop opens, to edit its location
              const isTravel = it.category === 'נסיעה';
              return `
              <div class="item-card glass${expandable ? ' expandable' : ''}${isTravel ? ' travel' : ''}"
                ${isTravel ? `data-ticon="${TripModals.travelIcon(it)}"` : ''} data-item-id="${it.id}">
                <div class="item-top">
                  ${it.time_label ? `<span class="item-time">${TRIPI.esc(it.time_label)}</span>` : ''}
                  <span class="item-title">${TRIPI.esc(it.title)}</span>
                  ${+it.cost > 0 ? `<span class="item-cost">${TripModals.fmt(it.cost, TripModals.curOf(state))}</span>` : ''}
                  ${multiDest() && it.area ? `<span class="item-area">📍 ${TRIPI.esc(it.area)}</span>` : ''}
                  ${it.category ? `<span class="item-cat">${TRIPI.esc(it.category)}</span>` : ''}
                  ${editMode ? `<button class="item-del" data-id="${it.id}" title="מחיקת תחנה">✕</button>` : ''}
                </div>
                ${it.note ? `<div class="item-note">${TRIPI.esc(it.note)}</div>` : ''}
                ${expandable ? `
                  <button type="button" class="item-expand-btn" aria-expanded="false">
                    <span class="ieb-text">${editMode ? 'פרטים ועריכת מיקום' : 'מפה ותמונות'}</span>
                    <span class="ieb-caret" aria-hidden="true">▾</span>
                  </button>
                  <div class="item-more-wrap"><div class="item-more"></div></div>` : ''}
              </div>`;
            }).join('')}
            ${byDay.get(day).length === 0 && editMode ? '<div class="empty-day">יום פנוי — מוסיפים תחנה למטה ↓</div>' : ''}
            ${editMode ? `<button class="add-item-inline" data-day="${day}">+ הוספת תחנה ליום ${day}</button>` : ''}
          </div>
        </div>`;
      }).join('');

      // click to expand: lazy-load an exact-location mini map inside the card
      container.querySelectorAll('.item-card.expandable').forEach((card) => {
        const toggle = (e) => {
          if (e.target.closest('.item-del') || e.target.closest('a')) return;
          const it = tripItems.find((x) => x.id === +card.dataset.itemId);
          const more = card.querySelector('.item-more');
          const btn = card.querySelector('.item-expand-btn');
          if (card.classList.contains('expanded')) {
            card.classList.remove('expanded');
            btn.setAttribute('aria-expanded', 'false');
            btn.querySelector('.ieb-text').textContent = editMode ? 'פרטים ועריכת מיקום' : 'מפה ותמונות';
            return;
          }
          if (!more.dataset.loaded) {
            const hasMap = !!(it.place_query || (it.lat != null && it.lon != null));
            more.innerHTML = `
              ${it.place_query ? `<div class="item-more-place"><span class="imp-pin">📍</span><span class="imp-text">${TRIPI.esc(it.place_query)}</span></div>` : ''}
              ${hasMap ? `<iframe class="item-mini-map" loading="lazy" title="מפת התחנה" src="${TRIPI.mapsEmbedUrlExact(it)}"></iframe>` : ''}
              ${it.place_query ? '<div class="stop-gallery"></div>' : ''}
              ${editMode ? `
                <button type="button" class="edit-loc-btn">📍 ${it.place_query ? 'שינוי מיקום' : 'הוספת מיקום'}</button>
                <div class="edit-loc-form" hidden>
                  <input type="text" class="edit-loc-input" maxlength="120" placeholder="הקלידו ובחרו מהרשימה…" autocomplete="off" value="${TRIPI.esc(it.place_query || '')}">
                  <div style="display:flex;gap:8px;margin-top:8px">
                    <button type="button" class="btn btn-amber edit-loc-save" style="flex:1;justify-content:center">שמירה</button>
                    <button type="button" class="btn btn-ghost edit-loc-cancel">ביטול</button>
                  </div>
                  <div class="form-error edit-loc-err"></div>
                </div>` : ''}`;
            more.dataset.loaded = '1';
            const gal = more.querySelector('.stop-gallery');
            if (gal) GEO.renderGallery(gal, it.place_query);

            const locBtn = more.querySelector('.edit-loc-btn');
            if (locBtn) {
              const locForm = more.querySelector('.edit-loc-form');
              const locInput = more.querySelector('.edit-loc-input');
              const locPicker = GEO.attachPlaceAutocomplete(locInput, {
                getBias: () => ({ lat: it.lat ?? dests[0]?.lat, lon: it.lon ?? dests[0]?.lon }),
              });
              locBtn.onclick = (e) => { e.stopPropagation(); locForm.hidden = false; locBtn.hidden = true; locInput.focus(); };
              more.querySelector('.edit-loc-cancel').onclick = (e) => { e.stopPropagation(); locForm.hidden = true; locBtn.hidden = false; };
              more.querySelector('.edit-loc-save').onclick = async (e) => {
                e.stopPropagation();
                const saveBtn = e.currentTarget;
                if (saveBtn.disabled) return;
                saveBtn.disabled = true;
                const picked = locPicker.getPicked();
                try {
                  const updated = await TRIPI.api(`/api/trips/code/${trip.share_code}/items/${it.id}`, {
                    method: 'PATCH', headers: canEditHeaders,
                    body: JSON.stringify({
                      place_query: locInput.value.trim() || null,
                      lat: picked ? picked.lat : null,
                      lon: picked ? picked.lon : null,
                    }),
                  });
                  Object.assign(it, { place_query: updated.place_query, lat: updated.lat, lon: updated.lon });
                  renderItinerary();
                } catch (err) {
                  more.querySelector('.edit-loc-err').textContent = err.message;
                  saveBtn.disabled = false;
                }
              };
            }
          }
          card.classList.add('expanded');
          btn.setAttribute('aria-expanded', 'true');
          btn.querySelector('.ieb-text').textContent = 'סגירה';
        };
        card.querySelector('.item-top').addEventListener('click', toggle);
        card.querySelector('.item-expand-btn').addEventListener('click', toggle);
      });

      if (editMode) {
        container.querySelectorAll('.item-del').forEach((b) => {
          b.onclick = async () => {
            if (b.disabled) return;
            if (!confirm('למחוק את התחנה?')) return;
            b.disabled = true;
            try {
              await TRIPI.api(`/api/trips/code/${trip.share_code}/items/${b.dataset.id}`, { method: 'DELETE', headers: canEditHeaders });
              tripItems = tripItems.filter((it) => it.id !== +b.dataset.id);
              renderItinerary();
              updateAmbient();
            } catch (e) { alert(e.message); b.disabled = false; }
          };
        });
        container.querySelectorAll('.add-item-inline').forEach((b) => {
          b.onclick = () => openAddItemForm(+b.dataset.day, b);
        });
      }
    }

    function openAddItemForm(day, anchorBtn) {
      document.querySelector('.inline-item-form')?.remove();
      const form = document.createElement('div');
      form.className = 'inline-item-form glass';
      form.innerHTML = `
        <div class="form-grid">
          <div class="field"><label>שעה</label><input type="time" class="iif-time"></div>
          <div class="field"><label>קטגוריה</label><select class="iif-cat">
            <option>אטרקציה</option><option>אוכל</option><option>טבע</option><option>ים</option>
            <option>תרבות</option><option>קניות</option><option>לינה</option><option>נוף</option>
            <option>חיי לילה</option><option>נסיעה</option></select></div>
          <div class="field span-2"><label>מה עושים? *</label><input type="text" class="iif-title" maxlength="120" placeholder="למשל: ארוחת ערב על הגג"></div>
          ${multiDest() ? `<div class="field span-2"><label>באיזה אזור?</label><select class="iif-area">
            ${tripDests.map((d) => `<option${d.name === defaultAreaForDay(day) ? ' selected' : ''}>${TRIPI.esc(d.name)}</option>`).join('')}
          </select></div>` : ''}
          <div class="field span-2"><label>מיקום (חיפוש מקומות)</label><input type="text" class="iif-place" maxlength="120" placeholder="הקלידו ותבחרו מהרשימה…" autocomplete="off"></div>
          <div class="field span-2"><label>עלות משוערת (לא חובה)</label><input type="number" min="0" class="iif-cost" placeholder="נכנסת ישר לתקציב"></div>
        </div>
        <div class="form-error iif-err"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-amber iif-save" style="flex:1;justify-content:center">הוספה</button>
          <button class="btn btn-ghost iif-cancel">ביטול</button>
        </div>`;
      anchorBtn.parentNode.insertBefore(form, anchorBtn);
      const placeInput = form.querySelector('.iif-place');
      const picker = GEO.attachPlaceAutocomplete(placeInput, {
        getBias: () => ({ lat: dests[0]?.lat, lon: dests[0]?.lon }),
      });
      form.querySelector('.iif-cancel').onclick = () => form.remove();
      form.querySelector('.iif-save').onclick = async (ev) => {
        const saveBtn = ev.currentTarget;
        if (saveBtn.disabled) return; // double-tap → one stop, not two
        const title = form.querySelector('.iif-title').value.trim();
        if (!title) { form.querySelector('.iif-err').textContent = 'צריך לכתוב מה עושים'; return; }
        saveBtn.disabled = true;
        try {
          const item = await TRIPI.api(`/api/trips/code/${trip.share_code}/items`, {
            method: 'POST', headers: canEditHeaders,
            body: JSON.stringify({
              day_number: day,
              time_label: form.querySelector('.iif-time').value || null,
              title,
              category: form.querySelector('.iif-cat').value,
              place_query: placeInput.value.trim() || null,
              area: form.querySelector('.iif-area')?.value || tripDests[0]?.name || null,
              lat: picker.getPicked()?.lat ?? null,
              lon: picker.getPicked()?.lon ?? null,
              cost: form.querySelector('.iif-cost').value || null,
            }),
          });
          tripItems.push(item);
          tripItems.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')));
          renderItinerary();
          updateAmbient();
        } catch (e) {
          form.querySelector('.iif-err').textContent = e.message;
          saveBtn.disabled = false;
        }
      };
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
      }
      renderParticipantsList(wrap);
      wrap.classList.add('open');
    }

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
    function showAiEditCard() { aiCard.style.display = ''; }
    if (canEditHeaders) showAiEditCard();
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
        const r = await TRIPI.api(`/api/trips/code/${trip.share_code}/ai-edit`, {
          method: 'POST', headers: canEditHeaders || {},
          body: JSON.stringify({ prompt }),
        });
        tripItems = r.items;
        renderItinerary();
        const changed = r.added + r.updated + r.removed > 0;
        aiResult.classList.add(changed ? 'ok' : 'info');
        aiResult.textContent = r.summary;
        if (changed) { aiInput.value = ''; aiCount.textContent = '0/200'; }
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

    // ---- clone button: published trips can be copied into my account ----
    const cloneBtn = document.getElementById('clone-btn');
    async function doClone() {
      if (cloneBtn.disabled) return;
      cloneBtn.disabled = true;
      const cloneLabel = document.getElementById('clone-label');
      const prevLabel = cloneLabel.textContent;
      cloneLabel.textContent = 'משכפלים…';
      try {
        const copy = await TRIPI.api(`/api/trips/code/${trip.share_code}/clone`, { method: 'POST' });
        location.href = '/trip/' + copy.share_code;
      } catch (e) {
        alert(e.message);
        cloneBtn.disabled = false;
        cloneLabel.textContent = prevLabel;
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

    // likes and cloning are gallery features — they appear only on published trips
    // (and follow the publish toggle live)
    function syncPublicUI() {
      likeBtn.style.display = trip.is_public ? '' : 'none';
      cloneBtn.style.display = trip.is_public ? '' : 'none';
    }
    syncPublicUI();

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
          document.getElementById('trip-meta').appendChild(chipEl);
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

    // ---- print / WhatsApp ----
    document.getElementById('print-btn').onclick = () => window.print();
    document.getElementById('wa-share').onclick = () => {
      const text = `${trip.emoji || '🧭'} ${trip.title}\n${trip.destination} · ${trip.days} ימים\nקוד טיול: ${trip.share_code}\n${location.href}`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    };

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

    async function showDestination(d) {
      // resolve coordinates once if this destination has none (old or free-text trips)
      if (d.lat == null) {
        const found = await GEO.searchPlaces(d.name).catch(() => []);
        if (found[0]) { d.lat = found[0].lat; d.lon = found[0].lon; if (!d.country) d.country = found[0].country; }
      }
      const mapQuery = `${d.name}${d.country && d.country !== d.name ? ', ' + d.country : ''}`;
      document.getElementById('trip-map').src = TRIPI.mapsEmbedUrl(mapQuery);
      document.getElementById('map-caption').textContent = `📍 ${mapQuery}`;
      loadWeather(d);
      // loadHotels(d, mapQuery); // כרטיס "מלונות באזור" מוסתר זמנית (גם ה-HTML שלו מוער ב-trip.html)
    }

    async function loadWeather(d) {
      const card = document.getElementById('weather-card');
      if (d.lat == null) { card.style.display = 'none'; return; }
      card.style.display = '';
      document.getElementById('weather-row').innerHTML = `
        <div class="weather-day">
          <span class="skl skl-wd-name"></span><span class="skl skl-wd-icon"></span><span class="skl skl-wd-temp"></span>
        </div>`.repeat(7);
      try {
        // when the trip has dates in the next 16 days, fetch far enough to align per itinerary day
        const wantDates = !!trip.start_date;
        const days = await GEO.forecast(d.lat, d.lon, wantDates ? 16 : 7);
        weatherByDate = {};
        if (wantDates) {
          for (const w of days) weatherByDate[w.date] = w;
          renderItinerary(); // stamp each day header with its own forecast
        }
        document.getElementById('weather-row').innerHTML = days.slice(0, 7).map((w) => `
          <div class="weather-day" title="${GEO.weatherLabel(w.code)}">
            <div class="wd-name">${new Date(w.date + 'T00:00').toLocaleDateString('he-IL', { weekday: 'short' })}</div>
            <div class="wd-icon">${GEO.weatherIcon(w.code)}</div>
            <div class="wd-temp">${w.max}°<span>${w.min}°</span></div>
          </div>`).join('');
        card.style.display = '';
      } catch { card.style.display = 'none'; }
    }

    async function loadHotels(d, mapQuery) { // eslint-disable-line no-unused-vars -- מושבת זמנית, ראו showDestination
      const card = document.getElementById('hotels-card');
      const list = document.getElementById('hotels-list');
      if (!card || d.lat == null) { if (card) card.style.display = 'none'; return; }
      card.style.display = '';
      list.innerHTML = `
        <div class="hotel-row skl-hotel">
          <span class="skl skl-hname"></span>
          <span class="hotel-links"><span class="skl skl-dot"></span><span class="skl skl-dot"></span></span>
        </div>`.repeat(4);
      try {
        const hotels = await GEO.hotelsNear(d.lat, d.lon);
        if (!hotels.length) throw new Error('none');
        list.innerHTML = hotels.map((h) => `
          <div class="hotel-row">
            <span class="hotel-name">${TRIPI.esc(h.name)}${h.stars ? ` <span class="hotel-stars">${'★'.repeat(Math.min(+h.stars || 0, 5))}</span>` : ''}</span>
            <span class="hotel-links">
              <a target="_blank" rel="noopener" title="גוגל מפות" href="${TRIPI.mapsSearchUrl(h.name + ' ' + d.name)}">📍</a>
              <a target="_blank" rel="noopener" title="חיפוש בבוקינג" href="https://www.booking.com/searchresults.he.html?ss=${encodeURIComponent(h.name + ' ' + d.name)}">🛏️</a>
            </span>
          </div>`).join('');
        document.getElementById('hotels-foot').innerHTML =
          `<a target="_blank" rel="noopener" href="https://www.booking.com/searchresults.he.html?ss=${encodeURIComponent(mapQuery)}">לכל המלונות ב${TRIPI.esc(d.name)} ›</a>`;
      } catch {
        list.innerHTML = '';
        document.getElementById('hotels-foot').innerHTML =
          `<a target="_blank" rel="noopener" href="https://www.booking.com/searchresults.he.html?ss=${encodeURIComponent(mapQuery)}">חיפוש מלונות ב${TRIPI.esc(d.name)} ›</a>`;
      }
    }

    showDestination(dests[0]);
    const ticketCode = document.getElementById('ticket-code');
    ticketCode.textContent = trip.share_code;
    ticketCode.classList.add('copyable');
    ticketCode.title = 'לחיצה מעתיקה את קוד הטיול';

    const feedback = document.getElementById('copy-feedback');
    const flash = (msg) => { feedback.textContent = msg; setTimeout(() => { feedback.textContent = ''; }, 2200); };
    document.getElementById('copy-link').addEventListener('click', async () => {
      await TRIPI.copy(location.href);
      flash('הקישור הועתק! ✓');
    });
  }

  load();
})();
