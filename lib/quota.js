// The AI's daily quotas, in one place.
//
// Every model-backed feature meters itself per user per day — builds, smart edits,
// recommendation questions, planning turns — and every one of them used to keep its
// own in-memory Map with the same six lines around it. This is those six lines, once,
// plus the one thing they now share: the referral bonus. A traveller who brought three
// friends to TRIP MAKER (lib: users.referral_bonus, set by routes/auth.js) gets every
// limit doubled — the same multiplier on every counter, so "double quota" means what it
// says everywhere.
//
// The counters live in Postgres (ai_usage: one row per user, meter and day), not in
// memory. The first cut kept a Map, as the rest of the rate limiting does — and on the
// free Render instance, which restarts on every deploy and sleeps after fifteen idle
// minutes, a traveller watched "19 left" go 19 → 17 → 19 within half an hour. A limit
// that forgets itself whenever the process does is not a limit. One small query per
// AI call is the price. Admins are counted (the panel shows the number) but never capped.
const { pool } = require('./db');
const { isAdmin } = require('./auth');

const BONUS_MULTIPLIER = 2;
const BONUS_TTL_MS = 60 * 1000; // the flag is read once a minute per user, not once a call
const bonusCache = new Map(); // userId → { until, bonus }

async function hasBonus(userId) {
  const hit = bonusCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.bonus;
  let bonus = false;
  try {
    const { rows } = await pool.query('SELECT referral_bonus FROM users WHERE id = $1', [userId]);
    bonus = !!(rows[0] && rows[0].referral_bonus);
  } catch { /* the database blinking never costs anyone their quota */ }
  bonusCache.set(userId, { until: Date.now() + BONUS_TTL_MS, bonus });
  return bonus;
}
// the moment the third friend signs up, the doubled limit applies to the next call
const forgetBonus = (userId) => bonusCache.delete(userId);

const today = () => new Date().toISOString().slice(0, 10);

// one meter: check(req) says whether the call may go ahead — and returns the spend()
// that records it once the model actually answered (the model call is the budgeted
// resource, never the request). null means the day's allowance is spent.
//
// AI_QUOTA_<NAME> (e.g. AI_QUOTA_PLAN=3) overrides a meter's base limit per environment —
// the way to see the spent-day card without sixty real turns.
function dailyQuota(name, defaultLimit) {
  const envLimit = parseInt(process.env['AI_QUOTA_' + name.toUpperCase()], 10);
  const baseLimit = Number.isInteger(envLimit) && envLimit >= 0 ? envLimit : defaultLimit;
  async function check(req) {
    const userId = req.user.id;
    const day = today();
    let used = 0;
    try {
      const { rows } = await pool.query(
        'SELECT count FROM ai_usage WHERE user_id = $1 AND meter = $2 AND day = $3', [userId, name, day]
      );
      used = rows[0] ? rows[0].count : 0;
    } catch (err) {
      // the database blinking is not a reason to refuse a traveller — but it must not
      // pass in silence either (PLAYBOOK §2: quiet failures are the dangerous kind)
      console.error(`quota: could not read ${name} usage for user ${userId} (${err.code || err.message}) — allowing`);
    }
    const admin = await isAdmin(req);
    const limit = baseLimit * ((await hasBonus(userId)) ? BONUS_MULTIPLIER : 1);
    if (used >= limit && !admin) {
      console.log(`quota: ${name} spent for user ${userId} (${used}/${limit} today)`); // a spent day leaves a trace
      return null;
    }
    return {
      used, limit, admin,
      remaining: admin ? null : limit - used - 1, // after this call; null = unlimited
      // the increment is atomic in the database: two turns landing together both count
      spend: () => pool.query(
        `INSERT INTO ai_usage (user_id, meter, day, count) VALUES ($1, $2, $3, 1)
         ON CONFLICT (user_id, meter, day) DO UPDATE SET count = ai_usage.count + 1`,
        [userId, name, day]
      ).catch((err) => console.error(`quota: could not record ${name} usage for user ${userId} (${err.code || err.message})`)),
    };
  }
  return { name, check };
}

// the 429 every meter answers with: the same shape, so one client component can show
// the same gentle card — and `quota` tells it apart from every other error
function exhausted(res, name, message) {
  return res.status(429).json({ error: message, quota: name });
}

module.exports = { dailyQuota, exhausted, hasBonus, forgetBonus, BONUS_MULTIPLIER };
