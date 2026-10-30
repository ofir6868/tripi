// Connectors — the traveller's own accounts, lent to the AI one service at a time.
//
// A trip is already half-planned somewhere else: the flights are in Gmail, the days
// off are in the calendar, the friend's spreadsheet is in Drive. A connector lets the
// planner read exactly one of those, after the traveller said so twice: once to Google
// (the consent screen, one read-only scope per service, incremental — turning on Gmail
// never quietly widens into Drive) and once here, where each service is a switch of
// its own that can be flipped off at any moment. Every connector is read-only by
// construction: the AI reads a booking, it does not send mail or move meetings — what
// it learns lands in the trip through the same proposal cards as everything else.
//
// Tokens are stored encrypted (AES-256-GCM, a key derived from CONNECTOR_SECRET, or
// from JWT_SECRET when that is not set) in user_connectors — one row per user and
// provider, carrying the services that are on. Disconnecting the last service revokes
// the token at Google and deletes the row: nothing of theirs stays behind.
//
// Without GOOGLE_CLIENT_ID/SECRET the whole feature is a closed door with a sign on it
// (the sheet says it is not set up), never an error.
const crypto = require('crypto');
const { pool } = require('./db');
const { JWT_SECRET } = require('./auth');

// the registry — adding a service is one entry here plus a reader below
const SERVICES = {
  calendar: {
    provider: 'google', label: 'יומן Google', icon: '📅',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    sees: 'אירועים ביומן בטווח התאריכים של הטיול — כדי לדעת מתי אתם פנויים ומה כבר קבוע',
  },
  gmail: {
    provider: 'google', label: 'Gmail', icon: '✉️',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    sees: 'חיפוש בהודעות (למשל אישורי טיסה ומלון) וקריאת ההודעה שנבחרה — רק קריאה, בלי לשלוח',
  },
  drive: {
    provider: 'google', label: 'Google Drive', icon: '📁',
    sees: 'חיפוש קבצים וקריאת טקסט ממסמכי Google ומקבצי טקסט — למשל תוכנית טיול שחבר שלח',
    scope: 'https://www.googleapis.com/auth/drive.readonly',
  },
};
const SERVICE_KEYS = Object.keys(SERVICES);

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// ---------- the vault ----------
const KEY = crypto.createHash('sha256').update(process.env.CONNECTOR_SECRET || JWT_SECRET || 'tripmaker').digest();
function seal(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function open(blob) {
  if (!blob) return null;
  try {
    const b = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; } // a rotated secret: the row is unreadable, and treated as disconnected
}

// ---------- rows ----------
async function loadRow(userId, provider = 'google') {
  const { rows } = await pool.query('SELECT * FROM user_connectors WHERE user_id = $1 AND provider = $2', [userId, provider]);
  return rows[0] || null;
}

// what the sheet shows: every service, on or off, and whether the feature exists here
async function statusFor(userId) {
  const row = configured() && userId ? await loadRow(userId).catch(() => null) : null;
  const on = new Set(row ? row.services || [] : []);
  return {
    configured: configured(),
    account: row ? row.account_email : null,
    services: SERVICE_KEYS.map((k) => ({ key: k, ...SERVICES[k], on: on.has(k) })),
  };
}

// the services the AI may use for this user right now — the list the tool registry reads
async function enabledFor(userId) {
  if (!configured() || !userId) return [];
  const row = await loadRow(userId).catch(() => null);
  return row && open(row.refresh_token_enc) ? (row.services || []).filter((s) => SERVICES[s]) : [];
}

// ---------- OAuth ----------
const redirectUri = (origin) => process.env.CONNECTORS_REDIRECT_URI || `${origin}/api/connectors/google/callback`;

// the consent URL for turning `wanted` services on — incremental, so what is already
// granted rides along and only the new scopes are asked for
function authUrl({ origin, state, wanted }) {
  const scopes = wanted.map((s) => SERVICES[s].scope);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: ['openid', 'email', ...scopes].join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenPost(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`google token ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

// the callback's half: exchange the code, read which scopes were really granted (the
// consent screen lets a person untick one), and store the services those scopes cover
async function completeAuth({ userId, code, origin, wanted }) {
  const tok = await tokenPost({ code, redirect_uri: redirectUri(origin), grant_type: 'authorization_code' });
  const granted = String(tok.scope || '').split(/\s+/);
  const services = SERVICE_KEYS.filter((k) => granted.includes(SERVICES[k].scope));
  let email = null;
  try {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const p = await r.json();
    if (r.ok && p.email) email = String(p.email).toLowerCase();
  } catch { /* the address is a label, not a key */ }
  const prev = await loadRow(userId);
  // Google returns a refresh token on the first consent only when prompt=consent — which
  // it is — but an earlier row's token stays if a new one was not issued
  const refresh = tok.refresh_token || (prev ? open(prev.refresh_token_enc) : null);
  if (!refresh) throw new Error('no refresh token');
  const merged = [...new Set([...(prev ? prev.services : []), ...services])].filter((s) => granted.includes(SERVICES[s].scope));
  const expires = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  await pool.query(
    `INSERT INTO user_connectors (user_id, provider, services, scopes, access_token_enc, refresh_token_enc, expires_at, account_email, updated_at)
     VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET services = EXCLUDED.services, scopes = EXCLUDED.scopes,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at, account_email = COALESCE(EXCLUDED.account_email, user_connectors.account_email), updated_at = now()`,
    [userId, JSON.stringify(merged), granted.join(' '), seal(tok.access_token), seal(refresh), expires, email]
  );
  return { services: merged, wantedButRefused: wanted.filter((s) => !services.includes(s)), email };
}

// a live access token for the user, refreshed when it is about to expire
async function accessToken(userId) {
  const row = await loadRow(userId);
  if (!row) return null;
  const refresh = open(row.refresh_token_enc);
  if (!refresh) return null;
  const access = open(row.access_token_enc);
  if (access && row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60 * 1000) return access;
  const tok = await tokenPost({ refresh_token: refresh, grant_type: 'refresh_token' });
  const expires = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  await pool.query('UPDATE user_connectors SET access_token_enc = $1, expires_at = $2, updated_at = now() WHERE user_id = $3 AND provider = $4',
    [seal(tok.access_token), expires, userId, 'google']);
  return tok.access_token;
}

// a service switched off; the last one off revokes the grant at Google and forgets it all
async function disable(userId, service) {
  const row = await loadRow(userId);
  if (!row) return { services: [] };
  const left = (row.services || []).filter((s) => s !== service);
  if (left.length) {
    await pool.query('UPDATE user_connectors SET services = $1, updated_at = now() WHERE user_id = $2 AND provider = $3', [JSON.stringify(left), userId, 'google']);
    return { services: left };
  }
  await revokeAll(userId);
  return { services: [] };
}

async function revokeAll(userId) {
  const row = await loadRow(userId);
  if (!row) return;
  const refresh = open(row.refresh_token_enc);
  if (refresh) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh }),
    }).catch(() => { /* a revoke that failed leaves a token Google will expire on its own */ });
  }
  await pool.query('DELETE FROM user_connectors WHERE user_id = $1 AND provider = $2', [userId, 'google']);
}

// ---------- the readers (what the AI's tools call) ----------
async function gapi(userId, url, { timeoutMs = 8000 } = {}) {
  const token = await accessToken(userId);
  if (!token) throw new Error('not connected');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw new Error('permission');
    if (!res.ok) throw new Error(`google api ${res.status}`);
    const type = res.headers.get('content-type') || '';
    return /json/.test(type) ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function calendarEvents(userId, { from, to }) {
  const start = isIso(from) ? from : new Date().toISOString().slice(0, 10);
  const end = isIso(to) && to >= start ? to : start;
  const p = new URLSearchParams({
    timeMin: `${start}T00:00:00Z`, timeMax: `${end}T23:59:59Z`, singleEvents: 'true', orderBy: 'startTime', maxResults: '25',
  });
  const data = await gapi(userId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`);
  return {
    from: start, to: end,
    events: (data.items || []).map((e) => ({
      title: String(e.summary || '(ללא כותרת)').slice(0, 120),
      start: (e.start && (e.start.dateTime || e.start.date)) || null,
      end: (e.end && (e.end.dateTime || e.end.date)) || null,
      all_day: !!(e.start && e.start.date),
      location: e.location ? String(e.location).slice(0, 120) : null,
    })),
  };
}

const header = (msg, name) => ((msg.payload && msg.payload.headers) || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

async function gmailSearch(userId, { query, limit = 8 }) {
  const q = String(query || '').slice(0, 200);
  const list = await gapi(userId, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(limit, 10)}&q=${encodeURIComponent(q)}`);
  const ids = (list.messages || []).map((m) => m.id);
  const msgs = await Promise.all(ids.map((id) => gapi(userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`).catch(() => null)));
  return {
    query: q,
    messages: msgs.filter(Boolean).map((m) => ({
      id: m.id, subject: header(m, 'Subject').slice(0, 140), from: header(m, 'From').slice(0, 100),
      date: header(m, 'Date').slice(0, 40), snippet: String(m.snippet || '').slice(0, 200),
    })),
  };
}

