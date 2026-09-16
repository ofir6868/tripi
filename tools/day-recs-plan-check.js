// The shape of a free-day picks pass, checked without a database or a model:
//   node tools/day-recs-plan-check.js
// Exits 1 on a trip whose picks would be asked for badly. What "badly" means is what
// a 30-day trip taught us (routes/day-recs.js): a call that spans two areas, a call
// with more days in it than the model can answer well, days asked for out of order —
// and, worst of all, a free day that falls outside every batch and is never asked for
// at all, which is the skeleton that never fills.
//
// It also checks the other half: which days a change actually invalidates. A stop
// added on day 3 of a month-long trip must cost the days around day 3 and nothing
// else — that is the difference between two model calls and thirty.
const recs = require('../routes/day-recs.js');

const CAP = recs.DAYS_PER_CALL;
const stop = (day, title, area) => ({ id: day * 100 + title.length, day_number: day, title, area: area || null });

// a trip, as the pass sees it: days, destinations, the settled split (plan_state) and
// whatever stops are already on the itinerary
const CASES = [
  {
    name: '30 days, one country, nothing settled and nothing planned',
    trip: { id: 1, title: 'יפן', days: 30, destination: 'יפן', destinations: [{ name: 'יפן', country: 'יפן' }], plan_state: {} },
    items: [],
    // no split anywhere — the model is asked for one, and without a key the pass still
    // has to cover the trip: one area, batched by the cap
    wantSource: 'one block',
    wantBatches: 5,
  },
  {
    name: '30 days, the split the planning chat settled',
    trip: {
      id: 2, title: 'יפן', days: 30, destination: 'יפן', destinations: [{ name: 'יפן', country: 'יפן' }],
      plan_state: {
        areas: [
          { area: 'טוקיו והסביבה', from: 1, to: 8, cities: ['טוקיו', 'ניקו'] },
          { area: 'האלפים היפניים', from: 9, to: 16, cities: ['טקאיאמה'] },
          { area: 'קנסאי', from: 17, to: 24, cities: ['קיוטו', 'אוסקה'] },
          { area: 'הוקאידו', from: 25, to: 30, cities: ['סאפורו'] },
        ],
      },
    },
    items: [stop(1, 'נחיתה בהאנדה'), stop(17, 'רכבת לקיוטו')],
    wantSource: 'settled',
    wantAreas: 4,
  },
  {
    name: '30 days, a split that stops at day 20 — not the one they were shown',
    trip: {
      id: 3, title: 'יפן', days: 30, destination: 'יפן', destinations: [{ name: 'יפן', country: 'יפן' }],
      plan_state: { areas: [{ area: 'טוקיו', from: 1, to: 10, cities: [] }, { area: 'קנסאי', from: 11, to: 20, cities: [] }] },
    },
    items: [],
    wantSource: 'one block', // a partial split is not used: the model is asked instead
  },
  {
    name: '18 days across three countries, areas pinned by the stops',
    trip: {
      id: 4, title: 'הטיול הגדול', days: 18, destination: 'פרו',
      destinations: [{ name: 'פרו', country: 'פרו' }, { name: 'בוליביה', country: 'בוליביה' }, { name: 'צ׳ילה', country: 'צ׳ילה' }],
      plan_state: {},
    },
    items: [stop(1, 'לימה', 'פרו'), stop(7, 'קוסקו', 'פרו'), stop(9, 'לה פאס', 'בוליביה'), stop(14, 'אטקמה', 'צ׳ילה')],
    wantSource: 'itinerary',
    wantAreas: 3,
  },
  {
    name: '4 days in Crete — nothing to split',
    trip: { id: 5, title: 'כרתים', days: 4, destination: 'כרתים', destinations: [{ name: 'כרתים', country: 'יוון' }], plan_state: {} },
    items: [stop(2, 'חוף אלפוניסי')],
    wantSource: 'one block',
    wantBatches: 1,
  },
  {
    name: '12 days, half of them already planned',
    trip: {
      id: 6, title: 'איטליה', days: 12, destination: 'איטליה',
      destinations: [{ name: 'רומא', country: 'איטליה' }, { name: 'טוסקנה', country: 'איטליה' }],
      plan_state: {},
    },
    items: [stop(1, 'קולוסיאום', 'רומא'), stop(2, 'ותיקן', 'רומא'), stop(3, 'טרסטוורה', 'רומא'),
      stop(7, 'פירנצה', 'טוסקנה'), stop(8, 'סיינה', 'טוסקנה'), stop(12, 'טיסה הביתה', 'טוסקנה')],
    wantSource: 'itinerary',
  },
];

