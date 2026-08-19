// hotels near coordinates (OSM Overpass, server-side with cache) — feeds the
// hotel-name autocomplete in the trip page's hotels modal (trip-modals.js)
const express = require('express');

const router = express.Router();

const hotelsCache = new Map(); // "lat,lon" → {at, data}
const HOTELS_TTL = 24 * 60 * 60 * 1000;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

router.get('/api/hotels', async (req, res) => {
  const lat = Math.round(parseFloat(req.query.lat) * 100) / 100;
  const lon = Math.round(parseFloat(req.query.lon) * 100) / 100;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'bad coords' });

  const key = `${lat},${lon}`;
  const cached = hotelsCache.get(key);
  if (cached && Date.now() - cached.at < HOTELS_TTL) return res.json(cached.data);

  // Photon first: every public Overpass mirror times out from this host (measured
  // 2026-08-19 from the deployed service — overpass-api.de refuses outright, kumi and
  // private.coffee never finish the handshake), while Photon answers in under a second.
  // Its reverse endpoint takes the same "hotels within 7km" question and needs no
  // query language. What it can't tell us is the star rating, which is optional here.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&radius=7&limit=20&lang=en&osm_tag=tourism:hotel`, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'TRIPI trip planner/1.0', Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (r.ok) {
      const seen = new Set();
      const hotels = ((await r.json()).features || [])
        .map((f) => ({
          name: (f.properties || {})['name:he'] || (f.properties || {}).name,
          stars: null,
          lat: f.geometry && f.geometry.coordinates[1],
          lon: f.geometry && f.geometry.coordinates[0],
        }))
        .filter((h) => h.name && h.lat != null && !seen.has(h.name) && seen.add(h.name))
        .slice(0, 8);
      if (hotels.length) {
        hotelsCache.set(key, { at: Date.now(), data: hotels });
        return res.json(hotels);
      }
    }
  } catch { /* fall through to Overpass — it carries star ratings when it answers */ }

  // node-only: way/relation geometry resolution regularly 504s on the public servers
  const query = `[out:json][timeout:25];node["tourism"="hotel"]["name"](around:7000,${lat},${lon});out 30;`;
  let elements = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 28000); // public Overpass servers regularly need 15-20s
      const r = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TRIPI trip planner/1.0 (github.com/ofir6868/tripi)',
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) continue;
      elements = (await r.json()).elements || [];
      break;
    } catch { /* try next mirror */ }
  }
  if (elements === null) return res.json([]); // all mirrors down — client shows Booking fallback

  const seen = new Set();
  const hotels = elements
    .map((el) => ({
      name: el.tags?.['name:he'] || el.tags?.name,
      stars: el.tags?.stars || null,
      lat: el.lat ?? el.center?.lat,
      lon: el.lon ?? el.center?.lon,
    }))
    .filter((h) => h.name && !seen.has(h.name) && seen.add(h.name))
    .slice(0, 8);
  hotelsCache.set(key, { at: Date.now(), data: hotels });
  res.json(hotels);
});

module.exports = router;
