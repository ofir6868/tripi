// What day it is, and what a date change does — checked with no network, no key and no
// database. Two failures from 2026-11-01 are pinned here: the planner asking a traveller
// in Takayama what today's date was (lib/trip-clock.js gives every prompt the date, the
// destination's clock and the trip's calendar), and a date change that came back "not
// done" — once because the trip already had that date, once because the trip's length
// could not change at all (lib/plan-actions.js dates_set). Part of `npm test`.
process.env.DATABASE_URL = '';

const assert = require('assert');
const clock = require('../lib/trip-clock');
const actions = require('../lib/plan-actions');

let failed = 0;
const pending = [];
const check = (name, fn) => {
  pending.push((async () => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
  })());
};

// ---- the clock ----
// 2026-10-26 11:31 UTC: 13:31 in Israel (winter time since the 25th), 20:31 in Takayama —
// the phone clock on the first screenshot
const NOW = new Date('2026-10-26T11:31:00Z');

check('a pg DATE (local midnight) reads as its own calendar day', () => {
  assert.strictEqual(clock.isoOf(new Date(2026, 9, 26)), '2026-10-26');
  assert.strictEqual(clock.isoOf('2026-10-26'), '2026-10-26');
  assert.strictEqual(clock.isoOf(null), null);
});
check('today is in the prompt, in Israel and at the destination', () => {
  const b = clock.promptBlock({ days: 23, start_date: '2026-10-26' }, { tz: 'Asia/Tokyo', now: NOW });
  assert(b.includes('2026-10-26'), b);
  assert(b.includes('13:31'), 'Israel clock');
  assert(b.includes('20:31'), 'destination clock');
  assert(b.includes('היום הוא יום 1 מתוך 23'), b);
  assert(b.includes('ומחר יום 2'), b);
});
check('the calendar names every trip day with its date', () => {
  const b = clock.promptBlock({ days: 23, start_date: '2026-10-26' }, { now: NOW });
  assert(b.includes('1=26.10 ב׳'), b);
  assert(b.includes('23=17.11 ג׳'), b);
});
check('during the trip, "today" is the destination\'s day', () => {
  // 23:30 in Israel on the 27th is already the 28th in Tokyo — trip day 3
  const b = clock.promptBlock({ days: 10, start_date: '2026-10-26' }, { tz: 'Asia/Tokyo', now: new Date('2026-10-27T21:30:00Z') });
  assert(b.includes('היום הוא יום 3'), b);
});
check('before and after the trip, and undated', () => {
  assert(clock.promptBlock({ days: 5, start_date: '2026-11-05' }, { now: NOW }).includes('יוצאים בעוד 10 ימים'));
  assert(clock.promptBlock({ days: 5, start_date: '2026-10-01' }, { now: NOW }).includes('הטיול הסתיים לפני 21 ימים'));
  assert(clock.promptBlock({ days: 5, start_date: null }, { now: NOW }).includes('אין עדיין תאריך יציאה'));
});
check('a stop line carries its date', () => {
  assert.strictEqual(clock.dayLabel({ start_date: '2026-10-26' }, 3), 'יום 3 (28.10, ד׳)');
  assert.strictEqual(clock.dayLabel({ start_date: null }, 3), 'יום 3');
});

// ---- dates_set: cleaning ----
const trip0 = () => ({ id: 1, days: 20, start_date: '2026-10-26' });

check('"from the 26th to the 17th" is a start and a length', () => {
  const [a] = actions.cleanActions([{ kind: 'dates_set', start_date: '2026-10-26', end_date: '2026-11-17' }], trip0(), []);
  assert.deepStrictEqual(a, { kind: 'dates_set', start_date: '2026-10-26', end_date: null, days: 23, keep_calendar: false });
  assert(actions.describeAction(a).title.includes('17 בנובמבר 2026'));
});
check('an end before the start, or past the ceiling, is dropped', () => {
  assert.strictEqual(actions.cleanActions([{ kind: 'dates_set', start_date: '2026-10-26', end_date: '2026-10-20' }], trip0(), []).length, 0);
  assert.strictEqual(actions.cleanActions([{ kind: 'dates_set', start_date: '2026-01-01', end_date: '2026-12-31' }], trip0(), []).length, 0);
});
check('a hotel in the new last nights survives the cleaner beside the lengthening', () => {
  const out = actions.cleanActions([
    { kind: 'hotel_add', name: 'Park Hyatt', night_start: 20, night_end: 22, status: 'booked' },
    { kind: 'dates_set', start_date: '2026-10-26', end_date: '2026-11-17' },
  ], trip0(), []);
  assert.strictEqual(out[0].night_end, 22);
});
check('the action schema stays strict (every property required)', () => {
  const s = actions.ACTION_SCHEMA;
  assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort());
});

