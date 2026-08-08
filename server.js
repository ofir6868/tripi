// Load .env for local development (no dotenv dependency needed)
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach((line) => {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
} catch { /* no .env — fine in production */ }

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tripi-dev-secret-change-me';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function generateShareCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function uniqueShareCode(client) {
  for (let i = 0; i < 20; i++) {
    const code = generateShareCode();
    const { rows } = await client.query('SELECT 1 FROM trips WHERE share_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('could not generate share code');
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'ההתחברות פגה, נא להתחבר מחדש' });
  }
}

function authOptional(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ }
  }
  next();
}

// admin flag: trusted straight off the JWT when it's there, otherwise read once per
// request from the DB — so tokens minted before the admin column existed still work,
// and a promotion/demotion takes effect without waiting for the 30-day token to expire
async function isAdmin(req) {
  if (!req.user) return false;
  if (req.user.is_admin) return true;
  if (req.adminChecked !== undefined) return req.adminChecked;
  try {
    const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    req.adminChecked = !!(rows[0] && rows[0].is_admin);
  } catch {
    req.adminChecked = false; // a DB hiccup must never hand out admin rights
  }
  return req.adminChecked;
}

// use after authRequired
async function adminRequired(req, res, next) {
  if (!(await isAdmin(req))) return res.status(403).json({ error: 'האזור הזה מיועד למנהלי המערכת' });
  next();
}

const tripFields = `id, owner_id, title, destination, country, description, cover_image,
  start_date, end_date, days, share_code, is_public, emoji, destinations, likes, created_at`;

function newInviteToken() {
  return require('crypto').randomBytes(16).toString('base64url');
}

async function isParticipant(tripId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM trip_participants WHERE trip_id = $1 AND user_id = $2', [tripId, userId]
  );
  return rows.length > 0;
}

// resolve a trip by share code and check edit rights: owner, participant, or admin
async function tripWithEditAuth(req, res) {
  const { rows } = await pool.query(
    `SELECT ${tripFields}, invite_token FROM trips WHERE share_code = $1`, [req.params.code]
  );
  const trip = rows[0];
  if (!trip) { res.status(404).json({ error: 'הטיול לא נמצא' }); return null; }
  if (!req.user) {
    res.status(401).json({ error: 'נדרשת התחברות כדי לערוך את הטיול' });
    return null;
  }
  const allowed = req.user.id === trip.owner_id
    || await isParticipant(trip.id, req.user.id)
    || await isAdmin(req);
  if (!allowed) {
    res.status(403).json({ error: 'רק משתתפי הטיול יכולים לערוך — בקשו קישור הזמנה מהמארגנים' });
    return null;
  }
  return trip;
}

// sanitize a client-supplied destinations array → [{name, country, lat, lon}]
function cleanDestinations(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map((d) => ({
    name: String(d?.name || '').slice(0, 80).trim(),
    country: d?.country ? String(d.country).slice(0, 60).trim() : null,
    lat: Number.isFinite(+d?.lat) ? +d.lat : null,
    lon: Number.isFinite(+d?.lon) ? +d.lon : null,
  })).filter((d) => d.name);
}

