// A photo for each stop of a trip that we can vouch for — lib/stop-photos.js decides
// what counts. Same shape as routes/hours.js, for the same reasons: one answer for the
// whole trip, never blocking the itinerary (the page draws the photos over cards that
// already exist), and bounded three ways — only stops carrying a place identity, a cap on
// how many are looked up in one request, and a limiter on the requests that reach a
// source. Everything is cached per place, so a trip answered once is answered from
// Postgres afterwards, for every viewer.
const express = require('express');
const { pool } = require('../lib/db');
const { stopPhoto } = require('../lib/stop-photos');
const { rateLimiter, codeMissLimit, CODE_MISS_ERROR } = require('../lib/rate-limit');

const router = express.Router();

const MAX_STOPS = 120;
// Wikimedia and OSM are someone else's servers — four at a time is polite, and a
// fully-cached trip still returns in one round trip
const CONCURRENCY = 4;

const lookupLimit = rateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 40,
  error: 'יותר מדי בקשות תמונה — נסו שוב בעוד כמה דקות',
});

router.get('/api/trips/code/:code/photos', async (req, res) => {
  try {
    // another door onto "does this code exist" — it shares the enumeration bucket
    if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
    const { rows: trips } = await pool.query('SELECT id FROM trips WHERE share_code = $1', [req.params.code]);
    const trip = trips[0];
    if (!trip) { codeMissLimit.hit(req.ip); return res.status(404).json({ error: 'הטיול לא נמצא' }); }

    const { rows: items } = await pool.query(
      `SELECT id, osm_type, osm_id, google_place_id
       FROM trip_items
       WHERE trip_id = $1 AND category IS DISTINCT FROM 'נסיעה'
         AND (osm_id IS NOT NULL OR google_place_id IS NOT NULL)
       ORDER BY day_number, time_label NULLS LAST
       LIMIT ${MAX_STOPS}`, [trip.id]
    );
    if (!items.length) return res.json({ stops: {} });

    if (lookupLimit.blocked(req.ip)) return res.status(429).json({ error: 'יותר מדי בקשות תמונה — נסו שוב בעוד כמה דקות' });
    lookupLimit.hit(req.ip);

    const stops = {};
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      await Promise.all(items.slice(i, i + CONCURRENCY).map(async (it) => {
        const p = await stopPhoto({ osmType: it.osm_type, osmId: it.osm_id, googlePlaceId: it.google_place_id }).catch(() => null);
        if (p && p.url) stops[it.id] = { url: p.url, large: p.large || p.url, credit: p.credit || null, link: p.link || null, source: p.source };
      }));
    }
    res.json({ stops });
  } catch (err) {
    console.error('stop photos failed', err.message);
    // never a 500 to the page: the itinerary is complete without pictures
    res.json({ stops: {} });
  }
});

module.exports = router;
