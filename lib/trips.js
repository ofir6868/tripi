const { pool } = require('./db');
const { isAdmin } = require('./auth');

function generateShareCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function uniqueShareCode(client) {
  for (let i = 0; i < 20; i++) {
    const code = generateShareCode();
    const { rows } = await client.query('SELECT 1 FROM trips WHERE share_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('could not generate share code');
}

const tripFields = `id, owner_id, title, destination, country, description, cover_image,
  start_date, end_date, days, share_code, is_public, emoji, destinations, likes, created_at`;

function newInviteToken() {
  return require('crypto').randomBytes(16).toString('base64url');
}

async function isParticipant(tripId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM trip_participants WHERE trip_id = $1 AND user_id = $2', [tripId, userId]
  );
  return rows.length > 0;
}

// resolve a trip by share code and check edit rights: owner, participant, or admin
async function tripWithEditAuth(req, res) {
  const { rows } = await pool.query(
    `SELECT ${tripFields}, invite_token FROM trips WHERE share_code = $1`, [req.params.code]
  );
  const trip = rows[0];
  if (!trip) { res.status(404).json({ error: 'הטיול לא נמצא' }); return null; }
  if (!req.user) {
    res.status(401).json({ error: 'נדרשת התחברות כדי לערוך את הטיול' });
    return null;
  }
  const allowed = req.user.id === trip.owner_id
    || await isParticipant(trip.id, req.user.id)
    || await isAdmin(req);
  if (!allowed) {
    res.status(403).json({ error: 'רק משתתפי הטיול יכולים לערוך — בקשו קישור הזמנה מהמארגנים' });
    return null;
  }
  return trip;
}

// sanitize a client-supplied destinations array → [{name, country, lat, lon}]
// a cleared field arrives as null or '' — and `+null` is 0, which Number.isFinite
// happily accepts. Without these, clearing a location pins it at 0°,0° in the
// Atlantic, and clearing a price books it as free.
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
// same, for a non-negative capped amount (null stays null — `null >= 0` is true, so
// the check has to be explicit)
const moneyOrNull = (v, max = 99999999) => {
  const n = numOrNull(v);
  return n != null && n >= 0 ? Math.min(n, max) : null;
};

function cleanDestinations(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map((d) => ({
    name: String(d?.name || '').slice(0, 80).trim(),
    country: d?.country ? String(d.country).slice(0, 60).trim() : null,
    lat: numOrNull(d?.lat),
    lon: numOrNull(d?.lon),
  })).filter((d) => d.name);
}

module.exports = {
  generateShareCode, uniqueShareCode, tripFields, newInviteToken, isParticipant,
  tripWithEditAuth, numOrNull, moneyOrNull, cleanDestinations,
};
