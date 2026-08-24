// Google Places (New) autocomplete, proxied: the key lives here and never reaches
// the client; the browser gets thin JSON. Only the place-picker uses this — the AI
// place verification (lib/places.js) stays on OSM. No key → 503, and the client
// quietly falls back to Photon, so the feature degrades instead of breaking.
const express = require('express');

const router = express.Router();
const KEY = () => process.env.GOOGLE_PLACES_API_KEY || '';

// Google's types → the picker's icon vocabulary (poiIcon in geo.js)
const KIND = {
  restaurant: 'restaurant', cafe: 'cafe', coffee_shop: 'cafe', bar: 'bar',
  fast_food_restaurant: 'fast_food', hotel: 'hotel', lodging: 'hotel', hostel: 'hostel',
  museum: 'museum', tourist_attraction: 'attraction', historical_landmark: 'monument',
  beach: 'beach', park: 'park', garden: 'garden', castle: 'castle',
  church: 'place_of_worship', hindu_temple: 'place_of_worship', mosque: 'place_of_worship',
  synagogue: 'place_of_worship', airport: 'airport', train_station: 'station',
  subway_station: 'station', shopping_mall: 'mall', market: 'marketplace', locality: 'city',
};

const acCache = new Map();
const detailCache = new Map();
const CAP = 800;
const remember = (cache, k, v) => {
  if (cache.size >= CAP) cache.delete(cache.keys().next().value);
  cache.set(k, v);
};

router.get('/api/places/autocomplete', async (req, res) => {
  if (!KEY()) return res.status(503).json({ error: 'places unavailable' });
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json([]);
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const biased = Number.isFinite(lat) && Number.isFinite(lon);
  // bias rounded to ~1km, so nearby stops share cache entries
  const key = q + '|' + (biased ? `${lat.toFixed(2)},${lon.toFixed(2)}` : '');
  if (acCache.has(key)) return res.json(acCache.get(key));
  try {
    // languageCode he: the traveler types Hebrew and reads Hebrew — this picker is
    // exactly the surface Google beats Photon on. Verification never sees these
    // (a picked place arrives with coordinates and skips the AI-place checks).
    const body = { input: q, languageCode: 'he' };
    if (biased) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 50000 } };
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': KEY() },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error('places autocomplete', r.status, (await r.text().catch(() => '')).slice(0, 200));
      return res.status(502).json({ error: 'places failed' });
    }
    const data = await r.json();
    const out = (data.suggestions || []).map((s) => s.placePrediction).filter(Boolean).slice(0, 6)
      .map((p) => ({
        name: p.structuredFormat?.mainText?.text || p.text?.text || '',
        detail: p.structuredFormat?.secondaryText?.text || '',
        kind: KIND[(p.types || []).find((t) => KIND[t])] || '',
        place_id: p.placeId,
      }))
      .filter((x) => x.name);
    remember(acCache, key, out);
    res.json(out);
  } catch (err) {
    console.error('places autocomplete failed', err.message);
    res.status(502).json({ error: 'places failed' });
  }
});

// placeId → coordinates, resolved on pick — autocomplete answers carry no geometry,
// and the location field mask keeps this in the cheapest request tier
router.get('/api/places/details', async (req, res) => {
  if (!KEY()) return res.status(503).json({ error: 'places unavailable' });
  const id = String(req.query.id || '').trim();
  if (!id || id.length > 300 || !/^[\w-]+$/.test(id)) return res.status(400).json({ error: 'bad id' });
  if (detailCache.has(id)) return res.json(detailCache.get(id));
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: { 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': 'location' },
    });
    if (!r.ok) {
      console.error('places details', r.status, (await r.text().catch(() => '')).slice(0, 200));
      return res.status(502).json({ error: 'places failed' });
    }
    const data = await r.json();
    const out = { lat: data.location?.latitude ?? null, lon: data.location?.longitude ?? null };
    remember(detailCache, id, out);
    res.json(out);
  } catch (err) {
    console.error('places details failed', err.message);
    res.status(502).json({ error: 'places failed' });
  }
});

module.exports = router;
