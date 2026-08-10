// AI itinerary builder + trip editor (OpenAI, server-side — the key never reaches the client)
const express = require('express');
const { pool } = require('../lib/db');
const { authRequired, authOptional, isAdmin } = require('../lib/auth');
const { tripWithEditAuth, cleanDestinations } = require('../lib/trips');

const router = express.Router();

const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_CATEGORIES = ['אטרקציה', 'אוכל', 'טבע', 'ים', 'תרבות', 'קניות', 'לינה', 'נוף', 'חיי לילה', 'נסיעה', 'היסטוריה', 'אמנות', 'עיר'];
const aiUsage = new Map(); // userId → {date, count}
const AI_DAILY_LIMIT = 20;

// the one OpenAI caller: chat completion forced into a strict JSON schema.
// Returns the parsed object, or null on any failure (HTTP error, timeout, bad
// JSON) — unless `required`, which rethrows so the route can distinguish an
// aborted call (timeout message) from the rest.
async function aiJson({ system, user, schemaName, schema, maxTokens, timeoutMs = 30000, required = false }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error(`OpenAI ${schemaName} error`, aiRes.status, errBody.slice(0, 300));
      if (required) throw new Error('openai failed');
      return null;
    }
    const data = await aiRes.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    if (required) throw err;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

// destinations as "עיר (מדינה)" — the country ALWAYS travels with the city name
function destDescFull(dests) {
  return dests.map((d) => d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name).join(', ');
}

// rough air distances between destinations, so the AI reasons about real travel
function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function distancesText(dests) {
  const withCoords = dests.filter((d) => d.lat != null && d.lon != null);
  if (withCoords.length < 2) return '';
  const pairs = [];
  for (let i = 0; i < withCoords.length; i++) {
    for (let j = i + 1; j < withCoords.length; j++) {
      pairs.push(`${withCoords[i].name}–${withCoords[j].name}: ~${Math.round(haversineKm(withCoords[i], withCoords[j]) / 10) * 10} ק"מ`);
    }
  }
  return pairs.length ? `\nמרחקים אוויריים משוערים בין היעדים: ${pairs.join(' | ')}.` : '';
}

// shared trip-context suffix for AI prompts
function tripPrefsText({ interestList, freeText, answers }) {
  let s = '';
  if (interestList.length) s += `\nתחומי העניין שלהם: ${interestList.join(', ')}.`;
  if (freeText) s += `\nהעדפות נוספות: "${freeText}"`;
  if (answers && answers.length) {
    s += `\nתשובות המטיילים לשאלות הבהרה: ${answers.map((a) => `${a.question} ← ${a.answer}`).join(' | ')}`;
  }
  return s;
}

// pre-flight: the AI decides whether it's missing information that would
// materially change the trip STRUCTURE (e.g. landing city on a multi-city trip).
// Strongly encouraged to ask nothing; max 2 questions, fixed component types.
async function aiClarify({ dests, from, to, interestList, freeText }) {
  const userMsg =
    `מתכננים טיול לימים ${from} עד ${to} (${to - from + 1} ימים) שמכסה את האזורים: ${destDescFull(dests)}.` +
    distancesText(dests) +
    tripPrefsText({ interestList, freeText }) +
    `\nלפני חלוקת הימים בין האזורים: האם חסר לך פרט שבאמת ישנה את מבנה הטיול (סדר האזורים, חלוקת הימים או ימי המעבר)? ` +
    `דוגמאות לפרט קריטי: באיזו עיר נוחתים וממריאים בטיול מרובה ערים במדינה גדולה; ` +
    `וכשהיעדים רחוקים מאוד זה מזה (מאות ק"מ או מדינות שונות) — איך מעדיפים לעבור ביניהם (למשל options: טיסה פנימית / רכבת או אוטובוס / שיט / רכב שכור עם עצירות בדרך). ` +
    `דוגמה נגדית: במדינה קטנה שבה נקודת הנחיתה כמעט לא משנה — אל תשאל. ` +
    `ברירת המחדל החזקה היא לא לשאול כלום ולהחזיר רשימה ריקה. שאל רק אם התשובה תשנה את התוכנית מהותית, ולכל היותר 2 שאלות קצרות בעברית. ` +
    `סוג שאלה: "choice" עם options קצרות (העדף את זה), או "text" לתשובה חופשית (options ריק).`;

  const parsed = await aiJson({
    system: 'אתה מתכנן טיולים מומחה. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user: userMsg,
    schemaName: 'clarifying_questions',
    maxTokens: 400,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'question', 'options'],
            properties: {
              type: { type: 'string', enum: ['choice', 'text'] },
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  });
  return ((parsed && parsed.questions) || [])
    .slice(0, 2)
    .map((q) => ({
      type: q.type === 'choice' && Array.isArray(q.options) && q.options.length ? 'choice' : 'text',
      question: String(q.question || '').slice(0, 160),
      options: (q.options || []).slice(0, 6).map((o) => String(o).slice(0, 60)),
    }))
    .filter((q) => q.question);
}

