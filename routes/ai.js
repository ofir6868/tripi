// AI itinerary builder + trip editor (OpenAI, server-side — the key never reaches the client)
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../lib/db');
const { authRequired, authOptional, isAdmin } = require('../lib/auth');
const { tripWithEditAuth, cleanDestinations } = require('../lib/trips');
const posthog = require('../lib/posthog');

const router = express.Router();

// two tiers, named by capability rather than any one vendor's model family — swapping
// in e.g. Gemini later is a matter of changing these two env vars, nothing else.
const AI_MODEL_WEAK = process.env.AI_MODEL_WEAK || 'gpt-4o-mini'; // cheap, fast — the default for most calls
const AI_MODEL_STRONG = process.env.AI_MODEL_STRONG || 'gpt-4o'; // used where the weak model demonstrably drifts
// from this many days on, a single broad destination is asked which regions to
// COMBINE (multi-select) rather than which one to focus on
const COMBINE_REGIONS_FROM_DAYS = 10;
// how many areas one build may span — a guard against a runaway list, not a pacing
// rule: how long each area is worth is the model's judgement, never a fixed ratio
const MAX_REGIONS = 6;
// a block (or single-area trip) at least this long needs the strong model — from this
// length on the weak model starts thinning out days or repeating stops
const STRONG_MODEL_FROM_DAYS = 6;
const AI_CATEGORIES = ['אטרקציה', 'אוכל', 'טבע', 'ים', 'תרבות', 'קניות', 'לינה', 'נוף', 'חיי לילה', 'נסיעה', 'היסטוריה', 'אמנות', 'עיר'];
// cost estimates arrive as loose model output — keep only positive, sane integers
const cleanCost = (v) => (Number.isFinite(+v) && +v > 0 ? Math.min(Math.round(+v), 999999999) : null);
const aiUsage = new Map(); // userId → {date, count}
const AI_DAILY_LIMIT = 20;

// the one OpenAI caller: chat completion forced into a strict JSON schema.
// Returns the parsed object, or null on any failure (HTTP error, timeout, bad
// JSON) — unless `required`, which rethrows so the route can distinguish an
// aborted call (timeout message) from the rest.
async function aiJson({ system, user, schemaName, schema, maxTokens, model = AI_MODEL_WEAK, timeoutMs = 30000, required = false, ph = null }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  // PostHog LLM analytics: one $ai_generation per OpenAI call, full input/output
  // included — cost is computed on their side from model + token counts, and
  // ph.traceId groups the calls of a single build/edit into one trace
  const started = Date.now();
  let reported = false;
  const aiEvent = (extra) => {
    if (!ph || reported) return;
    reported = true;
    posthog.capture('$ai_generation', ph.distinctId, {
      $ai_trace_id: ph.traceId,
      $ai_span_name: schemaName,
      $ai_provider: 'openai',
      $ai_model: model,
      $ai_base_url: 'https://api.openai.com/v1',
      $ai_input: messages,
      $ai_latency: (Date.now() - started) / 1000,
      ...extra,
    });
  };
  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      console.error(`OpenAI ${schemaName} error`, aiRes.status, errBody.slice(0, 300));
      aiEvent({ $ai_http_status: aiRes.status, $ai_is_error: true, $ai_error: errBody.slice(0, 300) });
      if (required) throw new Error('openai failed');
      return null;
    }
    const data = await aiRes.json();
    const content = data.choices[0].message.content;
    aiEvent({
      $ai_http_status: aiRes.status,
      $ai_output_choices: [{ role: 'assistant', content }],
      $ai_input_tokens: data.usage?.prompt_tokens ?? null,
      $ai_output_tokens: data.usage?.completion_tokens ?? null,
    });
    return JSON.parse(content);
  } catch (err) {
    // a silent null here is hard to tell apart from "the AI had nothing to say" —
    // a transient `fetch failed` once cost an hour of blaming the prompt
    console.error(`OpenAI ${schemaName} failed`, err.name, err.cause ? (err.cause.code || err.cause.message) : err.message);
    aiEvent({
      $ai_is_error: true,
      $ai_error: err.name === 'AbortError' ? `aborted after ${timeoutMs}ms timeout` : String(err.message || err).slice(0, 300),
    });
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

// A country trip is always built as areas, never as one undivided country. Areas are
// what the day allocation, the transfer stops and the calendar's day headers hang on,
// and each area is its own generation call — a 22-day country built in one call thins
// out and repeats itself. One area is a legitimate answer for a short trip.
// Regions come from the traveller when they picked some, and from the AI when they
// skipped the question or never saw it.

// the ticked options, split into name + the cities the option named. Only `picked`
// counts, never the answer text: free text with commas in it ("אוהבים אוכל רחוב,
// קצב רגוע") would otherwise become three imaginary areas with train rides between.
function regionsFromPicked(base, answerList) {
  const answer = (answerList || []).find((a) => a.picked.length);
  if (!answer) return null;
  const seen = new Set();
  const regions = [];
  for (const label of answer.picked) {
    const name = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!name || name === base.name || seen.has(name)) continue;
    seen.add(name);
    const hint = label.match(/\(([^)]*)\)\s*$/)?.[1] || '';
    regions.push({ name, cities: hint.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 3) });
  }
  return regions.length ? regions.slice(0, MAX_REGIONS) : null;
}

