// Migration 2: multi-destination support + coordinates for weather/hotels.
// Idempotent. Usage: DATABASE_URL=postgres://... node db/migrate.js
const { Pool } = require('pg');

const url = process.env.DATABASE_URL ||
  (() => { try { return require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').match(/DATABASE_URL=(.*)/)[1].trim(); } catch { return null; } })();

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

// coordinates for the seeded suggested trips (share_code → [{name, country, lat, lon}])
const SEED_DESTS = {
  '284917': [{ name: 'סנטוריני', country: 'יוון', lat: 36.393, lon: 25.461 }],
  '731502': [{ name: 'רומא', country: 'איטליה', lat: 41.893, lon: 12.483 }],
  '590346': [{ name: 'טוקיו', country: 'יפן', lat: 35.677, lon: 139.694 }],
  '417829': [{ name: 'ליסבון', country: 'פורטוגל', lat: 38.717, lon: -9.139 }],
  '863054': [
    { name: 'קו פנגן', country: 'תאילנד', lat: 9.751, lon: 100.024 },
    { name: 'קוסמוי', country: 'תאילנד', lat: 9.512, lon: 100.014 },
  ],
  '925471': [{ name: 'ניו יורק', country: 'ארה"ב', lat: 40.713, lon: -74.006 }],
  '308156': [{ name: 'פריז', country: 'צרפת', lat: 48.857, lon: 2.352 }],
  '652093': [
    { name: 'רמת הגולן', country: 'ישראל', lat: 32.992, lon: 35.69 },
    { name: 'הכנרת', country: 'ישראל', lat: 32.833, lon: 35.591 },
  ],
};

async function main() {
  console.log('Adding destinations column...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS destinations JSONB NOT NULL DEFAULT '[]'`);

  console.log('Backfilling seed trip coordinates...');
  for (const [code, dests] of Object.entries(SEED_DESTS)) {
    const { rowCount } = await pool.query(
      `UPDATE trips SET destinations = $1 WHERE share_code = $2 AND destinations = '[]'`,
      [JSON.stringify(dests), code]
    );
    if (rowCount) console.log(`  + ${code}: ${dests.map((d) => d.name).join(', ')}`);
  }

  console.log('Backfilling remaining trips from destination text (no coords)...');
  await pool.query(`
    UPDATE trips SET destinations = jsonb_build_array(jsonb_build_object('name', destination, 'country', country, 'lat', null, 'lon', null))
    WHERE destinations = '[]' AND destination IS NOT NULL AND destination <> ''
  `);

  console.log('Migration 3: edit codes + likes...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS edit_code CHAR(6)`);
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS likes INT NOT NULL DEFAULT 0`);
  const noCode = await pool.query(`SELECT id FROM trips WHERE edit_code IS NULL`);
  for (const r of noCode.rows) {
    await pool.query(`UPDATE trips SET edit_code = $1 WHERE id = $2`,
      [String(Math.floor(100000 + Math.random() * 900000)), r.id]);
  }
  if (noCode.rows.length) console.log(`  + edit codes generated for ${noCode.rows.length} trips`);

  console.log('Migration 4: per-item area...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS area TEXT`);

  console.log('Done.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
