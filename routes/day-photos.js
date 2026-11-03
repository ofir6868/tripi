// The day's pictures — chosen from the traveller's own Google Drive, kept in Drive.
//
//   GET    /api/trips/code/:code/day-photos            every day's pictures, read live from Drive
//   POST   /api/trips/code/:code/day-photos            { day, files: [driveFileId] } — attach
//   DELETE /api/trips/code/:code/day-photos/:id        detach (the file in Drive is untouched)
//   GET    /api/day-photos/:id/img                     one picture's bytes (signed link)
//   GET    /api/connectors/drive/photos                the picker: the traveller's own pictures
//   GET    /api/connectors/drive/thumb/:uid/:fileId        a picker thumbnail (signed link)
//
// Drive is the source of truth, the only copy, and the off switch:
// - we keep a pointer per picture (trip, day, whose Drive, which file — trip_day_photos),
//   never the picture. Every look reads Drive through the owner's connector and streams
//   the bytes on; a file deleted or trashed in Drive drops its pointer the next time the
//   trip is opened.
// - nothing here runs for a traveller whose Drive switch is off: the page asks first
//   (can_add), and with no Drive and no pictures from anyone the feature is not drawn at
//   all (public/js/trip-day-photos.js). An owner who switches Drive off hides their
//   pictures from the trip; switching it back on brings them back.
// - the pictures belong to the trip's people, not to the share code: participants only.
//
// An <img> cannot carry the Authorization header, so the picture links are signed
// (HMAC, a few hours) — handed out only to someone this route already let in.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { authRequired, authOptional, isAdmin, JWT_SECRET } = require('../lib/auth');
const { tripWithEditAuth, isParticipant } = require('../lib/trips');
const connectors = require('../lib/connectors');
const { rateLimiter } = require('../lib/rate-limit');
const analytics = require('../lib/posthog');

const router = express.Router();

const MAX_PER_DAY = 60;
const MAX_PER_POST = 30;
const SIGN_TTL_S = 6 * 60 * 60;
const META_TTL = 10 * 60 * 1000;
const CONCURRENCY = 6;

const imgLimit = rateLimiter({ windowMs: 60 * 1000, max: 600, error: 'יותר מדי בקשות לתמונות — נסו שוב בעוד רגע' });
const pickLimit = rateLimiter({ windowMs: 60 * 1000, max: 40, error: 'יותר מדי חיפושים — נסו שוב בעוד רגע' });