const freeDaysOf = (trip, items) => recs.freeDays(trip, items);

function sourceOf(blocks, trip, items) {
  if (blocks.length === 1 && blocks[0].from === 1 && blocks[0].to === trip.days && !blocks[0].cities.length) return 'one block';
  const settled = (trip.plan_state || {}).areas || [];
  if (settled.length === blocks.length && settled.every((a, i) => a.area === blocks[i].area && a.from === blocks[i].from)) return 'settled';
  return 'itinerary';
}

let bad = 0;
const fail = (msg) => { bad++; console.log(`   ✗ ${msg}`); };

(async () => {
  for (const c of CASES) {
    const free = freeDaysOf(c.trip, c.items);
    const blocks = await recs.areaPlan(c.trip, c.items, { ph: null });
    const source = sourceOf(blocks, c.trip, c.items);
    const batches = recs.batchesOf(blocks, free);
    console.log(`\n${c.name}`);
    console.log(`   ${blocks.length} אזורים (${source}): ${blocks.map((b) => `${b.area} ${b.from}-${b.to}`).join(' | ')}`);
    console.log(`   ${free.length} ימים פנויים → ${batches.length} בקשות: ${batches.map((b) => `${b.block.area} [${b.days[0]}-${b.days[b.days.length - 1]}]`).join(' ')}`);

    // 1. the areas cover the trip, in order, with no gaps
    if (blocks[0].from !== 1 || blocks[blocks.length - 1].to !== c.trip.days) fail('the areas do not cover the trip');
    for (let i = 1; i < blocks.length; i++) if (blocks[i].from !== blocks[i - 1].to + 1) fail(`a gap between ${blocks[i - 1].area} and ${blocks[i].area}`);

    // 2. every free day is asked for exactly once, and no call is too big or crosses an area
    const asked = batches.flatMap((b) => b.days);
    if (asked.length !== new Set(asked).size) fail('a day is asked for twice');
    if (asked.length !== free.length) fail(`${free.length - asked.length} free day(s) are never asked for`);
    for (const b of batches) {
      if (b.days.length > CAP) fail(`a call covers ${b.days.length} days (cap ${CAP})`);
      if (b.days.some((d) => d < b.block.from || d > b.block.to)) fail(`a call crosses out of ${b.block.area}`);
      if (b.days.some((d, i) => i && d < b.days[i - 1])) fail('a call lists its days out of order');
    }
    // 3. chronological: the calls start from the first day of the trip and go down
    for (let i = 1; i < batches.length; i++) {
      if (batches[i].days[0] < batches[i - 1].days[0]) fail('the calls are not in day order');
    }
    if (c.wantSource && source !== c.wantSource) fail(`the split came from "${source}", expected "${c.wantSource}"`);
    if (c.wantAreas && blocks.length !== c.wantAreas) fail(`${blocks.length} areas, expected ${c.wantAreas}`);
    if (c.wantBatches && batches.length !== c.wantBatches) fail(`${batches.length} calls, expected ${c.wantBatches}`);

    // 4. what a day's picks depend on: its area and the stops on either side of it
    const ctxOf = (items) => new Map(freeDaysOf(c.trip, items).map((d) => [d, recs.dayContext(c.trip, items, d, blocks).sig]));
    const before = ctxOf(c.items);
    const touched = free.find((d) => d > 2 && d < c.trip.days - 1);
    if (touched) {
      const after = ctxOf([...c.items, stop(touched, 'תחנה חדשה', blocks[0].area)]);
      const changed = [...before.keys()].filter((d) => before.get(d) !== after.get(d));
      const far = changed.filter((d) => Math.abs(d - touched) > 1);
      console.log(`   תחנה ביום ${touched} משנה ${changed.length} ימים: ${changed.join(', ') || '—'}`);
      if (far.length) fail(`a stop on day ${touched} invalidated distant day(s) ${far.join(', ')}`);
    }
  }
  console.log(bad ? `\n${bad} problem(s)` : '\nevery trip is asked for in order, in one-area calls, with every free day covered');
  process.exit(bad ? 1 : 0);
})();
