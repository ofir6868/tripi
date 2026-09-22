// Can you get from one stop to the next by the hour written on it?
//
// A stop is verified in space (lib/places.js: it exists) and in time (lib/opening-hours.js:
// it is open). This is the third axis, motion: the model writes "10:00 museum, 10:30 lunch"
// with no idea the two are forty minutes apart, and nothing between the build and the
// traveller's morning ever measured it. The measuring is done by OSRM (lib/travel-fit.js on
// the server at build time, public/js/trip-travel.js in the browser on every render); the
// rule for what the measurement means lives HERE, once, so the build and the page cannot
// disagree about which stop is out of reach (PLAYBOOK §2: one definition, one truth).
// Loaded by the browser as a plain script and by the server with require(), like
// public/js/countries.js.
//
// The rule is deliberately timid, in the spirit of lib/hours-fit.js:
//
//   Floors, not      A stop has no duration. Rather than guess how long a traveller stays,
//   estimates.       each category carries the SHORTEST stay that is still a visit — a meal
//                    under three quarters of an hour, a museum under an hour, do not happen.
//                    A leg is called tight only when even that floor plus the road does not
//                    fit in the gap. Everything looser is left alone: this flags the
//                    impossible, not the ambitious.
//   Driving only,    OSRM answers with a car. Within a city that is the right order of
//   and only         magnitude for every mode; between cities it says nothing about the
//   nearby.          train, and a leg longer than MAX_LEG_KM is therefore not judged at all.
//                    A transit stop (category נסיעה) is the journey itself — its own note
//                    carries the time — so a leg into or out of one is not judged either.
//   Forward only,    A move puts the stop at the earliest hour it can be reached, never
//   never past the   earlier, and never past the next stop's written hour: that would
//   next stop.       reorder the day, and the order is the plan. Such a stop is reported.
const TRAVEL_RULES = (() => {
  const MIN_STAY = {
    'אוכל': 45, 'אטרקציה': 60, 'תרבות': 60, 'היסטוריה': 60, 'אמנות': 60, 'טבע': 60,
    'ים': 90, 'קניות': 45, 'חיי לילה': 60, 'עיר': 45, 'נוף': 20,
    'לינה': 0, 'נסיעה': 0,
  };
  const DEFAULT_STAY = 30;
  const MAX_LEG_KM = 120;     // beyond this the mode is unknowable (train? plane?) — say nothing
  const MIN_LEG_MINUTES = 3;  // a hop across the street is not a leg
  const DAY_END = 23 * 60 + 30;
  const ROUND_TO = 5;

  const toMinutes = (label) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(label || '').trim());
    return m ? +m[1] * 60 + +m[2] : null;
  };
  const toLabel = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const minStay = (stop) => {
    const v = MIN_STAY[stop && stop.category];
    return Number.isFinite(v) ? v : DEFAULT_STAY;
  };
  const isTransit = (stop) => !!stop && stop.category === 'נסיעה';

  // stops: ONE day's stops in itinerary order, each { id, time (HH:MM or null), category }.
  // legs: legs[i] is the road from stops[i] to stops[i+1] — { minutes, km } or null when
  // unknown (no coordinates, routing failed). Both come from the caller; this only judges.
  //
  // → { moves: [{ id, from, to, prevId, travel, stay }],
  //     tight: [{ id, from, prevId, travel, stay, earliest, reason }] }
  // moves are hours that make the day work; tight is what could not be fixed without
  // reordering the day, for the caller to say out loud.
  function fitDay(stops, legs) {
    const moves = [];
    const tight = [];
    if (!Array.isArray(stops) || !Array.isArray(legs)) return { moves, tight };
    // ceilings come from the plan as written, so one move never cascades into the next
    const times = stops.map((s) => toMinutes(s.time));
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const leg = legs[i];
      if (!leg || !Number.isFinite(leg.minutes)) continue;            // nothing measured
      if (leg.km > MAX_LEG_KM) continue;                               // not a car's question
      if (isTransit(a) || isTransit(b)) continue;                      // the journey is the stop
      const ta = times[i];
      const tb = times[i + 1];
      if (ta == null || tb == null) continue;                          // no hours to judge
      if (tb < ta) continue;                                           // already out of order — not this rule's business
      const stay = minStay(a);
      const travel = Math.round(leg.minutes);
      if (travel < MIN_LEG_MINUTES) continue;
      const need = stay + travel;
      if (tb - ta >= need) continue;                                   // fits
      const earliest = Math.ceil((ta + need) / ROUND_TO) * ROUND_TO;
      const ceiling = times.slice(i + 2).find((t) => t != null);
      const base = { id: b.id, from: b.time, prevId: a.id, travel, stay, earliest: toLabel(Math.min(earliest, DAY_END)) };
      if (earliest > DAY_END) tight.push({ ...base, reason: 'the day is over by then' });
      else if (ceiling != null && earliest > ceiling) tight.push({ ...base, reason: 'past the next stop', ceiling: toLabel(ceiling) });
      else moves.push({ ...base, to: toLabel(earliest) });
    }
    return { moves, tight };
  }

  return { MIN_STAY, DEFAULT_STAY, MAX_LEG_KM, MIN_LEG_MINUTES, toMinutes, toLabel, minStay, fitDay };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TRAVEL_RULES;
