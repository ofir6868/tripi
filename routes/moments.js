// The moments of a trip (lib/moments.js): listed, written, edited — and found.
//
//   GET    /api/trips/code/:code/moments            the list, and the trip's clock (tz)
//   POST   /api/trips/code/:code/moments            write one or several (approved proposals included)
//   PATCH  /api/trips/code/:code/moments/:id        edit by hand; status 'active' is how a proposal is approved
//   DELETE /api/trips/code/:code/moments/:id
//   POST   /api/trips/code/:code/moments/:id/preview  the push, now, to the asker alone — "show me what arrives"
//   POST   /api/trips/code/:code/moments/extract    a document's text (read on the device) → proposed moments
//   POST   /api/trips/code/:code/moments/scan       the traveller's Gmail → proposed moments, with attachments listed
//   GET    /api/connectors/gmail/attachment          one attachment's bytes, streamed to the device that asked
//
// Two things never happen here. Nothing is written without a person: extract and scan
// answer PROPOSALS and the client posts back the ones that were ticked. And no document
// is kept: the attachment route hands the bytes through to the phone, where
// public/js/trip-docs.js files them in IndexedDB beside the documents added by hand, and
// the moment remembers only their names. Participants only (tripWithEditAuth) — a moment
// carries booking codes, and a share-code visitor has no business with those.
const express = require('express');
const { pool } = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { tripWithEditAuth } = require('../lib/trips');
const moments = require('../lib/moments');
const connectors = require('../lib/connectors');
const push = require('../lib/push');
const { dailyQuota, exhausted } = require('../lib/quota');
const analytics = require('../lib/posthog');

const router = express.Router();

// one meter for both ways of asking the model to read a booking — ten a day is a trip's
// worth of confirmations, and a scan reads up to a dozen mails in one call
const momentsMeter = dailyQuota('moments', 10);
const MAX_PER_POST = 20;
const SCAN_MESSAGES = 12;     // mails one scan reads in full
const SCAN_TEXT_CHARS = 2200; // of each
const EXTRACT_CHARS = 6000;

const tripOf = (row) => ({ ...row, days: Math.max(+row.days || 1, 1) });