// trip meta: description + emoji + cover image. The AI sees only the NAMES of
// the cover photos (token-cheap) and picks one; the server maps name → URL.
const TRIP_EMOJIS = ['🧭', '🏖️', '🏔️', '🏛️', '🌸', '🎡', '🍜', '🚐', '🤿', '🎿', '🐫', '🦁', '🗼', '🚋', '🥥', '🗽', '🥐', '⛰️'];
const COVER_U = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;
const COVER_OPTIONS = [
  { name: 'כביש מדברי בשקיעה', url: COVER_U('photo-1469854523086-cc02fe5d8800') },
  { name: 'חוף טרופי עם מים צלולים', url: COVER_U('photo-1507525428034-b723cf961d3e') },
  { name: 'פסגות הרים מושלגות', url: COVER_U('photo-1464822759023-fed622ff2c3b') },
  { name: 'הקולוסיאום ורומא העתיקה', url: COVER_U('photo-1552832230-c0197dd311b5') },
  { name: 'רחוב ניאון יפני בלילה', url: COVER_U('photo-1540959733332-eab4deabeeaf') },
  { name: 'מגדל אייפל ופריז', url: COVER_U('photo-1502602898657-3e91760cbb34') },
  { name: 'סנטוריני — בתים לבנים וים', url: COVER_U('photo-1613395877344-13d4a8e0d49e') },
  { name: 'קאנו על אגם בין הרים', url: COVER_U('photo-1476514525535-07fb3b4ae5f1') },
];

// location-specific covers may only be used when the trip actually goes there
const COVER_TAGS = {
  'הקולוסיאום ורומא העתיקה': ['רומא', 'איטליה', 'rome', 'italy'],
  'רחוב ניאון יפני בלילה': ['יפן', 'טוקיו', 'אוסקה', 'קיוטו', 'japan', 'tokyo'],
  'מגדל אייפל ופריז': ['פריז', 'צרפת', 'paris', 'france'],
  'סנטוריני — בתים לבנים וים': ['סנטוריני', 'יוון', 'santorini', 'greece'],
};
function validateCoverChoice(chosenName, dests) {
  const hay = dests.map((d) => `${d.name} ${d.country || ''}`).join(' ').toLowerCase();
  const tags = COVER_TAGS[chosenName];
  if (!tags) return chosenName; // generic photo — always fine
  if (tags.some((t) => hay.includes(t))) return chosenName;
  // model picked a landmark from the wrong country — swap to a matching one, else generic
  for (const [name, ts] of Object.entries(COVER_TAGS)) {
    if (ts.some((t) => hay.includes(t))) return name;
  }
  return COVER_OPTIONS[0].name;
}

async function aiTripMeta({ dests, from, to, interestList, freeText, answers }) {
  const meta = await aiJson({
    system: 'אתה קופירייטר של טיולים. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user:
      `טיול של ${to - from + 1} ימים ב: ${destDescFull(dests)}.` + tripPrefsText({ interestList, freeText, answers }) +
      `\n1. כתוב תיאור קצר, חם ומזמין (2-3 משפטים, עברית).` +
      `\n2. בחר אימוג'י אחד שהכי מתאים לאופי הטיול.` +
      `\n3. בחר את תמונת הנושא שהכי מתאימה מתוך הרשימה (לפי השם בלבד). ` +
      `חשוב: תמונה של עיר או אתר מסוים מותרת רק אם הטיול באמת מבקר שם — לטיול במקום אחר בחר תמונה כללית (נוף, חוף, הרים, כביש).`,
    schemaName: 'trip_meta',
    maxTokens: 350,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['description', 'emoji', 'cover'],
      properties: {
        description: { type: 'string' },
        emoji: { type: 'string', enum: TRIP_EMOJIS },
        cover: { type: 'string', enum: COVER_OPTIONS.map((c) => c.name) },
      },
    },
  });
  if (!meta) return null;
  const coverName = validateCoverChoice(meta.cover, dests);
  return {
    description: String(meta.description || '').slice(0, 500) || null,
    emoji: TRIP_EMOJIS.includes(meta.emoji) ? meta.emoji : '🧭',
    cover_image: (COVER_OPTIONS.find((c) => c.name === coverName) || COVER_OPTIONS[0]).url,
  };
}