// the fallback: the AI names the areas for a country nobody split by hand — how many
// of them, and which, is its call. What a region is worth depends on what these
// travellers came for and on what the region actually holds, so no days-per-region
// ratio is imposed here. The one pacing rule the prompt states is the one that keeps
// a short trip from becoming a move a day.
async function aiCountryRegions({ dest, from, to, interestList, freeText, answers, ph }) {
  const days = to - from + 1;
  const call = () => aiJson({
    system: 'אתה מתכנן טיולים מומחה. מספר האזורים בטיול ואורך השהות בכל אחד נגזרים ממה שיש בו לראות ולעשות ' +
      'עבור המטיילים האלה ומקצב סביר — לא מחלוקה שווה של הימים ולא מיחס קבוע של ימים לאזור. ' +
      'אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user:
      `טיול של ${days} ימים ב${destDescFull([dest])}.` +
      tripPrefsText({ interestList, freeText, answers }) +
      `\nלאילו אזורים גיאוגרפיים לחלק את הטיול, לפי סדר ביקור הגיוני? ` +
      `קבע את מספרם לפי כמה ימים כל אזור מצדיק עבור המטיילים האלה — אזור שיש בו הרבה ממה שמעניין אותם מחזיק יותר ימים. ` +
      `שקלל את מחיר המעבר: כל מעבר בין אזורים אוכל חצי יום עד יום מ-${days} הימים (אריזה, נסיעה, צ'ק-אין), ` +
      `ולכן אזור נכנס לרשימה רק אם נשארים בו לפחות יומיים-שלושה רצופים — אחרת הימים שלו שווים יותר באזור שכבר ברשימה. ` +
      `אם ${days} הימים מצדיקים מקום אחד, החזר אזור אחד. ` +
      `לכל אזור שם מוכר בעברית ו-2–3 ערים מרכזיות שנמצאות בו.`,
    schemaName: 'trip_regions',
    maxTokens: 400,
    ph,
    model: AI_MODEL_STRONG, // region names in Hebrew are exactly where the weak model invents places
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['regions'],
      properties: {
        regions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'cities'],
            properties: {
              name: { type: 'string' },
              cities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  });
  // one retry: this call decides whether a long trip is built area-by-area or as one
  // sprawling block, and a transient network blip is a poor reason to lose that
  const parsed = (await call()) || (await call());
  const regions = ((parsed && parsed.regions) || [])
    .map((r) => ({
      name: String(r.name || '').slice(0, 60).trim(),
      cities: (r.cities || []).slice(0, 3).map((c) => String(c).slice(0, 60).trim()).filter(Boolean),
    }))
    .filter((r) => r.name);
  return regions.length ? regions.slice(0, MAX_REGIONS) : null;
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
// materially change the trip STRUCTURE (which region, landing city, how to move
// between far-apart areas). Default is to ask nothing; max 2 questions, fixed types.
async function aiClarify({ dests, from, to, interestList, freeText, ph }) {
  const days = to - from + 1;
  // the caller only sends two shapes here: one broad destination (a country pick, or
  // free text we can't classify), or several destinations. Each shape has its own
  // structural unknown, so each branch names only that one — last in the message,
  // which is where this model actually follows an instruction.
  const broadSingle = dests.length === 1 && (!dests[0].country || dests[0].country === dests[0].name);
  // roughly a region per 5–7 days: below that the trip has room for one area and the
  // question is "which one", above it the question is "which to combine". Pure day
  // arithmetic, so the server decides it — asked to judge this, the model answered
  // "combine" for a 3-day Malta trip.
  const combine = broadSingle && days >= COMBINE_REGIONS_FROM_DAYS;
  const userMsg =
    `מתכננים טיול של ${days} ימים (ימים ${from} עד ${to}) ב: ${destDescFull(dests)}.` +
    distancesText(dests) +
    tripPrefsText({ interestList, freeText }) +
    `\nלפני שמחלקים את הימים בין האזורים: חסר לך פרט שבלעדיו החלוקה עלולה לצאת שגויה? ` +
    `ברירת המחדל היא להחזיר רשימה ריקה — כל שאלה חייבת להיות על מבנה המסלול עצמו (איזה אזור, סדר האזורים, חלוקת הימים או המעברים ביניהם), ` +
    `לכל היותר 2 שאלות קצרות בעברית, סוג "choice" עם options קצרות (עדיף) או "text" בלי options.` +
    (broadSingle
      ? `\nהפרט היחיד שחסר כאן הוא אילו אזורים ייכנסו למסלול — שאלה אחת בלבד: ` +
        (combine ? `אילו אזורים לשלב ב-${days} הימים.` : `באיזה אזור להתמקד ב-${days} הימים.`) +
        ` כל option בעברית בפורמט "שם האזור (עיר, עיר)": אזור גיאוגרפי אחד שמשתרע על כמה ערים, ובסוגריים רק שמות ערים שנמצאות בו — 3–4 אזורים נפרדים שאינם חופפים.`
      : `\nהפרטים שחסרים כאן בדרך כלל: באיזו עיר נוחתים וממריאים כשהיעדים פרוסים על מדינה גדולה, ` +
        `ואיך עוברים בין יעדים רחוקים זה מזה — מתוך טיסה פנימית / רכבת / אוטובוס / רכב שכור / שיט, רק האפשרויות שהגיוניות למרחק שצוין למעלה.`);

  const parsed = await aiJson({
    system: 'אתה מתכנן טיולים מומחה. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user: userMsg,
    schemaName: 'clarifying_questions',
    maxTokens: 400,
    ph,
    model: AI_MODEL_STRONG,
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
  const questions = ((parsed && parsed.questions) || [])
    .slice(0, 2)
    .map((q) => ({
      type: q.type === 'choice' && Array.isArray(q.options) && q.options.length ? 'choice' : 'text',
      question: String(q.question || '').slice(0, 160),
      options: (q.options || []).slice(0, 6).map((o) => String(o).slice(0, 60)),
      multi: false,
    }))
    .filter((q) => q.question);
  // the combine round is the only multi-select, and only when it came back as the
  // single region question we asked for — never spread it over a stray second one
  if (combine && questions.length === 1 && questions[0].type === 'choice') questions[0].multi = true;
  return questions;
}

// trip meta: description + emoji + cover image. The AI sees only the NAMES of
// the cover photos (token-cheap) and picks one; the server maps name → URL.
const TRIP_EMOJIS = ['🧭', '🏖️', '🏔️', '🏛️', '🌸', '🎡', '🍜', '🚐', '🤿', '🎿', '🐫', '🦁', '🗼', '🚋', '🥥', '🗽', '🥐', '⛰️'];
const COVER_U = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;
// soft cap: ~40 covers — beyond that, pre-filter by destination tags before the
// model call so the enum stays small. Every URL was eyeballed against its name
// before landing here — a mislabeled landmark is worse than a generic beach.
const COVER_OPTIONS = [
  { name: 'כביש מדברי בשקיעה', url: COVER_U('photo-1469854523086-cc02fe5d8800') },
  { name: 'חוף טרופי עם מים צלולים', url: COVER_U('photo-1507525428034-b723cf961d3e') },
  { name: 'פסגות הרים מושלגות', url: COVER_U('photo-1464822759023-fed622ff2c3b') },
  { name: 'קאנו על אגם בין הרים', url: COVER_U('photo-1476514525535-07fb3b4ae5f1') },
  { name: 'הקולוסיאום ורומא העתיקה', url: COVER_U('photo-1552832230-c0197dd311b5') },
  { name: 'רחוב ניאון יפני בלילה', url: COVER_U('photo-1540959733332-eab4deabeeaf') },
  { name: 'מגדל אייפל ופריז', url: COVER_U('photo-1502602898657-3e91760cbb34') },
  { name: 'סנטוריני — בתים לבנים וים', url: COVER_U('photo-1613395877344-13d4a8e0d49e') },
  { name: 'סירות תאילנדיות על חוף טרופי', url: COVER_U('photo-1552465011-b4e21bf6e79a') },
  { name: 'ניו יורק — טיימס סקוור', url: COVER_U('photo-1496442226666-8d4d0e62e6e9') },
  { name: 'לונדון — גשר המצודה והתמזה', url: COVER_U('photo-1513635269975-59663e0ac1ad') },
  { name: 'ברצלונה מלמעלה — סגרדה פמיליה', url: COVER_U('photo-1583422409516-2895a77efded') },
  { name: 'תעלות אמסטרדם', url: COVER_U('photo-1534351590666-13e3e96b5017') },
  { name: 'קו הרקיע של דובאי', url: COVER_U('photo-1512453979798-5ea266f8880c') },
  { name: 'חשמלית צהובה בליסבון', url: COVER_U('photo-1585208798174-6cedd86e019a') },
  { name: 'מפרץ הא לונג — סלעים וסירות', url: COVER_U('photo-1528127269322-539801943592') },
  { name: 'טביליסי בשקיעה', url: COVER_U('photo-1565008576549-57569a49371d') },
  { name: 'בודפשט והדנובה מלמעלה', url: COVER_U('photo-1551867633-194f125bddfa') },
  { name: 'פראג — גשר קארל והטירה', url: COVER_U('photo-1519677100203-a0e668c92439') },
  { name: 'ברלין — שער ברנדנבורג', url: COVER_U('photo-1560969184-10fe8719e047') },
  { name: 'סוואנה אפריקאית בשקיעה', url: COVER_U('photo-1547471080-7cc2caa01a7e') },
  { name: 'ירושלים — כיפת הסלע', url: COVER_U('photo-1552423314-cf29ab68ad73') },
  { name: 'וינה — קתדרלת שטפן', url: COVER_U('photo-1516550893923-42d28e5677af') },
  { name: 'באלי — מקדש על המים', url: COVER_U('photo-1537996194471-e657df975ab4') },
  { name: 'קסבה מרוקאית ונאות דקלים', url: COVER_U('photo-1489749798305-4fea3ae63d43') },
  { name: 'קניון ירוק באיסלנד', url: COVER_U('photo-1504893524553-b855bce32c67') },
  { name: 'רכבת בין ג׳ונגלים בסרי לנקה', url: COVER_U('photo-1566296314736-6eaac1ca0cb9') },
  { name: 'האקרופוליס באתונה', url: COVER_U('photo-1555993539-1732b0258235') },
  { name: 'מאצ׳ו פיצ׳ו בעננים', url: COVER_U('photo-1526392060635-9d6019884377') },
  { name: 'הטאג׳ מהאל', url: COVER_U('photo-1564507592333-c60657eea523') },
  { name: 'כדורים פורחים בקפדוקיה', url: COVER_U('photo-1641128324972-af3212f0f6bd') },
  { name: 'שונית אלמוגים וצוללנים', url: COVER_U('photo-1544551763-46a013bb70d5') },
  { name: 'גבעות ירוקות בערפל', url: COVER_U('photo-1470071459604-3b5ec3a7fe05') },
];

// location-specific covers may only be used when the trip actually goes there
const COVER_TAGS = {
  'הקולוסיאום ורומא העתיקה': ['רומא', 'איטליה', 'rome', 'italy'],
  'רחוב ניאון יפני בלילה': ['יפן', 'טוקיו', 'אוסקה', 'קיוטו', 'japan', 'tokyo'],
  'מגדל אייפל ופריז': ['פריז', 'צרפת', 'paris', 'france'],
  'סנטוריני — בתים לבנים וים': ['סנטוריני', 'יוון', 'santorini', 'greece'],
  'סירות תאילנדיות על חוף טרופי': ['תאילנד', 'פוקט', 'קראבי', 'קו פנגן', 'קוסמוי', 'בנגקוק', 'thailand'],
  'ניו יורק — טיימס סקוור': ['ניו יורק', 'ניו-יורק', 'ארה"ב', 'new york', 'usa'],
  'לונדון — גשר המצודה והתמזה': ['לונדון', 'אנגליה', 'בריטניה', 'london', 'england'],
  'ברצלונה מלמעלה — סגרדה פמיליה': ['ברצלונה', 'ספרד', 'barcelona', 'spain'],
  'תעלות אמסטרדם': ['אמסטרדם', 'הולנד', 'amsterdam', 'netherlands'],
  'קו הרקיע של דובאי': ['דובאי', 'איחוד האמירויות', 'dubai'],
  // the same yellow trams run in Porto, so the whole country qualifies
  'חשמלית צהובה בליסבון': ['ליסבון', 'פורטו', 'פורטוגל', 'lisbon', 'porto', 'portugal'],
  'מפרץ הא לונג — סלעים וסירות': ['וייטנאם', 'האנוי', 'הא לונג', 'vietnam', 'hanoi'],
  'טביליסי בשקיעה': ['גיאורגיה', 'טביליסי', 'בטומי', 'georgia', 'tbilisi'],
  'בודפשט והדנובה מלמעלה': ['בודפשט', 'הונגריה', 'budapest', 'hungary'],
  'פראג — גשר קארל והטירה': ['פראג', "צ'כיה", 'צכיה', 'prague', 'czech'],
  'ברלין — שער ברנדנבורג': ['ברלין', 'גרמניה', 'berlin', 'germany'],
  'סוואנה אפריקאית בשקיעה': ['טנזניה', 'קניה', 'זנזיבר', 'דרום אפריקה', 'נמיביה', 'אוגנדה', 'ספארי', 'tanzania', 'kenya', 'safari', 'africa'],
  'ירושלים — כיפת הסלע': ['ישראל', 'ירושלים', 'israel', 'jerusalem'],
  'וינה — קתדרלת שטפן': ['וינה', 'אוסטריה', 'vienna', 'austria'],
  'באלי — מקדש על המים': ['באלי', 'אינדונזיה', 'bali', 'indonesia'],
  'קסבה מרוקאית ונאות דקלים': ['מרוקו', 'מרקש', 'morocco', 'marrakesh'],
  'קניון ירוק באיסלנד': ['איסלנד', 'רייקיאוויק', 'iceland'],
  'רכבת בין ג׳ונגלים בסרי לנקה': ['סרי לנקה', 'סרי-לנקה', 'sri lanka'],
  'האקרופוליס באתונה': ['אתונה', 'יוון', 'athens', 'greece'],
  'מאצ׳ו פיצ׳ו בעננים': ["מאצ'ו", 'מאצו', 'פרו', 'קוסקו', 'peru', 'machu'],
  'הטאג׳ מהאל': ['הודו', 'אגרה', 'דלהי', 'india', 'agra', 'delhi'],
  'כדורים פורחים בקפדוקיה': ['קפדוקיה', 'טורקיה', 'תורכיה', 'cappadocia', 'turkey'],
  // named by what they show, targeted by tags: the reef serves the Red Sea trips,
  // the green hills serve the Israeli north (Golan/Galilee) — no false place claims
  'שונית אלמוגים וצוללנים': ['אילת', 'ים סוף', 'סיני', 'טאבה', 'eilat', 'sinai'],
  'גבעות ירוקות בערפל': ['רמת הגולן', 'גולן', 'גליל', 'כנרת', 'טבריה', 'צפת', 'חרמון', 'ישראל', 'israel', 'golan', 'galilee'],
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

async function aiTripMeta({ dests, from, to, interestList, freeText, answers, ph }) {
  const meta = await aiJson({
    system: 'אתה קופירייטר של טיולים. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user:
      `טיול של ${to - from + 1} ימים ב: ${destDescFull(dests)}.` + tripPrefsText({ interestList, freeText, answers }) +
      `\n1. כתוב תיאור קצר וממוקד (1-2 משפטים, עברית) שמסביר בפועל מה יש בטיול הזה — אילו יעדים, ואיזה סוג חוויות (הליכות, אוכל, ים, טבע, ערים, וכו'). ` +
      `תיאור מציאותי ולא פרסומת: בלי סופרלטיבים ומילים נפוחות ("קסום", "מרהיב", "בלתי נשכח", "חלומי" וכדומה), בלי אמוג'ים, ובלי לועזית מוטמעת בעברית.` +
      `\n2. בחר אימוג'י אחד שהכי מתאים לאופי הטיול.` +
      `\n3. בחר את תמונת הנושא שהכי מתאימה מתוך הרשימה (לפי השם בלבד). ` +
      `חשוב: תמונה של עיר או אתר מסוים מותרת רק אם הטיול באמת מבקר שם — לטיול במקום אחר בחר תמונה כללית (נוף, חוף, הרים, כביש).`,
    schemaName: 'trip_meta',
    maxTokens: 350,
    ph,
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
async function aiPlanBlocks({ dests, from, to, interestList, freeText, answers, ph }) {
  const areaNames = dests.map((d) => d.name);
  // the preferences come BEFORE the instruction, so "for these travellers" points at
  // something already on the page — and the allocation rule lands last, which is where
  // this model actually follows one
  let userMsg =
    `טיול לימים ${from} עד ${to} (כולל, סה"כ ${to - from + 1} ימים) שמכסה את האזורים: ${destDescFull(dests)}. ` +
    distancesText(dests) +
    tripPrefsText({ interestList, freeText, answers }) +
    `\nחלק את הימים בין האזורים: קבע סדר ביקור גיאוגרפי הגיוני, והקצה לכל אזור ימים לפי כמה שיש בו לראות ולעשות עבור המטיילים האלה — ` +
    `אזור עמוס במה שמעניין אותם מקבל יותר ימים, ואזור שרואים בו את העיקר ביומיים מקבל יומיים. חלוקה שווה היא סימן שלא שקלת את התוכן. ` +
    `קח בחשבון זמני נסיעה: מעבר בין אזורים רחוקים (מאות ק"מ, טיסה או נסיעה ארוכה) גוזל חצי יום עד יום — שקלל את זה בהקצאת הימים של האזור שאליו מגיעים. ` +
    `כל אזור מופיע פעם אחת בדיוק, הבלוקים רצופים ומכסים את כל טווח הימים בלי חורים ובלי חפיפות.`;

  const parsed = await aiJson({
    system: 'אתה מתכנן טיולים מומחה. אורך השהות בכל אזור נגזר ממה שיש בו לראות ולעשות עבור המטיילים האלה ' +
      'ומזמני המעבר — לא מחלוקה שווה של הימים. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
    user: userMsg,
    schemaName: 'day_allocation',
    maxTokens: 600,
    timeoutMs: 45000,
    ph,
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
async function aiGenerateBlock({ dests, area, from, to, interestList, freeText, answers, transferFrom, ph }) {
  // a long block asks the model to hold many days of a single area coherent in one
  // generation — the weak model starts thinning out days or repeating stops there
  const blockDays = to - from + 1;
  const model = blockDays >= STRONG_MODEL_FROM_DAYS ? AI_MODEL_STRONG : AI_MODEL_WEAK;
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
      'time_label בפורמט HH:MM; ' +
      'cost הוא הערכת עלות ריאלית לאדם בשקלים חדשים (מספר שלם): כרטיס כניסה, ארוחה ממוצעת או מחיר נסיעה — לתחנה חינמית (רחוב, פארק, נוף, שוק בלי קנייה) החזר null. ' +
      'גוון בין קטגוריות והימנע מתחנות גנריות.',
    user: userMsg,
    schemaName: 'itinerary',
    maxTokens: 10000,
    timeoutMs: 90000,
    model,
    ph,
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
            required: ['day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area', 'cost'],
            properties: {
              day_number: { type: 'integer' },
              time_label: { type: 'string' },
              title: { type: 'string' },
              note: { type: 'string' },
              place_query: { type: 'string' },
              category: { type: 'string', enum: AI_CATEGORIES },
              area: { type: 'string' },
              cost: { type: ['integer', 'null'] },
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
      cost: cleanCost(it.cost),
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
      cost: null,
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

    // one trace per build request — every OpenAI call it spawns shares this id,
    // attributed to the same pseudonymous identity the client-side analytics uses
    const ph = { distinctId: 'user_' + req.user.id, traceId: randomUUID() };

    // clarifying-questions round: for full multi-area builds, or for a single broad
    // destination — a country pick (name === country) or unclassified free text —
    // where the days may not stretch across it. Only when the client hasn't been
    // through it yet (answers absent, even as an empty array). No daily quota cost.
    const answerList = Array.isArray(answers)
      ? answers.slice(0, 4).map((a) => ({
          question: String(a?.question || '').slice(0, 160),
          answer: String(a?.answer || '').slice(0, 240), // a multi answer carries several regions
          // the options actually ticked, so the build can tell them from typed text
          picked: (Array.isArray(a?.picked) ? a.picked : [])
            .slice(0, 5).map((p) => String(p).slice(0, 60).trim()).filter(Boolean),
        })).filter((a) => a.question && a.answer)
      : null;
    const broadSingle = dests.length === 1 && (!dests[0].country || dests[0].country === dests[0].name);
    if (!area && (dests.length >= 2 || broadSingle) && answerList === null) {
      const questions = await aiClarify({ dests, from, to, interestList, freeText, ph });
      if (questions.length) return res.json({ questions });
    }

    // a country is always built as areas: the ones the traveller ticked, or — when they
    // skipped the question or never saw it — the ones the AI breaks it into. They stand
    // in for destinations while building, so a one-country trip gets the same contiguous
    // blocks and transfer stops as a multi-city one. The trip's own destination list
    // is untouched; only the response's `plan` reports the areas back.
    const regions = broadSingle && !area
      ? (regionsFromPicked(dests[0], answerList)
        || await aiCountryRegions({ dest: dests[0], from, to, interestList, freeText, answers: answerList, ph }))
      : null;
    const regionCities = new Map((regions || []).map((r) => [r.name, r.cities]));
    const buildDests = regions
      ? regions.map((r) => ({ name: r.name, country: dests[0].country || dests[0].name, lat: null, lon: null }))
      : dests;

    // build the per-area blocks: a single requested area, or an AI-decided
    // allocation (order + days per city). The AI plans; the server only verifies
    // that the blocks are contiguous — falling back to an even split if invalid.
    let blocks;
    if (area) {
      blocks = [{ dest: dests.find((d) => d.name === area), from, to }];
    } else if (buildDests.length === 1) {
      blocks = [{ dest: buildDests[0], from, to }];
    } else {
      blocks = await aiPlanBlocks({ dests: buildDests, from, to, interestList, freeText, answers: answerList, ph })
        || allocateDays(orderByProximity(buildDests), from, to);
    }

    const wantMeta = want_description || req.body.want_meta;
    const descPromise = wantMeta
      ? aiTripMeta({ dests, from, to, interestList, freeText, answers: answerList, ph })
      : Promise.resolve(null);

    const [results, meta] = await Promise.all([
      Promise.all(blocks.map((b, i) =>
        aiGenerateBlock({
          dests: buildDests,
          area: b.dest.name,
          from: b.from,
          to: b.to,
          interestList,
          freeText,
          answers: answerList,
          transferFrom: i > 0 ? blocks[i - 1].dest.name : null,
          ph,
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
      // cities ride along so the client can place an area on the map — a region name
      // on its own geocodes to nothing, or to the wrong continent
      plan: blocks.map((b) => ({
        area: b.dest.name, from: b.from, to: b.to, cities: regionCities.get(b.dest.name) || [],
      })),
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

// re-pacing a trip costs one update per moved stop, so the cap has to clear a
// whole-trip reshuffle — at 30 the tail of a reorganization was silently dropped,
// which by itself left days empty
async function aiEditOps({ title, destText, dests, days, items, prompt, description = '', scopeNote = '', opsCap = 80, ph }) {
  const areaNames = dests.map((d) => d.name);
  const itemLines = items.map((it) =>
    `#${it.id} | יום ${it.day_number} | ${it.time_label || '--:--'} | [${it.category || 'כללי'}] ${it.title}` +
    (areaNames.length > 1 && it.area ? ` | אזור: ${it.area}` : '') +
    (it.place_query ? ` | ${it.place_query}` : '') +
    (+it.cost > 0 ? ` | עלות משוערת: ${Math.round(+it.cost)}` : ''));
  // an explicit density + area-span picture: the raw stop list alone lets the model
  // delete "the extra places" without noticing it emptied half the trip
  const perDay = [];
  for (let d = 1; d <= days; d++) perDay.push(items.filter((it) => it.day_number === d).length);
  const loadLine = `\nעומס נוכחי (תחנות ליום): ${perDay.map((c, i) => `יום ${i + 1}: ${c}`).join(' | ')}.`;
  const spanLine = areaNames.length > 1
    ? `\nפריסת האזורים כיום: ${areaNames.map((name) => {
        const ds = items.filter((it) => it.area === name).map((it) => it.day_number);
        return ds.length ? `${name}: ימים ${Math.min(...ds)}-${Math.max(...ds)}` : `${name}: אין תחנות`;
      }).join(' | ')}.`
    : '';
  const userMsg =
    `הטיול: "${title}" — ${dests.length ? destDescFull(dests) : destText}, ${days} ימים (1 עד ${days}).` +
    `\nהמסלול הנוכחי (כל שורה: #מזהה | יום | שעה | [קטגוריה] כותרת | מקום):\n${itemLines.join('\n') || '(המסלול עדיין ריק)'}` +
    loadLine + spanLine +
    `\nתיאור הטיול הקיים: ${description ? `"${description}"` : '(אין תיאור)'}` +
    (scopeNote ? `\n${scopeNote}` : '') +
    `\n\nבקשת השינוי של המטיילים: "${prompt}"`;

  const parsed = await aiJson({
    system: 'אתה עורך מסלולי טיולים. מקבל מסלול קיים ובקשת שינוי קצרה, ומחזיר אך ורק JSON לפי הסכמה: ops (רשימת פעולות) ו-summary (סיכום קצר וידידותי בעברית של מה שביצעת). ' +
      'התפקיד שלך הוא לבצע את הבקשה בפועל דרך פעולות על תחנות המסלול: add (הוספה), update (עדכון — כולל העברה ליום או שעה אחרים), delete (מחיקה). ' +
      'כמעט כל בקשה ניתנת למימוש דרך תחנות, גם אם לא נאמרה בהן המילה "תחנה": "יום רגוע יותר" = לדלל או להזיז תחנות; "עוד אוכל מקומי" = להוסיף תחנות אוכל; "להחליף את יום 3" = מחיקות והוספות באותו יום; "להתחיל מאוחר יותר" = לעדכן שעות; וכן הלאה. ' +
      'ברירת המחדל שלך היא לבצע: אל תחזיר ops ריק אם אפשר לממש את הבקשה, ולו חלקית, באמצעות פעולות על תחנות. בקשה כללית או עמומה — קבל החלטות סבירות בעצמך ותאר אותן ב-summary, במקום לשאול. ' +
      // the failure this guards against: "too crowded" answered with mass deletions,
      // leaving a few packed days and a tail of empty ones
      'מספר ימי הטיול קבוע ואינו משתנה בעריכה, ולכן אסור להשאיר יום ריק בתוך הטווח שאתה נוגע בו: בסוף העריכה לכל יום 2-4 תחנות (ביום מעבר בין ערים או ביום שהמטיילים ביקשו במפורש להשאיר פנוי — פחות). ' +
      'בקשות על קצב ועומס — "צפוף מדי", "פחות מקומות", "יותר רגוע", "יותר נינוח" — הן בקשות לפרוס מחדש, לא למחוק בכמות: המטיילים רוצים את אותו טיול בקצב נוח, על פני אותם ימים. סדר הפעולות הוא קודם פריסה ואחר כך מחיקה: הזז תחנות (update של day_number ו-time_label) מהימים העמוסים לימים הדלילים או הריקים, הרחב כל אזור לרצף ימים ארוך יותר עד שכל ימי הטיול מנוצלים, ורק את מה שנשאר עודף באמת — מחק. ' +
      'עריכה שמרוקנת ימים שלמים ומשאירה את שאר הימים עמוסים היא כישלון, גם אם מחקת בדיוק את מה שהתבקש. ' +
      'שמור על המבנה הגיאוגרפי: כל אזור תופס רצף ימים אחד ורציף, בלי לקפוץ הלוך ושוב בין ערים. אם אזור יורד מהטיול או מתכווץ — הרחב את שאר האזורים כך שיכסו יחד את כל ימי הטיול. בכל תחנה שהעברת ליום אחר עדכן גם את שדה area לאזור שיושב על אותו יום; ביום שבו מתחלף האזור תשב תחנת נסיעה אחת (קטגוריה: נסיעה) שמתארת את המעבר — הוסף אותה אם חסרה, ומחק תחנות נסיעה שכבר לא מתאימות לפריסה החדשה. ' +
      'לפני שאתה מחזיר, בדוק את עצמך: אין יום ריק בטווח שנגעת בו, כל אזור עדיין רצוף, והתחנות בכל יום מסודרות כרונולוגית לפי time_label. אם שינית את פריסת הימים או האזורים — תאר את החלוקה החדשה ב-summary. ' +
      'מחוץ לתחום שלך: תאריכי הטיול, תקציב, מלונות ותמונת הנושא. אל תדמה שינוי כזה דרך תחנות — הזזת הטיול כולו לתאריכים אחרים, למשל, אינה הזזת תחנות בין ימים (הימים ממוספרים 1 עד N ללא תלות בתאריך). ' +
      'בקשה מעורבת — בצע רק את חלק התחנות וציין ב-summary מה נשאר מחוץ לתחום. ' +
      'החזר ops ריק רק בשני מקרים: (1) הבקשה עוסקת אך ורק בדברים שמחוץ לתחום — ואז הסבר ב-summary בעדינות שכאן משנים רק את תחנות המסלול; (2) אי אפשר להבין מהבקשה שום כוונה — ואז שאל שאלת הבהרה קצרה ב-summary. ' +
      'שנה רק את מה שנוגע לבקשה ואל תיגע בשאר התחנות. ' +
      // the description is the one thing outside the stop list that can start lying
      // after an edit — but rewriting it on every tweak is noise, so null is the default
      'שדה description: ברירת המחדל היא null — התיאור הקיים נשאר כמו שהוא. החזר תיאור חדש רק אם השינוי שביצעת הפך את התיאור הקיים ללא נכון: הוא מזכיר עיר, אזור, אתר או סוג חוויה שכבר אינם בטיול; הוא מבטיח דגש שירד ממנו (למשל "טיול מוזיאונים" אחרי שהמוזיאונים נמחקו); או שהוא נוקב במספר ימים או ערים שכבר אינו נכון. ' +
      'ניסוח יפה יותר, סגנון או תוספת פרטים אינם סיבה להחליף תיאור, ותיאור שנשאר נכון גם אחרי השינוי נשאר על כנו. אם אין תיאור כלל — החזר null; כתיבת תיאור מאפס אינה חלק מהעריכה. ' +
      'תיאור חדש: 1-2 משפטים בעברית שמתארים בפועל מה יש בטיול — אילו יעדים ואיזה סוג חוויות — בלי סופרלטיבים ומילים נפוחות ("קסום", "מרהיב", "בלתי נשכח", "חלומי"), בלי אמוג\'ים ובלי לועזית מוטמעת בעברית. אם החלפת תיאור, ציין זאת במשפט קצר ב-summary. ' +
      'update/delete חייבים id של תחנה קיימת; ב-update החזר null בכל שדה שלא משתנה. ' +
      'add חייב title קצר בעברית; note טיפ פרקטי קצר בעברית; time_label בפורמט HH:MM; ' +
      'place_query באנגלית וכולל תמיד עיר ומדינה (למשל "Nishiki Market, Kyoto, Japan"), ורק למקום אמיתי וספציפי שניתן למצוא בגוגל מפות — לתחנה כללית (כמו "ארוחת ערב" בלי מקום מוגדר) החזר null; ' +
      'cost הוא הערכת עלות לאדם במטבע התקציב (מספר שלם) — מלא אותו בהוספת תחנה עם עלות אופיינית, והחזר null לתחנה חינמית או כשאין שינוי; ' +
      `category מתוך: ${AI_CATEGORIES.join(', ')}` +
      (areaNames.length > 1 ? `; area מתוך: ${areaNames.join(', ')}.` : '.'),
    user: userMsg,
    schemaName: 'trip_edit',
    maxTokens: 12000, // a full re-pacing is dozens of ops — a short budget truncates the JSON
    timeoutMs: 90000,
    ph,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'description', 'ops'],
      properties: {
        summary: { type: 'string' },
        description: { type: ['string', 'null'] }, // null = the existing one still holds
        ops: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'id', 'day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area', 'cost'],
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
              cost: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
  });
  if (!parsed) return null;
  return {
    summary: String(parsed.summary || '').slice(0, 300),
    description: parsed.description ? String(parsed.description).slice(0, 500).trim() || null : null,
    ops: Array.isArray(parsed.ops) ? parsed.ops.slice(0, opsCap) : [],
  };
}

router.post('/api/trips/code/:code/ai-edit', authOptional, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'עריכת AI לא זמינה כרגע' });
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'כתבו מה לשנות במסלול' });
    if (prompt.length > AI_EDIT_MAX_PROMPT) {
      return res.status(400).json({ error: `הבקשה ארוכה מדי — עד ${AI_EDIT_MAX_PROMPT} תווים` });
    }

    // optional scope: one area within a day range (multi-destination trips) —
    // validated against the trip's stored destinations, enforced on the ops below
    const dests = Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [];
    const areaNames = dests.map((d) => d.name);
    const area = b.area && areaNames.includes(b.area) ? b.area : null;
    let from = 1, to = trip.days, scopeNote = '';
    if (area) {
      from = Math.min(Math.max(parseInt(b.day_from, 10) || 1, 1), trip.days);
      to = Math.min(Math.max(parseInt(b.day_to, 10) || trip.days, from), trip.days);
      scopeNote = `החל את הבקשה אך ורק על אזור "${area}" בימים ${from} עד ${to}: ` +
        `כל תחנה שתוסיף תהיה באזור הזה ובטווח הימים הזה (שדה area: "${area}"), ואל תיגע בתחנות מחוץ לטווח. ` +
        `אם התבקשה בנייה מחדש — החלף את כל התחנות בטווח (מחיקות + הוספות), 3-4 תחנות ליום בסדר כרונולוגי.`;
    }

    // 3 AI edits a day per user (editing requires login, so req.user is always set here).
    // admins still get counted, but are never capped — same rule as /api/ai/itinerary
    const quotaKey = 'u' + req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const usage = aiEditUsage.get(quotaKey);
    const used = usage && usage.date === today ? usage.count : 0;
    const admin = await isAdmin(req);
    if (used >= AI_EDIT_DAILY_LIMIT && !admin) {
      return res.status(429).json({ error: 'ניצלתם את שלושת שינויי ה-AI להיום — אפשר להמשיך לערוך ידנית, או לנסות שוב מחר' });
    }

    const { rows: items } = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    const result = await aiEditOps({
      title: trip.title,
      destText: trip.destination,
      dests,
      days: trip.days,
      items,
      prompt,
      description: trip.description || '',
      scopeNote,
      // edits are single-call traces, but the id still ties retries apart in the UI
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (!result) return res.status(502).json({ error: 'ה-AI לא הצליח לעבד את הבקשה — נסו שוב עוד רגע' });
    aiEditUsage.set(quotaKey, { date: today, count: used + 1 }); // the model call is the budgeted resource

    const byId = new Map(items.map((it) => [it.id, it]));
    const inScope = (day) => !area || (day >= from && day <= to);
    let added = 0, updated = 0, removed = 0;
    await client.query('BEGIN');
    for (const op of result.ops) {
      if (op.action === 'delete' && byId.has(op.id)) {
        if (!inScope(byId.get(op.id).day_number)) continue;
        await client.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [op.id, trip.id]);
        removed++;
      } else if (op.action === 'update' && byId.has(op.id)) {
        const target = byId.get(op.id);
        if (!inScope(target.day_number)) continue;
        // a move must also land inside the scope, else drop the whole op
        const newDay = op.day_number != null ? clampDay(op.day_number, trip.days, target.day_number) : null;
        if (newDay != null && !inScope(newDay)) continue;
        const sets = [];
        const vals = [];
        const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
        if (newDay != null) add('day_number', newDay);
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
        if (op.cost != null) add('cost', cleanCost(op.cost));
        if (sets.length) {
          vals.push(op.id, trip.id);
          await client.query(
            `UPDATE trip_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND trip_id = $${vals.length}`, vals
          );
          updated++;
        }
      } else if (op.action === 'add' && op.title && String(op.title).trim()) {
        const day = clampDay(op.day_number, trip.days, from);
        if (!inScope(day)) continue;
        await client.query(
          `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, cost, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))`,
          [trip.id, day, cleanTime(op.time_label), String(op.title).slice(0, 200).trim(),
           op.note ? String(op.note).slice(0, 300) : null,
           op.place_query ? String(op.place_query).slice(0, 120) : null,
           AI_CATEGORIES.includes(op.category) ? op.category : 'אטרקציה',
           op.area ? String(op.area).slice(0, 80) : (area || null),
           cleanCost(op.cost)]
        );
        added++;
      }
    }

    // the description only follows the itinerary: an edit that changed nothing can't
    // have made it wrong, so it never gets rewritten on a no-op
    const changedItinerary = added + updated + removed > 0;
    const newDesc = changedItinerary && result.description
      && result.description !== (trip.description || '').trim() ? result.description : null;
    if (newDesc) await client.query('UPDATE trips SET description = $1 WHERE id = $2', [newDesc, trip.id]);
    await client.query('COMMIT');

    const fresh = await pool.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    // a day that had stops and lost all of them is almost always an edit gone wrong
    // (a "thin it out" answered with deletions) — say so instead of leaving the
    // traveller to scroll down and find the hole
    const hasNow = new Set(fresh.rows.map((it) => it.day_number));
    const emptied = [...new Set(items.map((it) => it.day_number))]
      .filter((d) => !hasNow.has(d)).sort((a, b) => a - b);
    const summary = (result.summary || 'בוצע') +
      (emptied.length ? ` (שימו לב: ${emptied.length > 1 ? 'ימים' : 'יום'} ${emptied.join(', ')} נשארו בלי תחנות — אפשר לבקש לפרוס מחדש את הטיול על כל הימים)` : '');

    res.json({
      summary,
      added, updated, removed,
      items: fresh.rows,
      description: newDesc, // null = unchanged, so the client leaves it alone
      remaining: admin ? null : AI_EDIT_DAILY_LIMIT - used - 1, // null = unlimited (admin)
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

module.exports = router;