async function withTx(res, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- the list ----------

router.get('/api/trips/code/:code/moments', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const [rows, tz] = await Promise.all([moments.listForTrip(pool, trip.id), moments.tzForTrip(trip)]);
    res.json({ moments: rows, tz, kinds: moments.KINDS });
  } catch (err) {
    console.error('moments list failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- writing ----------

router.post('/api/trips/code/:code/moments', authRequired, async (req, res) => {
  try {
    const trip = tripOf(await tripWithEditAuth(req, res) || {});
    if (!trip.id) return;
    const b = req.body || {};
    const raws = (Array.isArray(b.moments) ? b.moments : [b]).slice(0, MAX_PER_POST);
    if (!raws.length) return res.status(400).json({ error: 'אין תזכורות לשמור' });
    const tz = await moments.tzForTrip(trip);
    const cleaned = raws.map((r) => moments.cleanMoment(r, trip, { tz }));
    const bad = cleaned.find((c) => c.error);
    if (bad && cleaned.length === 1) return res.status(400).json({ error: bad.error });
    const good = cleaned.filter((c) => !c.error);
    if (!good.length) return res.status(400).json({ error: bad ? bad.error : 'אין תזכורות תקינות לשמור' });
    const rows = await withTx(res, async (client) => {
      const out = [];
      for (const m of good) out.push((await moments.createMoment(client, trip, m, req.user.id)).row);
      return out;
    });
    analytics.capture('moments_added', 'user_' + req.user.id, { code: trip.share_code, count: rows.length, kinds: rows.map((r) => r.kind), sources: rows.map((r) => (r.source || {}).type || 'manual') });
    res.json({ moments: rows, skipped: cleaned.filter((c) => c.error).map((c) => c.error) });
  } catch (err) {
    console.error('moments create failed', err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.patch('/api/trips/code/:code/moments/:id', authRequired, async (req, res) => {
  try {
    const trip = tripOf(await tripWithEditAuth(req, res) || {});
    if (!trip.id) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'מזהה לא תקין' });
    const r = await withTx(res, (client) => moments.updateMoment(client, trip, id, req.body || {}));
    if (!r) return res.status(404).json({ error: 'התזכורת לא נמצאה' });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r.row);
  } catch (err) {
    console.error('moments update failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

router.delete('/api/trips/code/:code/moments/:id', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_moments WHERE id = $1 AND trip_id = $2', [req.params.id, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('moments delete failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the push as it will arrive, sent right now to the person asking (their devices only).
// The one way to see that the tap really opens the ticket, before the morning it matters.
router.post('/api/trips/code/:code/moments/:id/preview', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    if (!push.enabled) return res.status(503).json({ error: 'התראות לא מופעלות בשרת הזה' });
    const { rows } = await pool.query('SELECT * FROM trip_moments WHERE id = $1 AND trip_id = $2', [req.params.id, trip.id]);
    const m = rows[0];
    if (!m) return res.status(404).json({ error: 'התזכורת לא נמצאה' });
    const minutesLeft = (new Date(m.starts_at).getTime() - Date.now()) / 60000;
    const copy = moments.pushCopy(m, Math.max(minutesLeft, 0));
    const sent = await push.sendToUsers([req.user.id], {
      kind: 'moment', ...copy,
      url: `/trip/${trip.share_code}#moment-${m.id}`,
      tag: `moment-${m.id}`,
      countries: push.tripCountries(trip),
      docs: (m.docs || []).length,
    });
    res.json({ sent });
  } catch (err) {
    console.error('moments preview failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- finding moments in text and in mail ----------

const str = (d) => ({ type: ['string', 'null'], description: d });
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['moments'],
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'local_time', 'tz', 'lead_minutes', 'details', 'hotel', 'message_index'],
        properties: {
          kind: { type: 'string', enum: moments.KIND_KEYS },
          title: { type: 'string' },
          local_time: str('YYYY-MM-DDTHH:MM, השעה המקומית במקום האירוע'),
          tz: str('אזור הזמן IANA של מקום האירוע, למשל Asia/Tokyo'),
          lead_minutes: { type: ['integer', 'null'] },
          details: {
            type: 'object', additionalProperties: false,
            required: moments.DETAIL_KEYS,
            properties: Object.fromEntries(moments.DETAIL_KEYS.map((k) => [k, { type: ['string', 'null'] }])),
          },
          hotel: {
            type: ['object', 'null'], additionalProperties: false,
            required: ['name', 'night_start', 'night_end', 'price_total', 'note'],
            properties: {
              name: { type: 'string' }, night_start: { type: ['integer', 'null'] }, night_end: { type: ['integer', 'null'] },
              price_total: { type: ['number', 'null'] }, note: { type: ['string', 'null'] },
            },
          },
          message_index: { type: ['integer', 'null'] },
        },
      },
    },
  },
};

const isoDate = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));

function tripBlock(trip, tz) {
  const dests = (Array.isArray(trip.destinations) ? trip.destinations : []).filter((d) => d && d.name).map((d) => d.name + (d.country ? ` (${d.country})` : ''));
  const start = isoDate(trip.start_date);
  return [
    `הטיול: "${trip.title}" — ${dests.join(', ') || trip.destination}${trip.country ? `, ${trip.country}` : ''}.`,
    start ? `תאריכים: ${start} עד ${isoDate(trip.end_date) || start}, ${trip.days} ימים (יום 1 = ${start}).` : `אורך: ${trip.days} ימים; תאריך היציאה עדיין לא נקבע.`,
    tz ? `אזור הזמן של היעד, כשלא כתוב אחרת: ${tz}.` : '',
  ].filter(Boolean).join('\n');
}

const SYSTEM = `אתם קוראים אישורי הזמנה וכרטיסים של מטיילים ישראלים ומחלצים מהם את "הרגעים" — כל דבר שקורה בשעה נתונה ושחייבים להיות בו: טיסה, אוטובוס/רכבת/מעבורת/העברה, צ׳ק-אין וצ׳ק-אאוט במלון, כרטיס עם שעת כניסה, איסוף רכב, ואישור כניסה למדינה (למשל Visit Japan Web, ESTA) — כדי שהאפליקציה תשלח התראה לפני כל אחד עם המסמך הנכון.
כללים:
- kind: flight לכל מקטע טיסה בנפרד (שעת ההמראה המקומית בשדה היוצא; קונקשן הוא רגע נוסף); transport לאוטובוס/רכבת/מעבורת/העברה (שעת היציאה); hotel_checkin ו-hotel_checkout למלון — אם שעת הצ׳ק-אין לא כתובה, 15:00 וב-note "שעת הצ׳ק-אין לא כתובה"; entry לאישור כניסה — בשעת הנחיתה בארץ היעד; activity לכרטיס עם שעה; car לאיסוף רכב; other רק כשיש שעה ואין קטגוריה מתאימה.
- local_time הוא השעה המקומית במקום האירוע, ו-tz הוא אזור הזמן IANA של אותו מקום (המראה מנתב"ג: Asia/Jerusalem; נחיתה בטוקיו: Asia/Tokyo). כשאין שעה בכלל — אל תמציאו; השמיטו את הרגע או השתמשו ב-15:00 רק לצ׳ק-אין כאמור.
- title קצר ובעברית: "אוטובוס מקיוטו לטוקיו", "טיסה אל על LY091 תל אביב ← טוקיו", "מלון Granbell שיבויה".
- details — רק מה שכתוב: code (מספר הזמנה/PNR), number (מספר טיסה/קו), from/to (ערים או קודי שדה), seat, gate, terminal, platform, address, phone, provider (חברה), passenger, price (עם מטבע), link, note. null במה שלא כתוב.
- hotel: רק ל-hotel_checkin, עם name ולילות לפי ימי הטיול (לילה N = הלילה שבין יום N ליום N+1; לפי התאריכים שבאישור מול תאריך היציאה של הטיול). null לכל שאר הסוגים, ו-null כשאין תאריכי טיול.
- lead_minutes: כמה דקות לפני לשלוח התראה — null לברירת המחדל, או מספר כשהמסמך מצדיק אחרת (למשל טיסה בינלאומית: 180).
- message_index: מספר ההודעה/הקובץ שממנו נקרא הרגע (לפי המספור בקלט), או null.
- מסמך שאינו הזמנה (ניוזלטר, פרסומת, קבלה בלי שעה) לא מניב רגעים. אל תמציאו שעה, תאריך, מספר או מקום שלא כתובים.`;

async function extractMoments({ trip, tz, blocks, userId, ph }) {
  const ai = require('./ai');
  const raw = await ai.aiJson({
    system: SYSTEM,
    user: `${tripBlock(trip, tz)}\n\n${blocks.join('\n\n')}`,
    schemaName: 'trip_moments',
    schema: EXTRACT_SCHEMA,
    maxTokens: 2500,
    timeoutMs: 60000,
    ph: ph || { distinctId: 'user_' + userId, traceId: `moments-${trip.id}-${Date.now()}` },
  });
  return raw && Array.isArray(raw.moments) ? raw.moments.slice(0, MAX_PER_POST) : [];
}

// the model's rows → cleaned proposals the client can show and tick, each with the
// reason it was refused when it was (shown greyed, never written)
function proposalsOf(raws, trip, tz, sourceOf) {
  return raws.map((r) => {
    const src = sourceOf ? sourceOf(r) : null;
    const c = moments.cleanMoment({ ...r, status: 'proposed', source: src && src.source }, trip, { tz });
    if (c.error) return { error: c.error, title: String(r && r.title || '').slice(0, 120) };
    return {
      kind: c.kind, title: c.title, local_time: c.local_time, tz: c.tz, starts_at: c.starts_at.toISOString(),
      lead_minutes: c.lead_minutes, details: c.details, hotel: c.hotel, day: c.stop,
      source: c.source, attachments: (src && src.attachments) || [],
    };
  });
}

// a document the device read (public/js/doc-text.js) — the text comes, the file does not
router.post('/api/trips/code/:code/moments/extract', authRequired, async (req, res) => {
  try {
    const trip = tripOf(await tripWithEditAuth(req, res) || {});
    if (!trip.id) return;
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'קריאת מסמכים עם AI לא מוגדרת בשרת הזה' });
    const b = req.body || {};
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, EXTRACT_CHARS);
    const name = String(b.name || 'מסמך').replace(/[\r\n]/g, ' ').slice(0, 120);
    if (text.length < 20) return res.status(400).json({ error: 'לא נמצא טקסט לקריאה במסמך הזה' });
    const q = await momentsMeter.check(req);
    if (!q) return exhausted(res, 'moments', 'מכסת קריאת המסמכים להיום נגמרה — מחר יש חדשה, ואפשר להוסיף תזכורת ידנית');
    const tz = await moments.tzForTrip(trip);
    const raws = await extractMoments({ trip, tz, blocks: [`[קובץ 1: ${name}]\n${text}\n[סוף קובץ 1]`], userId: req.user.id });
    await q.spend();
    const proposals = proposalsOf(raws, trip, tz, () => ({ source: { type: 'doc', name }, attachments: [] }));
    analytics.capture('moments_extract', 'user_' + req.user.id, { code: trip.share_code, found: proposals.filter((p) => !p.error).length });
    res.json({ proposals, remaining: q.remaining });
  } catch (err) {
    console.error('moments extract failed', err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// the Gmail query: confirmations and tickets, in Hebrew and English, from the half year
// before the trip (when it has dates) or the last half year (when it does not)
function gmailQuery(trip) {
  const words = '(booking OR confirmation OR reservation OR "e-ticket" OR eticket OR itinerary OR "boarding pass" OR ticket OR voucher OR הזמנה OR אישור OR כרטיס OR "כרטיסי טיסה")';
  const start = isoDate(trip.start_date);
  const d = start ? new Date(start + 'T00:00:00Z') : new Date();
  d.setUTCDate(d.getUTCDate() - 183);
  const after = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${words} after:${after} -category:promotions -category:social`;
}

router.post('/api/trips/code/:code/moments/scan', authRequired, async (req, res) => {
  try {
    const trip = tripOf(await tripWithEditAuth(req, res) || {});
    if (!trip.id) return;
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'קריאת מסמכים עם AI לא מוגדרת בשרת הזה' });
    const services = await connectors.enabledFor(req.user.id);
    if (!services.includes('gmail')) return res.status(409).json({ error: 'Gmail לא מחובר — אפשר לחבר אותו בחיבורים של הצ׳אט', connect: 'gmail' });
    const q = await momentsMeter.check(req);
    if (!q) return exhausted(res, 'moments', 'מכסת הסריקות להיום נגמרה — מחר יש חדשה');
    const r = await scanGmail({ trip, userId: req.user.id, query: String((req.body || {}).query || '').slice(0, 200) || null });
    if (r.read) await q.spend();
    analytics.capture('moments_scan', 'user_' + req.user.id, { code: trip.share_code, read: r.read, found: r.proposals.filter((p) => !p.error).length });
    res.json({ ...r, remaining: r.read ? q.remaining : q.remaining + 1 });
  } catch (err) {
    const msg = err && err.message === 'permission' ? 'Gmail צריך אישור מחדש — נתקו וחברו שוב בחיבורים'
      : err && err.message === 'not connected' ? 'Gmail לא מחובר' : null;
    if (msg) return res.status(409).json({ error: msg, connect: 'gmail' });
    console.error('moments scan failed', err);
    res.status(500).json({ error: 'הסריקה נכשלה — נסו שוב בעוד רגע' });
  }
});

// the scan itself — also run by lib/reminders.js a week before a trip, for a traveller
// who switched Gmail on, to propose what their mail already knows
async function scanGmail({ trip, userId, query = null, ph = null }) {
  const found = await connectors.gmailSearch(userId, { query: query || gmailQuery(trip), limit: 10 });
  const ids = (found.messages || []).map((m) => m.id).slice(0, SCAN_MESSAGES);
  if (!ids.length) return { read: 0, messages: [], proposals: [] };
  const msgs = (await Promise.all(ids.map((id) => connectors.gmailMessage(userId, { id, maxChars: SCAN_TEXT_CHARS }).catch(() => null)))).filter((m) => m && m.text);
  if (!msgs.length) return { read: 0, messages: [], proposals: [] };
  const tz = await moments.tzForTrip(trip);
  const blocks = msgs.map((m, i) => `[הודעה ${i + 1}] מאת: ${m.from} | נושא: ${m.subject} | תאריך: ${m.date}${m.attachments.length ? ` | קבצים מצורפים: ${m.attachments.map((a) => a.name).join(', ')}` : ''}\n${m.text}\n[סוף הודעה ${i + 1}]`);
  const raws = await extractMoments({ trip, tz, blocks, userId, ph });
  const proposals = proposalsOf(raws, trip, tz, (r) => {
    const m = Number.isInteger(r.message_index) ? msgs[r.message_index - 1] : null;
    return m
      ? { source: { type: 'gmail', id: m.id, subject: m.subject, from: m.from }, attachments: m.attachments }
      : { source: { type: 'scan' }, attachments: [] };
  });
  return {
    read: msgs.length,
    messages: msgs.map((m) => ({ id: m.id, subject: m.subject, from: m.from, date: m.date, attachments: m.attachments })),
    proposals,
  };
}

// an attachment, to the device and nowhere else. The person asking must be the one whose
// mailbox it is (the token is theirs); the type is pinned to what the מסמכים page keeps.
router.get('/api/connectors/gmail/attachment', authRequired, async (req, res) => {
  try {
    const type = /^(image\/(jpeg|png|webp|gif|heic)|application\/pdf)$/.test(String(req.query.type || '')) ? String(req.query.type) : 'application/octet-stream';
    const buf = await connectors.gmailAttachment(req.user.id, { messageId: req.query.message, attachmentId: req.query.id });
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(String(req.query.name || 'attachment').slice(0, 120))}`);
    res.send(buf);
  } catch (err) {
    const code = err && err.message === 'permission' ? 403 : err && err.message === 'not connected' ? 409 : 502;
    console.warn('gmail attachment failed', err && err.message);
    res.status(code).json({ error: 'לא הצלחנו להביא את הקובץ מ-Gmail' });
  }
});

module.exports = router;
module.exports.scanGmail = scanGmail;
module.exports.extractMoments = extractMoments;
module.exports.proposalsOf = proposalsOf;
module.exports.EXTRACT_SCHEMA = EXTRACT_SCHEMA;
module.exports.gmailQuery = gmailQuery;
