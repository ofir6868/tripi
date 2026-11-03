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
//
// The full page (2026-11): the card in the sidebar is a preview; the map people
// actually use is the full page it opens into — its own address (#map, so back
// closes it and a link can land on it), and laid out the way the trip apps that
// travellers already know lay it out (Wanderlog, Google Travel): the itinerary in a
// panel beside the map on a wide screen, every day in its own colour on both, and a
// "כל הימים" view that shows the whole trip at once. A phone keeps the strip and the
// stop sheet — a side panel on a phone is a map you can no longer see. From the full
// page, a trip that has started can also be flown over in 3D and saved as a video
// (trip-flyover.js, loaded only when asked: MapLibre is a megabyte).
const TripMap = (() => {
  let map = null;
  let base = null;          // the big map's tile layers — see mountBase
  let pinLayer = null;      // numbered markers (above the route)
  let routeLayer = null;    // the walking-order line
  let lodgeLayer = null;    // where each day ends: the night's hotel, and the dashed walk to it
  let youLayer = null;      // the traveller's own position (locate)
  let ctx = null;
  let selectedDay = 1;      // 0 = every day at once (the overview)
  let activeId = null;      // the stop the strip has selected (its pin is lit)
  let fullscreen = false;
  let framed = false;       // the map has shown a day once — later re-frames fly, the first one cuts
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
  // one colour per day, the same in the pins, the route, the panel and the flyover —
  // so "day 3 is the blue one" holds everywhere. Picked to read on pale streets, the
  // dark canvas and satellite photo alike; a long trip wraps around.
  const DAY_COLORS = ['#ffb45f', '#6fd3b8', '#7cb8ff', '#ff8fb1', '#c3a6ff', '#ffd75e', '#ff8a6b', '#9be36d'];
  const dayColor = (day) => DAY_COLORS[(Math.max(day, 1) - 1) % DAY_COLORS.length];
  const stopEmoji = (it) => it.category === 'נסיעה'
    ? (typeof TripModals !== 'undefined' ? TripModals.travelIcon(it) : '🧳')
    : (CAT_EMOJI[it.category] || '📍');
  const esc = (s) => (typeof TRIPMAKER !== 'undefined' ? TRIPMAKER.esc(s) : String(s == null ? '' : s));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = () => matchMedia('(pointer: coarse)').matches;
  const narrow = () => matchMedia('(max-width: 640px)').matches;
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
    film: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M6 18 18 6M6 6l12 12"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>',
  };

  // The stop itself on the map, not a number on a teardrop (2026-11: "the dotted line
  // and the pins aren't pretty"): a round bubble with the stop's photo — the same
  // free photo the itinerary card shows (trip-photos.js) — ringed in white and in the
  // day's colour, its number as a badge, a pointer under it, and its name on a chip
  // that comes out when the stop is selected or hovered. A stop with no photo gets
  // its category emoji on the day's colour. The overview draws them a size smaller.
  const photoOf = (it) => (typeof TripPhotos !== 'undefined' ? TripPhotos.get(it.id) : null);
  const photoIcon = (it, n, i, small, still) => {
    const ph = photoOf(it);
    const size = small ? 36 : 48;
    return L.divIcon({
      className: 'map-ph-wrap' + (small ? ' map-ph-small' : '') + (still ? ' still' : ''),
      html: `<span class="map-ph" style="--pin:${dayColor(it.day_number)};animation-delay:${Math.min(i || 0, 24) * 55}ms">
          <span class="mph-ring"></span>
          <span class="mph-img${ph ? ' has-photo' : ''}"><span class="mph-emoji">${stopEmoji(it)}</span>${ph ? `<img alt="" decoding="async" referrerpolicy="no-referrer" src="${esc(ph.url)}" onerror="this.parentNode.classList.remove('has-photo');this.remove()">` : ''}</span>
          <span class="mph-num">${n}</span>
          <span class="mph-label">${it.time_label && !small ? `<b dir="ltr">${esc(it.time_label)}</b>` : ''}${esc(it.title)}</span>
        </span>`,
      iconSize: [size, size + 8],
      iconAnchor: [size / 2, size + 8],
    });
  };

  const located = (it) => it.lat != null && it.lon != null;
  const dayItems = (day) => ctx.items().filter((it) => it.day_number === day);
  const dayStops = (day) => dayItems(day).filter(located);
  // what the map is showing: one day's stops, or (overview) every located stop in
  // trip order. `num` is the stop's number within its own day — the pin's label
  const curStops = () => {
    if (selectedDay) return dayStops(selectedDay);
    return ctx.items().filter(located).slice().sort((a, b) => a.day_number - b.day_number);
  };
  // the trip day today falls on, or 0 when the trip is not happening today
  const todayDay = () => {
    const s = ctx.dayDate && ctx.dayDate(1);
    if (!s) return 0;
    s.setHours(0, 0, 0, 0);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const d = Math.round((t - s) / 86400000) + 1;
    return d >= 1 && d <= ctx.trip.days ? d : 0;
  };
  const numInDay = (it) => dayStops(it.day_number).findIndex((s) => s.id === it.id) + 1;

  // ---- the overnight point ----
  //
  // A hotel is never a stop (it lives on the hotels page, with its nights and its price);
  // the map draws it on its own as the place the day ends — night N is slept after day N.
  // A house-shaped pin, not a photo bubble, so it never reads as one more stop, joined to
  // the day's last stop by a thin dashed walk. A tap opens the hotel's card.
  const nightHotel = (day) => (ctx && ctx.state && typeof TripModals !== 'undefined' && TripModals.nightHotel
    && day >= 1 && day < ctx.trip.days ? TripModals.nightHotel(ctx.state, day) : null);
  const placedHotel = (h) => h && h.lat != null && h.lon != null;
  // what the map shows: the selected day's night, or (overview) every night's stay once
  const curLodging = () => {
    const days = selectedDay ? [selectedDay] : Array.from({ length: ctx.trip.days }, (_, i) => i + 1);
    const out = [];
    for (const d of days) {
      const h = nightHotel(d);
      if (!placedHotel(h)) continue;
      const seen = out.find((x) => x.hotel.id === h.id);
      if (seen) seen.nights.push(d); else out.push({ hotel: h, day: d, nights: [d] });
    }
    return out;
  };
  const LODGE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-5h18v5"/><path d="M3 13V6"/><path d="M7 13v-3h4v3"/></svg>';
  const lodgeIcon = (l, small) => L.divIcon({
    className: 'map-lodge-wrap' + (small ? ' map-lodge-small' : '') + (l.hotel.status === 'idea' ? ' is-idea' : ''),
    html: `<span class="map-lodge" style="--pin:${dayColor(l.day)}">
        <span class="ml-roof"></span>
        <span class="ml-body">${LODGE_SVG}</span>
        <span class="ml-label"><b>${l.nights.length > 1 ? `לילות ${l.nights[0]}–${l.nights[l.nights.length - 1]}` : `לילה ${l.day}`}</b>${esc(l.hotel.name)}</span>
      </span>`,
    iconSize: [small ? 30 : 38, small ? 34 : 44],
    iconAnchor: [small ? 15 : 19, small ? 34 : 44],
  });
  function drawLodging(stops) {
    lodgeLayer.clearLayers();
    const lodging = curLodging();
    for (const l of lodging) {
      const at = [+l.hotel.lat, +l.hotel.lon];
      // the walk home from the last stop of each day it ends
      for (const d of l.nights) {
        const last = stops.filter((s) => s.day_number === d).pop();
        if (last && kmApart({ lat: last.lat, lon: last.lon }, { lat: at[0], lon: at[1] }) < 60) {
          lodgeLayer.addLayer(L.polyline([[last.lat, last.lon], at], {
            className: 'route-home', color: dayColor(d), weight: selectedDay ? 3 : 2, opacity: .9,
            dashArray: '1 8', lineCap: 'round', interactive: false,
          }));
        }
      }
      const m = L.marker(at, {
        icon: lodgeIcon(l, !selectedDay), title: '', keyboard: true, riseOnHover: true, zIndexOffset: -100,
        alt: `לינה, לילה ${l.day}: ${l.hotel.name}`,
      });
      m.on('click', () => openLodging(l.day));
      lodgeLayer.addLayer(m);
    }
    return lodging.map((l) => [+l.hotel.lat, +l.hotel.lon]);
  }
  function openLodging(night) {
    if (!ctx.openHotel) return;
    TRIPMAKER.track?.('overnight_open', { trip_id: ctx.trip.id, night, from: 'map' });
    // the full page steps back out first (a history entry of its own); the hotels page
    // opens once it has, so the two never fight over the same back step
    if (fullscreen && history.state && history.state.tripmakerMap) {
      window.addEventListener('popstate', () => setTimeout(() => ctx.openHotel(night), 0), { once: true });
      closeFull();
      return;
    }
    if (fullscreen) closeFull();
    ctx.openHotel(night);
  }

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
    lodgeLayer = L.featureGroup().addTo(map);
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
    on('map-btn-full', () => (fullscreen ? closeFull() : openFull()));
    on('map-open-pill', () => openFull());
    on('map-btn-fly', () => openFlyover());
    on('map-fly-pill', () => openFlyover());
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('#stop-modal.open')) return; // the sheet above the map has the keys
      if (e.key === 'Escape') {
        if (!$('map-layers').hidden) { closeLayers(); return; }
        if (fullscreen && activeId != null) { clearActive(); return; }
        if (fullscreen) closeFull();
        return;
      }
      // full screen: the arrow keys walk the day (RTL — left is onward)
      if (!fullscreen || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepActive(1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepActive(-1); }
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

  // The card opens out of its place in the sidebar to the whole viewport, and folds
  // back into it: the card takes its full size at once and a clip-path reveals it
  // from the old rectangle outward (a transform would squeeze the map, whose aspect
  // changes). Leaving runs the same reveal backwards, and the classes come off only
  // once it has closed. The map is re-framed when the motion settles.
  // The full page has an address of its own. Opening pushes #map, so the phone's back
  // gesture closes it the way it closes every other page here (trip-pages.js); the
  // close button goes back through history too, so the two never fall out of step.
  // A reload or a shared link on #map lands straight on the full page (init).
  const MAP_HASH = '#map';
  function openFull() {
    if (fullscreen || !map) return;
    if (location.hash === MAP_HASH) history.replaceState(null, '', location.pathname + location.search);
    history.pushState({ tripmakerMap: 1 }, '', MAP_HASH);
    setFullscreen(true);
    TRIPMAKER.track?.('map_full_open', { code: ctx.trip.share_code, days: ctx.trip.days });
  }
  function closeFull() {
    if (!fullscreen) return;
    if (history.state && history.state.tripmakerMap) history.back(); // popstate closes it
    else { setFullscreen(false); if (location.hash === MAP_HASH) history.replaceState(null, '', location.pathname + location.search); }
  }
  window.addEventListener('popstate', () => {
    if (!map) return;
    // a stop sheet opened over the full page pushes an entry at the same URL —
    // stepping out of it leaves us on #map, still full
    if (fullscreen && location.hash !== MAP_HASH) setFullscreen(false);
    else if (!fullscreen && location.hash === MAP_HASH) setFullscreen(true);
  });

  let flip = null;
  function setFullscreen(onOff) {
    const c = card();
    if (!c || !map) return;
    if (flip) { flip.finish(); flip = null; }
    const apply = (on) => {
      c.classList.toggle('map-full', on);
      c.closest('.trip-side')?.classList.toggle('has-map-full', on);
      document.documentElement.classList.toggle('map-full-open', on);
    };
    fullscreen = !!onOff;
    const before = c.getBoundingClientRect();
    apply(fullscreen);
    const after = c.getBoundingClientRect();
    // the small rectangle (inside the viewport-sized one) as a clip inset, in px
    const small = fullscreen ? before : after;
    const big = fullscreen ? after : before;
    const inset = `inset(${small.top - big.top}px ${big.right - small.right}px ${big.bottom - small.bottom}px ${small.left - big.left}px round 22px)`;
    const btn = $('map-btn-full');
    if (btn) {
      btn.innerHTML = fullscreen ? IC.collapse : IC.expand;
      btn.title = fullscreen ? 'סגירת מסך מלא' : 'מסך מלא';
      btn.setAttribute('aria-label', btn.title);
    }
    if (fullscreen) map.scrollWheelZoom.enable(); else map.scrollWheelZoom.disable();
    closeLayers();
    renderPanel();
    renderDetail();
    const settle = () => { map.invalidateSize({ animate: false }); pinsSig = null; renderPins(); };
    if (reduced() || typeof c.animate !== 'function' || !before.width || !after.width) { setTimeout(settle, 30); return; }
    if (fullscreen) {
      flip = c.animate([{ clipPath: inset }, { clipPath: 'inset(0 0 0 0 round 0)' }], { duration: 480, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      flip.onfinish = () => { flip = null; settle(); };
    } else {
      apply(true); // stay open for the fold, then really leave
      flip = c.animate([{ clipPath: 'inset(0 0 0 0 round 0)' }, { clipPath: inset }], { duration: 400, easing: 'cubic-bezier(.4, 0, .2, 1)' });
      flip.onfinish = () => { flip = null; apply(false); settle(); };
    }
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
      const stops = curStops();
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
    const today = todayDay();
    // "כל הימים" first: the whole trip at once, every day in its colour
    const all = `<button type="button" class="map-day map-day-all${selectedDay === 0 ? ' active' : ''}" data-day="0"
        aria-pressed="${selectedDay === 0}" title="כל התחנות של הטיול, כל יום בצבע שלו">
        <span class="md-n">כל הימים</span><span class="md-sub md-dots" aria-hidden="true">${DAY_COLORS.slice(0, Math.min(days, 5)).map((c) => `<i style="background:${c}"></i>`).join('')}</span></button>`;
    row.innerHTML = all + Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const n = dayStops(day).length;
      const sub = day === today ? 'היום' : dayLabel(day);
      return `<button type="button" class="map-day${day === selectedDay ? ' active' : ''}${n ? '' : ' no-pins'}${day === today ? ' is-today' : ''}"
        data-day="${day}" aria-pressed="${day === selectedDay}" style="--day:${dayColor(day)}" title="${n ? `${n} תחנות עם מיקום` : 'אין תחנות עם מיקום'}">
        <span class="md-n"><i class="md-dot" aria-hidden="true"></i>יום ${day}</span>${sub ? `<span class="md-sub">${sub}</span>` : ''}</button>`;
    }).join('');
    row.querySelectorAll('.map-day').forEach((b) => {
      b.onclick = () => selectDay(+b.dataset.day);
    });
    // keep the active chip in view on a 22-day trip — scroll the ROW only;
    // scrollIntoView would also scroll the page to the map on every repaint
    const active = row.querySelector('.map-day.active');
    if (active) row.scrollTo({ left: active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2, behavior: reduced() ? 'auto' : 'smooth' });
  }

  // ---- stop strip (under the canvas) ----

  function renderStrip() {
    const strip = $('map-strip');
    if (!strip) return;
    if (!selectedDay) { renderDayCards(strip); return; }
    const items = dayItems(selectedDay);
    const stay = nightHotel(selectedDay);
    strip.hidden = !items.length && !stay;
    if (!items.length && !stay) { strip.innerHTML = ''; return; }
    let n = 0;
    // the day's last card is where it ends: the night's hotel, never one more stop
    const lodgeCard = stay ? `<button type="button" class="map-stop map-lodge-card enter${stay.status === 'idea' ? ' is-idea' : ''}${placedHotel(stay) ? '' : ' unplaced'}" data-night="${selectedDay}"
          style="animation-delay:${items.length * 40}ms;--day:${dayColor(selectedDay)}" title="לינה — לחיצה פותחת את כרטיס המלון">
          <span class="ms-photo ms-lodge${stay.photo ? ' has-photo' : ''}" aria-hidden="true"><span class="ms-emoji">${LODGE_SVG}</span>${stay.photo ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(stay.photo)}" onerror="this.parentNode.classList.remove('has-photo');this.remove()">` : ''}</span>
          <span class="ms-body">
            <span class="ms-time">לינה · לילה ${selectedDay}</span>
            <span class="ms-title">${esc(stay.name)}</span>
            <span class="ms-cat">${stay.status === 'idea' ? 'רעיון, עוד לא הוזמן' : 'הוזמן'}</span>
          </span>
        </button>` : '';
    strip.innerHTML = items.map((it, i) => {
      const has = located(it);
      const num = has ? ++n : null;
      const leg = has && i < items.length - 1 && located(items[i + 1])
        ? `<span class="map-leg" data-from="${it.id}" aria-hidden="true"></span>` : '';
      const ph = photoOf(it);
      return `<button type="button" class="map-stop enter${has ? '' : ' unplaced'}${it.id === activeId ? ' active' : ''}" data-id="${it.id}"
          style="animation-delay:${i * 40}ms;--day:${dayColor(selectedDay)}" title="${has ? 'לחיצה מסמנת במפה, לחיצה נוספת פותחת את התחנה' : 'לתחנה הזו אין עדיין מיקום'}">
          <span class="ms-photo${ph ? ' has-photo' : ''}" aria-hidden="true"><span class="ms-emoji">${stopEmoji(it)}</span>${ph ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(ph.url)}" onerror="this.parentNode.classList.remove('has-photo');this.remove()">` : ''}<span class="ms-num">${num == null ? '·' : num}</span></span>
          <span class="ms-body">
            ${it.time_label ? `<span class="ms-time">${esc(it.time_label)}</span>` : ''}
            <span class="ms-title">${esc(it.title)}</span>
            ${it.category ? `<span class="ms-cat">${esc(it.category)}</span>` : ''}
          </span>
        </button>${leg}`;
    }).join('') + lodgeCard;
    strip.querySelector('.map-lodge-card')?.addEventListener('click', () => openLodging(selectedDay));
    strip.querySelectorAll('.map-stop:not(.map-lodge-card)').forEach((b) => {
      b.onclick = () => {
        const id = +b.dataset.id;
        const it = items.find((x) => x.id === id);
        if (!it) return;
        if (!located(it) || activeId === id) { ctx.openStop(id); return; }
        setActive(id, true);
      };
    });
    fillLegs();
    wireSwipe(strip);
  }

  // Swiping the cards walks the map (the way map apps pair a carousel with pins): when
  // a swipe settles, the card at the start of the strip is selected and its pin comes
  // into view. Our own scrolls (a pin tap scrolling its card in) are not swipes.
  function wireSwipe(strip) {
    if (strip.dataset.swipe) return;
    strip.dataset.swipe = '1';
    let t = null;
    // only a hand on the strip makes a swipe — a re-render, a snap or our own
    // scrollTo moving it must not pick a stop (and fly the map away from the day)
    let touched = -Infinity;
    const touch = () => { touched = performance.now(); };
    ['pointerdown', 'touchstart', 'wheel'].forEach((ev) => strip.addEventListener(ev, touch, { passive: true }));
    strip.addEventListener('scroll', () => {
      if (performance.now() - touched > 2500) return;
      clearTimeout(t);
      t = setTimeout(() => {
        if (!selectedDay || performance.now() < stripQuietUntil) return;
        const box = strip.getBoundingClientRect();
        let best = null;
        let bestD = Infinity;
        strip.querySelectorAll('.map-stop:not(.unplaced):not(.map-lodge-card)').forEach((c) => {
          const r = c.getBoundingClientRect();
          const d = Math.abs(r.right - (box.right - 12)); // RTL: the start is the right edge
          if (d < bestD) { bestD = d; best = c; }
        });
        if (!best) return;
        const id = +best.dataset.id;
        if (id === activeId) return;
        fromSwipe = true;
        try { setActive(id, true); } finally { fromSwipe = false; }
      }, 160);
    }, { passive: true });
  }

  // the overview's strip: one card per day — its colour, how many stops, the first
  // and last of them. A tap opens that day.
  function renderDayCards(strip) {
    const days = Array.from({ length: ctx.trip.days }, (_, i) => i + 1).filter((d) => dayItems(d).length);
    strip.hidden = !days.length;
    strip.innerHTML = days.map((d, i) => {
      const its = dayItems(d);
      const first = its[0];
      const last = its[its.length - 1];
      const sub = dayLabel(d);
      return `<button type="button" class="map-stop map-daycard enter" data-day="${d}" style="--day:${dayColor(d)};animation-delay:${i * 40}ms">
          <span class="ms-num">${d}</span>
          <span class="ms-body">
            <span class="ms-top"><span class="ms-dayname">יום ${d}${sub ? ` · ${sub}` : ''}</span><span class="ms-count">${its.length} תחנות</span></span>
            <span class="ms-title">${esc(first.title)}${its.length > 1 ? ` ← ${esc(last.title)}` : ''}</span>
          </span>
        </button>`;
    }).join('');
    strip.querySelectorAll('.map-daycard').forEach((b) => { b.onclick = () => selectDay(+b.dataset.day); });
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
        el.innerHTML = `<span>${fmtMin(leg.minutes)}</span>`;
        el.classList.add('known');
        el.title = `${fmtMin(leg.minutes)} נסיעה · ${leg.km} ק״מ`;
      });
    }).catch(() => { /* the arrows stay — the road is a bonus */ });
  }

  function setActive(id, pan) {
    activeId = id;
    const strip = $('map-strip');
    strip?.querySelectorAll('.map-stop').forEach((b) => b.classList.toggle('active', +b.dataset.id === id));
    syncPanelActive(true);
    pinLayer.eachLayer((m) => {
      const el = m.getElement && m.getElement();
      if (!el) return;
      const on = m.options.stopId === id;
      el.classList.toggle('is-active', on);
      m.setZIndexOffset(on ? 500 : 0);
    });
    renderDetail();
    if (pan) {
      // the smallest move that brings the pin into the clear part of the canvas —
      // clear of the day strip, the controls and (full screen) the stop panel
      const m = markerOf(id);
      if (m) {
        const ll = m.getLatLng();
        // centred in the clear part, not the middle of the canvas — on the full
        // page the middle can be under the panel
        const pad = framePad();
        const off = L.point((pad.paddingTopLeft[0] - pad.paddingBottomRight[0]) / 2, (pad.paddingTopLeft[1] - pad.paddingBottomRight[1]) / 2);
        const z = Math.max(map.getZoom(), 15);
        const center = map.unproject(map.project(ll, z).subtract(off), z);
        map.flyTo(center, z, { animate: !reduced(), duration: map.getZoom() < 13 ? .7 : .5 });
      }
    }
    const active = strip?.querySelector('.map-stop.active');
    if (active && strip && !fromSwipe) {
      stripQuietUntil = performance.now() + 700; // our own scroll is not a swipe
      strip.scrollTo({ left: active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2, behavior: reduced() ? 'auto' : 'smooth' });
    }
  }
  let fromSwipe = false;
  let stripQuietUntil = 0;

  function markerOf(id) {
    let found = null;
    pinLayer.eachLayer((m) => { if (m.options.stopId === id) found = m; });
    return found;
  }

  // ---- the stop panel (full screen): the whole stop, beside its pin ----
  //
  // The strip's card says number, hour and name; with the viewport to itself the map
  // can say the rest — the photo, the note, the place, the hours we hold for it, the
  // road from the stop before and to the one after, and the two things to do with a
  // stop: open its sheet, or navigate to it. Walk the day with הקודמת/הבאה or the
  // arrow keys. A side panel on a wide screen, a sheet over the strip on a phone.

  const detailOpen = () => fullscreen && activeId != null && curStops().some((s) => s.id === activeId);

  function renderDetail() {
    const box = $('map-detail');
    const c = card();
    if (!box) return;
    const open = detailOpen();
    c?.classList.toggle('has-detail', open);
    if (!open) { box.hidden = true; box.innerHTML = ''; box.dataset.id = ''; return; }
    // the walk (הקודמת/הבאה) goes through what the map shows — the overview walks the
    // whole trip; the road before and after is always the stop's own day
    const stops = curStops();
    const idx = stops.findIndex((s) => s.id === activeId);
    const it = stops[idx];
    const dstops = dayStops(it.day_number);
    const di = dstops.findIndex((s) => s.id === it.id);
    const prev = dstops[di - 1];
    const next = dstops[di + 1];
    const stepPrev = stops[idx - 1];
    const stepNext = stops[idx + 1];
    const photo = typeof TripPhotos !== 'undefined' ? TripPhotos.get(it.id) : null;
    const hours = typeof TripHours !== 'undefined' ? TripHours.get(it.id) : null;
    let hoursLine = '';
    if (hours) {
      const windows = (hours.windows || []).join(', ');
      const shut = hours.verdict === 'closed';
      const label = shut ? (windows ? `סגור בשעה הזו · פתוח היום ${windows}` : 'סגור ביום הזה') : `פתוח היום ${windows || ''}`.trim();
      hoursLine = `<div class="md-row${shut ? ' shut' : ''}"><span class="md-ic">${shut ? '🚪' : '🕒'}</span><span>${esc(label)}</span></div>`;
    }
    let cost = '';
    if (ctx.canEdit && ctx.state && typeof TripModals !== 'undefined' && TripModals.itemCostInfo) {
      const info = TripModals.itemCostInfo(ctx.state, it);
      if (info) cost = `<span class="md-cost${info.scope === 'personal' ? ' personal' : ''}">${info.scope === 'personal' ? '🔒 ' : ''}${TripModals.fmt(info.amount, TripModals.curOf(ctx.state))}</span>`;
    }
    const nav = (q) => esc(TRIPMAKER.mapsSearchUrl(q, it.google_place_id));
    const changed = box.dataset.id !== String(it.id);
    box.dataset.id = it.id;
    box.innerHTML = `
      <button type="button" class="md-close" aria-label="סגירת פרטי התחנה">${IC.collapse}</button>
      <div class="md-media${photo ? ' has-photo' : ''}" aria-hidden="true">
        <span class="md-emoji">${stopEmoji(it)}</span>
        ${photo ? `<img alt="" decoding="async" referrerpolicy="no-referrer" src="${esc(photo.url)}"${photo.credit ? ` title="📷 ${esc(photo.credit)}"` : ''}>` : ''}
      </div>
      <div class="md-body">
        <div class="md-head">
          <span class="md-num" style="--day:${dayColor(it.day_number)}">${di + 1}</span>
          ${!selectedDay ? `<span class="md-day">יום ${it.day_number}</span>` : ''}
          ${it.time_label ? `<span class="md-time">${esc(it.time_label)}</span>` : ''}
          ${it.category ? `<span class="md-cat">${esc(it.category)}</span>` : ''}
          ${cost}
        </div>
        <h3 class="md-title">${esc(it.title)}</h3>
        ${it.note ? `<p class="md-note">${esc(it.note)}</p>` : ''}
        <div class="md-rows">
          ${it.place_query ? `<div class="md-row"><span class="md-ic">📍</span><span class="md-place" dir="ltr">${esc(it.place_query)}</span></div>` : ''}
          ${hoursLine}
          ${prev ? `<div class="md-row md-leg" data-leg="prev"><span class="md-ic">${IC.car}</span><span><b class="md-min">…</b> מ־${esc(prev.title)}</span></div>` : ''}
          ${next ? `<div class="md-row md-leg" data-leg="next"><span class="md-ic">${IC.car}</span><span><b class="md-min">…</b> אל ${esc(next.title)}</span></div>` : ''}
        </div>
        <div class="md-actions">
          <button type="button" class="btn btn-amber md-open">פרטי התחנה</button>
          <a class="btn btn-ghost md-nav-link" target="_blank" rel="noopener" href="${nav(it.place_query || `${it.lat},${it.lon}`)}">ניווט ›</a>
        </div>
      </div>
      <div class="md-nav">
        <button type="button" class="md-step" data-dir="-1" ${stepPrev ? '' : 'disabled'}>‹ הקודמת</button>
        <span class="md-count">${idx + 1} / ${stops.length}</span>
        <button type="button" class="md-step" data-dir="1" ${stepNext ? '' : 'disabled'}>הבאה ›</button>
      </div>`;
    box.hidden = false;
    box.classList.toggle('swap', changed);
    box.querySelector('.md-close').onclick = () => clearActive();
    box.querySelector('.md-open').onclick = () => ctx.openStop(it.id);
    box.querySelectorAll('.md-step').forEach((b) => { b.onclick = () => stepActive(+b.dataset.dir); });
    const img = box.querySelector('.md-media img');
    if (img) img.onerror = () => img.parentElement.classList.remove('has-photo');
    // the road, from the answer the route line already asked for
    if (dstops.length > 1 && typeof GEO !== 'undefined') {
      const id = it.id;
      GEO.routeLegs(dstops).then((legs) => {
        if (!legs || box.dataset.id !== String(id)) return;
        const fill = (which, leg) => {
          const row = box.querySelector(`.md-leg[data-leg="${which}"]`);
          if (!row) return;
          if (!leg || leg.minutes < 1) { row.remove(); return; }
          row.querySelector('.md-min').textContent = fmtMin(leg.minutes);
          row.title = `${leg.km} ק״מ`;
        };
        fill('prev', legs[di - 1]);
        fill('next', legs[di]);
      }).catch(() => box.querySelectorAll('.md-leg').forEach((r) => r.remove()));
    }
  }

  function clearActive() {
    activeId = null;
    $('map-strip')?.querySelectorAll('.map-stop').forEach((b) => b.classList.remove('active'));
    syncPanelActive(false);
    pinLayer.eachLayer((m) => {
      const el = m.getElement && m.getElement();
      if (el) el.classList.remove('is-active');
      m.setZIndexOffset(0);
    });
    renderDetail();
  }

  function stepActive(dir) {
    const stops = curStops();
    if (!stops.length) return;
    const idx = stops.findIndex((s) => s.id === activeId);
    const to = idx < 0 ? (dir > 0 ? 0 : stops.length - 1) : Math.min(Math.max(idx + dir, 0), stops.length - 1);
    if (to !== idx) setActive(stops[to].id, true);
  }

  // ---- pins + route ----

  // the full page's itinerary panel is on screen (wide screens only — see renderPanel)
  const panelOn = () => fullscreen && !narrow() && !!$('map-panel') && !$('map-panel').hidden;

  // room around the day's bounds for what floats on the canvas: the day strip at
  // the top, the control stack on the left, the destination chip bottom-right — and
  // on the full page, the itinerary panel on the right with the stop panel beside
  // the controls on the left
  // a photo bubble stands ~56px above its point (and half its width each side) —
  // the frame keeps room for the bubble, not just for the point
  const BUBBLE = 50;
  const framePad = () => {
    const detail = detailOpen();
    const panel = panelOn();
    if (panel) {
      return {
        paddingTopLeft: [detail ? 430 : 70, (ctx.trip.days > 1 ? 70 : 24) + BUBBLE],
        paddingBottomRight: [($('map-panel').offsetWidth || 360) + 40, 36],
      };
    }
    return {
      paddingTopLeft: [58 + BUBBLE / 2, (ctx.trip.days > 1 ? 62 : 24) + BUBBLE],
      paddingBottomRight: [(detail && !narrow() ? 410 : 24) + BUBBLE / 2, detail && narrow() ? 260 : 52],
    };
  };

  let pinsSig = null; // day + pin coords — an unchanged itinerary keeps the user's pan/zoom

  function renderPins() {
    ensureMap();
    const stops = curStops();
    const sig = selectedDay + '|' + stops.map((it) => `${it.id}:${it.lat},${it.lon}`).join(';')
      + '|' + curLodging().map((l) => `${l.hotel.id}:${l.hotel.lat},${l.hotel.lon}:${l.hotel.status}:${l.nights.join(',')}`).join(';');
    if (sig === pinsSig) return;
    pinsSig = sig;
    pinLayer.clearLayers();
    routeLayer.clearLayers();
    const lodged = drawLodging(stops);
    if (!stops.some((s) => s.id === activeId)) activeId = null;
    if (!stops.length && lodged.length) {
      // nothing to walk yet, but the night is known: the map opens on the bed
      say('');
      if (framed && !reduced()) map.flyTo(lodged[0], 14, { duration: .8 }); else map.setView(lodged[0], 14, { animate: false });
      framed = true;
      renderDetail();
      return;
    }
    if (!stops.length) {
      say(!selectedDay ? 'לתחנות של הטיול אין עדיין מיקום במפה'
        : dayItems(selectedDay).length ? `לתחנות של יום ${selectedDay} אין עדיין מיקום במפה` : `יום ${selectedDay} עדיין ריק`);
      // nothing located on this day — fall back to the destination itself
      const d = ctx.currentDest();
      if (d && d.lat != null) {
        if (framed && !reduced()) map.flyTo([d.lat, d.lon], 12, { duration: .8 });
        else map.setView([d.lat, d.lon], 12, { animate: false });
      }
      renderDetail();
      return;
    }
    say('');
    const latlngs = stops.map((it) => [it.lat, it.lon]);
    // a route per day, in that day's colour; the overview keeps straight lines (a
    // router call per day of a three-week trip is not worth a glance at the whole)
    const days = [...new Set(stops.map((s) => s.day_number))];
    days.forEach((d) => drawRoute(stops.filter((s) => s.day_number === d).map((s) => [s.lat, s.lon]), dayColor(d), !selectedDay));
    // numbered pins drawn last, in their own group, so they always sit above the route
    stops.forEach((it, i) => {
      const n = selectedDay ? i + 1 : numInDay(it);
      const m = L.marker([it.lat, it.lon], {
        icon: photoIcon(it, n, i, !selectedDay),
        title: '',
        alt: `${selectedDay ? '' : `יום ${it.day_number}, `}${n}. ${it.title}`,
        keyboard: true,
        riseOnHover: true,
        stopId: it.id,
        stopN: n,
      });
      // a pin opens the same stop sheet a card tap opens — one surface per stop
      // (Enter on a focused pin arrives here as a click — Leaflet maps it). On the
      // full page the stop panel is that surface, so a pin selects instead.
      m.on('click', () => {
        if (fullscreen) { setActive(it.id, false); return; }
        setActive(it.id, false); ctx.openStop(it.id);
      });
      m.on('mouseover', () => hoverPanel(it.id, true));
      m.on('mouseout', () => hoverPanel(it.id, false));
      pinLayer.addLayer(m);
    });
    if (activeId != null) setActive(activeId, false); else renderDetail();
    // the first frame cuts straight to the day; every later one flies there — and a
    // day's frame holds the bed it ends in, unless that is a whole other city
    const near = lodged.filter((p) => latlngs.some((q) => kmApart({ lat: p[0], lon: p[1] }, { lat: q[0], lon: q[1] }) < 30));
    const fly = framed && !reduced();
    const frame = [...latlngs, ...near];
    if (frame.length === 1) {
      if (fly) map.flyTo(frame[0], 15, { duration: .8 }); else map.setView(frame[0], 15, { animate: false });
    } else if (fly) {
      map.flyToBounds(L.latLngBounds(frame), { ...framePad(), maxZoom: 16, duration: .8 });
    } else {
      map.fitBounds(L.latLngBounds(frame), { ...framePad(), maxZoom: 16, animate: false });
    }
    framed = true;
    // the real road, once the router answers (straight lines until then). It takes
    // the straight line's place without drawing itself in a second time.
    if (selectedDay && latlngs.length > 1 && typeof GEO !== 'undefined') {
      const t0 = performance.now();
      GEO.routeLegs(stops).then((legs) => {
        if (sig !== pinsSig || !legs || !legs.geometry || legs.geometry.length < 2) return;
        routeLayer.clearLayers();
        // a router that answered at once (cached) draws the road in; a late one
        // replaces a line that was already drawn, quietly
        drawRoute(legs.geometry, dayColor(selectedDay), false, performance.now() - t0 > 900);
      }).catch(() => { /* straight lines are an honest answer too */ });
    }
    loadPhotos();
  }

  // The photos arrive after the pins (one request per trip, cached — trip-photos.js);
  // when they land, every bubble and card that has one is repainted in place — no
  // re-framing, no second drop-in.
  let photosAsked = false;
  function loadPhotos() {
    if (photosAsked || typeof TripPhotos === 'undefined' || !ctx.trip.share_code) return;
    photosAsked = true;
    TripPhotos.load(ctx.trip.share_code).then((data) => {
      if (!data || !data.stops || !map) return;
      pinLayer.eachLayer((m) => {
        const it = ctx.items().find((x) => x.id === m.options.stopId);
        if (!it || !photoOf(it)) return;
        const on = m.options.stopId === activeId;
        m.setIcon(photoIcon(it, m.options.stopN, 0, !selectedDay, true));
        if (on) m.getElement()?.classList.add('is-active');
      });
      renderStrip();
      if (fullscreen) renderPanel();
    }).catch(() => { /* the emoji bubbles are the map without photos */ });
  }

  // The walking order as a road, not a row of dots: a dark casing so it holds on
  // pale streets and satellite photo alike, the line in the day's colour, and over
  // it a soft light that runs along it in walking order — the direction without
  // arrows. A day the map has just been switched to draws its line in, from the
  // first stop to the last. Adds to the route layer (the overview draws one per
  // day, without the running light); callers clear it first.
  function drawRoute(latlngs, color, thin, settled) {
    if (latlngs.length < 2) return;
    const c = color || '#ffb45f';
    const casing = L.polyline(latlngs, {
      className: 'route-casing', color: '#06100d', weight: thin ? 7 : 10, opacity: .45, lineCap: 'round', lineJoin: 'round', interactive: false,
    });
    const line = L.polyline(latlngs, {
      className: 'route-line', color: c, weight: thin ? 3.5 : 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false,
    });
    routeLayer.addLayer(casing);
    routeLayer.addLayer(line);
    if (!thin) {
      routeLayer.addLayer(L.polyline(latlngs, {
        className: 'route-flow', color: '#fff', weight: 3, opacity: .75, dashArray: '2 28', lineCap: 'round', lineJoin: 'round', interactive: false,
      }));
    }
    if (settled || reduced()) return;
    // draw in: each path's dash is its own length, run from hidden to whole
    [casing, line].forEach((pl) => {
      const el = pl.getElement && pl.getElement();
      if (!el || !el.getTotalLength) return;
      const len = Math.ceil(el.getTotalLength());
      el.style.strokeDasharray = `${len} ${len}`;
      el.style.strokeDashoffset = String(len);
      el.getBoundingClientRect(); // commit the start before the transition
      el.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4, 0, .2, 1)';
      el.style.strokeDashoffset = '0';
      // a zoom redraws the path at a new length — the dash must not cut it short
      setTimeout(() => { el.style.transition = ''; el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; }, 1200);
    });
  }

  function selectDay(day) {
    selectedDay = Math.min(Math.max(day, 0), ctx.trip.days);
    pinsSig = null; // an explicit day pick re-frames the map even if nothing moved
    activeId = null;
    renderDetail();
    renderDayChips();
    renderPins();
    renderStrip();
    renderPanel();
  }

  // ---- the full page's itinerary panel (wide screens) ----
  //
  // The itinerary beside the map, the way the trip apps people already use it lay it
  // out: every day as a section in its colour, the day the map shows open, its stops
  // as rows (number, hour, photo, name) with the road between them. A row selects
  // its pin and opens the stop panel; hovering a row lights the pin, and hovering a
  // pin lights the row. A day's header switches the map to that day; "כל הימים"
  // opens them all. The flyover lives in the panel's head.

  function flyoverEligible() {
    if (!ctx.trip.start_date) return false;
    const start = new Date(ctx.trip.start_date); start.setHours(0, 0, 0, 0);
    if (Date.now() < start.getTime()) return false; // the trip has not started yet
    return ctx.items().filter(located).length >= 2;
  }

  function renderPanel() {
    const box = $('map-panel');
    const c = card();
    if (!box) return;
    const on = fullscreen && !narrow();
    box.hidden = !on;
    c?.classList.toggle('has-panel', on);
    syncFlyButton();
    if (!on) { box.innerHTML = ''; return; }
    const keepScroll = box.querySelector('.mp-days')?.scrollTop || 0;
    const days = ctx.trip.days;
    const today = todayDay();
    const d1 = ctx.dayDate ? ctx.dayDate(1) : null;
    const dN = ctx.dayDate ? ctx.dayDate(days) : null;
    const fmt = (d) => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
    const dest = ctx.currentDest && ctx.currentDest();
    const located_n = ctx.items().filter(located).length;
    const photo = (it) => (typeof TripPhotos !== 'undefined' ? TripPhotos.get(it.id) : null);
    const sections = Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const its = dayItems(day);
      const open = !selectedDay || selectedDay === day;
      const date = ctx.dayDate ? ctx.dayDate(day) : null;
      let n = 0;
      const rows = open ? its.map((it, j) => {
        const has = located(it);
        const num = has ? ++n : null;
        const ph = photo(it);
        const leg = has && j < its.length - 1 && located(its[j + 1])
          ? `<div class="mp-leg" data-from="${it.id}" aria-hidden="true"></div>` : '';
        return `<button type="button" class="mp-stop${has ? '' : ' unplaced'}${it.id === activeId ? ' active' : ''}" data-id="${it.id}" data-day="${day}">
            <span class="mp-num">${num == null ? '·' : num}</span>
            <span class="mp-body">
              <span class="mp-title">${esc(it.title)}</span>
              <span class="mp-meta">${it.time_label ? `<b dir="ltr">${esc(it.time_label)}</b>` : ''}${it.category ? `<span>${stopEmoji(it)} ${esc(it.category)}</span>` : ''}${has ? '' : '<span>אין מיקום</span>'}</span>
            </span>
            <span class="mp-thumb${ph ? ' has-photo' : ''}" aria-hidden="true">${stopEmoji(it)}${ph ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(ph.url)}">` : ''}</span>
          </button>${leg}`;
      }).join('') : '';
      const stay = open ? nightHotel(day) : null;
      const lodgeRow = stay ? `<button type="button" class="mp-stop mp-lodge${stay.status === 'idea' ? ' is-idea' : ''}" data-night="${day}" title="לחיצה פותחת את כרטיס המלון">
            <span class="mp-num mp-bed">${LODGE_SVG}</span>
            <span class="mp-body">
              <span class="mp-title">${esc(stay.name)}</span>
              <span class="mp-meta"><span>לינה · לילה ${day}</span>${stay.status === 'idea' ? '<span>רעיון</span>' : ''}${placedHotel(stay) ? '' : '<span>אין מיקום</span>'}</span>
            </span>
          </button>` : '';
      return `<section class="mp-day${open ? ' open' : ''}${day === today ? ' is-today' : ''}" style="--day:${dayColor(day)}">
          <button type="button" class="mp-dayhead" data-day="${day}" aria-expanded="${open}">
            <span class="mp-daydot" aria-hidden="true"></span>
            <span class="mp-dayname">יום ${day}${date ? `<small>${date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' })}</small>` : ''}</span>
            ${day === today ? '<span class="mp-today">היום</span>' : ''}
            <span class="mp-daycount">${its.length ? `${its.length} תחנות` : 'ריק'}</span>
          </button>
          ${open ? `<div class="mp-stops">${rows || '<p class="mp-empty">אין עדיין תחנות ביום הזה</p>'}${lodgeRow}</div>` : ''}
        </section>`;
    }).join('');
    box.innerHTML = `
      <div class="mp-head">
        <div class="mp-titles">
          <h2 class="mp-title">${esc(ctx.trip.emoji || '🗺️')} ${esc(ctx.trip.title || 'מפת הטיול')}</h2>
          <p class="mp-sub">${[dest && dest.name ? esc(dest.name) : '', d1 && dN ? `${fmt(d1)} – ${fmt(dN)}` : `${days} ימים`, `${located_n} תחנות במפה`].filter(Boolean).join(' · ')}</p>
        </div>
        ${flyoverEligible() ? `<button type="button" class="mp-fly" id="mp-fly">${IC.film}<span><b>סרטון טיסה מעל הטיול</b><small>תלת־ממד, מתחנה לתחנה — להורדה ולשיתוף</small></span></button>` : ''}
      </div>
      <div class="mp-days">${sections}</div>`;
    const list = box.querySelector('.mp-days');
    list.scrollTop = keepScroll;
    box.querySelector('#mp-fly')?.addEventListener('click', openFlyover);
    box.querySelectorAll('.mp-dayhead').forEach((b) => {
      b.onclick = () => {
        const d = +b.dataset.day;
        selectDay(selectedDay === d && days > 1 ? 0 : d);
      };
    });
    box.querySelectorAll('.mp-lodge').forEach((b) => { b.onclick = () => openLodging(+b.dataset.night); });
    box.querySelectorAll('.mp-stop:not(.mp-lodge)').forEach((b) => {
      const id = +b.dataset.id;
      b.onclick = () => {
        const it = ctx.items().find((x) => x.id === id);
        if (!it) return;
        if (!located(it)) { ctx.openStop(id); return; }
        if (activeId === id) { ctx.openStop(id); return; }
        setActive(id, true);
      };
      b.onmouseenter = () => hoverPin(id, true);
      b.onmouseleave = () => hoverPin(id, false);
    });
    box.querySelectorAll('.mp-thumb img').forEach((img) => { img.onerror = () => { img.parentElement.classList.remove('has-photo'); img.remove(); }; });
    fillPanelLegs(box);
  }

  // the road between the panel's rows, from the answer the route line already asked for
  function fillPanelLegs(box) {
    if (typeof GEO === 'undefined') return;
    const days = selectedDay ? [selectedDay] : Array.from({ length: ctx.trip.days }, (_, i) => i + 1);
    days.forEach((d) => {
      const stops = dayStops(d);
      if (stops.length < 2) return;
      GEO.routeLegs(stops).then((legs) => {
        if (!legs || !box.isConnected) return;
        legs.forEach((leg, i) => {
          const el = box.querySelector(`.mp-leg[data-from="${stops[i].id}"]`);
          if (!el || !leg || leg.minutes < 1) return;
          el.innerHTML = `${IC.car}<span>${fmtMin(leg.minutes)} · ${leg.km} ק״מ</span>`;
          el.classList.add('known');
        });
      }).catch(() => { /* the dotted line stays — the road is a bonus */ });
    });
  }

  function syncPanelActive(scroll) {
    const box = $('map-panel');
    if (!box || box.hidden) return;
    let hit = null;
    box.querySelectorAll('.mp-stop').forEach((b) => {
      const on = +b.dataset.id === activeId;
      b.classList.toggle('active', on);
      if (on) hit = b;
    });
    if (scroll && hit) {
      const list = box.querySelector('.mp-days');
      const top = hit.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - hit.offsetHeight) {
        list.scrollTo({ top: top - list.clientHeight / 3, behavior: reduced() ? 'auto' : 'smooth' });
      }
    }
  }
  function hoverPin(id, on) {
    const m = markerOf(id);
    const el = m && m.getElement && m.getElement();
    if (!el) return;
    el.classList.toggle('is-hover', on);
    if (on) m.setZIndexOffset(400); else if (id !== activeId) m.setZIndexOffset(0);
  }
  function hoverPanel(id, on) {
    $('map-panel')?.querySelector(`.mp-stop[data-id="${id}"]`)?.classList.toggle('hover', on);
  }

  // ---- the flyover (trip-flyover.js + MapLibre, fetched the first time it is asked for) ----

  function syncFlyButton() {
    const b = $('map-btn-fly');
    if (b) b.hidden = !(fullscreen && narrow() && flyoverEligible());
    const pill = $('map-fly-pill');
    if (pill) pill.hidden = !flyoverEligible();
  }

  let flyLoading = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src; el.async = true;
      el.onload = res; el.onerror = () => rej(new Error(src));
      document.head.appendChild(el);
    });
  }
  function loadCss(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  function openFlyover() {
    if (!flyLoading) {
      say('טוענים את המפה התלת־ממדית…');
      loadCss('/vendor/maplibre/maplibre-gl.css');
      flyLoading = (typeof maplibregl !== 'undefined' ? Promise.resolve() : loadScript('/vendor/maplibre/maplibre-gl.js'))
        .then(() => (typeof TripFlyover !== 'undefined' ? null : loadScript('/js/trip-flyover.js')))
        .finally(() => say(''));
      flyLoading.catch(() => { flyLoading = null; say('לא הצלחנו לטעון את המפה התלת־ממדית — בדקו את החיבור ונסו שוב', 4000); });
    }
    flyLoading.then(() => {
      TripFlyover.open({
        trip: ctx.trip,
        items: () => ctx.items(),
        dayDate: ctx.dayDate,
        dayColor,
        stopEmoji,
        selectedDay,
      });
    }).catch(() => {});
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
    L.marker([it.lat, it.lon], { icon: photoIcon(it, ctx ? numInDay(it) || '' : '', 0, false, true), interactive: false, keyboard: false }).addTo(m);
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
    syncFlyButton();
    $('map-btn-full')?.setAttribute('aria-label', 'מסך מלא');
    // the toolbar's "מפה" (and its row in "עוד" on a phone) — offered once there is a map
    const openBtn = $('map-open-btn');
    if (openBtn) { openBtn.style.display = ''; openBtn.onclick = openFull; }
    // crossing the phone breakpoint on the full page swaps panel ⇄ strip
    matchMedia('(max-width: 640px)').addEventListener?.('change', () => {
      if (!fullscreen) return;
      renderPanel(); renderDetail(); pinsSig = null; renderPins();
    });
    // the sidebar may still be laying out on first paint — Leaflet measures once
    setTimeout(() => {
      if (!map) return;
      map.invalidateSize(); pinsSig = null; renderPins();
      // a link (or a reload) on #map lands on the full page
      if (location.hash === MAP_HASH && !fullscreen) openFull();
    }, 60);
    return true;
  }

  // stops-picker pick on a multi-city trip: jump to that destination's first
  // located day, else just pan the map to the destination
  function showDest(d) {
    if (!map || !ctx) return;
    const day = ctx.items().find((it) => it.area === d.name && it.lat != null)?.day_number;
    if (day) selectDay(day);
    else if (d.lat != null) {
      pinLayer.clearLayers(); routeLayer.clearLayers(); lodgeLayer.clearLayers(); pinsSig = null;
      renderDayChips(); renderStrip();
      map.setView([d.lat, d.lon], 12);
    }
  }

  // called from the renderItinerary funnel: add/edit/delete/drag all repaint pins
  function refresh() {
    if (map && ctx) { renderDayChips(); renderPins(); renderStrip(); if (fullscreen) renderPanel(); else syncFlyButton(); }
  }

  return { available, init, showDest, refresh, selectDay, mini, openFull, dayColor };
})();