// ---------- signed links ----------
const SIGN_KEY = crypto.createHash('sha256').update(`day-photos:${JWT_SECRET || 'tripmaker'}`).digest();
const mac = (s) => crypto.createHmac('sha256', SIGN_KEY).update(s).digest('base64url').slice(0, 32);
function signed(path, subject, size) {
  const e = Math.floor(Date.now() / 1000) + SIGN_TTL_S;
  // rounded to the hour, so the same picture keeps the same URL and the browser's cache works
  const exp = Math.ceil(e / 3600) * 3600;
  return `${path}?s=${size}&e=${exp}&k=${mac(`${subject}:${size}:${exp}`)}`;
}
function verify(req, subject) {
  const e = +req.query.e;
  const size = +req.query.s || 400;
  if (!Number.isFinite(e) || e < Date.now() / 1000) return null;
  const k = String(req.query.k || '');
  const want = mac(`${subject}:${size}:${e}`);
  if (k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return null;
  return size;
}

// ---------- reading Drive, a few at a time, remembered briefly ----------
const metaCache = new Map(); // `${owner}:${file}` → { at, meta }  (meta null = gone)
async function metaOf(ownerId, fileId) {
  const key = `${ownerId}:${fileId}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return hit.meta;
  const meta = await connectors.drivePhoto(ownerId, fileId);
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(key, { at: Date.now(), meta });
  return meta;
}
async function pool6(list, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (i < list.length) { const j = i++; out[j] = await fn(list[j]); }
  }));
  return out;
}

async function tripForViewer(req) {
  const { rows } = await pool.query('SELECT id, owner_id, days, start_date FROM trips WHERE share_code = $1', [req.params.code]);
  const trip = rows[0];
  if (!trip || !req.user) return { trip, member: false };
  const member = req.user.id === trip.owner_id || await isParticipant(trip.id, req.user.id) || await isAdmin(req);
  return { trip, member };
}

const driveOn = async (userId) => (await connectors.enabledFor(userId)).includes('drive');

// ---------- the trip's pictures ----------

router.get('/api/trips/code/:code/day-photos', authOptional, async (req, res) => {
  try {
    const { trip, member } = await tripForViewer(req);
    if (!trip) return res.status(404).json({ error: 'הטיול לא נמצא' });
    if (!member || !connectors.configured()) return res.json({ can_add: false, photos: [] });
    const canAdd = await driveOn(req.user.id);
    const { rows } = await pool.query(
      'SELECT id, day_number, owner_id, file_id FROM trip_day_photos WHERE trip_id = $1 ORDER BY day_number, id', [trip.id]);
    // whose Drive is still switched on — a picture is shown only through its owner's Drive
    const owners = [...new Set(rows.map((r) => r.owner_id))];
    const live = new Set();
    await Promise.all(owners.map(async (o) => { if (await driveOn(o).catch(() => false)) live.add(o); }));
    const shown = rows.filter((r) => live.has(r.owner_id));
    const gone = [];
    const metas = await pool6(shown, async (r) => {
      try {
        const m = await metaOf(r.owner_id, r.file_id);
        if (!m) gone.push(r.id);
        return m;
      } catch { return null; } // Drive did not answer — not proof the file is gone; it is just not shown this time
    });
    if (gone.length) {
      // Drive said the file is not there (deleted, trashed, not a picture any more): the pointer goes too
      pool.query('DELETE FROM trip_day_photos WHERE id = ANY($1)', [gone]).catch(() => {});
    }
    const photos = shown.map((r, i) => {
      const m = metas[i];
      if (!m) return null;
      const path = `/api/day-photos/${r.id}/img`;
      return {
        id: r.id, day: r.day_number, file_id: r.file_id, name: m.name, taken: m.taken, lat: m.lat, lon: m.lon,
        mine: r.owner_id === req.user.id,
        link: r.owner_id === req.user.id ? m.link : null,
        thumb: signed(path, `p${r.id}`, 360),
        full: signed(path, `p${r.id}`, 1600),
      };
    }).filter(Boolean);
    // within a day, in the order they were taken (pictures without a clock keep the order they were added in)
    photos.sort((a, b) => a.day - b.day || (a.taken && b.taken ? a.taken.localeCompare(b.taken) : 0) || a.id - b.id);
    res.json({ can_add: canAdd, photos });
  } catch (err) {
    console.error('day photos list failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.post('/api/trips/code/:code/day-photos', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    if (!connectors.configured() || !(await driveOn(req.user.id))) return res.status(409).json({ error: 'צריך לחבר את Google Drive כדי להוסיף תמונות' });
    const day = parseInt(req.body && req.body.day, 10);
    const days = Math.max(+trip.days || 1, 1);
    if (!(day >= 1 && day <= days)) return res.status(400).json({ error: 'יום לא תקין' });
    const ids = [...new Set((Array.isArray(req.body.files) ? req.body.files : [])
      .map((f) => String(f || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)).filter(Boolean))].slice(0, MAX_PER_POST);
    if (!ids.length) return res.status(400).json({ error: 'לא נבחרו תמונות' });
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM trip_day_photos WHERE trip_id = $1 AND day_number = $2', [trip.id, day]);
    const room = Math.max(MAX_PER_DAY - n, 0);
    if (!room) return res.status(400).json({ error: `אפשר עד ${MAX_PER_DAY} תמונות ביום` });
    // only files this traveller can really see in their Drive, and only pictures
    const asked = ids.slice(0, room);
    const metas = await pool6(asked, (id) => connectors.drivePhoto(req.user.id, id).catch(() => null));
    const ok = asked.filter((_, i) => metas[i]);
    if (!ok.length) return res.status(400).json({ error: 'התמונות שנבחרו לא נמצאו ב-Drive' });
    await pool.query(
      `INSERT INTO trip_day_photos (trip_id, day_number, owner_id, file_id)
       SELECT $1, $2, $3, unnest($4::text[]) ON CONFLICT (trip_id, day_number, file_id) DO NOTHING`,
      [trip.id, day, req.user.id, ok]);
    asked.forEach((id, i) => { if (metas[i]) metaCache.set(`${req.user.id}:${id}`, { at: Date.now(), meta: metas[i] }); });
    analytics.capture('day_photos_added', 'user_' + req.user.id, { code: req.params.code, day, count: ok.length });
    res.json({ added: ok.length, skipped: ids.length - ok.length });
  } catch (err) {
    console.error('day photos add failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.delete('/api/trips/code/:code/day-photos/:id', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const { rowCount } = await pool.query('DELETE FROM trip_day_photos WHERE id = $1 AND trip_id = $2', [+req.params.id || 0, trip.id]);
    if (!rowCount) return res.status(404).json({ error: 'התמונה לא נמצאה' });
    res.json({ ok: true });
  } catch (err) {
    console.error('day photos remove failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- the bytes, streamed on — never stored ----------

async function sendImage(res, ownerId, fileId, size) {
  try {
    const { buf, type } = await connectors.drivePhotoBytes(ownerId, fileId, size);
    res.setHeader('Content-Type', /^image\//.test(type) ? type : 'image/jpeg');
    // Drive is the only copy: not us, and not the device's cache either
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (err) {
    const gone = err && /gone|not connected|google api 404/.test(err.message);
    if (!gone) console.warn('drive photo bytes failed', err && err.message);
    res.status(gone ? 404 : 502).end();
  }
}

router.get('/api/day-photos/:id/img', imgLimit.middleware, async (req, res) => {
  const id = +req.params.id || 0;
  const size = verify(req, `p${id}`);
  if (!size) return res.status(403).end();
  try {
    const { rows } = await pool.query('SELECT owner_id, file_id FROM trip_day_photos WHERE id = $1', [id]);
    if (!rows[0] || !(await driveOn(rows[0].owner_id))) return res.status(404).end();
    await sendImage(res, rows[0].owner_id, rows[0].file_id, size);
  } catch (err) {
    console.warn('day photo img failed', err.message);
    res.status(502).end();
  }
});

// ---------- the picker: the traveller's own Drive ----------

router.get('/api/connectors/drive/photos', authRequired, pickLimit.middleware, async (req, res) => {
  try {
    if (!connectors.configured() || !(await driveOn(req.user.id))) return res.status(409).json({ error: 'Google Drive לא מחובר' });
    const r = await connectors.drivePhotos(req.user.id, { date: req.query.date, q: req.query.q, pageToken: req.query.page });
    const out = (p) => ({ ...p, thumb: signed(`/api/connectors/drive/thumb/${req.user.id}/${encodeURIComponent(p.file_id)}`, `u${req.user.id}:${p.file_id}`, 300) });
    res.json({ day: r.day.map(out), recent: r.recent.map(out), next: r.next });
  } catch (err) {
    const code = err && err.message === 'permission' ? 403 : 502;
    console.warn('drive photos list failed', err && err.message);
    res.status(code).json({ error: code === 403 ? 'אין הרשאה לקרוא את ה-Drive — חברו אותו מחדש' : 'לא הצלחנו לקרוא את ה-Drive' });
  }
});

// the subject carries the user, so the link works only for the Drive it was made for
router.get('/api/connectors/drive/thumb/:uid/:fileId', imgLimit.middleware, async (req, res) => {
  const fid = String(req.params.fileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const uid = parseInt(req.params.uid, 10);
  if (!Number.isInteger(uid)) return res.status(403).end();
  const size = verify(req, `u${uid}:${fid}`);
  if (!size) return res.status(403).end();
  if (!(await driveOn(uid).catch(() => false))) return res.status(404).end();
  await sendImage(res, uid, fid, size);
});

module.exports = router;
module.exports._test = { signed, verify };
