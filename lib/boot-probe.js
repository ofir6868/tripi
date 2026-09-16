// Run the opening-hours probe and audit ON THE DEPLOYED HOST, and say what they found
// in the service log.
//
// Why this exists at all: the tools in tools/ answer the two questions that decide
// whether opening hours are worth anything — can this host reach the free source, and
// how many real stops land on a closed door — but they are command-line tools, and a
// free Render web service has no shell to run them from. This is the same two questions,
// asked at boot, by the process that is already running there.
//
// Off unless BOOT_PROBE is set, so it costs a deployed service nothing:
//   BOOT_PROBE=1        reachability + coverage + the audit, OSM only (free)
//   BOOT_PROBE=google   the same, also buying hours for stops OSM cannot answer
//                       (bounded by PLACE_HOURS_MONTHLY_LIMIT like any other paid call)
//
// It never blocks the boot, never throws into it, and reads nothing but its own two
// tables and trip_items. Unset the variable when the answer is in.
const { pool } = require('./db');
const { osmHours, placeHours, verifyOpen, hoursBudget } = require('./opening-hours');
const { verifyPlace } = require('./places');

const MODE = () => String(process.env.BOOT_PROBE || '').toLowerCase();
const log = (s) => console.log(`boot-probe: ${s}`);

// Resolved through the app's own verifier rather than a hardcoded element id, because
// that is the chain the feature actually depends on: Photon has to hand back an osm_id
// for a name before the free road leads anywhere. A hardcoded id proves the host can
// reach OSM and nothing else — the first production run returned one with no
// opening_hours tag at all, which answered the small question and not the real one.
const KNOWN_PLACE = 'Louvre Museum, Paris, France';
const HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const dateOf = (start, day) => {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + day - 1);
  return d;
};

async function reachability() {
  log('--- 1. the whole free chain, end to end ---');
  const t0 = Date.now();
  let v;
  try {
    v = await verifyPlace(KNOWN_PLACE);
  } catch (err) {
    log(`  verifyPlace THREW after ${Date.now() - t0}ms: ${err.message}`);
    return false;
  }
  const best = v && v.best;
  log(`  a) "${KNOWN_PLACE}" → ${v.verdict} in ${Date.now() - t0}ms`);
  if (!best || !best.osm_id) {
    log('  b) NO osm_id came back — Photon matched nothing, or matched without an element id.');
    log('     The free road needs this: without an osm_id there is nothing to ask OSM about.');
    return false;
  }
  log(`  b) osm element: ${best.osm_type}/${best.osm_id}  (${best.name})`);
  const t1 = Date.now();
  const hours = await osmHours(best.osm_type, best.osm_id, { timeoutMs: 8000 }).catch(() => ({ source: 'error' }));
  const ms = Date.now() - t1;
  if (hours && hours.source === 'error') { log(`  c) OSM UNREACHABLE (${ms}ms) — the free road does not work from this host`); return false; }
  if (!hours) { log(`  c) OSM reachable (${ms}ms) — but this element carries no opening_hours tag`); return true; }
  log(`  c) opening_hours = "${hours.tag}"  (${ms}ms)`);
  const today = new Date();
  const verdict = verifyOpen(hours, today, '10:00');
  log(`  d) parses: today (${HE_DOW[today.getDay()]}) at 10:00 → ${verdict.verdict}${verdict.reason ? ` (${verdict.reason})` : ''}`);
  return true;
}

