// Migration 2: multi-destination support + coordinates for weather/hotels.
// Idempotent. Usage: DATABASE_URL=postgres://... node db/migrate.js
const { Pool } = require('pg');

const url = process.env.DATABASE_URL ||
  (() => { try { return require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').match(/DATABASE_URL=(.*)/)[1].trim(); } catch { return null; } })();

const pool = new Pool({
  connectionString: url,
  ssl: (url || '').includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

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

  console.log('Migration 3: likes...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS likes INT NOT NULL DEFAULT 0`);

  console.log('Migration 4: per-item area...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS area TEXT`);

  console.log('Migration 5: per-item coordinates...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION`);

  console.log('Migration 6: hotels + budget + travel stops...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2)`);
  // "תחבורה" and "נסיעה" merged into a single travel category
  const merged = await pool.query(`UPDATE trip_items SET category = 'נסיעה' WHERE category = 'תחבורה'`);
  if (merged.rowCount) console.log(`  + ${merged.rowCount} transport stops renamed to נסיעה`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_budgets (
      trip_id INT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
      total NUMERIC(12,2),
      currency CHAR(3) NOT NULL DEFAULT 'ILS',
      travelers INT NOT NULL DEFAULT 2,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_hotels (
      id SERIAL PRIMARY KEY,
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      night_start INT NOT NULL,
      night_end INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      stars INT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      price_total NUMERIC(12,2),
      link TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_expenses (
      id SERIAL PRIMARY KEY,
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      category TEXT NOT NULL DEFAULT 'אחר',
      day_number INT,
      paid_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hotels_trip ON trip_hotels(trip_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_trip ON trip_expenses(trip_id)`);

  console.log('Migration 7: admin users...');
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`);
  // ADMIN_EMAILS (comma separated) promotes accounts on every run — the site owner is the default
  const adminEmails = (process.env.ADMIN_EMAILS || 'ofiregev68@gmail.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.length) {
    await promoteAdmins(adminEmails);
  }

  console.log('Migration 8: participants + invite links (edit codes retired)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_participants (
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (trip_id, user_id)
    )`);
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS invite_token TEXT`);
  const noToken = await pool.query(`SELECT id FROM trips WHERE invite_token IS NULL`);
  for (const r of noToken.rows) {
    await pool.query(`UPDATE trips SET invite_token = $1 WHERE id = $2`,
      [require('crypto').randomBytes(16).toString('base64url'), r.id]);
  }
  if (noToken.rows.length) console.log(`  + invite tokens generated for ${noToken.rows.length} trips`);
  // run this drop only once the new (participant-based) server code is live —
  // the old code still selects edit_code and would 500 without it
  await pool.query(`ALTER TABLE trips DROP COLUMN IF EXISTS edit_code`);

  console.log('Migration 9: draft trips (created at AI build, published as a ceremony)...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips(owner_id)`);

  console.log('Migration 10: web-push subscriptions...');
  // one row per browser (endpoint is the browser's own push mailbox, and is unique
  // across users — a shared phone re-subscribing simply reassigns the row)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)`);

  console.log('Migration 11: stop votes (experimental group mode)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_stop_votes (
      item_id INT NOT NULL REFERENCES trip_items(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote SMALLINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    )`);

  console.log('Done.');
  await pool.end();
}

async function promoteAdmins(adminEmails) {
  const { rows } = await pool.query(
    `UPDATE users SET is_admin = true WHERE email = ANY($1) AND is_admin = false RETURNING email`,
    [adminEmails]
  );
  rows.forEach((r) => console.log(`  + ${r.email} promoted to admin`));
  const missing = adminEmails.filter((e) => !rows.some((r) => r.email === e));
  const { rows: already } = await pool.query(
    `SELECT email FROM users WHERE email = ANY($1) AND is_admin = true`, [adminEmails]
  );
  missing.filter((e) => !already.some((a) => a.email === e))
    .forEach((e) => console.log(`  ! no account found for ${e} — it will need promoting after signup`));
}

main().catch((err) => { console.error(err); process.exit(1); });
