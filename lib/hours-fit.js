// Move a stop to an hour the door is actually open at.
//
// lib/opening-hours.js answers whether a stop is shut when we sent someone to it. That
// is worth having, but it arrives after the fact: the traveller reads a warning about a
// plan the model already wrote. Three of the five closed doors in the first production
// audit were the same shape — a museum at 09:00 that opens at 10:00, an aquarium the
// same, a dinner-only sushi bar booked for breakfast — and all three are a wrong hour on
// a right day, which is a thing a build can simply not do.
//
// The rules below are deliberately timid, because this edits an itinerary a person will
// follow:
//
//   Forward only.   A stop moves to the start of the next window that opens after it,
//                   never to an earlier one. Moving a 22:00 dinner to 09:00 because that
//                   is when the place was last open is not a fix, it is a different trip.
//   Never past the  A move that would carry a stop beyond the next stop's hour is
//   next stop.      refused: it would reorder the day, and the order is the plan. The
//                   stop is reported instead.
//   Never on a      A place shut all day is reported, never moved to another day. Which
//   guess.          day to move it to is a question about the whole itinerary, and the
//                   traveller may have picked that day for it.
//   Silence is      No hours, an unreadable tag, an unreachable source: nothing happens.
//   not a licence.  Only a known window ever moves anything.
//
// What it cannot reach still gets reported — routes/hours.js keeps marking closed doors
// on the page, because a stop added by hand or an hour changed by hand never passes
// through here at all.
const { openWindows, placeHours } = require('./opening-hours');

const toMinutes = (label) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(label || ''));
  return m ? +m[1] * 60 + +m[2] : null;
};
const toLabel = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// entries: [{ id, time, hours }] for ONE day, in the order they appear in the itinerary.
// date: that day's real calendar date.
//
// → { moves: [{ id, from, to, window }], shut: [{ id, time, reason, windows }] }
//   moves are hours to apply; shut is what the caller could not fix and may want to say
//   out loud, to the model or to the traveller.
function fitDay(entries, date) {
  const moves = [];
  const shut = [];
  if (!date || !Array.isArray(entries)) return { moves, shut };

  // the ceiling for each stop is the next stop that has an hour of its own, taken from
  // the plan as written — not from the hours this pass is handing out, so one move can
  // never cascade into shoving the whole afternoon later
  const times = entries.map((e) => toMinutes(e.time));

  entries.forEach((e, i) => {
    const at = times[i];
    if (at == null) return;                       // no hour of its own: nothing to correct
    const windows = openWindows(e.hours, date);
    if (windows === null) return;                 // nothing known — say nothing, do nothing

    if (!windows.length) {
      shut.push({ id: e.id, time: e.time, reason: 'shut all day', windows: [] });
      return;
    }
    if (windows.some((w) => at >= w.from && at < w.to)) return; // already fine

    const next = windows.find((w) => w.from > at);
    if (!next) {
      shut.push({ id: e.id, time: e.time, reason: 'the day is over by then', windows });
      return;
    }
    const ceiling = times.slice(i + 1).find((t) => t != null);
    if (ceiling != null && next.from > ceiling) {
      shut.push({ id: e.id, time: e.time, reason: 'opens after the next stop', windows });
      return;
    }
    moves.push({ id: e.id, from: e.time, to: toLabel(next.from), window: next.label });
  });

  return { moves, shut };
}

/* ------------------------- the whole itinerary, at build time ------------------------ */

const dateOf = (start, day) => {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + day - 1);
  return d;
};

// Look the hours up for a built itinerary and correct the hours that do not work, in
// place. Best effort by design, and on a clock: a build already keeps a traveller
// waiting on several model calls, and holding it longer on someone else's geocoder to
// perfect an itinerary they have not seen yet is the trade PLAYBOOK §3 says not to make.
// Past the budget the remaining stops are simply left alone — they still get the mark on
// the page, which is the same answer arriving later.
//
// It only ever moves stops WITHIN their own day, and only to an hour the place is open
// (see fitDay). A trip with no dates is not touched at all, because day 3 of an undated
// trip is not a Tuesday.
async function fitItinerary(items, { startDate, budgetMs = 12000, concurrency = 6 } = {}) {
  const report = { checked: 0, moved: [], shut: [] };
  if (!startDate || !Array.isArray(items) || !items.length) return report;
  const deadline = Date.now() + budgetMs;

  const withPlace = items.filter((it) => it.osm_id || it.google_place_id);
  const hoursFor = new Map();
  for (let i = 0; i < withPlace.length; i += concurrency) {
    if (Date.now() > deadline) break;
    await Promise.all(withPlace.slice(i, i + concurrency).map(async (it) => {
      const h = await placeHours({
        osmType: it.osm_type, osmId: it.osm_id, googlePlaceId: it.google_place_id,
      }).catch(() => null);
      if (h) hoursFor.set(it, h);
      report.checked++;
    }));
  }
  if (!hoursFor.size) return report;

  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
    byDay.get(it.day_number).push(it);
  }

  for (const [day, dayItems] of byDay) {
    const date = dateOf(startDate, day);
    if (!date) continue;
    const ordered = dayItems.slice().sort((a, b) =>
      String(a.time_label || '').localeCompare(String(b.time_label || '')));
    const { moves, shut } = fitDay(
      ordered.map((it) => ({ id: it, time: it.time_label, hours: hoursFor.get(it) || null })), date
    );
    for (const m of moves) {
      m.id.time_label = m.to; // m.id is the item itself — fitDay never looks inside it
      report.moved.push({ day, title: m.id.title, from: m.from, to: m.to, window: m.window });
    }
    for (const s of shut) report.shut.push({ day, title: s.id.title, time: s.time, reason: s.reason });
  }
  return report;
}

module.exports = { fitDay, fitItinerary, _test: { toMinutes, toLabel, dateOf } };
