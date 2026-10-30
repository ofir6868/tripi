// Connectors — switching the traveller's Google services on and off for the AI
// (lib/connectors.js has the why and the vault). Three routes and a callback:
//
//   GET    /api/connectors                      what is on, what exists, which account
//   GET    /api/connectors/google/start         → Google's consent screen for the services asked
//   GET    /api/connectors/google/callback      ← Google; stores the grant, returns to the trip
//   DELETE /api/connectors/google/:service      one switch off (the last one revokes it all)
//
// The start is a navigation, not a fetch, so the JWT rides the query string the way the
// guest token does on the sign-in route — only its user id is kept, inside a signed
// state that also names the services asked for and where to go back to.
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, authRequired } = require('../lib/auth');
const { rateLimiter } = require('../lib/rate-limit');
const connectors = require('../lib/connectors');
const analytics = require('../lib/posthog');

const router = express.Router();
const startLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 20, error: 'יותר מדי ניסיונות חיבור — נסו שוב בעוד כמה דקות' });

function publicOrigin(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
const safePath = (raw) => (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw.slice(0, 300) : '/');
const cleanServices = (raw) => [...new Set(String(raw || '').split(',').map((s) => s.trim()).filter((s) => connectors.SERVICE_KEYS.includes(s)))];

router.get('/api/connectors', authRequired, async (req, res) => {
  try {
    res.json(await connectors.statusFor(req.user.id));
  } catch (err) {
    console.error('connectors status failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.get('/api/connectors/google/start', startLimit.middleware, (req, res) => {
  const back = (msg) => {
    const r0 = safePath(req.query.next);
    const i = r0.indexOf('#');
    res.redirect(`${i >= 0 ? r0.slice(0, i) : r0}?connectors_error=${encodeURIComponent(msg)}${i >= 0 ? r0.slice(i) : ''}`);
  };
  if (!connectors.configured()) return back('חיבור חשבון Google לא מוגדר בשרת הזה');
  let userId = null;
  try {
    const t = jwt.verify(String(req.query.t || ''), JWT_SECRET);
    if (t && Number.isInteger(t.id)) userId = t.id;
  } catch { /* no valid token below */ }
  if (!userId) return back('צריך להיות מחוברים כדי לחבר שירותים');
  const wanted = cleanServices(req.query.services);
  if (!wanted.length) return back('לא נבחר שירות לחיבור');
  const state = jwt.sign(
    { n: crypto.randomBytes(12).toString('hex'), u: userId, s: wanted, r: safePath(req.query.next) },
    JWT_SECRET, { expiresIn: '15m' },
  );
  res.redirect(connectors.authUrl({ origin: publicOrigin(req), state, wanted }));
});

router.get('/api/connectors/google/callback', async (req, res) => {
  // the way back keeps the chat's own hash (#plan, #recs) so the sheet reopens where it
  // was; what happened rides the query, which public/js/chat-ui.js reads and clears
  let path = '/', hash = '';
  const back = (params) => res.redirect(`${path}?${new URLSearchParams(params)}${hash}`);
  try {
    const { code, state, error } = req.query;
    let st;
    try { st = jwt.verify(String(state || ''), JWT_SECRET); } catch { return back({ connectors_error: 'פג תוקף הבקשה — נסו שוב' }); }
    const r0 = safePath(st.r);
    const i = r0.indexOf('#');
    path = i >= 0 ? r0.slice(0, i) : r0;
    hash = i >= 0 ? r0.slice(i) : '';
    if (error) return back({ connectors_error: 'החיבור בוטל' });
    if (!code || !Number.isInteger(st.u)) return back({ connectors_error: 'תשובה לא תקינה מ-Google' });
    const r = await connectors.completeAuth({ userId: st.u, code: String(code), origin: publicOrigin(req), wanted: Array.isArray(st.s) ? st.s : [] });
    analytics.capture('connector_enabled', 'user_' + st.u, { services: r.services });
    const wanted = Array.isArray(st.s) ? st.s : [];
    const on = r.services.filter((s) => wanted.includes(s));
    back(on.length ? { connected: on.join(',') } : { refused: r.wantedButRefused.join(',') || wanted.join(',') });
  } catch (err) {
    console.error('connectors callback failed', err.message);
    back({ connectors_error: 'לא הצלחנו להשלים את החיבור' });
  }
});

router.delete('/api/connectors/google/:service', authRequired, async (req, res) => {
  try {
    const service = String(req.params.service);
    if (!connectors.SERVICE_KEYS.includes(service)) return res.status(400).json({ error: 'שירות לא מוכר' });
    const r = await connectors.disable(req.user.id, service);
    analytics.capture('connector_disabled', 'user_' + req.user.id, { service, left: r.services });
    res.json(await connectors.statusFor(req.user.id));
  } catch (err) {
    console.error('connectors disable failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
