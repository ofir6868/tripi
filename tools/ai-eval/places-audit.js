#!/usr/bin/env node
// Measures how many places in AI-built trips actually exist, by geocoding every
// trip_items.place_query against Photon. This is the hallucinated-places yardstick:
// run it before and after prompt/pipeline changes to see if the rate moves.
//
//   node tools/ai-eval/places-audit.js                # all AI-built trips (id > 8)
//   node tools/ai-eval/places-audit.js --trips 41,81  # specific trips
//   node tools/ai-eval/places-audit.js --include-seeds
//
// Reads the DB via DATABASE_URL (SELECT only). The verdicts and the matching logic
// live in lib/places.js — the same code the build pipeline uses to repair or drop
// unfound places — so what this audit counts and what the pipeline enforces can
// never mean different things.
//
// "mismatch"/"none" mean *not found in OSM*, which is evidence of — not proof of —
// a hallucination: real-but-obscure venues (cafes, tour desks) can be missing from
// OSM too. The report prints every non-ok place so a human can pass judgment; the
// honest headline number is a range, not a point.

require('../../lib/env');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../lib/db');
const { verifyPlaces } = require('../../lib/places');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const INCLUDE_SEEDS = argv.includes('--include-seeds');
const TRIP_IDS = flag('trips') ? flag('trips').split(',').map(Number) : null;
// seeds are the hand-curated demo trips from db/setup.js — ids 1..8 by construction
const SEED_MAX_ID = 8;

(async () => {
  const where = TRIP_IDS ? `t.id = ANY($1)` : INCLUDE_SEEDS ? 'TRUE' : `t.id > ${SEED_MAX_ID}`;
  const params = TRIP_IDS ? [TRIP_IDS] : [];
  const { rows } = await pool.query(
    `SELECT t.id AS trip_id, t.title AS trip_title, i.day_number, i.title, i.category, i.place_query
     FROM trips t JOIN trip_items i ON i.trip_id = t.id
     WHERE ${where} AND i.place_query IS NOT NULL AND i.place_query <> ''
     ORDER BY t.id, i.day_number, i.sort_order`, params);
  await pool.end();

  const unique = [...new Set(rows.map((r) => r.place_query))];
  console.log(`\nplaces-audit · ${rows.length} stops in ${new Set(rows.map((r) => r.trip_id)).size} trips · ${unique.length} unique places to geocode\n`);

  const results = await verifyPlaces(unique, {
    timeoutMs: 8000,
    onProgress: (done, total) => { if (done % 50 === 0) console.log(`  …${done}/${total}`); },
  });
  const items = rows.map((r) => ({ ...r, ...results.get(r.place_query) }));

  // per-trip table
  const byTrip = new Map();
  for (const it of items) {
    const k = it.trip_id;
    if (!byTrip.has(k)) byTrip.set(k, { title: it.trip_title, ok: 0, mismatch: 0, none: 0, skipped: 0 });
    byTrip.get(k)[it.verdict]++;
  }
  console.log('\nלפי טיול (ok / mismatch / none):');
  for (const [id, t] of byTrip) {
    const total = t.ok + t.mismatch + t.none + t.skipped;
    const bad = t.mismatch + t.none;
    console.log(`  #${id} ${t.title}  ·  ${total} תחנות  ·  ${t.ok} ✓  ${t.mismatch} ≈  ${t.none} ✗  (${Math.round((bad / total) * 100)}% חשודות)`);
  }

  // every non-ok place, the part a human actually reads
  const suspects = items.filter((it) => it.verdict === 'mismatch' || it.verdict === 'none');
  console.log(`\nחשודות (${suspects.length}):`);
  for (const s of suspects) {
    const hint = [s.activityLike && 'פעילות?', s.genericName && 'שם גנרי'].filter(Boolean).join(' ');
    const near = s.best ? `הכי קרוב: "${s.best.name}" (${s.best.where}, ${s.best.score})` : 'אין תוצאות בכלל';
    console.log(`  [${s.verdict === 'none' ? '✗' : '≈'}] #${s.trip_id} יום ${s.day_number} · ${s.title}`);
    console.log(`      "${s.place_query}" → ${near}${hint ? `  · ${hint}` : ''}`);
  }

  const skipped = items.filter((i) => i.verdict === 'skipped').length;
  const ok = items.filter((i) => i.verdict === 'ok').length;
  const none = items.filter((i) => i.verdict === 'none').length;
  console.log(`\nסה"כ: ${items.length} תחנות · ${ok} אומתו (${Math.round((ok / items.length) * 100)}%) · ` +
    `${suspects.length - none} mismatch · ${none} none` + (skipped ? ` · ${skipped} דולגו (רשת)` : ''));
  console.log(`טווח ההזיה האמיתי הוא בין ה-none לבין כלל החשודות — OSM לא מכיר כל מסעדה אמיתית.`);

  const dir = path.join(__dirname, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `places-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2));
  console.log(`full output → ${path.relative(process.cwd(), file)}`);
})();
