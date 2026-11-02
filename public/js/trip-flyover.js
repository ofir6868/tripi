// The trip, flown over in 3D — and saved as a video to keep or send.
//
// For a trip that has started (trip-map.js offers it from the full-page map): the
// camera opens high over the whole trip, dives to the first stop, and flies stop to
// stop in the order they were walked — tilted, over real terrain, the route drawing
// itself behind it in each day's colour, the stop's name on screen while the camera
// circles it. The same frames can be recorded on the device into a video file
// (MediaRecorder on a canvas), downloaded or handed to the phone's share sheet.
//
// What is on screen is what is recorded: the map is drawn by MapLibre (vendored,
// loaded only when this opens) and every frame is composited onto a second canvas
// together with the pins, the captions and the title cards — DOM markers and HTML
// captions would not be in the video. Hebrew is drawn by the canvas itself (RTL).
//
// Sources, keyless like the 2D map (PLAYBOOK §2): Esri World Imagery for the ground,
// Esri's reference layer for place names, and the Terrarium elevation tiles AWS hosts
// as open data for the relief. Esri failing before its first tile falls back to OSM
// streets, loudly (console.warn) — the same rule as trip-map.js.
//
// The path. "The path you actually went" lives in Google Maps Timeline, which Google
// moved onto the phone in 2024–25: there is no API that reads it any more, for us or
// anyone. What a traveller CAN do is export it from the Maps app (a Timeline.json
// file — the older Takeout files work too) and hand it to this page. The file is read
// here, on the device, cut down to the trip's own dates, and kept in this browser
// only; nothing of it is sent to the server (the same rule as the documents page).
// With it, each stop the traveller really reached is found in the timeline and the
// flight follows the recorded track between them. Without it — or for stops the
// timeline never came near — the flight is a straight line from place to place, or
// no line at all, as the traveller picks.
const TripFlyover = (() => {
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const TILE = {
    sat: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
    osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    dem: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  };
  const OUT = { wide: [1280, 720], tall: [720, 1280] };
  const FPS = 30;
  const MAX_STOPS = 45;           // past this the video samples the stops — a 90-stop film is a chore
  const MATCH_M = 300;            // how near the timeline must come for a stop to count as reached
  const TL_KEY = (code) => `tripmaker_timeline_${code}`;

  const esc = (s) => TRIPMAKER.esc(s);
  const $ = (sel) => root && root.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const rad = Math.PI / 180;
  const metres = (a, b) => {
    const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * rad);
    const y = b[1] - a[1];
    return Math.sqrt(x * x + y * y) * 111320;
  };
  const bearing = (a, b) => {
    const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
    const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
    return Math.atan2(y, x) / rad;
  };

  let root = null;
  let opts = null;
  let map = null;
  let comp = null;      // the composite canvas — the video
  let cx = null;
  let raf = 0;
  let aspect = 'wide';
  let pathMode = 'line'; // 'line' | 'none' | 'timeline'
  let scope = 0;         // 0 = the whole trip, else one day
  let timeline = null;   // { points: [[t, lat, lon]], at, files }
  let run = null;        // the flight in progress: { plan, idx, ... }
  let rec = null;        // { recorder, chunks, mime }
  let result = null;     // { url, blob, name }
  let wake = null;
  let satLoaded = false;
  let satErrors = 0;
  let attribution = 'Imagery © Esri · Terrain © Mapzen/AWS';
  let fonts = { body: 'Assistant, sans-serif', display: '"Suez One", serif' };

  // ---------------------------------------------------------------- timeline files

  // "32.0853°, 34.7818°" · "geo:32.0853,34.7818" · {latitudeE7} · {latE7} · {latLng}
  function toLL(v) {
    if (v == null) return null;
    if (typeof v === 'object') {
      if (v.latitudeE7 != null) return [v.latitudeE7 / 1e7, v.longitudeE7 / 1e7];
      if (v.latE7 != null) return [v.latE7 / 1e7, v.lngE7 / 1e7];
      return toLL(v.latLng || v.LatLng || v.placeLocation || v.point || v.location || null);
    }
    const m = String(v).match(/(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = +m[1];
    const lon = +m[2];
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  }
  function toT(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    if (/^\d{12,}$/.test(v)) return +v;
    return Date.parse(v);
  }

  // Every export Google has shipped, flattened to [time ms, lat, lon] points:
  // the on-device Timeline.json of Android (semanticSegments + rawSignals) and of
  // iPhone (a bare array of segments), and the two older Takeout files (Records.json,
  // and the monthly Semantic Location History files).
  function parseTimeline(json) {
    const out = [];
    const push = (t, ll) => { if (ll && Number.isFinite(t)) out.push([t, ll[0], ll[1]]); };
    const segment = (e) => {
      const start = toT(e.startTime);
      const end = toT(e.endTime);
      if (e.visit) {
        const ll = toLL(e.visit.topCandidate && (e.visit.topCandidate.placeLocation || e.visit.topCandidate));
        push(start, ll); push(end, ll);
      }
      if (e.activity) { push(start, toLL(e.activity.start)); push(end, toLL(e.activity.end)); }
      (e.timelinePath || []).forEach((p) => {
        const t = p.time != null ? toT(p.time) : start + (+p.durationMinutesOffsetFromStartTime || 0) * 60000;
        push(t, toLL(p.point));
      });
    };
    if (Array.isArray(json)) json.forEach(segment);
    if (json && Array.isArray(json.semanticSegments)) json.semanticSegments.forEach(segment);
    if (json && Array.isArray(json.rawSignals)) {
      json.rawSignals.forEach((r) => { if (r.position) push(toT(r.position.timestamp), toLL(r.position.LatLng || r.position.latLng)); });
    }
    if (json && Array.isArray(json.locations)) {
      json.locations.forEach((l) => push(toT(l.timestamp || l.timestampMs), toLL(l)));
    }
    if (json && Array.isArray(json.timelineObjects)) {
      json.timelineObjects.forEach((o) => {
        if (o.placeVisit) {
          const d = o.placeVisit.duration || {};
          const ll = toLL(o.placeVisit.location);
          push(toT(d.startTimestamp || d.startTimestampMs), ll);
          push(toT(d.endTimestamp || d.endTimestampMs), ll);
        }
        const a = o.activitySegment;
        if (a) {
          const d = a.duration || {};
          const s = toT(d.startTimestamp || d.startTimestampMs);
          const e = toT(d.endTimestamp || d.endTimestampMs);
          push(s, toLL(a.startLocation));
          const raw = (a.simplifiedRawPath && a.simplifiedRawPath.points) || [];
          raw.forEach((p) => push(toT(p.timestamp || p.timestampMs), toLL(p)));
          const wps = (a.waypointPath && a.waypointPath.waypoints) || [];
          if (!raw.length) wps.forEach((p, i) => push(s + ((e - s) * (i + 1)) / (wps.length + 1), toLL(p)));
          push(e, toLL(a.endLocation));
        }
      });
    }
    return out;
  }

  // the trip's own days (a day of slack each side — a flight home lands late), no
  // point closer than 20 m to the one before it, and a ceiling on how many we keep
  function tripWindow() {
    const start = new Date(opts.trip.start_date); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + opts.trip.days);
    return [start.getTime() - 86400000, end.getTime() + 86400000];
  }
  function trimPoints(points) {
    const [a, b] = tripWindow();
    const inside = points.filter((p) => p[0] >= a && p[0] <= b).sort((x, y) => x[0] - y[0]);
    const kept = [];
    for (const p of inside) {
      const last = kept[kept.length - 1];
      if (last && metres([last[2], last[1]], [p[2], p[1]]) < 20) continue;
      kept.push(p);
    }
    const stride = Math.ceil(kept.length / 40000) || 1;
    return stride > 1 ? kept.filter((_, i) => i % stride === 0) : kept;
  }

  function loadStoredTimeline() {
    try {
      const raw = localStorage.getItem(TL_KEY(opts.trip.share_code));
      if (!raw) return null;
      const s = JSON.parse(raw);
      const points = [];
      for (let i = 0; i < s.p.length; i += 3) points.push([s.p[i] * 1000, s.p[i + 1] / 1e5, s.p[i + 2] / 1e5]);
      return { points, at: s.at, files: s.files };
    } catch { return null; }
  }
  function storeTimeline(tl) {
    const p = [];
    tl.points.forEach((x) => p.push(Math.round(x[0] / 1000), Math.round(x[1] * 1e5), Math.round(x[2] * 1e5)));
    try {
      localStorage.setItem(TL_KEY(opts.trip.share_code), JSON.stringify({ at: tl.at, files: tl.files, p }));
      return true;
    } catch { return false; } // full or blocked: it still works for this visit
  }

  async function importFiles(files) {
    const note = $('.fly-tl-note');
    const all = [];
    let readable = 0;
    for (const f of files) {
      if (f.size > 400 * 1024 * 1024) { note.textContent = `${f.name} גדול מדי לקריאה בדפדפן (מעל 400MB). נסו את Timeline.json מהטלפון — הוא קטן בהרבה.`; continue; }
      note.textContent = `קוראים את ${f.name}…`;
      try {
        const json = JSON.parse(await f.text());
        const pts = parseTimeline(json);
        if (pts.length) readable++;
        all.push(...pts);
      } catch {
        note.textContent = f.name.endsWith('.zip')
          ? 'זה קובץ ZIP — פתחו אותו קודם ובחרו את קובץ ה-JSON שבתוכו'
          : `${f.name} לא נקרא כקובץ JSON של ציר הזמן`;
        return;
      }
    }
    if (!readable) { note.textContent = 'לא מצאנו בקובץ נקודות של ציר זמן. בחרו את Timeline.json שייצאתם מאפליקציית Google Maps.'; return; }
    const points = trimPoints(all);
    if (points.length < 2) { note.textContent = 'בקובץ אין מיקומים מתאריכי הטיול — אולי ציר הזמן היה כבוי בזמן הנסיעה?'; return; }
    timeline = { points, at: Date.now(), files: [...files].map((f) => f.name).join(', ') };
    const kept = storeTimeline(timeline);
    pathMode = 'timeline';
    TRIPMAKER.track?.('flyover_timeline_import', { code: opts.trip.share_code, points: points.length, stored: kept });
    renderSetup(kept ? '' : 'הקובץ גדול מכדי להישמר בדפדפן — הוא ישמש רק בביקור הזה');
  }

  // ---------------------------------------------------------------- the plan

  // the stops to fly, in walking order: day, then the day's own order
  function scopeStops() {
    const located = (it) => it.lat != null && it.lon != null;
    let stops = opts.items().filter(located).filter((it) => !scope || it.day_number === scope)
      .slice().sort((a, b) => a.day_number - b.day_number);
    if (stops.length > MAX_STOPS) {
      const step = (stops.length - 1) / (MAX_STOPS - 1);
      stops = Array.from({ length: MAX_STOPS }, (_, i) => stops[Math.round(i * step)]);
    }
    return stops;
  }

  // Walk the timeline once, in time order: each stop is reached at the first moment
  // after the previous stop that the track comes within MATCH_M of it. A stop the
  // track never reaches is left out of the flight — this is the trip as it happened.
  function matchTimeline(stops) {
    const pts = timeline.points;
    let from = 0;
    const hits = [];
    for (const s of stops) {
      const here = [s.lon, s.lat];
      for (let k = from; k < pts.length; k++) {
        if (metres(here, [pts[k][2], pts[k][1]]) <= MATCH_M) { hits.push({ stop: s, k }); from = k + 1; break; }
      }
    }
    return hits;
  }

  function straight(a, b, n = 24) {
    return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }

  function buildPlan() {
    let stops = scopeStops();
    let mode = pathMode;
    let note = '';
    const legs = [];  // legs[i]: the path into stop i (i ≥ 1), lon/lat pairs
    if (mode === 'timeline' && timeline) {
      const hits = matchTimeline(stops);
      if (hits.length >= 2) {
        if (hits.length < stops.length) note = `ציר הזמן הגיע ל-${hits.length} מתוך ${stops.length} התחנות — הסרטון עובר רק בהן`;
        stops = hits.map((h) => h.stop);
        hits.forEach((h, i) => {
          if (!i) return;
          const prev = hits[i - 1];
          let path = timeline.points.slice(prev.k, h.k + 1).map((p) => [p[2], p[1]]);
          const stride = Math.ceil(path.length / 300) || 1;
          if (stride > 1) path = path.filter((_, j) => j % stride === 0);
          legs[i] = [[prev.stop.lon, prev.stop.lat], ...path, [h.stop.lon, h.stop.lat]];
        });
      } else {
        mode = 'line';
        note = 'ציר הזמן לא עבר ליד תחנות הטיול — הסרטון טס בקו ישר';
      }
    }
    if (mode !== 'timeline') {
      stops.forEach((s, i) => { if (i) legs[i] = straight([stops[i - 1].lon, stops[i - 1].lat], [s.lon, s.lat]); });
    }
    // cumulative lengths, so "how far along the leg" can cut the path at a fraction
    const cum = legs.map((path) => {
      if (!path) return null;
      const c = [0];
      for (let j = 1; j < path.length; j++) c.push(c[j - 1] + metres(path[j - 1], path[j]));
      return c;
    });
    const n = stops.length;
    const dwell = n <= 12 ? 2600 : n <= 25 ? 1800 : 1100;
    const speed = n <= 25 ? 1 : 0.75;
    return { stops, legs, cum, mode, note, dwell, speed, drawLine: mode !== 'none' };
  }

  function legDuration(km, speed) {
    return clamp(1700 + Math.log2(1 + km) * 600, 2000, 6500) * speed;
  }

  // the part of leg i drawn so far — `frac` of its length
  function cutLeg(plan, i, frac) {
    const path = plan.legs[i];
    const cum = plan.cum[i];
    if (!path) return [];
    if (frac >= 1) return path;
    const goal = cum[cum.length - 1] * frac;
    const out = [path[0]];
    for (let j = 1; j < path.length; j++) {
      if (cum[j] <= goal) { out.push(path[j]); continue; }
      const t = (goal - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
      out.push([path[j - 1][0] + (path[j][0] - path[j - 1][0]) * t, path[j - 1][1] + (path[j][1] - path[j - 1][1]) * t]);
      break;
    }
    return out;
  }

  function setTrail(plan, upto, frac) {
    const src = map && map.getSource('trail');
    if (!src) return;
    const features = [];
    if (plan.drawLine) {
      for (let i = 1; i <= upto && i < plan.stops.length; i++) {
        const coords = i < upto ? plan.legs[i] : cutLeg(plan, i, frac);
        if (coords && coords.length > 1) {
          features.push({ type: 'Feature', properties: { color: opts.dayColor(plan.stops[i].day_number) }, geometry: { type: 'LineString', coordinates: coords } });
        }
      }
    }
    src.setData({ type: 'FeatureCollection', features });
  }

  // ---------------------------------------------------------------- the map

  function style() {
    return {
      version: 8,
      sources: {
        sat: { type: 'raster', tiles: [TILE.sat], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri' },
        labels: { type: 'raster', tiles: [TILE.labels], tileSize: 256, maxzoom: 19 },
        osm: { type: 'raster', tiles: [TILE.osm], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap' },
        dem: { type: 'raster-dem', tiles: [TILE.dem], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: 'Terrain: Mapzen / AWS Open Data' },
        trail: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0d1a17' } },
        // the fallback sits hidden under the imagery — a hidden layer's tiles are never fetched
        { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': 0.12, 'raster-contrast': 0.08 } },
        { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.85 } },
        { id: 'trail-glow', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 14, 'line-opacity': 0.35, 'line-blur': 6 } },
        { id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 5 } },
        { id: 'trail-core', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-opacity': 0.8 } },
      ],
      terrain: { source: 'dem', exaggeration: 1.4 },
      sky: {
        'sky-color': '#7fb4e6', 'horizon-color': '#f3d9b1', 'fog-color': '#cfe0ea',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.25, 'atmosphere-blend': 0.8,
      },
    };
  }

  function makeMap() {
    const box = $('.fly-map');
    const [w] = OUT[aspect];
    map = new maplibregl.Map({
      container: box,
      style: style(),
      center: [opts.items().find((i) => i.lon != null)?.lon || 0, opts.items().find((i) => i.lat != null)?.lat || 0],
      zoom: 3,
      pitch: 0,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      maxPitch: 75,
      pixelRatio: Math.max(1, w / (box.clientWidth || w)),
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    satLoaded = false; satErrors = 0; attribution = 'Imagery © Esri · Terrain © Mapzen/AWS';
    map.on('sourcedata', (e) => { if (e.sourceId === 'sat' && e.tile) satLoaded = true; });
    map.on('error', (e) => {
      if (e.sourceId !== 'sat' || satLoaded) return;
      if (++satErrors === 4) {
        console.warn('trip-flyover: Esri imagery is failing — falling back to OpenStreetMap streets');
        // a layer swap, not setTiles: reloading a raster source under terrain throws in MapLibre 5
        map.setLayoutProperty('sat', 'visibility', 'none');
        map.setLayoutProperty('labels', 'visibility', 'none');
        map.setLayoutProperty('osm', 'visibility', 'visible');
        attribution = 'Map © OpenStreetMap contributors · Terrain © Mapzen/AWS';
      }
    });
    return new Promise((res, rej) => {
      map.once('load', res);
      setTimeout(() => rej(new Error('load timeout')), 20000);
    });
  }

  function sizeFrame() {
    const stage = $('.fly-stage');
    const frame = $('.fly-frame');
    if (!stage || !frame) return;
    const [w, h] = OUT[aspect];
    const cs = getComputedStyle(stage);
    const sw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const sh = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const k = Math.min(sw / w, sh / h);
    frame.style.width = `${Math.floor(w * k)}px`;
    frame.style.height = `${Math.floor(h * k)}px`;
    comp.width = w; comp.height = h;
    if (map) {
      map.resize();
      map.setPixelRatio(Math.max(1, w / (frame.clientWidth || w)));
    }
  }

  const idle = (ms) => new Promise((res) => {
    if (!map) return res();
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    if (map.areTilesLoaded && map.areTilesLoaded() && !map.isMoving()) { setTimeout(fin, 60); return; }
    map.once('idle', fin);
    setTimeout(fin, ms);
  });

  // ---------------------------------------------------------------- compositing

  function roundRect(x, y, w, h, r) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + w, y, x + w, y + h, r);
    cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r);
    cx.arcTo(x, y, x + w, y, r);
    cx.closePath();
  }

  function drawPin(x, y, n, color, k, big, alpha) {
    cx.save();
    cx.globalAlpha = alpha;
    const r = (big ? 19 : 13) * k;
    if (big) {
      const pulse = (performance.now() % 1600) / 1600;
      cx.beginPath();
      cx.arc(x, y, r + (8 + pulse * 18) * k, 0, Math.PI * 2);
      cx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - pulse)})`;
      cx.lineWidth = 3 * k;
      cx.stroke();
    }
    cx.shadowColor = 'rgba(0,0,0,.5)';
    cx.shadowBlur = 10 * k;
    cx.shadowOffsetY = 3 * k;
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fillStyle = color;
    cx.fill();
    cx.shadowColor = 'transparent';
    cx.lineWidth = 3 * k;
    cx.strokeStyle = '#fff';
    cx.stroke();
    cx.fillStyle = '#241302';
    cx.font = `800 ${Math.round((big ? 17 : 12) * k)}px ${fonts.body}`;
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.direction = 'ltr';
    cx.fillText(String(n), x, y + 1 * k);
    cx.restore();
  }

  function dayText(day) {
    const d = opts.dayDate ? opts.dayDate(day) : null;
    return `יום ${day}${d ? ` · ${d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}`;
  }
  function datesText() {
    const a = opts.dayDate && opts.dayDate(1);
    const b = opts.dayDate && opts.dayDate(opts.trip.days);
    if (!a || !b) return `${opts.trip.days} ימים`;
    const f = (d) => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
    return `${f(a)} – ${f(b)} ${b.getFullYear()}`;
  }

  // centred title card (intro / outro), fading by `a`
  function titleCard(a, big, sub, small) {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    cx.save();
    cx.globalAlpha = a;
    const g = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(6,13,11,.55)');
    g.addColorStop(1, 'rgba(6,13,11,.85)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.direction = 'rtl';
    cx.fillStyle = '#fff6e6';
    cx.shadowColor = 'rgba(0,0,0,.45)';
    cx.shadowBlur = 18 * k;
    let size = 64 * k;
    cx.font = `400 ${size}px ${fonts.display}`;
    while (cx.measureText(big).width > W * 0.86 && size > 26 * k) { size -= 2 * k; cx.font = `400 ${size}px ${fonts.display}`; }
    cx.fillText(big, W / 2, H / 2 - 22 * k);
    cx.shadowBlur = 0;
    cx.font = `700 ${26 * k}px ${fonts.body}`;
    cx.fillStyle = '#ffc879';
    cx.fillText(sub, W / 2, H / 2 + 38 * k);
    if (small) {
      cx.font = `600 ${19 * k}px ${fonts.body}`;
      cx.fillStyle = 'rgba(255,246,230,.75)';
      cx.fillText(small, W / 2, H / 2 + 78 * k);
    }
    cx.restore();
  }

  function caption(stop, n, a) {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    const pad = 20 * k;
    const color = opts.dayColor(stop.day_number);
    cx.save();
    cx.globalAlpha = a;
    cx.direction = 'rtl';
    cx.textAlign = 'right';
    cx.textBaseline = 'alphabetic';
    const title = stop.title || '';
    const meta = [stop.time_label, `${opts.stopEmoji(stop)} ${stop.category || ''}`.trim()].filter(Boolean).join(' · ');
    let ts = 36 * k;
    cx.font = `400 ${ts}px ${fonts.display}`;
    const maxW = W - 2 * (28 * k) - 2 * pad;
    while (cx.measureText(title).width > maxW && ts > 20 * k) { ts -= 1.5 * k; cx.font = `400 ${ts}px ${fonts.display}`; }
    const tw = cx.measureText(title).width;
    cx.font = `700 ${19 * k}px ${fonts.body}`;
    const dw = cx.measureText(dayText(stop.day_number)).width + 40 * k;
    const mw = cx.measureText(meta).width;
    const boxW = Math.min(Math.max(tw, dw, mw) + 2 * pad, W - 56 * k);
    const boxH = pad * 2 + 26 * k + ts * 1.15 + 26 * k;
    const x1 = W - 28 * k;
    const x0 = x1 - boxW;
    const y0 = H - 40 * k - boxH;
    const rise = (1 - a) * 18 * k;
    cx.translate(0, rise);
    roundRect(x0, y0, boxW, boxH, 18 * k);
    cx.fillStyle = 'rgba(10,21,18,.78)';
    cx.fill();
    cx.lineWidth = 1.5 * k;
    cx.strokeStyle = 'rgba(255,255,255,.14)';
    cx.stroke();
    // day line: a dot in the day's colour, then the day
    let y = y0 + pad + 18 * k;
    cx.beginPath();
    cx.arc(x1 - pad - 7 * k, y - 6 * k, 7 * k, 0, Math.PI * 2);
    cx.fillStyle = color;
    cx.fill();
    cx.fillStyle = color;
    cx.font = `800 ${19 * k}px ${fonts.body}`;
    cx.fillText(`${dayText(stop.day_number)}  ·  תחנה ${n}`, x1 - pad - 22 * k, y);
    y += ts * 1.15 + 4 * k;
    cx.fillStyle = '#fff6e6';
    cx.font = `400 ${ts}px ${fonts.display}`;
    cx.fillText(title, x1 - pad, y);
    if (meta) {
      y += 28 * k;
      cx.fillStyle = 'rgba(255,246,230,.75)';
      cx.font = `600 ${18 * k}px ${fonts.body}`;
      cx.fillText(meta, x1 - pad, y);
    }
    cx.restore();
  }

  function watermark() {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    cx.save();
    cx.textBaseline = 'top';
    cx.direction = 'ltr';
    cx.textAlign = 'left';
    cx.font = `800 ${17 * k}px ${fonts.body}`;
    cx.shadowColor = 'rgba(0,0,0,.6)';
    cx.shadowBlur = 8 * k;
    cx.fillStyle = '#ffb45f';
    cx.fillText('TRIP', 24 * k, 22 * k);
    const w = cx.measureText('TRIP').width;
    cx.fillStyle = '#fff6e6';
    cx.fillText('MAKER', 24 * k + w, 22 * k);
    // the trip's name, top right
    cx.direction = 'rtl';
    cx.textAlign = 'right';
    cx.font = `700 ${18 * k}px ${fonts.body}`;
    cx.fillText(`${opts.trip.emoji || ''} ${opts.trip.title || ''}`.trim(), W - 24 * k, 22 * k);
    // attribution, as small as it may be and still be read
    cx.direction = 'ltr';
    cx.textAlign = 'left';
    cx.textBaseline = 'bottom';
    cx.shadowBlur = 4 * k;
    cx.font = `600 ${11 * k}px ${fonts.body}`;
    cx.fillStyle = 'rgba(255,255,255,.7)';
    cx.fillText(attribution, 14 * k, H - 10 * k);
    cx.restore();
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!map || !comp) return;
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    try { cx.drawImage(map.getCanvas(), 0, 0, W, H); } catch { return; }
    // soft shade top and bottom, so white text holds on bright imagery
    const g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,.35)');
    g.addColorStop(0.18, 'rgba(0,0,0,0)');
    g.addColorStop(0.7, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.4)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    if (!run) { watermark(); return; }
    const { plan } = run;
    // the trail grows with the camera: how far along the leg the centre has come
    if (run.flying != null) {
      const i = run.flying;
      const a = [plan.stops[i - 1].lon, plan.stops[i - 1].lat];
      const b = [plan.stops[i].lon, plan.stops[i].lat];
      const c = map.getCenter();
      const total = metres(a, b) || 1;
      run.frac = clamp(Math.max(run.frac, 1 - metres([c.lng, c.lat], b) / total), 0, 1);
      setTrail(plan, i, run.frac);
    }
    // pins: the ones already reached in full, the rest waiting faintly
    const scale = W / (map.getCanvas().clientWidth || W);
    plan.stops.forEach((s, i) => {
      if (i === run.idx) return;
      const p = map.project([s.lon, s.lat]);
      const x = p.x * scale;
      const y = p.y * scale;
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) return;
      drawPin(x, y, run.nums[i], opts.dayColor(s.day_number), k, false, i < run.idx ? 1 : 0.45);
    });
    if (run.idx >= 0 && run.idx < plan.stops.length) {
      const s = plan.stops[run.idx];
      const p = map.project([s.lon, s.lat]);
      drawPin(p.x * scale, p.y * scale, run.nums[run.idx], opts.dayColor(s.day_number), k, true, 1);
    }
    watermark();
    const now = performance.now();
    if (run.cap) caption(run.cap.stop, run.cap.n, clamp((now - run.cap.at) / 400, 0, 1) * (run.cap.out ? clamp(1 - (now - run.cap.out) / 300, 0, 1) : 1));
    if (run.card) {
      const t = now - run.card.at;
      const a = clamp(t / 500, 0, 1) * clamp((run.card.until - now) / 500, 0, 1);
      titleCard(a, run.card.big, run.card.sub, run.card.small);
    }
    // the progress line, along the bottom edge of the frame
    const prog = $('.fly-prog i');
    if (prog) prog.style.width = `${Math.round(clamp(run.progress || 0, 0, 1) * 100)}%`;
  }

  // ---------------------------------------------------------------- the flight

  // Waits on the clock, not on 'moveend': with terrain on, MapLibre fires stray
  // move events (its own terrain re-settling) that would end a leg the moment it
  // began. The camera move takes `duration`; a little slack lets it land.
  async function animate(kind, camera) {
    if (!run || run.stopped) return;
    map[kind]({ ...camera, essential: true });
    const until = performance.now() + (camera.duration || 1000);
    while (run && !run.stopped && performance.now() < until) await sleep(50);
    for (let i = 0; i < 10 && map.isEasing && map.isEasing(); i++) await sleep(40);
  }
  const fly = (camera) => animate('flyTo', camera);
  const ease = (camera) => animate('easeTo', camera);

  function boundsOf(stops) {
    const b = new maplibregl.LngLatBounds();
    stops.forEach((s) => b.extend([s.lon, s.lat]));
    return b;
  }

  // a flight that throws halfway must not leave the panel stuck on "בטיסה"
  async function play(record) {
    try { await flight(record); } catch (e) {
      console.error('trip-flyover: the flight failed', e);
      if (run) run.stopped = true;
      if (rec) await stopRecording(true);
      run = null;
      releaseWake();
      renderSetup('משהו השתבש באמצע הטיסה — נסו שוב');
    }
  }

  async function flight(record) {
    const plan = buildPlan();
    if (plan.stops.length < 2) { renderSetup('צריך לפחות שתי תחנות עם מיקום כדי לטוס ביניהן'); return; }
    const nums = plan.stops.map((s) => {
      const day = opts.items().filter((it) => it.day_number === s.day_number && it.lat != null && it.lon != null);
      return day.findIndex((x) => x.id === s.id) + 1;
    });
    run = { plan, nums, idx: -1, flying: null, frac: 0, cap: null, card: null, progress: 0, stopped: false };
    renderPlaying(record, plan.note);
    setTrail(plan, 0, 0);
    const over = boundsOf(plan.stops);
    const cam = map.cameraForBounds(over, { padding: Math.min(comp.width, comp.height) * 0.12 }) || { center: over.getCenter(), zoom: 10 };
    const introZoom = clamp((cam.zoom || 10) - 1.2, 2, 13);
    map.jumpTo({ center: cam.center, zoom: introZoom, pitch: 0, bearing: 0 });

    // warm the tiles first, so the film is not of tiles arriving: the opening shot
    // and (for a recording) every stop's close-up, once each, off camera
    setStatus('מכינים את המפה…');
    await idle(7000);
    if (record) {
      for (let i = 0; i < plan.stops.length && !run.stopped; i++) {
        setStatus(`מכינים את המפה · ${i + 1}/${plan.stops.length}`);
        const s = plan.stops[i];
        map.jumpTo({ center: [s.lon, s.lat], zoom: 15.6, pitch: 62, bearing: 0 });
        await idle(1600);
      }
      map.jumpTo({ center: cam.center, zoom: introZoom, pitch: 0, bearing: 0 });
      await idle(3000);
    }
    if (run.stopped) { run = null; renderSetup(); return; }
    if (record && !startRecording()) { record = false; }
    setStatus(record ? 'מקליטים — השאירו את המסך דלוק ואת הדף פתוח' : 'צפייה בלבד — שום דבר לא מוקלט');
    TRIPMAKER.track?.(record ? 'flyover_record' : 'flyover_play', { code: opts.trip.share_code, stops: plan.stops.length, path: plan.mode, aspect });

    const total = plan.stops.length + 2;
    // intro
    run.card = { big: `${opts.trip.title || 'הטיול'}`, sub: datesText(), small: `${plan.stops.length} תחנות · ${new Set(plan.stops.map((s) => s.day_number)).size} ימים`, at: performance.now(), until: performance.now() + 2800 };
    await ease({ zoom: introZoom + 0.6, bearing: -12, pitch: 25, duration: 2800, easing: (t) => t });
    run.card = null;
    let lastDay = null;
    for (let i = 0; i < plan.stops.length && !run.stopped; i++) {
      const s = plan.stops[i];
      const target = [s.lon, s.lat];
      const from = i ? [plan.stops[i - 1].lon, plan.stops[i - 1].lat] : null;
      const km = from ? metres(from, target) / 1000 : 5;
      let brg = map.getBearing();
      if (from) {
        const path = plan.legs[i];
        brg = bearing(path ? path[Math.max(0, path.length - 6)] : from, target);
      }
      if (run.cap) run.cap.out = performance.now();
      if (s.day_number !== lastDay && lastDay != null && !scope) {
        // a new day: its name over the flight
        run.card = { big: `יום ${s.day_number}`, sub: dayText(s.day_number).replace(/^יום \d+ · /, ''), at: performance.now(), until: performance.now() + 1700 };
      }
      lastDay = s.day_number;
      run.flying = i ? i : null;
      run.frac = 0;
      const duration = i ? legDuration(km, plan.speed) : 3200;
      await fly({ center: target, zoom: 15.6, pitch: 62, bearing: brg, duration, curve: km > 30 ? 1.8 : 1.3 });
      if (i) setTrail(plan, i, 1);
      run.flying = null;
      run.card = null;
      run.idx = i;
      run.cap = { stop: s, n: nums[i], at: performance.now() };
      run.progress = (i + 1) / total;
      await ease({ bearing: brg + 38, pitch: 64, duration: plan.dwell, easing: (t) => t });
    }
    if (!run.stopped) {
      // outro: up over everything, the whole route drawn
      if (run.cap) run.cap.out = performance.now();
      setTrail(plan, plan.stops.length, 1);
      run.idx = plan.stops.length; // no stop is "here" any more
      await fly({ center: cam.center, zoom: clamp((cam.zoom || 10) - 0.2, 2, 15), pitch: 35, bearing: 0, duration: 3000 });
      run.cap = null;
      run.card = { big: opts.trip.title || 'הטיול', sub: datesText(), small: 'נוצר ב-TRIP MAKER', at: performance.now(), until: performance.now() + 3200 };
      run.progress = 1;
      await ease({ bearing: 14, duration: 3000, easing: (t) => t });
    }
    const stopped = run.stopped;
    if (rec) await stopRecording(stopped);
    run = null;
    releaseWake();
    if (!stopped && result) renderDone();
    else renderSetup();
  }

  function stop() {
    if (!run) return;
    run.stopped = true;
    map?.stop();
  }

  // ---------------------------------------------------------------- recording

  function pickMime() {
    const list = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return list.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }
  const canRecord = () => typeof MediaRecorder !== 'undefined' && !!(comp && comp.captureStream);

  function startRecording() {
    try {
      const stream = comp.captureStream(FPS);
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(1000);
      rec = { recorder, chunks, mime: recorder.mimeType || mime || 'video/webm' };
      grabWake();
      return true;
    } catch (e) {
      console.warn('trip-flyover: recording failed to start', e);
      setStatus('הדפדפן הזה לא מקליט וידאו — הטיסה תוצג בלי הקלטה');
      return false;
    }
  }

  function stopRecording(discard) {
    return new Promise((res) => {
      const r = rec;
      rec = null;
      if (!r) return res();
      r.recorder.onstop = () => {
        if (!discard && r.chunks.length) {
          const type = r.mime.split(';')[0];
          const blob = new Blob(r.chunks, { type });
          const ext = type.includes('mp4') ? 'mp4' : 'webm';
          if (result) URL.revokeObjectURL(result.url);
          result = { blob, url: URL.createObjectURL(blob), name: `tripmaker-${opts.trip.share_code}-flyover.${ext}`, type };
        }
        res();
      };
      try { r.recorder.stop(); } catch { res(); }
    });
  }

  async function grabWake() {
    try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  }
  function releaseWake() {
    try { wake?.release(); } catch { /* gone */ }
    wake = null;
  }

  // a recording needs the page on screen: frames stop while it is hidden, and the
  // film would jump. Leaving the page stops the flight rather than ruin the video.
  function onVisibility() {
    if (document.hidden && run && rec) {
      stop();
      setTimeout(() => renderSetup('ההקלטה נעצרה כי יצאתם מהדף — כדי להקליט, השאירו את הדף פתוח עד הסוף'), 50);
    }
  }

  // ---------------------------------------------------------------- the panel

  function setStatus(msg) {
    const el = $('.fly-status');
    if (el) el.textContent = msg || '';
  }

  function daysWithStops() {
    const days = new Map();
    opts.items().forEach((it) => { if (it.lat != null && it.lon != null) days.set(it.day_number, (days.get(it.day_number) || 0) + 1); });
    return [...days.entries()].sort((a, b) => a[0] - b[0]);
  }

  function renderSetup(msg) {
    const panel = $('.fly-panel');
    if (!panel) return;
    const days = daysWithStops();
    const tl = timeline;
    const tlDays = tl ? new Set(tl.points.map((p) => new Date(p[0]).toDateString())).size : 0;
    const rOpt = (name, val, cur, label, sub, disabled) => `
      <label class="fly-opt${disabled ? ' off' : ''}"><input type="radio" name="${name}" value="${val}"${cur === val ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></label>`;
    panel.innerHTML = `
      <div class="fly-head">
        <h2>🎬 סרטון טיסה מעל הטיול</h2>
        <p>המצלמה טסה מתחנה לתחנה מעל מפה תלת־ממדית, והמסלול נמתח מאחוריה. אפשר לצפות, או להקליט סרטון ולשמור אותו.</p>
      </div>
      ${msg ? `<p class="fly-msg">${esc(msg)}</p>` : ''}
      <div class="fly-group">
        <div class="fly-label">מה מצלמים</div>
        <select class="fly-scope" aria-label="מה מצלמים">
          <option value="0"${!scope ? ' selected' : ''}>כל הטיול</option>
          ${days.filter(([, n]) => n >= 2).map(([d, n]) => `<option value="${d}"${scope === d ? ' selected' : ''}>${esc(dayText(d))} · ${n} תחנות</option>`).join('')}
        </select>
      </div>
      <div class="fly-group" role="radiogroup" aria-label="המסלול בסרטון">
        <div class="fly-label">המסלול</div>
        ${rOpt('path', 'timeline', pathMode, 'המסלול שעשיתם בפועל', tl ? `מציר הזמן של Google · ${tlDays} ימים, ${tl.points.length.toLocaleString('he-IL')} נקודות` : 'דורש ייבוא של ציר הזמן מ-Google Maps (למטה)', !tl)}
        ${rOpt('path', 'line', pathMode, 'קו ישר מתחנה לתחנה', 'לפי סדר התחנות במסלול')}
        ${rOpt('path', 'none', pathMode, 'בלי קו', 'רק טיסה מתחנה לתחנה')}
      </div>
      <details class="fly-tl"${tl ? '' : ' open'}>
        <summary>${tl ? '✓ ציר הזמן מיובא' : '📍 ייבוא ציר הזמן מ-Google Maps'}</summary>
        <div class="fly-tl-body">
          <p>Google העבירה את ציר הזמן לטלפון עצמו ב-2024, ואין יותר דרך לקרוא אותו מבחוץ — לא לנו ולא לאף אחד. אבל אפשר לייצא אותו מהטלפון ולבחור את הקובץ כאן:</p>
          <ul>
            <li><b>Android:</b> הגדרות → מיקום → שירותי מיקום → ציר הזמן → <i>ייצוא נתוני ציר הזמן</i></li>
            <li><b>iPhone:</b> Google Maps → התמונה שלכם → ציר הזמן → ⋯ → הגדרות מיקום ופרטיות → <i>ייצוא נתוני ציר הזמן</i></li>
          </ul>
          <p class="fly-fine">הקובץ (Timeline.json) נקרא במכשיר הזה בלבד ולא נשלח אלינו. נשמרים רק המיקומים מתאריכי הטיול, בדפדפן הזה. גם קבצי Takeout ישנים (Records.json, Semantic Location History) עובדים.</p>
          <div class="fly-tl-row">
            <label class="btn btn-ghost fly-file">${tl ? 'החלפת הקובץ' : 'בחירת קובץ'}<input type="file" accept=".json,application/json" multiple hidden></label>
            ${tl ? '<button type="button" class="btn btn-ghost fly-tl-del">מחיקה מהמכשיר</button>' : ''}
          </div>
          <p class="fly-tl-note" role="status"></p>
        </div>
      </details>
      <div class="fly-group">
        <div class="fly-label">צורה</div>
        <div class="fly-seg" role="radiogroup" aria-label="צורת הסרטון">
          <button type="button" data-aspect="wide" aria-pressed="${aspect === 'wide'}">▭ לרוחב</button>
          <button type="button" data-aspect="tall" aria-pressed="${aspect === 'tall'}">▯ לסטורי</button>
        </div>
      </div>
      <div class="fly-actions">
        <button type="button" class="btn btn-ghost fly-play">▶ צפייה</button>
        ${canRecord() ? '<button type="button" class="btn btn-amber fly-rec">● יצירת סרטון</button>' : ''}
      </div>
      ${canRecord() ? '' : '<p class="fly-fine">הדפדפן הזה לא יודע להקליט וידאו — אפשר לצפות בטיסה (ולהקליט את המסך מהטלפון).</p>'}
      ${result ? '<button type="button" class="fly-last">הסרטון האחרון שיצרתם ›</button>' : ''}`;
    panel.querySelector('.fly-scope').onchange = (e) => { scope = +e.target.value; };
    panel.querySelectorAll('input[name="path"]').forEach((r) => { r.onchange = () => { pathMode = r.value; }; });
    panel.querySelector('.fly-file input').onchange = (e) => { if (e.target.files.length) importFiles(e.target.files); };
    const del = panel.querySelector('.fly-tl-del');
    if (del) {
      del.onclick = () => {
        try { localStorage.removeItem(TL_KEY(opts.trip.share_code)); } catch { /* ignore */ }
        timeline = null;
        if (pathMode === 'timeline') pathMode = 'line';
        renderSetup('ציר הזמן נמחק מהמכשיר');
      };
    }
    panel.querySelectorAll('.fly-seg button').forEach((b) => {
      b.onclick = () => { aspect = b.dataset.aspect; root.dataset.aspect = aspect; sizeFrame(); renderSetup(); };
    });
    panel.querySelector('.fly-play').onclick = () => play(false);
    panel.querySelector('.fly-rec')?.addEventListener('click', () => play(true));
    panel.querySelector('.fly-last')?.addEventListener('click', renderDone);
  }

  function renderPlaying(record, note) {
    const panel = $('.fly-panel');
    panel.innerHTML = `
      <div class="fly-head"><h2>${record ? '● מקליטים' : '▶ בטיסה'}</h2></div>
      <p class="fly-status" role="status"></p>
      ${note ? `<p class="fly-msg">${esc(note)}</p>` : ''}
      <div class="fly-prog" aria-hidden="true"><i></i></div>
      <div class="fly-actions"><button type="button" class="btn btn-ghost fly-stop">■ עצירה</button></div>`;
    panel.querySelector('.fly-stop').onclick = stop;
  }

  function renderDone() {
    const panel = $('.fly-panel');
    if (!panel || !result) return;
    const file = new File([result.blob], result.name, { type: result.type });
    const share = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const mb = (result.blob.size / 1048576).toFixed(1);
    panel.innerHTML = `
      <div class="fly-head"><h2>✓ הסרטון מוכן</h2><p>${mb}MB · ${result.type.includes('mp4') ? 'MP4' : 'WebM'}</p></div>
      <video class="fly-video" src="${result.url}" controls playsinline loop></video>
      <div class="fly-actions">
        <a class="btn btn-amber" href="${result.url}" download="${esc(result.name)}">הורדה</a>
        ${share ? '<button type="button" class="btn btn-ghost fly-share">שיתוף</button>' : ''}
      </div>
      <button type="button" class="fly-last fly-again">‹ חזרה להגדרות</button>`;
    panel.querySelector('.fly-again').onclick = () => renderSetup();
    panel.querySelector('.fly-share')?.addEventListener('click', async () => {
      try { await navigator.share({ files: [file], title: opts.trip.title || 'TRIP MAKER' }); } catch { /* cancelled */ }
    });
    TRIPMAKER.track?.('flyover_saved', { code: opts.trip.share_code, mb: +mb, type: result.type });
  }

  // ---------------------------------------------------------------- open / close

  function onKey(e) { if (e.key === 'Escape' && root) { e.stopPropagation(); close(); } }
  function onPop() { if (root && !(history.state && history.state.tripmakerFly)) teardown(); }
  function onResize() { sizeFrame(); }

  async function open(o) {
    if (root) return;
    opts = o;
    scope = 0;
    timeline = loadStoredTimeline();
    if (pathMode === 'timeline' && !timeline) pathMode = 'line';
    const css = getComputedStyle(document.body);
    const body = css.getPropertyValue('--font-body').trim();
    const display = css.getPropertyValue('--font-display').trim();
    if (body) fonts.body = body;
    if (display) fonts.display = display;
    root = document.createElement('div');
    root.className = 'fly-root';
    root.dataset.aspect = aspect;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'סרטון טיסה מעל הטיול');
    root.innerHTML = `
      <div class="fly-stage"><div class="fly-frame"><div class="fly-map"></div><canvas class="fly-comp"></canvas></div></div>
      <aside class="fly-panel"></aside>
      <button type="button" class="fly-close" aria-label="סגירה">✕</button>`;
    document.body.appendChild(root);
    document.documentElement.classList.add('fly-open');
    history.pushState({ tripmakerFly: 1 }, '', location.href);
    window.addEventListener('popstate', onPop);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
    root.querySelector('.fly-close').onclick = close;
    comp = root.querySelector('.fly-comp');
    cx = comp.getContext('2d');
    renderSetup();
    sizeFrame();
    try { await document.fonts?.load(`400 30px ${fonts.display}`); await document.fonts?.load(`700 20px ${fonts.body}`); } catch { /* the fallback fonts draw too */ }
    try {
      await makeMap();
    } catch (e) {
      console.warn('trip-flyover: map failed', e);
      renderSetup('המפה התלת־ממדית לא עלתה במכשיר הזה (WebGL כבוי או לא נתמך)');
      root.querySelectorAll('.fly-play, .fly-rec').forEach((b) => { b.disabled = true; });
      return;
    }
    sizeFrame();
    const stops = scopeStops();
    if (stops.length) {
      const b = boundsOf(stops);
      const cam = map.cameraForBounds(b, { padding: 60 });
      if (cam) map.jumpTo({ ...cam, pitch: 45, bearing: -15 });
    }
    raf = requestAnimationFrame(frame);
    TRIPMAKER.track?.('flyover_open', { code: opts.trip.share_code, timeline: !!timeline });
  }

  function close() {
    if (!root) return;
    if (history.state && history.state.tripmakerFly) history.back(); // onPop tears down
    else teardown();
  }

  function teardown() {
    if (run) stop();
    if (rec) stopRecording(true);
    releaseWake();
    cancelAnimationFrame(raf);
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
    try { map?.remove(); } catch { /* already gone */ }
    map = null;
    root?.remove();
    root = null;
    comp = null;
    document.documentElement.classList.remove('fly-open');
  }

  // parseTimeline is exposed for tools/flyover-check.js
  return { open, close, parseTimeline };
})();
if (typeof module === 'object' && module.exports) module.exports = TripFlyover;