// ---------- auth ----------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'נא למלא את כל השדות' });
    if (password.length < 6) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, lower($2), $3) RETURNING id, name, email, is_admin',
      [name.trim(), email.trim(), hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'נא למלא אימייל וסיסמה' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = lower($1)', [email.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the client's cached user can predate the admin column — this is the fresh copy
app.get('/api/me', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, is_admin FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'המשתמש לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- trips ----------

app.get('/api/trips/suggested', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips WHERE is_public = true ORDER BY likes DESC, id LIMIT 16`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/trips/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    if (/^\d{6}$/.test(q)) {
      const { rows } = await pool.query(`SELECT ${tripFields} FROM trips WHERE share_code = $1`, [q]);
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips
       WHERE is_public = true AND (title ILIKE $1 OR destination ILIKE $1 OR country ILIKE $1)
       ORDER BY id LIMIT 12`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/trips/code/:code', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${tripFields}, invite_token FROM trips WHERE share_code = $1`, [req.params.code]
    );
    if (!rows[0]) return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    const trip = rows[0];
    const isOwner = !!(req.user && req.user.id === trip.owner_id);
    const admin = await isAdmin(req);
    // edit rights: owner, admin, or a trip participant — unlocks prices/notes/expenses
    const canEdit = isOwner || admin || (!!req.user && await isParticipant(trip.id, req.user.id));
    if (canEdit && !trip.invite_token) {
      // trips that predate invite links get one the first time a participant loads them
      trip.invite_token = newInviteToken();
      await pool.query('UPDATE trips SET invite_token = $1 WHERE id = $2', [trip.invite_token, trip.id]);
    }
    if (!canEdit) delete trip.invite_token; // the invite link is only revealed to participants
    const [items, hotels, budget, expenses, participants] = await Promise.all([
      pool.query('SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]),
      pool.query('SELECT * FROM trip_hotels WHERE trip_id = $1 ORDER BY night_start, id', [trip.id]),
      pool.query('SELECT total, currency, travelers FROM trip_budgets WHERE trip_id = $1', [trip.id]),
      pool.query('SELECT id, title, amount, category, day_number, paid_by, created_at FROM trip_expenses WHERE trip_id = $1 ORDER BY created_at DESC, id DESC', [trip.id]),
      canEdit ? pool.query(
        `SELECT u.id, u.name, (u.id = COALESCE($2, -1)) AS is_owner
         FROM users u
         WHERE u.id = COALESCE($2, -1) OR u.id IN (SELECT user_id FROM trip_participants WHERE trip_id = $1)
         ORDER BY (u.id = COALESCE($2, -1)) DESC, u.name`,
        [trip.id, trip.owner_id]
      ) : Promise.resolve({ rows: [] }),
    ]);
    // privacy split: viewers see hotel names/nights/links but not money or
    // confirmation notes, and no expense log — those are for participants
    const hotelRows = canEdit ? hotels.rows
      : hotels.rows.map((h) => ({ ...h, price_total: null, note: null }));
    res.json({
      trip, items: items.rows, isOwner, canEdit, isAdmin: admin,
      hotels: hotelRows,
      budget: budget.rows[0] || null,
      expenses: canEdit ? expenses.rows : [],
      participants: participants.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- collaborative editing (trip participants) ----

// redeem an invite link: a logged-in user with the current token becomes a participant
app.post('/api/trips/code/:code/join', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, owner_id, invite_token FROM trips WHERE share_code = $1', [req.params.code]
    );
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'הטיול לא נמצא' });
    const token = String((req.body || {}).token || '');
    if (!token || !trip.invite_token || token !== trip.invite_token) {
      return res.status(403).json({ error: 'קישור ההזמנה כבר לא בתוקף — בקשו מהמארגנים קישור חדש' });
    }
    if (req.user.id !== trip.owner_id) {
      await pool.query(
        'INSERT INTO trip_participants (trip_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [trip.id, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// remove a participant (or yourself — leaving the trip); the owner can't be removed
app.delete('/api/trips/code/:code/participants/:userId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const uid = parseInt(req.params.userId, 10);
    if (uid === trip.owner_id) return res.status(400).json({ error: 'אי אפשר להסיר את מארגן הטיול' });
    await pool.query('DELETE FROM trip_participants WHERE trip_id = $1 AND user_id = $2', [trip.id, uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// a fresh invite token invalidates every previously shared link
app.post('/api/trips/code/:code/invite/regenerate', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const token = newInviteToken();
    await pool.query('UPDATE trips SET invite_token = $1 WHERE id = $2', [token, trip.id]);
    res.json({ invite_token: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/trips/code/:code/items', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const it = req.body || {};
    if (!it.title || !String(it.title).trim()) return res.status(400).json({ error: 'חסרה כותרת לתחנה' });
    const { rows } = await pool.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))
       RETURNING *`,
      [trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), trip.days),
       it.time_label || null, String(it.title).slice(0, 200).trim(), it.note || null,
       it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
       Number.isFinite(+it.lat) ? +it.lat : null, Number.isFinite(+it.lon) ? +it.lon : null,
       Number.isFinite(+it.cost) && +it.cost >= 0 ? Math.min(+it.cost, 99999999) : null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.patch('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    // partial update: only the keys present in the body are touched
    const body = req.body || {};
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if ('place_query' in body) add('place_query', body.place_query ? String(body.place_query).slice(0, 120) : null);
    if ('lat' in body) add('lat', Number.isFinite(+body.lat) ? +body.lat : null);
    if ('lon' in body) add('lon', Number.isFinite(+body.lon) ? +body.lon : null);
    if ('cost' in body) add('cost', Number.isFinite(+body.cost) && +body.cost >= 0 ? Math.min(+body.cost, 99999999) : null);
    if (!sets.length) return res.status(400).json({ error: 'אין מה לעדכן' });
    vals.push(req.params.itemId, trip.id);
    const { rows } = await pool.query(
      `UPDATE trip_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND trip_id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'התחנה לא נמצאה' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.delete('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [req.params.itemId, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- shared budget (one row per trip) ----

const BUDGET_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'JPY', 'THB', 'CHF'];
const EXPENSE_CATEGORIES = ['לינה', 'אוכל', 'נסיעות', 'אטרקציות', 'קניות', 'אחר'];

app.put('/api/trips/code/:code/budget', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const total = Number.isFinite(+b.total) && +b.total > 0 ? Math.min(+b.total, 999999999) : null;
    const currency = BUDGET_CURRENCIES.includes(b.currency) ? b.currency : 'ILS';
    const travelers = Math.min(Math.max(parseInt(b.travelers, 10) || 1, 1), 50);
    const { rows } = await pool.query(
      `INSERT INTO trip_budgets (trip_id, total, currency, travelers)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (trip_id) DO UPDATE SET total = $2, currency = $3, travelers = $4, updated_at = now()
       RETURNING total, currency, travelers`,
      [trip.id, total, currency, travelers]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- hotels: night N = sleeping between day N and N+1 ----

function cleanHotel(body, trip) {
  const maxNight = Math.max(trip.days - 1, 1);
  const clampNight = (v, dflt) => Math.min(Math.max(parseInt(v, 10) || dflt, 1), maxNight);
  const start = clampNight(body.night_start, 1);
  const end = Math.max(clampNight(body.night_end, start), start);
  const link = body.link && /^https?:\/\//i.test(String(body.link).trim())
    ? String(body.link).trim().slice(0, 400) : null;
  return {
    name: String(body.name || '').slice(0, 160).trim(),
    night_start: start,
    night_end: end,
    status: body.status === 'idea' ? 'idea' : 'booked',
    stars: Number.isFinite(+body.stars) && +body.stars >= 1 ? Math.min(Math.round(+body.stars), 5) : null,
    lat: Number.isFinite(+body.lat) ? +body.lat : null,
    lon: Number.isFinite(+body.lon) ? +body.lon : null,
    price_total: Number.isFinite(+body.price_total) && +body.price_total >= 0 ? Math.min(+body.price_total, 999999999) : null,
    link,
    note: body.note ? String(body.note).slice(0, 300) : null,
  };
}

app.post('/api/trips/code/:code/hotels', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const h = cleanHotel(req.body || {}, trip);
    if (!h.name) return res.status(400).json({ error: 'חסר שם למלון' });
    const { rows } = await pool.query(
      `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, lat, lon, price_total, link, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [trip.id, h.name, h.night_start, h.night_end, h.status, h.stars, h.lat, h.lon, h.price_total, h.link, h.note]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.put('/api/trips/code/:code/hotels/:hotelId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const h = cleanHotel(req.body || {}, trip);
    if (!h.name) return res.status(400).json({ error: 'חסר שם למלון' });
    const { rows } = await pool.query(
      `UPDATE trip_hotels SET name=$1, night_start=$2, night_end=$3, status=$4, stars=$5,
         lat=$6, lon=$7, price_total=$8, link=$9, note=$10
       WHERE id = $11 AND trip_id = $12 RETURNING *`,
      [h.name, h.night_start, h.night_end, h.status, h.stars, h.lat, h.lon, h.price_total, h.link, h.note,
       req.params.hotelId, trip.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'המלון לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.delete('/api/trips/code/:code/hotels/:hotelId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_hotels WHERE id = $1 AND trip_id = $2', [req.params.hotelId, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- expense log (actual spending, quick-add) ----

app.post('/api/trips/code/:code/expenses', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const title = String(b.title || '').slice(0, 160).trim();
    const amount = Number.isFinite(+b.amount) ? Math.min(+b.amount, 999999999) : NaN;
    if (!title) return res.status(400).json({ error: 'על מה הוצאתם? חסר תיאור' });
    if (!(amount > 0)) return res.status(400).json({ error: 'חסר סכום תקין' });
    const day = parseInt(b.day_number, 10);
    const { rows } = await pool.query(
      `INSERT INTO trip_expenses (trip_id, title, amount, category, day_number, paid_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, amount, category, day_number, paid_by, created_at`,
      [trip.id, title, amount,
       EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'אחר',
       day >= 1 && day <= trip.days ? day : null,
       req.user.name || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.delete('/api/trips/code/:code/expenses/:expenseId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_expenses WHERE id = $1 AND trip_id = $2', [req.params.expenseId, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- clone a trip into my account ----

app.post('/api/trips/code/:code/clone', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await pool.query(`SELECT * FROM trips WHERE share_code = $1`, [req.params.code]);
    const src = rows[0];
    if (!src) return res.status(404).json({ error: 'הטיול לא נמצא' });
    await client.query('BEGIN');
    const code = await uniqueShareCode(client);
    const t = await client.query(
      `INSERT INTO trips (owner_id, title, destination, country, description, cover_image, start_date, end_date, days, share_code, emoji, destinations, invite_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${tripFields}`,
      [req.user.id, src.title, src.destination, src.country, src.description, src.cover_image,
       src.start_date, src.end_date, src.days, code, src.emoji, JSON.stringify(src.destinations || []), newInviteToken()]
    );
    await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order)
       SELECT $1, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order
       FROM trip_items WHERE trip_id = $2`,
      [t.rows[0].id, src.id]
    );
    // the plan travels with the trip: budget frame + hotels; the expense log (actuals) doesn't
    await client.query(
      `INSERT INTO trip_budgets (trip_id, total, currency, travelers)
       SELECT $1, total, currency, travelers FROM trip_budgets WHERE trip_id = $2`,
      [t.rows[0].id, src.id]
    );
    await client.query(
      `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, lat, lon, price_total, link, note)
       SELECT $1, name, night_start, night_end, status, stars, lat, lon, price_total, link, note
       FROM trip_hotels WHERE trip_id = $2`,
      [t.rows[0].id, src.id]
    );
    await client.query('COMMIT');
    res.json(t.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

// ---- likes + publish ----

app.post('/api/trips/:id/like', async (req, res) => {
  try {
    const delta = req.body && req.body.undo ? -1 : 1;
    // likes are a gallery feature — unpublished trips don't show the button and can't be liked
    const { rows } = await pool.query(
      'UPDATE trips SET likes = GREATEST(likes + $2, 0) WHERE id = $1 AND is_public RETURNING likes',
      [req.params.id, delta]
    );
    if (!rows[0]) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.patch('/api/trips/:id', authRequired, async (req, res) => {
  try {
    const { is_public } = req.body || {};
    const admin = await isAdmin(req);
    // publishing moved to the participants screen — any participant may toggle it
    const { rows } = await pool.query(
      `UPDATE trips SET is_public = $1 WHERE id = $2 AND ($4 OR owner_id = $3
         OR EXISTS (SELECT 1 FROM trip_participants p WHERE p.trip_id = $2 AND p.user_id = $3))
       RETURNING ${tripFields}`,
      [!!is_public, req.params.id, req.user.id, admin]
    );
    if (!rows[0]) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/my-trips', authRequired, async (req, res) => {
  try {
    // trips I own plus trips I joined as a participant (is_mine tells them apart)
    const { rows } = await pool.query(
      `SELECT ${tripFields}, (owner_id = $1) AS is_mine FROM trips
       WHERE owner_id = $1 OR id IN (SELECT trip_id FROM trip_participants WHERE user_id = $1)
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/trips', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, destination, country, description, cover_image, start_date, end_date, days, emoji, items, destinations } = req.body || {};
    const dests = cleanDestinations(destinations);
    // destination display text: explicit field, or derived from the destinations list
    const destText = (destination || dests.map((d) => d.name).join(' · ')).trim();
    if (!title || !destText) return res.status(400).json({ error: 'נא למלא שם טיול ויעד' });
    const countryText = country || [...new Set(dests.map((d) => d.country).filter(Boolean))].join(', ') || null;
    await client.query('BEGIN');
    const code = await uniqueShareCode(client);
    const nDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 60);
    const { rows } = await client.query(
      `INSERT INTO trips (owner_id, title, destination, country, description, cover_image, start_date, end_date, days, share_code, emoji, destinations, invite_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${tripFields}`,
      [req.user.id, title.trim(), destText.slice(0, 160), countryText, description || null,
       cover_image || null, start_date || null, end_date || null, nDays, code, emoji || null,
       JSON.stringify(dests), newInviteToken()]
    );
    const trip = rows[0];
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || !it.title) continue;
        await client.query(
          `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), nDays),
           it.time_label || null, String(it.title).slice(0, 200), it.note || null,
           it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
           Number.isFinite(+it.lat) ? +it.lat : null, Number.isFinite(+it.lon) ? +it.lon : null, i]
        );
      }
    }
    await client.query('COMMIT');
    res.json(trip);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

app.delete('/api/trips/:id', authRequired, async (req, res) => {
  try {
    const admin = await isAdmin(req);
    const { rowCount } = await pool.query(
      'DELETE FROM trips WHERE id = $1 AND ($3 OR owner_id = $2)',
      [req.params.id, req.user.id, admin]
    );
    if (!rowCount) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- admin ----------
// Trip publish/delete reuse the routes above (they already let an admin through),
// so this section is only the read views plus promoting/demoting users.

app.get('/api/admin/stats', authRequired, adminRequired, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM users)::int                      AS users,
             (SELECT count(*) FROM trips)::int                      AS trips,
             (SELECT count(*) FROM trips WHERE is_public)::int      AS public_trips,
             (SELECT count(*) FROM trip_items)::int                 AS items,
             (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_users,
             (SELECT count(*) FROM trips WHERE created_at > now() - interval '7 days')::int AS new_trips`);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin/users', authRequired, adminRequired, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_admin, u.created_at,
              (SELECT count(*) FROM trips t WHERE t.owner_id = u.id)::int AS trip_count
       FROM users u
       WHERE $1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2
       ORDER BY u.id`,
      [q, `%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/admin/trips', authRequired, adminRequired, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.destination, t.country, t.days, t.share_code,
              t.is_public, t.likes, t.emoji, t.created_at, t.owner_id,
              u.name AS owner_name, u.email AS owner_email,
              (SELECT count(*) FROM trip_items i WHERE i.trip_id = t.id)::int AS item_count
       FROM trips t LEFT JOIN users u ON u.id = t.owner_id
       WHERE $1 = '' OR t.title ILIKE $2 OR t.destination ILIKE $2 OR t.country ILIKE $2
             OR t.share_code = $1 OR u.email ILIKE $2 OR u.name ILIKE $2
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 300`,
      [q, `%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// quick-add from the users table: the admin creates the account, no email round trip.
// Leaving the password blank mints a temporary one and returns it once, so the admin
// has something to hand over — it is never recoverable afterwards.
app.post('/api/admin/users', authRequired, adminRequired, async (req, res) => {
  try {
    const { name, email, password, is_admin } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'צריך שם' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'צריך אימייל' });
    if (password && password.length < 6) {
      return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });
    }
    const generated = password ? null : require('crypto').randomBytes(6).toString('base64url');
    const hash = await bcrypt.hash(password || generated, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, is_admin) VALUES ($1, lower($2), $3, $4)
       RETURNING id, name, email, is_admin, created_at`,
      [name.trim(), email.trim(), hash, !!is_admin]
    );
    res.json({ ...rows[0], trip_count: 0, temp_password: generated });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// Deleting a user leaves their trips standing but ownerless (trips.owner_id is
// ON DELETE SET NULL) — ?trips=delete removes those trips too, which cascades to
// their stops, hotels and expenses.
app.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    // deleting your own account mid-session would leave the panel authenticated as a ghost
    if (id === req.user.id) return res.status(400).json({ error: 'אי אפשר למחוק את המשתמש שלכם' });

    const dropTrips = req.query.trips === 'delete';
    await client.query('BEGIN');
    const { rows: found } = await client.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
    if (!found[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'המשתמש לא נמצא' });
    }
    const { rowCount: owned } = await client.query('SELECT 1 FROM trips WHERE owner_id = $1', [id]);
    let tripsDeleted = 0;
    if (dropTrips && owned) {
      ({ rowCount: tripsDeleted } = await client.query('DELETE FROM trips WHERE owner_id = $1', [id]));
    }
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ ok: true, trips_deleted: tripsDeleted, trips_orphaned: dropTrips ? 0 : owned });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const makeAdmin = !!(req.body || {}).is_admin;
    // no self-demotion: locking yourself out of the panel needs a DB round trip to undo
    if (id === req.user.id && !makeAdmin) {
      return res.status(400).json({ error: 'אי אפשר להסיר הרשאות מנהל מעצמכם' });
    }
    const { rows } = await pool.query(
      'UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING id, name, email, is_admin',
      [makeAdmin, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'המשתמש לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- AI itinerary builder (OpenAI, server-side — the key never reaches the client) ----------

const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_CATEGORIES = ['אטרקציה', 'אוכל', 'טבע', 'ים', 'תרבות', 'קניות', 'לינה', 'נוף', 'חיי לילה', 'נסיעה', 'היסטוריה', 'אמנות', 'עיר'];
const aiUsage = new Map(); // userId → {date, count}
const AI_DAILY_LIMIT = 20;

// nearest-neighbor ordering by coordinates, starting from the first destination —
// keeps multi-city trips geographically sequential (Tokyo → Kyoto → Osaka, not zigzag)
function orderByProximity(dests) {
  if (dests.length < 3 || dests.some((d) => d.lat == null || d.lon == null)) return dests;
  const rest = dests.slice(1);
  const ordered = [dests[0]];
  while (rest.length) {
    const cur = ordered[ordered.length - 1];
    let best = 0, bestDist = Infinity;
    rest.forEach((d, i) => {
      const dist = (d.lat - cur.lat) ** 2 + (d.lon - cur.lon) ** 2;
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    ordered.push(rest.splice(best, 1)[0]);
  }
  return ordered;
}

// contiguous day blocks per area, e.g. 22 days / 3 areas → 8+7+7 (fallback only)
function allocateDays(orderedDests, from, to) {
  const total = to - from + 1;
  const base = Math.floor(total / orderedDests.length);
  let extra = total % orderedDests.length;
  let cur = from;
  return orderedDests.map((d) => {
    const len = base + (extra-- > 0 ? 1 : 0);
    const block = { dest: d, from: cur, to: cur + len - 1 };
    cur += len;
    return block;
  }).filter((b) => b.to >= b.from);
}

// destinations as "עיר (מדינה)" — the country ALWAYS travels with the city name
function destDescFull(dests) {
  return dests.map((d) => d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name).join(', ');
}

// rough air distances between destinations, so the AI reasons about real travel
function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function distancesText(dests) {
  const withCoords = dests.filter((d) => d.lat != null && d.lon != null);
  if (withCoords.length < 2) return '';
  const pairs = [];
  for (let i = 0; i < withCoords.length; i++) {
    for (let j = i + 1; j < withCoords.length; j++) {
      pairs.push(`${withCoords[i].name}–${withCoords[j].name}: ~${Math.round(haversineKm(withCoords[i], withCoords[j]) / 10) * 10} ק"מ`);
    }
  }
  return pairs.length ? `\nמרחקים אוויריים משוערים בין היעדים: ${pairs.join(' | ')}.` : '';
}

// shared trip-context suffix for AI prompts
function tripPrefsText({ interestList, freeText, answers }) {
  let s = '';
  if (interestList.length) s += `\nתחומי העניין שלהם: ${interestList.join(', ')}.`;
  if (freeText) s += `\nהעדפות נוספות: "${freeText}"`;
  if (answers && answers.length) {
    s += `\nתשובות המטיילים לשאלות הבהרה: ${answers.map((a) => `${a.question} ← ${a.answer}`).join(' | ')}`;
  }
  return s;
}

// pre-flight: the AI decides whether it's missing information that would
// materially change the trip STRUCTURE (e.g. landing city on a multi-city trip).
// Strongly encouraged to ask nothing; max 2 questions, fixed component types.
async function aiClarify({ dests, from, to, interestList, freeText }) {
  const userMsg =
    `מתכננים טיול לימים ${from} עד ${to} (${to - from + 1} ימים) שמכסה את האזורים: ${destDescFull(dests)}.` +
    distancesText(dests) +
    tripPrefsText({ interestList, freeText }) +
    `\nלפני חלוקת הימים בין האזורים: האם חסר לך פרט שבאמת ישנה את מבנה הטיול (סדר האזורים, חלוקת הימים או ימי המעבר)? ` +
    `דוגמאות לפרט קריטי: באיזו עיר נוחתים וממריאים בטיול מרובה ערים במדינה גדולה; ` +
    `וכשהיעדים רחוקים מאוד זה מזה (מאות ק"מ או מדינות שונות) — איך מעדיפים לעבור ביניהם (למשל options: טיסה פנימית / רכבת או אוטובוס / שיט / רכב שכור עם עצירות בדרך). ` +
    `דוגמה נגדית: במדינה קטנה שבה נקודת הנחיתה כמעט לא משנה — אל תשאל. ` +
    `ברירת המחדל החזקה היא לא לשאול כלום ולהחזיר רשימה ריקה. שאל רק אם התשובה תשנה את התוכנית מהותית, ולכל היותר 2 שאלות קצרות בעברית. ` +
    `סוג שאלה: "choice" עם options קצרות (העדף את זה), או "text" לתשובה חופשית (options ריק).`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 400,
        messages: [
          { role: 'system', content: 'אתה מתכנן טיולים מומחה. אתה מחזיר אך ורק JSON תקין לפי הסכמה.' },
          { role: 'user', content: userMsg },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'clarifying_questions',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['questions'],
              properties: {
                questions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'question', 'options'],
                    properties: {
                      type: { type: 'string', enum: ['choice', 'text'] },
                      question: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    if (!aiRes.ok) return [];
    const data = await aiRes.json();
    return (JSON.parse(data.choices[0].message.content).questions || [])
      .slice(0, 2)
      .map((q) => ({
        type: q.type === 'choice' && Array.isArray(q.options) && q.options.length ? 'choice' : 'text',
        question: String(q.question || '').slice(0, 160),
        options: (q.options || []).slice(0, 6).map((o) => String(o).slice(0, 60)),
      }))
      .filter((q) => q.question);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// trip meta: description + emoji + cover image. The AI sees only the NAMES of
// the cover photos (token-cheap) and picks one; the server maps name → URL.
const TRIP_EMOJIS = ['🧭', '🏖️', '🏔️', '🏛️', '🌸', '🎡', '🍜', '🚐', '🤿', '🎿', '🐫', '🦁', '🗼', '🚋', '🥥', '🗽', '🥐', '⛰️'];
const COVER_U = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;
const COVER_OPTIONS = [
  { name: 'כביש מדברי בשקיעה', url: COVER_U('photo-1469854523086-cc02fe5d8800') },
  { name: 'חוף טרופי עם מים צלולים', url: COVER_U('photo-1507525428034-b723cf961d3e') },
  { name: 'פסגות הרים מושלגות', url: COVER_U('photo-1464822759023-fed622ff2c3b') },
  { name: 'הקולוסיאום ורומא העתיקה', url: COVER_U('photo-1552832230-c0197dd311b5') },
  { name: 'רחוב ניאון יפני בלילה', url: COVER_U('photo-1540959733332-eab4deabeeaf') },
  { name: 'מגדל אייפל ופריז', url: COVER_U('photo-1502602898657-3e91760cbb34') },
  { name: 'סנטוריני — בתים לבנים וים', url: COVER_U('photo-1613395877344-13d4a8e0d49e') },
  { name: 'קאנו על אגם בין הרים', url: COVER_U('photo-1476514525535-07fb3b4ae5f1') },
];

// location-specific covers may only be used when the trip actually goes there
const COVER_TAGS = {
  'הקולוסיאום ורומא העתיקה': ['רומא', 'איטליה', 'rome', 'italy'],
  'רחוב ניאון יפני בלילה': ['יפן', 'טוקיו', 'אוסקה', 'קיוטו', 'japan', 'tokyo'],
  'מגדל אייפל ופריז': ['פריז', 'צרפת', 'paris', 'france'],
  'סנטוריני — בתים לבנים וים': ['סנטוריני', 'יוון', 'santorini', 'greece'],
};
function validateCoverChoice(chosenName, dests) {
  const hay = dests.map((d) => `${d.name} ${d.country || ''}`).join(' ').toLowerCase();
  const tags = COVER_TAGS[chosenName];
  if (!tags) return chosenName; // generic photo — always fine
  if (tags.some((t) => hay.includes(t))) return chosenName;
  // model picked a landmark from the wrong country — swap to a matching one, else generic
  for (const [name, ts] of Object.entries(COVER_TAGS)) {
    if (ts.some((t) => hay.includes(t))) return name;
  }
  return COVER_OPTIONS[0].name;
}

async function aiTripMeta({ dests, from, to, interestList, freeText, answers }) {
  const destDesc = destDescFull(dests);
  const coverNames = COVER_OPTIONS.map((c) => c.name);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 350,
        messages: [
          { role: 'system', content: 'אתה קופירייטר של טיולים. אתה מחזיר אך ורק JSON תקין לפי הסכמה.' },
          { role: 'user', content:
            `טיול של ${to - from + 1} ימים ב: ${destDesc}.` + tripPrefsText({ interestList, freeText, answers }) +
            `\n1. כתוב תיאור קצר, חם ומזמין (2-3 משפטים, עברית).` +
            `\n2. בחר אימוג'י אחד שהכי מתאים לאופי הטיול.` +
            `\n3. בחר את תמונת הנושא שהכי מתאימה מתוך הרשימה (לפי השם בלבד). ` +
            `חשוב: תמונה של עיר או אתר מסוים מותרת רק אם הטיול באמת מבקר שם — לטיול במקום אחר בחר תמונה כללית (נוף, חוף, הרים, כביש).` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'trip_meta',
            strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              required: ['description', 'emoji', 'cover'],
              properties: {
                description: { type: 'string' },
                emoji: { type: 'string', enum: TRIP_EMOJIS },
                cover: { type: 'string', enum: COVER_OPTIONS.map((c) => c.name) },
              },
            },
          },
        },
      }),
    });
    if (!aiRes.ok) return null;
    const data = await aiRes.json();
    const meta = JSON.parse(data.choices[0].message.content);
    const coverName = validateCoverChoice(meta.cover, dests);
    return {
      description: String(meta.description || '').slice(0, 500) || null,
      emoji: TRIP_EMOJIS.includes(meta.emoji) ? meta.emoji : '🧭',
      cover_image: (COVER_OPTIONS.find((c) => c.name === coverName) || COVER_OPTIONS[0]).url,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// stage 1: the AI itself decides city order and how many days each deserves —
// a small, cheap call whose output is easy to validate structurally
async function aiPlanBlocks({ dests, from, to, interestList, freeText, answers }) {
  const areaNames = dests.map((d) => d.name);
  let userMsg =
    `טיול לימים ${from} עד ${to} (כולל, סה"כ ${to - from + 1} ימים) שמכסה את האזורים: ${destDescFull(dests)}. ` +
    distancesText(dests) +
    `\nחלק את הימים בין האזורים: קבע סדר ביקור גיאוגרפי הגיוני, והקצה לכל אזור כמות ימים לפי כמה שיש בו לראות ולעשות עבור המטיילים האלה — לא בהכרח שווה בשווה. ` +
    `קח בחשבון זמני נסיעה: מעבר בין אזורים רחוקים (מאות ק"מ, טיסה או נסיעה ארוכה) גוזל חצי יום עד יום — שקלל את זה בהקצאת הימים של האזור שאליו מגיעים. ` +
    `כל אזור מופיע פעם אחת בדיוק, הבלוקים רצופים ומכסים את כל טווח הימים בלי חורים ובלי חפיפות.` +
    tripPrefsText({ interestList, freeText, answers });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 600,
        messages: [
          { role: 'system', content: 'אתה מתכנן טיולים מומחה. אתה מחזיר אך ורק JSON תקין לפי הסכמה.' },
          { role: 'user', content: userMsg },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'day_allocation',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['blocks'],
              properties: {
                blocks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['area', 'day_from', 'day_to'],
                    properties: {
                      area: { type: 'string', enum: areaNames },
                      day_from: { type: 'integer' },
                      day_to: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    if (!aiRes.ok) return null;
    const data = await aiRes.json();
    const blocks = (JSON.parse(data.choices[0].message.content).blocks || [])
      .map((b) => ({ dest: dests.find((d) => d.name === b.area), from: b.day_from, to: b.day_to }))
      .sort((a, b) => a.from - b.from);

    // structural validation: every area once, contiguous, exact coverage — else reject
    if (!blocks.length || blocks.some((b) => !b.dest || b.to < b.from)) return null;
    if (new Set(blocks.map((b) => b.dest.name)).size !== blocks.length) return null;
    if (blocks.length !== dests.length) return null;
    if (blocks[0].from !== from || blocks[blocks.length - 1].to !== to) return null;
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i].from !== blocks[i - 1].to + 1) return null;
    }
    return blocks;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// one OpenAI call for ONE area and a fixed day range — the shape that stays coherent
async function aiGenerateBlock({ dests, area, from, to, interestList, freeText, answers, transferFrom }) {
  let userMsg =
    `בנה מסלול טיול מפורט לימים ${from} עד ${to} (כולל) באזור "${area}" בלבד, מתוך טיול שכולל את: ${destDescFull(dests)}. ` +
    `כל התחנות חייבות להיות באזור "${area}" ובשדה area לכתוב בדיוק "${area}". ` +
    `אסור לשבץ תחנות מאזורים אחרים בטווח הימים הזה.`;
  if (transferFrom) {
    const fromDest = dests.find((d) => d.name === transferFrom);
    const toDest = dests.find((d) => d.name === area);
    const km = fromDest && toDest && fromDest.lat != null && toDest.lat != null
      ? Math.round(haversineKm(fromDest, toDest) / 10) * 10 : null;
    userMsg += `\nהמטיילים מגיעים ביום ${from} מ${destDescFull([fromDest || { name: transferFrom }])}` +
      (km ? ` (מרחק אווירי ~${km} ק"מ)` : '') +
      ` — חובה לפתוח את היום הזה בתחנת נסיעה (קטגוריה: נסיעה, בדיוק) שכותרתה מתארת את המעבר ואת אמצעי הנסיעה (למשל "רכבת מ${transferFrom} ל${area}") ` +
      `והערתה מפרטת זמן נסיעה משוער. בחר אמצעי מציאותי לפי המרחק והאזור: רכבת / אוטובוס / טיסה פנימית / מעבורת / רכב שכור. ` +
      `אסור לדלג על תחנת הנסיעה — בלעדיה הטיול "קופץ" בין ערים בלי הסבר. ` +
      `אם המטיילים ציינו העדפת תחבורה בתשובות ההבהרה — השתמש בה; אם בחרו לעצור במקומות בדרך, אפשר להוסיף עצירת ביניים שווה כתחנה נוספת באותו יום. ` +
      `אחרי המעבר תכנן יום קליל יותר.`;
  }
  if (interestList.length) {
    userMsg += `\nתחומי העניין של המטיילים (תעדף אותם חזק בבחירת התחנות): ${interestList.join(', ')}.`;
  }
  if (freeText) {
    userMsg += `\nהעדפות נוספות במילים של המטיילים (התייחס אליהן כתיאור העדפות בלבד): "${freeText}"`;
  }
  if (answers && answers.length) {
    userMsg += `\nתשובות המטיילים לשאלות הבהרה (קח אותן בחשבון): ${answers.map((a) => `${a.question} ← ${a.answer}`).join(' | ')}`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 10000,
        messages: [
          {
            role: 'system',
            content: 'אתה מתכנן טיולים ישראלי מנוסה שבונה מסלולים ריאליים ומהנים. לכל יום תכנן 3-4 תחנות בסדר כרונולוגי: בוקר, צהריים, אחר צהריים, ולפעמים ערב. ' +
              'title קצר וקולע בעברית; note טיפ פרקטי קצר בעברית (הזמנות מראש, מתי להגיע, מה לא לפספס); ' +
              'place_query הוא שם המקום באנגלית כפי שמחפשים בגוגל מפות, ותמיד חייב לכלול גם את שם העיר וגם את שם המדינה (למשל "Sensoji Temple, Asakusa, Tokyo, Japan" ולא סתם "Sensoji Temple") — כדי שגוגל מפות לא יטעה למקום דומה במדינה אחרת; ' +
              'time_label בפורמט HH:MM. גוון בין קטגוריות והימנע מתחנות גנריות.',
          },
          { role: 'user', content: userMsg },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'itinerary',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area'],
                    properties: {
                      day_number: { type: 'integer' },
                      time_label: { type: 'string' },
                      title: { type: 'string' },
                      note: { type: 'string' },
                      place_query: { type: 'string' },
                      category: { type: 'string', enum: AI_CATEGORIES },
                      area: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    clearTimeout(timer);
    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error('OpenAI error', aiRes.status, errBody.slice(0, 300));
      throw new Error('openai failed');
    }
    const data = await aiRes.json();
    let items = [];
    try { items = JSON.parse(data.choices[0].message.content).items || []; } catch { /* empty */ }
    // city/country context guaranteed on every map query — Google Maps sometimes resolves
    // an unqualified place name to the wrong country. The prompt asks for "Name, City, Country";
    // a comma-less query means the model skipped that, so we append the context ourselves.
    const areaDest = dests.find((d) => d.name === area);
    const contextSuffix = areaDest && areaDest.country && areaDest.country !== areaDest.name
      ? `${area}, ${areaDest.country}` : area;
    const withContext = (q) => (q.includes(',') ? q : `${q}, ${contextSuffix}`.slice(0, 120));
    // hard-enforce the block's day range and area regardless of what the model wrote
    const cleaned = items
      .filter((it) => it && it.title && it.day_number >= from && it.day_number <= to)
      .map((it) => ({
        day_number: it.day_number,
        time_label: /^\d{1,2}:\d{2}$/.test(it.time_label || '') ? it.time_label : null,
        title: String(it.title).slice(0, 200),
        note: it.note ? String(it.note).slice(0, 300) : null,
        place_query: it.place_query ? withContext(String(it.place_query).slice(0, 90)) : null,
        category: AI_CATEGORIES.includes(it.category) ? it.category : 'אטרקציה',
        area,
      }));
    // travel stops are mandatory between areas: if the model skipped the נסיעה stop
    // (or labeled it something else), synthesize one so the trip never teleports
    if (transferFrom && !cleaned.some((it) => it.day_number === from && it.category === 'נסיעה')) {
      const fromDest = dests.find((d) => d.name === transferFrom);
      const toDest = dests.find((d) => d.name === area);
      const km = fromDest && toDest && fromDest.lat != null && toDest.lat != null
        ? Math.round(haversineKm(fromDest, toDest) / 10) * 10 : null;
      cleaned.unshift({
        day_number: from,
        time_label: '08:00',
        title: `נסיעה מ${transferFrom} ל${area}`,
        note: km ? `מעבר בין אזורים (~${km} ק"מ אוויר) — בדקו מראש זמני יציאה וכרטיסים` : 'מעבר בין אזורים — בדקו מראש זמני יציאה וכרטיסים',
        place_query: null,
        category: 'נסיעה',
        area,
      });
    }
    return cleaned;
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/ai/itinerary', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'בניית AI לא זמינה כרגע' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = aiUsage.get(req.user.id);
    const used = usage && usage.date === today ? usage.count : 0;
    // admins still get counted (the panel shows the number) but are never capped
    if (used >= AI_DAILY_LIMIT && !(await isAdmin(req))) {
      return res.status(429).json({ error: 'הגעתם למכסת בניות ה-AI היומית — נסו שוב מחר' });
    }

    const { destinations, area, day_from, day_to, interests, notes, answers, want_description } = req.body || {};
    const interestList = (Array.isArray(interests) ? interests : [])
      .slice(0, 15).map((s) => String(s).slice(0, 40).trim()).filter(Boolean);
    const freeText = notes ? String(notes).slice(0, 500).trim() : '';
    const dests = cleanDestinations(destinations);
    if (!dests.length) return res.status(400).json({ error: 'חסרים יעדים' });
    const from = Math.min(Math.max(parseInt(day_from, 10) || 1, 1), 60);
    const to = Math.min(Math.max(parseInt(day_to, 10) || from, from), 60);
    if (to - from + 1 > 30) return res.status(400).json({ error: 'אפשר לבנות עד 30 ימים בבקשה אחת' });
    const areaNames = dests.map((d) => d.name);
    if (area && !areaNames.includes(area)) return res.status(400).json({ error: 'אזור לא מוכר' });

    // clarifying-questions round: only for full multi-area builds, only when the
    // client hasn't been through it yet (answers absent, even as an empty array).
    // Doesn't consume the daily quota.
    const answerList = Array.isArray(answers)
      ? answers.slice(0, 4).map((a) => ({
          question: String(a?.question || '').slice(0, 160),
          answer: String(a?.answer || '').slice(0, 160),
        })).filter((a) => a.question && a.answer)
      : null;
    if (!area && dests.length >= 2 && answerList === null) {
      const questions = await aiClarify({ dests, from, to, interestList, freeText });
      if (questions.length) return res.json({ questions });
    }

    // build the per-area blocks: a single requested area, or an AI-decided
    // allocation (order + days per city). The AI plans; the server only verifies
    // that the blocks are contiguous — falling back to an even split if invalid.
    let blocks;
    if (area) {
      blocks = [{ dest: dests.find((d) => d.name === area), from, to }];
    } else if (dests.length === 1) {
      blocks = [{ dest: dests[0], from, to }];
    } else {
      blocks = await aiPlanBlocks({ dests, from, to, interestList, freeText, answers: answerList })
        || allocateDays(orderByProximity(dests), from, to);
    }

    const wantMeta = want_description || req.body.want_meta;
    const descPromise = wantMeta
      ? aiTripMeta({ dests, from, to, interestList, freeText, answers: answerList })
      : Promise.resolve(null);

    const [results, meta] = await Promise.all([
      Promise.all(blocks.map((b, i) =>
        aiGenerateBlock({
          dests,
          area: b.dest.name,
          from: b.from,
          to: b.to,
          interestList,
          freeText,
          answers: answerList,
          transferFrom: i > 0 ? blocks[i - 1].dest.name : null,
        })
      )),
      descPromise,
    ]);
    const items = results.flat()
      .sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')))
      .slice(0, 200);
    if (!items.length) return res.status(502).json({ error: 'ה-AI החזיר מסלול ריק — נסו שוב' });

    aiUsage.set(req.user.id, { date: today, count: used + 1 });
    res.json({
      items,
      plan: blocks.map((b) => ({ area: b.dest.name, from: b.from, to: b.to })),
      meta,
      description: meta ? meta.description : null, // back-compat
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'ה-AI התעכב יותר מדי — נסו שוב' : 'ה-AI לא הצליח לבנות את המסלול — נסו שוב עוד רגע' });
  }
});

// ---------- AI trip editor: one structured-diff call over the current itinerary ----------
// The trip was built by several parallel structured calls (no stored transcript), and
// manual edits diverge from it anyway — so each edit request sends a fresh, compact
// snapshot of the CURRENT itinerary instead of replaying any "creation conversation".

const AI_EDIT_DAILY_LIMIT = 3;
const AI_EDIT_MAX_PROMPT = 100;
const aiEditUsage = new Map(); // 'u<userId>' → {date, count}

async function aiEditOps({ title, destText, dests, days, items, prompt, scopeNote = '', opsCap = 30 }) {
  const areaNames = dests.map((d) => d.name);
  const itemLines = items.map((it) =>
    `#${it.id} | יום ${it.day_number} | ${it.time_label || '--:--'} | [${it.category || 'כללי'}] ${it.title}` +
    (areaNames.length > 1 && it.area ? ` | אזור: ${it.area}` : '') +
    (it.place_query ? ` | ${it.place_query}` : ''));
  const userMsg =
    `הטיול: "${title}" — ${dests.length ? destDescFull(dests) : destText}, ${days} ימים (1 עד ${days}).` +
    `\nהמסלול הנוכחי (כל שורה: #מזהה | יום | שעה | [קטגוריה] כותרת | מקום):\n${itemLines.join('\n') || '(המסלול עדיין ריק)'}` +
    (scopeNote ? `\n${scopeNote}` : '') +
    `\n\nבקשת השינוי של המטיילים: "${prompt}"`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 5000,
        messages: [
          {
            role: 'system',
            content: 'אתה עורך מסלולי טיולים. מקבל מסלול קיים ובקשת שינוי קצרה, ומחזיר אך ורק JSON לפי הסכמה: ops (רשימת פעולות) ו-summary (סיכום קצר וידידותי בעברית של מה ששינית). ' +
              'כללים: שנה רק את מה שהתבקש ואל תיגע בשאר התחנות. אתה רשאי לשנות אך ורק תחנות מסלול (add/update/delete). ' +
              'בקשות על תאריכים, תקציב, מלונות, תמונת נושא או כל דבר שאינו תחנות — החזר ops ריק והסבר ב-summary שדרך הקסם אפשר לשנות רק את תחנות המסלול. ' +
              'אם הבקשה לא ברורה — החזר ops ריק ושאלת הבהרה קצרה ב-summary. ' +
              'update/delete חייבים id של תחנה קיימת; ב-update החזר null בכל שדה שלא משתנה. ' +
              'add חייב title קצר בעברית; note טיפ פרקטי קצר בעברית; time_label בפורמט HH:MM; ' +
              'place_query באנגלית וכולל תמיד עיר ומדינה (למשל "Nishiki Market, Kyoto, Japan"), ורק למקום אמיתי וספציפי שניתן למצוא בגוגל מפות — לתחנה כללית (כמו "ארוחת ערב" בלי מקום מוגדר) החזר null; ' +
              `category מתוך: ${AI_CATEGORIES.join(', ')}` +
              (areaNames.length > 1 ? `; area מתוך: ${areaNames.join(', ')}.` : '.'),
          },
          { role: 'user', content: userMsg },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'trip_edit',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['summary', 'ops'],
              properties: {
                summary: { type: 'string' },
                ops: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['action', 'id', 'day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area'],
                    properties: {
                      action: { type: 'string', enum: ['add', 'update', 'delete'] },
                      id: { type: ['integer', 'null'] },
                      day_number: { type: ['integer', 'null'] },
                      time_label: { type: ['string', 'null'] },
                      title: { type: ['string', 'null'] },
                      note: { type: ['string', 'null'] },
                      place_query: { type: ['string', 'null'] },
                      category: { type: ['string', 'null'] },
                      area: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error('OpenAI ai-edit error', aiRes.status, errBody.slice(0, 300));
      return null;
    }
    const data = await aiRes.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return {
      summary: String(parsed.summary || '').slice(0, 300),
      ops: Array.isArray(parsed.ops) ? parsed.ops.slice(0, opsCap) : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/trips/code/:code/ai-edit', authOptional, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'עריכת AI לא זמינה כרגע' });
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const prompt = String((req.body || {}).prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'כתבו מה לשנות במסלול' });
    if (prompt.length > AI_EDIT_MAX_PROMPT) {
      return res.status(400).json({ error: `הבקשה ארוכה מדי — עד ${AI_EDIT_MAX_PROMPT} תווים` });
    }

    // 3 AI edits a day per user (editing requires login, so req.user is always set here)
    const quotaKey = 'u' + req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const usage = aiEditUsage.get(quotaKey);
    const used = usage && usage.date === today ? usage.count : 0;
    if (used >= AI_EDIT_DAILY_LIMIT) {
      return res.status(429).json({ error: 'ניצלתם את שלושת שינויי ה-AI להיום — אפשר להמשיך לערוך ידנית, או לנסות שוב מחר' });
    }

    const { rows: items } = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    const result = await aiEditOps({
      title: trip.title,
      destText: trip.destination,
      dests: Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [],
      days: trip.days,
      items,
      prompt,
    });
    if (!result) return res.status(502).json({ error: 'ה-AI לא הצליח לעבד את הבקשה — נסו שוב עוד רגע' });
    aiEditUsage.set(quotaKey, { date: today, count: used + 1 }); // the model call is the budgeted resource

    const validIds = new Set(items.map((it) => it.id));
    const clampDay = (d) => Math.min(Math.max(parseInt(d, 10) || 1, 1), trip.days);
    const cleanTime = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t : null);
    let added = 0, updated = 0, removed = 0;
    await client.query('BEGIN');
    for (const op of result.ops) {
      if (op.action === 'delete' && validIds.has(op.id)) {
        await client.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [op.id, trip.id]);
        removed++;
      } else if (op.action === 'update' && validIds.has(op.id)) {
        const sets = [];
        const vals = [];
        const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
        if (op.day_number != null) add('day_number', clampDay(op.day_number));
        if (op.time_label != null) add('time_label', cleanTime(op.time_label));
        if (op.title != null && String(op.title).trim()) add('title', String(op.title).slice(0, 200).trim());
        if (op.note != null) add('note', String(op.note).slice(0, 300) || null);
        if (op.place_query != null) {
          add('place_query', String(op.place_query).slice(0, 120) || null);
          // the stop moved somewhere else — stale coordinates would pin the old spot
          add('lat', null);
          add('lon', null);
        }
        if (op.category != null && AI_CATEGORIES.includes(op.category)) add('category', op.category);
        if (op.area != null) add('area', String(op.area).slice(0, 80) || null);
        if (sets.length) {
          vals.push(op.id, trip.id);
          await client.query(
            `UPDATE trip_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND trip_id = $${vals.length}`, vals
          );
          updated++;
        }
      } else if (op.action === 'add' && op.title && String(op.title).trim()) {
        await client.query(
          `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))`,
          [trip.id, clampDay(op.day_number), cleanTime(op.time_label), String(op.title).slice(0, 200).trim(),
           op.note ? String(op.note).slice(0, 300) : null,
           op.place_query ? String(op.place_query).slice(0, 120) : null,
           AI_CATEGORIES.includes(op.category) ? op.category : 'אטרקציה',
           op.area ? String(op.area).slice(0, 80) : null]
        );
        added++;
      }
    }
    await client.query('COMMIT');

    const fresh = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    res.json({
      summary: result.summary || 'בוצע',
      added, updated, removed,
      items: fresh.rows,
      remaining: AI_EDIT_DAILY_LIMIT - used - 1,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

// draft edits: the plan wizard's itinerary lives only in the client, so the ops are
// computed here (same model call, same daily quota) and applied by the browser.
// An optional area + day range scopes the request — the integrated replacement for
// the old "build a specific area" form, including full in-range rebuilds.
app.post('/api/ai/edit-draft', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'עריכת AI לא זמינה כרגע' });
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'כתבו מה לשנות במסלול' });
    if (prompt.length > AI_EDIT_MAX_PROMPT) {
      return res.status(400).json({ error: `הבקשה ארוכה מדי — עד ${AI_EDIT_MAX_PROMPT} תווים` });
    }
    const dests = cleanDestinations(b.destinations);
    if (!dests.length) return res.status(400).json({ error: 'חסרים יעדים' });
    const days = Math.min(Math.max(parseInt(b.days, 10) || 1, 1), 60);
    const cleanTime = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t : null);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it) => ({
      id: parseInt(it?.id, 10) || 0,
      day_number: Math.min(Math.max(parseInt(it?.day_number, 10) || 1, 1), days),
      time_label: cleanTime(it?.time_label),
      title: String(it?.title || '').slice(0, 200),
      note: it?.note ? String(it.note).slice(0, 300) : null,
      place_query: it?.place_query ? String(it.place_query).slice(0, 120) : null,
      category: AI_CATEGORIES.includes(it?.category) ? it.category : null,
      area: it?.area ? String(it.area).slice(0, 80) : null,
    })).filter((it) => it.id && it.title);

    // optional scope: one area within a day range (multi-destination trips)
    const areaNames = dests.map((d) => d.name);
    const area = b.area && areaNames.includes(b.area) ? b.area : null;
    let from = 1, to = days, scopeNote = '';
    if (area) {
      from = Math.min(Math.max(parseInt(b.day_from, 10) || 1, 1), days);
      to = Math.min(Math.max(parseInt(b.day_to, 10) || days, from), days);
      scopeNote = `החל את הבקשה אך ורק על אזור "${area}" בימים ${from} עד ${to}: ` +
        `כל תחנה שתוסיף תהיה באזור הזה ובטווח הימים הזה (שדה area: "${area}"), ואל תיגע בתחנות מחוץ לטווח. ` +
        `אם התבקשה בנייה מחדש — החלף את כל התחנות בטווח (מחיקות + הוספות), 3-4 תחנות ליום בסדר כרונולוגי.`;
    }

    const quotaKey = 'u' + req.user.id; // shared daily pool with the trip-page AI edits
    const today = new Date().toISOString().slice(0, 10);
    const usage = aiEditUsage.get(quotaKey);
    const used = usage && usage.date === today ? usage.count : 0;
    if (used >= AI_EDIT_DAILY_LIMIT) {
      return res.status(429).json({ error: 'ניצלתם את שלושת שינויי ה-AI להיום — אפשר להמשיך לערוך ידנית, או לנסות שוב מחר' });
    }

    const result = await aiEditOps({
      title: String(b.title || '').slice(0, 80) || 'טיול חדש',
      destText: dests.map((d) => d.name).join(' · '),
      dests, days, items, prompt, scopeNote,
      opsCap: 60, // scoped rebuilds legitimately delete + re-add several days
    });
    if (!result) return res.status(502).json({ error: 'ה-AI לא הצליח לעבד את הבקשה — נסו שוב עוד רגע' });
    aiEditUsage.set(quotaKey, { date: today, count: used + 1 });

    // sanitize ops for the client: known ids, clamped days, scope enforced
    const byId = new Map(items.map((it) => [it.id, it]));
    const inScope = (day) => !area || (day >= from && day <= to);
    const clampDay = (d, dflt) => Math.min(Math.max(parseInt(d, 10) || dflt, 1), days);
    const ops = [];
    for (const op of result.ops) {
      if (op.action === 'delete') {
        const target = byId.get(op.id);
        if (target && inScope(target.day_number)) ops.push({ action: 'delete', id: op.id });
      } else if (op.action === 'update') {
        const target = byId.get(op.id);
        if (!target || !inScope(target.day_number)) continue;
        const day = op.day_number != null ? clampDay(op.day_number, target.day_number) : null;
        if (day != null && !inScope(day)) continue;
        ops.push({
          action: 'update',
          id: op.id,
          day_number: day,
          time_label: op.time_label != null ? cleanTime(op.time_label) : null,
          title: op.title != null && String(op.title).trim() ? String(op.title).slice(0, 200).trim() : null,
          note: op.note != null ? String(op.note).slice(0, 300) : null,
          place_query: op.place_query != null ? String(op.place_query).slice(0, 120) : null,
          category: op.category != null && AI_CATEGORIES.includes(op.category) ? op.category : null,
          area: op.area != null ? String(op.area).slice(0, 80) : null,
        });
      } else if (op.action === 'add' && op.title && String(op.title).trim()) {
        const day = clampDay(op.day_number, from);
        if (!inScope(day)) continue;
        ops.push({
          action: 'add',
          day_number: day,
          time_label: cleanTime(op.time_label),
          title: String(op.title).slice(0, 200).trim(),
          note: op.note ? String(op.note).slice(0, 300) : null,
          place_query: op.place_query ? String(op.place_query).slice(0, 120) : null,
          category: AI_CATEGORIES.includes(op.category) ? op.category : 'אטרקציה',
          area: op.area ? String(op.area).slice(0, 80) : (area || null),
        });
      }
    }
    res.json({ summary: result.summary || 'בוצע', ops, remaining: AI_EDIT_DAILY_LIMIT - used - 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- hotels (OSM Overpass, server-side with cache) ----------

const hotelsCache = new Map(); // "lat,lon" → {at, data}
const HOTELS_TTL = 24 * 60 * 60 * 1000;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

app.get('/api/hotels', async (req, res) => {
  const lat = Math.round(parseFloat(req.query.lat) * 100) / 100;
  const lon = Math.round(parseFloat(req.query.lon) * 100) / 100;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'bad coords' });

  const key = `${lat},${lon}`;
  const cached = hotelsCache.get(key);
  if (cached && Date.now() - cached.at < HOTELS_TTL) return res.json(cached.data);

  // node-only: way/relation geometry resolution regularly 504s on the public servers
  const query = `[out:json][timeout:25];node["tourism"="hotel"]["name"](around:7000,${lat},${lon});out 30;`;
  let elements = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 28000); // public Overpass servers regularly need 15-20s
      const r = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TRIPI trip planner/1.0 (github.com/ofir6868/tripi)',
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) continue;
      elements = (await r.json()).elements || [];
      break;
    } catch { /* try next mirror */ }
  }
  if (elements === null) return res.json([]); // all mirrors down — client shows Booking fallback

  const seen = new Set();
  const hotels = elements
    .map((el) => ({
      name: el.tags?.['name:he'] || el.tags?.name,
      stars: el.tags?.stars || null,
      lat: el.lat ?? el.center?.lat,
      lon: el.lon ?? el.center?.lon,
    }))
    .filter((h) => h.name && !seen.has(h.name) && seen.add(h.name))
    .slice(0, 8);
  hotelsCache.set(key, { at: Date.now(), data: hotels });
  res.json(hotels);
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// pretty routes — /trip/:code gets Open Graph tags injected so WhatsApp/social previews
// show the trip cover, title and code
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
let tripHtmlCache = null;
app.get('/trip/:code', async (req, res) => {
  // cache the page only in production — in dev, re-read so edits show up without a restart
  if (!tripHtmlCache || process.env.NODE_ENV !== 'production') {
    tripHtmlCache = require('fs').readFileSync(path.join(__dirname, 'public', 'trip.html'), 'utf8');
  }
  let html = tripHtmlCache;
  try {
    const { rows } = await pool.query(
      'SELECT title, destination, description, cover_image, days, share_code, emoji FROM trips WHERE share_code = $1',
      [req.params.code]
    );
    const t = rows[0];
    if (t) {
      const title = `${t.emoji || '🧭'} ${t.title} · TRIPI`;
      const desc = `${t.destination} · ${t.days} ימים · קוד טיול ${t.share_code}` +
        (t.description ? ` — ${t.description.slice(0, 120)}` : '');
      const og = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TRIPI">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  ${t.cover_image ? `<meta property="og:image" content="${escapeHtml(t.cover_image)}">` : ''}
  <meta property="og:url" content="https://tripi-caw3.onrender.com/trip/${escapeHtml(t.share_code)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="description" content="${escapeHtml(desc)}">`;
      html = html
        .replace('<title>טיול · TRIPI</title>', `<title>${escapeHtml(title)}</title>${og}`);
    }
  } catch { /* serve the plain page on any error */ }
  res.type('html').send(html);
});
app.get('/plan', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'plan.html')));
app.get('/my', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'my.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => console.log(`TRIPI running on http://localhost:${PORT}`));
