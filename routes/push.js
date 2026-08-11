// Push subscription management: the browser owns the subscription, we only store
// where to deliver. Nothing here is trip-scoped — one subscription per browser
// covers every trip that person plans.
const express = require('express');
const { pool } = require('../lib/db');
const { authRequired } = require('../lib/auth');
const push = require('../lib/push');

const router = express.Router();

// the client needs the VAPID public key to subscribe; it's public by design
router.get('/api/push/key', (_req, res) => {
  res.json({ enabled: push.enabled, key: push.publicKey || null });
});

router.post('/api/push/subscribe', authRequired, async (req, res) => {
  try {
    const sub = req.body || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String((sub.keys && sub.keys.p256dh) || '');
    const auth = String((sub.keys && sub.keys.auth) || '');
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
      return res.status(400).json({ error: 'מנוי ההתראות לא תקין' });
    }
    // the endpoint is the identity here: the same browser re-subscribing (or a
    // second account on a shared phone) must move the row, not duplicate it
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5, created_at = now()`,
      [req.user.id, endpoint.slice(0, 500), p256dh, auth,
       String(req.headers['user-agent'] || '').slice(0, 200)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the browser rotated the subscription behind our back (pushsubscriptionchange).
// No auth here on purpose: a service worker has no access to the JWT in
// localStorage. Knowing the previous endpoint — an unguessable URL the push
// service minted for that one browser — is the proof, and all this can do is
// move a row that already exists onto its replacement.
router.post('/api/push/resubscribe', async (req, res) => {
  try {
    const b = req.body || {};
    const old = String(b.old || '');
    const sub = b.subscription || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String((sub.keys && sub.keys.p256dh) || '');
    const auth = String((sub.keys && sub.keys.auth) || '');
    if (!/^https:\/\//.test(old) || !/^https:\/\//.test(endpoint) || !p256dh || !auth) {
      return res.status(400).json({ error: 'בקשה לא תקינה' });
    }
    await pool.query(
      `UPDATE push_subscriptions SET endpoint = $1, p256dh = $2, auth = $3, created_at = now()
       WHERE endpoint = $4`,
      [endpoint.slice(0, 500), p256dh, auth, old]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// turning notifications off: the browser drops its subscription, we drop the row
router.post('/api/push/unsubscribe', authRequired, async (req, res) => {
  try {
    const endpoint = String((req.body || {}).endpoint || '');
    if (endpoint) {
      await pool.query(
        'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
