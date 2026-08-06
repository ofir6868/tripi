// Trip page: loads a trip by its 6-digit share code from the URL (/trip/123456).
(() => {
  const code = location.pathname.split('/').pop();

  const heDate = (d) => d ? new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' }) : null;

  async function load() {
    let data;
    try {
      data = await TRIPI.api('/api/trips/code/' + encodeURIComponent(code));
    } catch {
      document.querySelector('.trip-hero').style.display = 'none';
      document.getElementById('not-found').style.display = '';
      return;
    }
    const { trip, items } = data;

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

    // itinerary grouped by day
    const byDay = new Map();
    for (const it of items) {
      if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
      byDay.get(it.day_number).push(it);
    }
    const container = document.getElementById('days-container');
    if (!items.length) {
      container.innerHTML = '<div class="empty-day glass" style="margin-top:20px;border-radius:var(--radius)">המסלול עדיין ריק — בעל הטיול עוד לא הוסיף תחנות</div>';
    } else {
      container.innerHTML = [...byDay.keys()].sort((a, b) => a - b).map((day) => `
        <div class="day-block">
          <div class="day-title"><span class="day-badge">יום ${day}</span></div>
          <div class="timeline">
            ${byDay.get(day).map((it) => `
              <div class="item-card glass">
                <div class="item-top">
                  ${it.time_label ? `<span class="item-time">${TRIPI.esc(it.time_label)}</span>` : ''}
                  <span class="item-title">${TRIPI.esc(it.title)}</span>
                  ${it.category ? `<span class="item-cat">${TRIPI.esc(it.category)}</span>` : ''}
                </div>
                ${it.note ? `<div class="item-note">${TRIPI.esc(it.note)}</div>` : ''}
                ${it.place_query ? `<a class="item-map-link" target="_blank" rel="noopener" href="${TRIPI.mapsSearchUrl(it.place_query)}">📍 פתיחה בגוגל מפות</a>` : ''}
              </div>`).join('')}
          </div>
        </div>`).join('');
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
      try {
        const days = await GEO.forecast(d.lat, d.lon);
        document.getElementById('weather-row').innerHTML = days.map((w) => `
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
      list.innerHTML = '<div class="empty-day" style="padding:10px">מאתרים מלונות…</div>';
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
