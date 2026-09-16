#!/usr/bin/env node
// How many stops in real trips send a traveller to a door that is shut?
//
//   node tools/opening-hours-audit.js                 # every dated trip with stops
//   node tools/opening-hours-audit.js --trips 41,81
//   node tools/opening-hours-audit.js --google        # also pay for what OSM can't answer
//
// This is the opening-hours yardstick, and it is meant to be run BEFORE anything is
// built on top of it. lib/places.js has a dated baseline for invented places (2026-08-16:
// 91% verified, ~4–5% truly invented); nothing has ever measured the other axis. If the
// closed-door rate comes back at 3% this is a nice feature; if it comes back at 15% it is
// the most important thing in the repository, and the difference is one cheap run.
//
// SELECT only. Free by default: OSM answers without a key and without a meter, and
// --google is the only thing here that can spend money (bounded by PLACE_HOURS_MONTHLY_LIMIT
// either way). The verdicts come from lib/opening-hours.js — the same module any product
// surface would use — so what this counts and what the app would show cannot diverge.
//
// A stop whose hours nobody holds is 'unknown', NOT 'closed'. The honest headline is a
// rate over the stops we could actually answer for, printed beside the coverage that
// produced it, because a 2% closed rate over 10% coverage is not a measurement.
require('../lib/env');
const { pool } = require('../lib/db');
const { placeHours, verifyOpen, hoursBudget } = require('../lib/opening-hours');

const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--trips');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger) : null;
})();
const useGoogle = args.includes('--google');
const HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const dateOf = (start, day) => {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + day - 1);
  return d;
};

(async () => {
  const { rows } = await pool.query(`
    SELECT i.id, i.title, i.day_number, i.time_label, i.place_query, i.category,
           i.osm_type, i.osm_id, i.google_place_id,
           t.id AS trip_id, t.title AS trip_title, t.start_date, t.days
    FROM trip_items i JOIN trips t ON t.id = i.trip_id
    WHERE t.start_date IS NOT NULL
      AND i.place_query IS NOT NULL
      ${only ? 'AND t.id = ANY($1)' : ''}
    ORDER BY t.id, i.day_number, i.time_label NULLS LAST`,
  only ? [only] : []);

  if (!rows.length) { console.log('no dated trips with places to audit.'); await pool.end(); return; }

  const trips = new Set(rows.map((r) => r.trip_id));
  console.log(`${rows.length} placed stops across ${trips.size} dated trips`);
  console.log(`sources: OpenStreetMap${useGoogle ? ' + Google (billed)' : ' only — pass --google to also buy what OSM cannot answer'}\n`);

  const tally = { open: 0, closed: 0, unknown: 0, skipped: 0 };
  const shut = [];
  let done = 0;

  for (const r of rows) {
    const date = dateOf(r.start_date, r.day_number);
    if (!date) { tally.unknown++; continue; }
    const hours = await placeHours({
      osmType: r.osm_type, osmId: r.osm_id,
      googlePlaceId: useGoogle ? r.google_place_id : null,
    }).catch(() => null);
    const v = verifyOpen(hours, date, r.time_label);
    tally[v.verdict] = (tally[v.verdict] || 0) + 1;
    if (v.verdict === 'closed') shut.push({ ...r, date, v });
    if (++done % 25 === 0) process.stdout.write(`  ${done}/${rows.length}\r`);
  }

  const answered = tally.open + tally.closed;
  const pct = (n, of) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

  console.log('                                      ');
  console.log(`  open      ${String(tally.open).padStart(4)}`);
  console.log(`  closed    ${String(tally.closed).padStart(4)}   ← the ones that matter`);
  console.log(`  unknown   ${String(tally.unknown).padStart(4)}   (no hours on file, or a tag the parser won't guess at)`);
  console.log(`  skipped   ${String(tally.skipped).padStart(4)}   (the lookup failed — says nothing about the place)`);
  console.log(`\n  coverage:     ${pct(answered, rows.length)} of stops could be answered at all`);
  console.log(`  CLOSED DOORS: ${pct(tally.closed, answered)} of those — ${tally.closed} stop(s)`);
  if (answered < rows.length * 0.2) {
    console.log('\n  ! coverage this low makes the rate above unreliable. Run with --google, or');
    console.log('    check that stops carry osm_type/osm_id (migration 25 — only stops verified');
    console.log('    since it landed have them).');
  }

  if (shut.length) {
    console.log('\n— every closed door, for human judgement —\n');
    for (const s of shut) {
      console.log(`  ${s.trip_title} · יום ${s.day_number} (${HE_DOW[s.date.getDay()]}) ${s.time_label || '(ללא שעה)'}`);
      console.log(`    ${s.title}  —  ${s.place_query}`);
      console.log(`    ${s.v.source}: ${s.v.tag ? `"${s.v.tag}"` : s.v.reason}${s.v.assumedNoon ? '  [judged at noon: the stop has no clock time]' : ''}`);
      if (s.v.ignoresHolidays) console.log('    [the tag has a public-holiday rule this cannot evaluate]');
      console.log('');
    }
  }
  if (useGoogle) console.log(`place_hours budget: ${await hoursBudget.used()}/${hoursBudget.limit} used this month`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
