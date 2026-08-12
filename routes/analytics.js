// PostHog project config for the client. The key is a public client-side token
// (phc_…), same trust level as the VAPID public key — serving it from env keeps
// it out of the repo and lets the whole integration no-op when unset.
const express = require('express');

const router = express.Router();

const KEY = process.env.POSTHOG_KEY || '';
const HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';

router.get('/api/analytics/config', (_req, res) => {
  res.json({ enabled: !!KEY, key: KEY || null, host: HOST });
});

module.exports = router;
