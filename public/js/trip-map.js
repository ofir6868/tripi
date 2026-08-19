// The trip's own map: numbered pins for one day's stops on OSM tiles (Leaflet,
// vendored — /vendor/leaflet). Replaces the old destination-only Google embed:
// every verified stop already carries lat/lon, so the map can show the route you
// will actually walk, day by day. Stops without coordinates are skipped silently —
// same convention as the travel-leg chain in trip.js.
const TripMap = (() => {
  let map = null;
  let pinLayer = null;
  let ctx = null;
  let selectedDay = 1;

  const available = () => typeof L !== 'undefined';

  // a numbered amber dot — pure divIcon, so none of Leaflet's default marker
  // images (which we don't vendor) are ever requested
  const pinIcon = (n) => L.divIcon({
    className: 'map-pin-wrap',
    html: `<span class="map-pin">${n}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  const dayStops = (day) =>
    ctx.items().filter((it) => it.day_number === day && it.lat != null && it.lon != null);

  function ensureMap() {
    if (map) return map;
    const el = document.getElementById('trip-map');
    map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      // wheel zoom inside a scrolling page hijacks the scroll — pinch/buttons only
      scrollWheelZoom: false,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    return map;
  }

  function renderDayChips() {
    const row = document.getElementById('map-days');
    const days = ctx.trip.days;
    if (days <= 1) { row.style.display = 'none'; return; }
    row.style.display = '';
    row.innerHTML = Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const has = dayStops(day).length > 0;
      return `<button type="button" class="day-tab map-day-tab${day === selectedDay ? ' active' : ''}${has ? '' : ' no-pins'}"
        data-day="${day}">יום ${day}</button>`;
    }).join('');
    row.querySelectorAll('.map-day-tab').forEach((b) => {
      b.onclick = () => selectDay(+b.dataset.day);
    });
    // keep the active chip reachable on a 22-day trip's row — scroll the ROW only;
    // scrollIntoView would also scroll the page to the map on every repaint
    const active = row.querySelector('.map-day-tab.active');
    if (active) row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
  }

  let pinsSig = null; // day + pin coords — an unchanged itinerary keeps the user's pan/zoom

  function renderPins() {
    ensureMap();
    const stops = dayStops(selectedDay);
    const sig = selectedDay + '|' + stops.map((it) => `${it.id}:${it.lat},${it.lon}`).join(';');
    if (sig === pinsSig) return;
    pinsSig = sig;
    pinLayer.clearLayers();
    if (!stops.length) {
      // nothing located on this day — fall back to the destination itself
      const d = ctx.currentDest();
      if (d && d.lat != null) map.setView([d.lat, d.lon], 12);
      return;
    }
    const latlngs = stops.map((it) => [it.lat, it.lon]);
    // the walking order, dashed — echoes the loader's route sketch
    if (latlngs.length > 1) {
      pinLayer.addLayer(L.polyline(latlngs, {
        color: '#ffb45f', weight: 3, opacity: .8, dashArray: '6 8',
      }));
    }
    stops.forEach((it, i) => {
      const m = L.marker([it.lat, it.lon], {
        icon: pinIcon(i + 1),
        title: it.title,
        keyboard: false,
      });
      // a pin opens the same stop sheet a card tap opens — one surface per stop
      m.on('click', () => ctx.openStop(it.id));
      pinLayer.addLayer(m);
    });
    if (latlngs.length === 1) map.setView(latlngs[0], 15);
    else map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30], maxZoom: 16 });
  }

  function selectDay(day) {
    selectedDay = Math.min(Math.max(day, 1), ctx.trip.days);
    pinsSig = null; // an explicit day pick re-frames the map even if nothing moved
    renderDayChips();
    renderPins();
  }

  // ---- public API (all no-ops when Leaflet failed to load — trip.js falls back) ----

  function init(c) {
    if (!available()) return false;
    ctx = c;
    selectedDay = Math.min(Math.max(c.initialDay || 1, 1), c.trip.days);
    renderDayChips();
    renderPins();
    // the sidebar may still be laying out on first paint — Leaflet measures once
    setTimeout(() => map && map.invalidateSize(), 60);
    return true;
  }

  // dest-switcher tap on a multi-city trip: jump to that destination's first
  // located day, else just pan the map to the destination
  function showDest(d) {
    if (!map || !ctx) return;
    const day = ctx.items().find((it) => it.area === d.name && it.lat != null)?.day_number;
    if (day) selectDay(day);
    else if (d.lat != null) { pinLayer.clearLayers(); pinsSig = null; renderDayChips(); map.setView([d.lat, d.lon], 12); }
  }

  // called from the renderItinerary funnel: add/edit/delete/drag all repaint pins
  function refresh() {
    if (map && ctx) { renderDayChips(); renderPins(); }
  }

  return { available, init, showDest, refresh, selectDay };
})();
