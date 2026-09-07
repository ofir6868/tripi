// The trip's own map: numbered pins for one day's stops on OSM tiles (Leaflet,
// vendored — /vendor/leaflet). Replaces the old destination-only Google embed:
// every verified stop already carries lat/lon, so the map can show the route you
// will actually walk, day by day. Stops without coordinates are skipped silently —
// same convention as the travel-leg chain in trip.js.
const TripMap = (() => {
  let map = null;
  let pinLayer = null;
  let tileLayer = null;
  let overlayLayers = [];
  let ctx = null;
  let selectedDay = 1;
  const STYLE_KEY = 'tripmaker_map_style';
  const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const ESRI_OPTS = { maxZoom: 19, attribution: 'Tiles &copy; Esri' };
  const STYLES = {
    satellite: {
      label: 'לוויין',
      url: ESRI_IMAGERY,
      opts: ESRI_OPTS,
    },
    hybrid: {
      label: 'לוויין משולב',
      title: 'לוויין עם שמות מקומות',
      url: ESRI_IMAGERY,
      opts: ESRI_OPTS,
      overlays: [
        {
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          opts: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
        },
        {
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
          opts: { maxZoom: 19, pane: 'overlayPane' },
        },
      ],
    },
    streets: {
      label: 'רחובות',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      opts: {
        maxZoom: 20,
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
      },
    },
  };
  let mapStyle = 'streets';

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

  function readStyle() {
    try {
      const saved = localStorage.getItem(STYLE_KEY);
      if (saved && STYLES[saved]) return saved;
    } catch { /* storage blocked */ }
    return 'streets';
  }

  function applyStyle(name, persist) {
    mapStyle = STYLES[name] ? name : 'streets';
    if (persist) {
      try { localStorage.setItem(STYLE_KEY, mapStyle); } catch { /* ignore */ }
    }
    document.querySelector('.map-card')?.classList.toggle('map-style-sat', mapStyle !== 'streets');
    if (map) {
      const spec = STYLES[mapStyle];
      if (tileLayer) map.removeLayer(tileLayer);
      overlayLayers.forEach((layer) => map.removeLayer(layer));
      overlayLayers = [];
      tileLayer = L.tileLayer(spec.url, spec.opts).addTo(map);
      (spec.overlays || []).forEach((ov) => {
        const layer = L.tileLayer(ov.url, ov.opts).addTo(map);
        overlayLayers.push(layer);
      });
      if (pinLayer) pinLayer.bringToFront();
    }
    renderStyleChips();
  }

  function renderStyleChips() {
    const row = document.getElementById('map-styles');
    if (!row) return;
    row.hidden = false;
    row.dataset.style = mapStyle;
    if (!row.childElementCount) {
      row.innerHTML = Object.entries(STYLES).map(([id, spec]) =>
        `<button type="button" class="map-style-btn" data-style="${id}"${spec.title ? ` title="${spec.title}"` : ''}>${spec.label}</button>`
      ).join('');
      row.querySelectorAll('.map-style-btn').forEach((b) => {
        b.onclick = () => applyStyle(b.dataset.style, true);
      });
    }
    row.querySelectorAll('.map-style-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.style === mapStyle);
    });
  }

  function ensureMap() {
    if (map) return map;
    const el = document.getElementById('trip-map');
    map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      // wheel zoom inside a scrolling page hijacks the scroll — pinch/buttons only
      scrollWheelZoom: false,
    });
    applyStyle(mapStyle, false);
    pinLayer = L.layerGroup().addTo(map);
    return map;
  }

  function renderDayChips() {
    const row = document.getElementById('map-days');
    const bar = row && row.closest('.map-toolbar');
    const days = ctx.trip.days;
    if (days <= 1) {
      row.style.display = 'none';
      if (bar) bar.style.display = 'none';
      return;
    }
    row.style.display = '';
    if (bar) bar.style.display = '';
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
    mapStyle = readStyle();
    selectedDay = Math.min(Math.max(c.initialDay || 1, 1), c.trip.days);
    renderStyleChips();
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
