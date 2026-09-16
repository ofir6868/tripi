// Fill in the OSM element id for stops that were verified before migration 25 existed.
//
// Every stop the AI ever placed was geocoded, and the geocoder named the element it
// matched — but until migration 25 there was nowhere to put it, so it was thrown away
// 1,618 times. That single missing column is the whole reason the opening-hours audit
// answers "0% coverage" on a production database full of dated trips: the free road
// needs an element id, and not one row carries one.
//
// This walks the old rows and asks the same question again. Off unless BACKFILL_OSM is
// set; `BACKFILL_OSM=1` does the lot, `BACKFILL_OSM=200` stops after 200 rows.
//
// It is written to be dull on purpose. Everything below is a property it must not lose:
//
//   Free       Photon only (allowGoogle:false). Not one paid call, which also means a
//              Google quota that is currently exhausted cannot stall it.
//   Narrow     writes osm_type and osm_id, and nothing else, ever. Not the title, not
//              place_query, not the coordinates, not google_place_id.
//   Additive   only rows where osm_id IS NULL. It cannot overwrite an answer, and it
//              cannot touch a row a traveller has since corrected by hand.
//   Careful    writes only on verdict 'ok' — the same bar the build pipeline uses to
//              decide a place is real. A mismatch, a miss or a network blip writes
//              nothing at all, so a bad match never becomes a stored fact.
//   Resumable  batched and idempotent; a restart mid-run continues where it stopped,
//              and running it twice is the same as running it once.
//   Reversible in one statement:
//                UPDATE trip_items SET osm_type = NULL, osm_id = NULL;
//              which puts the database back exactly as it was, because those two
//              columns held nothing before this.
//   Quiet      paced, and it cannot fail a boot.
const { pool } = require('./db');
const { verifyPlace } = require('./places');
const { cacheGet, cacheSet } = require('./api-budget');

// Where the last run stopped. It lives in api_cache because that table is exactly for
// operational state that may be thrown away without consequence — losing it costs a
// repeat pass, never a wrong row.
const CURSOR = ['backfill', 'osm_cursor'];

const BATCH = 20;
const PAUSE_MS = 1500; // between batches — Photon is someone else's server
// Matches MAX_IN_FLIGHT in lib/places.js, which is the thing that actually governs how
// hard Photon is pushed. A strictly sequential walk does not spare the geocoder anything
// — it just leaves two of its three permitted slots idle, and turns an hour of work into
// three. The build pipeline already verifies whole trips concurrently through the same
// limiter, so this is that function's ordinary mode rather than a new demand on it.
const CONCURRENCY = 3;
const log = (s) => console.log(`osm-backfill: ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(limit) {
  log(`starting — up to ${limit} stops, Photon only, writing osm_type/osm_id and nothing else`);
  let seen = 0, filled = 0, unmatched = 0, blips = 0;

  // A cursor, not a plain LIMIT. The rows this cannot match stay NULL, so they keep
  // sorting to the front and a re-query would hand back the same ones every batch —
  // a loop that makes no progress and pays Photon for every lap. Walking forward by id
  // visits each row exactly once.
  //
  // And the cursor is saved, because on this host a run does not get to finish. The free
  // instance restarts, and every push to main redeploys it; the first attempt was cut off
  // three times in ten minutes. A cursor that resets to zero on each restart re-walks
  // every row it already failed to match — a prefix that only grows — so the run spends
  // its whole life re-asking about the same unmatchable places and never reaches the end
  // of the table. Saved, each restart carries on from where the last one stopped.
  let cursor = 0;
  const saved = await cacheGet(...CURSOR);
  if (saved.hit && Number.isInteger(saved.value)) {
    cursor = saved.value;
    log(`  resuming from id ${cursor} (a previous run stopped there)`);
  }

  // Two different reasons to stop, and only one of them means the walk is over: the
  // table ran out, or this run hit the limit it was given. Conflating them resets the
  // cursor on a run that was merely cut short, which sends the next one back to the top
  // — the exact failure the saved cursor exists to prevent.
  let exhausted = false;

  while (seen < limit) {
    const want = Math.min(BATCH, limit - seen);
    const { rows } = await pool.query(
      `SELECT id, place_query FROM trip_items
       WHERE osm_id IS NULL AND place_query IS NOT NULL AND place_query <> '' AND id > $2
       ORDER BY id
       LIMIT $1`, [want, cursor]
    );
    if (!rows.length) { exhausted = true; break; }
    cursor = rows[rows.length - 1].id;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (r) => {
        seen++;
        let v;
        try {
          v = await verifyPlace(r.place_query, { allowGoogle: false });
        } catch {
          blips++; return;
        }
        if (v.verdict !== 'ok' || !v.best || !v.best.osm_id) {
          if (v.verdict === 'skipped') blips++; else unmatched++;
          return;
        }
        // the one write. The WHERE clause repeats the IS NULL guard so a concurrent
        // edit that filled the row first always wins over this backfill.
        const { rowCount } = await pool.query(
          `UPDATE trip_items SET osm_type = $1, osm_id = $2 WHERE id = $3 AND osm_id IS NULL`,
          [v.best.osm_type, v.best.osm_id, r.id]
        );
        if (rowCount) filled++;
      }));
    }

    await cacheSet(...CURSOR, cursor);
    log(`  ${seen} seen · ${filled} filled · ${unmatched} no match · ${blips} network (id ${cursor})`);

    if (rows.length < want) { exhausted = true; break; } // fewer than asked for = the end
    await sleep(PAUSE_MS);
  }

  const { rows: after } = await pool.query(
    `SELECT count(*) FILTER (WHERE osm_id IS NOT NULL)::int AS with_osm,
            count(*) FILTER (WHERE place_query IS NOT NULL)::int AS placed
     FROM trip_items`
  );
  log(`done: ${filled} filled, ${unmatched} no match, ${blips} network trouble`);
  log(`  the table now holds ${after[0].with_osm} osm ids across ${after[0].placed} placed stops`);
  log('  to undo: UPDATE trip_items SET osm_type = NULL, osm_id = NULL;');
  // Only once the table is genuinely exhausted does the next run start from the top.
  // A run that merely spent its limit leaves the cursor where it is, so the next one
  // picks up from there instead of re-walking everything it already tried.
  if (exhausted) { await cacheSet(...CURSOR, 0); log('  reached the end of the table'); }
  else log(`  stopped at its limit; the next run resumes from id ${cursor}`);
  // returned so a test can hold the loop to its contract: every row still missing an id
  // is visited exactly once per run, and never more than once
  return { seen, filled, unmatched, blips };
}

function start() {
  const raw = String(process.env.BACKFILL_OSM || '').trim();
  if (!raw) return;
  const n = parseInt(raw, 10);
  const limit = Number.isInteger(n) && n > 1 ? n : 5000;
  setTimeout(() => {
    run(limit).catch((err) => log(`failed: ${err && err.message}`));
  }, 8000).unref(); // well after the probe, and well after the site is serving
}

module.exports = { start, run };
