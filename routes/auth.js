const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../lib/db');
const {
  JWT_SECRET, authRequired, setSessionCookie, clearSessionCookie, readSessionCookie,
} = require('../lib/auth');
const { rateLimiter } = require('../lib/rate-limit');

const router = express.Router();

// register: every attempt counts (mass account creation). login: only *failed*
// attempts count (below), so real users are never locked out by their own logins.
const registerLimit = rateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  error: 'יותר מדי נסיונות הרשמה — נסו שוב בעוד רבע שעה',
});
const loginLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 15 });

router.post('/api/auth/register', registerLimit.middleware, async (req, res) => {
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
    setSessionCookie(res, token);
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.post('/api/auth/login', async (req, res) => {
  try {
    if (loginLimit.blocked(req.ip)) {
      return res.status(429).json({ error: 'יותר מדי נסיונות התחברות כושלים — נסו שוב בעוד רבע שעה' });
    }
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'נא למלא אימייל וסיסמה' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = lower($1)', [email.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      loginLimit.hit(req.ip); // brute-force signal: only wrong credentials count
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    setSessionCookie(res, token);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the client's cached user can predate the admin column — this is the fresh copy
router.get('/api/me', authRequired, async (req, res) => {
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

// Storage recovery, and nothing else. A returning visitor whose localStorage Safari
// has since emptied arrives looking signed out while the session cookie is still
// good; this hands the token back so every other route can go on requiring a Bearer
// header. The reply carries a credential, so it must never be stored anywhere.
router.get('/api/auth/session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cookie = readSessionCookie(req);
  if (!cookie) return res.status(401).json({ error: 'אין התחברות שמורה' });

  let payload;
  try {
    payload = jwt.verify(cookie, JWT_SECRET);
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'ההתחברות פגה, נא להתחבר מחדש' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, is_admin FROM users WHERE id = $1', [payload.id]
    );
    if (!rows[0]) {
      clearSessionCookie(res); // the account is gone — so is the session
      return res.status(401).json({ error: 'המשתמש לא נמצא' });
    }
    const user = rows[0];
    // reissued rather than replayed: a recovered session with two days left on it
    // would be back here on the next visit
    const token = jwt.sign(
      { id: user.id, name: user.name, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' }
    );
    setSessionCookie(res, token);
    res.json({ token, user: { ...user, is_admin: !!user.is_admin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// signing out has to reach the cookie too, or the next page load quietly restores
// the session the user just ended — on a shared phone, into someone else's hands
router.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
