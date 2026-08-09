const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../lib/db');
const { JWT_SECRET, authRequired } = require('../lib/auth');

const router = express.Router();

router.post('/api/auth/register', async (req, res) => {
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

router.post('/api/auth/login', async (req, res) => {
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

module.exports = router;
