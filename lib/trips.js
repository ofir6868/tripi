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
  start_date, end_date, days, share_code, is_public, is_draft, emoji, destinations, likes, created_at`;

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
    // plan_state (the planning chat's memory) rides along here, and only here: this is
    // the editors' path, and the memory holds what the travellers told the AI
    `SELECT ${tripFields}, invite_token, plan_state FROM trips WHERE share_code = $1`, [req.params.code]
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

// the planning chat's memory, as the wizard seeds it and the chat route grows it.
// Only known keys, each capped — it is model-written JSON headed for a JSONB column.
const PLAN_MODES = ['auto', 'manual'];
const PLAN_STAGES = ['clarify', 'choose', 'areas', 'flights', 'days', 'done'];
function cleanPlanState(input) {
  const src = input && typeof input === 'object' ? input : {};
  const strs = (v, n, len) => (Array.isArray(v) ? v : []).slice(0, n)
    .map((x) => String(x ?? '').slice(0, len).trim()).filter(Boolean);
  const out = {
    mode: PLAN_MODES.includes(src.mode) ? src.mode : 'manual',
    stage: PLAN_STAGES.includes(src.stage) ? src.stage : 'clarify',
    interests: strs(src.interests, 15, 40),
    notes: src.notes ? String(src.notes).slice(0, 500).trim() : '',
    facts: strs(src.facts, 24, 160),
    // the clarifying questions still to ask, with the chips they came with
    pending: (Array.isArray(src.pending) ? src.pending : []).slice(0, 3).map((q) => ({
      question: String(q?.question || '').slice(0, 200).trim(),
      options: strs(q?.options, 6, 60),
      multi: !!q?.multi,
    })).filter((q) => q.question),
    areas: (Array.isArray(src.areas) ? src.areas : []).slice(0, 12).map((a) => ({
      area: String(a?.area || '').slice(0, 60).trim(),
      from: parseInt(a?.from, 10),
      to: parseInt(a?.to, 10),
      cities: strs(a?.cities, 3, 60),
    })).filter((a) => a.area && Number.isInteger(a.from) && Number.isInteger(a.to) && a.to >= a.from),
  };
  if (src.build === 'once' || src.build === 'steps') out.build = src.build;
  if (src.opened) out.opened = true;
  if (src.invited) out.invited = true; // the co-planner invitation was offered once
  return out;
}

module.exports = {
  generateShareCode, cleanPlanState, PLAN_MODES, PLAN_STAGES, uniqueShareCode, tripFields, newInviteToken, isParticipant,
  tripWithEditAuth, numOrNull, moneyOrNull, cleanDestinations,
};
