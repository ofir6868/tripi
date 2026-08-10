const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// a known fallback secret means anyone can forge tokens (including admin ones) —
// tolerable on a laptop, never in production. Render sets RENDER=true on its own.
if (!process.env.JWT_SECRET && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
  throw new Error('JWT_SECRET is not set — refusing to start with the known dev secret in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'tripi-dev-secret-change-me';

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

module.exports = { JWT_SECRET, authRequired, authOptional, isAdmin, adminRequired };
