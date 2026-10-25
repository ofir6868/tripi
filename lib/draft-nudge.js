// A draft that stopped is a traveller who stopped — nearly half the trips ever started
// were still drafts when anyone counted, and nothing ever called anyone back to one.
// Two ways back, both built on the same reading of a draft:
//
//  - in the app: the homepage and the wizard ask /api/my-drafts/waiting and offer the
//    draft back ("הטיול לרומא מחכה לכם") — it reaches everyone who returns, guests
//    included, with no permission to ask for;
//  - by push (lib/reminders.js): once after two quiet days and once after a week, to
//    the travellers who allowed notifications — never more than that per draft.
//
// "Quiet" is measured from the trip's creation and the last turn of its planning chat.
// trip_items carries no timestamps, so a draft edited only by hand on the trip page
// reads as older than it is — the cost of that is one early nudge, which is why there
// are at most two.
const { pool } = require('./db');

// the window a draft is still worth offering back: past that it is a trip the
// traveller gave up on, and bringing it up again is noise
const WAITING_DAYS = 30;

const DRAFT_FIELDS = `t.id, t.owner_id, t.title, t.destination, t.country, t.destinations, t.cover_image,
  t.share_code, t.days,
  GREATEST(t.created_at, (SELECT MAX(m.created_at) FROM trip_plan_messages m WHERE m.trip_id = t.id)) AS last_active,
  (SELECT COUNT(DISTINCT i.day_number) FROM trip_items i WHERE i.trip_id = t.id)::int AS filled_days`;

// the owner's most recently touched draft, or null
async function waitingDraft(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM (SELECT ${DRAFT_FIELDS} FROM trips t WHERE t.owner_id = $1 AND t.is_draft) d
     WHERE last_active > now() - make_interval(days => $2)
     ORDER BY last_active DESC LIMIT 1`,
    [userId, WAITING_DAYS]
  );
  return rows[0] || null;
}

// the words, the same for the card and the push: what is done, and the one next step
function nudgeCopy(d) {
  // a one-place trip is named by the place ("לרומא", not "לאיטליה"); several places by
  // their country, since a list of cities does not fit in a notification title
  const names = (Array.isArray(d.destinations) ? d.destinations : []).filter((x) => x && x.name).map((x) => x.name);
  const where = names.length === 1 ? names[0] : (d.country || d.destination);
  const days = Math.max(+d.days || 1, 1);
  const filled = Math.min(+d.filled_days || 0, days);
  const title = `הטיול ל${where} מחכה לכם`;
  let body;
  if (!filled) body = 'התחלתם לתכנן — עוד כמה דקות עם ה-AI והמסלול מוכן';
  else if (filled < days) body = `${filled} מתוך ${days} ימים כבר במסלול — נשלים את השאר?`;
  else body = 'המסלול מלא — נשאר רק לשמור את הטיול ולשלוח לחברים';
  return { title, body };
}

// drafts that went quiet `age` days ago (a one-day band, so a daily tick meets each
// draft once) and were never nudged under `kind`
async function quietDrafts(age, kind) {
  const { rows } = await pool.query(
    `SELECT * FROM (SELECT ${DRAFT_FIELDS} FROM trips t WHERE t.is_draft) d
     WHERE last_active <= now() - make_interval(days => $1)
       AND last_active > now() - make_interval(days => $1 + 1)
       AND NOT EXISTS (SELECT 1 FROM push_log p WHERE p.trip_id = d.id AND p.kind = $2)`,
    [age, kind]
  );
  return rows;
}

module.exports = { waitingDraft, nudgeCopy, quietDrafts, WAITING_DAYS };
