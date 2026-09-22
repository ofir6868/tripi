// The road rule (public/js/travel-rules.js) and the build pass over it (lib/travel-fit.js),
// checked without a network, a key or a database. `node tools/travel-fit-check.js`
//
// Every case is a day someone could have been handed — the shapes the rule exists for at
// the top, and below them the shapes it must REFUSE to touch: a wrong move rearranges a
// plan a traveller will follow, so anything the rule cannot be sure of has to stay put.
process.env.DATABASE_URL = ''; // lib/api-budget falls back to in-process counters and cache
const RULES = require('../public/js/travel-rules');

let failures = 0;
const check = (why, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${why}${pass ? '' : ` — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

const stop = (id, time, category = 'אטרקציה') => ({ id, time, category });
const leg = (minutes, km = 5) => ({ minutes, km });
const moved = (r) => r.moves.map((m) => [m.id, m.to]);
const tightIds = (r) => r.tight.map((t) => [t.id, t.reason]);

console.log('The rule (public/js/travel-rules.js)\n');

// --- the shape this exists for ---------------------------------------------------
let r = RULES.fitDay([stop(1, '10:00'), stop(2, '10:30', 'אוכל')], [leg(40)]);
check('a museum at 10:00 and lunch 40 minutes away at 10:30: lunch moves to 11:40', moved(r), [[2, '11:40']]);
check('and nothing is reported', tightIds(r), []);

r = RULES.fitDay([stop(1, '10:00'), stop(2, '13:00', 'אוכל')], [leg(40)]);
check('three hours later fits, and is left alone', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, '10:00', 'אוכל'), stop(2, '10:50')], [leg(10)]);
check('a meal is at least 45 minutes: the next stop 50 minutes on, ten away, moves to 10:55', moved(r), [[2, '10:55']]);

r = RULES.fitDay([stop(1, '10:00', 'נוף'), stop(2, '10:30')], [leg(10)]);
check('a viewpoint is a short stop: 20 minutes plus the road fits in half an hour', moved(r), []);

r = RULES.fitDay([stop(1, '09:00'), stop(2, '09:20'), stop(3, '12:00')], [leg(30), leg(10)]);
check('the second stop moves to 10:30, under the third\'s 12:00', moved(r), [[2, '10:30']]);

// --- the timidity ---------------------------------------------------------------------
r = RULES.fitDay([stop(1, '09:00'), stop(2, '09:20'), stop(3, '10:00')], [leg(30), leg(10)]);
check('a move that would jump the next stop is refused and reported', tightIds(r), [[2, 'past the next stop']]);
check('with the ceiling it hit', r.tight[0].ceiling, '10:00');
check('the third stop is judged from the second\'s WRITTEN hour, and moves under nothing', moved(r), [[3, '10:30']]);

r = RULES.fitDay([stop(1, '22:30'), stop(2, '22:45')], [leg(50)]);
check('past midnight is reported, never scheduled', tightIds(r), [[2, 'the day is over by then']]);

r = RULES.fitDay([stop(1, '09:00'), stop(2, '09:20'), stop(3, '09:40')], [leg(30), leg(30)]);
check('ceilings are the plan as written: the second stop is refused (10:30 is past 09:40)', tightIds(r), [[2, 'past the next stop']]);
check('and the third moves from the second\'s written 09:20, not from where it would have gone', moved(r), [[3, '10:50']]);

r = RULES.fitDay([stop(1, '10:00'), stop(2, '10:30')], [leg(2)]);
check('a hop across the street is not a leg', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, '10:00'), stop(2, '11:00')], [leg(300, 400)]);
check('a 400 km leg is not a car\'s question (train? plane?) — nothing is said', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, '08:00', 'נסיעה'), stop(2, '09:00')], [leg(180, 90)]);
check('a leg out of a transit stop is the journey itself, not judged', [moved(r), tightIds(r)], [[], []]);
r = RULES.fitDay([stop(1, '08:00'), stop(2, '09:00', 'נסיעה')], [leg(180, 90)]);
check('nor a leg into one', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, null), stop(2, '10:30')], [leg(40)]);
check('a stop with no hour judges nothing', [moved(r), tightIds(r)], [[], []]);
r = RULES.fitDay([stop(1, '10:00'), stop(2, 'אחה״צ')], [leg(40)]);
check('nor does a stop whose hour is a word', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, '10:00'), stop(2, '10:30')], [null]);
check('a leg the router could not measure is not evidence', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, '14:00'), stop(2, '10:30')], [leg(40)]);
check('a day already out of order is not this rule\'s business', [moved(r), tightIds(r)], [[], []]);

r = RULES.fitDay([stop(1, '10:00', 'משהו אחר'), stop(2, '10:20')], [leg(10)]);
check('an unknown category gets the default floor (30 min)', moved(r), [[2, '10:40']]);

// --- the whole itinerary, at build time, with the router stubbed -------------------------
console.log('\nA built itinerary, corrected before anyone sees it (lib/travel-fit.js)\n');
(async () => {
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const chain = decodeURIComponent(u.split('/driving/')[1].split('?')[0]).split(';');
    // one leg per pair, 40 minutes each, except a chain the "router" fails on
    if (chain.some((c) => c.endsWith(',99.0000') || c.endsWith(',99.0100'))) return { ok: false, status: 500, text: async () => 'boom' };
    const legs = chain.slice(1).map(() => ({ duration: 40 * 60, distance: 8000 }));
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ legs }] }) };
  };
  const { fitItinerary } = require('../lib/travel-fit');
  const items = [
    { day_number: 1, time_label: '10:00', title: 'museum', category: 'אטרקציה', lat: 41.9, lon: 12.5 },
    { day_number: 1, time_label: '10:30', title: 'lunch', category: 'אוכל', lat: 41.91, lon: 12.51 },
    { day_number: 1, time_label: '16:00', title: 'gardens', category: 'טבע', lat: 41.92, lon: 12.52 },
    { day_number: 2, time_label: '09:00', title: 'unlocated', category: 'אטרקציה', lat: null, lon: null },
    { day_number: 2, time_label: '09:10', title: 'after it', category: 'אטרקציה', lat: 41.93, lon: 12.53 },
    { day_number: 3, time_label: '09:00', title: 'router down', category: 'אטרקציה', lat: 99.0, lon: 12.5 },
    { day_number: 3, time_label: '09:10', title: 'still 09:10', category: 'אטרקציה', lat: 99.01, lon: 12.51 },
  ];
  const rep = await fitItinerary(items);
  check('lunch 40 minutes from the museum moves to 11:40', items[1].time_label, '11:40');
  check('the gardens, hours later, are untouched', items[2].time_label, '16:00');
  check('a stop after an unlocated one has no leg to judge', items[4].time_label, '09:10');
  check('a router that fails changes nothing', items[6].time_label, '09:10');
  check('the report names the move', rep.moved.map((m) => [m.day, m.title, m.from, m.to]), [[1, 'lunch', '10:30', '11:40']]);
  check('one request per day chain, none for the unroutable day', asked.length, 2);
  const again = await fitItinerary([
    { day_number: 1, time_label: '10:00', title: 'museum', category: 'אטרקציה', lat: 41.9, lon: 12.5 },
    { day_number: 1, time_label: '10:30', title: 'lunch', category: 'אוכל', lat: 41.91, lon: 12.51 },
    { day_number: 1, time_label: '16:00', title: 'gardens', category: 'טבע', lat: 41.92, lon: 12.52 },
  ]);
  check('the same chain again is answered from the cache', [asked.length, again.moved.length], [2, 1]);
  const spent = [{ day_number: 1, time_label: '10:00', category: 'אטרקציה', lat: 41.9, lon: 12.5, title: 'a' },
    { day_number: 1, time_label: '10:30', category: 'אוכל', lat: 41.95, lon: 12.55, title: 'b' }];
  await fitItinerary(spent, { budgetMs: -1 });
  check('a spent time budget changes nothing', spent[1].time_label, '10:30');

  console.log(`\n${failures ? failures + ' failure(s)' : 'all correct'}`);
  process.exit(failures ? 1 : 0);
})();
