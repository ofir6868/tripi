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

  // --- explicit closure ------------------------------------------------------
  ['off', MON, '10:00', 'closed', 'a place tagged simply off'],

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

  const total = CASES.length + GOOGLE.length + contract.length + chain.length;
  console.log(`\n${total - failures}/${total} correct`);
  process.exit(failures ? 1 : 0);
})();
