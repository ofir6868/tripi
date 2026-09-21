// The scheduled jobs, on a host that has no clock of its own.
//
// On an always-on server these are in-process timers started by server.js: the reminder
// tick every 20 minutes, the escrow backup on its interval, the cache sweep at boot. A
// Vercel function instance is frozen the moment it answers, so a setInterval there fires
// late, never, or twice over in two instances at once — a schedule has to arrive from
// outside, as a request. vercel.json points a daily cron at this route; the work itself
// stays where it was, in lib/, and this is only the doorbell.
//
// Vercel signs its cron calls with CRON_SECRET, so the route answers to that bearer token
// and nothing else — the same shape as the rotation token in routes/rotation.js. Without
// the secret set the route refuses everyone, which is the right answer for an endpoint
// that would otherwise let a stranger spend the push and GitHub quotas for us.
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'cron disabled: CRON_SECRET is not set' });
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad cron secret' });
  next();
}

// One job failing is not the others' problem: a GitHub outage must not cost us the
// morning briefs, so each runs on its own and reports its own outcome.
async function run(name, job) {
  try {
    await job();
    return [name, 'ok'];
  } catch (err) {
    console.error(`cron: ${name} failed —`, err.message);
    return [name, `failed: ${err.message}`];
  }
}

// Vercel's scheduler issues a GET, and an uptime pinger standing in for it would too.
// Same work either way — the method is not what makes this safe, the token is.
async function tick(_req, res) {
  const results = await Promise.all([
    run('reminders', () => require('../lib/reminders').tick()),
    run('api-budget-sweep', () => require('../lib/api-budget').sweep()),
    // the backup is a no-op by design when the escrow is not configured — the same two
    // keys lib/rotation-backup.js checks before it starts its own timer
    run('rotation-backup', async () => {
      if (!process.env.DB_BACKUP_KEY || !process.env.ESCROW_GITHUB_TOKEN) return;
      await require('../lib/rotation-backup').backupOnce();
    }),
  ]);
  res.json({ ok: true, ran: Object.fromEntries(results) });
}

router.get('/api/cron/tick', cronAuth, tick);
router.post('/api/cron/tick', cronAuth, tick);

module.exports = router;
