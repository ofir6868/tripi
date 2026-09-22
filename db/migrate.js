// Migrations 2–28, in order. Idempotent — safe to run on every boot, and the server
// does (lib/db-bootstrap.js), so a replaced database catches up by itself.
// Usage: DATABASE_URL=postgres://... node db/migrate.js
require('../lib/env');
const { isLocalUrl } = require('../lib/canonical-origin');

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

async function migrate(pool, log = console.log) {
  log('Adding destinations column...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS destinations JSONB NOT NULL DEFAULT '[]'`);

  log('Backfilling seed trip coordinates...');
  for (const [code, dests] of Object.entries(SEED_DESTS)) {
    const { rowCount } = await pool.query(
      `UPDATE trips SET destinations = $1 WHERE share_code = $2 AND destinations = '[]'`,
      [JSON.stringify(dests), code]
    );
    if (rowCount) log(`  + ${code}: ${dests.map((d) => d.name).join(', ')}`);
  }

  log('Backfilling remaining trips from destination text (no coords)...');
  await pool.query(`
    UPDATE trips SET destinations = jsonb_build_array(jsonb_build_object('name', destination, 'country', country, 'lat', null, 'lon', null))
    WHERE destinations = '[]' AND destination IS NOT NULL AND destination <> ''
  `);

  log('Migration 3: likes...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS likes INT NOT NULL DEFAULT 0`);

  log('Migration 4: per-item area...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS area TEXT`);

  log('Migration 5: per-item coordinates...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION`);

  log('Migration 6: hotels + budget + travel stops...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2)`);
  // "תחבורה" and "נסיעה" merged into a single travel category
  const merged = await pool.query(`UPDATE trip_items SET category = 'נסיעה' WHERE category = 'תחבורה'`);
  if (merged.rowCount) log(`  + ${merged.rowCount} transport stops renamed to נסיעה`);
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

  log('Migration 7: admin users...');
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`);
  // ADMIN_EMAILS (comma separated) promotes accounts on every run — the site owner is the default
  const adminEmails = (process.env.ADMIN_EMAILS || 'ofiregev68@gmail.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.length) {
    await promoteAdmins(pool, adminEmails, log);
  }

  log('Migration 8: participants + invite links (edit codes retired)...');
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
  if (noToken.rows.length) log(`  + invite tokens generated for ${noToken.rows.length} trips`);
  // run this drop only once the new (participant-based) server code is live —
  // the old code still selects edit_code and would 500 without it
  await pool.query(`ALTER TABLE trips DROP COLUMN IF EXISTS edit_code`);

  log('Migration 9: draft trips (created at AI build, published as a ceremony)...');
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips(owner_id)`);

  log('Migration 10: web-push subscriptions...');
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

  log('Migration 11: stop votes (experimental group mode)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_stop_votes (
      item_id INT NOT NULL REFERENCES trip_items(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote SMALLINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    )`);

  log('Migration 12: push_log (scheduled reminder dedup)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_log (
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      sent_on DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (trip_id, kind, sent_on)
    )`);

  log('Migration 13: zero-pad single-digit stop hours (times sort as strings)...');
  await pool.query(`UPDATE trip_items SET time_label = '0' || time_label WHERE time_label ~ '^\\d:\\d\\d$'`);

  log('Migration 14: Google sign-in (nullable password + google_sub)...');
  await pool.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE`);

  log('Migration 15: google_place_id on trip_items (deterministic maps links)...');
  // place IDs are the one piece of Places data Google's terms allow storing
  // indefinitely — everything else (ratings, hours) must be fetched fresh off this id
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS google_place_id TEXT`);

  log('Migration 16: the planning chat (a draft is planned in conversation before it is saved)...');
  // plan_state is the chat's structured memory — the mode, the stage, the facts the
  // traveller settled and the day→area split — kept on the trip rather than derived
  // from the transcript, so the model never has to remember a decision from a turn
  // that scrolled out of its window
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS plan_state JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_plan_messages (
      id SERIAL PRIMARY KEY,
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plan_messages_trip ON trip_plan_messages(trip_id, id)`);

  log('Migration 17: referrals (three friends signed up through your link = every AI quota doubled)...');
  // referral_code is minted lazily, the first time the traveller asks for their link;
  // referred_by is set once, at signup, and never moves; referral_bonus is the
  // cached verdict lib/quota.js reads (a count query on every AI call would be waste)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_bonus BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)`);

  log('Migration 18: AI usage counters in the database (a restart used to reset every quota)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      meter TEXT NOT NULL,
      day DATE NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, meter, day)
    )`);

  log('Migration 19: expenses can mark a planned stop as paid...');
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS cost_paid BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE trip_expenses ADD COLUMN IF NOT EXISTS item_id INT REFERENCES trip_items(id) ON DELETE SET NULL`);
  // the index belongs with the ALTER that makes its column exist, never in
  // db/setup.js's schema string — see the note under the indexes there
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_item ON trip_expenses(item_id) WHERE item_id IS NOT NULL`);

  log('Migration 20: per-expense settle marks (who already paid their share back)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_expense_settlements (
      id SERIAL PRIMARY KEY,
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      expense_id INT NOT NULL REFERENCES trip_expenses(id) ON DELETE CASCADE,
      debtor_key TEXT NOT NULL,
      debtor_name TEXT NOT NULL,
      settled_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (expense_id, debtor_key)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expense_settlements_trip ON trip_expense_settlements(trip_id)`);

  log('Migration 21: system announcements (one-shot banners for users)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_announcements_published ON announcements(published_at DESC NULLS LAST)`);

  log('Migration 22: per-day recommendations for free days (trip_day_recs)...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_day_recs (
      trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_number INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      cards JSONB NOT NULL DEFAULT '[]',
      seen JSONB NOT NULL DEFAULT '[]',
      token TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (trip_id, day_number)
    )`);

  log('Migration 23: free-day picks remember what they were chosen around, and the area plan they were asked in...');
  // `context` is the cache key of a single day's picks: its area and the stops on
  // either side of it. A day whose surroundings did not change keeps its cards, so a
  // stop added on day 3 of a 30-day trip costs a couple of model calls, not thirty.
  await pool.query(`ALTER TABLE trip_day_recs ADD COLUMN IF NOT EXISTS context TEXT`);
  // the day→area split the picks are ordered and batched by, when nothing else in the
  // trip provides one (routes/day-recs.js). Cached per itinerary: the signature is
  // what the split was computed from, so any change to the trip asks for it again.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trip_rec_areas (
      trip_id INT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
      signature TEXT NOT NULL DEFAULT '',
      areas JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  log('Migration 24: the paid APIs remember what they bought (a restart used to re-buy it)...');
  // What we have spent this month, per paid SKU. The photo cap used to be `let capUsed`
  // in lib/place-photos.js, which meant the free instance counted back from zero on
  // every deploy and the 900-call ceiling never actually held — the same failure
  // migration 18 fixed for the AI quotas, one resource over.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_usage (
      meter TEXT NOT NULL,
      month CHAR(7) NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (meter, month)
    )`);
  // What we already bought. Keyed by scope so all four Google call sites share one
  // definition, and swept at 30 days because that is as long as Google's terms allow
  // their content to be kept (lib/api-budget.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_cache (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, key)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_cache_fetched ON api_cache(fetched_at)`);

  log('Migration 25: a verified stop remembers which OSM element it is...');
  // Photon already names the element it matched when a place is verified (lib/places.js);
  // until now that was thrown away. Kept, it is the free key to everything else OSM holds
  // about the place — opening_hours above all, which is the one thing a plan can get
  // wrong in a way the traveller only discovers at the door (lib/opening-hours.js).
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS osm_type TEXT`);
  await pool.query(`ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS osm_id TEXT`);

  log('Migration 26: every Google call leaves a daily record of what became of it...');
  // api_usage is the gate — one atomic count per SKU per month. This is the record beside
  // it: per SKU per Pacific day, how many calls Google served (billed), rejected (given
  // back), never answered (kept counted), how many we refused before sending, and how many
  // the cache answered instead. The admin page (/admin/google) is built from it, and so is
  // any question of the form "why did the photos stop on the 12th" (lib/api-budget.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_usage_daily (
      meter TEXT NOT NULL,
      day DATE NOT NULL,
      ok INT NOT NULL DEFAULT 0,
      rejected INT NOT NULL DEFAULT 0,
      timeouts INT NOT NULL DEFAULT 0,
      refused INT NOT NULL DEFAULT 0,
      cache_hits INT NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at TIMESTAMPTZ,
      PRIMARY KEY (meter, day)
    )`);

  log('Migration 27: a push subscription that points at a developer machine is not a mailbox...');
  // localhost, a LAN address, a .local name — these reach push_subscriptions when a local
  // build is pointed at the shared database, which is what the README tells a new developer
  // to do (there is no local Postgres). Nothing outside that machine can deliver to them,
  // and the send fails with a network error rather than the 404/410 that prunes a dead row
  // (lib/push.js), so they never leave on their own and are dialled again on every fan-out.
  // routes/push.js refuses new ones; this sweeps what is already there. It stays in the
  // migration list rather than running once because this database is replaced monthly and
  // rebuilt from an escrow dump (lib/db-restore.js) that may predate the rule — and the
  // free instance boots often enough that "every boot" is close to continuous.
  const { rows: subs } = await pool.query('SELECT id, endpoint FROM push_subscriptions');
  const localSubs = subs.filter((s) => isLocalUrl(s.endpoint));
  if (localSubs.length) {
    await pool.query('DELETE FROM push_subscriptions WHERE id = ANY($1)', [localSubs.map((s) => s.id)]);
    log(`  + dropped ${localSubs.length} push subscription(s) pointing at a local host: ${
      localSubs.map((s) => s.endpoint.slice(0, 60)).join(', ')}`);
  }

  log('Migration 28: a visitor can plan before opening an account...');
  // The sign-up wall used to stand at "create a trip": in the month before this, thirteen
  // people finished the wizard, eight met the wall, one got past it. A guest is now a
  // users row with no email and no password (lib/guest.js); the account comes when the
  // trip is saved and shared, and the guest's trips come with it. The column has to
  // allow NULL for that — UNIQUE still holds for every real address.
  await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false`);

  log('Done.');
}

async function promoteAdmins(pool, adminEmails, log) {
  const { rows } = await pool.query(
    `UPDATE users SET is_admin = true WHERE email = ANY($1) AND is_admin = false RETURNING email`,
    [adminEmails]
  );
  rows.forEach((r) => log(`  + ${r.email} promoted to admin`));
  const missing = adminEmails.filter((e) => !rows.some((r) => r.email === e));
  const { rows: already } = await pool.query(
    `SELECT email FROM users WHERE email = ANY($1) AND is_admin = true`, [adminEmails]
  );
  missing.filter((e) => !already.some((a) => a.email === e))
    .forEach((e) => log(`  ! no account found for ${e} — it will need promoting after signup`));
}

module.exports = { migrate };

if (require.main === module) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    ssl: url && url.includes('render.com')
      ? { rejectUnauthorized: false }
      : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
  });
  migrate(pool).then(() => pool.end()).catch((err) => { console.error(err); process.exit(1); });
}