// the text of one message: the text/plain part when there is one, the HTML stripped otherwise
function bodyText(payload) {
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.body && p.body.data && /^text\/(plain|html)/.test(p.mimeType || '')) parts.push({ type: p.mimeType, data: p.body.data });
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const pick = parts.find((p) => p.type.startsWith('text/plain')) || parts[0];
  if (!pick) return '';
  const text = Buffer.from(pick.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return pick.type.startsWith('text/html') ? text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : text;
}
async function gmailRead(userId, { id, maxChars = 3500 }) {
  const mid = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!mid) return { error: 'חסר מזהה הודעה' };
  const m = await gapi(userId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${mid}?format=full`);
  return {
    id: m.id, subject: header(m, 'Subject').slice(0, 140), from: header(m, 'From').slice(0, 100), date: header(m, 'Date').slice(0, 40),
    text: bodyText(m.payload).replace(/\s+/g, ' ').trim().slice(0, maxChars),
  };
}

async function driveSearch(userId, { query, limit = 10 }) {
  const q = String(query || '').replace(/['\\]/g, ' ').slice(0, 120);
  const filter = `(name contains '${q}' or fullText contains '${q}') and trashed = false`;
  const p = new URLSearchParams({ q: filter, pageSize: String(Math.min(limit, 10)), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', orderBy: 'modifiedTime desc' });
  const data = await gapi(userId, `https://www.googleapis.com/drive/v3/files?${p}`);
  return {
    query: q,
    files: (data.files || []).map((f) => ({ id: f.id, name: String(f.name).slice(0, 120), type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink })),
  };
}