// stage 1: the AI itself decides city order and how many days each deserves —
// a small, cheap call whose output is easy to validate structurally
async function aiPlanBlocks({ dests, from, to, interestList, freeText, answers }) {
  const areaNames = dests.map((d) => d.name);
  let userMsg =
    `טיול לימים ${from} עד ${to} (כולל, סה"כ ${to - from + 1} ימים) שמכסה את האזורים: ${destDescFull(dests)}. ` +
    distancesText(dests) +
    `\nחלק את הימים בין האזורים: קבע סדר ביקור גיאוגרפי הגיוני, והקצה לכל אזור כמות ימים לפי כמה שיש בו לראות ולעשות עבור המטיילים האלה — לא בהכרח שווה בשווה. ` +
    `קח בחשבון זמני נסיעה: מעבר בין אזורים רחוקים (מאות ק"מ, טיסה או נסיעה ארוכה) גוזל חצי יום עד יום — שקלל את זה בהקצאת הימים של האזור שאליו מגיעים. ` +
    `כל אזור מופיע פעם אחת בדיוק, הבלוקים רצופים ומכסים את כל טווח הימים בלי חורים ובלי חפיפות.` +
    tripPrefsText({ interestList, freeText, answers });

  const parsed = await aiJson({
    system: 'אתה מתכנן טיולים מומחה. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user: userMsg,
    schemaName: 'day_allocation',
    maxTokens: 600,
    timeoutMs: 45000,
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
  });
  if (!parsed) return null;
  const blocks = (parsed.blocks || [])
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
}