// ---- dates_set: writing, against a fake database ----
function fakeDb({ start, days, items = [], hotels = [] }) {
  const db = { start, days, items: items.map((d, i) => ({ id: i + 1, day_number: d })), hotels: hotels.map((h) => ({ ...h })) };
  db.query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ');
    if (/^SELECT start_date, days FROM trips/.test(q)) return { rows: [{ start_date: db.start, days: db.days }] };
    if (/^SELECT DISTINCT day_number FROM trip_items/.test(q)) {
      const [, shift, n] = p;
      return { rows: [...new Set(db.items.map((i) => i.day_number).filter((d) => d + shift < 1 || d + shift > n))].sort((a, b) => a - b).map((d) => ({ day_number: d })) };
    }
    if (/^SELECT name FROM trip_hotels/.test(q)) {
      const [, shift, last] = p;
      return { rows: db.hotels.filter((h) => h.night_start + shift < 1 || h.night_end + shift > last) };
    }
    if (/^UPDATE trip_items SET day_number = day_number \+ \$1/.test(q)) { db.items.forEach((i) => { i.day_number += p[0]; }); return { rows: [] }; }
    if (/^UPDATE trip_hotels SET night_start = night_start \+ \$1/.test(q)) { db.hotels.forEach((h) => { h.night_start += p[0]; h.night_end += p[0]; }); return { rows: [] }; }
    if (/^UPDATE trip_expenses/.test(q) || /^DELETE FROM trip_day_recs/.test(q)) return { rows: [] };
    if (/^UPDATE trips SET start_date = \$1::date, days = \$2,/.test(q)) { db.start = p[0]; db.days = p[1]; return { rows: [] }; }
    if (/^UPDATE trips SET start_date = \$1::date, days = COALESCE/.test(q)) { db.start = p[0]; if (p[1]) db.days = p[1]; return { rows: [] }; }
    throw new Error('unexpected SQL: ' + q.slice(0, 80));
  };
  return db;
}

check('a date the trip already has is "already so", not a refusal', async () => {
  const db = fakeDb({ start: new Date(2026, 9, 26), days: 20 });
  const r = await actions.applyActions(db, trip0(), [{ kind: 'dates_set', start_date: '2026-10-26', end_date: null, days: null, keep_calendar: false }]);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.already, 1);
  assert.strictEqual(r.skipped.length, 0);
});
check('lengthening writes the new length, and the undo takes it back', async () => {
  const db = fakeDb({ start: '2026-10-26', days: 20, items: [1, 5, 20] });
  const trip = trip0();
  const r = await actions.applyActions(db, trip, [{ kind: 'dates_set', start_date: '2026-10-26', end_date: null, days: 23, keep_calendar: false }]);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(db.days, 23);
  assert.strictEqual(trip.days, 23, 'the ops after it read the new length');
  assert.deepStrictEqual(r.calendar, { shift: 0, days: 23 });
  const u = await actions.undoActions(db, trip, r.undo);
  assert.strictEqual(db.days, 20);
  assert.deepStrictEqual(u.calendar, { shift: 0, days: 20 });
});
check('day 1 moved a day earlier with keep_calendar: the stops keep their dates', async () => {
  const db = fakeDb({ start: '2026-10-27', days: 20, items: [1, 2, 20], hotels: [{ name: 'Hilton', night_start: 1, night_end: 3 }] });
  const trip = { id: 1, days: 20, start_date: '2026-10-27' };
  const r = await actions.applyActions(db, trip, [{ kind: 'dates_set', start_date: '2026-10-26', end_date: null, days: 21, keep_calendar: true }]);
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(db.items.map((i) => i.day_number), [2, 3, 21]);
  assert.deepStrictEqual([db.hotels[0].night_start, db.hotels[0].night_end], [2, 4]);
  await actions.undoActions(db, trip, r.undo);
  assert.deepStrictEqual(db.items.map((i) => i.day_number), [1, 2, 20]);
  assert.strictEqual(db.start, '2026-10-27');
});
check('shortening past a planned day refuses, with the days it would lose', async () => {
  const db = fakeDb({ start: '2026-10-26', days: 20, items: [3, 19, 20] });
  const r = await actions.applyActions(db, trip0(), [{ kind: 'dates_set', start_date: '2026-10-26', end_date: null, days: 18, keep_calendar: false }]);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(db.days, 20, 'nothing written');
  assert(/19, 20/.test(r.skipped[0].reason), r.skipped[0].reason);
});

Promise.all(pending).then(() => {
  console.log(failed ? `${failed} failed` : 'trip clock: all good');
  process.exit(failed ? 1 : 0);
});
