// Server-side PostHog capture, fire-and-forget. Same contract as the client
// integration and push.js: without POSTHOG_KEY this no-ops entirely, and a
// failed capture never breaks the request that produced it.
const KEY = process.env.POSTHOG_KEY || '';
const HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';

function capture(event, distinctId, properties) {
  if (!KEY || !distinctId) return;
  fetch(HOST + '/i/v0/e/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      event,
      distinct_id: distinctId,
      properties,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
}

module.exports = { capture };
