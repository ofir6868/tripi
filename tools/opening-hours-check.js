// The opening-hours parser and evaluator, checked against real tag shapes — no network,
// no keys, no cost. `node tools/opening-hours-check.js`
//
// Every fixture is a tag that actually occurs in OSM, a real calendar day, and the
// answer a human reading the tag would give. The ones that matter most are at the
// bottom: the tags this parser must REFUSE to answer. A wrong 'closed' sends a traveller
// away from an open door, so anything ambiguous has to come back 'unknown'.
const { verifyOpen, _test } = require('../lib/opening-hours');

const HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const d = (y, m, day) => new Date(y, m - 1, day);

// A September 2026 week, so every weekday below is a real one:
const MON = d(2026, 9, 14), TUE = d(2026, 9, 15), WED = d(2026, 9, 16);
const FRI = d(2026, 9, 18), SAT = d(2026, 9, 19), SUN = d(2026, 9, 20);
const JAN = d(2027, 1, 13); // a Wednesday in deep winter

// the Louvre's actual opening_hours tag, as OSM carries it
const LOUVRE = 'Mo,Th,Sa-Su 09:00-18:00; Tu off; We,Fr 09:00-21:00; Jan 01,May 01,Dec 25 off';

const CASES = [
  // --- the everyday shapes -------------------------------------------------
  ['24/7', WED, '03:00', 'open', 'a 24/7 place at three in the morning'],
  ['Mo-Fr 09:00-17:00', MON, '10:00', 'open', 'weekday inside the window'],
  ['Mo-Fr 09:00-17:00', MON, '18:00', 'closed', 'weekday after closing'],
  ['Mo-Fr 09:00-17:00', SAT, '10:00', 'closed', 'a weekday-only place on Saturday'],
  ['Mo-Fr 09:00-17:00', MON, '09:00', 'open', 'the opening minute is open'],
  ['Mo-Fr 09:00-17:00', MON, '17:00', 'closed', 'the closing minute is not'],

  // --- the one this whole feature exists for -------------------------------
  ['Tu-Su 09:00-18:00; Mo off', MON, '10:00', 'closed', 'THE MUSEUM THAT SHUTS ON MONDAY'],
  ['Tu-Su 09:00-18:00; Mo off', TUE, '10:00', 'open', 'and is open on Tuesday'],
  ['Mo-Su 09:00-18:00; We off', WED, '12:00', 'closed', 'a later rule overrides an earlier one'],
  ['Mo-Su 09:00-18:00; We off', MON, '12:00', 'open', 'but only for the day it names'],

  // --- lunch breaks, which are everywhere outside northern Europe -----------
  ['Mo-Fr 09:00-12:00,13:00-17:00', MON, '12:30', 'closed', 'shut for lunch'],
  ['Mo-Fr 09:00-12:00,13:00-17:00', MON, '13:30', 'open', 'back after lunch'],

  // --- odd days and odd hours ----------------------------------------------
  ['Mo,We,Fr 10:00-14:00', WED, '11:00', 'open', 'a comma list of days'],
  ['Mo,We,Fr 10:00-14:00', TUE, '11:00', 'closed', 'a day not in the list'],
  ['Sa-Su 10:00-16:00', SUN, '11:00', 'open', 'a day range that wraps the week end'],
  ['Sa-Su 10:00-16:00', FRI, '11:00', 'closed', 'and excludes Friday'],
  ['Fr 18:00-02:00', SAT, '01:00', 'open', 'Friday night spilling into Saturday'],
  ['Fr 18:00-02:00', SAT, '03:00', 'closed', 'but not past its close'],
  ['Mo-Su 18:00-00:00', WED, '23:30', 'open', 'a window that closes at midnight'],

  // --- seasons --------------------------------------------------------------
  ['Apr-Oct Mo-Su 09:00-19:00', WED, '10:00', 'open', 'in season'],
  ['Apr-Oct Mo-Su 09:00-19:00', JAN, '10:00', 'closed', 'out of season'],

  // --- specific calendar dates, which is what museums shut for ---------------
  // The Louvre's real tag, in full. Read off production on 2026-09-16, and the reason
  // date lists are supported at all: without them this whole tag came back 'unknown'
  // and its four other rules went to waste.
  [LOUVRE, MON, '10:00', 'open', 'the Louvre on a Monday'],
  [LOUVRE, TUE, '10:00', 'closed', 'THE LOUVRE IS SHUT ON TUESDAYS'],
  [LOUVRE, WED, '20:00', 'open', 'and open late on Wednesdays'],
  [LOUVRE, WED, '21:30', 'closed', 'but not past nine'],
  [LOUVRE, d(2026, 12, 25), '10:00', 'closed', 'Christmas, named as a date'],
  [LOUVRE, d(2026, 1, 1), '10:00', 'closed', 'New Year, likewise'],
  [LOUVRE, d(2026, 5, 1), '10:00', 'closed', 'and May Day'],
  [LOUVRE, d(2026, 12, 24), '10:00', 'open', 'Christmas Eve is not in the list, and stays open'],
  // A tag with nothing but closures says when the place is SHUT and never when it is
  // open, so every other day is unknown — not closed. Encoded the wrong way round here
  // at first, and the first real audit caught it: three false 'closed' verdicts on
  // Kuromon Market in Osaka, whose entire tag is "Su off", on a Friday and a Tuesday.
  ['Su off', SUN, '12:00', 'closed', 'the day a closures-only tag DOES name'],
  ['Su off', FRI, '12:00', 'unknown', 'ANY OTHER DAY IS UNKNOWN, NOT CLOSED'],
  ['Dec 25 off', d(2026, 12, 26), '10:00', 'unknown', 'likewise for a date-only closure'],
  ['Mo-Fr 09:00-17:00; Su off', SAT, '12:00', 'closed', 'but once a tag says when it opens, an unlisted day is shut'],

  // --- explicit closure ------------------------------------------------------
  ['off', MON, '10:00', 'closed', 'a bare "off" names every day, so it is shut'],
  // the five real findings from the production audit of 2026-09-16, kept as fixtures
  ['Mo-Su 17:00-22:00', d(2026, 9, 17), '12:00', 'closed', 'a dinner-only sushi bar booked for breakfast'],
  ['Mo-Su 10:00-20:00', SUN, '09:00', 'closed', 'Osaka Aquarium, an hour before it opens'],
  ['Sa-Th 10:00-17:00; Fr 10:00-20:00', FRI, '09:00', 'closed', 'a museum at 09:00 that opens at 10:00'],
  ['Sa-Su 09:00-18:00; We-Th 07:00-18:00; Fr 18:00-00:00', TUE, '09:00', 'closed', 'Chatuchak is a weekend market; Tuesday is not in it'],
  ['Sa-Su 09:00-18:00; We-Th 07:00-18:00; Fr 18:00-00:00', SAT, '10:00', 'open', 'and the weekend is'],

  // --- holidays: answered, but flagged --------------------------------------
  ['Mo-Su 10:00-18:00; PH off', MON, '12:00', 'open', 'an ordinary day is still answered'],

  // --- and everything this parser must refuse to answer ---------------------
  ['sunrise-sunset', WED, '12:00', 'unknown', 'needs the sun, not a clock'],
  ['Mo-Fr 09:00-17:00; Sa[1] 10:00-14:00', SAT, '11:00', 'unknown', 'the first Saturday of the month'],
  ['Mo-Fr 09:00+', MON, '10:00', 'unknown', 'open-ended, with no closing time'],
  ['Mo-Fr 08:00-16:00; SH Mo-Fr 09:00-13:00', MON, '10:00', 'unknown', 'school holidays are a regional calendar'],
  ['week 1-52/2 Mo 10:00-12:00', MON, '11:00', 'unknown', 'every second week'],
  ['גיבריש שאינו תגית', MON, '10:00', 'unknown', 'not a tag at all'],
  ['', MON, '10:00', 'unknown', 'an empty tag'],
];

