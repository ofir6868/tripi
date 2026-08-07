// Load .env for local development (no dotenv dependency needed)
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach((line) => {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
} catch { /* no .env — fine in production */ }

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tripi-dev-secret-change-me';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

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

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'ההתחברות פגה, נא להתחבר מחדש' });
  }
}

function authOptional(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ }
  }
  next();
}

const tripFields = `id, owner_id, title, destination, country, description, cover_image,
  start_date, end_date, days, share_code, is_public, emoji, destinations, likes, created_at`;

// resolve a trip by share code and check edit rights: owner JWT or x-edit-code header
async function tripWithEditAuth(req, res) {
  const { rows } = await pool.query(
    `SELECT ${tripFields}, edit_code FROM trips WHERE share_code = $1`, [req.params.code]
  );
  const trip = rows[0];
  if (!trip) { res.status(404).json({ error: 'הטיול לא נמצא' }); return null; }
  const isOwner = req.user && req.user.id === trip.owner_id;
  const editCode = req.headers['x-edit-code'];
  if (!isOwner && (!editCode || editCode !== trip.edit_code)) {
    res.status(403).json({ error: 'אין הרשאת עריכה לטיול הזה' });
    return null;
  }
  return trip;
}

// sanitize a client-supplied destinations array → [{name, country, lat, lon}]
function cleanDestinations(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map((d) => ({
    name: String(d?.name || '').slice(0, 80).trim(),
    country: d?.country ? String(d.country).slice(0, 60).trim() : null,
    lat: Number.isFinite(+d?.lat) ? +d.lat : null,
    lon: Number.isFinite(+d?.lon) ? +d.lon : null,
  })).filter((d) => d.name);
}

// ---------- auth ----------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'נא למלא את כל השדות' });
    if (password.length < 6) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, lower($2), $3) RETURNING id, name, email',
      [name.trim(), email.trim(), hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'נא למלא אימייל וסיסמה' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = lower($1)', [email.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }
    const token = jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- trips ----------

app.get('/api/trips/suggested', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips WHERE is_public = true ORDER BY likes DESC, id LIMIT 16`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/trips/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    if (/^\d{6}$/.test(q)) {
      const { rows } = await pool.query(`SELECT ${tripFields} FROM trips WHERE share_code = $1`, [q]);
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips
       WHERE is_public = true AND (title ILIKE $1 OR destination ILIKE $1 OR country ILIKE $1)
       ORDER BY id LIMIT 12`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/trips/code/:code', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${tripFields}, edit_code FROM trips WHERE share_code = $1`, [req.params.code]
    );
    if (!rows[0]) return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    const trip = rows[0];
    const isOwner = !!(req.user && req.user.id === trip.owner_id);
    if (!isOwner) delete trip.edit_code; // edit code is only revealed to the owner
    const items = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id',
      [trip.id]
    );
    res.json({ trip, items: items.rows, isOwner });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- collaborative editing (owner or x-edit-code header) ----

