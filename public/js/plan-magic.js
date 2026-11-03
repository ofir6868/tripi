// The trip-creation wizard, told as a journey — the new creation flow, an admin-only
// preview for now (switched on per browser from the pill at the foot of /plan).
//
// It is a SKIN, not a second wizard. plan.js still owns every answer, the draft, the
// guest identity and the POST that creates the trip; this file only listens to the
// state it announces ('plan:state', see snapshot() there) and draws three things
// around the same three panels:
//
//   · a globe behind everything — MapLibre's globe projection, the library the flyover
//     already vendors (loaded only here, only when this is on). Each destination the
//     traveller picks is flown to, pinned, and joined to the trip's route by an arc
//     from home; step 3 circles the last stop over real relief, and the take-off dives
//     into the first one.
//   · a live preview of the trip being made — cover photo, route, a day-by-day strip
//     and the trip's vibe, each section filling in as its question is answered.
//   · the take-off — a boarding pass printed while the trip is created, so the wait
//     for the server reads as the start of the trip instead of as a spinner.
//
// Same rules as the flyover (PLAYBOOK §2): keyless sources only — the globe's base is
// the Terrarium elevation tiles AWS hosts as open data, coloured by height and depth,
// so the globe is whole even when the Esri imagery laid over it never arrives (and that
// is said in the console, not swallowed). No WebGL at all degrades to a still photo
// sky: the flow loses the globe, never the wizard. Photos are the destination guides'
// own (js/dest-photos.js), under the Unsplash licence.
const PlanMagic = (() => {
  const KEY = 'tripmaker_magic_create';
  const esc = (s) => TRIPMAKER.esc(s);
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE = window.matchMedia('(pointer: fine)').matches;
  const wide = () => window.matchMedia('(min-width: 1000px)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // where nearly every trip made here leaves from — the arc's first leg
  const HOME = { name: 'תל אביב', lat: 32.01, lon: 34.88 };
  // the per-area palette the recommendations already wear (trip-recs.js AREA_COLORS)
  const COLORS = ['#ffb45f', '#8fd8c4', '#c9a7ff', '#7fb8ff', '#ff9db1', '#ffd166'];
  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

  const isAdmin = () => !!(TRIPMAKER.user && TRIPMAKER.user.is_admin);
  const wanted = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

  let active = false;
  let st = null;    // the wizard's latest snapshot
  let prev = null;  // the one before it — what changed decides what animates
  const emojiOf = {}; // interest label → its emoji, read off the wizard's own chips

  const parseIso = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d); };
  const located = (s) => (s ? s.destinations.filter((d) => d.lat != null && d.lon != null) : []);
  const photoFor = (d, w) => {
    const hit = DEST_PHOTOS.find(d);
    return DEST_PHOTOS.img(hit ? hit.id : DEST_PHOTOS.generic[0], w);
  };

  // ================================================================ sparkle bursts

  // a handful of particles thrown from a point — emoji when given, else light motes.
  // Pure WAAPI on fixed spans: nothing to clean up but the spans themselves.
  function burst(x, y, { emoji = null, n = 14, spread = 90 } = {}) {
    if (REDUCED) return;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = emoji ? 'mg-spark mg-spark-emoji' : 'mg-spark';
      if (emoji) s.textContent = Array.isArray(emoji) ? emoji[i % emoji.length] : emoji;
      s.style.left = `${x}px`;
      s.style.top = `${y}px`;
      if (!emoji) s.style.setProperty('--c', COLORS[i % 3 === 0 ? 1 : 0]);
      document.body.appendChild(s);
      const a = Math.random() * Math.PI * 2;
      const r = spread * (0.45 + Math.random() * 0.75);
      const dx = Math.cos(a) * r;
      const dy = Math.sin(a) * r - (emoji ? 40 : 20);
      const rot = (Math.random() - 0.5) * 120;
      s.animate([
        { transform: 'translate(-50%, -50%) scale(.3)', opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55}px)) scale(1.1) rotate(${rot / 2}deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 30}px)) scale(.6) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => s.remove();
    }
  }
  const burstFrom = (el, o) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, o);
  };

  // ================================================================ the globe

  const Globe = (() => {
    const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
    let map = null;
    let el = null;
    let ready = false;
    let failed = false;
    let mode = 'spin';       // spin | frame | orbit | dive
    let raf = 0;
    let routeT = 1;          // how much of the route is drawn, 0..1
    let route = [];          // [[lon, lat], …] home → stops
    let routeKey = '';
    let cruise = 0;          // where the little plane is along the drawn route
    let lastFrame = 0;
    let satSeen = false;
    let satErrors = 0;
    const pins = new Map();  // key → maplibregl.Marker

    function loadScript(src) {
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
        document.head.appendChild(s);
      });
    }
    function loadCss(href) {
      if (document.querySelector(`link[href="${href}"]`)) return;
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      document.head.appendChild(l);
    }

    function style() {
      return {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          // two copies of the same tiles: MapLibre wants relief and terrain on separate sources
          dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 12, encoding: 'terrarium' },
          demt: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 12, encoding: 'terrarium' },
          sat: { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 18 },
          route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          plane: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': '#0a2a3a' } },
          // the base that never needs a key: height and depth as colour, the product's
          // own palette — deep teal seas, green lowlands, sand, paper-white peaks
          { id: 'relief', type: 'color-relief', source: 'dem', paint: {
            'color-relief-color': ['interpolate', ['linear'], ['elevation'],
              -7000, '#061a26', -3000, '#0a2c3e', -200, '#114a62', -1, '#1d6a7c',
              0, '#2d6b55', 200, '#3f7c57', 700, '#7d8a55', 1500, '#a8906a', 2600, '#c8b394', 4200, '#f5efe3'],
          } },
          { id: 'shade', type: 'hillshade', source: 'dem', paint: {
            'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#03121a', 'hillshade-highlight-color': '#fff3da', 'hillshade-accent-color': '#0a1512',
          } },
          // the imagery fades in over the relief on its first tile, and never hides it before
          { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 1400, delay: 0 }, 'raster-saturation': 0.1 } },
          { id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ffb45f', 'line-width': 12, 'line-opacity': 0.28, 'line-blur': 7 } },
          { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ffcf8f', 'line-width': 2.6, 'line-dasharray': [2, 1.6] } },
          { id: 'plane-halo', type: 'circle', source: 'plane', paint: { 'circle-radius': 11, 'circle-color': '#ffb45f', 'circle-opacity': 0.25, 'circle-blur': 0.8 } },
          { id: 'plane', type: 'circle', source: 'plane', paint: { 'circle-radius': 3.6, 'circle-color': '#fffaf0', 'circle-stroke-color': '#ffb45f', 'circle-stroke-width': 2 } },
        ],
        sky: {
          'sky-color': '#0a1512', 'horizon-color': '#1f4b52', 'fog-color': '#0d2229',
          'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.35,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
        },
      };
    }

    // the map sits behind the panels, so the camera frames what is left visible
    function padding() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (wide()) {
        const panel = Math.min(560, w * 0.4);
        const card = Math.min(400, w * 0.28);
        return { top: 110, bottom: 70, right: panel + 40, left: card + 50 };
      }
      return { top: 90, bottom: Math.round(h * 0.6), left: 24, right: 24 };
    }
    const baseZoom = () => (wide() ? 1.45 : 1.05);

    async function init(container) {
      el = container;
      try {
        loadCss('/vendor/maplibre/maplibre-gl.css');
        if (typeof maplibregl === 'undefined') await loadScript('/vendor/maplibre/maplibre-gl.js');
        map = new maplibregl.Map({
          container: el,
          style: style(),
          center: [HOME.lon - 8, HOME.lat - 4],
          zoom: baseZoom(),
          interactive: false,
          attributionControl: false,
          fadeDuration: 0,
          maxPitch: 72,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        });
      } catch (e) {
        console.warn('plan-magic: no globe here (' + e.message + ') — the photo sky stands in');
        return flat();
      }
      map.setPadding(padding());
      map.on('sourcedata', (e) => {
        if (e.sourceId === 'sat' && e.tile && !satSeen) {
          satSeen = true;
          map.setPaintProperty('sat', 'raster-opacity', 0.94);
        }
      });
      map.on('error', (e) => {
        if (e && e.sourceId === 'sat' && !satSeen && ++satErrors === 4) {
          console.warn('plan-magic: Esri imagery is not answering — the globe stays on its relief base');
        }
      });
      // the camera can move as soon as the style is in; the globe is shown once its first
      // tiles are drawn ('load' waits for every tile, the imagery that may never come too)
      map.once('style.load', () => { ready = true; apply(); });
      const reveal = () => el.classList.add('is-ready');
      map.once('idle', reveal);
      map.once('load', reveal);
      setTimeout(() => { if (ready) reveal(); }, 5000);
      // a globe whose style never loads (a GPU that says yes and draws nothing) is a
      // black hole behind the wizard — give it a while, then fall back
      setTimeout(() => { if (!ready) { console.warn('plan-magic: globe did not load in time'); flat(); } }, 15000);
      window.addEventListener('resize', () => { if (map) { map.setPadding(padding()); apply(true); } });
      raf = requestAnimationFrame(frame);
    }

    function flat() {
      failed = true;
      if (map) { try { map.remove(); } catch { /* already gone */ } map = null; }
      cancelAnimationFrame(raf);
      document.querySelector('.mg-stage')?.classList.add('is-flat');
    }

    // ---- the route: home → each stop, as great circles
    function gc(a, b, n = 64) {
      const r = Math.PI / 180;
      const [lo1, la1, lo2, la2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
      const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
      if (d < 1e-6) return [a, b];
      const out = [];
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
        const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
        const z = A * Math.sin(la1) + B * Math.sin(la2);
        out.push([Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
      }
      return out;
    }
    function buildRoute(stops) {
      const pts = [[HOME.lon, HOME.lat], ...stops.map((d) => [d.lon, d.lat])];
      const line = [];
      for (let i = 1; i < pts.length; i++) {
        const seg = gc(pts[i - 1], pts[i]);
        line.push(...(i === 1 ? seg : seg.slice(1)));
      }
      return line;
    }
    function cut(line, t) {
      if (line.length < 2) return line;
      const n = Math.max(2, Math.round((line.length - 1) * t) + 1);
      return line.slice(0, n);
    }
    function drawRoute() {
      if (!ready) return;
      const shown = cut(route, routeT);
      map.getSource('route').setData({ type: 'FeatureCollection', features: shown.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: shown } }] : [] });
      let head = null;
      if (route.length > 1) {
        if (routeT < 1) head = shown[shown.length - 1];
        else head = route[Math.min(route.length - 1, Math.floor(cruise * (route.length - 1)))];
      }
      map.getSource('plane').setData({ type: 'FeatureCollection', features: head ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: head } }] : [] });
    }

    // ---- pins: the traveller's stops, flag and name, pulsing
    function syncPins(stops) {
      if (!ready) return;
      const keep = new Set();
      stops.forEach((d, i) => {
        const key = `${d.name}|${d.country || ''}`;
        keep.add(key);
        let m = pins.get(key);
        if (!m) {
          const e = document.createElement('div');
          e.className = 'mg-pin';
          e.innerHTML = `<span class="mg-pin-ring"></span><span class="mg-pin-dot"></span>
            <span class="mg-pin-label">${d.cc ? COUNTRIES.flagHtml(d.cc) : ''}<b>${esc(d.name)}</b></span>`;
          m = new maplibregl.Marker({ element: e, anchor: 'center', opacityWhenCovered: '0' }).setLngLat([d.lon, d.lat]).addTo(map);
          pins.set(key, m);
        }
        m.getElement().style.setProperty('--c', COLORS[i % COLORS.length]);
      });
      if (!pins.has('home')) {
        const e = document.createElement('div');
        e.className = 'mg-pin mg-pin-home';
        e.innerHTML = '<span class="mg-pin-dot"></span><span class="mg-pin-label"><b>יוצאים מכאן</b></span>';
        pins.set('home', new maplibregl.Marker({ element: e, anchor: 'center', opacityWhenCovered: '0' }).setLngLat([HOME.lon, HOME.lat]).addTo(map));
      }
      pins.forEach((m, key) => {
        if (key === 'home') { m.getElement().hidden = !stops.length; return; }
        if (!keep.has(key)) { m.remove(); pins.delete(key); }
      });
    }

    // ---- the camera, per step
    let lastCamKey = '';
    function apply(force = false) {
      if (!ready || failed || !st) return;
      const stops = located(st);
      const key = stops.map((d) => `${d.lon.toFixed(2)},${d.lat.toFixed(2)}`).join(';');
      if (key !== routeKey) {
        const grew = stops.length > (routeKey ? routeKey.split(';').length : 0);
        route = stops.length ? buildRoute(stops) : [];
        routeKey = key;
        routeT = grew && !REDUCED ? 0 : 1;
        cruise = 0;
      }
      syncPins(stops);
      drawRoute();
      if (mode === 'dive') return;
      const camKey = `${st.step}|${key}|${force ? Date.now() : ''}`;
      if (camKey === lastCamKey) return;
      lastCamKey = camKey;
      const dur = REDUCED ? 0 : 2600;
      if (!stops.length) {
        mode = 'spin';
        map.easeTo({ zoom: baseZoom(), pitch: 0, bearing: 0, duration: dur });
        return;
      }
      if (st.step >= 3) {
        const d = stops[stops.length - 1];
        mode = 'orbit';
        map.flyTo({ center: [d.lon, d.lat], zoom: wide() ? 6.2 : 5.4, pitch: 58, bearing: -25, duration: REDUCED ? 0 : 3400, essential: true });
        setTerrain(true);
        return;
      }
      setTerrain(false);
      mode = 'frame';
      const cam = frameFor([{ lon: HOME.lon, lat: HOME.lat }, ...stops]);
      map.flyTo({
        center: cam.center,
        zoom: cam.zoom, pitch: st.step === 2 ? 38 : 18, bearing: st.step === 2 ? -12 : 0,
        duration: dur, essential: true, curve: 1.3,
      });
    }

    // The camera that shows every point on the globe, worked out on the sphere:
    // cameraForBounds thinks in flat Mercator and, on the globe, lands far too close —
    // the first and last stops end up under the panels. The centre is the mean of the
    // points as unit vectors; the zoom is the one at which the widest chord between it
    // and a point fits the part of the screen the panels leave free. (The globe is drawn
    // at the Mercator scale of its centre's latitude, hence the cos.)
    function frameFor(pts) {
      const r = Math.PI / 180;
      let x = 0; let y = 0; let z = 0;
      pts.forEach((p) => {
        x += Math.cos(p.lat * r) * Math.cos(p.lon * r);
        y += Math.cos(p.lat * r) * Math.sin(p.lon * r);
        z += Math.sin(p.lat * r);
      });
      const clon = Math.atan2(y, x) / r;
      const clat = Math.atan2(z, Math.sqrt(x * x + y * y)) / r;
      let spread = 0; // the widest angle from the centre to any point
      pts.forEach((p) => {
        const c = Math.sin(clat * r) * Math.sin(p.lat * r) + Math.cos(clat * r) * Math.cos(p.lat * r) * Math.cos((p.lon - clon) * r);
        spread = Math.max(spread, Math.acos(Math.min(1, Math.max(-1, c))));
      });
      const pad = padding();
      const free = Math.max(160, Math.min(window.innerWidth - pad.left - pad.right, window.innerHeight - pad.top - pad.bottom));
      const chord = 2 * Math.sin(Math.max(spread, 2 * r)) * 1.12; // a little more, for breathing room and the labels
      const zoom = Math.log2((free * 2 * Math.PI * Math.cos(clat * r)) / (512 * chord));
      return { center: [clon, clat], zoom: Math.max(wide() ? 1.3 : 0.9, Math.min(zoom, 6)) };
    }

    // real relief under a tilted camera is the most expensive frame here — on a desktop
    // only; a phone keeps the flat relief and its battery
    let terrainOn = false;
    function setTerrain(on) {
      if (!FINE) return;
      if (!ready || on === terrainOn) return;
      terrainOn = on;
      try { map.setTerrain(on ? { source: 'demt', exaggeration: 1.6 } : null); } catch { /* the relief is decoration */ }
    }

    // one loop for everything that moves on its own: the idle spin, the orbit, the
    // route drawing itself and the little plane that rides it afterwards
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      if (!ready || failed) return;
      const dt = Math.min(64, ts - (lastFrame || ts));
      lastFrame = ts;
      if (document.hidden) return;
      if (routeT < 1) { routeT = Math.min(1, routeT + dt / 1700); drawRoute(); }
      else if (route.length > 1 && !REDUCED) { cruise = (cruise + dt / 9000) % 1; drawRoute(); }
      if (REDUCED || map.isMoving()) return;
      if (mode === 'spin') {
        const c = map.getCenter();
        map.jumpTo({ center: [c.lng + dt * 0.004, c.lat] });
      } else if (mode === 'orbit' || mode === 'dive') {
        map.jumpTo({ bearing: map.getBearing() - dt * (mode === 'dive' ? 0.012 : 0.004) });
      }
    }

    // the take-off: down into the first stop, steep, over the relief
    function dive() {
      if (!ready || failed || !st) return;
      const stops = located(st);
      const d = stops[0];
      if (!d) return;
      mode = 'dive';
      setTerrain(true);
      map.flyTo({ center: [d.lon, d.lat], zoom: 9.5, pitch: 68, bearing: map.getBearing() - 40, duration: REDUCED ? 0 : 4200, essential: true, curve: 1.6 });
    }
    function undive() { mode = 'frame'; lastCamKey = ''; apply(); }

    return { init, apply, dive, undive, get ok() { return ready && !failed; } };
  })();

  // ================================================================ the page around the wizard

  const PLANE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5Z"/></svg>';

  function buildStage() {
    const stage = document.createElement('div');
    stage.className = 'mg-stage';
    stage.setAttribute('aria-hidden', 'true');
    stage.innerHTML = `
      <div class="mg-sky"><i></i><i></i><i></i></div>
      <div class="mg-flatphoto"></div>
      <div class="mg-globe"></div>
      <div class="mg-vignette"></div>
      <div class="mg-credit">Relief © Mapzen/AWS · Imagery © Esri · Photos Unsplash</div>`;
    document.body.prepend(stage);
    return stage;
  }

  // the old three boxes become a flight path: the plane sits on the step you are on,
  // and the last stop is the take-off itself
  function buildProgress() {
    const old = document.querySelector('.wizard-progress');
    const p = document.createElement('nav');
    p.className = 'mg-progress';
    p.setAttribute('aria-label', 'שלבי התכנון');
    const stops = [['1', 'לאן'], ['2', 'מתי'], ['3', 'איך'], ['✨', 'המראה']];
    p.innerHTML = `
      <div class="mg-pp-line"><span class="mg-pp-fill"></span></div>
      <span class="mg-pp-plane">${PLANE_SVG}</span>
      ${stops.map(([n, l], i) => `<button type="button" class="mg-pp-stop" data-step="${i + 1}" style="--i:${i}" ${i === 3 ? 'disabled' : ''}>
        <span class="mg-pp-n">${n}</span><span class="mg-pp-l">${l}</span></button>`).join('')}`;
    old.after(p);
    // back to any step already passed — forward is the panel's own button, which checks
    p.addEventListener('click', (e) => {
      const b = e.target.closest('.mg-pp-stop');
      if (!b || !st || +b.dataset.step >= st.step) return;
      PlanWizard.goStep(+b.dataset.step);
    });
    return p;
  }

  function buildPreview() {
    const a = document.createElement('aside');
    a.className = 'mg-preview';
    a.setAttribute('aria-label', 'תצוגה מקדימה של הטיול');
    a.innerHTML = `
      <div class="mg-card">
        <div class="mg-cover">
          <div class="mg-cover-imgs"></div>
          <div class="mg-cover-shade"></div>
          <span class="mg-badge"><i></i>הטיול שלכם נבנה</span>
          <span class="mg-flags"></span>
        </div>
        <div class="mg-head">
          <h2 class="mg-title"><span class="mg-ghost">לאן הפעם?</span></h2>
          <div class="mg-meta"><span class="mg-meta-hint">בחרו יעד, והטיול יתחיל להיבנות כאן ✨</span></div>
        </div>
        <div class="mg-body">
          <section class="mg-sec mg-sec-route">
            <h3 class="mg-sec-h">המסלול</h3>
            <div class="mg-route"></div>
          </section>
          <section class="mg-sec mg-sec-days">
            <h3 class="mg-sec-h">יום אחרי יום <span class="mg-sec-aside"></span></h3>
            <div class="mg-days"></div>
            <div class="mg-legend"></div>
          </section>
          <section class="mg-sec mg-sec-vibe">
            <h3 class="mg-sec-h">האווירה</h3>
            <div class="mg-vibes"></div>
            <p class="mg-note" hidden></p>
          </section>
        </div>
      </div>`;
    document.querySelector('.mg-progress').before(a);
    // a postcard you can tip in your hand — a pointer only; a phone scrolls past it
    if (FINE && !REDUCED) {
      const card = a.querySelector('.mg-card');
      a.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty('--ry', `${(-x * 9).toFixed(2)}deg`);
        card.style.setProperty('--rx', `${(y * 7).toFixed(2)}deg`);
        card.style.setProperty('--gx', `${((x + 0.5) * 100).toFixed(1)}%`);
        card.style.setProperty('--gy', `${((y + 0.5) * 100).toFixed(1)}%`);
      });
      a.addEventListener('pointerleave', () => { card.style.setProperty('--ry', '0deg'); card.style.setProperty('--rx', '0deg'); });
    }
    return a;
  }

  // step 1 gets a rail of postcards to pick from instead of only a blank box — the
  // popular strip's own list (js/popular.js), so each card is a destination the
  // wizard already knows how to plan
  function buildInspiration() {
    if (typeof POPULAR === 'undefined') return;
    const panel = document.getElementById('panel-1');
    const box = document.createElement('div');
    box.className = 'mg-inspo';
    const cards = [
      ...POPULAR.combos.map((c) => ({ kind: 'combo', id: c.id, name: c.title, sub: `${c.dests.length} מדינות`, ccs: c.dests.map((d) => d.cc), img: c.img })),
      ...POPULAR.singles.map((d) => ({ kind: 'single', name: d.name, sub: d.country || 'כל המדינה', ccs: [d.cc], img: d.img, d })),
    ];
    box.innerHTML = `
      <div class="mg-inspo-head"><span>או שתנו לתמונה לבחור</span><small>לחיצה מוסיפה לטיול</small></div>
      <div class="mg-inspo-rail" role="list">
        ${cards.map((c, i) => `
          <button type="button" class="mg-postcard" role="listitem" data-i="${i}" style="--i:${i}">
            <img src="${esc(c.img.replace('w=360&h=240', 'w=420&h=300'))}" alt="" loading="lazy" decoding="async">
            <span class="mg-pc-shade"></span>
            <span class="mg-pc-flags">${c.ccs.map((cc) => COUNTRIES.flagHtml(cc)).join('')}</span>
            <span class="mg-pc-name">${esc(c.name)}</span>
            <span class="mg-pc-sub">${esc(c.sub)}</span>
            <span class="mg-pc-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span>
          </button>`).join('')}
      </div>`;
    panel.querySelector('.form-error').before(box);
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.mg-postcard');
      if (!b) return;
      const c = cards[+b.dataset.i];
      const dests = c.kind === 'combo' ? POPULAR.chips(POPULAR.combo(c.id).dests) : [{ name: c.d.name, country: c.d.country || c.d.name, lat: null, lon: null, cc: c.d.cc }];
      const picked = st ? st.destinations : [];
      const has = (d) => picked.some((p) => p.name === d.name);
      if (dests.every(has)) {
        // a second tap takes it back off — the card is a toggle, like a chip
        dests.forEach((d) => {
          const i = (PlanWizard.snapshot().destinations || []).findIndex((p) => p.name === d.name);
          if (i >= 0) PlanWizard.remove(i);
        });
        return;
      }
      dests.filter((d) => !has(d)).forEach((d) => PlanWizard.add({ ...d }));
      burstFrom(b, { n: 16 });
    });
  }

  // the interest chips keep their text (plan.js reads it back from a draft) and gain
  // a face: the emoji large, the label under it
  function dressInterests() {
    document.querySelectorAll('#interest-row .interest-chip').forEach((b, i) => {
      const t = b.textContent;
      const sp = t.indexOf(' ');
      const emo = t.slice(0, sp);
      const label = t.slice(sp + 1);
      emojiOf[label] = emo;
      b.innerHTML = `<span class="mg-ie" aria-hidden="true">${emo}</span> <span class="mg-il">${esc(label)}</span>`;
      b.style.setProperty('--i', i);
      b.addEventListener('click', () => { if (b.classList.contains('selected')) burstFrom(b.querySelector('.mg-ie'), { emoji: emo, n: 7, spread: 70 }); });
    });
  }

  function dressCopy() {
    const h1 = document.querySelector('.wizard-shell > h1');
    if (h1) h1.innerHTML = 'בונים <span class="mg-shine">טיול חדש</span>';
    const sub = document.querySelector('.wizard-shell > .page-sub');
    if (sub) sub.textContent = 'שלוש שאלות, וצופים בטיול שלכם נבנה מול העיניים.';
    const cta = document.getElementById('ai-full');
    if (cta) { cta.classList.add('mg-cta'); cta.insertAdjacentHTML('beforeend', '<span class="mg-cta-glint" aria-hidden="true"></span>'); }
  }

  // ================================================================ the live preview

  const P = {};
  function bindPreview(a) {
    P.card = a.querySelector('.mg-card');
    P.imgs = a.querySelector('.mg-cover-imgs');
    P.flags = a.querySelector('.mg-flags');
    P.title = a.querySelector('.mg-title');
    P.meta = a.querySelector('.mg-meta');
    P.route = a.querySelector('.mg-route');
    P.days = a.querySelector('.mg-days');
    P.legend = a.querySelector('.mg-legend');
    P.aside = a.querySelector('.mg-sec-aside');
    P.vibes = a.querySelector('.mg-vibes');
    P.note = a.querySelector('.mg-note');
    P.badge = a.querySelector('.mg-badge');
  }

  // ---- cover: the latest destination's photo; with several, they take turns
  let coverList = null;
  let coverIdx = 0;
  let coverTimer = 0;
  let coverShown = '';
  function showCover(url) {
    if (!url || url === coverShown) return;
    coverShown = url;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.className = 'mg-cover-img';
    img.src = url;
    const put = () => {
      P.imgs.appendChild(img);
      requestAnimationFrame(() => img.classList.add('in'));
      const old = [...P.imgs.children].slice(0, -1);
      setTimeout(() => old.forEach((o) => o.remove()), 1600);
      document.querySelector('.mg-flatphoto')?.style.setProperty('--img', `url("${url}")`);
    };
    if (img.complete) put(); else { img.onload = put; img.onerror = put; }
  }
  function setCovers(list) {
    const key = list.join('|');
    if (coverList && key === coverList.join('|')) return;
    const added = !!coverList && list.length > coverList.length;
    coverList = list;
    clearInterval(coverTimer);
    coverIdx = added ? list.length - 1 : 0; // a new pick is shown first
    showCover(list[coverIdx] || DEST_PHOTOS.img(DEST_PHOTOS.generic[0], 900));
    if (list.length > 1 && !REDUCED) {
      coverTimer = setInterval(() => { coverIdx = (coverIdx + 1) % coverList.length; showCover(coverList[coverIdx]); }, 4200);
    }
  }

  // a title that types itself in, letter by letter — only when it changes
  let titleShown = null;
  function setTitle(text) {
    if (text === titleShown) return;
    titleShown = text;
    if (!text) { P.title.innerHTML = '<span class="mg-ghost">לאן הפעם?</span>'; return; }
    P.title.innerHTML = [...text].map((ch, i) => (ch === ' ' ? ' ' : `<span class="mg-ch" style="--d:${Math.min(i, 40) * 22}ms">${esc(ch)}</span>`)).join('');
  }

  function fmtRange(s) {
    if (!s.start) return '';
    const a = parseIso(s.start);
    const b = s.end ? parseIso(s.end) : null;
    if (!b) return `${a.getDate()} ב${MONTHS[a.getMonth()]}`;
    if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ב${MONTHS[a.getMonth()]}`;
    return `${a.getDate()} ב${MONTHS[a.getMonth()]} – ${b.getDate()} ב${MONTHS[b.getMonth()]}`;
  }
  // the season a date range lands in, where the trip is — a one-word promise
  function season(s) {
    if (!s.start) return '';
    const m = parseIso(s.start).getMonth();
    const south = (located(s)[0] || {}).lat < -5;
    const n = [['❄️', 'חורף'], ['❄️', 'חורף'], ['🌸', 'אביב'], ['🌸', 'אביב'], ['🌸', 'אביב'], ['☀️', 'קיץ'], ['☀️', 'קיץ'], ['☀️', 'קיץ'], ['🍂', 'סתיו'], ['🍂', 'סתיו'], ['🍂', 'סתיו'], ['❄️', 'חורף']];
    return n[south ? (m + 6) % 12 : m].join(' ');
  }

  // who gets which day: a rough even split, in the order picked — the planning chat
  // decides the real one, and the legend says so
  function daySplit(days, n) {
    if (!n) return [];
    return Array.from({ length: days }, (_, i) => Math.min(n - 1, Math.floor((i * n) / days)));
  }

  function renderDays(s) {
    const n = s.destinations.length;
    const split = daySplit(s.days, Math.max(n, 1));
    const cells = P.days.children;
    const start = s.start ? parseIso(s.start) : null;
    // grow or shrink in place, so only the days that are new arrive with a bounce
    while (cells.length > s.days) cells[cells.length - 1].remove();
    const had = cells.length;
    for (let i = 0; i < s.days; i++) {
      let c = cells[i];
      if (!c) {
        c = document.createElement('span');
        c.className = 'mg-day';
        c.style.setProperty('--d', `${Math.min(i - had, 30) * 28}ms`);
        P.days.appendChild(c);
      }
      const di = split[i];
      c.style.setProperty('--c', n ? COLORS[di % COLORS.length] : 'rgba(255,255,255,.35)');
      let label = `<b>${i + 1}</b>`;
      if (start) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        label += `<small>${DOW[d.getDay()]}׳</small>`;
      }
      c.innerHTML = label;
      c.title = n ? `יום ${i + 1} · ${s.destinations[di].name}` : `יום ${i + 1}`;
    }
    P.days.classList.toggle('is-long', s.days > 21);
    P.days.classList.toggle('is-ghost', !n); // days with nowhere to be yet are outlines, not loading bars
    P.aside.textContent = s.start ? fmtRange(s) : 'תאריכים — כשתבחרו';
    if (n > 1) {
      const counts = s.destinations.map((_, i) => split.filter((x) => x === i).length);
      P.legend.innerHTML = s.destinations.map((d, i) => `<span><i style="--c:${COLORS[i % COLORS.length]}"></i>${esc(d.name)} · ~${counts[i]}</span>`).join('')
        + '<em>החלוקה הסופית נקבעת בתכנון</em>';
    } else P.legend.innerHTML = '';
  }

  function renderRoute(s) {
    if (!s.destinations.length) {
      P.route.innerHTML = `<span class="mg-stop mg-stop-home"><b>${esc(HOME.name)}</b></span><span class="mg-leg" style="--c:#ffb45f"><i>${PLANE_SVG}</i></span><span class="mg-stop mg-stop-ghost"><b>?</b></span>`;
      return;
    }
    const legs = s.destinations.map((d, i) => `
      <span class="mg-leg" style="--c:${COLORS[i % COLORS.length]}"><i>${PLANE_SVG}</i></span>
      <span class="mg-stop" style="--c:${COLORS[i % COLORS.length]}">${d.cc ? COUNTRIES.flagHtml(d.cc) : '📍'}<b>${esc(d.name)}</b></span>`).join('');
    P.route.innerHTML = `<span class="mg-stop mg-stop-home"><b>${esc(HOME.name)}</b></span>${legs}`;
  }

  function renderVibes(s) {
    if (!s.interests.length) {
      P.vibes.innerHTML = s.step >= 3
        ? '<span class="mg-vibe-empty">בחרו מה מעניין אתכם, וזה יופיע כאן</span>'
        : '<span class="mg-vibe-empty">בשלב 3 תבחרו מה מעניין אתכם</span>';
    } else {
      const have = new Set([...P.vibes.querySelectorAll('.mg-vibe')].map((e) => e.dataset.k));
      P.vibes.innerHTML = s.interests.map((k) => `<span class="mg-vibe${have.has(k) ? '' : ' is-new'}" data-k="${esc(k)}">${emojiOf[k] || '✨'} ${esc(k)}</span>`).join('');
    }
    P.note.hidden = !s.notes;
    P.note.textContent = s.notes ? `״${s.notes}״` : '';
  }

  function render() {
    const s = st;
    if (!s) return;
    const p = prev;
    document.documentElement.dataset.mgStep = s.step;

    // cover + flags + title
    const ccs = [...new Set(s.destinations.map((d) => d.cc).filter(Boolean))];
    P.flags.innerHTML = ccs.map((cc) => COUNTRIES.flagHtml(cc)).join('');
    setCovers(s.destinations.map((d) => photoFor(d, 900)));
    setTitle(s.title || (s.destinations.length ? (DESTINATIONS.tripPhrase ? DESTINATIONS.tripPhrase(s.destinations[0].name) : s.destinations[0].name) : ''));
    const bits = [];
    if (s.step > 1 || s.days !== 4 || s.start) bits.push(`${s.days} ימים`);
    if (s.start) bits.push(fmtRange(s));
    const se = season(s);
    P.meta.innerHTML = bits.length
      ? `${bits.map(esc).join(' · ')}${se ? ` <span class="mg-season">${se}</span>` : ''}`
      : (s.destinations.length ? '<span class="mg-meta-hint">כמה זמן? בשלב הבא</span>' : '<span class="mg-meta-hint">בחרו יעד, והטיול יתחיל להיבנות כאן ✨</span>');

    renderRoute(s);
    renderDays(s);
    renderVibes(s);

    P.card.classList.toggle('has-dest', !!s.destinations.length);
    P.card.classList.toggle('has-dates', !!s.start);
    P.card.classList.toggle('has-vibe', !!s.interests.length);

    // a new destination: the card catches it
    if (p && s.destinations.length > p.destinations.length && !REDUCED) {
      P.card.classList.remove('is-catch');
      void P.card.offsetWidth;
      P.card.classList.add('is-catch');
      burstFrom(P.flags, { n: 12, spread: 70 });
    }

    // the postcards on step 1 show which are already in the trip
    const names = new Set(s.destinations.map((d) => d.name));
    document.querySelectorAll('.mg-postcard').forEach((b) => {
      const i = +b.dataset.i;
      const card = b; // eslint-friendly alias
      const nm = card.querySelector('.mg-pc-name').textContent;
      const combo = typeof POPULAR !== 'undefined' && i < POPULAR.combos.length ? POPULAR.combos[i] : null;
      const on = combo ? combo.dests.every((d) => names.has(d.name)) : names.has(nm);
      card.classList.toggle('is-on', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    // step changes: the progress plane moves, the new panel swings in
    const prog = document.querySelector('.mg-progress');
    prog.style.setProperty('--at', s.step - 1);
    prog.querySelectorAll('.mg-pp-stop').forEach((b) => {
      const n = +b.dataset.step;
      b.classList.toggle('is-done', n < s.step);
      b.classList.toggle('is-here', n === s.step);
      if (n < 4) b.disabled = n >= s.step;
    });
    if (p && p.step !== s.step) {
      const panel = document.getElementById(`panel-${s.step}`);
      panel.classList.remove('mg-in-fwd', 'mg-in-back');
      void panel.offsetWidth;
      panel.classList.add(s.step > p.step ? 'mg-in-fwd' : 'mg-in-back');
    }

    Globe.apply();
  }

  // ================================================================ take-off

  function launch(snap, path) {
    st = snap;
    const t0 = performance.now();
    const MIN = REDUCED ? 500 : 3600;
    const first = snap.destinations[0] || { name: 'לאן שתבחרו' };
    const more = snap.destinations.length > 1 ? ` +${snap.destinations.length - 1}` : '';
    const who = (TRIPMAKER.user && TRIPMAKER.user.name) || 'מטיילים';
    const when = snap.start ? fmtRange(snap) : 'תאריך פתוח';
    const lines = path === 'manual'
      ? ['אורזים את מה שסיפרתם', 'מסמנים את היעדים על המפה', 'מכינים לכם דף טיול נקי']
      : ['אורזים את מה שסיפרתם', 'מסמנים את היעדים על המפה', 'מעירים את מתכנן ה-AI', 'פותחים את חדר התכנון'];
    const ov = document.createElement('div');
    ov.className = 'mg-launch';
    ov.setAttribute('role', 'status');
    ov.setAttribute('aria-live', 'polite');
    ov.innerHTML = `
      <div class="mg-launch-sky"></div>
      <div class="mg-pass-lift"><div class="mg-pass">
        <div class="mg-pass-top">
          <span class="mg-pass-brand" dir="ltr">TRIP<b>MAKER</b></span>
          <span class="mg-pass-kind">כרטיס עלייה למטוס</span>
        </div>
        <div class="mg-pass-route">
          <div class="mg-pass-pt"><small>מ</small><b dir="ltr">TLV</b><span>${esc(HOME.name)}</span></div>
          <div class="mg-pass-fly"><i></i>${PLANE_SVG}<i></i></div>
          <div class="mg-pass-pt"><small>אל</small><b>${first.cc ? COUNTRIES.flagHtml(first.cc) : '🌍'}</b><span>${esc(first.name)}${esc(more)}</span></div>
        </div>
        <div class="mg-pass-grid">
          <div><small>נוסעים</small><b>${esc(who)}</b></div>
          <div><small>מתי</small><b>${esc(when)}</b></div>
          <div><small>משך</small><b>${snap.days} ימים</b></div>
          <div><small>שער</small><b dir="ltr">AI</b></div>
        </div>
        <div class="mg-pass-tear"></div>
        <div class="mg-pass-foot">
          <span class="mg-pass-code" aria-hidden="true"></span>
          <span class="mg-pass-title">${esc(snap.title || DESTINATIONS.tripPhrase?.(first.name) || first.name)}</span>
        </div>
        <span class="mg-stamp" aria-hidden="true">מוכן<br>להמראה</span>
      </div></div>
      <ol class="mg-launch-lines">${lines.map((l, i) => `<li style="--i:${i}"><span class="mg-ll-dot"></span>${esc(l)}</li>`).join('')}</ol>
      <div class="mg-launch-flash"></div>`;
    document.body.appendChild(ov);
    document.documentElement.classList.add('mg-launching');
    requestAnimationFrame(() => ov.classList.add('is-on'));
    Globe.dive();
    const lis = [...ov.querySelectorAll('.mg-launch-lines li')];
    let k = 0;
    const tick = setInterval(() => {
      if (k < lis.length - 1) { lis[k].classList.add('is-done'); k++; lis[k].classList.add('is-now'); }
    }, REDUCED ? 150 : 850);
    lis[0].classList.add('is-now');
    return {
      async land() {
        const wait = MIN - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
        clearInterval(tick);
        lis.forEach((li) => { li.classList.remove('is-now'); li.classList.add('is-done'); });
        ov.classList.add('is-landed');
        burstFrom(ov.querySelector('.mg-stamp'), { n: 22, spread: 160 });
        await sleep(REDUCED ? 200 : 1100);
        ov.classList.add('is-gone');
        await sleep(REDUCED ? 0 : 380);
      },
      abort() {
        clearInterval(tick);
        ov.classList.remove('is-on');
        document.documentElement.classList.remove('mg-launching');
        setTimeout(() => ov.remove(), 400);
        Globe.undive();
      },
    };
  }

  // ================================================================ switching it on

  function activate() {
    if (active || typeof PlanWizard === 'undefined') return;
    active = true;
    document.documentElement.classList.add('magic-on');
    const stage = buildStage();
    buildProgress();
    bindPreview(buildPreview());
    buildInspiration();
    dressInterests();
    dressCopy();
    document.addEventListener('plan:state', (e) => { prev = st; st = e.detail; render(); });
    st = PlanWizard.snapshot();
    render();
    // the CTA throws sparks on the way out
    document.getElementById('ai-full')?.addEventListener('pointerdown', (e) => burst(e.clientX, e.clientY, { n: 18, spread: 120 }));
    // destination chips in the search sparkle as they land
    const chips = document.getElementById('dest-chips');
    new MutationObserver((m) => {
      if (m.some((r) => r.addedNodes.length) && prev && st && st.destinations.length > prev.destinations.length) {
        burstFrom(chips.lastElementChild, { n: 10, spread: 60 });
      }
    }).observe(chips, { childList: true });
    // on a phone the credit line lives at the foot of the page: over the globe it sat
    // right under the header, on top of the view it was crediting
    const foot = document.querySelector('.site-footer');
    if (foot) foot.insertAdjacentHTML('beforeend', '<div class="mg-credit-foot" dir="ltr">Relief © Mapzen/AWS · Imagery © Esri · Photos Unsplash</div>');
    Globe.init(stage.querySelector('.mg-globe'));
  }

  // the admin's switch: a pill at the foot of the page, on for this browser only
  function mountSwitch() {
    if (!isAdmin()) { document.documentElement.classList.remove('magic-on'); return; }
    const on = wanted();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mg-switch';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.title = 'נראה רק למנהלים, ונשמר בדפדפן הזה';
    b.innerHTML = `<span class="mg-switch-track"><span class="mg-switch-knob"></span></span>
      <span class="mg-switch-text">חוויית היצירה החדשה</span><span class="mg-switch-tag">מנהלים</span>`;
    b.onclick = () => {
      const next = b.getAttribute('aria-checked') !== 'true';
      try { if (next) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* no storage: this visit only */ }
      TRIPMAKER.track?.('plan_magic_switch', { on: next });
      b.setAttribute('aria-checked', next ? 'true' : 'false');
      // switching on is live; switching off reloads into the plain wizard, answers kept
      // by the draft autosave
      if (next) activate(); else setTimeout(() => location.reload(), 220);
    };
    document.body.appendChild(b);
    if (on) activate();
  }

  mountSwitch();

  return { get active() { return active; }, launch };
})();
