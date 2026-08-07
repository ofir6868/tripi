// Trip page: loads a trip by its 6-digit share code from the URL (/trip/123456).
(() => {
  const code = location.pathname.split('/').pop();

  const heDate = (d) => d ? new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' }) : null;

  // edit rights: owner (JWT) or a previously entered edit code kept per-trip
  const savedEditCodes = JSON.parse(localStorage.getItem('tripi_edit_codes') || '{}');
  let editMode = false;
  let canEditHeaders = null; // extra headers for item API calls

  async function load() {
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
    meta.push(`<span class="chip" dir="ltr" style="letter-spacing:.2em;color:var(--amber)">#${trip.share_code}</span>`);
    document.getElementById('trip-meta').innerHTML = meta.join('');

    document.getElementById('trip-layout').style.display = '';
    document.getElementById('trip-desc').innerHTML = trip.description
      ? TRIPI.esc(trip.description)
      : 'עוד אין תיאור לטיול הזה — אבל המסלול מדבר בעד עצמו 🙂';

    // itinerary grouped by day (weatherByDate is filled by loadWeather when dates align)
    let tripItems = items.slice();
    let weatherByDate = {};
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

    function renderItinerary() {
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
      container.innerHTML = [...byDay.keys()].sort((a, b) => a - b).map((day) => {
        const date = dayDate(day);
        const iso = date ? date.toISOString().slice(0, 10) : null;
        const w = iso && weatherByDate[iso];
        return `
        <div class="day-block">
          <div class="day-title">
            <span class="day-badge">יום ${day}</span>
            ${date ? `<span class="day-date">${date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</span>` : ''}
            ${w ? `<span class="day-weather" title="${GEO.weatherLabel(w.code)}">${GEO.weatherIcon(w.code)} ${w.max}°</span>` : ''}
          </div>
          <div class="timeline">
            ${byDay.get(day).map((it) => {
              const hasMap = !!(it.place_query || (it.lat != null && it.lon != null));
              const expandable = hasMap || editMode; // edit mode: every stop opens, to edit its location
              return `
              <div class="item-card glass${expandable ? ' expandable' : ''}" data-item-id="${it.id}">
                <div class="item-top">
                  ${it.time_label ? `<span class="item-time">${TRIPI.esc(it.time_label)}</span>` : ''}
                  <span class="item-title">${TRIPI.esc(it.title)}</span>
                  ${multiDest() && it.area ? `<span class="item-area">📍 ${TRIPI.esc(it.area)}</span>` : ''}
                  ${it.category ? `<span class="item-cat">${TRIPI.esc(it.category)}</span>` : ''}
                  ${expandable ? '<span class="item-chevron" title="הרחבה">▾</span>' : ''}
                  ${editMode ? `<button class="item-del" data-id="${it.id}" title="מחיקת תחנה">✕</button>` : ''}
                </div>
                ${it.note ? `<div class="item-note">${TRIPI.esc(it.note)}</div>` : ''}
                ${it.place_query ? `<a class="item-map-link" target="_blank" rel="noopener" href="${TRIPI.mapsSearchUrl(it.place_query)}">📍 פתיחה בגוגל מפות</a>` : ''}
                ${expandable ? '<div class="item-more" hidden></div>' : ''}
              </div>`;
            }).join('')}
            ${byDay.get(day).length === 0 && editMode ? '<div class="empty-day">יום פנוי — מוסיפים תחנה למטה ↓</div>' : ''}
            ${editMode ? `<button class="add-item-inline" data-day="${day}">+ הוספת תחנה ליום ${day}</button>` : ''}
          </div>
        </div>`;
      }).join('');

      // click to expand: lazy-load an exact-location mini map inside the card
      container.querySelectorAll('.item-card.expandable').forEach((card) => {
        card.querySelector('.item-top').addEventListener('click', (e) => {
          if (e.target.closest('.item-del') || e.target.closest('a')) return;
          const it = tripItems.find((x) => x.id === +card.dataset.itemId);
          const more = card.querySelector('.item-more');
          const open = !more.hidden;
          if (open) { more.hidden = true; card.classList.remove('expanded'); return; }
          if (!more.dataset.loaded) {
            const hasMap = !!(it.place_query || (it.lat != null && it.lon != null));
            more.innerHTML = `
              ${it.place_query ? `<div class="item-more-place">📌 ${TRIPI.esc(it.place_query)}</div>` : ''}
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
          more.hidden = false;
          card.classList.add('expanded');
        });
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
            <option>חיי לילה</option><option>תחבורה</option></select></div>
          <div class="field span-2"><label>מה עושים? *</label><input type="text" class="iif-title" maxlength="120" placeholder="למשל: ארוחת ערב על הגג"></div>
          ${multiDest() ? `<div class="field span-2"><label>באיזה אזור?</label><select class="iif-area">
            ${tripDests.map((d) => `<option${d.name === defaultAreaForDay(day) ? ' selected' : ''}>${TRIPI.esc(d.name)}</option>`).join('')}
          </select></div>` : ''}
          <div class="field span-2"><label>מיקום (חיפוש מקומות)</label><input type="text" class="iif-place" maxlength="120" placeholder="הקלידו ותבחרו מהרשימה…" autocomplete="off"></div>
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
            }),
          });
          tripItems.push(item);
          tripItems.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')));
          renderItinerary();
        } catch (e) {
          form.querySelector('.iif-err').textContent = e.message;
          saveBtn.disabled = false;
        }
      };
    }

    renderItinerary();

    // ---- edit mode entry ----
    const editBtn = document.getElementById('edit-btn');
    function enterEditMode() {
      editMode = true;
      editBtn.textContent = '✅ סיום עריכה';
      editBtn.classList.add('editing');
      renderItinerary();
    }
    editBtn.onclick = () => {
      if (editMode) {
        editMode = false;
        editBtn.textContent = '✏️ עריכה';
        editBtn.classList.remove('editing');
        document.querySelector('.inline-item-form')?.remove();
        renderItinerary();
        return;
      }
      if (isOwner) { canEditHeaders = {}; enterEditMode(); return; }
      const saved = savedEditCodes[trip.share_code];
      if (saved) { canEditHeaders = { 'X-Edit-Code': saved }; enterEditMode(); return; }
      const entered = prompt('להזנת מצב עריכה צריך קוד עריכה בן 6 ספרות (מקבלים מבעל הטיול):');
      if (!entered) return;
      canEditHeaders = { 'X-Edit-Code': entered.trim() };
      // verify by trying a harmless call: add+nothing — instead verify by attempting entry; server checks on first mutation
      savedEditCodes[trip.share_code] = entered.trim();
      localStorage.setItem('tripi_edit_codes', JSON.stringify(savedEditCodes));
      enterEditMode();
    };

    // ---- owner box: edit code + publish toggle ----
    if (isOwner && trip.edit_code) {
      document.getElementById('owner-box').style.display = '';
      document.getElementById('edit-code').textContent = trip.edit_code;
      const toggle = document.getElementById('publish-toggle');
      toggle.checked = !!trip.is_public;
      toggle.onchange = async () => {
        try { await TRIPI.api('/api/trips/' + trip.id, { method: 'PATCH', body: JSON.stringify({ is_public: toggle.checked }) }); }
        catch (e) { toggle.checked = !toggle.checked; alert(e.message); }
      };
    }

    // ---- like button ----
    const likedTrips = JSON.parse(localStorage.getItem('tripi_likes') || '{}');
    const likeBtn = document.getElementById('like-btn');
    const likeCount = document.getElementById('like-count');
    likeCount.textContent = trip.likes || 0;
    if (likedTrips[trip.id]) likeBtn.firstChild.textContent = '❤️ ';
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
        likeBtn.firstChild.textContent = likedTrips[trip.id] ? '❤️ ' : '🤍 ';
      } catch { /* ignore */ } finally { likeBusy = false; }
    };

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
      loadHotels(d, mapQuery);
    }

    async function loadWeather(d) {
      const card = document.getElementById('weather-card');
      if (d.lat == null) { card.style.display = 'none'; return; }
      card.style.display = '';
      document.getElementById('weather-row').innerHTML = '<span class="skl skl-wday"></span>'.repeat(7);
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

    async function loadHotels(d, mapQuery) {
      const card = document.getElementById('hotels-card');
      const list = document.getElementById('hotels-list');
      if (d.lat == null) { card.style.display = 'none'; return; }
      card.style.display = '';
      list.innerHTML = '<span class="skl skl-row"></span>'.repeat(4);
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
    document.getElementById('ticket-code').textContent = trip.share_code;

    const feedback = document.getElementById('copy-feedback');
    const flash = (msg) => { feedback.textContent = msg; setTimeout(() => { feedback.textContent = ''; }, 2200); };
    document.getElementById('copy-code').addEventListener('click', async () => {
      await navigator.clipboard.writeText(trip.share_code).catch(() => {});
      flash('הקוד הועתק! ✓');
    });
    document.getElementById('copy-link').addEventListener('click', async () => {
      await navigator.clipboard.writeText(location.href).catch(() => {});
      flash('הקישור הועתק! ✓');
    });
  }

  load();
})();