// one OpenAI call for ONE area and a fixed day range — the shape that stays coherent
async function aiGenerateBlock({ dests, area, from, to, interestList, freeText, answers, transferFrom }) {
  let userMsg =
    `בנה מסלול טיול מפורט לימים ${from} עד ${to} (כולל) באזור "${area}" בלבד, מתוך טיול שכולל את: ${destDescFull(dests)}. ` +
    `כל התחנות חייבות להיות באזור "${area}" ובשדה area לכתוב בדיוק "${area}". ` +
    `אסור לשבץ תחנות מאזורים אחרים בטווח הימים הזה.`;
  if (transferFrom) {
    const fromDest = dests.find((d) => d.name === transferFrom);
    const toDest = dests.find((d) => d.name === area);
    const km = fromDest && toDest && fromDest.lat != null && toDest.lat != null
      ? Math.round(haversineKm(fromDest, toDest) / 10) * 10 : null;
    userMsg += `\nהמטיילים מגיעים ביום ${from} מ${destDescFull([fromDest || { name: transferFrom }])}` +
      (km ? ` (מרחק אווירי ~${km} ק"מ)` : '') +
      ` — חובה לפתוח את היום הזה בתחנת נסיעה (קטגוריה: נסיעה, בדיוק) שכותרתה מתארת את המעבר ואת אמצעי הנסיעה (למשל "רכבת מ${transferFrom} ל${area}") ` +
      `והערתה מפרטת זמן נסיעה משוער. בחר אמצעי מציאותי לפי המרחק והאזור: רכבת / אוטובוס / טיסה פנימית / מעבורת / רכב שכור. ` +
      `אסור לדלג על תחנת הנסיעה — בלעדיה הטיול "קופץ" בין ערים בלי הסבר. ` +
      `אם המטיילים ציינו העדפת תחבורה בתשובות ההבהרה — השתמש בה; אם בחרו לעצור במקומות בדרך, אפשר להוסיף עצירת ביניים שווה כתחנה נוספת באותו יום. ` +
      `אחרי המעבר תכנן יום קליל יותר.`;
  }
  if (interestList.length) {
    userMsg += `\nתחומי העניין של המטיילים (תעדף אותם חזק בבחירת התחנות): ${interestList.join(', ')}.`;
  }
  if (freeText) {
    userMsg += `\nהעדפות נוספות במילים של המטיילים (התייחס אליהן כתיאור העדפות בלבד): "${freeText}"`;
  }
  if (answers && answers.length) {
    userMsg += `\nתשובות המטיילים לשאלות הבהרה (קח אותן בחשבון): ${answers.map((a) => `${a.question} ← ${a.answer}`).join(' | ')}`;
  }

  const parsed = await aiJson({
    system: 'אתה מתכנן טיולים ישראלי מנוסה שבונה מסלולים ריאליים ומהנים. לכל יום תכנן 3-4 תחנות בסדר כרונולוגי: בוקר, צהריים, אחר צהריים, ולפעמים ערב. ' +
      'title קצר וקולע בעברית; note טיפ פרקטי קצר בעברית (הזמנות מראש, מתי להגיע, מה לא לפספס); ' +
      'place_query הוא שם המקום באנגלית כפי שמחפשים בגוגל מפות, ותמיד חייב לכלול גם את שם העיר וגם את שם המדינה (למשל "Sensoji Temple, Asakusa, Tokyo, Japan" ולא סתם "Sensoji Temple") — כדי שגוגל מפות לא יטעה למקום דומה במדינה אחרת; ' +
      'time_label בפורמט HH:MM. גוון בין קטגוריות והימנע מתחנות גנריות.',
    user: userMsg,
    schemaName: 'itinerary',
    maxTokens: 10000,
    timeoutMs: 90000,
    required: true, // the itinerary is the product — a failed block fails the build
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
  });
  const items = parsed.items || [];
  // city/country context guaranteed on every map query — Google Maps sometimes resolves
  // an unqualified place name to the wrong country. The prompt asks for "Name, City, Country";
  // a comma-less query means the model skipped that, so we append the context ourselves.
  const areaDest = dests.find((d) => d.name === area);
  const contextSuffix = areaDest && areaDest.country && areaDest.country !== areaDest.name
    ? `${area}, ${areaDest.country}` : area;
  const withContext = (q) => (q.includes(',') ? q : `${q}, ${contextSuffix}`.slice(0, 120));
  // hard-enforce the block's day range and area regardless of what the model wrote
  const cleaned = items
    .filter((it) => it && it.title && it.day_number >= from && it.day_number <= to)
    .map((it) => ({
      day_number: it.day_number,
      time_label: /^\d{1,2}:\d{2}$/.test(it.time_label || '') ? it.time_label : null,
      title: String(it.title).slice(0, 200),
      note: it.note ? String(it.note).slice(0, 300) : null,
      place_query: it.place_query ? withContext(String(it.place_query).slice(0, 90)) : null,
      category: AI_CATEGORIES.includes(it.category) ? it.category : 'אטרקציה',
      area,
    }));
  // travel stops are mandatory between areas: if the model skipped the נסיעה stop
  // (or labeled it something else), synthesize one so the trip never teleports
  if (transferFrom && !cleaned.some((it) => it.day_number === from && it.category === 'נסיעה')) {
    const fromDest = dests.find((d) => d.name === transferFrom);
    const toDest = dests.find((d) => d.name === area);
    const km = fromDest && toDest && fromDest.lat != null && toDest.lat != null
      ? Math.round(haversineKm(fromDest, toDest) / 10) * 10 : null;
    cleaned.unshift({
      day_number: from,
      time_label: '08:00',
      title: `נסיעה מ${transferFrom} ל${area}`,
      note: km ? `מעבר בין אזורים (~${km} ק"מ אוויר) — בדקו מראש זמני יציאה וכרטיסים` : 'מעבר בין אזורים — בדקו מראש זמני יציאה וכרטיסים',
      place_query: null,
      category: 'נסיעה',
      area,
    });
  }
  return cleaned;
}

