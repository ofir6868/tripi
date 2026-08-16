// The complete current schema, as one idempotent DDL block — every past migration
// already folded in. Used by db/setup.js on first boot and by the rotation restore
// endpoint when it rebuilds a brand-new (empty) database.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  owner_id INT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  country TEXT,
  description TEXT,
  cover_image TEXT,
  start_date DATE,
  end_date DATE,
  days INT DEFAULT 1,
  share_code CHAR(6) UNIQUE NOT NULL,
  is_public BOOLEAN DEFAULT false,
  is_draft BOOLEAN NOT NULL DEFAULT false,
  emoji TEXT,
  destinations JSONB NOT NULL DEFAULT '[]',
  invite_token TEXT,
  likes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- a participant can edit the trip; the owner is a participant implicitly
CREATE TABLE IF NOT EXISTS trip_participants (
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS trip_items (
  id SERIAL PRIMARY KEY,
  trip_id INT REFERENCES trips(id) ON DELETE CASCADE,
  day_number INT NOT NULL DEFAULT 1,
  time_label TEXT,
  title TEXT NOT NULL,
  note TEXT,
  place_query TEXT,
  category TEXT,
  area TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  cost NUMERIC(10,2),
  sort_order INT DEFAULT 0
);

-- one shared budget per trip; NULL total = "sum only" mode (no cap, no alerts)
CREATE TABLE IF NOT EXISTS trip_budgets (
  trip_id INT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  total NUMERIC(12,2),
  currency CHAR(3) NOT NULL DEFAULT 'ILS',
  travelers INT NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- night N = sleeping between day N and day N+1 (nights 1..days-1)
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
);

-- experimental group mode: one thumbs-up/down per participant per stop
CREATE TABLE IF NOT EXISTS trip_stop_votes (
  item_id INT NOT NULL REFERENCES trip_items(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote SMALLINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);

-- actual spending log (quick-add) — planned estimates live on trip_items.cost
CREATE TABLE IF NOT EXISTS trip_expenses (
  id SERIAL PRIMARY KEY,
  trip_id INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  category TEXT NOT NULL DEFAULT 'אחר',
  day_number INT,
  paid_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- one row per browser (endpoint is the browser's own push mailbox, and is unique
-- across users — a shared phone re-subscribing simply reassigns the row)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trips_share_code ON trips(share_code);
CREATE INDEX IF NOT EXISTS idx_trips_public ON trips(is_public);
CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips(owner_id);
CREATE INDEX IF NOT EXISTS idx_items_trip ON trip_items(trip_id);
CREATE INDEX IF NOT EXISTS idx_hotels_trip ON trip_hotels(trip_id);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON trip_expenses(trip_id);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`;

// Every table in FK-safe insert order, with its full column list. The rotation
// dump/restore pair iterates this registry, so a future migration only has to
// add its table/column here (and in SCHEMA above) for backups to keep matching.
const TABLES = [
  { name: 'users', serial: true,
    cols: ['id', 'name', 'email', 'password_hash', 'is_admin', 'created_at'] },
  { name: 'trips', serial: true, jsonb: ['destinations'],
    cols: ['id', 'owner_id', 'title', 'destination', 'country', 'description', 'cover_image',
           'start_date', 'end_date', 'days', 'share_code', 'is_public', 'is_draft', 'emoji',
           'destinations', 'invite_token', 'likes', 'created_at'] },
  { name: 'trip_participants',
    cols: ['trip_id', 'user_id', 'joined_at'] },
  { name: 'trip_items', serial: true,
    cols: ['id', 'trip_id', 'day_number', 'time_label', 'title', 'note', 'place_query',
           'category', 'area', 'lat', 'lon', 'cost', 'sort_order'] },
  { name: 'trip_budgets',
    cols: ['trip_id', 'total', 'currency', 'travelers', 'updated_at'] },
  { name: 'trip_hotels', serial: true,
    cols: ['id', 'trip_id', 'name', 'night_start', 'night_end', 'status', 'stars',
           'lat', 'lon', 'price_total', 'link', 'note', 'created_at'] },
  { name: 'trip_stop_votes',
    cols: ['item_id', 'user_id', 'vote', 'created_at'] },
  { name: 'trip_expenses', serial: true,
    cols: ['id', 'trip_id', 'title', 'amount', 'category', 'day_number', 'paid_by', 'created_at'] },
  { name: 'push_subscriptions', serial: true,
    cols: ['id', 'user_id', 'endpoint', 'p256dh', 'auth', 'user_agent', 'created_at'] },
];

module.exports = { SCHEMA, TABLES };
