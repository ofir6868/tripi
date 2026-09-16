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

const MODE = () => String(process.env.BOOT_PROBE || '').toLowerCase();
const log = (s) => console.log(`boot-probe: ${s}`);

// Kinkaku-ji, Kyoto — tagged, famous, and an answer a human can sanity-check
const KNOWN = { type: 'way', id: '4008131' };
const HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const dateOf = (start, day) => {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + day - 1);
  return d;
};

async function reachability() {
  log('--- 1. can this host reach OpenStreetMap? ---');
  const t0 = Date.now();
  let res;
  try {
    res = await osmHours(KNOWN.type, KNOWN.id, { timeoutMs: 8000 });
  } catch (err) {
    log(`  THREW after ${Date.now() - t0}ms: ${err.message}`);
    return false;
  }
  const ms = Date.now() - t0;
  if (!res) { log(`  reachable (${ms}ms) — but this element carries no opening_hours tag`); return true; }
  if (res.source === 'error') { log(`  UNREACHABLE (${ms}ms) — the free road does not work from here`); return false; }
  log(`  REACHABLE (${ms}ms) — ${KNOWN.type}/${KNOWN.id} opening_hours = "${res.tag}"`);
  const today = new Date();
  const v = verifyOpen(res, today, '10:00');
  log(`  and it parses: today (${HE_DOW[today.getDay()]}) at 10:00 → ${v.verdict}${v.reason ? ` (${v.reason})` : ''}`);
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
    log('  note: migration 25 only fills osm_id on stops verified AFTER it landed, so');
    log('        older stops can only be answered through Google (BOOT_PROBE=google).');
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
