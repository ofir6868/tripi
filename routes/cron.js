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
//
// Two doorbells. /api/cron/tick is the daily one: everything, once a day, which is all the
// free plan's scheduler offers. /api/cron/moments runs ONLY the moment pushes (the bus at
// 08:30 cannot wait for a 06:00 UTC cron) and is rung every five minutes by the repository's
// own GitHub Actions schedule (.github/workflows/moments-clock.yml — free, the repo is
// public), which proves itself with a GitHub-signed OIDC token instead of a copied secret
// (lib/github-oidc.js); any other pinger sends `Authorization: Bearer <CRON_SECRET>`.
// It is safe at any frequency: a moment is claimed before it is sent, and the query behind
// it is one indexed read. Without such a pinger moments still go out, late, with the daily
// tick — and with any participant opening the trip page, which runs the same scan
// (routes/trips.js) so the person at the bus stop is rarely the only clock around.
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// Two proofs open the door: the shared CRON_SECRET (Vercel's scheduler, any pinger), or a
// GitHub Actions OIDC token from this very repository (lib/github-oidc.js) — the clock
// workflow carries no secret at all. CRON_GITHUB_REPO names the repository allowed in;
// CRON_OIDC_AUDIENCE is the audience the workflow asks GitHub for (both have defaults).
const OIDC_REPO = process.env.CRON_GITHUB_REPO || 'ofir6868/tripi';
const OIDC_AUDIENCE = process.env.CRON_OIDC_AUDIENCE || 'tripmaker-cron';

async function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (secret && given) {
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  // a JWT is three dot-separated parts; anything else is not worth a signature check
  if (given.split('.').length === 3) {
    const claims = await require('../lib/github-oidc').verify(given, { repository: OIDC_REPO, audience: OIDC_AUDIENCE });
    if (claims) { req.cronActor = `github:${claims.repository}@${claims.ref || ''}`; return next(); }
  }
  if (!secret) return res.status(503).json({ error: 'cron disabled: CRON_SECRET is not set' });
  return res.status(401).json({ error: 'bad cron secret' });
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
    // the full schema + sweep pass that cold starts now skip once a deploy has run it
    // (lib/db-bootstrap.js) — the daily tick keeps "every boot" sweeps close to continuous
    run('schema', () => require('../lib/db-bootstrap').runFull()),
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

async function momentsOnly(_req, res) {
  const results = await Promise.all([
    run('moments', async () => { const n = await require('../lib/reminders').momentsTick(); return n; }),
  ]);
  res.json({ ok: true, ran: Object.fromEntries(results) });
}
router.get('/api/cron/moments', cronAuth, momentsOnly);
router.post('/api/cron/moments', cronAuth, momentsOnly);

module.exports = router;
module.exports._test = { cronAuth };
