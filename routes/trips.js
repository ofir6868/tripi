const express = require('express');
const { pool } = require('../lib/db');
const { authRequired, authOptional, isAdmin } = require('../lib/auth');
const {
  uniqueShareCode, tripFields, newInviteToken, isParticipant, tripWithEditAuth,
  numOrNull, moneyOrNull, cleanDestinations,
} = require('../lib/trips');
const { rateLimiter } = require('../lib/rate-limit');

const router = express.Router();

// the 6-digit share code is the only thing protecting unpublished trips, so codes
// must not be enumerable. Only *missed* lookups count — typos are rare and page
// loads of real trips never touch the counter, but a scanner burns out in seconds.
const codeMissLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const CODE_MISS_ERROR = 'יותר מדי קודים שגויים — נסו שוב בעוד רבע שעה';

router.get('/api/trips/suggested', async (_req, res) => {
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

router.get('/api/trips/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    if (/^\d{6}$/.test(q)) {
      if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
      const { rows } = await pool.query(`SELECT ${tripFields} FROM trips WHERE share_code = $1`, [q]);
      if (!rows.length) codeMissLimit.hit(req.ip);
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

router.get('/api/trips/code/:code', authOptional, async (req, res) => {
  try {
    if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
    const { rows } = await pool.query(
      `SELECT ${tripFields}, invite_token FROM trips WHERE share_code = $1`, [req.params.code]
    );
    if (!rows[0]) {
      codeMissLimit.hit(req.ip);
      return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    }
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
router.post('/api/trips/code/:code/join', authRequired, async (req, res) => {
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
router.delete('/api/trips/code/:code/participants/:userId', authOptional, async (req, res) => {
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
router.post('/api/trips/code/:code/invite/regenerate', authOptional, async (req, res) => {
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

router.post('/api/trips/code/:code/items', authOptional, async (req, res) => {
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
       numOrNull(it.lat), numOrNull(it.lon), moneyOrNull(it.cost)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.patch('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    // partial update: only the keys present in the body are touched
    const body = req.body || {};
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if ('title' in body) {
      const title = String(body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'חסרה כותרת לתחנה' });
      add('title', title.slice(0, 200));
    }
    if ('day_number' in body) add('day_number', Math.min(Math.max(parseInt(body.day_number, 10) || 1, 1), trip.days));
    if ('time_label' in body) add('time_label', body.time_label ? String(body.time_label).slice(0, 20) : null);
    if ('category' in body) add('category', body.category ? String(body.category).slice(0, 40) : null);
    if ('area' in body) add('area', body.area ? String(body.area).slice(0, 80) : null);
    if ('note' in body) add('note', body.note ? String(body.note).slice(0, 500) : null);
    if ('place_query' in body) add('place_query', body.place_query ? String(body.place_query).slice(0, 120) : null);
    if ('lat' in body) add('lat', numOrNull(body.lat));
    if ('lon' in body) add('lon', numOrNull(body.lon));
    if ('cost' in body) add('cost', moneyOrNull(body.cost));
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

router.delete('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
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

router.put('/api/trips/code/:code/budget', authOptional, async (req, res) => {
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
  const stars = numOrNull(body.stars);
  return {
    name: String(body.name || '').slice(0, 160).trim(),
    night_start: start,
    night_end: end,
    status: body.status === 'idea' ? 'idea' : 'booked',
    stars: stars != null && stars >= 1 ? Math.min(Math.round(stars), 5) : null,
    lat: numOrNull(body.lat),
    lon: numOrNull(body.lon),
    price_total: moneyOrNull(body.price_total, 999999999),
    link,
    note: body.note ? String(body.note).slice(0, 300) : null,
  };
}

router.post('/api/trips/code/:code/hotels', authOptional, async (req, res) => {
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

router.put('/api/trips/code/:code/hotels/:hotelId', authOptional, async (req, res) => {
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

router.delete('/api/trips/code/:code/hotels/:hotelId', authOptional, async (req, res) => {
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

router.post('/api/trips/code/:code/expenses', authOptional, async (req, res) => {
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

router.delete('/api/trips/code/:code/expenses/:expenseId', authOptional, async (req, res) => {
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

router.post('/api/trips/code/:code/clone', authRequired, async (req, res) => {
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

router.post('/api/trips/:id/like', async (req, res) => {
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

router.patch('/api/trips/:id', authRequired, async (req, res) => {
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

router.get('/api/my-trips', authRequired, async (req, res) => {
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

router.post('/api/trips', authRequired, async (req, res) => {
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${tripFields}, invite_token`,
      [req.user.id, title.trim(), destText.slice(0, 160), countryText, description || null,
       cover_image || null, start_date || null, end_date || null, nDays, code, emoji || null,
       JSON.stringify(dests), newInviteToken()]
    );
    const trip = rows[0];
    // one multi-row insert — an AI-built trip arrives with a hundred-plus stops,
    // and a round trip per stop is what made creation feel slow
    const rowsToInsert = (Array.isArray(items) ? items : [])
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it && it.title);
    if (rowsToInsert.length) {
      const vals = [];
      const tuples = rowsToInsert.map(({ it, i }) => {
        vals.push(
          trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), nDays),
          it.time_label || null, String(it.title).slice(0, 200), it.note || null,
          it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
          numOrNull(it.lat), numOrNull(it.lon), i
        );
        const base = vals.length - 11;
        return `(${Array.from({ length: 11 }, (_, k) => '$' + (base + k + 1)).join(',')})`;
      });
      await client.query(
        `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, sort_order)
         VALUES ${tuples.join(',')}`,
        vals
      );
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

router.delete('/api/trips/:id', authRequired, async (req, res) => {
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

module.exports = router;
