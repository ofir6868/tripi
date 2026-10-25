// The trip's own map: one day's stops, numbered in walking order, on tiles that cost
// nothing and need no key (Leaflet, vendored — /vendor/leaflet). Every verified stop
// carries lat/lon, so the map shows the route you will actually walk, day by day; a
// stop without coordinates is skipped on the map and greyed in the strip below it —
// the same convention as the travel-leg chain in trip.js.
//
// The widget is laid out the way a map app lays itself out, not the way a card does:
// the tiles fill the canvas edge to edge, and everything else floats on them in glass —
// the day strip along the top, a control stack on the left (fit · my location ·
// style · full screen), the destination at the bottom. Under the canvas, the day's
// stops as a strip of small cards: a card selects its pin, a second tap opens the
// stop; a pin tap opens the stop too (the one stop sheet, TripCalendar.openStop).
//
// Basemaps, and why they are what they are (PLAYBOOK §2 — keyless first, graceful
// fall always): the streets layer used to come from CARTO's public raster endpoint,
// which started answering every tile with a 200 and an "API KEY REQUIRED" image in
// 2026-10 — a map that silently went blank. Each style now names its sources in
// order, and a source whose first tiles all fail is swapped for the next one, with
// a console.warn, so the next outage is at least loud (PLAYBOOK §2 — quiet is a bug).
// A 200 with the wrong picture in it cannot be caught this way; that is why CARTO
// is simply gone.
const TripMap = (() => {
  let map = null;
  let base = null;          // the big map's tile layers — see mountBase
  let pinLayer = null;      // numbered markers (above the route)
  let routeLayer = null;    // the walking-order line
  let youLayer = null;      // the traveller's own position (locate)
  let ctx = null;
  let selectedDay = 1;
  let activeId = null;      // the stop the strip has selected (its pin is lit)
  let fullscreen = false;
  let geoWatch = null;
  let miniMap = null;       // the stop sheet's static map, one at a time
  const STYLE_KEY = 'tripmaker_map_style';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const ESRI_ATTR = 'Tiles &copy; Esri';
  const STYLES = {
    streets: {
      label: 'רחובות',
      sources: [
        { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: OSM_ATTR } },
        { url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, opts: { maxZoom: 19, attribution: ESRI_ATTR } },
      ],
    },
    dark: {
      label: 'כהה',
      title: 'מפה כהה, בצבעי האתר',
      dark: true,
      // Esri's canvas is drawn to zoom 16; Leaflet scales those tiles up to 18 so
      // a day's pins never hit a wall where the other styles still zoom in
      sources: [{ url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, opts: { maxNativeZoom: 16, maxZoom: 18, attribution: ESRI_ATTR } }],
      overlays: [{ url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, opts: { maxNativeZoom: 16, maxZoom: 18, pane: 'overlayPane' } }],
    },
    satellite: {
      label: 'לוויין',
      photo: true,
      sources: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, opts: { maxZoom: 19, attribution: ESRI_ATTR } }],
    },
    hybrid: {
      label: 'לוויין משולב',
      title: 'לוויין עם שמות מקומות וכבישים',
      photo: true,
      sources: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, opts: { maxZoom: 19, attribution: ESRI_ATTR } }],
      overlays: [
        { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, opts: { maxZoom: 19, pane: 'overlayPane' } },
        { url: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, opts: { maxZoom: 19, pane: 'overlayPane' } },
      ],
    },
  };
  const STYLE_ORDER = ['streets', 'dark', 'satellite', 'hybrid'];
  let mapStyle = 'streets';
  // which source each style is currently served from — a fallback that kicked in
  // once holds for the visit, so a style switch does not retry the dead host
  const sourceIdx = {};

  // the little-category emoji: same table as the calendar's tiles, so a stop looks
  // the same in the strip as it does in the list
  const CAT_EMOJI = {
    'אטרקציה': '🎡', 'אוכל': '🍜', 'טבע': '🌿', 'ים': '🏖️', 'תרבות': '🎭',
    'קניות': '🛍️', 'לינה': '🏨', 'נוף': '🌄', 'חיי לילה': '🌙',
  };
  const stopEmoji = (it) => it.category === 'נסיעה'
    ? (typeof TripModals !== 'undefined' ? TripModals.travelIcon(it) : '🧳')
    : (CAT_EMOJI[it.category] || '📍');
  const esc = (s) => (typeof TRIPMAKER !== 'undefined' ? TRIPMAKER.esc(s) : String(s == null ? '' : s));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = () => matchMedia('(pointer: coarse)').matches;
  const fmtMin = (min) => (min < 60 ? `${min} דק׳` : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} שע׳`);
  const kmApart = (a, b) => {
    const rad = Math.PI / 180;
    return Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(b.lat * rad));
  };

  const available = () => typeof L !== 'undefined';
  const $ = (id) => document.getElementById(id);
  const card = () => document.querySelector('.map-card');

  // ---- icons (inline SVG, stroke = currentColor) ----
  const IC = {
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="2.5"/></svg>',
    locate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M6 18 18 6M6 6l12 12"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>',
  };

  // a numbered pin — pure divIcon, so none of Leaflet's default marker images
  // (which we don't vendor) are ever requested. A teardrop in the brand amber with
  // a white ring, so it reads as a pin on pale streets, dark canvas and satellite
  // photo alike; the pulse ring is drawn only on the selected pin (CSS .is-active)
  const pinIcon = (label, extra) => L.divIcon({
    className: 'map-pin-wrap' + (extra ? ' ' + extra : ''),
    html: `<span class="map-pin"><span class="map-pin-ring"></span><span class="map-pin-num">${label}</span></span>`,
    iconSize: [34, 40],
    iconAnchor: [17, 36],
    tooltipAnchor: [0, -34],
  });

  const located = (it) => it.lat != null && it.lon != null;
  const dayItems = (day) => ctx.items().filter((it) => it.day_number === day);
  const dayStops = (day) => dayItems(day).filter(located);

  // ---- basemaps ----

  function readStyle() {
    try {
      const saved = localStorage.getItem(STYLE_KEY);
      if (saved && STYLES[saved]) return saved;
    } catch { /* storage blocked */ }
    return 'streets';
  }

  // Lay a style's tiles on a map. `holder` keeps the layers so they can be taken off
  // again (a style switch) — one per map, since the stop sheet's static map shares
  // this code. The fallback watch: a source whose first tiles all fail (three errors
  // before a single load) is replaced by the style's next source, if it has one.
  function mountBase(m, name, holder) {
    const spec = STYLES[name];
    if (holder.tile) m.removeLayer(holder.tile);
    (holder.overlays || []).forEach((l) => m.removeLayer(l));
    holder.overlays = [];
    const idx = Math.min(sourceIdx[name] || 0, spec.sources.length - 1);
    const src = spec.sources[idx];
    const tile = L.tileLayer(src.url, src.opts);
    let errors = 0;
    let loads = 0;
    tile.on('tileload', () => { loads++; });
    tile.on('tileerror', () => {
      errors++;
      if (loads || errors < 3 || idx + 1 >= spec.sources.length || holder.tile !== tile) return;
      const next = spec.sources[idx + 1];
      console.warn(`trip-map: ${name} tiles from ${new URL(src.url.replace(/\{[^}]+\}/g, 'x')).host} are failing — falling back to ${new URL(next.url.replace(/\{[^}]+\}/g, 'x')).host}`);
      sourceIdx[name] = idx + 1;
      mountBase(m, name, holder);
    });
    tile.addTo(m);
    holder.tile = tile;
    (spec.overlays || []).forEach((ov) => {
      const layer = L.tileLayer(ov.url, ov.opts).addTo(m);
      holder.overlays.push(layer);
    });
  }

  function applyStyle(name, persist) {
    mapStyle = STYLES[name] ? name : 'streets';
    if (persist) {
      try { localStorage.setItem(STYLE_KEY, mapStyle); } catch { /* ignore */ }
    }
    const c = card();
    if (c) {
      c.dataset.style = mapStyle;
      c.classList.toggle('map-photo', !!STYLES[mapStyle].photo);
      c.classList.toggle('map-dark', !!STYLES[mapStyle].dark);
    }
    if (map) {
      mountBase(map, mapStyle, base);
      if (routeLayer) routeLayer.bringToFront();
      if (pinLayer) pinLayer.bringToFront();
    }
    renderLayerPicker();
  }

  // ---- the style picker: a popover of real tile thumbnails of where the map is ----

  // slippy-map tile coordinates for a point, so each thumbnail shows THIS trip's
  // streets in that style rather than a stock swatch of somewhere else
  function tileXY(lat, lon, z) {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1), z };
  }
  const tileUrl = (tpl, t) => tpl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y).replace('{s}', 'a').replace('{r}', '');

  function renderLayerPicker() {
    const pop = $('map-layers');
    if (!pop) return;
    if (!pop.childElementCount) {
      pop.innerHTML = STYLE_ORDER.map((id) => {
        const spec = STYLES[id];
        return `<button type="button" class="map-layer" role="menuitemradio" data-style="${id}"${spec.title ? ` title="${spec.title}"` : ''}>
          <span class="ml-thumb"></span><span class="ml-label">${spec.label}</span></button>`;
      }).join('');
      pop.querySelectorAll('.map-layer').forEach((b) => {
        b.onclick = () => { applyStyle(b.dataset.style, true); closeLayers(); };
      });
    }
    pop.querySelectorAll('.map-layer').forEach((b) => {
      const on = b.dataset.style === mapStyle;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $('map-btn-layers')?.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
  }

  // thumbnails are fetched the first time the picker opens, centred on the map
  function fillThumbs() {
    const pop = $('map-layers');
    if (!pop || pop.dataset.thumbs || !map) return;
    pop.dataset.thumbs = '1';
    const c = map.getCenter();
    const t = tileXY(c.lat, c.lng, 12);
    pop.querySelectorAll('.map-layer').forEach((b) => {
      const spec = STYLES[b.dataset.style];
      const src = spec.sources[Math.min(sourceIdx[b.dataset.style] || 0, spec.sources.length - 1)];
      const imgs = [src, ...(spec.overlays || [])].map((s) => `<img alt="" loading="lazy" decoding="async" src="${tileUrl(s.url, t)}">`);
      b.querySelector('.ml-thumb').innerHTML = imgs.join('');
    });
  }

  function openLayers() {
    const pop = $('map-layers');
    if (!pop) return;
    fillThumbs();
    pop.hidden = false;
    renderLayerPicker();
    pop.querySelector('.map-layer.active')?.focus();
    setTimeout(() => document.addEventListener('pointerdown', onOutside), 0);
  }
  function closeLayers() {
    const pop = $('map-layers');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    renderLayerPicker();
    document.removeEventListener('pointerdown', onOutside);
  }
  function onOutside(e) {
    if (e.target.closest('#map-layers, #map-btn-layers')) return;
    closeLayers();
  }

  // ---- the map itself ----

  function ensureMap() {
    if (map) return map;
    const el = $('trip-map');
    map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      // wheel zoom inside a scrolling page hijacks the scroll — pinch/buttons only,
      // until the map is full screen and the page is not what is under the wheel
      scrollWheelZoom: false,
      zoomSnap: .5,
      wheelPxPerZoomLevel: 120,
    });
    // the attribution sits bottom-left, under the controls, so the bottom-right
    // corner stays free for the destination chip
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    base = { tile: null, overlays: [] };
    applyStyle(mapStyle, false);
    routeLayer = L.featureGroup().addTo(map);
    pinLayer = L.featureGroup().addTo(map);
    youLayer = L.featureGroup().addTo(map);
    map.on('click', closeLayers);
    map.on('dragstart', closeLayers);
    wireControls();
    // the sidebar changes width at the breakpoints and the card changes size in
    // full screen — Leaflet measures itself once, so re-measure whenever we move
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { if (map) map.invalidateSize({ animate: false }); }).observe(el);
    }
    return map;
  }

  function wireControls() {
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('map-btn-in', () => map.zoomIn());
    on('map-btn-out', () => map.zoomOut());
    on('map-btn-fit', () => { pinsSig = null; renderPins(); });
    on('map-btn-locate', toggleLocate);
    on('map-btn-layers', () => ($('map-layers').hidden ? openLayers() : closeLayers()));
    on('map-btn-full', () => setFullscreen(!fullscreen));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('map-layers').hidden) { closeLayers(); return; }
      // the stop sheet above the map takes Esc first (TripCalendar closes it)
      if (fullscreen && !document.querySelector('#stop-modal.open')) setFullscreen(false);
    });
  }

  // a transient line over the map — "no located stops today", a locate error
  let noteTimer = null;
  function say(msg, ms) {
    const el = $('map-note');
    if (!el) return;
    clearTimeout(noteTimer);
    el.textContent = msg || '';
    el.hidden = !msg;
    if (msg && ms) noteTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---- full screen ----

  function setFullscreen(onOff) {
    fullscreen = !!onOff;
    const c = card();
    if (!c) return;
    c.classList.toggle('map-full', fullscreen);
    c.closest('.trip-side')?.classList.toggle('has-map-full', fullscreen);
    document.documentElement.classList.toggle('map-full-open', fullscreen);
    const btn = $('map-btn-full');
    if (btn) {
      btn.innerHTML = fullscreen ? IC.collapse : IC.expand;
      btn.title = fullscreen ? 'סגירת מסך מלא' : 'מסך מלא';
      btn.setAttribute('aria-label', btn.title);
    }
    if (!map) return;
    if (fullscreen) map.scrollWheelZoom.enable(); else map.scrollWheelZoom.disable();
    closeLayers();
    // the canvas has a new size — measure it, then frame the day in it again
    setTimeout(() => { map.invalidateSize({ animate: false }); pinsSig = null; renderPins(); }, 30);
  }

  // ---- my location ----

  function toggleLocate() {
    if (geoWatch != null) { stopLocate(); return; }
    if (!navigator.geolocation) { say('הדפדפן הזה לא יודע איפה אתם', 2600); return; }
    const btn = $('map-btn-locate');
    btn?.classList.add('busy');
    let first = true;
    geoWatch = navigator.geolocation.watchPosition((pos) => {
      btn?.classList.remove('busy');
      btn?.classList.add('on');
      btn?.setAttribute('aria-pressed', 'true');
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      drawYou(lat, lon, accuracy);
      if (!first) return;
      first = false;
      // pan over only when you are actually near the day — a planner checking the
      // trip from home should not watch Rome slide away to show their sofa
      const stops = dayStops(selectedDay);
      const near = !stops.length || stops.some((s) => kmApart({ lat, lon }, s) <= 300);
      if (near) {
        const pts = stops.map((s) => [s.lat, s.lon]).concat([[lat, lon]]);
        map.flyToBounds(L.latLngBounds(pts), { ...framePad(), maxZoom: 16, animate: !reduced(), duration: .8 });
      } else {
        say('אתם רחוקים מתחנות היום — המיקום שלכם מסומן, המפה נשארת על המסלול', 3600);
      }
    }, (err) => {
      stopLocate();
      say(err.code === 1 ? 'אין הרשאה למיקום — אפשר לאשר בהגדרות הדפדפן' : 'המיקום לא זמין כרגע', 3200);
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
  }

  function stopLocate() {
    if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
    youLayer?.clearLayers();
    const btn = $('map-btn-locate');
    btn?.classList.remove('on', 'busy');
    btn?.setAttribute('aria-pressed', 'false');
  }

  function drawYou(lat, lon, accuracy) {
    youLayer.clearLayers();
    if (accuracy && accuracy < 1500) {
      youLayer.addLayer(L.circle([lat, lon], {
        radius: accuracy, color: '#8fd8c4', weight: 1, opacity: .5, fillColor: '#8fd8c4', fillOpacity: .12, interactive: false,
      }));
    }
    youLayer.addLayer(L.marker([lat, lon], {
      icon: L.divIcon({ className: 'map-you-wrap', html: '<span class="map-you"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, keyboard: false, zIndexOffset: 1000,
    }));
  }

  // ---- day strip (over the canvas) ----

  function dayLabel(day) {
    const date = ctx.dayDate ? ctx.dayDate(day) : null;
    return date ? date.toLocaleDateString('he-IL', { weekday: 'short' }).replace(/^יום /, '') : '';
  }

  function renderDayChips() {
    const row = $('map-days');
    if (!row) return;
    const days = ctx.trip.days;
    row.hidden = days <= 1;
    if (days <= 1) return;
    row.innerHTML = Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const n = dayStops(day).length;
      const sub = dayLabel(day);
      return `<button type="button" class="map-day${day === selectedDay ? ' active' : ''}${n ? '' : ' no-pins'}"
        data-day="${day}" aria-pressed="${day === selectedDay}" title="${n ? `${n} תחנות עם מיקום` : 'אין תחנות עם מיקום'}">
        <span class="md-n">יום ${day}</span>${sub ? `<span class="md-sub">${sub}</span>` : ''}</button>`;
    }).join('');
    row.querySelectorAll('.map-day').forEach((b) => {
      b.onclick = () => selectDay(+b.dataset.day);
    });
    // keep the active chip in view on a 22-day trip — scroll the ROW only;
    // scrollIntoView would also scroll the page to the map on every repaint
    const active = row.querySelector('.map-day.active');
    if (active) row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
  }

  // ---- stop strip (under the canvas) ----

  function renderStrip() {
    const strip = $('map-strip');
    if (!strip) return;
    const items = dayItems(selectedDay);
    strip.hidden = !items.length;
    if (!items.length) { strip.innerHTML = ''; return; }
    let n = 0;
    strip.innerHTML = items.map((it, i) => {
      const has = located(it);
      const num = has ? ++n : null;
      const leg = has && i < items.length - 1 && located(items[i + 1])
        ? `<span class="map-leg" data-from="${it.id}" aria-hidden="true"><span class="ml-dot"></span></span>` : '';
      return `<button type="button" class="map-stop${has ? '' : ' unplaced'}${it.id === activeId ? ' active' : ''}" data-id="${it.id}"
          title="${has ? 'לחיצה מסמנת במפה, לחיצה נוספת פותחת את התחנה' : 'לתחנה הזו אין עדיין מיקום'}">
          <span class="ms-num">${num == null ? '·' : num}</span>
          <span class="ms-body">
            <span class="ms-top">${it.time_label ? `<span class="ms-time">${esc(it.time_label)}</span>` : ''}<span class="ms-cat">${stopEmoji(it)}</span></span>
            <span class="ms-title">${esc(it.title)}</span>
          </span>
        </button>${leg}`;
    }).join('');
    strip.querySelectorAll('.map-stop').forEach((b) => {
      b.onclick = () => {
        const id = +b.dataset.id;
        const it = items.find((x) => x.id === id);
        if (!it) return;
        if (!located(it) || activeId === id) { ctx.openStop(id); return; }
        setActive(id, true);
      };
    });
    fillLegs();
  }

  // the road between the strip's cards — from the same OSRM answer the route line
  // and the itinerary's travel rows use (GEO.routeLegs caches by coordinate chain)
  function fillLegs() {
    const strip = $('map-strip');
    const stops = dayStops(selectedDay);
    if (!strip || stops.length < 2 || typeof GEO === 'undefined') return;
    const sig = pinsSig;
    GEO.routeLegs(stops).then((legs) => {
      if (!legs || sig !== pinsSig || !strip.isConnected) return;
      legs.forEach((leg, i) => {
        const el = strip.querySelector(`.map-leg[data-from="${stops[i].id}"]`);
        if (!el || !leg || leg.minutes < 1) return;
        el.innerHTML = `${IC.car}<span>${fmtMin(leg.minutes)}</span>`;
        el.classList.add('known');
        el.title = `${fmtMin(leg.minutes)} נסיעה · ${leg.km} ק״מ`;
      });
    }).catch(() => { /* the arrows stay — the road is a bonus */ });
  }

  function setActive(id, pan) {
    activeId = id;
    const strip = $('map-strip');
    strip?.querySelectorAll('.map-stop').forEach((b) => b.classList.toggle('active', +b.dataset.id === id));
    pinLayer.eachLayer((m) => {
      const el = m.getElement && m.getElement();
      if (!el) return;
      const on = m.options.stopId === id;
      el.classList.toggle('is-active', on);
      if (on) { m.setZIndexOffset(500); if (m.getTooltip()) m.openTooltip(); }
      else { m.setZIndexOffset(0); if (m.getTooltip()) m.closeTooltip(); }
      if (on && pan) {
        const ll = m.getLatLng();
        if (map.getBounds().pad(-.15).contains(ll)) map.panTo(ll, { animate: !reduced() });
        else map.flyTo(ll, Math.max(map.getZoom(), 15), { animate: !reduced(), duration: .6 });
      }
    });
    const active = strip?.querySelector('.map-stop.active');
    if (active && strip) strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
  }

  // ---- pins + route ----

  // room around the day's bounds for what floats on the canvas: the day strip at
  // the top, the control stack on the left, the destination chip bottom-right
  const framePad = () => ({ paddingTopLeft: [58, ctx.trip.days > 1 ? 62 : 24], paddingBottomRight: [24, 52] });

  let pinsSig = null; // day + pin coords — an unchanged itinerary keeps the user's pan/zoom

  function renderPins() {
    ensureMap();
    const stops = dayStops(selectedDay);
    const sig = selectedDay + '|' + stops.map((it) => `${it.id}:${it.lat},${it.lon}`).join(';');
    if (sig === pinsSig) return;
    pinsSig = sig;
    pinLayer.clearLayers();
    routeLayer.clearLayers();
    if (!stops.some((s) => s.id === activeId)) activeId = null;
    if (!stops.length) {
      say(dayItems(selectedDay).length ? `לתחנות של יום ${selectedDay} אין עדיין מיקום במפה` : `יום ${selectedDay} עדיין ריק`);
      // nothing located on this day — fall back to the destination itself
      const d = ctx.currentDest();
      if (d && d.lat != null) map.setView([d.lat, d.lon], 12, { animate: false });
      return;
    }
    say('');
    const latlngs = stops.map((it) => [it.lat, it.lon]);
    drawRoute(latlngs);
    // numbered pins drawn last, in their own group, so they always sit above the route
    stops.forEach((it, i) => {
      const m = L.marker([it.lat, it.lon], {
        icon: pinIcon(i + 1),
        title: '',
        alt: `${i + 1}. ${it.title}`,
        keyboard: true,
        riseOnHover: true,
        stopId: it.id,
      });
      m.bindTooltip(
        `<span class="mt-num">${i + 1}</span>${it.time_label ? `<span class="mt-time">${esc(it.time_label)}</span>` : ''}<span class="mt-title">${stopEmoji(it)} ${esc(it.title)}</span>`,
        { direction: 'top', className: 'map-tip', opacity: 1 }
      );
      // a pin opens the same stop sheet a card tap opens — one surface per stop
      // (Enter on a focused pin arrives here as a click — Leaflet maps it)
      m.on('click', () => { setActive(it.id, false); ctx.openStop(it.id); });
      pinLayer.addLayer(m);
    });
    if (activeId != null) setActive(activeId, false);
    if (latlngs.length === 1) map.setView(latlngs[0], 15, { animate: false });
    else map.fitBounds(L.latLngBounds(latlngs), { ...framePad(), maxZoom: 16, animate: false });
    // the real road, once the router answers (straight lines until then)
    if (latlngs.length > 1 && typeof GEO !== 'undefined') {
      GEO.routeLegs(stops).then((legs) => {
        if (sig !== pinsSig || !legs || !legs.geometry || legs.geometry.length < 2) return;
        drawRoute(legs.geometry);
      }).catch(() => { /* straight lines are an honest answer too */ });
    }
  }

  // the walking order: a soft glow trace under a bright marching-dash line on top —
  // reads over pale streets, dark canvas and a busy satellite photo alike
  function drawRoute(latlngs) {
    routeLayer.clearLayers();
    if (latlngs.length < 2) return;
    routeLayer.addLayer(L.polyline(latlngs, {
      className: 'route-line-glow', color: '#ffb45f', weight: 9, opacity: .32, lineCap: 'round', lineJoin: 'round', interactive: false,
    }));
    routeLayer.addLayer(L.polyline(latlngs, {
      className: 'route-line', color: '#ffc879', weight: 4, opacity: 1,
      dashArray: '1 10', lineCap: 'round', lineJoin: 'round', interactive: false,
    }));
  }

  function selectDay(day) {
    selectedDay = Math.min(Math.max(day, 1), ctx.trip.days);
    pinsSig = null; // an explicit day pick re-frames the map even if nothing moved
    activeId = null;
    renderDayChips();
    renderPins();
    renderStrip();
  }

  // ---- the stop sheet's map: one pin, no controls, the same tiles ----

  function mini(el, it) {
    if (!available() || !el || it.lat == null || it.lon == null) return null;
    if (miniMap) { try { miniMap.remove(); } catch { /* already gone with its sheet */ } miniMap = null; }
    const m = L.map(el, {
      zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tapHold: false,
    });
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(m);
    mountBase(m, mapStyle, { tile: null, overlays: [] });
    L.marker([it.lat, it.lon], { icon: pinIcon(stopEmoji(it), 'map-pin-emoji'), interactive: false, keyboard: false }).addTo(m);
    m.setView([it.lat, it.lon], 15);
    el.classList.add('map-photo-' + (STYLES[mapStyle].photo ? 'on' : 'off'));
    setTimeout(() => m.invalidateSize(), 60); // the sheet is still sliding in
    miniMap = m;
    return m;
  }

  // ---- public API (all no-ops when Leaflet failed to load — trip.js falls back) ----

  function init(c) {
    if (!available()) return false;
    ctx = c;
    mapStyle = readStyle();
    selectedDay = Math.min(Math.max(c.initialDay || 1, 1), c.trip.days);
    card()?.classList.add('map-live');
    ensureMap();
    renderDayChips();
    renderPins();
    renderStrip();
    $('map-btn-full')?.setAttribute('aria-label', 'מסך מלא');
    // the sidebar may still be laying out on first paint — Leaflet measures once
    setTimeout(() => { if (map) { map.invalidateSize(); pinsSig = null; renderPins(); } }, 60);
    return true;
  }

  // stops-picker pick on a multi-city trip: jump to that destination's first
  // located day, else just pan the map to the destination
  function showDest(d) {
    if (!map || !ctx) return;
    const day = ctx.items().find((it) => it.area === d.name && it.lat != null)?.day_number;
    if (day) selectDay(day);
    else if (d.lat != null) {
      pinLayer.clearLayers(); routeLayer.clearLayers(); pinsSig = null;
      renderDayChips(); renderStrip();
      map.setView([d.lat, d.lon], 12);
    }
  }

  // called from the renderItinerary funnel: add/edit/delete/drag all repaint pins
  function refresh() {
    if (map && ctx) { renderDayChips(); renderPins(); renderStrip(); }
  }

  return { available, init, showDest, refresh, selectDay, mini };
})();