let failures = 0;
console.log('OSM opening_hours tags\n');
for (const [tag, date, time, expect, why] of CASES) {
  const got = verifyOpen(tag ? { source: 'osm', tag } : null, date, time);
  const pass = got.verdict === expect;
  if (!pass) failures++;
  const when = `${HE_DOW[date.getDay()]} ${String(date.getDate()).padStart(2)}/${date.getMonth() + 1} ${time}`;
  console.log(`${pass ? '  ✓' : '  ✗'} ${expect.padEnd(7)} ${when}  ${(tag || '(ריק)').slice(0, 38).padEnd(40)} ${why}`);
  if (!pass) console.log(`      got "${got.verdict}" (${got.reason || ''})`);
}

// Google hands the week over structured, so the only thing to get right is the shape.
// day 0 = Sunday, matching Date#getDay.
console.log('\nGoogle regularOpeningHours\n');
const GOOGLE = [
  [[{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 17 } }], MON, '10:00', 'open', 'Monday inside the window'],
  [[{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 17 } }], TUE, '10:00', 'closed', 'no period covers Tuesday'],
  [[{ open: { day: 2, hour: 9 }, close: { day: 2, hour: 18 } },
    { open: { day: 3, hour: 9 }, close: { day: 3, hour: 18 } }], WED, '10:00', 'open', 'periods are additive, not overriding'],
  [[{ open: { day: 5, hour: 18 }, close: { day: 6, hour: 2 } }], SAT, '01:00', 'open', 'Friday night into Saturday'],
  [[{ open: { day: 1, hour: 0 } }], MON, '23:00', 'open', 'a period with no close is open all day'],
  [[], MON, '10:00', 'closed', 'Google reports the place permanently closed'],
  [null, MON, '10:00', 'unknown', 'Google returned no hours at all'],
];
for (const [periods, date, time, expect, why] of GOOGLE) {
  const got = verifyOpen({ source: 'google', periods }, date, time);
  const pass = got.verdict === expect;
  if (!pass) failures++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${expect.padEnd(7)} ${HE_DOW[date.getDay()]} ${time}  ${why}`);
  if (!pass) console.log(`      got "${got.verdict}" (${got.reason || ''})`);
}

console.log('\nThe contract that matters most\n');
const contract = [
  ['a network failure is never evidence', verifyOpen({ source: 'error' }, MON, '10:00').verdict === 'skipped'],
  ['no hours on file is never "closed"', verifyOpen(null, MON, '10:00').verdict === 'unknown'],
  ['a stop with no clock time is judged at noon', verifyOpen({ source: 'osm', tag: 'Mo-Fr 11:00-13:00' }, MON, '').verdict === 'open'],
  ['and says so, so a caller can soften the wording', verifyOpen({ source: 'osm', tag: 'Mo-Fr 11:00-13:00' }, MON, '').assumedNoon === true],
  ['a PH rule sets the holiday flag', verifyOpen({ source: 'osm', tag: 'Mo-Su 10:00-18:00; PH off' }, MON, '12:00').ignoresHolidays === true],
  ['an ordinary tag does not', verifyOpen({ source: 'osm', tag: 'Mo-Su 10:00-18:00' }, MON, '12:00').ignoresHolidays === false],
  ['an unsupported tag never yields a verdict', _test.parseOpeningHours('Mo-Fr sunset-22:00').ok === false],
];
for (const [why, pass] of contract) {
  if (!pass) failures++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${why}`);
}

