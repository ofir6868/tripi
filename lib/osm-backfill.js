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

const BATCH = 20;
const PAUSE_MS = 1500; // between batches — Photon is someone else's server
const log = (s) => console.log(`osm-backfill: ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(limit) {
  log(`starting — up to ${limit} stops, Photon only, writing osm_type/osm_id and nothing else`);
  let seen = 0, filled = 0, unmatched = 0, blips = 0;

  // A cursor, not a plain LIMIT. The rows this cannot match stay NULL, so they keep
  // sorting to the front and a re-query would hand back the same ones every batch —
  // a loop that makes no progress and pays Photon for every lap. Walking forward by id
  // visits each row exactly once, which is also what makes a stopped run resumable
  // without repeating work it already did.
  let cursor = 0;

  while (seen < limit) {
    const { rows } = await pool.query(
      `SELECT id, place_query FROM trip_items
       WHERE osm_id IS NULL AND place_query IS NOT NULL AND place_query <> '' AND id > $2
       ORDER BY id
       LIMIT $1`, [Math.min(BATCH, limit - seen), cursor]
    );
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const r of rows) {
      seen++;
      let v;
      try {
        v = await verifyPlace(r.place_query, { allowGoogle: false });
      } catch {
        blips++; continue;
      }
      if (v.verdict !== 'ok' || !v.best || !v.best.osm_id) {
        if (v.verdict === 'skipped') blips++; else unmatched++;
        continue;
      }
      // the one write. The WHERE clause repeats the IS NULL guard so a concurrent
      // edit that filled the row first always wins over this backfill.
      const { rowCount } = await pool.query(
        `UPDATE trip_items SET osm_type = $1, osm_id = $2 WHERE id = $3 AND osm_id IS NULL`,
        [v.best.osm_type, v.best.osm_id, r.id]
      );
      if (rowCount) filled++;
    }

    log(`  ${seen} seen · ${filled} filled · ${unmatched} no match · ${blips} network`);

    if (rows.length < BATCH) break;
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
