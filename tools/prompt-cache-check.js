// The chat prompts keep their unchanging part first — checked with no network, no key and
// no database. The provider caches a prompt's prefix and bills it at a fraction, but only
// a prefix that is byte-for-byte the same as the last call's: one changing line near the
// top (the clock moves every minute) and everything after it is paid in full, every turn.
// Pinned here: two turns of the same trip, a minute apart, with a stop added and a
// proposal waiting, share the whole rule text — the planner's system prompt is identical,
// and the trip chat's differs only in its tail. Part of `npm test`.
process.env.DATABASE_URL = '';

const assert = require('assert');
const ai = require('../routes/ai');
const plan = require('../routes/plan');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
};

const trip = { id: 1, title: 'יפן', days: 10, start_date: '2026-10-26', destination: 'Japan', country: 'Japan', dests: [{ name: 'Tokyo', country: 'Japan' }, { name: 'Kyoto', country: 'Japan' }] };
const items1 = [{ id: 1, day_number: 1, time_label: '10:00', category: 'אטרקציה', title: 'סנסו-ג׳י', area: 'Tokyo' }];
const items2 = [...items1, { id: 2, day_number: 2, time_label: '09:00', category: 'אוכל', title: 'שוק צוקיג׳י', area: 'Tokyo' }];
const T1 = new Date('2026-10-26T11:31:00Z');
const T2 = new Date('2026-10-26T11:32:00Z');

// the clock block is built from the real Date — pin it for each turn
const withNow = (now, fn) => {
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now.getTime()])); } static now() { return now.getTime(); } };
  try { return fn(); } finally { global.Date = RealDate; }
};
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };

check('trip chat: rules come before the itinerary and the clock', () => {
  const args = { trip, dests: trip.dests, edit: true, prefs: null, side: { hotels: [], budget: null }, services: [], tz: 'Asia/Tokyo' };
  const a = withNow(T1, () => ai.recsSystemPrompt({ ...args, items: items1 }));
  const b = withNow(T2, () => ai.recsSystemPrompt({ ...args, items: items2 }));
  assert.notStrictEqual(a, b, 'the two turns should differ somewhere');
  const shared = commonPrefix(a, b);
  const tail = a.indexOf('\nהטיול: "');
  assert.ok(tail > 0, 'the trip block is missing');
  assert.ok(shared >= tail, `the turns diverge at char ${shared}, before the trip block at ${tail}`);
  assert.ok(a.lastIndexOf('היום:') > tail, 'the clock should be in the tail');
  assert.ok(tail / a.length > 0.7, `only ${Math.round((tail / a.length) * 100)}% of the prompt is the stable part`);
});

check('planner: the system prompt is the same from turn to turn', () => {
  const state = { stage: 'days', facts: [], areas: [], pending: [] };
  const args = { trip, state, side: { hotels: [], budget: null }, history: [], stepwise: false, services: [], tz: 'Asia/Tokyo' };
  const a = withNow(T1, () => plan.turnPrompt({ ...args, items: items1, pendingProposal: null }));
  const b = withNow(T2, () => plan.turnPrompt({ ...args, items: items2, pendingProposal: 'שוק צוקיג׳י' }));
  assert.strictEqual(a.system, b.system);
  assert.ok(b.user.includes('הצעה ממתינה: שוק צוקיג׳י'), 'the pending proposal moved to the user message');
  assert.ok(a.user.includes('הצעה ממתינה: (אין)'));
});

if (failed) { console.log(`prompt cache: ${failed} failed`); process.exit(1); }
console.log('prompt cache: the stable part of every chat prompt comes first');
process.exit(0);