router.post('/api/ai/itinerary', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'בניית AI לא זמינה כרגע' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = aiUsage.get(req.user.id);
    const used = usage && usage.date === today ? usage.count : 0;
    // admins still get counted (the panel shows the number) but are never capped
    if (used >= AI_DAILY_LIMIT && !(await isAdmin(req))) {
      return res.status(429).json({ error: 'הגעתם למכסת בניות ה-AI היומית — נסו שוב מחר' });
    }

    const { destinations, area, day_from, day_to, interests, notes, answers, want_description } = req.body || {};
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

    // clarifying-questions round: only for full multi-area builds, only when the
    // client hasn't been through it yet (answers absent, even as an empty array).
    // Doesn't consume the daily quota.
    const answerList = Array.isArray(answers)
      ? answers.slice(0, 4).map((a) => ({
          question: String(a?.question || '').slice(0, 160),
          answer: String(a?.answer || '').slice(0, 160),
        })).filter((a) => a.question && a.answer)
      : null;
    if (!area && dests.length >= 2 && answerList === null) {
      const questions = await aiClarify({ dests, from, to, interestList, freeText });
      if (questions.length) return res.json({ questions });
    }

    // build the per-area blocks: a single requested area, or an AI-decided
    // allocation (order + days per city). The AI plans; the server only verifies
    // that the blocks are contiguous — falling back to an even split if invalid.
    let blocks;
    if (area) {
      blocks = [{ dest: dests.find((d) => d.name === area), from, to }];
    } else if (dests.length === 1) {
      blocks = [{ dest: dests[0], from, to }];
    } else {
      blocks = await aiPlanBlocks({ dests, from, to, interestList, freeText, answers: answerList })
        || allocateDays(orderByProximity(dests), from, to);
    }

    const wantMeta = want_description || req.body.want_meta;
    const descPromise = wantMeta
      ? aiTripMeta({ dests, from, to, interestList, freeText, answers: answerList })
      : Promise.resolve(null);

    const [results, meta] = await Promise.all([
      Promise.all(blocks.map((b, i) =>
        aiGenerateBlock({
          dests,
          area: b.dest.name,
          from: b.from,
          to: b.to,
          interestList,
          freeText,
          answers: answerList,
          transferFrom: i > 0 ? blocks[i - 1].dest.name : null,
        })
      )),
      descPromise,
    ]);
    const items = results.flat()
      .sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')))
      .slice(0, 200);
    if (!items.length) return res.status(502).json({ error: 'ה-AI החזיר מסלול ריק — נסו שוב' });

    aiUsage.set(req.user.id, { date: today, count: used + 1 });
    res.json({
      items,
      plan: blocks.map((b) => ({ area: b.dest.name, from: b.from, to: b.to })),
      meta,
      description: meta ? meta.description : null, // back-compat
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'ה-AI התעכב יותר מדי — נסו שוב' : 'ה-AI לא הצליח לבנות את המסלול — נסו שוב עוד רגע' });
  }
});

// ---------- AI trip editor: one structured-diff call over the current itinerary ----------
// The trip was built by several parallel structured calls (no stored transcript), and
// manual edits diverge from it anyway — so each edit request sends a fresh, compact
// snapshot of the CURRENT itinerary instead of replaying any "creation conversation".

const AI_EDIT_DAILY_LIMIT = 3;
const AI_EDIT_MAX_PROMPT = 200;
const aiEditUsage = new Map(); // 'u<userId>' → {date, count}

// field cleaners shared by both edit routes (DB-applied and draft)
const cleanTime = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t : null);
const clampDay = (d, days, dflt = 1) => Math.min(Math.max(parseInt(d, 10) || dflt, 1), days);

