// The trip, flown over in 3D — and saved as a video to keep or send.
//
// For a trip that has started (trip-map.js offers it from the full-page map): a short
// film, vertical for a story by default. It opens high over the whole trip with its
// name, dives to the first stop, and then rides the road stop by stop — a marker on
// the tip of a line that draws itself, the camera following behind it and turning
// with the road, pulling out over a long drive and leaning in as it lands. Each stop
// gets a pin that grows out of the ground with its name on a card; a small dashboard
// counts the kilometres, the altitude under the marker and the hour. It ends pulled
// back over the whole route, slowly circling, with the trip's totals.
//
// The film is a script, not a live flight: every frame's camera (centre, zoom, pitch,
// bearing) and every overlay is computed up front from the stops (buildFrames), the
// bearing smoothed so the camera never snaps. That is what makes the two ways out
// possible:
//   · watching plays the script by the clock (tiles may still be arriving);
//   · "יצירת סרטון" renders it frame by frame — move the camera, wait until every tile
//     is drawn, composite, hand the frame to the device's own H.264 encoder
//     (WebCodecs) and mux an MP4 (mp4-muxer, vendored, loaded only then). No
//     half-loaded tiles and no stutter, whatever the phone or the network — it simply
//     takes longer than the film. Where WebCodecs is missing (older Firefox/Safari)
//     the old way stays: MediaRecorder on the canvas while it plays in real time.
//
// What is on screen is what is recorded: the map is drawn by MapLibre (vendored,
// loaded only when this opens) and every frame is composited onto a second canvas
// together with the pins, the cards and the dashboard — DOM markers and HTML would
// not be in the video. Hebrew is drawn by the canvas itself (RTL).
//
// Sources, keyless like the 2D map (PLAYBOOK §2):
//   · the ground: Sentinel-2 cloudless **2016** by EOX — one mosaic at every zoom, so
//     no colour seams across a tilted frame and no popping when the zoom level
//     changes. Only the 2016 (and 2017) layers are CC BY 4.0; 2018+ are CC BY-NC-SA,
//     which a commercial app may not use without buying EOX's licence — don't "upgrade"
//     the year without that. It is 10 m imagery: soft up close, so Esri World Imagery
//     stays for streets (crisp, but a different picture per zoom). "אוטומטי" picks by
//     the trip: mostly walks → Esri, drives/hikes/flights → Sentinel (groundFor).
//   · relief: the Terrarium elevation tiles AWS hosts as open data.
//   · roads: OSRM on routing.openstreetmap.de (FOSSGIS) — foot for short hops, car
//     for the rest, one request per run of legs; a leg it can't route is a straight
//     line, and a leg too long to drive is a dashed arc (a flight).
// The imagery failing before its first tile falls back to OSM streets, loudly
// (console.warn) — the same rule as trip-map.js.
//
// The path. "The path you actually went" lives in Google Maps Timeline, which Google
// moved onto the phone in 2024–25: there is no API that reads it any more, for us or
// anyone. What a traveller CAN do is export it from the Maps app (a Timeline.json
// file — the older Takeout files work too) and hand it to this page. The file is read
// here, on the device, cut down to the trip's own dates, and kept in this browser
// only; nothing of it is sent to the server (the same rule as the documents page).
// With it, each stop the traveller really reached is found in the timeline and the
// flight follows the recorded track between them. Without it the film follows the
// roads between the stops (or straight lines, or no line, as the traveller picks).
const TripFlyover = (() => {
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const TILE = {
    s2: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
    sat: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
    osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    dem: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  };
  const ROUTER = {
    foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
    car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
  };
  const CREDIT = {
    s2: 'Imagery: Sentinel-2 cloudless by EOX (Copernicus data 2016) · Terrain: AWS Terrain Tiles',
    esri: 'Imagery © Esri · Terrain: AWS Terrain Tiles',
    osm: 'Map © OpenStreetMap contributors · Terrain: AWS Terrain Tiles',
  };
  // what the viewer plays at, and what a rendered film is made at (WebCodecs)
  const VIEW = { wide: [1280, 720], tall: [720, 1280] };
  const FILM = { wide: [1920, 1080], tall: [1080, 1920] };
  const FPS = 30;
  const EXAG = 1.25;              // terrain exaggeration — the altitude readout divides it back out
  const MAX_STOPS = 45;           // past this the video samples the stops — a 90-stop film is a chore
  const MATCH_M = 300;            // how near the timeline must come for a stop to count as reached
  const FOOT_KM = 3.5;            // a hop shorter than this is walked; longer is driven
  const DRIVE_KM = 450;           // and longer than this was flown
  const TL_KEY = (code) => `tripmaker_timeline_${code}`;
  const PREF_KEY = 'tripmaker_flyover_prefs';

  const esc = (s) => TRIPMAKER.esc(s);
  const $ = (sel) => root && root.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }; // quintic
  const bump = (t) => Math.sin(Math.PI * clamp(t, 0, 1)) ** 2;   // 0 → 1 → 0, flat at both ends
  const backOut = (t) => { t = clamp(t, 0, 1); const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
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
  const turn = (from, to) => ((((to - from) % 360) + 540) % 360) - 180; // the short way round

  let root = null;
  let opts = null;
  let map = null;
  let comp = null;      // the composite canvas — the video
  let cx = null;
  let raf = 0;
  let aspect = 'tall';
  let imagery = 'auto';  // what the traveller picked: 'auto' | 's2' | 'esri'
  let ground = 'esri';   // what is on the map now: 's2' | 'esri'
  let pathMode = 'road'; // 'road' | 'line' | 'none' | 'timeline'
  let scope = 0;         // 0 = the whole trip, else one day
  let timeline = null;   // { points: [[t, lat, lon]], at, files }
  let run = null;        // the film in progress: { plan, film, cur, ... }
  let rec = null;        // { recorder, chunks, mime } — the real-time fallback
  let result = null;     // { url, blob, name, type }
  let wake = null;
  let satLoaded = false;
  let satErrors = 0;
  let fellBack = false;
  let fonts = { body: 'Assistant, sans-serif', display: '"Suez One", serif' };
  let lineK = 1;         // line widths scale with the frame, so the video looks the same on any screen

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (p.aspect === 'wide' || p.aspect === 'tall') aspect = p.aspect;
      if (['auto', 's2', 'esri'].includes(p.imagery)) imagery = p.imagery;
    } catch { /* defaults */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ aspect, imagery })); } catch { /* fine */ }
  }

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
  // a flight: the great circle, sampled
  function arc(a, b, n = 64) {
    const [l1, p1] = [a[0] * rad, a[1] * rad];
    const [l2, p2] = [b[0] * rad, b[1] * rad];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
    if (!d) return [a, b];
    return Array.from({ length: n + 1 }, (_, i) => {
      const f = i / n;
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      const z = A * Math.sin(p1) + B * Math.sin(p2);
      return [Math.atan2(y, x) / rad, Math.atan2(z, Math.sqrt(x * x + y * y)) / rad];
    });
  }

  // no two points closer than `step` metres — the drawn line is cut every frame
  function thin(path, step) {
    if (path.length < 3) return path;
    const out = [path[0]];
    for (let j = 1; j < path.length - 1; j++) if (metres(out[out.length - 1], path[j]) >= step) out.push(path[j]);
    out.push(path[path.length - 1]);
    return out;
  }

  // One OSRM request for a run of consecutive legs, split back into legs at the
  // snapped waypoints. Cached for the visit; a failure is null (the legs go straight).
  const routeCache = new Map();
  function route(profile, pts) {
    const chain = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
    const key = `${profile}|${chain}`;
    if (routeCache.has(key)) return routeCache.get(key);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const p = fetch(`${ROUTER[profile]}${chain}?overview=full&geometries=geojson`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const coords = j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
        if (!coords || !j.waypoints || j.waypoints.length !== pts.length) return null;
        const legs = [];
        let from = 0;
        for (let w = 1; w < pts.length; w++) {
          const goal = j.waypoints[w].location;
          let best = from;
          let bestD = Infinity;
          for (let k = from; k < coords.length; k++) {
            const d = Math.abs(coords[k][0] - goal[0]) + Math.abs(coords[k][1] - goal[1]);
            if (d < bestD) { bestD = d; best = k; }
            if (d === 0) break;
          }
          legs.push(coords.slice(from, best + 1));
          from = best;
        }
        return legs;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    p.then((v) => { if (!v) routeCache.delete(key); });
    routeCache.set(key, p);
    return p;
  }

  async function roadLegs(stops, kinds, legs) {
    // runs of consecutive legs of the same kind, at most 24 legs a request
    const runs = [];
    for (let i = 1; i < stops.length; i++) {
      const k = kinds[i];
      if (k === 'fly') continue;
      const last = runs[runs.length - 1];
      if (last && last.kind === k && last.to === i - 1 && last.to - last.from < 24) last.to = i;
      else runs.push({ kind: k, from: i - 1, to: i });
    }
    await Promise.all(runs.map(async (r) => {
      const pts = stops.slice(r.from, r.to + 1).map((s) => [s.lon, s.lat]);
      const got = await route(r.kind, pts);
      if (!got) return;
      got.forEach((path, j) => {
        const i = r.from + j + 1;
        const a = [stops[i - 1].lon, stops[i - 1].lat];
        const b = [stops[i].lon, stops[i].lat];
        const full = [a, ...path, b];
        let len = 0;
        for (let q = 1; q < full.length; q++) len += metres(full[q - 1], full[q]);
        // a road five times the crow's flight is OSRM snapping to the wrong bank
        if (len > metres(a, b) * 5 + 3000) return;
        legs[i] = thin(full, r.kind === 'foot' ? 8 : Math.max(25, len / 500));
      });
    }));
  }

  async function buildPlan() {
    let stops = scopeStops();
    let mode = pathMode;
    let note = '';
    const legs = [];  // legs[i]: the path into stop i (i ≥ 1), lon/lat pairs
    const kindOf = (a, b) => {
      const km = metres([a.lon, a.lat], [b.lon, b.lat]) / 1000;
      return km < FOOT_KM ? 'foot' : km < DRIVE_KM ? 'car' : 'fly';
    };
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
        mode = 'road';
        note = 'ציר הזמן לא עבר ליד תחנות הטיול — הסרטון נוסע בדרכים';
      }
    }
    const kinds = stops.map((s, i) => (i ? kindOf(stops[i - 1], s) : null));
    if (mode === 'road') {
      setStatus('מחפשים את הדרכים בין התחנות…');
      await roadLegs(stops, kinds, legs);
      const missing = kinds.filter((k, i) => i && k !== 'fly' && !legs[i]).length;
      if (missing) note = note || `${missing === kinds.length - 1 ? 'לא מצאנו דרכים בין התחנות' : `ל-${missing} קטעים לא מצאנו דרך`} — שם הקו ישר`;
    }
    stops.forEach((s, i) => {
      if (!i || legs[i]) return;
      const a = [stops[i - 1].lon, stops[i - 1].lat];
      const b = [s.lon, s.lat];
      legs[i] = kinds[i] === 'fly' ? arc(a, b) : straight(a, b);
    });
    // cumulative lengths, so "how far along the leg" can cut the path at a distance
    const cum = legs.map((path) => {
      if (!path) return null;
      const c = [0];
      for (let j = 1; j < path.length; j++) c.push(c[j - 1] + metres(path[j - 1], path[j]));
      return c;
    });
    const len = cum.map((c) => (c ? c[c.length - 1] : 0));
    return { stops, legs, cum, len, kinds, mode, note, drawLine: mode !== 'none' };
  }

  // where along leg i the marker is at `d` metres, and the path drawn up to there
  function pointAt(plan, i, d) {
    const path = plan.legs[i];
    const cum = plan.cum[i];
    if (d <= 0) return path[0];
    for (let j = 1; j < path.length; j++) {
      if (cum[j] < d) continue;
      const t = (d - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
      return [lerp(path[j - 1][0], path[j][0], t), lerp(path[j - 1][1], path[j][1], t)];
    }
    return path[path.length - 1];
  }
  function sliceTo(plan, i, d) {
    const path = plan.legs[i];
    const cum = plan.cum[i];
    const out = [path[0]];
    for (let j = 1; j < path.length && cum[j] < d; j++) out.push(path[j]);
    out.push(pointAt(plan, i, d));
    return out;
  }
  // the way the road runs at `d`: from a little behind to a little ahead
  function bearingAt(plan, i, d) {
    const w = clamp(plan.len[i] * 0.12, 40, 4000);
    const a = pointAt(plan, i, clamp(d - w, 0, plan.len[i]));
    const b = pointAt(plan, i, clamp(d + w, 0, plan.len[i]));
    return metres(a, b) < 1 ? null : bearing(a, b);
  }

  // ---------------------------------------------------------------- the map

  const EMPTY = { type: 'FeatureCollection', features: [] };

  function style() {
    const raster = { 'raster-saturation': 0.15, 'raster-contrast': 0.08, 'raster-fade-duration': 0 };
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    const show = (on) => ({ visibility: on ? 'visible' : 'none' });
    return {
      version: 8,
      sources: {
        s2: { type: 'raster', tiles: [TILE.s2], tileSize: 256, maxzoom: 15 },
        sat: { type: 'raster', tiles: [TILE.sat], tileSize: 256, maxzoom: 19 },
        labels: { type: 'raster', tiles: [TILE.labels], tileSize: 256, maxzoom: 19 },
        osm: { type: 'raster', tiles: [TILE.osm], tileSize: 256, maxzoom: 19 },
        dem: { type: 'raster-dem', tiles: [TILE.dem], tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
        ghost: { type: 'geojson', data: EMPTY },
        trail: { type: 'geojson', data: EMPTY },
        marker: { type: 'geojson', data: EMPTY },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#33402f' } }, // ground-ish, for a tile that never came
        // the fallback sits hidden under the imagery — a hidden layer's tiles are never fetched
        { id: 'osm', type: 'raster', source: 'osm', layout: show(false), paint: { 'raster-fade-duration': 0 } },
        { id: 's2', type: 'raster', source: 's2', layout: show(ground === 's2'), paint: raster },
        { id: 'sat', type: 'raster', source: 'sat', layout: show(ground === 'esri'), paint: raster },
        { id: 'labels', type: 'raster', source: 'labels', layout: show(ground === 'esri'), paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 } },
        // the whole way, faint, so the eye knows where the line is going
        { id: 'ghost', type: 'line', source: 'ghost', layout: round,
          paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 1.4, 'line-dasharray': [2, 2] } },
        { id: 'trail-glow', type: 'line', source: 'trail', layout: round,
          paint: { 'line-color': ['get', 'color'], 'line-width': 11, 'line-blur': 6, 'line-opacity': 0.7 } },
        // walked: a solid road in the day's colour with a bright core
        { id: 'trail-foot', type: 'line', source: 'trail', layout: round, filter: ['==', ['get', 'kind'], 'foot'],
          paint: { 'line-color': ['get', 'color'], 'line-width': 4 } },
        { id: 'trail-core', type: 'line', source: 'trail', layout: round, filter: ['==', ['get', 'kind'], 'foot'],
          paint: { 'line-color': '#fffaf0', 'line-width': 1.2, 'line-opacity': 0.75 } },
        // driven or flown: white dashes over the day's glow
        { id: 'trail-ride', type: 'line', source: 'trail', layout: { 'line-join': 'round' }, filter: ['!=', ['get', 'kind'], 'foot'],
          paint: { 'line-color': '#ffffff', 'line-width': 2.6, 'line-dasharray': [1.6, 1.2] } },
        { id: 'marker-glow', type: 'circle', source: 'marker',
          paint: { 'circle-radius': 9, 'circle-color': '#ffffff', 'circle-opacity': 0.35, 'circle-blur': 0.8, 'circle-pitch-alignment': 'map' } },
        { id: 'marker', type: 'circle', source: 'marker',
          paint: { 'circle-radius': 3.6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map' } },
      ],
      terrain: { source: 'dem', exaggeration: EXAG },
      sky: {
        'sky-color': '#6f9fd8', 'horizon-color': '#f3e2cf', 'fog-color': '#e9eef4',
        'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.55, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0.8,
      },
    };
  }

  // widths are CSS pixels of the frame; the film is the frame scaled up, so a line
  // is as thick in the video whether the frame was 260 or 900 pixels on screen
  const WIDTHS = [
    ['ghost', 'line-width', 1.4], ['trail-glow', 'line-width', 11], ['trail-glow', 'line-blur', 6],
    ['trail-foot', 'line-width', 4], ['trail-core', 'line-width', 1.2], ['trail-ride', 'line-width', 2.6],
    ['marker-glow', 'circle-radius', 9], ['marker', 'circle-radius', 3.6], ['marker', 'circle-stroke-width', 1.5],
  ];
  function scaleLines() {
    if (!map || !map.isStyleLoaded()) return;
    WIDTHS.forEach(([layer, prop, v]) => map.setPaintProperty(layer, prop, v * lineK));
  }

  // 'auto': a trip that stays inside one city (its stops within ~20 km) is about
  // streets seen up close, where Esri is sharp and Sentinel is mush; a trip that
  // drives, hikes across valleys or flies is about the land, where one seamless
  // mosaic looks like a film.
  function groundFor(stops) {
    if (imagery !== 'auto') return imagery;
    if (stops.length < 2) return 'esri';
    const lon = stops.map((s) => s.lon);
    const lat = stops.map((s) => s.lat);
    const span = metres([Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]);
    return span < 20000 ? 'esri' : 's2';
  }
  function setGround(which) {
    if (which === ground) return;
    ground = which;
    if (!map || fellBack) return;
    map.setLayoutProperty('s2', 'visibility', which === 's2' ? 'visible' : 'none');
    map.setLayoutProperty('sat', 'visibility', which === 'esri' ? 'visible' : 'none');
    map.setLayoutProperty('labels', 'visibility', which === 'esri' ? 'visible' : 'none');
    satLoaded = false; satErrors = 0;
  }
  const credit = () => CREDIT[fellBack ? 'osm' : ground];
  const closeZoom = () => (ground === 's2' && !fellBack ? 13.7 : 15.2); // the close-up at a stop

  function makeMap() {
    const box = $('.fly-map');
    const first = scopeStops()[0] || opts.items().find((i) => i.lon != null) || { lon: 0, lat: 0 };
    map = new maplibregl.Map({
      container: box,
      style: style(),
      center: [first.lon, first.lat],
      zoom: 3,
      pitch: 0,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      maxPitch: 75,
      pixelRatio: Math.max(1, VIEW[aspect][0] / (box.clientWidth || VIEW[aspect][0])),
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    satLoaded = false; satErrors = 0; fellBack = false;
    const groundSource = () => (ground === 's2' ? 's2' : 'sat');
    map.on('sourcedata', (e) => { if (e.sourceId === groundSource() && e.tile) satLoaded = true; });
    map.on('error', (e) => {
      if (e.sourceId !== groundSource() || satLoaded || fellBack) return;
      if (++satErrors === 4) {
        console.warn(`trip-flyover: ${ground === 's2' ? 'EOX Sentinel-2' : 'Esri'} imagery is failing — falling back to OpenStreetMap streets`);
        // a layer swap, not setTiles: reloading a raster source under terrain throws in MapLibre 5
        ['s2', 'sat', 'labels'].forEach((l) => map.setLayoutProperty(l, 'visibility', 'none'));
        map.setLayoutProperty('osm', 'visibility', 'visible');
        fellBack = true;
      }
    });
    map.on('render', onMapRender);
    return new Promise((res, rej) => {
      map.once('load', () => { scaleLines(); res(); });
      setTimeout(() => rej(new Error('load timeout')), 20000);
    });
  }

  // fit the frame to the stage at the aspect, and the composite to `size` pixels
  function sizeFrame(size) {
    const stage = $('.fly-stage');
    const frame = $('.fly-frame');
    if (!stage || !frame) return;
    const [w, h] = size || VIEW[aspect];
    const [vw, vh] = VIEW[aspect];
    const cs = getComputedStyle(stage);
    const sw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const sh = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const k = Math.min(sw / vw, sh / vh);
    frame.style.width = `${Math.floor(vw * k)}px`;
    frame.style.height = `${Math.floor(vh * k)}px`;
    comp.width = w; comp.height = h;
    lineK = Math.min(frame.clientWidth, frame.clientHeight) / 360 || 1;
    if (map) {
      map.resize();
      map.setPixelRatio(Math.max(1, w / (frame.clientWidth || w)));
      scaleLines();
    }
  }

  // Every tile for this camera drawn: 'idle' fires after a render with nothing left
  // to load. The repaint makes sure a render happens even when the camera stood still.
  function settled(cap = 8000) {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(timer); map.off('idle', fin); res(); };
      const timer = setTimeout(fin, cap);
      map.once('idle', fin);
      map.triggerRepaint();
    });
  }

  // ---------------------------------------------------------------- the script

  const P = (s) => [s.lon, s.lat];
  const lerpLL = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  // How far the centre has travelled when the zoom has gone from z0 to z: in step
  // with the scale, so the ground slides past at an even speed while the camera dives
  // or climbs, instead of rushing at the end (what flyTo does for the same reason).
  const along = (z0, z1, z, u) => (Math.abs(z1 - z0) < 0.05 ? smooth(u) : (2 ** (z0 - z) - 1) / (2 ** (z0 - z1) - 1));

  function fitOf(points, padFrac = 0.16) {
    const b = new maplibregl.LngLatBounds();
    points.forEach((p) => b.extend(p));
    const frame = $('.fly-frame');
    const pad = Math.min(frame.clientWidth, frame.clientHeight) * padFrac;
    let cam = null;
    try { cam = map.cameraForBounds(b, { padding: pad }); } catch { cam = null; }
    return { center: b.getCenter().toArray(), zoom: cam && Number.isFinite(cam.zoom) ? cam.zoom : 10 };
  }

  // The whole film as one frame per 1/30 s: camera and what is on screen. Lengths
  // come from the number of stops (a story is about a minute, whatever the trip),
  // drives and flights taking longer than walks.
  function buildFrames(plan) {
    const n = plan.stops.length;
    const Zs = closeZoom();             // the close-up at a stop
    const all = fitOf(plan.legs.flatMap((l) => l || []).concat(plan.stops.map(P)));
    all.zoom = Math.min(all.zoom, Zs - 0.6);
    const zStart = clamp(Math.min(all.zoom - 2.6, 6.5), 1.5, 8);
    const per = clamp(62 / n, 1.7, 6.5);
    const weight = { foot: 1, car: 1.3, fly: 1.6 };
    const segs = [];
    let f = 0;
    const add = (kind, secs, extra) => {
      const len = Math.max(2, Math.round(secs * FPS));
      segs.push({ kind, f0: f, f1: f + len, ...extra });
      f += len;
    };
    add('intro', 6);
    plan.stops.forEach((s, i) => {
      if (i) add('leg', per * 0.6 * weight[plan.kinds[i]], { i, newDay: !scope && s.day_number !== plan.stops[i - 1].day_number });
      add('stop', Math.max(1.2, per * 0.4) + (i === n - 1 ? 0.5 : 0), { i });
    });
    add('outro', 6.5);

    const legFit = plan.legs.map((l) => (l ? fitOf(l, 0.22) : null));
    const frames = new Array(f);
    let b = 0;        // the bearing the camera has
    let target = 0;   // the bearing it is turning toward — 6% of the way each frame
    let km = 0;       // the road behind the marker, legs already done
    segs.forEach((seg, si) => {
      const len = seg.f1 - seg.f0;
      const hold = target;
      for (let q = 0; q < len; q++) {
        const u = len > 1 ? q / (len - 1) : 1;
        const fr = { si, u, c: null, z: 0, p: 0, b: 0, leg: null, d: 0, km };
        if (seg.kind === 'intro') {
          // hang over the whole trip under the title, then dive to the first stop,
          // tilting up and turning in the second half
          const v = smooth((u - 0.22) / 0.78);
          fr.z = lerp(zStart, Zs, v);
          fr.c = lerpLL(all.center, P(plan.stops[0]), along(zStart, Zs, fr.z, v));
          const tilt = smooth((v - 0.45) / 0.55);
          fr.p = 52 * tilt;
          b = target = -20 * tilt;
        } else if (seg.kind === 'leg') {
          const i = seg.i;
          const L = plan.len[i];
          const kind = plan.kinds[i];
          const d = L * smooth(u);
          const m = pointAt(plan, i, d);
          const lf = legFit[i];
          const zMid = Math.min(Zs - (kind === 'foot' ? 0.6 : 0.9), lf.zoom);
          const w = bump(u);
          fr.z = lerp(Zs, zMid, w);
          // the centre leaves the marker for the middle of the leg as the camera pulls out
          fr.c = lerpLL(m, lerpLL(lf.center, m, 0.5), w * (kind === 'foot' ? 0.35 : 1));
          // low enough that a valley's walls don't hide the road (higher pitch, more wall)
          fr.p = kind === 'fly' ? lerp(52, 32, w) : kind === 'car' ? 52 + 6 * w : 52;
          const brg = kind === 'fly' ? bearing(plan.legs[i][0], plan.legs[i][plan.legs[i].length - 1]) : bearingAt(plan, i, d);
          if (brg != null) target = b + turn(b, brg);
          fr.leg = i; fr.d = d; fr.km = km + d;
          if (q === len - 1) km += L;
        } else if (seg.kind === 'stop') {
          fr.c = P(plan.stops[seg.i]);
          fr.z = Zs + 0.3 * bump(u);
          fr.p = 52 + 3 * bump(u);
          target = hold + 18 * u; // a slow turn around the stop
          fr.km = km;
        } else {
          // up and away over the whole route, circling
          const v = smooth(u * 1.25);
          fr.z = lerp(Zs, all.zoom, v);
          fr.c = lerpLL(P(plan.stops[n - 1]), all.center, along(Zs, all.zoom, fr.z, v));
          fr.p = lerp(52, 46, v);
          target = hold + 30 * u;
          fr.km = km;
        }
        if (seg.kind !== 'intro') b += turn(b, target) * 0.06;
        fr.b = b;
        frames[seg.f0 + q] = fr;
      }
    });
    return { frames, segs, totalKm: km / 1000 };
  }

  // ---------------------------------------------------------------- one frame

  function legFeature(plan, i, coords) {
    return { type: 'Feature', properties: { color: opts.dayColor(plan.stops[i].day_number), kind: plan.kinds[i] === 'foot' ? 'foot' : 'ride' }, geometry: { type: 'LineString', coordinates: coords } };
  }

  // move the camera and the drawn line to frame `k`
  function applyFrame(k) {
    const { plan, film } = run;
    const fr = film.frames[k];
    const seg = film.segs[fr.si];
    run.cur = k;
    map.jumpTo({ center: fr.c, zoom: fr.z, pitch: fr.p, bearing: fr.b });
    // legs before this one are done; this one is drawn up to the marker
    const done = seg.kind === 'leg' ? seg.i - 1 : seg.kind === 'stop' ? seg.i : seg.kind === 'outro' ? plan.stops.length - 1 : 0;
    const features = [];
    if (plan.drawLine) {
      for (let i = 1; i <= done; i++) features.push(legFeature(plan, i, plan.legs[i]));
      if (seg.kind === 'leg' && fr.d > 0) features.push(legFeature(plan, seg.i, sliceTo(plan, seg.i, fr.d)));
    }
    map.getSource('trail').setData({ type: 'FeatureCollection', features });
    let mk = null;
    if (seg.kind === 'leg') mk = { at: pointAt(plan, seg.i, fr.d), day: plan.stops[seg.i].day_number };
    map.getSource('marker').setData(mk ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { color: opts.dayColor(mk.day) }, geometry: { type: 'Point', coordinates: mk.at } }] } : EMPTY);
  }

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
  function fit(text, weight, size, family, maxW, min) {
    let s = size;
    cx.font = `${weight} ${s}px ${family}`;
    while (cx.measureText(text).width > maxW && s > min) { s -= 1; cx.font = `${weight} ${s}px ${family}`; }
    return s;
  }
  function spaced(px) { try { cx.letterSpacing = `${px}px`; } catch { /* older canvas: no spacing */ } }

  // a stop already passed (or still ahead, fainter): a dot in the day's colour with its number
  function dot(x, y, n, color, k, alpha) {
    cx.save();
    cx.globalAlpha = alpha;
    const r = 11 * k;
    cx.shadowColor = 'rgba(0,0,0,.5)';
    cx.shadowBlur = 8 * k;
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fillStyle = color;
    cx.fill();
    cx.shadowColor = 'transparent';
    cx.lineWidth = 2.5 * k;
    cx.strokeStyle = '#fff';
    cx.stroke();
    cx.fillStyle = '#241302';
    cx.font = `800 ${Math.round(11 * k)}px ${fonts.body}`;
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.direction = 'ltr';
    cx.fillText(String(n), x, y + 0.5 * k);
    cx.restore();
  }

  // The stop being visited: a white stem grows out of the ground (overshooting a
  // little), a dot with a ring at its foot, two rings pulsing out, and a card on top
  // with the stop's name, its hour and what it is. `age` is seconds since it landed.
  function bigPin(x, y, stop, n, k, age, fade) {
    const color = opts.dayColor(stop.day_number);
    const grow = backOut(age / 0.55);
    const stem = 92 * k * grow;
    cx.save();
    cx.globalAlpha = fade;
    for (let r = 0; r < 2; r++) {
      const p = ((age + r * 0.7) % 1.4) / 1.4;
      cx.beginPath();
      cx.ellipse(x, y, (10 + p * 46) * k, (10 + p * 46) * k * 0.55, 0, 0, Math.PI * 2);
      cx.strokeStyle = `rgba(255,255,255,${0.75 * (1 - p)})`;
      cx.lineWidth = 2.5 * k;
      cx.stroke();
    }
    if (stem > 1) {
      const g = cx.createLinearGradient(0, y, 0, y - stem);
      g.addColorStop(0, 'rgba(255,255,255,.95)');
      g.addColorStop(1, 'rgba(255,255,255,.55)');
      cx.fillStyle = g;
      cx.fillRect(x - 1.6 * k, y - stem, 3.2 * k, stem);
    }
    cx.shadowColor = 'rgba(0,0,0,.5)';
    cx.shadowBlur = 10 * k;
    cx.beginPath();
    cx.arc(x, y, 9 * k * Math.min(1, grow * 1.4), 0, Math.PI * 2);
    cx.fillStyle = color;
    cx.fill();
    cx.shadowColor = 'transparent';
    cx.lineWidth = 3.5 * k;
    cx.strokeStyle = '#fff';
    cx.stroke();
    // the card
    const a = clamp((age - 0.3) / 0.35, 0, 1);
    if (a > 0) {
      const W = comp.width;
      const title = stop.title || '';
      const meta = [stop.time_label, `${opts.stopEmoji(stop)} ${stop.category || ''}`.trim()].filter(Boolean).join(' · ');
      const head = `${dayLabel(stop.day_number)} · תחנה ${n}`;
      const pad = 16 * k;
      cx.direction = 'rtl';
      cx.textAlign = 'right';
      cx.textBaseline = 'alphabetic';
      const ts = fit(title, 400, 34 * k, fonts.display, W * 0.78 - 2 * pad, 18 * k);
      const tw = cx.measureText(title).width;
      cx.font = `700 ${15 * k}px ${fonts.body}`;
      const hw = cx.measureText(head).width;
      cx.font = `600 ${15 * k}px ${fonts.body}`;
      const mw = meta ? cx.measureText(meta).width : 0;
      const bw = Math.min(Math.max(tw, hw, mw) + 2 * pad + 8 * k, W * 0.86);
      const bh = pad * 2 + 18 * k + ts * 1.1 + (meta ? 24 * k : 0);
      const bx = clamp(x - bw / 2, 14 * k, W - 14 * k - bw);
      const by = y - stem - bh - 8 * k + (1 - a) * 14 * k;
      cx.globalAlpha = fade * a;
      roundRect(bx, by, bw, bh, 18 * k);
      cx.fillStyle = 'rgba(12,16,22,.68)';
      cx.fill();
      cx.lineWidth = 1 * k;
      cx.strokeStyle = 'rgba(255,255,255,.14)';
      cx.stroke();
      // the accent bar, on the reading side
      roundRect(bx + bw - 6 * k, by + 14 * k, 4 * k, bh - 28 * k, 2 * k);
      cx.fillStyle = color;
      cx.fill();
      const xr = bx + bw - pad - 8 * k;
      let ty = by + pad + 14 * k;
      cx.font = `800 ${15 * k}px ${fonts.body}`;
      cx.fillStyle = color;
      cx.fillText(head, xr, ty);
      ty += ts * 1.1;
      cx.font = `400 ${ts}px ${fonts.display}`;
      cx.fillStyle = '#fff6e6';
      cx.fillText(title, xr, ty);
      if (meta) {
        ty += 24 * k;
        cx.font = `600 ${15 * k}px ${fonts.body}`;
        cx.fillStyle = 'rgba(255,246,230,.75)';
        cx.fillText(meta, xr, ty);
      }
    }
    cx.restore();
  }

  function dayLabel(day) { return `יום ${day}`; }
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
  const kmText = (km) => (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('he-IL'));
  const minutes = (s) => { const m = String(s || '').match(/^(\d{1,2})[:.](\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

  // The opening title: the trip's name opening up letter by letter, then the dates
  // and what is in it, each a beat later.
  function introTitle(t, plan) {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    const a = clamp((t - 0.3) / 0.7, 0, 1) * clamp((5.1 - t) / 0.7, 0, 1);
    if (a <= 0) return;
    cx.save();
    const g = cx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.6);
    g.addColorStop(0, `rgba(6,13,11,${0.45 * a})`);
    g.addColorStop(1, `rgba(6,13,11,${0.15 * a})`);
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.direction = 'rtl';
    cx.shadowColor = 'rgba(0,0,0,.5)';
    cx.shadowBlur = 20 * k;
    const title = opts.trip.title || 'הטיול';
    spaced(lerp(0, 6 * k, smooth((t - 0.3) / 3.5)));
    const size = fit(title, 400, 78 * k, fonts.display, W * 0.84, 28 * k);
    cx.globalAlpha = a;
    cx.fillStyle = '#fff6e6';
    cx.fillText(title, W / 2, H * 0.45);
    spaced(0);
    cx.shadowBlur = 10 * k;
    const sub = clamp((t - 1.0) / 0.6, 0, 1);
    cx.globalAlpha = a * sub;
    cx.fillStyle = 'rgba(255,255,255,.85)';
    cx.fillRect(W / 2 - 60 * k * sub, H * 0.45 + size * 0.62, 120 * k * sub, 1.5 * k);
    cx.font = `700 ${24 * k}px ${fonts.body}`;
    cx.fillStyle = '#ffc879';
    cx.fillText(datesText(), W / 2, H * 0.45 + size * 0.62 + 32 * k);
    const sub2 = clamp((t - 1.6) / 0.6, 0, 1);
    cx.globalAlpha = a * sub2;
    cx.font = `600 ${18 * k}px ${fonts.body}`;
    cx.fillStyle = 'rgba(255,246,230,.8)';
    const days = new Set(plan.stops.map((s) => s.day_number)).size;
    cx.fillText(`${plan.stops.length} תחנות · ${days === 1 ? 'יום אחד' : `${days} ימים`}`, W / 2, H * 0.45 + size * 0.62 + 66 * k);
    cx.restore();
  }

  // a new day: its number, a line opening from the middle, the date under it
  function chapter(t, dur, stop) {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    const span = Math.min(2.4, dur);
    const a = clamp(t / 0.35, 0, 1) * clamp((span - t) / 0.4, 0, 1);
    if (a <= 0) return;
    const y = H * (H > W ? 0.24 : 0.28);
    cx.save();
    cx.globalAlpha = a;
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.direction = 'rtl';
    cx.shadowColor = 'rgba(0,0,0,.55)';
    cx.shadowBlur = 16 * k;
    cx.font = `800 ${15 * k}px ${fonts.body}`;
    cx.fillStyle = opts.dayColor(stop.day_number);
    spaced(4 * k);
    cx.fillText('· פרק חדש ·', W / 2, y - 52 * k);
    spaced(2 * k);
    cx.font = `400 ${60 * k}px ${fonts.display}`;
    cx.fillStyle = '#fff6e6';
    cx.fillText(`יום ${stop.day_number}`, W / 2, y);
    spaced(0);
    const line = 130 * k * smooth(t / 0.7);
    cx.fillStyle = 'rgba(255,255,255,.85)';
    cx.fillRect(W / 2 - line, y + 40 * k, line * 2, 1.5 * k);
    const d = opts.dayDate ? opts.dayDate(stop.day_number) : null;
    cx.font = `700 ${19 * k}px ${fonts.body}`;
    cx.fillStyle = 'rgba(255,246,230,.85)';
    cx.fillText(d ? d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }) : (stop.area || ''), W / 2, y + 68 * k);
    cx.restore();
  }

  // the dashboard along the road: how far, how high, and what time it is
  function hud(a, fr, seg, plan) {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    const i = seg.i;
    const at = pointAt(plan, i, fr.d);
    let alt = null;
    try { const e = map.queryTerrainElevation(at); if (e != null && Number.isFinite(e)) alt = Math.max(0, Math.round(e / EXAG)); } catch { /* no terrain yet */ }
    const s0 = plan.stops[i - 1];
    const s1 = plan.stops[i];
    const m0 = minutes(s0.time_label);
    const m1 = minutes(s1.time_label);
    let time = dayLabel(s1.day_number);
    let timeHead = 'יום';
    if (s0.day_number === s1.day_number && m0 != null && m1 != null && m1 > m0) {
      const m = Math.round(lerp(m0, m1, plan.len[i] ? fr.d / plan.len[i] : 1));
      time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      timeHead = 'שעה';
    }
    const cols = [
      ['מרחק', `${kmText(fr.km / 1000)}`, 'ק״מ'],
      ['גובה', alt == null ? '—' : alt.toLocaleString('he-IL'), alt == null ? '' : 'מ׳'],
      [timeHead, time, ''],
    ];
    const y = H - (H > W ? 150 : 96) * k;
    const colW = Math.min(W * 0.27, 190 * k);
    cx.save();
    cx.globalAlpha = a;
    cx.textAlign = 'center';
    cx.direction = 'rtl';
    cx.shadowColor = 'rgba(0,0,0,.6)';
    cx.shadowBlur = 12 * k;
    cols.forEach(([head, val, unit], j) => {
      const x = W / 2 + (1 - j) * colW; // right to left
      cx.textBaseline = 'alphabetic';
      cx.font = `800 ${13 * k}px ${fonts.body}`;
      cx.fillStyle = 'rgba(255,255,255,.72)';
      spaced(3 * k);
      cx.fillText(head, x, y);
      spaced(0);
      cx.font = `400 ${38 * k}px ${fonts.display}`;
      cx.fillStyle = '#fff6e6';
      cx.direction = 'ltr';
      const vw = cx.measureText(val).width;
      cx.fillText(val, x - (unit ? 10 * k : 0), y + 44 * k);
      if (unit) {
        cx.font = `700 ${14 * k}px ${fonts.body}`;
        cx.fillStyle = '#ffc879';
        cx.textAlign = 'left';
        cx.direction = 'rtl';
        cx.fillText(unit, x - 10 * k + vw / 2 + 5 * k, y + 44 * k);
        cx.textAlign = 'center';
      }
      cx.direction = 'rtl';
      if (j < 2) {
        cx.fillStyle = 'rgba(255,255,255,.22)';
        cx.fillRect(x - colW / 2, y - 6 * k, 1 * k, 56 * k);
      }
    });
    cx.restore();
  }

  function outroCard(t, plan, film) {
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    const a = clamp((t - 1.4) / 0.8, 0, 1);
    if (a <= 0) return;
    cx.save();
    cx.globalAlpha = a;
    const g = cx.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, 'rgba(6,13,11,0)');
    g.addColorStop(1, 'rgba(6,13,11,.75)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.direction = 'rtl';
    cx.shadowColor = 'rgba(0,0,0,.5)';
    cx.shadowBlur = 16 * k;
    const y = H - (H > W ? 330 : 190) * k;
    const size = fit(opts.trip.title || 'הטיול', 400, 54 * k, fonts.display, W * 0.84, 24 * k);
    cx.fillStyle = '#fff6e6';
    cx.fillText(opts.trip.title || 'הטיול', W / 2, y);
    cx.font = `700 ${21 * k}px ${fonts.body}`;
    cx.fillStyle = '#ffc879';
    cx.fillText(datesText(), W / 2, y + size * 0.55 + 22 * k);
    // the day's totals, three numbers
    const days = new Set(plan.stops.map((s) => s.day_number)).size;
    const totals = [[kmText(film.totalKm), 'ק״מ בדרך'], [String(plan.stops.length), 'תחנות'], [String(days), days === 1 ? 'יום' : 'ימים']];
    const colW = Math.min(W * 0.27, 190 * k);
    totals.forEach(([v, l], j) => {
      const x = W / 2 + (1 - j) * colW;
      const ty = y + size * 0.55 + 92 * k;
      cx.font = `400 ${40 * k}px ${fonts.display}`;
      cx.fillStyle = '#fff6e6';
      cx.direction = 'ltr';
      cx.fillText(v, x, ty);
      cx.direction = 'rtl';
      cx.font = `700 ${14 * k}px ${fonts.body}`;
      cx.fillStyle = 'rgba(255,246,230,.75)';
      cx.fillText(l, x, ty + 36 * k);
    });
    cx.restore();
  }

  function watermark(k) {
    const W = comp.width;
    const H = comp.height;
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
    cx.direction = 'rtl';
    cx.textAlign = 'right';
    cx.font = `700 ${17 * k}px ${fonts.body}`;
    cx.fillText(`${opts.trip.emoji || ''} ${opts.trip.title || ''}`.trim(), W - 24 * k, 22 * k);
    // attribution, as small as it may be and still be read
    cx.direction = 'ltr';
    cx.textAlign = 'center';
    cx.textBaseline = 'bottom';
    cx.shadowBlur = 4 * k;
    cx.font = `600 ${10.5 * k}px ${fonts.body}`;
    cx.fillStyle = 'rgba(255,255,255,.72)';
    cx.fillText(`${credit()} · Roads © OpenStreetMap`, W / 2, H - 10 * k);
    cx.restore();
  }

  // the finish: shade at the top and bottom so white text holds on bright ground,
  // and a vignette that pulls the eye to the middle
  function grade(W, H) {
    const g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,.38)');
    g.addColorStop(0.16, 'rgba(0,0,0,0)');
    g.addColorStop(0.7, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.45)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    const v = cx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    v.addColorStop(0, 'rgba(8,14,20,0)');
    v.addColorStop(1, 'rgba(8,14,20,.42)');
    cx.fillStyle = v;
    cx.fillRect(0, 0, W, H);
  }

  // Draw the map as it is now and everything over it, for frame `run.cur` (or the
  // bare map with the watermark when nothing is playing).
  function composite() {
    if (!map || !comp) return;
    const W = comp.width;
    const H = comp.height;
    const k = Math.min(W, H) / 720;
    try { cx.drawImage(map.getCanvas(), 0, 0, W, H); } catch { return; }
    grade(W, H);
    if (!run || run.cur == null) { watermark(k); return; }
    const { plan, film } = run;
    const fr = film.frames[run.cur];
    const seg = film.segs[fr.si];
    const t = (run.cur - seg.f0) / FPS;
    const dur = (seg.f1 - seg.f0) / FPS;
    const scale = W / (map.getCanvas().clientWidth || W);
    const xy = (s) => { const p = map.project([s.lon, s.lat]); return [p.x * scale, p.y * scale]; };
    const onScreen = ([x, y]) => x > -60 && y > -60 && x < W + 60 && y < H + 60;
    // which stop is "here", and which are behind
    const reached = seg.kind === 'stop' ? seg.i : seg.kind === 'leg' ? seg.i - 1 : seg.kind === 'outro' ? plan.stops.length : -1;
    const big = seg.kind === 'stop' ? seg.i : (seg.kind === 'leg' && t < 0.5 ? seg.i - 1 : -1);
    if (seg.kind !== 'intro' || t > 4.6) {
      plan.stops.forEach((s, j) => {
        if (j === big) return;
        const p = xy(s);
        if (onScreen(p)) dot(p[0], p[1], run.nums[j], opts.dayColor(s.day_number), k, j <= reached ? 1 : 0.5);
      });
    }
    if (big >= 0) {
      const p = xy(plan.stops[big]);
      const age = seg.kind === 'stop' ? t : (film.segs[fr.si - 1].f1 - film.segs[fr.si - 1].f0) / FPS + t;
      const fade = seg.kind === 'stop' ? 1 : clamp(1 - t / 0.5, 0, 1);
      if (onScreen(p)) bigPin(p[0], p[1], plan.stops[big], run.nums[big], k, age, fade);
    }
    if (seg.kind === 'leg') {
      const a = clamp(t / 0.4, 0, 1) * clamp((dur - t) / 0.4, 0, 1);
      if (a > 0) hud(a, fr, seg, plan);
      if (seg.newDay) chapter(t, dur, plan.stops[seg.i]);
    }
    watermark(k);
    if (seg.kind === 'intro') introTitle(t, plan);
    if (seg.kind === 'outro') outroCard(t, plan, film);
  }

  // composite each time MapLibre draws, so the pins sit on the frame they belong to
  function onMapRender() { if (run && run.cur != null && !run.offline) composite(); }

  // the idle loop: keeps the composite showing the map while nothing plays
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!run || run.cur == null) composite();
  }

  // ---------------------------------------------------------------- playing

  function stopNumbers(plan) {
    return plan.stops.map((s) => {
      const day = opts.items().filter((it) => it.day_number === s.day_number && it.lat != null && it.lon != null);
      return day.findIndex((x) => x.id === s.id) + 1;
    });
  }

  async function prepare() {
    const plan = await buildPlan();
    if (plan.stops.length < 2) { renderSetup('צריך לפחות שתי תחנות עם מיקום כדי לטוס ביניהן'); return null; }
    if (!root || !map) return null;
    setGround(groundFor(plan.stops));
    const film = buildFrames(plan);
    map.getSource('ghost').setData({ type: 'FeatureCollection', features: plan.drawLine ? plan.legs.filter(Boolean).map((l) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })) : [] });
    return { plan, film, nums: stopNumbers(plan), cur: null, stopped: false, offline: false };
  }

  // 'play' = watch it by the clock; 'film' = render frame by frame into an MP4;
  // 'live' = the fallback recording, MediaRecorder while it plays by the clock.
  // A run that throws halfway must not leave the panel stuck on "בטיסה".
  async function play(how) {
    if (run) return;
    renderPlaying(how);
    try {
      run = { cur: null, stopped: false, preparing: true };
      const r = await prepare();
      if (!r || run.stopped) { run = null; if (r) renderSetup(); return; }
      run = r;
      renderPlaying(how, r.plan.note);
      TRIPMAKER.track?.(`flyover_${how}`, { code: opts.trip.share_code, stops: r.plan.stops.length, path: r.plan.mode, aspect, imagery, ground, secs: Math.round(r.film.frames.length / FPS) });
      if (how === 'film') await renderFilm();
      else await realtime(how === 'live');
    } catch (e) {
      console.error('trip-flyover: the film failed', e);
      if (rec) await stopRecording(true);
      run = null;
      releaseWake();
      sizeFrame();
      renderSetup('משהו השתבש באמצע — נסו שוב');
      return;
    }
    const stopped = !run || run.stopped;
    run = null;
    releaseWake();
    sizeFrame();
    if (!stopped && result) renderDone();
    else renderSetup();
  }

  // by the clock: the frame for the time that has passed, whatever the tiles are doing
  async function realtime(record) {
    const n = run.film.frames.length;
    if (record) {
      // warm the tiles first, so the film is not of tiles arriving: the opening shot
      // and every stop's close-up, once each, off camera
      for (let i = 0; i < run.plan.stops.length && !run.stopped; i++) {
        setStatus(`מכינים את המפה · ${i + 1}/${run.plan.stops.length}`);
        const s = run.plan.stops[i];
        map.jumpTo({ center: [s.lon, s.lat], zoom: closeZoom(), pitch: 52, bearing: 0 });
        await settled(2000);
      }
      if (run.stopped) return;
      applyFrame(0);
      await settled(4000);
      if (!startRecording()) record = false;
    }
    setStatus(record ? 'מקליטים — השאירו את המסך דלוק ואת הדף פתוח' : 'צפייה בלבד — שום דבר לא מוקלט');
    await new Promise((res) => {
      const t0 = performance.now();
      const step = () => {
        if (!run || run.stopped) return res();
        const k = Math.floor(((performance.now() - t0) / 1000) * FPS);
        if (k >= n) return res();
        if (k !== run.cur) applyFrame(k);
        setProgress(k / n);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    if (rec) await stopRecording(!run || run.stopped);
  }

  function stop() {
    if (!run) return;
    run.stopped = true;
  }

  // ---------------------------------------------------------------- the film (WebCodecs)

  const canFilm = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  let muxerLoading = null;
  function loadMuxer() {
    if (typeof Mp4Muxer !== 'undefined') return Promise.resolve();
    if (!muxerLoading) {
      muxerLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = '/vendor/mp4-muxer/mp4-muxer.js';
        s.onload = res;
        s.onerror = () => { muxerLoading = null; rej(new Error('mp4-muxer failed to load')); };
        document.head.appendChild(s);
      });
    }
    return muxerLoading;
  }

  // the biggest H.264 the device will encode: 1080×1920, else 720×1280
  async function encoderConfig() {
    const sizes = [FILM[aspect], VIEW[aspect]];
    for (const [w, h] of sizes) {
      for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42e01f']) {
        const cfg = { codec, width: w, height: h, bitrate: w * h > 1.5e6 ? 6_000_000 : 3_500_000, framerate: FPS, latencyMode: 'quality', avc: { format: 'avc' } };
        try {
          const ok = await VideoEncoder.isConfigSupported(cfg);
          if (ok && ok.supported) return cfg;
        } catch { /* try the next */ }
      }
    }
    return null;
  }

  const visible = () => new Promise((res) => {
    if (!document.hidden) return res();
    const on = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', on); res(); } };
    document.addEventListener('visibilitychange', on);
  });

  // Frame by frame: move the camera, wait for every tile, composite, encode. Leaving
  // the page pauses it (a hidden page draws nothing) and coming back carries on.
  async function renderFilm() {
    await loadMuxer();
    const cfg = await encoderConfig();
    if (!cfg) { setStatus('המכשיר הזה לא מקודד וידאו — מקליטים בזמן אמת'); return realtime(true); }
    sizeFrame([cfg.width, cfg.height]);
    run.offline = true;
    grabWake();
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({ target, video: { codec: 'avc', width: cfg.width, height: cfg.height, frameRate: FPS }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    let failed = null;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
    encoder.configure(cfg);
    const n = run.film.frames.length;
    const t0 = performance.now();
    for (let k = 0; k < n; k++) {
      if (!run || run.stopped || failed) break;
      if (document.hidden) { setStatus('ההכנה מושהית — חזרו לדף כדי להמשיך'); await visible(); }
      applyFrame(k);
      await settled();
      composite();
      const vf = new VideoFrame(comp, { timestamp: Math.round((k * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(vf, { keyFrame: k % (FPS * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 4) await sleep(4);
      if (k % 5 === 0) {
        const per = (performance.now() - t0) / (k + 1);
        const left = Math.round((per * (n - k)) / 1000);
        setStatus(`מכינים את הסרטון · ${Math.round((k / n) * 100)}% · ${left > 90 ? `עוד כ-${Math.round(left / 60)} דק׳` : `עוד ${left} שנ׳`}`);
        setProgress(k / n);
      }
    }
    if (!run || run.stopped || failed) {
      try { encoder.close(); } catch { /* closed */ }
      if (failed) throw failed;
      return;
    }
    setStatus('אורזים את הקובץ…');
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    if (result) URL.revokeObjectURL(result.url);
    result = { blob, url: URL.createObjectURL(blob), name: `tripmaker-${opts.trip.share_code}-flyover.mp4`, type: 'video/mp4', secs: Math.round(n / FPS), size: `${cfg.width}×${cfg.height}` };
  }

  // ---------------------------------------------------------------- recording (fallback)

  function pickMime() {
    const list = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return list.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }
  const canRecord = () => typeof MediaRecorder !== 'undefined' && !!(comp && comp.captureStream);

  function startRecording() {
    try {
      const stream = comp.captureStream(FPS);
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 6_000_000 });
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

  // A real-time recording needs the page on screen: frames stop while it is hidden,
  // and the film would jump. Leaving the page stops it rather than ruin the video.
  // (The frame-by-frame film just pauses — see renderFilm.)
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
  function setProgress(v) {
    const prog = $('.fly-prog i');
    if (prog) prog.style.width = `${Math.round(clamp(v || 0, 0, 1) * 100)}%`;
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
    const seg = (attr, cur, list, label) => `
      <div class="fly-seg" role="radiogroup" aria-label="${label}">
        ${list.map(([v, t]) => `<button type="button" data-${attr}="${v}" aria-pressed="${cur === v}">${t}</button>`).join('')}
      </div>`;
    const film = canFilm();
    const live = !film && canRecord();
    panel.innerHTML = `
      <div class="fly-head">
        <h2>🎬 סרטון טיסה מעל הטיול</h2>
        <p>המצלמה נוסעת בדרך מתחנה לתחנה מעל מפה תלת־ממדית, הקו נמתח מאחוריה וכל תחנה קמה עם השם שלה. סרטון של כדקה, לסטורי או לשמירה.</p>
      </div>
      ${msg ? `<p class="fly-msg">${esc(msg)}</p>` : ''}
      <div class="fly-actions">
        <button type="button" class="btn btn-ghost fly-play">▶ צפייה</button>
        ${film || live ? '<button type="button" class="btn btn-amber fly-rec">● יצירת סרטון</button>' : ''}
      </div>
      ${film ? `<p class="fly-fine">הסרטון נבנה פריים אחר פריים במכשיר (MP4 ‏${FILM[aspect][0]}×${FILM[aspect][1]}) — לוקח כמה דקות, ואפשר לצאת מהדף ולחזור.</p>` : ''}
      ${!film && !live ? '<p class="fly-fine">הדפדפן הזה לא יודע להקליט וידאו — אפשר לצפות בטיסה (ולהקליט את המסך מהטלפון).</p>' : ''}
      ${result ? '<button type="button" class="fly-last">הסרטון האחרון שיצרתם ›</button>' : ''}
      <div class="fly-group">
        <div class="fly-label">צורה</div>
        ${seg('aspect', aspect, [['tall', '▯ לסטורי'], ['wide', '▭ לרוחב']], 'צורת הסרטון')}
      </div>
      <div class="fly-group">
        <div class="fly-label">מה מצלמים</div>
        <select class="fly-scope" aria-label="מה מצלמים">
          <option value="0"${!scope ? ' selected' : ''}>כל הטיול</option>
          ${days.filter(([, n]) => n >= 2).map(([d, n]) => `<option value="${d}"${scope === d ? ' selected' : ''}>${esc(dayText(d))} · ${n} תחנות</option>`).join('')}
        </select>
      </div>
      <div class="fly-group" role="radiogroup" aria-label="המסלול בסרטון">
        <div class="fly-label">המסלול</div>
        ${rOpt('path', 'road', pathMode, 'בדרכים', 'שבילים ברגל, כבישים ברכב, וקשת בטיסה')}
        ${rOpt('path', 'timeline', pathMode, 'המסלול שעשיתם בפועל', tl ? `מציר הזמן של Google · ${tlDays} ימים, ${tl.points.length.toLocaleString('he-IL')} נקודות` : 'דורש ייבוא של ציר הזמן מ-Google Maps (למטה)', !tl)}
        ${rOpt('path', 'line', pathMode, 'קו ישר מתחנה לתחנה', '')}
        ${rOpt('path', 'none', pathMode, 'בלי קו', 'רק טיסה מתחנה לתחנה')}
      </div>
      <div class="fly-group">
        <div class="fly-label">הקרקע</div>
        ${seg('imagery', imagery, [['auto', 'אוטומטי'], ['s2', 'אחיד'], ['esri', 'חד']], 'תמונת הקרקע')}
        <p class="fly-fine">${{ auto: 'טיול בתוך עיר מקבל צילום חד מקרוב; טיול של נסיעות, טבע וטיסות מקבל פסיפס אחיד וקולנועי.', s2: 'Sentinel‑2: אותו צבע בכל גובה, בלי תפרים — מראה קולנועי, רך מקרוב.', esri: 'Esri: חד מקרוב, אבל הצבעים מתחלפים בין גבהים.' }[imagery]}</p>
      </div>
      <details class="fly-tl"${tl ? '' : ''}>
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
      </details>`;
    panel.querySelector('.fly-scope').onchange = (e) => { scope = +e.target.value; setGround(groundFor(scopeStops())); overview(); };
    panel.querySelectorAll('input[name="path"]').forEach((r) => { r.onchange = () => { pathMode = r.value; }; });
    panel.querySelector('.fly-file input').onchange = (e) => { if (e.target.files.length) importFiles(e.target.files); };
    const del = panel.querySelector('.fly-tl-del');
    if (del) {
      del.onclick = () => {
        try { localStorage.removeItem(TL_KEY(opts.trip.share_code)); } catch { /* ignore */ }
        timeline = null;
        if (pathMode === 'timeline') pathMode = 'road';
        renderSetup('ציר הזמן נמחק מהמכשיר');
      };
    }
    panel.querySelectorAll('[data-aspect]').forEach((b) => {
      b.onclick = () => { aspect = b.dataset.aspect; root.dataset.aspect = aspect; savePrefs(); sizeFrame(); overview(); renderSetup(); };
    });
    panel.querySelectorAll('[data-imagery]').forEach((b) => {
      b.onclick = () => { imagery = b.dataset.imagery; setGround(groundFor(scopeStops())); savePrefs(); renderSetup(); };
    });
    panel.querySelector('.fly-play').onclick = () => play('play');
    panel.querySelector('.fly-rec')?.addEventListener('click', () => play(film ? 'film' : 'live'));
    panel.querySelector('.fly-last')?.addEventListener('click', renderDone);
    if (!map) panel.querySelectorAll('.fly-play, .fly-rec').forEach((b) => { b.disabled = true; });
  }

  function renderPlaying(how, note) {
    const panel = $('.fly-panel');
    if (!panel) return;
    const head = how === 'film' ? '🎬 מכינים את הסרטון' : how === 'live' ? '● מקליטים' : '▶ בטיסה';
    panel.innerHTML = `
      <div class="fly-head"><h2>${head}</h2></div>
      <p class="fly-status" role="status"></p>
      ${note ? `<p class="fly-msg">${esc(note)}</p>` : ''}
      <div class="fly-prog" aria-hidden="true"><i></i></div>
      ${how === 'film' ? '<p class="fly-fine">כל פריים מחכה שהמפה תיטען במלואה, כך שהסרטון חלק גם אם הרשת איטית. אפשר לצאת מהדף — ההכנה תמשיך כשתחזרו.</p>' : ''}
      <div class="fly-actions"><button type="button" class="btn btn-ghost fly-stop">■ עצירה</button></div>`;
    panel.querySelector('.fly-stop').onclick = stop;
  }

  function renderDone() {
    const panel = $('.fly-panel');
    if (!panel || !result) return;
    const file = new File([result.blob], result.name, { type: result.type });
    const share = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const mb = (result.blob.size / 1048576).toFixed(1);
    const facts = [`${mb}MB`, result.type.includes('mp4') ? 'MP4' : 'WebM', result.size, result.secs ? `${result.secs} שנ׳` : ''].filter(Boolean).join(' · ');
    panel.innerHTML = `
      <div class="fly-head"><h2>✓ הסרטון מוכן</h2><p>${facts}</p></div>
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
  function onResize() { if (!run || !run.offline) sizeFrame(); }

  // the still behind the panel: the stops from above, tilted
  function overview() {
    if (!map || run) return;
    const stops = scopeStops();
    if (!stops.length) return;
    const fitted = fitOf(stops.map(P));
    map.jumpTo({ center: fitted.center, zoom: Math.min(fitted.zoom, 14), pitch: 45, bearing: -15 });
  }

  async function open(o) {
    if (root) return;
    opts = o;
    scope = 0;
    loadPrefs();
    ground = groundFor(scopeStops());
    timeline = loadStoredTimeline();
    if (pathMode === 'timeline' && !timeline) pathMode = 'road';
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
      try { map?.remove(); } catch { /* half made */ }
      map = null;
      renderSetup('המפה התלת־ממדית לא עלתה במכשיר הזה (WebGL כבוי או לא נתמך)');
      return;
    }
    if (!root) return; // closed while loading
    sizeFrame();
    overview();
    renderSetup();
    raf = requestAnimationFrame(tick);
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
    run = null;
    root?.remove();
    root = null;
    comp = null;
    document.documentElement.classList.remove('fly-open');
  }

  // parseTimeline is exposed for tools/flyover-check.js; the script helpers for its film checks
  // _frame(k): build the film if needed and show exactly frame k, tiles loaded — what
  // the rendered film would hold there (tools/preview screenshots look at it)
  async function _frame(k) {
    if (!run) { run = await prepare(); if (!run) return 0; }
    const n = run.film.frames.length;
    applyFrame(clamp(k, 0, n - 1));
    await settled();
    composite();
    return n;
  }
  return { open, close, parseTimeline, _frame, _test: { arc, thin, smooth, bump, turn, along } };
})();
if (typeof module === 'object' && module.exports) module.exports = TripFlyover;
