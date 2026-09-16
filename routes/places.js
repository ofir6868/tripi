// Google Places (New) autocomplete, proxied: the key lives here and never reaches
// the client; the browser gets thin JSON. Only the place-picker uses this — the AI
// place verification (lib/places.js) stays on OSM. No key → 503, and the client
// quietly falls back to Photon, so the feature degrades instead of breaking.
//
// Both routes are unauthenticated, because the picker runs before a traveller has
// signed in — which for a long time meant anyone could spend our Google budget by
// curling this path in a loop, at no cost to themselves and with nothing counting.
// Three things stand between that and a bill now, and the order matters:
//
//   1. the durable cache (lib/api-budget.js), so a repeat query is free forever rather
//      than only until the next deploy;
//   2. a per-IP limit that counts ONLY the queries that reach Google — a miss is the
//      billed event, and enumeration is all misses, while a traveller typing into the
//      picker is mostly cache hits and debounced besides (300ms, public/js/geo.js);
//   3. a monthly ceiling per SKU, which is the actual guarantee: whatever gets past the
//      first two, the month cannot cost more than the number set here.
//
// A spent budget answers exactly like a missing key — 503, and the picker moves to
// Photon — so the degradation path was already written and already tested.
const express = require('express');
const { monthlyMeter, cacheGet, cacheSet, once } = require('../lib/api-budget');
const { rateLimiter } = require('../lib/rate-limit');

const router = express.Router();
const KEY = () => process.env.GOOGLE_PLACES_API_KEY || '';

// Ceilings we choose, not allowances Google publishes: each is set below the free tier
// of its SKU so the default configuration cannot bill, and each is overridable for a
// deployment that has a budget and wants the better picker. Autocomplete and the
// location-only Details lookup are the two cheapest tiers; the expensive one in this
// codebase is the photo fetch (lib/place-photos.js, 1,000/month).
const acBudget = monthlyMeter('places_autocomplete', 4000, 'PLACES_AUTOCOMPLETE_MONTHLY_LIMIT');
const detailBudget = monthlyMeter('places_details', 5000, 'PLACES_DETAILS_MONTHLY_LIMIT');

// Only misses are counted, which is the share-code rule one resource over: legitimate
// typing repeats prefixes and lands on the cache, while walking the key space cannot.
const lookupLimit = rateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 80,
  error: 'יותר מדי חיפושים — נסו שוב בעוד כמה דקות',
});

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

router.get('/api/places/autocomplete', async (req, res) => {
  if (!KEY()) return res.status(503).json({ error: 'places unavailable' });
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json([]);
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const biased = Number.isFinite(lat) && Number.isFinite(lon);
  // bias rounded to ~1km, so nearby stops share cache entries
  const key = q + '|' + (biased ? `${lat.toFixed(2)},${lon.toFixed(2)}` : '');

  // the limiter is an in-memory check and the cache is a query, so the limiter goes
  // first: an address that has already spent 80 uncached lookups in ten minutes is not
  // a traveller typing, and it must not be able to put the database to work per request
  if (lookupLimit.blocked(req.ip)) return res.status(429).json({ error: 'יותר מדי חיפושים — נסו שוב בעוד כמה דקות' });
  const hit = await cacheGet('places_ac', key);
  if (hit.hit) return res.json(hit.value);

  try {
    const out = await once('places_ac' + key, async () => {
      const again = await cacheGet('places_ac', key);
      if (again.hit) return again.value;
      lookupLimit.hit(req.ip);
      if (!(await acBudget.claim())) return null; // budget spent → the picker uses Photon

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
        return null; // never cached: we paid, but a 500 is not an answer about this query
      }
      const data = await r.json();
      const rows = (data.suggestions || []).map((s) => s.placePrediction).filter(Boolean).slice(0, 6)
        .map((p) => ({
          name: p.structuredFormat?.mainText?.text || p.text?.text || '',
          detail: p.structuredFormat?.secondaryText?.text || '',
          kind: KIND[(p.types || []).find((t) => KIND[t])] || '',
          place_id: p.placeId,
        }))
        .filter((x) => x.name);
      await cacheSet('places_ac', key, rows);
      return rows;
    });
    if (out === null) return res.status(503).json({ error: 'places unavailable' });
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

  if (lookupLimit.blocked(req.ip)) return res.status(429).json({ error: 'יותר מדי חיפושים — נסו שוב בעוד כמה דקות' });
  const hit = await cacheGet('places_detail', id);
  if (hit.hit) return res.json(hit.value);

  try {
    const out = await once('places_detail' + id, async () => {
      const again = await cacheGet('places_detail', id);
      if (again.hit) return again.value;
      lookupLimit.hit(req.ip);
      if (!(await detailBudget.claim())) return null;

      const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
        headers: { 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': 'location' },
      });
      if (!r.ok) {
        console.error('places details', r.status, (await r.text().catch(() => '')).slice(0, 200));
        return null;
      }
      const data = await r.json();
      const coords = { lat: data.location?.latitude ?? null, lon: data.location?.longitude ?? null };
      await cacheSet('places_detail', id, coords);
      return coords;
    });
    if (out === null) return res.status(503).json({ error: 'places unavailable' });
    res.json(out);
  } catch (err) {
    console.error('places details failed', err.message);
    res.status(502).json({ error: 'places failed' });
  }
});

module.exports = router;
