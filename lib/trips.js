const { pool } = require('./db');
const { isAdmin } = require('./auth');
const { cleanFlights } = require('./flights');

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

// what a viewer (gallery visitor, share-code holder who isn't a participant) may
// see: the itinerary and hotel names, never money. Participants get the raw rows.
function viewerSafeItems(rows) {
  return rows.map((it) => ({ ...it, cost: null }));
}
function viewerSafeHotels(rows) {
  return rows.map((h) => ({ ...h, price_total: null, note: null }));
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
// a trip long enough for a plan_state to matter is still a trip somebody may have set to
// 400 days in a URL; the flights cleaner needs a bound, and this is the same one the
// planning routes clamp days to
const MAX_DAYS = 400;
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
  out.areas.sort((a, b) => a.from - b.from);
  // the flights the card settled (lib/flights.js) — legs, whether they are confirmed, and
  // the stops they wrote, so re-confirming replaces them instead of stacking a second set
  const flights = cleanFlights(src.flights, MAX_DAYS);
  if (flights) out.flights = flights;
  if (src.build === 'once' || src.build === 'steps') out.build = src.build;
  if (src.opened) out.opened = true;
  if (src.invited) out.invited = true; // the co-planner invitation was offered once
  // the opening round is behind us — the trip page's dock has been earned, and never
  // goes back into hiding (routes/plan.js decides the moment, trip-pages.js paints it)
  if (src.basics) out.basics = true;
  return out;
}

// A day→area split is "the one that counts" only when it covers the trip end to end:
// day 1 to the last day, contiguous, no gaps and no overlaps. The planning chat refuses
// to store anything else, and the free-day picks (routes/day-recs.js) ask the same
// question before they use it instead of asking the model for a split of their own —
// one definition, so "there is a split" cannot mean two different things in two places.
function areasCoverTrip(areas, days) {
  const list = Array.isArray(areas) ? areas : [];
  if (!list.length || !Number.isInteger(days) || days < 1) return false;
  if (list[0].from !== 1 || list[list.length - 1].to !== days) return false;
  for (let i = 1; i < list.length; i++) if (list[i].from !== list[i - 1].to + 1) return false;
  return list.every((a) => a.area && a.to >= a.from);
}

// What the travellers actually asked for — the wizard's interest chips ("חיי לילה",
// "חופים וים"), the free text beside them, and whatever the planning chat has since
// agreed with them. One definition, read by every surface that recommends a PLACE: the
// recommendations chat, the free-day picks and the planner itself.
//
// Why it is worded this hard: the preferences were reaching the build and nothing else,
// so a trip built around nightlife went on to be filled, day after day, with museums —
// and the traveller had no way to tell that the chips they ticked had ever been read. A
// list of interests dropped quietly into a prompt does not survive a model's own taste;
// naming the share of the answer they own, and asking the blurb to say which preference
// it serves, is what makes them visible in the output as well as in the input.
// `facts`: false for the planning chat, which already prints its whole memory under
// "מה שכבר הוסכם" — the same lines twice in one prompt buy nothing and cost tokens.
function tripPrefsBlock(planState, { facts = true } = {}) {
  const s = cleanPlanState(planState);
  const lines = [];
  if (s.interests.length) lines.push(`תחומי העניין שסימנו: ${s.interests.join(', ')}`);
  if (s.notes) lines.push(`מה שסיפרו על עצמם: "${s.notes}"`);
  // the chat's memory holds preferences nobody ticked — "אוהבים לישון עד מאוחר",
  // "בלי טרקים ארוכים" — and they are worth exactly as much as the chips
  if (facts) for (const f of s.facts.slice(0, 8)) lines.push(f);
  if (!lines.length) return '';
  const rules = [
    s.interests.length
      ? `אלה לא רקע: לפחות שני שליש מההמלצות שתציעו חייבות לענות ישירות על תחומי העניין שסומנו (${s.interests.join(', ')}).`
      : 'אלה לא רקע: ההמלצות שתציעו צריכות לענות על מה שכתוב כאן.',
    'ב-blurb של כל המלצה כזו אמרו במפורש מה בה עונה להעדפה ("החוף השקט באי", "הרחוב שבו יוצאים בלילה") — כדי שהמטיילים יראו שנקראו.',
    'מה שסותר את ההעדפות לא נכנס: לא מוזיאונים למי שביקש חיי לילה, ולא מקומות יקרים למי שביקש תקציב נמוך.',
  ];
  return `\nההעדפות של המטיילים — הקו המנחה של כל המלצה כאן:\n${lines.map((l) => `- ${l}`).join('\n')}\n${rules.join(' ')}\n`;
}

module.exports = {
  generateShareCode, cleanPlanState, areasCoverTrip, tripPrefsBlock, PLAN_MODES, PLAN_STAGES, uniqueShareCode, tripFields, newInviteToken, isParticipant,
  tripWithEditAuth, viewerSafeItems, viewerSafeHotels, numOrNull, moneyOrNull, cleanDestinations,
};