// The link between the two halves, stubbed so it stays offline and free. It is here
// because it broke in production and nothing caught it: Photon writes the element kind
// as a single letter, the OSM API wants the word, and a lookup that quietly answers null
// for "R" is indistinguishable from a place that has no hours — which is exactly how a
// full-chain run reported an untagged Louvre in 0ms without ever making the request.
console.log('\nPhoton → OSM: the element kind survives the handoff\n');
let asked = null;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('photon')) return { ok: true, json: async () => ({ features: [{
    properties: { name: 'Louvre Museum', city: 'Paris', country: 'France', countrycode: 'FR', osm_type: 'R', osm_id: 7515426 },
    geometry: { coordinates: [2.337, 48.861] } }] }) };
  if (u.includes('api.openstreetmap.org')) { asked = u; return { ok: true, json: async () => ({
    elements: [{ tags: { opening_hours: 'Mo,Th,Sa,Su 09:00-18:00; We,Fr 09:00-21:45; Tu off' } }] }) }; }
  return { ok: false, status: 404 };
};

(async () => {
  const { verifyPlace } = require('../lib/places');
  const { osmHours } = require('../lib/opening-hours');
  const v = await verifyPlace('Louvre Museum, Paris, France');
  const chain = [
    ['Photon\'s "R" is stored as "relation"', v.best && v.best.osm_type === 'relation'],
    ['the element id rides along', v.best && v.best.osm_id === '7515426'],
  ];
  const h = await osmHours(v.best && v.best.osm_type, v.best && v.best.osm_id);
  chain.push(['the OSM request is actually made, with the long form', !!asked && asked.includes('/relation/7515426.json')]);
  chain.push(['and the tag comes back', !!h && h.source === 'osm']);
  chain.push(['the real Louvre tag: Tuesday is closed', verifyOpen(h, TUE, '10:00').verdict === 'closed']);
  chain.push(['and Monday is open', verifyOpen(h, MON, '10:00').verdict === 'open']);
  const legacy = await osmHours('r', '7515426');
  chain.push(['a row written with the old "r" resolves to the same element', !!legacy && legacy.tag === (h && h.tag)]);
  chain.push(['an unknown kind is still refused', (await osmHours('banana', '7515426')) === null]);
  for (const [why, pass] of chain) {
    if (!pass) failures++;
    console.log(`${pass ? '  ✓' : '  ✗'} ${why}`);
  }

  // ---- fitting a stop to the hours, which is the half that prevents rather than reports
  console.log('\nMoving a stop to an hour that works (lib/hours-fit.js)\n');
  const { fitDay } = require('../lib/hours-fit');
  const osm = (tag) => ({ source: 'osm', tag });
  const fit = [];
  const F = (why, got, want) => fit.push([why, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`]);

  // the three real findings this exists to prevent
  let r = fitDay([{ id: 1, time: '09:00', hours: osm('Mo-Su 10:00-20:00') }], SUN);
  F('the aquarium at 09:00 moves to 10:00', r.moves.map((m) => [m.from, m.to]), [['09:00', '10:00']]);
  r = fitDay([{ id: 1, time: '12:00', hours: osm('Mo-Su 17:00-22:00') }], MON);
  F('breakfast at a dinner-only place moves to 17:00', r.moves.map((m) => [m.from, m.to]), [['12:00', '17:00']]);
  r = fitDay([{ id: 1, time: '09:00', hours: osm('Sa-Th 10:00-17:00; Fr 10:00-20:00') }], FRI);
  F('the museum at 09:00 moves to 10:00', r.moves.map((m) => [m.from, m.to]), [['09:00', '10:00']]);

  // and the timidity
  r = fitDay([{ id: 1, time: '09:00', hours: osm('Sa-Su 09:00-18:00') }], TUE);
  F('a place shut all day is reported, never moved', [r.moves.length, r.shut[0] && r.shut[0].reason], [0, 'shut all day']);
  r = fitDay([{ id: 1, time: '22:00', hours: osm('Mo-Su 09:00-18:00') }], MON);
  F('a stop after closing is NOT dragged back to the morning', [r.moves.length, r.shut[0] && r.shut[0].reason], [0, 'the day is over by then']);
  r = fitDay([
    { id: 1, time: '09:00', hours: osm('Mo-Su 16:00-20:00') },
    { id: 2, time: '11:00', hours: osm('Mo-Su 09:00-20:00') },
  ], MON);
  F('a move that would jump the next stop is refused', [r.moves.length, r.shut[0] && r.shut[0].reason], [0, 'opens after the next stop']);
  r = fitDay([{ id: 1, time: '12:30', hours: osm('Mo-Fr 09:00-12:00,13:00-17:00') }], MON);
  F('a lunch break moves the stop to when it reopens', r.moves.map((m) => m.to), ['13:00']);
  r = fitDay([{ id: 1, time: '10:00', hours: osm('Mo-Su 09:00-18:00') }], MON);
  F('a stop that is already fine is left alone', [r.moves.length, r.shut.length], [0, 0]);
  r = fitDay([{ id: 1, time: '09:00', hours: osm('sunrise-sunset') }], MON);
  F('an unreadable tag moves nothing', [r.moves.length, r.shut.length], [0, 0]);
  r = fitDay([{ id: 1, time: '09:00', hours: null }], MON);
  F('no hours at all moves nothing', [r.moves.length, r.shut.length], [0, 0]);
  r = fitDay([{ id: 1, time: '09:00', hours: { source: 'error' } }], MON);
  F('an unreachable source moves nothing', [r.moves.length, r.shut.length], [0, 0]);
  r = fitDay([{ id: 1, time: null, hours: osm('Mo-Su 10:00-20:00') }], MON);
  F('a stop with no hour of its own is not given one', [r.moves.length, r.shut.length], [0, 0]);
  // one move must not shove the rest of the day
  r = fitDay([
    { id: 1, time: '09:00', hours: osm('Mo-Su 10:00-20:00') },
    { id: 2, time: '11:00', hours: osm('Mo-Su 10:00-20:00') },
    { id: 3, time: '13:00', hours: osm('Mo-Su 10:00-20:00') },
  ], MON);
  F('only the stop that needed it moves', r.moves.map((m) => [m.id, m.to]), [[1, '10:00']]);

  for (const [why, pass, extra] of fit) {
    if (!pass) failures++;
    console.log(`${pass ? '  ✓' : '  ✗'} ${why}${pass ? '' : ' — ' + extra}`);
  }

  // ---- and the same thing over a whole built itinerary, which is where it runs
  console.log('\nA built itinerary, corrected before anyone sees it\n');
  const TAGS = {
    10: { opening_hours: 'Mo-Su 10:00-20:00' },   // opens at ten
    20: { opening_hours: 'Mo-Su 17:00-22:00' },   // dinner only
    30: { opening_hours: 'Sa-Su 09:00-18:00' },   // weekends only
    40: { opening_hours: 'Mo-Su 08:00-22:00' },   // wide open
    50: { name: 'untagged' },                     // nothing known
  };
  global.fetch = async (url) => {
    const m = /api\.openstreetmap\.org\/api\/0\.6\/\w+\/(\d+)\.json/.exec(String(url));
    const tags = m && TAGS[m[1]];
    return tags ? { ok: true, json: async () => ({ elements: [{ tags }] }) } : { ok: false, status: 404 };
  };
  const { fitItinerary } = require('../lib/hours-fit');
  const items = [
    { day_number: 1, time_label: '09:00', title: 'museum',  osm_type: 'way', osm_id: '10' },
    { day_number: 1, time_label: '12:00', title: 'dinner',  osm_type: 'way', osm_id: '20' },
    { day_number: 1, time_label: '19:00', title: 'promenade', osm_type: 'way', osm_id: '40' },
    { day_number: 2, time_label: '09:00', title: 'weekend market', osm_type: 'way', osm_id: '30' },
    { day_number: 2, time_label: '11:00', title: 'untagged', osm_type: 'way', osm_id: '50' },
  ];
  const rep = await fitItinerary(items, { startDate: '2026-09-14' }); // day 1 = Monday
  const built = [
    ['the 09:00 museum is served at 10:00', items[0].time_label === '10:00'],
    ['breakfast at a dinner-only place becomes 17:00', items[1].time_label === '17:00'],
    ['a stop that already worked is untouched', items[2].time_label === '19:00'],
    ['a weekend market on a Tuesday is reported, not moved',
      items[3].time_label === '09:00' && rep.shut.some((x) => x.reason === 'shut all day')],
    ['a place with no hours is untouched', items[4].time_label === '11:00'],
    ['an undated trip is never touched',
      (await (async () => { const u = [{ day_number: 1, time_label: '09:00', title: 'u', osm_type: 'way', osm_id: '10' }];
        await fitItinerary(u, { startDate: null }); return u[0].time_label === '09:00'; })())],
    ['a spent time budget changes nothing',
      (await (async () => { const u = [{ day_number: 1, time_label: '09:00', title: 'u', osm_type: 'way', osm_id: '10' }];
        await fitItinerary(u, { startDate: '2026-09-14', budgetMs: -1 }); return u[0].time_label === '09:00'; })())],
  ];
  for (const [why, pass] of built) {
    if (!pass) failures++;
    console.log(`${pass ? '  ✓' : '  ✗'} ${why}`);
  }

  const total = CASES.length + GOOGLE.length + contract.length + chain.length + fit.length + built.length;
  console.log(`\n${total - failures}/${total} correct`);
  process.exit(failures ? 1 : 0);
})();
