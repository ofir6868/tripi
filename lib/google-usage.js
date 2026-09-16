// What Google itself counted — the other side of the ledger lib/api-budget.js keeps.
//
// Our meters count what this app sent and what came back. That is the number that
// decides, but it is still our number: a call site that bypasses the meter, a second
// project on the same key, a counter reset by a database rotation — each of them makes
// it quietly wrong, and nothing inside the app can see that. Cloud Monitoring can. Every
// request to places.googleapis.com is recorded there per API method and per response
// class, which is exactly the grain the quotas and the bill work at (lib/google-skus.js),
// so the admin page puts the two side by side and a gap is visible the day it opens.
//
// Optional, like every paid or keyed integration (PLAYBOOK §2): without
// GOOGLE_MONITORING_KEY the page says "not connected" and everything else works.
// The key is a service account JSON (raw, or base64 of it) whose only role is
// Monitoring Viewer on the project that owns GOOGLE_PLACES_API_KEY — read-only by
// construction. GOOGLE_MONITORING_PROJECT overrides the project the key names.
//
// Read-only and cheap: one token exchange an hour, one timeSeries.list per page view at
// most every ten minutes. Monitoring's own data runs a few minutes behind.
const crypto = require('crypto');
const { GOOGLE_METHOD } = require('./google-skus');

const SHORT = Object.fromEntries(Object.entries(GOOGLE_METHOD).map(([k, v]) => [v, k]));
const CACHE_MS = 10 * 60 * 1000;

function readKey() {
  const raw = (process.env.GOOGLE_MONITORING_KEY || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return { invalid: true };
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

let token = null; // { value, until }
async function accessToken(key) {
  if (token && token.until > Date.now() + 60000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/monitoring.read',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64url(sig)}`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`token exchange failed (HTTP ${res.status} ${data.error || ''})`.trim());
  token = { value: data.access_token, until: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

let cached = null; // { at, since, value }

// Requests per method since `since`, split into what Google served (2xx — the billable
// ones) and everything else. Never throws: the answer carries `error` instead, because a
// reconciliation that cannot run must not take the admin page down with it.
async function googleCounts(since) {
  const key = readKey();
  if (!key) return { connected: false };
  if (key.invalid || !key.client_email || !key.private_key) {
    return { connected: false, error: 'GOOGLE_MONITORING_KEY is set but is not a service account JSON' };
  }
  if (cached && cached.since === +since && Date.now() - cached.at < CACHE_MS) return cached.value;

  const project = process.env.GOOGLE_MONITORING_PROJECT || key.project_id;
  const end = new Date();
  const params = new URLSearchParams({
    filter: 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api"'
      + ' AND resource.labels.service="places.googleapis.com"',
    'interval.startTime': since.toISOString(),
    'interval.endTime': end.toISOString(),
    // one bucket for the whole month so far: a sum per method per response class
    'aggregation.alignmentPeriod': `${Math.max(60, Math.ceil((end - since) / 1000))}s`,
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
  });
  params.append('aggregation.groupByFields', 'resource.labels.method');
  params.append('aggregation.groupByFields', 'metric.labels.response_code_class');

  let value;
  try {
    const bearer = await accessToken(key);
    const methods = {};
    let pageToken = '';
    do {
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${params}`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data.error && data.error.message) || '';
        throw new Error(res.status === 403
          ? `HTTP 403 — the service account needs the Monitoring Viewer role on ${project}`
          : `HTTP ${res.status} ${msg}`.trim());
      }
      for (const ts of data.timeSeries || []) {
        const method = SHORT[ts.resource && ts.resource.labels && ts.resource.labels.method];
        if (!method) continue; // a Places method this app does not call
        const cls = (ts.metric && ts.metric.labels && ts.metric.labels.response_code_class) || '';
        const n = (ts.points || []).reduce((sum, p) => sum + Number((p.value && p.value.int64Value) || 0), 0);
        const row = methods[method] || (methods[method] = { ok: 0, other: 0 });
        if (cls === '2xx') row.ok += n; else row.other += n;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    value = { connected: true, project, since: since.toISOString(), fetched_at: end.toISOString(), methods };
  } catch (err) {
    value = { connected: true, project, error: err.name === 'TimeoutError' ? 'Cloud Monitoring did not answer in time' : err.message };
  }
  cached = { at: Date.now(), since: +since, value };
  return value;
}

module.exports = { googleCounts };