app.post('/api/trips/code/:code/items', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const it = req.body || {};
    if (!it.title || !String(it.title).trim()) return res.status(400).json({ error: 'חסרה כותרת לתחנה' });
    const { rows } = await pool.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))
       RETURNING *`,
      [trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), trip.days),
       it.time_label || null, String(it.title).slice(0, 200).trim(), it.note || null,
       it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
       Number.isFinite(+it.lat) ? +it.lat : null, Number.isFinite(+it.lon) ? +it.lon : null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.delete('/api/trips/code/:code/items/:itemId', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await pool.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [req.params.itemId, trip.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---- clone a trip into my account ----

app.post('/api/trips/code/:code/clone', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await pool.query(`SELECT * FROM trips WHERE share_code = $1`, [req.params.code]);
    const src = rows[0];
    if (!src) return res.status(404).json({ error: 'הטיול לא נמצא' });
    await client.query('BEGIN');
    const code = await uniqueShareCode(client);
    const editCode = String(Math.floor(100000 + Math.random() * 900000));
    const t = await client.query(
      `INSERT INTO trips (owner_id, title, destination, country, description, cover_image, start_date, end_date, days, share_code, emoji, destinations, edit_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${tripFields}`,
      [req.user.id, src.title, src.destination, src.country, src.description, src.cover_image,
       src.start_date, src.end_date, src.days, code, src.emoji, JSON.stringify(src.destinations || []), editCode]
    );
    await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, sort_order)
       SELECT $1, day_number, time_label, title, note, place_query, category, sort_order
       FROM trip_items WHERE trip_id = $2`,
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

app.post('/api/trips/:id/like', async (req, res) => {
  try {
    const delta = req.body && req.body.undo ? -1 : 1;
    const { rows } = await pool.query(
      'UPDATE trips SET likes = GREATEST(likes + $2, 0) WHERE id = $1 RETURNING likes',
      [req.params.id, delta]
    );
    if (!rows[0]) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.patch('/api/trips/:id', authRequired, async (req, res) => {
  try {
    const { is_public } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE trips SET is_public = $1 WHERE id = $2 AND owner_id = $3 RETURNING ${tripFields}`,
      [!!is_public, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/my-trips', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${tripFields} FROM trips WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/trips', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, destination, country, description, cover_image, start_date, end_date, days, emoji, items, destinations } = req.body || {};
    const dests = cleanDestinations(destinations);
    // destination display text: explicit field, or derived from the destinations list
    const destText = (destination || dests.map((d) => d.name).join(' · ')).trim();
    if (!title || !destText) return res.status(400).json({ error: 'נא למלא שם טיול ויעד' });
    const countryText = country || [...new Set(dests.map((d) => d.country).filter(Boolean))].join(', ') || null;
    await client.query('BEGIN');
    const code = await uniqueShareCode(client);
    const editCode = String(Math.floor(100000 + Math.random() * 900000));
    const nDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 60);
    const { rows } = await client.query(
      `INSERT INTO trips (owner_id, title, destination, country, description, cover_image, start_date, end_date, days, share_code, emoji, destinations, edit_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${tripFields}, edit_code`,
      [req.user.id, title.trim(), destText.slice(0, 160), countryText, description || null,
       cover_image || null, start_date || null, end_date || null, nDays, code, emoji || null,
       JSON.stringify(dests), editCode]
    );
    const trip = rows[0];
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || !it.title) continue;
        await client.query(
          `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [trip.id, Math.min(Math.max(parseInt(it.day_number, 10) || 1, 1), nDays),
           it.time_label || null, String(it.title).slice(0, 200), it.note || null,
           it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
           Number.isFinite(+it.lat) ? +it.lat : null, Number.isFinite(+it.lon) ? +it.lon : null, i]
        );
      }
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

app.delete('/api/trips/:id', authRequired, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM trips WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'הטיול לא נמצא' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ---------- AI itinerary builder (OpenAI, server-side — the key never reaches the client) ----------

const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_CATEGORIES = ['אטרקציה', 'אוכל', 'טבע', 'ים', 'תרבות', 'קניות', 'לינה', 'נוף', 'חיי לילה', 'תחבורה', 'היסטוריה', 'אמנות', 'עיר'];
const aiUsage = new Map(); // userId → {date, count}
const AI_DAILY_LIMIT = 20;

// nearest-neighbor ordering by coordinates, starting from the first destination —
// keeps multi-city trips geographically sequential (Tokyo → Kyoto → Osaka, not zigzag)
function orderByProximity(dests) {
  if (dests.length < 3 || dests.some((d) => d.lat == null || d.lon == null)) return dests;
  const rest = dests.slice(1);
  const ordered = [dests[0]];
  while (rest.length) {
    const cur = ordered[ordered.length - 1];
    let best = 0, bestDist = Infinity;
    rest.forEach((d, i) => {
      const dist = (d.lat - cur.lat) ** 2 + (d.lon - cur.lon) ** 2;
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    ordered.push(rest.splice(best, 1)[0]);
  }
  return ordered;
}

// contiguous day blocks per area, e.g. 22 days / 3 areas → 8+7+7 (fallback only)
function allocateDays(orderedDests, from, to) {
  const total = to - from + 1;
  const base = Math.floor(total / orderedDests.length);
  let extra = total % orderedDests.length;
  let cur = from;
  return orderedDests.map((d) => {
    const len = base + (extra-- > 0 ? 1 : 0);
    const block = { dest: d, from: cur, to: cur + len - 1 };
    cur += len;
    return block;
  }).filter((b) => b.to >= b.from);
}

// stage 1: the AI itself decides city order and how many days each deserves —
// a small, cheap call whose output is easy to validate structurally
async function aiPlanBlocks({ dests, from, to, interestList, freeText }) {
  const areaNames = dests.map((d) => d.name);
  const destDesc = dests.map((d) => d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name).join(', ');
  let userMsg =
    `טיול לימים ${from} עד ${to} (כולל, סה"כ ${to - from + 1} ימים) שמכסה את האזורים: ${destDesc}. ` +
    `חלק את הימים בין האזורים: קבע סדר ביקור גיאוגרפי הגיוני, והקצה לכל אזור כמות ימים לפי כמה שיש בו לראות ולעשות עבור המטיילים האלה — לא בהכרח שווה בשווה. ` +
    `כל אזור מופיע פעם אחת בדיוק, הבלוקים רצופים ומכסים את כל טווח הימים בלי חורים ובלי חפיפות.`;
  if (interestList.length) userMsg += `\nתחומי העניין שלהם: ${interestList.join(', ')}.`;
  if (freeText) userMsg += `\nהעדפות נוספות: "${freeText}"`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 600,
        messages: [
          { role: 'system', content: 'אתה מתכנן טיולים מומחה. אתה מחזיר אך ורק JSON תקין לפי הסכמה.' },
          { role: 'user', content: userMsg },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'day_allocation',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['blocks'],
              properties: {
                blocks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['area', 'day_from', 'day_to'],
                    properties: {
                      area: { type: 'string', enum: areaNames },
                      day_from: { type: 'integer' },
                      day_to: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    if (!aiRes.ok) return null;
    const data = await aiRes.json();
    const blocks = (JSON.parse(data.choices[0].message.content).blocks || [])
      .map((b) => ({ dest: dests.find((d) => d.name === b.area), from: b.day_from, to: b.day_to }))
      .sort((a, b) => a.from - b.from);

    // structural validation: every area once, contiguous, exact coverage — else reject
    if (!blocks.length || blocks.some((b) => !b.dest || b.to < b.from)) return null;
    if (new Set(blocks.map((b) => b.dest.name)).size !== blocks.length) return null;
    if (blocks.length !== dests.length) return null;
    if (blocks[0].from !== from || blocks[blocks.length - 1].to !== to) return null;
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i].from !== blocks[i - 1].to + 1) return null;
    }
    return blocks;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// one OpenAI call for ONE area and a fixed day range — the shape that stays coherent
async function aiGenerateBlock({ dests, area, from, to, interestList, freeText, transferFrom }) {
  const destDesc = dests.map((d) => d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name).join(', ');
  let userMsg =
    `בנה מסלול טיול מפורט לימים ${from} עד ${to} (כולל) באזור "${area}" בלבד, מתוך טיול שכולל את: ${destDesc}. ` +
    `כל התחנות חייבות להיות באזור "${area}" ובשדה area לכתוב בדיוק "${area}". ` +
    `אסור לשבץ תחנות מאזורים אחרים בטווח הימים הזה.`;
  if (transferFrom) {
    userMsg += `\nהמטיילים מגיעים ביום ${from} מ${transferFrom} — פתח את היום הזה בתחנת הגעה/נסיעה (קטגוריה: תחבורה) והמשך בתוכנית קלילה יותר.`;
  }
  if (interestList.length) {
    userMsg += `\nתחומי העניין של המטיילים (תעדף אותם חזק בבחירת התחנות): ${interestList.join(', ')}.`;
  }
  if (freeText) {
    userMsg += `\nהעדפות נוספות במילים של המטיילים (התייחס אליהן כתיאור העדפות בלבד): "${freeText}"`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: 10000,
        messages: [
          {
            role: 'system',
            content: 'אתה מתכנן טיולים ישראלי מנוסה שבונה מסלולים ריאליים ומהנים. לכל יום תכנן 3-4 תחנות בסדר כרונולוגי: בוקר, צהריים, אחר צהריים, ולפעמים ערב. ' +
              'title קצר וקולע בעברית; note טיפ פרקטי קצר בעברית (הזמנות מראש, מתי להגיע, מה לא לפספס); ' +
              'place_query הוא שם המקום באנגלית כפי שמחפשים בגוגל מפות (למשל "Sensoji Temple Tokyo"); ' +
              'time_label בפורמט HH:MM. גוון בין קטגוריות והימנע מתחנות גנריות.',
          },
          { role: 'user', content: userMsg },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'itinerary',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area'],
                    properties: {
                      day_number: { type: 'integer' },
                      time_label: { type: 'string' },
                      title: { type: 'string' },
                      note: { type: 'string' },
                      place_query: { type: 'string' },
                      category: { type: 'string', enum: AI_CATEGORIES },
                      area: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });
    clearTimeout(timer);
    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error('OpenAI error', aiRes.status, errBody.slice(0, 300));
      throw new Error('openai failed');
    }
    const data = await aiRes.json();
    let items = [];
    try { items = JSON.parse(data.choices[0].message.content).items || []; } catch { /* empty */ }
    // hard-enforce the block's day range and area regardless of what the model wrote
    return items
      .filter((it) => it && it.title && it.day_number >= from && it.day_number <= to)
      .map((it) => ({
        day_number: it.day_number,
        time_label: /^\d{1,2}:\d{2}$/.test(it.time_label || '') ? it.time_label : null,
        title: String(it.title).slice(0, 200),
        note: it.note ? String(it.note).slice(0, 300) : null,
        place_query: it.place_query ? String(it.place_query).slice(0, 120) : null,
        category: AI_CATEGORIES.includes(it.category) ? it.category : 'אטרקציה',
        area,
      }));
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/ai/itinerary', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'בניית AI לא זמינה כרגע' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = aiUsage.get(req.user.id);
    const used = usage && usage.date === today ? usage.count : 0;
    if (used >= AI_DAILY_LIMIT) return res.status(429).json({ error: 'הגעתם למכסת בניות ה-AI היומית — נסו שוב מחר' });

    const { destinations, area, day_from, day_to, interests, notes } = req.body || {};
    const interestList = (Array.isArray(interests) ? interests : [])
      .slice(0, 15).map((s) => String(s).slice(0, 40).trim()).filter(Boolean);
    const freeText = notes ? String(notes).slice(0, 500).trim() : '';
    const dests = cleanDestinations(destinations);
    if (!dests.length) return res.status(400).json({ error: 'חסרים יעדים' });
    const from = Math.min(Math.max(parseInt(day_from, 10) || 1, 1), 60);
    const to = Math.min(Math.max(parseInt(day_to, 10) || from, from), 60);
    if (to - from + 1 > 30) return res.status(400).json({ error: 'אפשר לבנות עד 30 ימים בבקשה אחת' });
    const areaNames = dests.map((d) => d.name);
    if (area && !areaNames.includes(area)) return res.status(400).json({ error: 'אזור לא מוכר' });

    // build the per-area blocks: a single requested area, or an AI-decided
    // allocation (order + days per city). The AI plans; the server only verifies
    // that the blocks are contiguous — falling back to an even split if invalid.
    let blocks;
    if (area) {
      blocks = [{ dest: dests.find((d) => d.name === area), from, to }];
    } else if (dests.length === 1) {
      blocks = [{ dest: dests[0], from, to }];
    } else {
      blocks = await aiPlanBlocks({ dests, from, to, interestList, freeText })
        || allocateDays(orderByProximity(dests), from, to);
    }

    const results = await Promise.all(blocks.map((b, i) =>
      aiGenerateBlock({
        dests,
        area: b.dest.name,
        from: b.from,
        to: b.to,
        interestList,
        freeText,
        transferFrom: i > 0 ? blocks[i - 1].dest.name : null,
      })
    ));
    const items = results.flat()
      .sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')))
      .slice(0, 200);
    if (!items.length) return res.status(502).json({ error: 'ה-AI החזיר מסלול ריק — נסו שוב' });

    aiUsage.set(req.user.id, { date: today, count: used + 1 });
    res.json({ items, plan: blocks.map((b) => ({ area: b.dest.name, from: b.from, to: b.to })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'ה-AI התעכב יותר מדי — נסו שוב' : 'ה-AI לא הצליח לבנות את המסלול — נסו שוב עוד רגע' });
  }
});

// ---------- hotels (OSM Overpass, server-side with cache) ----------

const hotelsCache = new Map(); // "lat,lon" → {at, data}
const HOTELS_TTL = 24 * 60 * 60 * 1000;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

app.get('/api/hotels', async (req, res) => {
  const lat = Math.round(parseFloat(req.query.lat) * 100) / 100;
  const lon = Math.round(parseFloat(req.query.lon) * 100) / 100;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'bad coords' });

  const key = `${lat},${lon}`;
  const cached = hotelsCache.get(key);
  if (cached && Date.now() - cached.at < HOTELS_TTL) return res.json(cached.data);

  // node-only: way/relation geometry resolution regularly 504s on the public servers
  const query = `[out:json][timeout:25];node["tourism"="hotel"]["name"](around:7000,${lat},${lon});out 30;`;
  let elements = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 28000); // public Overpass servers regularly need 15-20s
      const r = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'TRIPI trip planner/1.0 (github.com/ofir6868/tripi)',
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) continue;
      elements = (await r.json()).elements || [];
      break;
    } catch { /* try next mirror */ }
  }
  if (elements === null) return res.json([]); // all mirrors down — client shows Booking fallback

  const seen = new Set();
  const hotels = elements
    .map((el) => ({
      name: el.tags?.['name:he'] || el.tags?.name,
      stars: el.tags?.stars || null,
      lat: el.lat ?? el.center?.lat,
      lon: el.lon ?? el.center?.lon,
    }))
    .filter((h) => h.name && !seen.has(h.name) && seen.add(h.name))
    .slice(0, 8);
  hotelsCache.set(key, { at: Date.now(), data: hotels });
  res.json(hotels);
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// pretty routes — /trip/:code gets Open Graph tags injected so WhatsApp/social previews
// show the trip cover, title and code
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
let tripHtmlCache = null;
app.get('/trip/:code', async (req, res) => {
  if (!tripHtmlCache) {
    tripHtmlCache = require('fs').readFileSync(path.join(__dirname, 'public', 'trip.html'), 'utf8');
  }
  let html = tripHtmlCache;
  try {
    const { rows } = await pool.query(
      'SELECT title, destination, description, cover_image, days, share_code, emoji FROM trips WHERE share_code = $1',
      [req.params.code]
    );
    const t = rows[0];
    if (t) {
      const title = `${t.emoji || '🧭'} ${t.title} · TRIPI`;
      const desc = `${t.destination} · ${t.days} ימים · קוד טיול ${t.share_code}` +
        (t.description ? ` — ${t.description.slice(0, 120)}` : '');
      const og = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TRIPI">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  ${t.cover_image ? `<meta property="og:image" content="${escapeHtml(t.cover_image)}">` : ''}
  <meta property="og:url" content="https://tripi-caw3.onrender.com/trip/${escapeHtml(t.share_code)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="description" content="${escapeHtml(desc)}">`;
      html = html
        .replace('<title>טיול · TRIPI</title>', `<title>${escapeHtml(title)}</title>${og}`);
    }
  } catch { /* serve the plain page on any error */ }
  res.type('html').send(html);
});
app.get('/plan', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'plan.html')));
app.get('/my', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'my.html')));

app.listen(PORT, () => console.log(`TRIPI running on http://localhost:${PORT}`));
