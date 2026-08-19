const express = require('express');
const { pool } = require('../lib/db');
const { authRequired, authOptional, isAdmin } = require('../lib/auth');
const {
  uniqueShareCode, tripFields, newInviteToken, isParticipant, tripWithEditAuth,
  numOrNull, moneyOrNull, cleanDestinations,
} = require('../lib/trips');
const { rateLimiter } = require('../lib/rate-limit');
const { notifyTripAsync } = require('../lib/push');
const { verifyPlaces } = require('../lib/places');

const router = express.Router();

// the 6-digit share code is the only thing protecting unpublished trips, so codes
// must not be enumerable. Only *missed* lookups count — typos are rare and page
// loads of real trips never touch the counter, but a scanner burns out in seconds.
const codeMissLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const CODE_MISS_ERROR = 'יותר מדי קודים שגויים — נסו שוב בעוד רבע שעה';

router.get('/api/trips/suggested', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips WHERE is_public = true AND NOT is_draft ORDER BY likes DESC, id LIMIT 16`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.get('/api/trips/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    if (/^\d{6}$/.test(q)) {
      if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
      const { rows } = await pool.query(`SELECT ${tripFields} FROM trips WHERE share_code = $1`, [q]);
      if (!rows.length) codeMissLimit.hit(req.ip);
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips
       WHERE is_public = true AND NOT is_draft AND (title ILIKE $1 OR destination ILIKE $1 OR country ILIKE $1)
       ORDER BY id LIMIT 12`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.get('/api/trips/code/:code', authOptional, async (req, res) => {
  try {
    if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
    const { rows } = await pool.query(
      `SELECT ${tripFields}, invite_token FROM trips WHERE share_code = $1`, [req.params.code]
    );
    if (!rows[0]) {
      codeMissLimit.hit(req.ip);
      return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    }
    const trip = rows[0];
    const isOwner = !!(req.user && req.user.id === trip.owner_id);
    const admin = await isAdmin(req);
    // edit rights: owner, admin, or a trip participant — unlocks prices/notes/expenses
    const canEdit = isOwner || admin || (!!req.user && await isParticipant(trip.id, req.user.id));
    if (canEdit && !trip.invite_token) {
      // trips that predate invite links get one the first time a participant loads them
      trip.invite_token = newInviteToken();
      await pool.query('UPDATE trips SET invite_token = $1 WHERE id = $2', [trip.invite_token, trip.id]);
    }
    if (!canEdit) delete trip.invite_token; // the invite link is only revealed to participants
    const [items, hotels, budget, expenses, participants] = await Promise.all([
      pool.query('SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]),
      pool.query('SELECT * FROM trip_hotels WHERE trip_id = $1 ORDER BY night_start, id', [trip.id]),
      pool.query('SELECT total, currency, travelers FROM trip_budgets WHERE trip_id = $1', [trip.id]),
      pool.query('SELECT id, title, amount, category, day_number, paid_by, created_at FROM trip_expenses WHERE trip_id = $1 ORDER BY created_at DESC, id DESC', [trip.id]),
      canEdit ? pool.query(
        `SELECT u.id, u.name, (u.id = COALESCE($2, -1)) AS is_owner
         FROM users u
         WHERE u.id = COALESCE($2, -1) OR u.id IN (SELECT user_id FROM trip_participants WHERE trip_id = $1)
         ORDER BY (u.id = COALESCE($2, -1)) DESC, u.name`,
        [trip.id, trip.owner_id]
      ) : Promise.resolve({ rows: [] }),
    ]);
    // privacy split: viewers see hotel names/nights/links but not money or
    // confirmation notes, and no expense log — those are for participants
    const hotelRows = canEdit ? hotels.rows
      : hotels.rows.map((h) => ({ ...h, price_total: null, note: null }));
    res.json({
      trip, items: items.rows, isOwner, canEdit, isAdmin: admin,
      hotels: hotelRows,
      budget: budget.rows[0] || null,
      expenses: canEdit ? expenses.rows : [],
      participants: participants.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- map backfill: coordinates for the stops that never got any ----
// The day map draws stored lat/lon. Verification only started keeping the coordinates
// it pays for on 2026-08-18, so nearly every stop written before that has a
// place_query and no pin — and a build whose geocoder was having a bad minute leaves
// the same hole. The trip page asks for a batch per load; whatever the geocoder can
// place is written back, so the work happens once per stop and the map fills in.
// Anyone who can open the trip may ask: it only resolves a place name the page
// already shows, and it can't touch anything else on the row.
const LOCATE_BATCH = 25; // ~15s at the geocoder's polite pace — one page-load's worth
const LOCATE_MAX_KM = 80; // clears a day-trip's outskirts, catches a same-name place elsewhere

// Photon and Overpass both refuse Render's datacenter IPs (measured 2026-08-19: the
// same eight Eilat stops that geocode from a laptop come back empty from the server),
// so the page geocodes its own stops from the browser — where the place picker has
// always reached Photon — and posts the coordinates here. Only someone who may edit
// the trip may write them, and only over a stop that has none: a pin is cosmetic, but
// a stranger who knows the share code shouldn't get to move one.
async function saveLocatedCoords(req, res) {
  const trip = await tripWithEditAuth(req, res);
  if (!trip) return;
  const coords = (Array.isArray(req.body.coords) ? req.body.coords : [])
    .map((c) => ({ id: parseInt(c && c.id, 10), lat: numOrNull(c && c.lat), lon: numOrNull(c && c.lon) }))
    .filter((c) => Number.isInteger(c.id) && c.lat != null && c.lon != null &&
      Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180)
    .slice(0, 200);
  if (!coords.length) return res.json({ saved: 0 });
  const { rowCount } = await pool.query(
    `UPDATE trip_items AS i SET lat = v.lat, lon = v.lon
       FROM unnest($1::int[], $2::float8[], $3::float8[]) AS v(id, lat, lon)
      WHERE i.id = v.id AND i.trip_id = $4 AND i.lat IS NULL`,
    [coords.map((c) => c.id), coords.map((c) => c.lat), coords.map((c) => c.lon), trip.id]
  );
  // deliberately no pingEdit: filling in a pin is not an itinerary change anyone
  // needs a push notification about
  res.json({ saved: rowCount });
}

router.post('/api/trips/code/:code/locate', authOptional, async (req, res) => {
  try {
    if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
    if (req.body && Array.isArray(req.body.coords)) return await saveLocatedCoords(req, res);
    const { rows } = await pool.query('SELECT id, destinations FROM trips WHERE share_code = $1', [req.params.code]);
    if (!rows[0]) {
      codeMissLimit.hit(req.ip); // same enumeration guard the page load itself gets
      return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    }
    const tripId = rows[0].id;
    // the same ceiling the page applies to its own lookups: a geocoder hit further than
    // this from every area of the trip is the right name in the wrong city — "Benny
    // HaDayag, Eilat" answers with a Rishon LeZion branch 250km up the coast
    const areas = (Array.isArray(rows[0].destinations) ? rows[0].destinations : [])
      .filter((d) => d && d.lat != null && d.lon != null);
    const nearAnArea = (c) => !areas.length || areas.some((d) =>
      Math.hypot((c.lat - d.lat) * 111, (c.lon - d.lon) * 111 * Math.cos(d.lat * Math.PI / 180)) <= LOCATE_MAX_KM);
    // the page walks the unlocated stops with `skip` — stops this call fails to place
    // stay NULL, and without the offset the next batch would ask about them again
    const skip = Math.max(parseInt(req.body && req.body.skip, 10) || 0, 0);
    const { rows: todo } = await pool.query(
      `SELECT id, place_query FROM trip_items
        WHERE trip_id = $1 AND lat IS NULL AND place_query IS NOT NULL
        ORDER BY day_number, sort_order, id
        OFFSET $2`, [tripId, skip]
    );
    const batch = todo.slice(0, LOCATE_BATCH);
    if (!batch.length) return res.json({ located: [], attempted: 0, remaining: 0 });

    const results = await verifyPlaces([...new Set(batch.map((r) => r.place_query))]);
    const located = [];
    for (const r of batch) {
      const v = results.get(r.place_query);
      if (v && v.verdict === 'ok' && v.best && v.best.lat != null && nearAnArea(v.best)) {
        located.push({ id: r.id, lat: v.best.lat, lon: v.best.lon });
      }
    }
    if (located.length) {
      // one statement for the batch — a round trip per stop is what made creation slow
      await pool.query(
        `UPDATE trip_items AS i SET lat = v.lat, lon = v.lon
           FROM unnest($1::int[], $2::float8[], $3::float8[]) AS v(id, lat, lon)
          WHERE i.id = v.id AND i.trip_id = $4`,
        [located.map((l) => l.id), located.map((l) => l.lat), located.map((l) => l.lon), tripId]
      );
    }
    res.json({ located, attempted: batch.length, remaining: todo.length - batch.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- calendar export: the itinerary as an .ics file ----
// Timed stops become floating (no-timezone) events — "09:00" means 09:00 wherever
// the traveler wakes up, which is exactly right for a trip abroad. Unclocked stops
// become all-day events, plus one all-day banner spanning the whole trip.
const icsEscape = (s) => String(s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  // every line-break flavor becomes a literal \n — a bare CR smuggled into a title
  // would otherwise split the content line and inject ICS properties of its own
  .replace(/\r\n?|\n/g, '\\n')
  .replace(/[\x00-\x1f]/g, '');
// RFC 5545 folding: content lines SHOULD stay within 75 octets — fold on character
// boundaries (never mid-UTF-8; Hebrew is 2 bytes a letter) with CRLF + space
function icsFold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
const icsDate = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

router.get('/api/trips/code/:code/calendar.ics', authOptional, async (req, res) => {
  try {
    if (codeMissLimit.blocked(req.ip)) return res.status(429).json({ error: CODE_MISS_ERROR });
    const { rows } = await pool.query(`SELECT ${tripFields} FROM trips WHERE share_code = $1`, [req.params.code]);
    if (!rows[0]) {
      codeMissLimit.hit(req.ip);
      return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    }
    const trip = rows[0];
    if (!trip.start_date) return res.status(400).json({ error: 'לטיול אין תאריך התחלה — קובעים תאריך ואפשר לייצא ליומן' });
    const { rows: items } = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, time_label NULLS FIRST, sort_order, id', [trip.id]
    );

    const start = new Date(trip.start_date);
    const dayOf = (n) => { const d = new Date(start); d.setDate(d.getDate() + n - 1); return d; };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // UTC basic format
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TRIP MAKER//trip planner//HE',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${icsEscape(trip.title)}`,
    ];
    const pageUrl = `${req.protocol}://${req.get('host')}/trip/${trip.share_code}`;

    // the whole trip as one all-day banner (DTEND is exclusive)
    const after = new Date(start); after.setDate(after.getDate() + Math.max(trip.days, 1));
    lines.push(
      'BEGIN:VEVENT',
      `UID:trip${trip.id}@tripmaker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(start)}`,
      `DTEND;VALUE=DATE:${icsDate(after)}`,
      `SUMMARY:${icsEscape(`${trip.emoji || '🧳'} ${trip.title}`)}`,
      `DESCRIPTION:${icsEscape(pageUrl)}`,
      'END:VEVENT'
    );

    for (const it of items) {
      const d = dayOf(it.day_number);
      const time = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(it.time_label || '').trim());
      lines.push('BEGIN:VEVENT', `UID:trip${trip.id}-item${it.id}@tripmaker`, `DTSTAMP:${stamp}`);
      if (time) {
        const hh = time[1].padStart(2, '0');
        // stops have no stored duration — an hour marks the slot. DTEND must be
        // strictly after DTSTART, so a 23:xx stop rolls its end into the next day.
        const endD = new Date(d);
        if (+time[1] === 23) endD.setDate(endD.getDate() + 1);
        lines.push(
          `DTSTART:${icsDate(d)}T${hh}${time[2]}00`,
          `DTEND:${icsDate(endD)}T${String((+time[1] + 1) % 24).padStart(2, '0')}${time[2]}00`
        );
      } else {
        const next = new Date(d); next.setDate(next.getDate() + 1);
        lines.push(`DTSTART;VALUE=DATE:${icsDate(d)}`, `DTEND;VALUE=DATE:${icsDate(next)}`);
      }
      lines.push(`SUMMARY:${icsEscape(it.title)}`);
      if (it.note) lines.push(`DESCRIPTION:${icsEscape(it.note)}`);
      if (it.place_query) lines.push(`LOCATION:${icsEscape(it.place_query)}`);
      if (it.lat != null && it.lon != null) lines.push(`GEO:${it.lat};${it.lon}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="tripmaker-${trip.share_code}.ics"`);
    res.send(lines.map(icsFold).join('\r\n') + '\r\n');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- collaborative editing (trip participants) ----

// redeem an invite link: a logged-in user with the current token becomes a participant
router.post('/api/trips/code/:code/join', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, owner_id, invite_token FROM trips WHERE share_code = $1', [req.params.code]
    );
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'הטיול לא נמצא' });
    const token = String((req.body || {}).token || '');
    if (!token || !trip.invite_token || token !== trip.invite_token) {
      return res.status(403).json({ error: 'קישור ההזמנה כבר לא בתוקף — בקשו מהמארגנים קישור חדש' });
    }
    if (req.user.id !== trip.owner_id) {
      const { rowCount } = await pool.query(
        'INSERT INTO trip_participants (trip_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [trip.id, req.user.id]
      );
      // only a genuinely new participant is news — reopening an invite link you
      // already redeemed must not re-ping everyone
      if (rowCount) {
        notifyTripAsync(trip.id, { actorId: req.user.id, actorName: req.user.name, kind: 'join' });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// remove a participant (or yourself — leaving the trip); the owner can't be removed
router.delete('/api/trips/code/:code/participants/:userId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const uid = parseInt(req.params.userId, 10);
    if (uid === trip.owner_id) return res.status(400).json({ error: 'אי אפשר להסיר את מארגן הטיול' });
    await pool.query('DELETE FROM trip_participants WHERE trip_id = $1 AND user_id = $2', [trip.id, uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// a fresh invite token invalidates every previously shared link
router.post('/api/trips/code/:code/invite/regenerate', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const token = newInviteToken();
    await pool.query('UPDATE trips SET invite_token = $1 WHERE id = $2', [token, trip.id]);
    res.json({ invite_token: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the "finish planning" ceremony: one-way draft → published. The share code was
// minted at creation — publishing only reveals it (and the share surfaces) in the UI.
router.post('/api/trips/code/:code/publish', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const { rows } = await pool.query(
      `UPDATE trips SET is_draft = false WHERE id = $1 RETURNING ${tripFields}`, [trip.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// every itinerary change tells the other co-planners the same thing ("come see
// what moved"), so they share one throttled notification — lib/push collapses a
// burst of edits into a single ping per person per trip
const pingEdit = (req, trip) =>
  notifyTripAsync(trip.id, { actorId: req.user.id, actorName: req.user.name, kind: 'edit' });

router.post('/api/trips/code/:code/items', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const it = req.body || {};
    if (!it.title || !String(it.title).trim()) return res.status(400).json({ error: 'חסרה כותרת לתחנה' });
    const { rows } = await pool.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))
       RETURNING *`,
      [trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), trip.days),
       it.time_label || null, String(it.title).slice(0, 200).trim(), it.note || null,
       it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
       numOrNull(it.lat), numOrNull(it.lon), moneyOrNull(it.cost)]
    );
    pingEdit(req, trip);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.patch('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    // partial update: only the keys present in the body are touched
    const body = req.body || {};
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if ('title' in body) {
      const title = String(body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'חסרה כותרת לתחנה' });
      add('title', title.slice(0, 200));
    }
    if ('day_number' in body) add('day_number', Math.min(Math.max(parseInt(body.day_number, 10) || 1, 1), trip.days));
    if ('time_label' in body) add('time_label', body.time_label ? String(body.time_label).slice(0, 20) : null);
    if ('category' in body) add('category', body.category ? String(body.category).slice(0, 40) : null);
    if ('area' in body) add('area', body.area ? String(body.area).slice(0, 80) : null);
    if ('note' in body) add('note', body.note ? String(body.note).slice(0, 500) : null);
    if ('place_query' in body) add('place_query', body.place_query ? String(body.place_query).slice(0, 120) : null);
    if ('lat' in body) add('lat', numOrNull(body.lat));
    if ('lon' in body) add('lon', numOrNull(body.lon));
    if ('cost' in body) add('cost', moneyOrNull(body.cost));
    // arrange-mode swaps trade sort_order between stops — it breaks ties among
    // same-day stops that share a time label (or have none)
    if ('sort_order' in body) add('sort_order', Math.max(parseInt(body.sort_order, 10) || 0, 0));
    if (!sets.length) return res.status(400).json({ error: 'אין מה לעדכן' });
    vals.push(req.params.itemId, trip.id);
    const { rows } = await pool.query(
      `UPDATE trip_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND trip_id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'התחנה לא נמצאה' });
    pingEdit(req, trip);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.delete('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [req.params.itemId, trip.id]);
    pingEdit(req, trip);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- stop votes (experimental group mode: thumbs per stop, participants only) ----
// deliberately thin — no push, no presence, list-view UI only; may be reshaped later

const voteTally = (itemFilter) => `
  SELECT v.item_id,
         COUNT(*) FILTER (WHERE v.vote = 1)::int  AS up,
         COUNT(*) FILTER (WHERE v.vote = -1)::int AS down,
         COALESCE(MAX(v.vote) FILTER (WHERE v.user_id = $2), 0)::int AS my_vote
  FROM trip_stop_votes v
  JOIN trip_items i ON i.id = v.item_id
  WHERE i.trip_id = $1 ${itemFilter}
  GROUP BY v.item_id`;

router.get('/api/trips/code/:code/votes', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const { rows } = await pool.query(voteTally(''), [trip.id, req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// vote: 1 = בעד, -1 = נגד, 0 = הסרת ההצבעה; returns the stop's fresh tally
router.put('/api/trips/code/:code/items/:itemId/vote', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const vote = parseInt((req.body || {}).vote, 10);
    if (![-1, 0, 1].includes(vote)) return res.status(400).json({ error: 'הצבעה לא תקינה' });
    const itemId = parseInt(req.params.itemId, 10);
    const item = await pool.query('SELECT 1 FROM trip_items WHERE id = $1 AND trip_id = $2', [itemId, trip.id]);
    if (!item.rowCount) return res.status(404).json({ error: 'התחנה לא נמצאה' });
    if (vote === 0) {
      await pool.query('DELETE FROM trip_stop_votes WHERE item_id = $1 AND user_id = $2', [itemId, req.user.id]);
    } else {
      await pool.query(
        `INSERT INTO trip_stop_votes (item_id, user_id, vote) VALUES ($1, $2, $3)
         ON CONFLICT (item_id, user_id) DO UPDATE SET vote = $3`,
        [itemId, req.user.id, vote]
      );
    }
    const { rows } = await pool.query(voteTally('AND v.item_id = $3'), [trip.id, req.user.id, itemId]);
    res.json(rows[0] || { item_id: itemId, up: 0, down: 0, my_vote: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- shared budget (one row per trip) ----

const BUDGET_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'JPY', 'THB', 'CHF'];
const EXPENSE_CATEGORIES = ['לינה', 'אוכל', 'נסיעות', 'אטרקציות', 'קניות', 'אחר'];

router.put('/api/trips/code/:code/budget', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const total = Number.isFinite(+b.total) && +b.total > 0 ? Math.min(+b.total, 999999999) : null;
    const currency = BUDGET_CURRENCIES.includes(b.currency) ? b.currency : 'ILS';
    const travelers = Math.min(Math.max(parseInt(b.travelers, 10) || 1, 1), 50);
    const { rows } = await pool.query(
      `INSERT INTO trip_budgets (trip_id, total, currency, travelers)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (trip_id) DO UPDATE SET total = $2, currency = $3, travelers = $4, updated_at = now()
       RETURNING total, currency, travelers`,
      [trip.id, total, currency, travelers]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// resetting the budget removes only the frame (cap, currency, travelers) —
// stop estimates and the expense log belong to the itinerary and stay put
router.delete('/api/trips/code/:code/budget', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_budgets WHERE trip_id = $1', [trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- hotels: night N = sleeping between day N and N+1 ----

function cleanHotel(body, trip) {
  const maxNight = Math.max(trip.days - 1, 1);
  const clampNight = (v, dflt) => Math.min(Math.max(parseInt(v, 10) || dflt, 1), maxNight);
  const start = clampNight(body.night_start, 1);
  const end = Math.max(clampNight(body.night_end, start), start);
  const link = body.link && /^https?:\/\//i.test(String(body.link).trim())
    ? String(body.link).trim().slice(0, 400) : null;
  const stars = numOrNull(body.stars);
  return {
    name: String(body.name || '').slice(0, 160).trim(),
    night_start: start,
    night_end: end,
    status: body.status === 'idea' ? 'idea' : 'booked',
    stars: stars != null && stars >= 1 ? Math.min(Math.round(stars), 5) : null,
    lat: numOrNull(body.lat),
    lon: numOrNull(body.lon),
    price_total: moneyOrNull(body.price_total, 999999999),
    link,
    note: body.note ? String(body.note).slice(0, 300) : null,
  };
}

router.post('/api/trips/code/:code/hotels', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const h = cleanHotel(req.body || {}, trip);
    if (!h.name) return res.status(400).json({ error: 'חסר שם למלון' });
    const { rows } = await pool.query(
      `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, lat, lon, price_total, link, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [trip.id, h.name, h.night_start, h.night_end, h.status, h.stars, h.lat, h.lon, h.price_total, h.link, h.note]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.put('/api/trips/code/:code/hotels/:hotelId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const h = cleanHotel(req.body || {}, trip);
    if (!h.name) return res.status(400).json({ error: 'חסר שם למלון' });
    const { rows } = await pool.query(
      `UPDATE trip_hotels SET name=$1, night_start=$2, night_end=$3, status=$4, stars=$5,
         lat=$6, lon=$7, price_total=$8, link=$9, note=$10
       WHERE id = $11 AND trip_id = $12 RETURNING *`,
      [h.name, h.night_start, h.night_end, h.status, h.stars, h.lat, h.lon, h.price_total, h.link, h.note,
       req.params.hotelId, trip.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'המלון לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.delete('/api/trips/code/:code/hotels/:hotelId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_hotels WHERE id = $1 AND trip_id = $2', [req.params.hotelId, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- expense log (actual spending, quick-add) ----

router.post('/api/trips/code/:code/expenses', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const title = String(b.title || '').slice(0, 160).trim();
    const amount = Number.isFinite(+b.amount) ? Math.min(+b.amount, 999999999) : NaN;
    if (!title) return res.status(400).json({ error: 'על מה הוצאתם? חסר תיאור' });
    if (!(amount > 0)) return res.status(400).json({ error: 'חסר סכום תקין' });
    const day = parseInt(b.day_number, 10);
    const { rows } = await pool.query(
      `INSERT INTO trip_expenses (trip_id, title, amount, category, day_number, paid_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, amount, category, day_number, paid_by, created_at`,
      [trip.id, title, amount,
       EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'אחר',
       day >= 1 && day <= trip.days ? day : null,
       req.user.name || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.delete('/api/trips/code/:code/expenses/:expenseId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_expenses WHERE id = $1 AND trip_id = $2', [req.params.expenseId, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- clone a trip into my account ----

router.post('/api/trips/code/:code/clone', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await pool.query(`SELECT * FROM trips WHERE share_code = $1`, [req.params.code]);
    const src = rows[0];
    if (!src) return res.status(404).json({ error: 'הטיול לא נמצא' });
    await client.query('BEGIN');
    const code = await uniqueShareCode(client);
    const t = await client.query(
      `INSERT INTO trips (owner_id, title, destination, country, description, cover_image, start_date, end_date, days, share_code, emoji, destinations, invite_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${tripFields}`,
      [req.user.id, src.title, src.destination, src.country, src.description, src.cover_image,
       src.start_date, src.end_date, src.days, code, src.emoji, JSON.stringify(src.destinations || []), newInviteToken()]
    );
    await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order)
       SELECT $1, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order
       FROM trip_items WHERE trip_id = $2`,
      [t.rows[0].id, src.id]
    );
    // the plan travels with the trip: budget frame + hotels; the expense log (actuals) doesn't
    await client.query(
      `INSERT INTO trip_budgets (trip_id, total, currency, travelers)
       SELECT $1, total, currency, travelers FROM trip_budgets WHERE trip_id = $2`,
      [t.rows[0].id, src.id]
    );
    await client.query(
      `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, lat, lon, price_total, link, note)
       SELECT $1, name, night_start, night_end, status, stars, lat, lon, price_total, link, note
       FROM trip_hotels WHERE trip_id = $2`,
      [t.rows[0].id, src.id]
    );
    await client.query('COMMIT');
    res.json(t.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

// ---- likes + publish ----

router.post('/api/trips/:id/like', async (req, res) => {
  try {
    const delta = req.body && req.body.undo ? -1 : 1;
    // likes are a gallery feature — unpublished trips don't show the button and can't be liked
    const { rows } = await pool.query(
      'UPDATE trips SET likes = GREATEST(likes + $2, 0) WHERE id = $1 AND is_public RETURNING likes',
      [req.params.id, delta]
    );
    if (!rows[0]) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.patch('/api/trips/:id', authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const admin = await isAdmin(req);
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    // publishing moved to the participants screen — any participant may toggle it.
    // NOT is_draft: a trip still in planning can never enter the public gallery
    if (b.is_public !== undefined) add('is_public', !!b.is_public);
    // description is writable too (the AI-edit undo restores the pre-edit text
    // through here) — same length cap the AI writer keeps
    if (b.description !== undefined) {
      add('description', b.description == null ? null : String(b.description).slice(0, 500).trim() || null);
    }
    if (!sets.length) return res.status(400).json({ error: 'אין מה לעדכן' });
    vals.push(req.params.id, req.user.id, admin);
    const idP = vals.length - 2, userP = vals.length - 1, adminP = vals.length;
    // old.is_public rides along so the proofread below fires only on the actual
    // unpublished→published transition, not on every repeat of the same PATCH
    const { rows } = await pool.query(
      `UPDATE trips t SET ${sets.join(', ')}
       FROM (SELECT is_public AS was_public FROM trips WHERE id = $${idP}) old
       WHERE t.id = $${idP} ${b.is_public !== undefined ? 'AND NOT t.is_draft' : ''}
         AND ($${adminP} OR t.owner_id = $${userP}
           OR EXISTS (SELECT 1 FROM trip_participants p WHERE p.trip_id = $${idP} AND p.user_id = $${userP}))
       RETURNING ${tripFields}, old.was_public`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'הטיול לא נמצא' });
    const { was_public, ...tripOut } = rows[0];
    res.json(tripOut);
    // gallery gate: a trip ENTERING the public gallery gets one cheap, fail-open
    // copy-edit pass (AI descriptions occasionally leak foreign words) — after the
    // response, never blocking or failing the toggle itself
    if (b.is_public && tripOut.is_public && !was_public) {
      try { require('./ai').proofreadPublicTripCopy(tripOut, req.user.id); } catch { /* proofread is optional */ }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.get('/api/my-trips', authRequired, async (req, res) => {
  try {
    // trips I own plus trips I joined as a participant (is_mine tells them apart)
    const { rows } = await pool.query(
      `SELECT ${tripFields}, (owner_id = $1) AS is_mine FROM trips
       WHERE owner_id = $1 OR id IN (SELECT trip_id FROM trip_participants WHERE user_id = $1)
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.post('/api/trips', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, destination, country, description, cover_image, start_date, end_date, days, emoji, items, destinations, draft } = req.body || {};
    const dests = cleanDestinations(destinations);
    // destination display text: explicit field, or derived from the destinations list
    const destText = (destination || dests.map((d) => d.name).join(' · ')).trim();
    if (!title || !destText) return res.status(400).json({ error: 'נא למלא שם טיול ויעד' });
    const countryText = country || [...new Set(dests.map((d) => d.country).filter(Boolean))].join(', ') || null;
    await client.query('BEGIN');
    const code = await uniqueShareCode(client);
    const nDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 60);
    const { rows } = await client.query(
      `INSERT INTO trips (owner_id, title, destination, country, description, cover_image, start_date, end_date, days, share_code, emoji, destinations, invite_token, is_draft)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${tripFields}, invite_token`,
      [req.user.id, title.trim(), destText.slice(0, 160), countryText, description || null,
       cover_image || null, start_date || null, end_date || null, nDays, code, emoji || null,
       JSON.stringify(dests), newInviteToken(), !!draft]
    );
    const trip = rows[0];
    // one multi-row insert — an AI-built trip arrives with a hundred-plus stops,
    // and a round trip per stop is what made creation feel slow
    const rowsToInsert = (Array.isArray(items) ? items : [])
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it && it.title);
    if (rowsToInsert.length) {
      const vals = [];
      const tuples = rowsToInsert.map(({ it, i }) => {
        vals.push(
          trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), nDays),
          it.time_label || null, String(it.title).slice(0, 200), it.note || null,
          it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
          numOrNull(it.lat), numOrNull(it.lon), moneyOrNull(it.cost), i
        );
        const base = vals.length - 12;
        return `(${Array.from({ length: 12 }, (_, k) => '$' + (base + k + 1)).join(',')})`;
      });
      await client.query(
        `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, cost, sort_order)
         VALUES ${tuples.join(',')}`,
        vals
      );
    }
    await client.query('COMMIT');
    res.json(trip);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

router.delete('/api/trips/:id', authRequired, async (req, res) => {
  try {
    const admin = await isAdmin(req);
    const { rowCount } = await pool.query(
      'DELETE FROM trips WHERE id = $1 AND ($3 OR owner_id = $2)',
      [req.params.id, req.user.id, admin]
    );
    if (!rowCount) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