async function aiEditOps({ title, destText, dests, days, items, prompt, scopeNote = '', opsCap = 30 }) {
  const areaNames = dests.map((d) => d.name);
  const itemLines = items.map((it) =>
    `#${it.id} | יום ${it.day_number} | ${it.time_label || '--:--'} | [${it.category || 'כללי'}] ${it.title}` +
    (areaNames.length > 1 && it.area ? ` | אזור: ${it.area}` : '') +
    (it.place_query ? ` | ${it.place_query}` : ''));
  const userMsg =
    `הטיול: "${title}" — ${dests.length ? destDescFull(dests) : destText}, ${days} ימים (1 עד ${days}).` +
    `\nהמסלול הנוכחי (כל שורה: #מזהה | יום | שעה | [קטגוריה] כותרת | מקום):\n${itemLines.join('\n') || '(המסלול עדיין ריק)'}` +
    (scopeNote ? `\n${scopeNote}` : '') +
    `\n\nבקשת השינוי של המטיילים: "${prompt}"`;

  const parsed = await aiJson({
    system: 'אתה עורך מסלולי טיולים. מקבל מסלול קיים ובקשת שינוי קצרה, ומחזיר אך ורק JSON לפי הסכמה: ops (רשימת פעולות) ו-summary (סיכום קצר וידידותי בעברית של מה שביצעת). ' +
      'התפקיד שלך הוא לבצע את הבקשה בפועל דרך פעולות על תחנות המסלול: add (הוספה), update (עדכון — כולל העברה ליום או שעה אחרים), delete (מחיקה). ' +
      'כמעט כל בקשה ניתנת למימוש דרך תחנות, גם אם לא נאמרה בהן המילה "תחנה": "יום רגוע יותר" = לדלל או להזיז תחנות; "עוד אוכל מקומי" = להוסיף תחנות אוכל; "להחליף את יום 3" = מחיקות והוספות באותו יום; "להתחיל מאוחר יותר" = לעדכן שעות; וכן הלאה. ' +
      'ברירת המחדל שלך היא לבצע: אל תחזיר ops ריק אם אפשר לממש את הבקשה, ולו חלקית, באמצעות פעולות על תחנות. בקשה כללית או עמומה — קבל החלטות סבירות בעצמך ותאר אותן ב-summary, במקום לשאול. ' +
      'מחוץ לתחום שלך: תאריכי הטיול, תקציב, מלונות ותמונת הנושא. אל תדמה שינוי כזה דרך תחנות — הזזת הטיול כולו לתאריכים אחרים, למשל, אינה הזזת תחנות בין ימים (הימים ממוספרים 1 עד N ללא תלות בתאריך). ' +
      'בקשה מעורבת — בצע רק את חלק התחנות וציין ב-summary מה נשאר מחוץ לתחום. ' +
      'החזר ops ריק רק בשני מקרים: (1) הבקשה עוסקת אך ורק בדברים שמחוץ לתחום — ואז הסבר ב-summary בעדינות שכאן משנים רק את תחנות המסלול; (2) אי אפשר להבין מהבקשה שום כוונה — ואז שאל שאלת הבהרה קצרה ב-summary. ' +
      'שנה רק את מה שנוגע לבקשה ואל תיגע בשאר התחנות. ' +
      'update/delete חייבים id של תחנה קיימת; ב-update החזר null בכל שדה שלא משתנה. ' +
      'add חייב title קצר בעברית; note טיפ פרקטי קצר בעברית; time_label בפורמט HH:MM; ' +
      'place_query באנגלית וכולל תמיד עיר ומדינה (למשל "Nishiki Market, Kyoto, Japan"), ורק למקום אמיתי וספציפי שניתן למצוא בגוגל מפות — לתחנה כללית (כמו "ארוחת ערב" בלי מקום מוגדר) החזר null; ' +
      `category מתוך: ${AI_CATEGORIES.join(', ')}` +
      (areaNames.length > 1 ? `; area מתוך: ${areaNames.join(', ')}.` : '.'),
    user: userMsg,
    schemaName: 'trip_edit',
    maxTokens: 5000,
    timeoutMs: 60000,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'ops'],
      properties: {
        summary: { type: 'string' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'id', 'day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area'],
            properties: {
              action: { type: 'string', enum: ['add', 'update', 'delete'] },
              id: { type: ['integer', 'null'] },
              day_number: { type: ['integer', 'null'] },
              time_label: { type: ['string', 'null'] },
              title: { type: ['string', 'null'] },
              note: { type: ['string', 'null'] },
              place_query: { type: ['string', 'null'] },
              category: { type: ['string', 'null'] },
              area: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  });
  if (!parsed) return null;
  return {
    summary: String(parsed.summary || '').slice(0, 300),
    ops: Array.isArray(parsed.ops) ? parsed.ops.slice(0, opsCap) : [],
  };
}

router.post('/api/trips/code/:code/ai-edit', authOptional, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'עריכת AI לא זמינה כרגע' });
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const prompt = String((req.body || {}).prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'כתבו מה לשנות במסלול' });
    if (prompt.length > AI_EDIT_MAX_PROMPT) {
      return res.status(400).json({ error: `הבקשה ארוכה מדי — עד ${AI_EDIT_MAX_PROMPT} תווים` });
    }

    // 3 AI edits a day per user (editing requires login, so req.user is always set here)
    const quotaKey = 'u' + req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const usage = aiEditUsage.get(quotaKey);
    const used = usage && usage.date === today ? usage.count : 0;
    if (used >= AI_EDIT_DAILY_LIMIT) {
      return res.status(429).json({ error: 'ניצלתם את שלושת שינויי ה-AI להיום — אפשר להמשיך לערוך ידנית, או לנסות שוב מחר' });
    }

    const { rows: items } = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    const result = await aiEditOps({
      title: trip.title,
      destText: trip.destination,
      dests: Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [],
      days: trip.days,
      items,
      prompt,
    });
    if (!result) return res.status(502).json({ error: 'ה-AI לא הצליח לעבד את הבקשה — נסו שוב עוד רגע' });
    aiEditUsage.set(quotaKey, { date: today, count: used + 1 }); // the model call is the budgeted resource

    const validIds = new Set(items.map((it) => it.id));
    let added = 0, updated = 0, removed = 0;
    await client.query('BEGIN');
    for (const op of result.ops) {
      if (op.action === 'delete' && validIds.has(op.id)) {
        await client.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [op.id, trip.id]);
        removed++;
      } else if (op.action === 'update' && validIds.has(op.id)) {
        const sets = [];
        const vals = [];
        const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
        if (op.day_number != null) add('day_number', clampDay(op.day_number, trip.days));
        if (op.time_label != null) add('time_label', cleanTime(op.time_label));
        if (op.title != null && String(op.title).trim()) add('title', String(op.title).slice(0, 200).trim());
        if (op.note != null) add('note', String(op.note).slice(0, 300) || null);
        if (op.place_query != null) {
          add('place_query', String(op.place_query).slice(0, 120) || null);
          // the stop moved somewhere else — stale coordinates would pin the old spot
          add('lat', null);
          add('lon', null);
        }
        if (op.category != null && AI_CATEGORIES.includes(op.category)) add('category', op.category);
        if (op.area != null) add('area', String(op.area).slice(0, 80) || null);
        if (sets.length) {
          vals.push(op.id, trip.id);
          await client.query(
            `UPDATE trip_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND trip_id = $${vals.length}`, vals
          );
          updated++;
        }
      } else if (op.action === 'add' && op.title && String(op.title).trim()) {
        await client.query(
          `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))`,
          [trip.id, clampDay(op.day_number, trip.days), cleanTime(op.time_label), String(op.title).slice(0, 200).trim(),
           op.note ? String(op.note).slice(0, 300) : null,
           op.place_query ? String(op.place_query).slice(0, 120) : null,
           AI_CATEGORIES.includes(op.category) ? op.category : 'אטרקציה',
           op.area ? String(op.area).slice(0, 80) : null]
        );
        added++;
      }
    }
    await client.query('COMMIT');

    const fresh = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    res.json({
      summary: result.summary || 'בוצע',
      added, updated, removed,
      items: fresh.rows,
      remaining: AI_EDIT_DAILY_LIMIT - used - 1,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

// draft edits: the plan wizard's itinerary lives only in the client, so the ops are
// computed here (same model call, same daily quota) and applied by the browser.
// An optional area + day range scopes the request — the integrated replacement for
// the old "build a specific area" form, including full in-range rebuilds.
router.post('/api/ai/edit-draft', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'עריכת AI לא זמינה כרגע' });
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'כתבו מה לשנות במסלול' });
    if (prompt.length > AI_EDIT_MAX_PROMPT) {
      return res.status(400).json({ error: `הבקשה ארוכה מדי — עד ${AI_EDIT_MAX_PROMPT} תווים` });
    }
    const dests = cleanDestinations(b.destinations);
    if (!dests.length) return res.status(400).json({ error: 'חסרים יעדים' });
    const days = Math.min(Math.max(parseInt(b.days, 10) || 1, 1), 60);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it) => ({
      id: parseInt(it?.id, 10) || 0,
      day_number: clampDay(it?.day_number, days),
      time_label: cleanTime(it?.time_label),
      title: String(it?.title || '').slice(0, 200),
      note: it?.note ? String(it.note).slice(0, 300) : null,
      place_query: it?.place_query ? String(it.place_query).slice(0, 120) : null,
      category: AI_CATEGORIES.includes(it?.category) ? it.category : null,
      area: it?.area ? String(it.area).slice(0, 80) : null,
    })).filter((it) => it.id && it.title);

    // optional scope: one area within a day range (multi-destination trips)
    const areaNames = dests.map((d) => d.name);
    const area = b.area && areaNames.includes(b.area) ? b.area : null;
    let from = 1, to = days, scopeNote = '';
    if (area) {
      from = Math.min(Math.max(parseInt(b.day_from, 10) || 1, 1), days);
      to = Math.min(Math.max(parseInt(b.day_to, 10) || days, from), days);
      scopeNote = `החל את הבקשה אך ורק על אזור "${area}" בימים ${from} עד ${to}: ` +
        `כל תחנה שתוסיף תהיה באזור הזה ובטווח הימים הזה (שדה area: "${area}"), ואל תיגע בתחנות מחוץ לטווח. ` +
        `אם התבקשה בנייה מחדש — החלף את כל התחנות בטווח (מחיקות + הוספות), 3-4 תחנות ליום בסדר כרונולוגי.`;
    }

    const quotaKey = 'u' + req.user.id; // shared daily pool with the trip-page AI edits
    const today = new Date().toISOString().slice(0, 10);
    const usage = aiEditUsage.get(quotaKey);
    const used = usage && usage.date === today ? usage.count : 0;
    if (used >= AI_EDIT_DAILY_LIMIT) {
      return res.status(429).json({ error: 'ניצלתם את שלושת שינויי ה-AI להיום — אפשר להמשיך לערוך ידנית, או לנסות שוב מחר' });
    }

    const result = await aiEditOps({
      title: String(b.title || '').slice(0, 80) || 'טיול חדש',
      destText: dests.map((d) => d.name).join(' · '),
      dests, days, items, prompt, scopeNote,
      opsCap: 60, // scoped rebuilds legitimately delete + re-add several days
    });
    if (!result) return res.status(502).json({ error: 'ה-AI לא הצליח לעבד את הבקשה — נסו שוב עוד רגע' });
    aiEditUsage.set(quotaKey, { date: today, count: used + 1 });

    // sanitize ops for the client: known ids, clamped days, scope enforced
    const byId = new Map(items.map((it) => [it.id, it]));
    const inScope = (day) => !area || (day >= from && day <= to);
    const ops = [];
    for (const op of result.ops) {
      if (op.action === 'delete') {
        const target = byId.get(op.id);
        if (target && inScope(target.day_number)) ops.push({ action: 'delete', id: op.id });
      } else if (op.action === 'update') {
        const target = byId.get(op.id);
        if (!target || !inScope(target.day_number)) continue;
        const day = op.day_number != null ? clampDay(op.day_number, days, target.day_number) : null;
        if (day != null && !inScope(day)) continue;
        ops.push({
          action: 'update',
          id: op.id,
          day_number: day,
          time_label: op.time_label != null ? cleanTime(op.time_label) : null,
          title: op.title != null && String(op.title).trim() ? String(op.title).slice(0, 200).trim() : null,
          note: op.note != null ? String(op.note).slice(0, 300) : null,
          place_query: op.place_query != null ? String(op.place_query).slice(0, 120) : null,
          category: op.category != null && AI_CATEGORIES.includes(op.category) ? op.category : null,
          area: op.area != null ? String(op.area).slice(0, 80) : null,
        });
      } else if (op.action === 'add' && op.title && String(op.title).trim()) {
        const day = clampDay(op.day_number, days, from);
        if (!inScope(day)) continue;
        ops.push({
          action: 'add',
          day_number: day,
          time_label: cleanTime(op.time_label),
          title: String(op.title).slice(0, 200).trim(),
          note: op.note ? String(op.note).slice(0, 300) : null,
          place_query: op.place_query ? String(op.place_query).slice(0, 120) : null,
          category: AI_CATEGORIES.includes(op.category) ? op.category : 'אטרקציה',
          area: op.area ? String(op.area).slice(0, 80) : (area || null),
        });
      }
    }
    res.json({ summary: result.summary || 'בוצע', ops, remaining: AI_EDIT_DAILY_LIMIT - used - 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