async function coverage() {
  log('--- 2. what do the stops carry? ---');
  const { rows } = await pool.query(`
    SELECT count(*)::int AS stops,
           count(*) FILTER (WHERE i.place_query IS NOT NULL)::int AS placed,
           count(*) FILTER (WHERE i.osm_id IS NOT NULL)::int AS with_osm,
           count(*) FILTER (WHERE i.google_place_id IS NOT NULL)::int AS with_google,
           count(*) FILTER (WHERE t.start_date IS NOT NULL)::int AS on_dated_trips,
           count(*) FILTER (WHERE t.start_date IS NOT NULL
             AND (i.osm_id IS NOT NULL OR i.google_place_id IS NOT NULL))::int AS answerable
    FROM trip_items i JOIN trips t ON t.id = i.trip_id`);
  const r = rows[0];
  log(`  ${r.stops} stops, ${r.placed} with a place, ${r.on_dated_trips} on dated trips`);
  log(`  carrying an OSM id: ${r.with_osm}   carrying a Google id: ${r.with_google}`);
  log(`  answerable at all (dated + some id): ${r.answerable}`);
  if (!r.with_osm) {
    log('  note: migration 25 only fills osm_id on stops verified AFTER it landed, so every');
    log(`        older stop is unanswerable until a backfill re-verifies it. ${r.placed} stops`);
    log('        carry a place_query, which is all a backfill needs — and Photon is free.');
  }
  return r;
}

async function audit(useGoogle) {
  log(`--- 3. the audit${useGoogle ? ' (OSM + Google)' : ' (OSM only)'} ---`);
  const { rows } = await pool.query(`
    SELECT i.id, i.title, i.day_number, i.time_label, i.place_query,
           i.osm_type, i.osm_id, i.google_place_id,
           t.title AS trip_title, t.start_date
    FROM trip_items i JOIN trips t ON t.id = i.trip_id
    WHERE t.start_date IS NOT NULL
      AND (i.osm_id IS NOT NULL OR i.google_place_id IS NOT NULL)
    ORDER BY t.id, i.day_number
    LIMIT 400`);
  if (!rows.length) { log('  nothing answerable yet — see the note above.'); return; }

  const tally = { open: 0, closed: 0, unknown: 0, skipped: 0 };
  const shut = [];
  for (const r of rows) {
    const date = dateOf(r.start_date, r.day_number);
    if (!date) { tally.unknown++; continue; }
    const hours = await placeHours({
      osmType: r.osm_type, osmId: r.osm_id,
      googlePlaceId: useGoogle ? r.google_place_id : null,
    }).catch(() => ({ source: 'error' }));
    const v = verifyOpen(hours, date, r.time_label);
    tally[v.verdict] = (tally[v.verdict] || 0) + 1;
    if (v.verdict === 'closed') shut.push({ r, date, v });
  }
  const answered = tally.open + tally.closed;
  const pct = (n, of) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');
  log(`  checked ${rows.length}: open ${tally.open} · closed ${tally.closed} · unknown ${tally.unknown} · skipped ${tally.skipped}`);
  log(`  coverage ${pct(answered, rows.length)}  |  CLOSED DOORS ${pct(tally.closed, answered)} (${tally.closed})`);
  for (const s of shut.slice(0, 20)) {
    log(`  · ${s.r.trip_title} יום ${s.r.day_number} (${HE_DOW[s.date.getDay()]}) ${s.r.time_label || 'ללא שעה'} — ${s.r.title}`);
    log(`      ${s.r.place_query}  [${s.v.source}] ${s.v.tag ? `"${s.v.tag}"` : s.v.reason || ''}`);
  }
  if (shut.length > 20) log(`  … and ${shut.length - 20} more`);
  if (useGoogle) log(`  place_hours budget: ${await hoursBudget.used()}/${hoursBudget.limit} this month`);
}

// fire-and-forget: a diagnostic must never be able to keep the site from coming up
function start() {
  const mode = MODE();
  if (!mode) return;
  setTimeout(() => {
    (async () => {
      log(`starting (BOOT_PROBE=${mode}) — unset the variable once the answer is in`);
      const reachable = await reachability();
      await coverage();
      await audit(mode === 'google');
      log(`done. OSM reachable from this host: ${reachable ? 'YES' : 'NO'}`);
    })().catch((err) => log(`failed: ${err && err.message}`));
  }, 3000).unref(); // let the service finish coming up first
}

module.exports = { start };
