const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// a known fallback secret means anyone can forge tokens (including admin ones) —
// tolerable on a laptop, never in production. Render sets RENDER=true on its own.
if (!process.env.JWT_SECRET && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
  throw new Error('JWT_SECRET is not set — refusing to start with the known dev secret in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'tripi-dev-secret-change-me';

// Safari deletes script-written storage — localStorage included — after seven days
// without a visit to the site, which signs an iPhone user out long before their
// 30-day token expires. A cookie written by the server rather than by script is not
// subject to that cap, so signing in drops one alongside the token.
//
// It is deliberately not an authentication mechanism: nothing below reads it, and
// authRequired stays Bearer-only. Exactly one route accepts it — a GET that hands
// the token back — so a cross-site request forged against it can change nothing,
// and the attacker's page cannot read the reply.
const SESSION_COOKIE = 'tripi_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // matches the token's own 30d

const secureCookies = () => process.env.NODE_ENV === 'production' || !!process.env.RENDER;

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,          // script can't read it, so ITP's cap doesn't apply
    sameSite: 'lax',         // never sent on a cross-site POST
    secure: secureCookies(), // localhost is plain http, Render is not
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax', secure: secureCookies() });
}

// hand-parsed: reading one cookie doesn't justify a dependency
function readSessionCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
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

module.exports = {
  JWT_SECRET, authRequired, authOptional, isAdmin, adminRequired,
  setSessionCookie, clearSessionCookie, readSessionCookie,
};
