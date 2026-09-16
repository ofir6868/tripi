const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');
const { authRequired, adminRequired, authOptional } = require('../lib/auth');
const { notifyAnnouncementAsync } = require('../lib/push');

const router = express.Router();

// Trip publish/delete reuse the routes in routes/trips.js (they already let an admin
// through), so this module is only the read views plus promoting/demoting users.

// ---- system announcements (one-shot banners) ----
// Public: the latest published message — any page can ask without auth.
// Admin: compose / list / delete. Dismiss is device-local (localStorage).
// Optional push fan-out to every subscribed browser when the admin opts in.

router.get('/api/announcements/current', authOptional, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, published_at
       FROM announcements
       WHERE published_at IS NOT NULL
       ORDER BY published_at DESC, id DESC
       LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.get('/api/admin/announcements', authRequired, adminRequired, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.body, a.published_at, a.created_at,
              u.name AS author_name
       FROM announcements a
       LEFT JOIN users u ON u.id = a.created_by
       ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.post('/api/admin/announcements', authRequired, adminRequired, async (req, res) => {
  try {
    const title = String((req.body && req.body.title) || '').trim().slice(0, 160);
    const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
    if (!title) return res.status(400).json({ error: 'צריך כותרת להודעה' });
    if (!body) return res.status(400).json({ error: 'צריך תוכן להודעה' });
    const publish = !!(req.body && req.body.publish);
    // push only makes sense on a live announcement — drafts stay quiet
    const notify = publish && !!(req.body && req.body.notify);
    const { rows } = await pool.query(
      `INSERT INTO announcements (title, body, published_at, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, body, published_at, created_at`,
      [title, body, publish ? new Date() : null, req.user.id]
    );
    if (notify) notifyAnnouncementAsync(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.post('/api/admin/announcements/:id/publish', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(id > 0)) return res.status(400).json({ error: 'הודעה לא תקינה' });
    const notify = !!(req.body && req.body.notify);
    const { rows } = await pool.query(
      `UPDATE announcements SET published_at = now()
       WHERE id = $1
       RETURNING id, title, body, published_at, created_at`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'ההודעה לא נמצאה' });
    if (notify) notifyAnnouncementAsync(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.delete('/api/admin/announcements/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(id > 0)) return res.status(400).json({ error: 'הודעה לא תקינה' });
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

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

// ---- Google Places: what this month costs, and what each SKU is doing about it ----
// Everything the /admin/google page shows, in one answer. A budget running out degrades a
// feature quietly — the picker drops to Photon, the cards drop to Wikipedia — so the
// numbers belong somewhere a human actually looks, next to what each limit means.
// Definitions come from lib/google-skus.js, the gate from api_usage, the history from
// api_usage_daily, and Google's own count from Cloud Monitoring when it is connected.
router.get('/api/admin/google', authRequired, adminRequired, async (_req, res) => {
  try {
    const { flushStats, meter, clock } = require('../lib/api-budget');
    const { SKUS, CONSOLE_DAILY_QUOTA } = require('../lib/google-skus');
    const { googleCounts } = require('../lib/google-usage');

    await flushStats(); // the last minute of calls, so the page is not a minute behind
    const now = new Date();
    const month = clock.month(now);
    const today = clock.day(now);
    const dayOfMonth = clock.ptParts(now).d;
    const daysInMonth = clock.daysInMonth(now);
    const since = clock.monthStart(now);

    const [{ rows: usage }, { rows: daily }, google] = await Promise.all([
      pool.query('SELECT meter, count FROM api_usage WHERE month = $1', [month]),
      pool.query(
        `SELECT meter, to_char(day, 'YYYY-MM-DD') AS day, ok, rejected, timeouts, refused, cache_hits,
                last_error, last_error_at
         FROM api_usage_daily WHERE day > $1::date - 30 ORDER BY day`, [today]
      ),
      googleCounts(since),
    ]);
    const used = Object.fromEntries(usage.map((r) => [r.meter, r.count]));
    const hasKey = !!process.env.GOOGLE_PLACES_API_KEY;

    const skus = SKUS.map((def) => {
      const m = meter(def.meter);
      const rows = daily.filter((r) => r.meter === def.meter);
      const inMonth = rows.filter((r) => r.day.slice(0, 7) === month);
      const sum = (list, f) => list.reduce((n, r) => n + r[f], 0);
      const todayRow = rows.find((r) => r.day === today) || null;
      const spent = used[def.meter] || 0;
      const allowed = m.allowedNow(now);

      // the pace of the last seven days, carried to the end of the month — a straight
      // line on purpose: it answers "at this rate", not "what will happen"
      const week = rows.filter((r) => r.day > clock.day(new Date(now - 7 * 86400000)));
      const perDay = sum(week, 'ok') / 7 + sum(week, 'timeouts') / 7;
      const projected = Math.round(spent + perDay * (daysInMonth - dayOfMonth));
      const over = def.free === null ? 0 : Math.max(0, projected - def.free);

      const lastErr = rows.filter((r) => r.last_error_at).sort((a, b) => new Date(b.last_error_at) - new Date(a.last_error_at))[0];
      let status = 'ok';
      if (!hasKey) status = 'off';
      else if (m.limit !== null && spent >= m.limit) status = 'spent';
      else if (allowed !== null && spent >= allowed) status = 'paced';
      else if (m.limit !== null && spent >= m.limit * 0.8) status = 'near';

      return {
        meter: def.meter, method: def.method, sku: def.sku, tier: def.tier,
        what: def.what, fallback: def.fallback, where: def.where,
        free: def.free, price_per_1k: def.pricePer1k, limit: m.limit, env: def.env,
        used: spent, allowed_now: allowed, projected, projected_cost: +(over * def.pricePer1k / 1000).toFixed(2),
        status,
        today: todayRow ? { ok: todayRow.ok, rejected: todayRow.rejected, timeouts: todayRow.timeouts, refused: todayRow.refused, cache_hits: todayRow.cache_hits } : null,
        month: { ok: sum(inMonth, 'ok'), rejected: sum(inMonth, 'rejected'), timeouts: sum(inMonth, 'timeouts'), refused: sum(inMonth, 'refused'), cache_hits: sum(inMonth, 'cache_hits') },
        days: rows.map((r) => ({ day: r.day, ok: r.ok, rejected: r.rejected, timeouts: r.timeouts, refused: r.refused, cache_hits: r.cache_hits })),
        last_error: lastErr ? { text: lastErr.last_error, at: lastErr.last_error_at } : null,
      };
    });

    // per API method: the level Google's quotas and its own counters work at
    const methods = Object.keys(CONSOLE_DAILY_QUOTA).map((method) => {
      const mine = skus.filter((s) => s.method === method);
      const t = (f) => mine.reduce((n, s) => n + (s.today ? s.today[f] : 0), 0);
      return {
        method,
        meters: mine.map((s) => s.meter),
        console_daily_quota: CONSOLE_DAILY_QUOTA[method],
        // what Google's daily quota sees: every request that reached it, served or not
        today_sent: t('ok') + t('rejected') + t('timeouts'),
        month_billed: mine.reduce((n, s) => n + s.used, 0),
        google: google.methods ? (google.methods[method] || { ok: 0, other: 0 }) : null,
      };
    });

    res.json({
      now: now.toISOString(), month, today, day_of_month: dayOfMonth, days_in_month: daysInMonth,
      month_start: since.toISOString(), next_reset: clock.nextReset(now).toISOString(),
      pace_ahead_days: clock.PACE_AHEAD_DAYS, has_key: hasKey,
      skus, methods,
      google: { connected: google.connected, error: google.error || null, project: google.project || null, fetched_at: google.fetched_at || null },
    });
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
              t.is_public, t.is_draft, t.likes, t.emoji, t.created_at, t.owner_id,
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
  // acquired inside the try: when the database is unreachable this rejects, and an
  // await outside the try would leave the request hanging until the platform gave up
  // on it with a non-JSON 5xx the client can only call "unexpected"
  let client = null;
  try {
    client = await pool.connect();
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
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
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
