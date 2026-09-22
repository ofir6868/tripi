// Move a stop to an hour it can actually be reached at.
//
// The third verification a built itinerary gets, after the place (lib/places.js) and the
// door (lib/hours-fit.js): the road. The model writes an hour for every stop with no idea
// how far the previous one is, and until now nothing between the build and the traveller
// measured it — the page drew the driving time under each card and never compared it to
// the clock beside it. The rule for what counts as out of reach lives in
// public/js/travel-rules.js, shared with the page, so the two cannot disagree; this file
// is the road itself (OSRM, keyless, cached) and the pass over a whole itinerary.
//
// Same manners as hours-fit: forward only, inside the day, never past the next stop's
// written hour, best effort on a clock, and an unreachable router changes nothing — a
// leg that could not be measured is not evidence about the plan.
const { cacheGet, cacheSet, once } = require('./api-budget');
const RULES = require('../public/js/travel-rules');

const SCOPE = 'osrm_legs';
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
const MAX_POINTS = 25; // the public server's own per-request cap

// [{lat, lon}] → [{minutes, km}] between consecutive points, or null when the router did
// not answer. Cached per coordinate chain (4 decimals ≈ 11m, so a stop nudged on the map
// still hits), and a failure is never cached — a blip is not an answer.
async function routeLegs(points, { timeoutMs = 6000 } = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lon)).slice(0, MAX_POINTS);
  if (pts.length < 2) return null;
  const key = pts.map((p) => `${(+p.lon).toFixed(4)},${(+p.lat).toFixed(4)}`).join(';');
  const hit = await cacheGet(SCOPE, key);
  if (hit.hit) return hit.value;
  return once(SCOPE + key, async () => {
    const again = await cacheGet(SCOPE, key);
    if (again.hit) return again.value;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${OSRM}/route/v1/driving/${key}?overview=false`, {
        signal: ctrl.signal, headers: { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; travel legs)' },
      });
      if (!res.ok) {
        console.warn(`travel-fit: OSRM answered ${res.status} for ${pts.length} points`);
        return null;
      }
      const data = await res.json();
      const legs = data && data.routes && data.routes[0] && data.routes[0].legs;
      if (!Array.isArray(legs) || legs.length !== pts.length - 1) {
        console.warn(`travel-fit: OSRM gave no route (${(data && data.code) || 'no code'})`);
        return null;
      }
      const out = legs.map((l) => ({ minutes: Math.round(l.duration / 60), km: +(l.distance / 1000).toFixed(1) }));
      await cacheSet(SCOPE, key, out);
      return out;
    } catch (err) {
      console.warn(`travel-fit: OSRM ${err.name === 'AbortError' ? 'timed out' : 'failed: ' + err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

const timeOf = (it) => String(it.time_label || '');

// One day's stops, in itinerary order, cut into runs of consecutive located stops — a
// stop with no coordinates breaks the chain, exactly as the page does it.
function locatedRuns(dayItems) {
  const runs = [];
  let run = [];
  for (const it of dayItems) {
    if (it.lat != null && it.lon != null) run.push(it);
    else { if (run.length > 1) runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// Measure every day's legs and correct, in place, the hours that cannot be kept.
// Undated trips are checked too: a road is the same length on any date.
async function fitItinerary(items, { budgetMs = 8000, concurrency = 4 } = {}) {
  const report = { legs: 0, moved: [], tight: [] };
  if (!Array.isArray(items) || items.length < 2) return report;
  const deadline = Date.now() + budgetMs;

  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
    byDay.get(it.day_number).push(it);
  }
  const jobs = [];
  for (const [day, dayItems] of byDay) {
    const ordered = dayItems.slice().sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
    for (const run of locatedRuns(ordered)) jobs.push({ day, run });
  }
  for (let i = 0; i < jobs.length; i += concurrency) {
    if (Date.now() > deadline) break;
    await Promise.all(jobs.slice(i, i + concurrency).map(async ({ day, run }) => {
      const legs = await routeLegs(run).catch(() => null);
      if (!legs) return;
      report.legs += legs.length;
      const { moves, tight } = RULES.fitDay(
        run.map((it) => ({ id: it, time: it.time_label, category: it.category })), legs
      );
      for (const m of moves) {
        m.id.time_label = m.to; // m.id is the item itself — fitDay never looks inside it
        report.moved.push({ day, title: m.id.title, from: m.from, to: m.to, travel: m.travel, after: m.prevId.title });
      }
      for (const t of tight) {
        report.tight.push({ day, title: t.id.title, time: t.from, travel: t.travel, earliest: t.earliest, reason: t.reason, after: t.prevId.title });
      }
    }));
  }
  return report;
}

module.exports = { routeLegs, fitItinerary, _test: { locatedRuns } };
