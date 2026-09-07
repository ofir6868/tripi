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
// In-memory on purpose (PLAYBOOK §2): one process, and a reset on restart is a gift,
// not a bug. Admins are counted (the panel shows the number) but never capped.
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
  const usage = new Map(); // userId → { date, count }
  async function check(req) {
    const userId = req.user.id;
    const u = usage.get(userId);
    const used = u && u.date === today() ? u.count : 0;
    const admin = await isAdmin(req);
    const limit = baseLimit * ((await hasBonus(userId)) ? BONUS_MULTIPLIER : 1);
    if (used >= limit && !admin) {
      console.log(`quota: ${name} spent for user ${userId} (${used}/${limit} today)`); // a spent day leaves a trace
      return null;
    }
    return {
      used, limit, admin,
      remaining: admin ? null : limit - used - 1, // after this call; null = unlimited
      spend: () => usage.set(userId, { date: today(), count: used + 1 }),
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
