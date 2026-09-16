// Which stops in this trip send the traveller to a door that is shut?
//
// The itinerary already knows the real calendar date of every day and the clock time of
// every stop; lib/opening-hours.js knows when the place is open. This route is the one
// place those two meet, and it answers for the trip as a whole because that is the
// question a traveller has ("is anything wrong with my week?"), not one stop at a time.
//
// It never changes the itinerary. A closed door is shown, never silently moved or
// dropped: the stop may be the whole reason for the trip, the hours may be stale, and
// the traveller is the one who knows which. Everything here is advisory.
//
// Cost and load: OSM is keyless and unmetered, Google is budgeted in lib/api-budget.js,
// and both are cached durably — so a trip answered once is answered from Postgres
// afterwards, including after a deploy. The first call for a trip is the expensive one,
// which is why the work is bounded three ways: only dated trips, only stops carrying a
// place identity, and a hard cap on how many are looked up in one request.
const express = require('express');
const { pool } = require('../lib/db');
const { placeHours, verifyOpen } = require('../lib/opening-hours');
const { rateLimiter, codeMissLimit, CODE_MISS_ERROR } = require('../lib/rate-limit');

const router = express.Router();

// A 30-day trip is ~90 stops; beyond that a single request would sit on the geocoder
// long enough to be a request nobody sees answered (PLAYBOOK §3).
const MAX_STOPS = 120;
// how many lookups are in the air at once — polite to OSM, and fast enough that a
// fully-cached trip returns in one round trip
const CONCURRENCY = 6;

// The lookups go out to someone else's server, so the public path gets a limiter. Only
// requests that actually reach a source are counted: a trip answered from the cache
// costs nothing and must not use up anyone's allowance.
const lookupLimit = rateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 40,
  error: 'יותר מדי בדיקות שעות — נסו שוב בעוד כמה דקות',
});

const dateOf = (start, day) => {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + day - 1);
  return d;
};

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

router.get('/api/trips/code/:code/hours', async (req, res) => {
  try {
    // This route answers by share code, so it is another door onto "does this code
    // exist" — and it shares the one enumeration bucket rather than opening a second
    // allowance beside it (lib/rate-limit.js). Only misses count, exactly as on the
    // page load itself.
    if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
    const { rows: trips } = await pool.query(
      'SELECT id, start_date, days FROM trips WHERE share_code = $1', [req.params.code]
    );
    const trip = trips[0];
    if (!trip) { codeMissLimit.hit(req.ip); return res.status(404).json({ error: 'הטיול לא נמצא' }); }
    // Without dates there is no question to ask: day 3 of an undated trip is not a
    // Tuesday, and "closed on Tuesdays" means nothing against it.
    if (!trip.start_date) return res.json({ dated: false, stops: {}, summary: null });

    const { rows: items } = await pool.query(
      `SELECT id, day_number, time_label, osm_type, osm_id, google_place_id
       FROM trip_items
       WHERE trip_id = $1 AND (osm_id IS NOT NULL OR google_place_id IS NOT NULL)
       ORDER BY day_number, time_label NULLS LAST
       LIMIT ${MAX_STOPS}`, [trip.id]
    );
    if (!items.length) return res.json({ dated: true, stops: {}, summary: { open: 0, closed: 0, unknown: 0, skipped: 0 } });

    if (lookupLimit.blocked(req.ip)) return res.status(429).json({ error: 'יותר מדי בדיקות שעות — נסו שוב בעוד כמה דקות' });
    lookupLimit.hit(req.ip);

    const stops = {};
    const summary = { open: 0, closed: 0, unknown: 0, skipped: 0 };

    await inBatches(items, CONCURRENCY, async (it) => {
      const date = dateOf(trip.start_date, it.day_number);
      if (!date) { summary.unknown++; return; }
      const hours = await placeHours({
        osmType: it.osm_type, osmId: it.osm_id, googlePlaceId: it.google_place_id,
      }).catch(() => ({ source: 'error' }));
      const v = verifyOpen(hours, date, it.time_label);
      summary[v.verdict] = (summary[v.verdict] || 0) + 1;
      // only the two verdicts a traveller can act on are worth shipping to the page;
      // 'unknown' and 'skipped' are the absence of an answer, and a card that says
      // "we don't know" on two thirds of a trip is noise, not information
      if (v.verdict === 'open' || v.verdict === 'closed') {
        stops[it.id] = {
          verdict: v.verdict,
          source: v.source || null,
          tag: v.tag || null,
          assumedNoon: !!v.assumedNoon,
          ignoresHolidays: !!v.ignoresHolidays,
          // the hours themselves, for the stop sheet: "open" is worth little next to
          // "09:00–18:00", and a shut day reads far better as the hours it keeps on the
          // days it is open than as a bare refusal
          windows: (v.windows || []).map((w) => w.label),
        };
      }
    });

    res.json({ dated: true, stops, summary });
  } catch (err) {
    console.error('hours check failed', err.message);
    // never a 500 to the page: the itinerary renders fine without this
    res.json({ dated: false, stops: {}, summary: null });
  }
});

module.exports = router;
