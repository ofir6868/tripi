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

    // map + ticket
    const mapQuery = `${trip.destination}${trip.country ? ', ' + trip.country : ''}`;
    document.getElementById('trip-map').src = TRIPI.mapsEmbedUrl(mapQuery);
    document.getElementById('map-caption').textContent = `📍 ${mapQuery}`;
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
