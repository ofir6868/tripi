const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');
const { authRequired, adminRequired } = require('../lib/auth');

const router = express.Router();

// Trip publish/delete reuse the routes in routes/trips.js (they already let an admin
// through), so this module is only the read views plus promoting/demoting users.

router.get('/api/admin/stats', authRequired, adminRequired, async (_req, res) => {
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

router.get('/api/admin/users', authRequired, adminRequired, async (req, res) => {
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

router.get('/api/admin/trips', authRequired, adminRequired, async (req, res) => {
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
router.post('/api/admin/users', authRequired, adminRequired, async (req, res) => {
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
router.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
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

router.patch('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
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

module.exports = router;