const READABLE = /^text\/|json|csv|markdown/;
async function driveRead(userId, { id, maxChars = 3500 }) {
  const fid = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!fid) return { error: 'חסר מזהה קובץ' };
  const meta = await gapi(userId, `https://www.googleapis.com/drive/v3/files/${fid}?fields=id,name,mimeType`);
  let text;
  if (meta.mimeType === 'application/vnd.google-apps.document' || meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const mime = meta.mimeType.endsWith('spreadsheet') ? 'text/csv' : 'text/plain';
    text = await gapi(userId, `https://www.googleapis.com/drive/v3/files/${fid}/export?mimeType=${mime}`);
  } else if (READABLE.test(meta.mimeType || '')) {
    text = await gapi(userId, `https://www.googleapis.com/drive/v3/files/${fid}?alt=media`);
  } else {
    return { id: fid, name: meta.name, error: `קובץ מסוג ${meta.mimeType} — אפשר לקרוא רק מסמכי Google, גיליונות וקובצי טקסט` };
  }
  return { id: fid, name: meta.name, text: String(typeof text === 'string' ? text : JSON.stringify(text)).replace(/\s+/g, ' ').trim().slice(0, maxChars) };
}

module.exports = {
  SERVICES, SERVICE_KEYS, configured, statusFor, enabledFor, authUrl, completeAuth, disable, revokeAll,
  calendarEvents, gmailSearch, gmailRead, driveSearch, driveRead, _test: { seal, open, bodyText },
};
