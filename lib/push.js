// Web Push fan-out to a trip's co-planners.
//
// Free by construction: the browser vendors' push services (FCM / Mozilla / Apple)
// carry the message at no cost, and VAPID is just a keypair we sign with — no
// account, no per-message fee, no third-party SDK. All this module needs is
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment; without them every
// call below turns into a no-op so the app runs exactly as before.
const webpush = require('web-push');
const { pool } = require('./db');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:ofiregev68@gmail.com';

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn('push: VAPID keys missing — notifications are disabled');
}

// "X changed the itinerary" is true after every keystroke-sized edit. One message
// per person per trip per window, and the rest of the burst is swallowed: the
// notification says "come see what changed", so a single ping covers all of it.
const EDIT_QUIET_MS = 10 * 60 * 1000;
const lastEditPing = new Map(); // `${tripId}:${actorId}` → timestamp
setInterval(() => {
  const cutoff = Date.now() - EDIT_QUIET_MS;
  for (const [k, t] of lastEditPing) if (t < cutoff) lastEditPing.delete(k);
}, EDIT_QUIET_MS).unref?.();

// the flags in the notification are resolved browser-side from these Hebrew names
// (the country list lives in public/js/countries.js and the service worker imports
// it) — so the server never stores or ships flag glyphs, same rule as the UI
function tripCountries(trip) {
  const names = (Array.isArray(trip.destinations) ? trip.destinations : [])
    .map((d) => d && (d.country || d.name))
    .concat(trip.country ? [trip.country] : [])
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  return [...new Set(names)].slice(0, 3);
}

async function recipients(tripId, ownerId, excludeUserId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id FROM users u
     WHERE (u.id = $2 OR u.id IN (SELECT user_id FROM trip_participants WHERE trip_id = $1))
       AND u.id <> COALESCE($3, -1)`,
    [tripId, ownerId, excludeUserId ?? null]
  );
  return rows.map((r) => r.id);
}

async function sendToUsers(userIds, payload) {
  if (!userIds.length) return 0;
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1)', [userIds]
  );
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(rows.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body
      );
      sent++;
    } catch (err) {
      // 404/410 = the browser threw this subscription away (app uninstalled,
      // permission revoked, profile wiped). Anything else is transient — a dead
      // row that keeps failing is worse than a missed ping, so only prune those.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
      } else {
        console.error('push send failed:', err.statusCode || err.message);
      }
    }
  }));
  return sent;
}

// fire-and-forget: a notification must never delay (or fail) the request that
// triggered it — the join/edit already succeeded by the time we get here
async function notifyTrip(tripId, { actorId, actorName, kind }) {
  if (!enabled) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, owner_id, title, destination, country, destinations, cover_image, share_code
       FROM trips WHERE id = $1`, [tripId]
    );
    const trip = rows[0];
    if (!trip) return;

    if (kind === 'edit') {
      const key = `${tripId}:${actorId}`;
      const now = Date.now();
      if (now - (lastEditPing.get(key) || 0) < EDIT_QUIET_MS) return;
      lastEditPing.set(key, now);
    }

    const to = await recipients(tripId, trip.owner_id, actorId);
    if (!to.length) return;

    const where = trip.country || trip.destination;
    const actor = actorName || 'מישהו';
    const { rows: cnt } = await pool.query(
      `SELECT (SELECT count(*) FROM trip_participants WHERE trip_id = $1) + 1 AS n`, [tripId]
    );
    const n = cnt[0] ? +cnt[0].n : 2;

    const copy = kind === 'join'
      ? {
        title: `${actor} הצטרף/ה לטיול ל${where}`,
        body: `אתם כבר ${n} שמתכננים ביחד · הציצו מה מחכה במסלול`,
      }
      : {
        title: `${actor} עדכן/ה את המסלול ל${where}`,
        body: `בואו לראות אילו שינויים נכנסו ל"${trip.title}"`,
      };

    await sendToUsers(to, {
      kind,
      title: copy.title,
      body: copy.body,
      url: `/trip/${trip.share_code}`,
      tag: `trip-${trip.share_code}`,
      cover: trip.cover_image || null,
      countries: tripCountries(trip),
      actor,
    });
  } catch (err) {
    console.error('notifyTrip failed:', err.message);
  }
}

// never await this from a route handler
const notifyTripAsync = (...args) => { notifyTrip(...args).catch(() => {}); };

module.exports = { enabled, publicKey: PUBLIC_KEY, notifyTrip, notifyTripAsync };
