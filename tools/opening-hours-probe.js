// Can this host reach the sources that know when a door is open, and what do they say?
//
//   node tools/opening-hours-probe.js                    # both sources, a known place
//   node tools/opening-hours-probe.js way 4008131        # a specific OSM element
//
// Run it ON THE DEPLOYED HOST, not only locally. That distinction is not pedantry
// here: lib/hotel-content.js records that every public Overpass mirror times out from
// Render while answering fine from a laptop (measured 2026-08-19), which is exactly why
// the OSM road below goes to the plain element endpoint instead. Whether THAT host
// answers from Render is the question this probe exists to settle, and it has to be
// settled before anything is built on top of the free path.
//
// Reads keys from .env like the server does — never pass one on the command line.
require('../lib/env');
const { osmHours, googleHours, verifyOpen, hoursBudget } = require('../lib/opening-hours');

const [, , typeArg, idArg] = process.argv;
// Kinkaku-ji in Kyoto: tagged, famous, and open every day — a place whose answer a
// human can sanity-check at a glance
const osmType = typeArg || 'way';
const osmId = idArg || '4008131';

const HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

(async () => {
  console.log(`DATABASE_URL:            ${process.env.DATABASE_URL ? 'present (durable cache)' : 'not set (per-process cache)'}`);
  console.log(`GOOGLE_PLACES_API_KEY:   ${process.env.GOOGLE_PLACES_API_KEY ? 'present' : 'not set — the paid road is off'}`);
  console.log(`place_hours budget:      ${hoursBudget.limit}/month, ${await hoursBudget.used()} used\n`);

  console.log(`— OpenStreetMap (keyless) — ${osmType}/${osmId}`);
  const t0 = Date.now();
  const osm = await osmHours(osmType, osmId);
  const ms = Date.now() - t0;
  if (!osm) console.log(`  no opening_hours tag on this element  (${ms}ms)`);
  else if (osm.source === 'error') console.log(`  UNREACHABLE or error  (${ms}ms) — the free road is not available from this host`);
  else console.log(`  opening_hours = "${osm.tag}"  (${ms}ms)`);

  if (process.env.GOOGLE_PLACES_API_KEY && process.argv.includes('--google')) {
    console.log('\n— Google (billed, Place Details Enterprise) —');
    console.log('  pass a place_id as the third argument to try it');
  }

  const hours = osm && osm.source === 'osm' ? osm : null;
  if (!hours) { console.log('\nnothing to evaluate.'); process.exit(osm && osm.source === 'error' ? 1 : 0); }

  console.log('\n— the week this place is open, as we read it —');
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const at10 = verifyOpen(hours, d, '10:00');
    const at20 = verifyOpen(hours, d, '20:00');
    const mark = (v) => (v.verdict === 'open' ? 'פתוח ' : v.verdict === 'closed' ? 'סגור ' : '?    ');
    console.log(`  ${HE_DOW[d.getDay()]}  ${String(d.getDate()).padStart(2)}/${d.getMonth() + 1}   10:00 ${mark(at10)}  20:00 ${mark(at20)}`);
  }
  const sample = verifyOpen(hours, today, '10:00');
  if (sample.ignoresHolidays) console.log('\n  note: the tag has a public-holiday rule this cannot evaluate — holidays are not accounted for');
  if (sample.verdict === 'unknown') console.log(`\n  the parser declined this tag: ${sample.reason}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
