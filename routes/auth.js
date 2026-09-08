const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../lib/db');
const { JWT_SECRET, authRequired } = require('../lib/auth');
const { rateLimiter } = require('../lib/rate-limit');

const router = express.Router();

// register: every attempt counts (mass account creation). login: only *failed*
// attempts count (below), so real users are never locked out by their own logins.
const registerLimit = rateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  error: 'יותר מדי נסיונות הרשמה — נסו שוב בעוד רבע שעה',
});
const loginLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 15 });
// keyed by user id (not IP): a wrong current-password guess counts against the
// account being attacked, same brute-force shape as login but scoped per-account
const passwordChangeLimit = rateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  error: 'יותר מדי נסיונות — נסו שוב בעוד רבע שעה',
});
const googleLimit = rateLimiter({
  windowMs: 15 * 60 * 1000, max: 30,
  error: 'יותר מדי נסיונות התחברות עם Google — נסו שוב בעוד רבע שעה',
});

const GOOGLE_CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || '';
const googleConfigured = () => !!(GOOGLE_CLIENT_ID() && GOOGLE_CLIENT_SECRET());

function publicOrigin(req) {
  // Render terminates TLS at the proxy; trust proxy is on in server.js
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${publicOrigin(req)}/api/auth/google/callback`;
}

function signUserToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '30d' },
  );
}

function safeReturnPath(raw) {
  if (!raw || typeof raw !== 'string') return '/';
  // only same-origin relative paths — block open redirects
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw.slice(0, 300);
}

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
    const token = signUserToken(user);
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
    const ok = user && user.password_hash && await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      loginLimit.hit(req.ip); // brute-force signal: only wrong credentials count
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }
    const token = signUserToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the client's cached user can predate the admin column — this is the fresh copy.
// has_password tells the settings screen whether to ask for a current password
// (a Google-only account has none yet, and is setting its first one)
router.get('/api/me', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, is_admin, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'המשתמש לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// settings screen: rename. Email is the account's stable identity (also the
// login handle) and isn't editable here — changing it is a bigger, separate
// feature (re-verification etc.) that nobody has asked for yet.
router.patch('/api/me', authRequired, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'נא למלא שם' });
    if (name.length > 80) return res.status(400).json({ error: 'השם ארוך מדי' });
    const { rows } = await pool.query(
      `UPDATE users SET name = $1 WHERE id = $2
       RETURNING id, name, email, is_admin, (password_hash IS NOT NULL) AS has_password`,
      [name, req.user.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'המשתמש לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// settings screen: change (or, for a Google-only account with no password yet,
// set a first) password. Current password is required whenever one already
// exists — this is the one endpoint where "logged in" alone must not be enough,
// since a stolen/left-open session shouldn't be able to lock the real owner out.
router.post('/api/me/password', authRequired, async (req, res) => {
  try {
    if (passwordChangeLimit.blocked(req.user.id)) {
      return res.status(429).json({ error: 'יותר מדי נסיונות — נסו שוב בעוד רבע שעה' });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'הסיסמה החדשה חייבת להכיל לפחות 6 תווים' });
    }
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(401).json({ error: 'המשתמש לא נמצא' });
    const { password_hash } = rows[0];
    if (password_hash) {
      const ok = currentPassword && await bcrypt.compare(currentPassword, password_hash);
      if (!ok) {
        passwordChangeLimit.hit(req.user.id);
        return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
      }
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- referrals: three friends signed up through your link = every AI quota doubled ----------
//
// The link is /?ref=CODE. Any page that lands with ?ref= keeps the code in the browser
// (common.js), and the first sign-in afterwards claims it — a claim is accepted only for
// an account younger than half an hour with no referrer yet, so a link forwarded to an
// old user changes nothing, and nobody can be claimed twice. The third accepted claim
// flips the referrer's bonus (lib/quota.js reads it); the referred friends get nothing
// beyond the app itself, which keeps the loop honest: the only thing worth faking is
// three real sign-ups.
const REFERRALS_NEEDED = 3;
const CLAIM_WINDOW = "interval '30 minutes'";

async function referralCodeFor(userId) {
  const { rows } = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return null;
  if (rows[0].referral_code) return rows[0].referral_code;
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 7);
    const upd = await pool.query(
      'UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL RETURNING referral_code', [code, userId]
    ).catch((err) => { if (err.code === '23505') return { rows: [] }; throw err; });
    if (upd.rows[0]) return upd.rows[0].referral_code;
    const again = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
    if (again.rows[0] && again.rows[0].referral_code) return again.rows[0].referral_code; // a parallel request won
  }
  return null;
}

router.get('/api/me/referral', authRequired, async (req, res) => {
  try {
    const code = await referralCodeFor(req.user.id);
    if (!code) return res.status(401).json({ error: 'המשתמש לא נמצא' });
    const { rows } = await pool.query(
      'SELECT (SELECT count(*) FROM users WHERE referred_by = $1)::int AS referred, referral_bonus FROM users WHERE id = $1', [req.user.id]
    );
    res.json({
      code,
      link: `${publicOrigin(req)}/?ref=${code}`,
      referred: rows[0].referred,
      needed: REFERRALS_NEEDED,
      bonus: !!rows[0].referral_bonus,
      multiplier: require('../lib/quota').BONUS_MULTIPLIER,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.post('/api/me/referral/claim', authRequired, async (req, res) => {
  try {
    const ref = String((req.body && req.body.ref) || '').trim().slice(0, 20);
    if (!/^[A-Za-z0-9]{4,20}$/.test(ref)) return res.json({ claimed: false });
    const { rows } = await pool.query(
      `UPDATE users SET referred_by = r.id
         FROM (SELECT id FROM users WHERE referral_code = $1) r
        WHERE users.id = $2 AND users.referred_by IS NULL AND r.id <> users.id
          AND users.created_at > now() - ${CLAIM_WINDOW}
        RETURNING r.id AS referrer`,
      [ref, req.user.id]
    );
    if (!rows[0]) return res.json({ claimed: false });
    const referrer = rows[0].referrer;
    const { rows: n } = await pool.query(
      `UPDATE users SET referral_bonus = true
        WHERE id = $1 AND NOT referral_bonus AND (SELECT count(*) FROM users WHERE referred_by = $1) >= $2
        RETURNING id`,
      [referrer, REFERRALS_NEEDED]
    );
    if (n[0]) require('../lib/quota').forgetBonus(referrer);
    res.json({ claimed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- Google OAuth ----------

router.get('/api/auth/providers', (_req, res) => {
  res.json({ google: googleConfigured() });
});

router.get('/api/auth/google', googleLimit.middleware, (req, res) => {
  if (!googleConfigured()) {
    return res.status(503).json({ error: 'התחברות עם Google לא מוגדרת כרגע' });
  }
  const state = jwt.sign(
    { n: crypto.randomBytes(16).toString('hex'), r: safeReturnPath(req.query.next) },
    JWT_SECRET,
    { expiresIn: '10m' },
  );
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID(),
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/api/auth/google/callback', async (req, res) => {
  const fail = (msg) => {
    const q = new URLSearchParams({ google_error: msg });
    res.redirect(`/?${q}`);
  };
  try {
    if (!googleConfigured()) return fail('התחברות עם Google לא מוגדרת');
    const { code, state, error } = req.query;
    if (error) return fail('ההתחברות עם Google בוטלה');
    if (!code || !state) return fail('תשובה לא תקינה מ-Google');

    let returnPath = '/';
    try {
      const st = jwt.verify(String(state), JWT_SECRET);
      returnPath = safeReturnPath(st.r);
    } catch {
      return fail('פג תוקף הבקשה — נסו שוב');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID(),
        client_secret: GOOGLE_CLIENT_SECRET(),
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error('google token exchange failed', tokenJson);
      return fail('לא הצלחנו להשלים את ההתחברות עם Google');
    }

    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const profile = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok || !profile.sub || !profile.email) {
      console.error('google userinfo failed', profile);
      return fail('לא הצלחנו לקרוא את פרטי החשבון מ-Google');
    }
    if (profile.email_verified === false) {
      return fail('יש לאמת את האימייל ב-Google לפני ההתחברות');
    }

    const email = String(profile.email).trim().toLowerCase();
    const name = String(profile.name || profile.given_name || email.split('@')[0]).trim().slice(0, 80);
    const sub = String(profile.sub);

    let user;
    const bySub = await pool.query(
      'SELECT id, name, email, is_admin FROM users WHERE google_sub = $1', [sub]
    );
    if (bySub.rows[0]) {
      user = bySub.rows[0];
    } else {
      const byEmail = await pool.query(
        'SELECT id, name, email, is_admin, google_sub FROM users WHERE email = $1', [email]
      );
      if (byEmail.rows[0]) {
        // link an existing email/password account to this Google identity
        const { rows } = await pool.query(
          `UPDATE users SET google_sub = $1, name = COALESCE(NULLIF(name, ''), $2)
           WHERE id = $3
           RETURNING id, name, email, is_admin`,
          [sub, name, byEmail.rows[0].id]
        );
        user = rows[0];
      } else {
        const { rows } = await pool.query(
          `INSERT INTO users (name, email, google_sub, password_hash)
           VALUES ($1, $2, $3, NULL)
           RETURNING id, name, email, is_admin`,
          [name, email, sub]
        );
        user = rows[0];
      }
    }

    const token = signUserToken(user);
    // fragment keeps the JWT out of server/proxy access logs for the landing page
    const dest = new URL(returnPath, publicOrigin(req));
    dest.hash = `google_token=${encodeURIComponent(token)}`;
    res.redirect(dest.pathname + dest.search + dest.hash);
  } catch (err) {
    console.error(err);
    return fail('שגיאה בהתחברות עם Google');
  }
});

module.exports = router;
