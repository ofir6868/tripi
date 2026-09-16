// AI itinerary builder + trip editor (OpenAI, server-side — the key never reaches the client)
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../lib/db');
const { authRequired, authOptional, isAdmin } = require('../lib/auth');
const { rateLimiter } = require('../lib/rate-limit');
const { tripWithEditAuth, cleanDestinations, isParticipant } = require('../lib/trips');
const { verifyPlaces } = require('../lib/places');
const { placePhoto } = require('../lib/place-photos');
const { fitItinerary } = require('../lib/hours-fit');
// the Hebrew country name → ISO code table the client uses for flags, read here to tell
// whether a stop landed in a country the traveller actually picked. It lives under
// public/ because the browser and the service worker load it too — one table, so a
// country can never be spelled one way for a flag and another way for this check.
const COUNTRIES = require('../public/js/countries.js');
const posthog = require('../lib/posthog');
const { dailyQuota, exhausted } = require('../lib/quota');

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
const AI_CATEGORIES = ['אטרקציה', 'אוכל', 'טבע', 'ים', 'תרבות', 'קניות', 'לינה', 'נוף', 'חיי לילה', 'נסיעה', 'היסטוריה', 'אמנות', 'עיר'];
// cost estimates arrive as loose model output — keep only positive, sane integers
const cleanCost = (v) => (Number.isFinite(+v) && +v > 0 ? Math.min(Math.round(+v), 999999999) : null);
// the model sometimes writes the STRING "null" where it means no place — on 2026-08-23
// one such string geocoded to Nully, a village in France, and a Tokyo workshop shipped
// with a French pin. Any spelling of "no place" is null, never a query.
const NO_PLACE_RE = /^(null|none|n\/?a|אין|-+)$/i;
const cleanPlaceQuery = (v, max = 120) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !NO_PLACE_RE.test(s) ? s.slice(0, max) : null;
};
const buildMeter = dailyQuota('build', 20); // builds per user per day
const promptResolveLimit = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  error: 'יותר מדי בקשות תכנון — נסו שוב בעוד כמה דקות',
});

// Never reaching OpenAI is not the same as OpenAI answering badly, and it is worth
// exactly one more try: opening a fresh TLS connection to api.openai.com intermittently
// exceeds undici's 10s connect timeout, and the call that pays for it is whichever one
// comes first after an idle stretch. Left alone it silently drops a clarifying round or
// fails a whole build. A model that answered — even with an error status — is not retried.
const CONNECTION_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
]);
const isConnectionError = (err) => err && err.name !== 'AbortError'
  && CONNECTION_ERRORS.has(err.cause && err.cause.code);

// the one OpenAI caller: chat completion forced into a strict JSON schema.
// Returns the parsed object, or null on any failure (HTTP error, timeout, bad
// JSON) — unless `required`, which rethrows so the route can distinguish an
// aborted call (timeout message) from the rest.
async function aiJson({ system, user, schemaName, schema, maxTokens, model = AI_MODEL_WEAK, timeoutMs = 30000, required = false, ph = null }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  // PostHog LLM analytics: one $ai_generation per OpenAI call, full input/output
  // included — cost is computed on their side from model + token counts, and
  // ph.traceId groups the calls of a single build/edit into one trace. A retried call
  // reports twice on purpose: the failure is part of what the trace should show.
  const aiEvent = (started, extra) => {
    if (!ph) return;
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

  // each attempt gets its own controller — reusing an aborted signal would fail the
  // retry before it left the process
  const attempt = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
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
        aiEvent(started, { $ai_http_status: aiRes.status, $ai_is_error: true, $ai_error: errBody.slice(0, 300) });
        return { failed: true };
      }
      const data = await aiRes.json();
      const content = data.choices[0].message.content;
      aiEvent(started, {
        $ai_http_status: aiRes.status,
        $ai_output_choices: [{ role: 'assistant', content }],
        $ai_input_tokens: data.usage?.prompt_tokens ?? null,
        $ai_output_tokens: data.usage?.completion_tokens ?? null,
      });
      return { value: JSON.parse(content) };
    } catch (err) {
      // a silent null here is hard to tell apart from "the AI had nothing to say" —
      // a transient `fetch failed` once cost an hour of blaming the prompt
      console.error(`OpenAI ${schemaName} failed`, err.name, err.cause ? (err.cause.code || err.cause.message) : err.message);
      aiEvent(started, {
        $ai_is_error: true,
        $ai_error: err.name === 'AbortError' ? `aborted after ${timeoutMs}ms timeout` : String(err.message || err).slice(0, 300),
      });
      return { failed: true, err };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt();
  if (res.failed && isConnectionError(res.err)) {
    console.warn(`OpenAI ${schemaName} retrying after ${res.err.cause.code}`);
    res = await attempt();
  }
  if (!res.failed) return res.value;
  if (required) throw (res.err || new Error('openai failed'));
  return null;
}

// ---------- homepage free-text intake ----------
// The homepage accepts a travel request rather than requiring an exact place name.
// Resolve only the destinations here; the complete request travels to the wizard as
// notes, so constraints such as "without a car" are still available to the builder.
router.post('/api/ai/resolve-trip-prompt', promptResolveLimit.middleware, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'תכנון AI לא זמין כרגע' });
    const prompt = String(req.body?.prompt || '').trim().slice(0, 500);
    if (prompt.length < 2) return res.status(400).json({ error: 'כתבו בקצרה איזה טיול תרצו' });

    const result = await aiJson({
      system:
        'אתה מפענח בקשות לתכנון טיול. כל יעד בתשובה חייב להתאים לביטוי גאוגרפי מפורש בבקשת המשתמש. ' +
        'שמור את רמת הפירוט שהמשתמש כתב: אזור נשאר אזור ומדינה נשארת מדינה; אל תחליף אותם בערים מומלצות ואל תרחיב למסלול. ' +
        'החזר שמות תצוגה טבעיים בעברית. לעיר או אזור החזר גם את המדינה בעברית; למדינה החזר אותה גם בשם וגם במדינה. ' +
        'לדוגמה, "שבוע בצפון איטליה" מחזיר יעד בשם "צפון איטליה" ומדינה "איטליה", לא את קומו או ורונה. ' +
        'אם אין בבקשה ביטוי גאוגרפי, החזר רשימה ריקה. שמור על סדר היעדים שהמשתמש כתב.',
      user: prompt,
      schemaName: 'trip_prompt_destinations',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['destinations'],
        properties: {
          destinations: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'country'],
              properties: {
                name: { type: 'string' },
                country: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      maxTokens: 350,
      timeoutMs: 15000,
      required: true,
    });

    const destinations = cleanDestinations(result?.destinations)
      .slice(0, 6)
      .map((d) => ({ name: d.name, country: d.country || null, lat: null, lon: null }));
    if (!destinations.length) {
      return res.status(422).json({ error: 'לא הצלחתי לזהות יעד בבקשה — נסו לציין עיר, אזור או מדינה' });
    }
    res.json({ destinations, prompt });
  } catch (err) {
    console.error('trip prompt resolution failed', err);
    res.status(500).json({
      error: err.name === 'AbortError'
        ? 'ה-AI התעכב יותר מדי — נסו שוב'
        : 'לא הצלחתי להבין את הבקשה כרגע — נסו שוב בעוד רגע',
    });
  }
});

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

// destinations as "עיר (מדינה)" — the country ALWAYS travels with the city name.
// An area carries the cities that place it too: "אזור קיוטו (יפן: קיוטו, נארה)". Without
// them the AI is ordering opaque labels, and it put Hiroshima between Tokyo and Kyoto —
// straight past Kyoto and back again.
function destDescFull(dests) {
  return dests.map((d) => {
    const inside = [
      d.country && d.country !== d.name ? d.country : null,
      (d.cities || []).length ? d.cities.join(', ') : null,
    ].filter(Boolean);
    return inside.length ? `${d.name} (${inside.join(': ')})` : d.name;
  }).join(', ');
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

// the region-edit screen round-trip: the day→area blocks the traveller painted (or
// accepted as recommended) on the wizard's calendar. Validated for exact contiguous
// coverage of the requested range; unlike aiPlanBlocks an area MAY appear more than
// once — painting קיוטו→טוקיו→קיוטו is legitimate — but the block count is capped,
// because every block is its own generation call.
const MAX_PRESET_BLOCKS = 12;
function cleanPresetPlan(raw, { from, to, areaNames, broadSingle }) {
  const blocks = raw.slice(0, MAX_PRESET_BLOCKS + 1).map((b) => ({
    area: String(b?.area || '').slice(0, 60).trim(),
    from: parseInt(b?.from, 10),
    to: parseInt(b?.to, 10),
    cities: (Array.isArray(b?.cities) ? b.cities : [])
      .slice(0, 3).map((c) => String(c).slice(0, 60).trim()).filter(Boolean),
  })).sort((a, b) => a.from - b.from);
  if (!blocks.length || blocks.length > MAX_PRESET_BLOCKS) return null;
  if (blocks.some((b) => !b.area || !Number.isInteger(b.from) || !Number.isInteger(b.to) || b.to < b.from)) return null;
  if (new Set(blocks.map((b) => b.area)).size > MAX_REGIONS) return null;
  // painted area names are free-form for a broad single destination (they came from
  // the AI's own split); for a multi-destination trip they must be the destinations
  if (!broadSingle && blocks.some((b) => !areaNames.includes(b.area))) return null;
  if (blocks[0].from !== from || blocks[blocks.length - 1].to !== to) return null;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].from !== blocks[i - 1].to + 1) return null;
  }
  return blocks;
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
  const parsed = await call(); // aiJson retries a connection failure on its own
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
async function aiClarify({ dests, from, to, interestList, freeText, ph, presetAreas = null }) {
  const days = to - from + 1;
  // the caller only sends two shapes here: one broad destination (a country pick, or
  // free text we can't classify), or several destinations. Each shape has its own
  // structural unknown, so each branch names only that one — last in the message,
  // which is where this model actually follows an instruction.
  // presetAreas = the region-edit screen already settled the day→area split, so the
  // region question is off the table — only the other unknowns (landing city,
  // transfers) are worth asking about.
  const broadSingle = !presetAreas && dests.length === 1 && (!dests[0].country || dests[0].country === dests[0].name);
  // roughly a region per 5–7 days: below that the trip has room for one area and the
  // question is "which one", above it the question is "which to combine". Pure day
  // arithmetic, so the server decides it — asked to judge this, the model answered
  // "combine" for a 3-day Malta trip.
  const combine = broadSingle && days >= COMBINE_REGIONS_FROM_DAYS;
  const userMsg =
    `מתכננים טיול של ${days} ימים (ימים ${from} עד ${to}) ב: ${destDescFull(dests)}.` +
    distancesText(dests) +
    tripPrefsText({ interestList, freeText }) +
    (presetAreas
      ? `\nחלוקת הימים לאזורים כבר נקבעה על ידי המטיילים: ${presetAreas.join(' ← ')} — אל תשאל אילו אזורים לכלול או איך לחלק את הימים.`
      : '') +
    `\nלפני שמחלקים את הימים בין האזורים: חסר לך פרט שבלעדיו החלוקה עלולה לצאת שגויה? ` +
    `ברירת המחדל היא להחזיר רשימה ריקה — כל שאלה חייבת להיות על מבנה המסלול עצמו (איזה אזור, סדר האזורים, חלוקת הימים או המעברים ביניהם), ` +
    `לכל היותר 2 שאלות קצרות בעברית, סוג "choice" עם options קצרות (עדיף) או "text" בלי options.` +
    (broadSingle
      ? `\nהפרט היחיד שחסר כאן הוא אילו אזורים ייכנסו למסלול — שאלה אחת בלבד, ` +
        // the traveller can tick one option or several, and the question has to read
        // like the thing they're about to do — a single-select that opens with
        // "אילו אזורים" invites a multi-pick the modal won't allow
        (combine
          ? `שנפתחת במילים "אילו אזורים" ושואלת אילו אזורים לשלב ב-${days} הימים (המטיילים יסמנו כמה).`
          : `שנפתחת במילים "באיזה אזור" ושואלת באיזה אזור להתמקד ב-${days} הימים (המטיילים יסמנו אחד בלבד).`) +
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
  { name: 'בריסל — הגרנד פלאס', url: COVER_U('photo-1573299867162-6e895f64bf23') },
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
  'בריסל — הגרנד פלאס': ['בריסל', 'בלגיה', 'brussels', 'belgium'],
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

// gallery gate: one cheap copy-edit pass when a trip enters the public gallery.
// AI descriptions occasionally leak a foreign word mid-Hebrew ("עם Schwerpunkt על…")
// and the gallery is the shop window. Description only — the title is the owner's
// voice and is never rewritten. Fail-open by construction: aiJson returns null on
// any failure and the publish already succeeded before this runs.
const proofreadDone = new Map(); // tripId → date — one model call per trip per day, whatever the caller does
async function proofreadPublicTripCopy(trip, userId) {
  if (!process.env.OPENAI_API_KEY || !trip.description) return;
  const today = new Date().toISOString().slice(0, 10);
  if (proofreadDone.get(trip.id) === today) return;
  proofreadDone.set(trip.id, today);
  try {
    const out = await aiJson({
      system: 'אתה עורך לשוני של אתר טיולים בעברית. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
      user:
        `תיאור של טיול ל${trip.destination} שעומד להתפרסם בגלריה ציבורית:\n"${trip.description}"\n` +
        'תקן אך ורק שגיאות: מילים בשפה זרה שנשתלו בטעות בתוך העברית (החלף במילה עברית מתאימה; שמות מקומות נשארים), ' +
        'שגיאות כתיב ותחביר שבור. אל תשנה סגנון, אל תוסיף מידע, אל תקצר. ' +
        'אם התיאור תקין — החזר אותו בדיוק כמו שהוא, אות באות.',
      schemaName: 'gallery_copy_edit',
      maxTokens: 400,
      ph: { distinctId: 'user_' + userId, traceId: randomUUID() },
      schema: {
        type: 'object', additionalProperties: false, required: ['description'],
        properties: { description: { type: 'string' } },
      },
    });
    const clean = out && String(out.description || '').trim().slice(0, 500);
    if (!clean || clean === trip.description) return;
    // compare-and-swap: the model call takes seconds, and an edit (or the AI-edit
    // undo) may have rewritten the description meanwhile — never clobber newer text
    await pool.query(
      'UPDATE trips SET description = $1 WHERE id = $2 AND description = $3',
      [clean, trip.id, trip.description]
    );
  } catch (err) {
    console.error('gallery proofread failed:', err.message);
  }
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

// Every place the model proposed gets geocoded (lib/places.js, keyless OSM) before the
// block is returned — the 2026-08 places audit measured ~5% of stops naming places that
// do not exist ("Vanora", "Kyuushu Castle"), clustered in restaurants and secondary
// regions. What the geocoder can't find goes back to the model once, listed, for a
// correction; whatever still fails loses its place_query — a stop without a pin beats a
// pin on a place that isn't there, even at the cost of the occasional real hole-in-the-
// wall OSM doesn't know. Geocoder trouble ('skipped') fails open: no verdict, no change.
//
// entries: [{ title, area?, place_query }] — mutated in place: place_query becomes the
// corrected query, stays as-is, or turns null when nothing real could stand behind it,
// and lat/lon are attached to every place that verified (the geocoder already paid for
// them; the client and the day-spread check below both live off stored coordinates).
//
// opts.flagMore(entries), if given, runs after coordinates are attached and returns
// additional entries to send for correction even though their place EXISTS — each
// carrying `reason` (shown to the model) and optionally `near` {lat, lon, km}, a
// circle an accepted replacement must fall inside.
async function repairPlaces(entries, { where, ph, flagMore, dests }) {
  try {
    const queries = [...new Set(entries.map((e) => e.place_query).filter(Boolean))];
    if (!queries.length) return;
    let results = await verifyPlaces(queries);
    // 'skipped' means the geocoder never answered — the one verdict that says nothing
    // about the place. It used to pass in silence, which is how a twenty-minute Photon
    // outage on 2026-08-19 produced a day of trips with no pins and no verification and
    // left no trace anywhere. Wait out the breaker once, ask again, and say so either way.
    const skipped = () => [...results].filter(([, r]) => r.verdict === 'skipped').map(([q]) => q);
    let quiet = skipped();
    if (quiet.length) {
      console.warn(`place verification: geocoder silent on ${quiet.length}/${queries.length} in "${where}" — retrying`);
      await new Promise((r) => setTimeout(r, 9000)); // just past the breaker window
      const retry = await verifyPlaces(quiet);
      results = new Map([...results, ...retry]);
      quiet = skipped();
      if (quiet.length) {
        console.error(`place verification UNAVAILABLE: ${quiet.length}/${queries.length} unverified in "${where}" — stops keep their place_query and no coordinates`);
      }
    }
    const setGeo = (e, r) => {
      if (!r || r.verdict !== 'ok' || !r.best) return;
      if (r.best.lat != null) { e.lat = r.best.lat; e.lon = r.best.lon; }
      // which country answered, and how to say where that is — both already paid for by
      // the same lookup, and the only way to catch a place that is entirely real and
      // entirely on the wrong trip
      e.cc = r.best.cc || null;
      e.geoWhere = r.best.where || null;
      // the id Google vouched with (second-opinion passes only) — stored on the stop,
      // it makes the maps link deterministic and every future details lookup direct
      if (r.best.place_id) e.google_place_id = r.best.place_id;
      // and the OSM element the geocoder matched — the free key to the place's
      // opening_hours (lib/opening-hours.js), already paid for by this same lookup
      e.osm_type = r.best.osm_type || null;
      e.osm_id = r.best.osm_id || null;
    };
    for (const e of entries) if (e.place_query) setGeo(e, results.get(e.place_query));
    const unfound = (q) => { const r = results.get(q); return r && (r.verdict === 'mismatch' || r.verdict === 'none'); };
    const failing = entries.filter((e) => e.place_query && unfound(e.place_query));
    for (const extra of flagMore ? flagMore(entries) : []) {
      if (!failing.includes(extra)) failing.push(extra);
    }
    if (!failing.length) return;
    // Every replacement must land inside the trip's geography, whatever the original
    // sin: a "not found" stop's fix used to be tested for existence only, which let
    // the corrector answer a flagged Tokyo stop with "Chidori Bunka Senta, Chiyoda
    // City, Tokyo, Japan" — a real name the geocoder found 800km away in Iwakuni —
    // and once with the string "null", which is a village in France. The circle is
    // the day's own cluster when the day has one; a travel day is the exception a
    // tight circle would wrong — its stops legitimately straddle two areas — so
    // there (and when the day can't say where it is) the replacement may land near
    // ANY of the trip's destinations instead.
    const failSet = new Set(failing);
    const locatedDests = (dests || []).filter((d) => d && d.lat != null && d.lon != null);
    const anyDest = locatedDests.length ? { points: locatedDests, km: AREA_REACH_KM } : null;
    const allowed = tripCountryCodes(dests);
    const travelDays = new Set(entries.filter((x) => x.category === 'נסיעה').map((x) => x.day_number));
    const defaultNear = (e) => {
      if (e.travelDay || (e.day_number != null && travelDays.has(e.day_number))) return anyDest;
      const mates = entries.filter((o) => o !== e && !failSet.has(o) && o.day_number != null &&
        o.day_number === e.day_number && o.lat != null && o.lon != null);
      if (mates.length >= 2) return {
        lat: mates.reduce((s, o) => s + o.lat, 0) / mates.length,
        lon: mates.reduce((s, o) => s + o.lon, 0) / mates.length,
        km: DAY_SPREAD_KM,
      };
      return anyDest;
    };
    for (const e of failing) {
      if (!e.near) e.near = defaultNear(e);
      if (!e.allowedCc && allowed) e.allowedCc = allowed;
    }
    console.log(`place verification: ${failing.length}/${queries.length} flagged in "${where}":`,
      failing.map((e) => `${e.place_query}${e.reason ? ` (${e.reason})` : ''}`).join(' | '));

    const parsed = await aiJson({
      system: 'אתה בודק עובדות של מסלולי טיולים. אתה מחזיר אך ורק JSON תקין לפי הסכמה.',
      user:
        `במסלול טיול ב"${where}" יש תחנות בעייתיות — המקום לא נמצא במפה (שם שגוי או מקום שלא קיים), או שהוא רחוק מדי משאר תחנות היום שלו, או שהוא נמצא במדינה שאינה חלק מהטיול:\n` +
        failing.map((e, i) => `${i}. "${e.title}"${e.area && e.area !== where ? ` (אזור: ${e.area})` : ''} — place_query: "${e.place_query}" — ${e.reason || 'לא נמצא במפה'}`).join('\n') +
        `\nהחזר לכל תחנה (לפי index) אחת משתיים: place_query מתוקן — מקום אמיתי, מוכר וקיים שמשרת את כוונת התחנה, באנגלית ובפורמט "Name, City, Country"; ` +
        `לתחנה רחוקה — מקום חלופי מאותו סוג שנמצא ליד שאר תחנות היום. ` +
        `לתחנה שנמצאת במדינה אחרת — מקום חלופי מאותו סוג בתוך אזור הטיול עצמו, אף פעם לא במדינה שממנה הגיעה התחנה השגויה. ` +
        `או place_query = null אם לתחנה אין מקום ספציפי אמיתי (ארוחה כללית, סיור חופשי). אל תמציא: אם אינך בטוח שהמקום קיים — החזר null. ` +
        `לצד כל תיקון החזר גם title חדש בעברית, קצר ובסגנון שם התחנה המקורי: למקום חלופי — תיאור שנוקב במקום החדש; ל-place_query = null — ניסוח כללי של כוונת התחנה, בלי שם המקום שלא נמצא. ` +
        `החזר title = null רק כששם התחנה המקורי לא נוקב במקום שהוחלף, ולכן נשאר נכון כמו שהוא. `,
      schemaName: 'place_fixes',
      maxTokens: 1500,
      model: AI_MODEL_STRONG,
      ph,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['fixes'],
        properties: {
          fixes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'place_query', 'title'],
              properties: {
                index: { type: 'integer' },
                place_query: { type: ['string', 'null'] },
                // the fix's other half: a corrected stop usually has a title still
                // naming the place that was just replaced or removed ("שוק נישיקי"
                // standing on a Nakamise pin reads as a Kyoto stop in Asakusa), so
                // the corrector rewrites it; null keeps the original
                title: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    });
    // a stop already known to be in the wrong country is wrong whether or not anything
    // can be suggested in its place — it goes even when the corrector never answers
    const strike = (e) => { e.place_query = null; e.lat = null; e.lon = null; e.google_place_id = null; if (e.dropIfUnfixed) e.drop = true; };
    if (!parsed) { // the corrector failing is not a reason to fail the build
      const doomed = failing.filter((e) => e.dropIfUnfixed);
      doomed.forEach(strike);
      if (doomed.length) console.log(`place verification: corrector unavailable — ${doomed.length} removed in "${where}"`);
      return;
    }

    const fixByIndex = new Map();
    const titleByIndex = new Map();
    for (const f of parsed.fixes || []) {
      if (!Number.isInteger(f.index) || f.index < 0 || f.index >= failing.length) continue;
      fixByIndex.set(f.index, cleanPlaceQuery(f.place_query));
      if (typeof f.title === 'string' && f.title.trim()) titleByIndex.set(f.index, f.title.slice(0, 200).trim());
    }
    // the replacements get the same check — a second invented name is how this loop
    // would otherwise reintroduce the exact failure it exists to stop — and a
    // replacement for a far stop must actually land inside its day's circle
    const replacements = [...new Set([...fixByIndex.values()].filter(Boolean))];
    const recheck = replacements.length ? await verifyPlaces(replacements) : new Map();
    let repaired = 0;
    failing.forEach((e, i) => {
      const fix = fixByIndex.get(i) || null;
      const r = fix ? recheck.get(fix) : null;
      let good = r && (r.verdict === 'ok' || r.verdict === 'skipped');
      if (good && e.near && r.verdict === 'ok' && r.best && r.best.lat != null) {
        good = e.near.points
          ? e.near.points.some((p) => haversineKm(p, r.best) <= e.near.km)
          : haversineKm(e.near, r.best) <= e.near.km;
      }
      // and a stop sent back for being in the wrong country cannot return from another
      // one — the model likes to answer a Paris stop with a Brussels stop
      if (good && e.allowedCc && r.verdict === 'ok' && r.best && r.best.cc) {
        good = e.allowedCc.has(r.best.cc);
      }
      if (good) {
        e.place_query = fix;
        if (r.verdict === 'ok' && r.best && r.best.lat != null) { e.lat = r.best.lat; e.lon = r.best.lon; }
        else { e.lat = null; e.lon = null; }
        e.google_place_id = (r.verdict === 'ok' && r.best && r.best.place_id) ? r.best.place_id : null;
        e.osm_type = (r.verdict === 'ok' && r.best) ? (r.best.osm_type || null) : null;
        e.osm_id = (r.verdict === 'ok' && r.best) ? (r.best.osm_id || null) : null;
        // the title follows the place: left as written, a repaired stop keeps naming
        // the place it no longer points at ("שוק נישיקי" standing on a Nakamise pin)
        if (titleByIndex.has(i)) e.newTitle = titleByIndex.get(i);
        repaired++;
      } else {
        // a stop whose place merely isn't in OSM keeps its slot in the day — losing the
        // pin is the smaller loss. A stop in a country nobody picked has no such
        // defence: it is not this trip's stop at all, so the caller is told to drop it.
        // The corrector's own "no real place here" comes with a title phrased for a
        // placeless stop and it applies; a replacement that failed the recheck does
        // not — its title names the very place that was just rejected.
        if (fixByIndex.has(i) && fixByIndex.get(i) === null && titleByIndex.has(i)) e.newTitle = titleByIndex.get(i);
        strike(e);
      }
    });
    const removed = failing.filter((e) => e.drop).length;
    console.log(`place verification: ${repaired} repaired, ${failing.length - repaired - removed} unpinned, ${removed} removed in "${where}"`);
  } catch (err) {
    console.warn('place verification skipped:', err.message); // never the caller's problem
  }
}

// The other thing coordinates buy: a day's stops must sit near each other. 150km
// clears real day-trips (Nikko from Tokyo is ~125) while catching the class the audit
// saw — a Hokkaido waterfall on an Osaka day, right name, wrong island. A day with a
// travel stop is exempt: spanning two cities is that day's whole point. The criterion
// is nearest-neighbor, not distance-to-mean: a misplaced stop is far from ALL its
// day-mates, while a mean would be dragged toward the outlier and convict the honest
// stops around it. Under three located stops there's no majority to say where the day
// is, so nobody gets convicted. Returns the flagged entries with reason + near set.
const DAY_SPREAD_KM = 150;
// the same reach, applied to the whole block rather than one day: a stop brought back
// from another country has to land in the area this block is actually about
const AREA_REACH_KM = DAY_SPREAD_KM;
function daySpreadOutliers(items) {
  const flagged = [];
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
    byDay.get(it.day_number).push(it);
  }
  for (const [, dayItems] of byDay) {
    if (dayItems.some((it) => it.category === 'נסיעה')) continue;
    const located = dayItems.filter((it) => it.lat != null && it.lon != null);
    if (located.length < 3) continue;
    const minDist = (it) => Math.min(...located.filter((o) => o !== it).map((o) => haversineKm(it, o)));
    const outliers = located.filter((it) => minDist(it) > DAY_SPREAD_KM);
    const anchor = located.filter((it) => !outliers.includes(it));
    if (!outliers.length || anchor.length < 2) continue; // no reliable "rest of the day" to point at
    const center = {
      lat: anchor.reduce((s, o) => s + o.lat, 0) / anchor.length,
      lon: anchor.reduce((s, o) => s + o.lon, 0) / anchor.length,
    };
    for (const it of outliers) {
      it.reason = `נמצא ~${Math.round(haversineKm(it, center))} ק"מ משאר תחנות היום שלו`;
      it.near = { lat: center.lat, lon: center.lon, km: DAY_SPREAD_KM };
      flagged.push(it);
    }
  }
  return flagged;
}

// The failure the geocoder cannot see on its own: a stop that is a real, findable
// place — in a country nobody picked. "Louvre, Paris, France" verifies perfectly; it
// just belongs to somebody else's trip. The geocoder already says which country
// answered, and the trip's own destinations say which countries were chosen, so the
// two together name the mistake exactly.
//
// Judgement is refused unless it can be complete: one destination whose country can't
// be resolved (free text, an unusual spelling) means the allowed set is unknown, and an
// unknown allowed set convicts honest stops. Silence beats a wrong verdict here.
function tripCountryCodes(dests) {
  const names = (dests || []).map((d) => d && (d.country || d.name)).filter(Boolean);
  if (!names.length) return null;
  const ccs = names.map((n) => COUNTRIES.ccByName(String(n).trim()));
  return ccs.every(Boolean) ? new Set(ccs) : null;
}

// flagMore-shaped (see repairPlaces): the stops sitting outside those countries, each
// asked to come back as something of the same kind inside the trip's own area — and
// marked to be dropped rather than merely unpinned if it can't.
//
// An unpicked country is not on its own a mistake, which the 2026-08-20 sweep of live
// trips showed in its only two candidates. The Vatican Museums, country code "va", on a
// trip to Rome — the Vatican, two kilometres from the hotel. And "Food with Love -
// Cooking School, Osaka, Japan", which the geocoder answered with a school in San Jose,
// California: the itinerary asked for Osaka, the *match* went to another continent.
// Neither is a stop in the wrong country, so three things have to hold together before
// one is called that: the border crossed, every destination left behind (within a day's
// reach, another country is a day trip), and the query itself naming the country the
// geocoder answered from — that last one is what separates a model that wandered off
// from a matcher that missed. A bad pin is the day-spread check's business, not this.
function foreignCountryStops(entries, dests, areaName = null) {
  const allowed = tripCountryCodes(dests);
  if (!allowed) return [];
  const located = (dests || []).filter((d) => d && d.lat != null);
  const anchor = (areaName && located.find((d) => d.name === areaName)) || located[0] || null;
  // "United States" against "…, Osaka, Japan" — the text never asked to leave Japan
  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const queryNamesItsCountry = (e) => {
    const country = flat((e.geoWhere || '').split(',').pop());
    return !!country && flat(e.place_query).includes(country);
  };
  const flagged = [];
  for (const e of entries) {
    if (!e.cc || allowed.has(e.cc)) continue;
    if (e.lat != null && located.some((d) => haversineKm(e, d) <= AREA_REACH_KM)) continue;
    if (!queryNamesItsCountry(e)) continue;
    e.reason = `המקום נמצא ב-${e.geoWhere} — מחוץ למדינות הטיול`; // geoWhere is what named the country above
    if (anchor) e.near = { lat: anchor.lat, lon: anchor.lon, km: AREA_REACH_KM };
    e.allowedCc = allowed;
    e.dropIfUnfixed = true;
    flagged.push(e);
  }
  return flagged;
}

// one OpenAI call for ONE area and a fixed day range — the shape that stays coherent
async function aiGenerateBlock({ dests, area, from, to, interestList, freeText, answers, transferFrom, existing = [], ph }) {
  // every block gets the strong model: the 2026-08 places audit put weak-model blocks
  // at 19-38% unfound places against 4-11% on the strong one — short trips were the
  // worst offenders, not the safe case. The itinerary is the product; the weak model
  // stays for the cheap structured calls around it.
  const model = AI_MODEL_STRONG;
  let userMsg =
    `בנה מסלול טיול מפורט לימים ${from} עד ${to} (כולל) באזור "${area}" בלבד, מתוך טיול שכולל את: ${destDescFull(dests)}. ` +
    `כל התחנות חייבות להיות באזור "${area}" ובשדה area לכתוב בדיוק "${area}". ` +
    `אסור לשבץ תחנות מאזורים אחרים בטווח הימים הזה.`;
  // the area rule alone leaves room for a famous place "nearby" that happens to be
  // across a border — naming the countries closes it, and costs one line of prompt
  const tripCountryNames = [...new Set((dests || []).map((d) => d && d.country).filter(Boolean))];
  if (tripCountryNames.length) {
    userMsg += ` כל התחנות חייבות להיות בתוך ${tripCountryNames.join(' / ')} — אסור לשלב מקום ממדינה אחרת.`;
  }
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
  // the planning chat settles one or two anchors a day with the traveller and then
  // asks for "the rest": those anchors are the day's spine — the block is built
  // around them, never over them, and only the complement comes back
  const anchors = existing.filter((it) => it.day_number >= from && it.day_number <= to);
  if (anchors.length) {
    userMsg += `\nתחנות שהמטיילים כבר קבעו בימים האלה (הן נשארות בדיוק כמו שהן — אל תחזיר אותן ואל תציע כפילות שלהן): ` +
      anchors.map((it) => `יום ${it.day_number}${it.time_label ? ' ' + it.time_label : ''}: ${it.title}${it.category === 'נסיעה' ? ' (נסיעה)' : ''}`).join(' | ') +
      `. השלם סביבן: לכל יום החזר רק את התחנות החסרות כדי שיהיו בו יחד 3-4 תחנות, בשעות שמסתדרות עם מה שכבר קבוע, ובאותו אזור. ` +
      `ביום שכבר יש בו תחנת נסיעה אל תוסיף תחנת נסיעה נוספת.`;
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
    .map((it) => {
      const q = cleanPlaceQuery(it.place_query, 90);
      return {
        day_number: it.day_number,
        time_label: cleanTime(it.time_label),
        title: String(it.title).slice(0, 200),
        note: it.note ? String(it.note).slice(0, 300) : null,
        place_query: q ? withContext(q) : null,
        category: AI_CATEGORIES.includes(it.category) ? it.category : 'אטרקציה',
        area,
        cost: cleanCost(it.cost),
      };
    });
  // travel stops are mandatory between areas: if the model skipped the נסיעה stop
  // (or labeled it something else), synthesize one so the trip never teleports
  const hasTravel = (d) => cleaned.some((it) => it.day_number === d && it.category === 'נסיעה')
    || anchors.some((it) => it.day_number === d && it.category === 'נסיעה');
  if (transferFrom && !hasTravel(from)) {
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
  // both flaggers, foreign second: a stop that is BOTH far from its day and in the
  // wrong country is the wrong-country one — that reason is the one worth telling the
  // corrector, and the one that decides what happens if the correction fails
  await repairPlaces(cleaned, {
    where: area,
    ph,
    dests,
    flagMore: (entries) => {
      const flagged = daySpreadOutliers(entries);
      for (const e of foreignCountryStops(entries, dests, area)) {
        if (!flagged.includes(e)) flagged.push(e);
      }
      return flagged;
    },
  });
  // the repairs just attached new pins, and a day that was too sparse to judge before
  // may have its majority now: an Osaka park on a Tokyo day shipped exactly that way —
  // two pins on its day at flag time, three after the repairs. One more look with the
  // same rules (travel days stay exempt); two passes total, never a loop.
  if (daySpreadOutliers(cleaned).length) {
    await repairPlaces(cleaned, { where: area, ph, dests, flagMore: (entries) => daySpreadOutliers(entries) });
  }
  for (const it of cleaned) if (it.newTitle) it.title = it.newTitle;
  const kept = cleaned.filter((it) => !it.drop);
  if (kept.length !== cleaned.length) {
    console.log(`block "${area}": dropped ${cleaned.length - kept.length} stop(s) that stayed outside the trip's countries`);
  }
  // the working notes between the flagger and the corrector — the items now travel to
  // the client and the DB, which have no business seeing them
  for (const it of kept) {
    delete it.reason; delete it.near; delete it.cc;
    delete it.geoWhere; delete it.allowedCc; delete it.dropIfUnfixed; delete it.newTitle;
  }
  return kept;
}

// ---------- pre-build region planning: the wizard's region-edit screen ----------
// A long trip shows its recommended day→area split on a calendar BEFORE any stop is
// generated. This runs ONLY the split — the same region + allocation logic the full
// build uses — and returns it for painting; the (possibly repainted) result comes
// back to /api/ai/itinerary as `plan`. Like the clarifying round it costs no daily
// build quota: the traveller is still deciding, and the build that follows counts.
router.post('/api/ai/plan-regions', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'בניית AI לא זמינה כרגע' });

    const { destinations, day_from, day_to, interests, notes } = req.body || {};
    const interestList = (Array.isArray(interests) ? interests : [])
      .slice(0, 15).map((s) => String(s).slice(0, 40).trim()).filter(Boolean);
    const freeText = notes ? String(notes).slice(0, 500).trim() : '';
    const dests = cleanDestinations(destinations);
    if (!dests.length) return res.status(400).json({ error: 'חסרים יעדים' });
    const from = Math.min(Math.max(parseInt(day_from, 10) || 1, 1), 60);
    const to = Math.min(Math.max(parseInt(day_to, 10) || from, from), 60);
    if (to - from + 1 > 30) return res.status(400).json({ error: 'אפשר לבנות עד 30 ימים בבקשה אחת' });

    const ph = { distinctId: 'user_' + req.user.id, traceId: randomUUID() };
    const broadSingle = dests.length === 1 && (!dests[0].country || dests[0].country === dests[0].name);
    const regions = broadSingle
      ? await aiCountryRegions({ dest: dests[0], from, to, interestList, freeText, answers: null, ph })
      : null;
    const buildDests = regions
      ? regions.map((r) => ({
        name: r.name, country: dests[0].country || dests[0].name, lat: null, lon: null, cities: r.cities,
      }))
      : dests;
    const blocks = buildDests.length === 1
      ? [{ dest: buildDests[0], from, to }]
      : (await aiPlanBlocks({ dests: buildDests, from, to, interestList, freeText, answers: null, ph })
        || allocateDays(orderByProximity(buildDests), from, to));
    res.json({
      plan: blocks.map((b) => ({ area: b.dest.name, from: b.from, to: b.to, cities: b.dest.cities || [] })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'ה-AI התעכב יותר מדי — נסו שוב' : 'ה-AI לא הצליח לחלק את הטיול לאזורים — נסו שוב עוד רגע' });
  }
});

// The build itself, shared by the wizard's one-shot route below and by the planning
// chat (routes/plan.js), which runs the same pipeline inside a draft that already
// exists — "בבת אחת" straight after the clarifying round, or "להשלים את השאר" around
// the anchors settled in conversation. Returns {questions} when a clarifying round is
// due and the caller hasn't been through one, else {items, plan, meta}.
async function buildItinerary({ dests, area = null, from, to, interestList, freeText, answerList, presetRaw = null, existing = [], wantMeta = false, startDate = null, ph }) {
  const areaNames = dests.map((d) => d.name);
  if (area && !areaNames.includes(area)) throw Object.assign(new Error('אזור לא מוכר'), { status: 400 });
  const broadSingle = dests.length === 1 && (!dests[0].country || dests[0].country === dests[0].name);

  // region-edit screen round-trip (long trips): the wizard already showed the AI's
  // split and the traveller's day→area painting comes back as `plan` — used
  // verbatim, so no region question and no re-allocation below. Ignored for
  // per-area rebuilds (`area`), which already know their day range.
  let presetPlan = null;
  if (!area && Array.isArray(presetRaw)) {
    presetPlan = cleanPresetPlan(presetRaw, { from, to, areaNames, broadSingle });
    if (!presetPlan) throw Object.assign(new Error('חלוקת האזורים לא תקינה — נסו שוב'), { status: 400 });
  }

  if (!area && (dests.length >= 2 || broadSingle) && answerList === null) {
    const questions = await aiClarify({
      dests, from, to, interestList, freeText, ph,
      presetAreas: presetPlan ? [...new Set(presetPlan.map((b) => b.area))] : null,
    });
    if (questions.length) return { questions };
  }

  // a country is always built as areas: the ones the traveller ticked, or — when they
  // skipped the question or never saw it — the ones the AI breaks it into. They stand
  // in for destinations while building, so a one-country trip gets the same contiguous
  // blocks and transfer stops as a multi-city one. The trip's own destination list
  // is untouched; only the response's `plan` reports the areas back.
  const regions = broadSingle && !area && !presetPlan
    ? (regionsFromPicked(dests[0], answerList)
      || await aiCountryRegions({ dest: dests[0], from, to, interestList, freeText, answers: answerList, ph }))
    : null;
  // preset areas carry their cities with them — they round-tripped from /plan-regions
  const regionCities = presetPlan
    ? new Map(presetPlan.map((b) => [b.area, b.cities]))
    : new Map((regions || []).map((r) => [r.name, r.cities]));
  let buildDests;
  if (presetPlan) {
    const names = [...new Set(presetPlan.map((b) => b.area))];
    // for a broad single destination the painted areas stand in for destinations,
    // exactly like AI-proposed regions; for a multi-destination trip the areas ARE
    // the destinations — and painting one over entirely legitimately drops it
    buildDests = broadSingle
      ? names.map((n) => ({
        name: n, country: dests[0].country || dests[0].name, lat: null, lon: null, cities: regionCities.get(n),
      }))
      : dests.filter((d) => names.includes(d.name));
  } else {
    buildDests = regions
      ? regions.map((r) => ({
        name: r.name, country: dests[0].country || dests[0].name, lat: null, lon: null, cities: r.cities,
      }))
      : dests;
  }

  // build the per-area blocks: the painted preset, a single requested area, or an
  // AI-decided allocation (order + days per city). The AI plans; the server only
  // verifies that the blocks are contiguous — falling back to an even split if invalid.
  let blocks;
  if (presetPlan) {
    blocks = presetPlan.map((b) => ({ dest: buildDests.find((d) => d.name === b.area), from: b.from, to: b.to }));
  } else if (area) {
    blocks = [{ dest: dests.find((d) => d.name === area), from, to }];
  } else if (buildDests.length === 1) {
    blocks = [{ dest: buildDests[0], from, to }];
  } else {
    blocks = await aiPlanBlocks({ dests: buildDests, from, to, interestList, freeText, answers: answerList, ph })
      || allocateDays(orderByProximity(buildDests), from, to);
  }

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
        existing,
        ph,
      })
    )),
    descPromise,
  ]);
  const items = results.flat()
    .sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')))
    .slice(0, 200);

  // The places are verified; now the hours are. The model writes a plausible-looking
  // clock time with no idea when the door opens, and the first production audit found
  // that exact shape three times over — a museum and an aquarium at 09:00 that open at
  // 10:00, and a dinner-only sushi bar booked for breakfast. Each one moves within its
  // own day to an hour that works, or is left alone and reported. Best effort on a
  // clock, and skipped entirely for a trip with no dates (lib/hours-fit.js).
  if (startDate) {
    try {
      const fit = await fitItinerary(items, { startDate });
      if (fit.moved.length) {
        console.log(`hours: moved ${fit.moved.length} stop(s) to an open hour — ` +
          fit.moved.map((m) => `${m.title} ${m.from}→${m.to}`).join(' | '));
      }
      if (fit.shut.length) {
        console.log(`hours: ${fit.shut.length} stop(s) shut and not moved — ` +
          fit.shut.map((x) => `${x.title} (${x.reason})`).join(' | '));
      }
    } catch (err) {
      // a build must never fail over an hour — the page still marks what it finds
      console.error(`hours: fit failed (${err.message}) — itinerary kept as built`);
    }
  }

  return {
    items,
    // cities ride along so the client can place an area on the map — a region name
    // on its own geocodes to nothing, or to the wrong continent
    plan: blocks.map((b) => ({
      area: b.dest.name, from: b.from, to: b.to, cities: regionCities.get(b.dest.name) || [],
    })),
    meta,
  };
}

// the request-shaping the two build routes share: interests, free text, day range and
// the clarifying answers, each capped the same way
function buildParams(body) {
  const { day_from, day_to, interests, notes, answers } = body || {};
  const interestList = (Array.isArray(interests) ? interests : [])
    .slice(0, 15).map((s) => String(s).slice(0, 40).trim()).filter(Boolean);
  const freeText = notes ? String(notes).slice(0, 500).trim() : '';
  const from = Math.min(Math.max(parseInt(day_from, 10) || 1, 1), 60);
  const to = Math.min(Math.max(parseInt(day_to, 10) || from, from), 60);
  // clarifying answers: only when the client has been through the round (answers
  // present, even as an empty array) — absent means "ask me first"
  const answerList = Array.isArray(answers)
    ? answers.slice(0, 4).map((a) => ({
        question: String(a?.question || '').slice(0, 160),
        answer: String(a?.answer || '').slice(0, 240), // a multi answer carries several regions
        // the options actually ticked, so the build can tell them from typed text
        picked: (Array.isArray(a?.picked) ? a.picked : [])
          .slice(0, 5).map((p) => String(p).slice(0, 60).trim()).filter(Boolean),
      })).filter((a) => a.question && a.answer)
    : null;
  return { interestList, freeText, from, to, answerList };
}

// a build's daily quota, per user — the spend() to call once the build succeeded, or
// null when the day's builds are used up (lib/quota.js: admins never capped, the
// referral bonus doubles the limit)
async function buildQuota(req) {
  const q = await buildMeter.check(req);
  return q ? q.spend : null;
}
const BUILD_EXHAUSTED = 'הגעתם למכסת בניות ה-AI היומית — נסו שוב מחר';

const buildErrorMessage = (err) => err.name === 'AbortError'
  ? 'ה-AI התעכב יותר מדי — נסו שוב'
  : 'ה-AI לא הצליח לבנות את המסלול — נסו שוב עוד רגע';

router.post('/api/ai/itinerary', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'בניית AI לא זמינה כרגע' });
    const spend = await buildQuota(req);
    if (!spend) return exhausted(res, 'build', BUILD_EXHAUSTED);

    const { destinations, area, want_description } = req.body || {};
    const { interestList, freeText, from, to, answerList } = buildParams(req.body);
    const dests = cleanDestinations(destinations);
    if (!dests.length) return res.status(400).json({ error: 'חסרים יעדים' });
    if (to - from + 1 > 30) return res.status(400).json({ error: 'אפשר לבנות עד 30 ימים בבקשה אחת' });

    // one trace per build request — every OpenAI call it spawns shares this id,
    // attributed to the same pseudonymous identity the client-side analytics uses
    const ph = { distinctId: 'user_' + req.user.id, traceId: randomUUID() };
    let built;
    try {
      built = await buildItinerary({
        dests, area: area || null, from, to, interestList, freeText, answerList,
        presetRaw: Array.isArray(req.body.plan) ? req.body.plan : null,
        wantMeta: !!(want_description || req.body.want_meta),
        // optional here: this route builds before a trip exists, so the caller is the
        // only one who knows the dates. Without them the hours pass simply does nothing.
        startDate: typeof req.body.start_date === 'string' ? req.body.start_date : null,
        ph,
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    if (built.questions) return res.json({ questions: built.questions }); // no quota for asking
    if (!built.items.length) return res.status(502).json({ error: 'ה-AI החזיר מסלול ריק — נסו שוב' });

    spend();
    res.json({
      items: built.items,
      plan: built.plan,
      meta: built.meta,
      description: built.meta ? built.meta.description : null, // back-compat
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: buildErrorMessage(err) });
  }
});

// ---------- AI trip editor: one structured-diff call over the current itinerary ----------
// The trip was built by several parallel structured calls (no stored transcript), and
// manual edits diverge from it anyway — so each edit request sends a fresh, compact
// snapshot of the CURRENT itinerary instead of replaying any "creation conversation".

const editMeter = dailyQuota('edit', 3); // smart edits per user per day
const AI_EDIT_MAX_PROMPT = 200;

// field cleaners shared by both edit routes (DB-applied and draft)
// zero-pad the hour: times sort as strings (day → clock → slot), and an unpadded
// "9:00" would land after "18:00"
const cleanTime = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t.padStart(5, '0') : null);
const clampDay = (d, days, dflt = 1) => Math.min(Math.max(parseInt(d, 10) || dflt, 1), days);

// the itinerary a set of ops would produce, so the rules below can be checked against
// the trip itself rather than against the list of operations
function applyOps(items, ops) {
  const out = items.map((it) => ({ ...it }));
  for (const op of ops) {
    if (op.action === 'delete') {
      const i = out.findIndex((it) => it.id === op.id);
      if (i !== -1) out.splice(i, 1);
    } else if (op.action === 'update') {
      const it = out.find((x) => x.id === op.id);
      if (it) for (const k of ['day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area', 'cost']) {
        if (op[k] !== null && op[k] !== undefined) it[k] = op[k];
      }
    } else if (op.action === 'add') {
      out.push({ ...op, id: `new-${out.length}` });
    }
  }
  return out;
}

// The two rules the edit prompt states in prose and asks the model to verify about
// itself — which is the least reliable way to enforce anything. Both models break them
// on a re-pacing request: the weak one empties a day outright, the strong one splits an
// area across non-adjacent days while its summary describes a clean layout. Stated as
// text because a failed edit is handed straight back as a diagnosis.
function editViolations(items, ops, days) {
  const after = applyOps(items, ops);
  const problems = [];
  const empty = [];
  const count = (arr, d) => arr.filter((it) => it.day_number === d).length;
  const crowded = [];
  for (let d = 1; d <= days; d++) {
    const now = count(after, d);
    if (!now) empty.push(d);
    // the prompt asks for 2-4 stops a day, but a fifth is what "add more food on days
    // 6-10" literally asks for — flagging that would fight the request. Six is where the
    // model stops adding and starts dumping. Only days this edit made worse count: a
    // trip that arrived crowded is not this edit's fault.
    if (now > 5 && now > count(items, d)) crowded.push(`${d} (${now})`);
  }
  if (empty.length) problems.push(`ימים שנשארו בלי אף תחנה: ${empty.join(', ')}`);
  if (crowded.length) problems.push(`ימים שנעשו עמוסים מדי (מעל 5 תחנות): ${crowded.join(', ')}`);
  for (const area of [...new Set(after.map((it) => it.area).filter(Boolean))]) {
    const ds = [...new Set(after.filter((it) => it.area === area).map((it) => it.day_number))].sort((a, b) => a - b);
    if (ds.length && ds[ds.length - 1] - ds[0] + 1 !== ds.length) {
      problems.push(`האזור "${area}" יושב על ימים לא רצופים: ${ds.join(', ')}`);
    }
  }
  return { problems, after };
}

// Deterministic last resort, used when the model's repair attempt still breaks the
// rules above. The model already decided WHAT the trip contains; this only fixes WHERE
// stops sit: stops whose area label disagrees with the day they landed on are moved
// into their area's days (or adopt the day's area when that block is full), empty days
// are refilled from the fullest ones, and days an op overfilled are thinned back. It
// amends the ops themselves — an added stop has no id yet, so its add op is edited in
// place; everything else becomes one more update op — and unlike another model call,
// it terminates with the rules holding.
function rebalanceEdit(items, ops, days, areaNames) {
  const clamp = (d, dflt) => Math.min(Math.max(parseInt(d, 10) || dflt, 1), days);
  // replay like applyOps, but remember which op created each added stop and what the
  // ops alone would leave behind (day0/area0), so only real corrections are emitted
  const entries = items.map((it) => ({
    id: it.id, day: it.day_number, area: it.area || null,
    time: it.time_label || '', category: it.category, touched: false, addOp: null,
  }));
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const op of ops) {
    if (op.action === 'delete') {
      const e = byId.get(op.id);
      if (e) { entries.splice(entries.indexOf(e), 1); byId.delete(op.id); }
    } else if (op.action === 'update') {
      const e = byId.get(op.id);
      if (!e) continue;
      e.touched = true;
      if (op.day_number != null) e.day = clamp(op.day_number, e.day);
      if (op.area != null) e.area = op.area;
      if (op.time_label != null) e.time = op.time_label;
      if (op.category != null) e.category = op.category;
    } else if (op.action === 'add') {
      entries.push({
        id: null, day: clamp(op.day_number, 1), area: op.area || null,
        time: op.time_label || '', category: op.category, touched: true, addOp: op,
      });
    }
  }
  for (const e of entries) { e.day0 = e.day; e.area0 = e.area; }

  const count = Array(days + 1).fill(0);
  for (const e of entries) count[e.day]++;
  const move = (e, d, area) => {
    count[e.day]--; e.day = d; count[d]++;
    if (area !== undefined) e.area = area;
  };

  // which area owns each day: a monotone partition (areas in their current day order,
  // each on one contiguous block) chosen to agree with as many stops as possible
  let dayArea = null;
  if (areaNames.length > 1) {
    const minDay = (n) => {
      const ds = entries.filter((e) => e.area === n).map((e) => e.day);
      return ds.length ? Math.min(...ds) : Infinity;
    };
    const order = [...areaNames].sort((a, b) => minDay(a) - minDay(b));
    const votes = Array.from({ length: days + 1 }, () => order.map(() => 0));
    for (const e of entries) {
      const j = order.indexOf(e.area);
      if (j !== -1) votes[e.day][j]++;
    }
    const dp = Array.from({ length: days + 1 }, () => order.map(() => 0));
    const prev = Array.from({ length: days + 1 }, () => order.map(() => 0));
    for (let j = 0; j < order.length; j++) dp[1][j] = votes[1][j];
    for (let d = 2; d <= days; d++) {
      for (let j = 0; j < order.length; j++) {
        let best = j; // a tie stays in the same area — fewer boundary flips
        for (let i = 0; i < j; i++) if (dp[d - 1][i] > dp[d - 1][best]) best = i;
        dp[d][j] = votes[d][j] + dp[d - 1][best];
        prev[d][j] = best;
      }
    }
    let j = 0;
    for (let i = 1; i < order.length; i++) if (dp[days][i] > dp[days][j]) j = i;
    dayArea = Array(days + 1).fill(null);
    for (let d = days; d >= 1; d--) { dayArea[d] = order[j]; j = prev[d][j]; }
  }

  // stops whose label disagrees with the day they sit on: move them into their own
  // area's days when there is room, otherwise adopt the day's area
  if (dayArea) {
    for (const e of entries) {
      if (!e.area) { if (e.addOp) e.area = dayArea[e.day]; continue; }
      if (e.area === dayArea[e.day]) continue;
      const block = [];
      for (let d = 1; d <= days; d++) if (dayArea[d] === e.area) block.push(d);
      const target = block.length ? block.reduce((a, b) => (count[b] < count[a] ? b : a)) : null;
      if (target != null && count[target] < 5) move(e, target);
      else e.area = dayArea[e.day];
    }
  }

  // a stop the ops already moved is the least anchored to its day; a travel stop is
  // the most — it IS the day's structure — so it goes last
  const pick = (d) => entries.filter((e) => e.day === d).sort((a, b) =>
    (a.category === 'נסיעה') - (b.category === 'נסיעה')
    || b.touched - a.touched
    || (b.time || '').localeCompare(a.time || '')
    || (b.id || 0) - (a.id || 0))[0];

  // refill empty days from the fullest ones, same-area days first
  for (let d = 1; d <= days; d++) {
    if (count[d] > 0) continue;
    while (count[d] < 2) {
      const donors = [];
      for (let x = 1; x <= days; x++) if (x !== d && count[x] >= 3) donors.push(x);
      if (!donors.length) break;
      donors.sort((a, b) =>
        (dayArea ? (dayArea[b] === dayArea[d]) - (dayArea[a] === dayArea[d]) : 0)
        || count[b] - count[a] || a - b);
      move(pick(donors[0]), d, dayArea ? dayArea[d] : undefined);
    }
  }

  // thin days an op overfilled — the same crowding rule editViolations flags
  const before = Array(days + 1).fill(0);
  for (const it of items) if (it.day_number >= 1 && it.day_number <= days) before[it.day_number]++;
  const extraDeletes = [];
  const droppedAdds = new Set();
  for (let d = 1; d <= days; d++) {
    while (count[d] > 5 && count[d] > before[d]) {
      const e = pick(d);
      const sameBlock = [];
      const anyDay = [];
      for (let x = 1; x <= days; x++) {
        if (x === d || count[x] >= 5) continue;
        anyDay.push(x);
        if (!dayArea || dayArea[x] === e.area) sameBlock.push(x);
      }
      const least = (arr) => arr.reduce((a, b) => (count[b] < count[a] ? b : a));
      if (sameBlock.length) move(e, least(sameBlock));
      else if (anyDay.length) {
        const t = least(anyDay);
        move(e, t, dayArea ? dayArea[t] : undefined);
      } else { // nowhere with room — this stop really is the excess
        entries.splice(entries.indexOf(e), 1);
        count[d]--;
        if (e.addOp) droppedAdds.add(e.addOp);
        else extraDeletes.push(e.id);
      }
    }
  }

  let changed = droppedAdds.size > 0;
  const out = ops.filter((op) => !droppedAdds.has(op));
  for (const e of entries) {
    if (e.addOp) {
      if (e.addOp.day_number !== e.day || (e.addOp.area || null) !== e.area) {
        e.addOp.day_number = e.day;
        e.addOp.area = e.area;
        changed = true;
      }
      continue;
    }
    const dayFix = e.day !== e.day0 ? e.day : null;
    const areaFix = (e.area || null) !== (e.area0 || null) ? e.area : null;
    if (dayFix == null && areaFix == null) continue;
    changed = true;
    out.push({
      action: 'update', id: e.id, day_number: dayFix, time_label: null, title: null,
      note: null, place_query: null, category: null, area: areaFix, cost: null,
    });
  }
  for (const id of extraDeletes) out.push({ action: 'delete', id });
  return changed || extraDeletes.length ? out : null;
}

// re-pacing a trip costs one update per moved stop, so the cap has to clear a
// whole-trip reshuffle — at 30 the tail of a reorganization was silently dropped,
// which by itself left days empty
async function aiEditOpsRaw({ title, destText, dests, days, items, prompt, description = '', scopeNote = '', opsCap = 80, ph }) {
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

  const askModel = (fixNote) => aiJson({
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
    user: userMsg + (fixNote || ''),
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
  // the model occasionally invents a variant of a real area name ("אזור הירושימה" for
  // "הירושימה"), which then counts as a separate area sitting on scattered days — fold
  // those back onto the trip's own names before anything judges the ops
  const canonArea = (a) => {
    if (!a || areaNames.includes(a)) return a || null;
    return areaNames.find((n) => a.includes(n) || n.includes(a)) || a;
  };
  const shape = (p) => ({
    summary: String(p.summary || '').slice(0, 300),
    description: p.description ? String(p.description).slice(0, 500).trim() || null : null,
    ops: Array.isArray(p.ops)
      ? p.ops.slice(0, opsCap).map((op) => (op && op.area ? { ...op, area: canonArea(op.area) } : op))
      : [],
  });

  const parsed = await askModel();
  if (!parsed) return null;
  const first = shape(parsed);
  if (!first.ops.length) return first;

  // Checking the trip the ops produce is the only reliable enforcement of the two rules
  // above, and a violation is worth one more call: the model gets told exactly what
  // broke, which is something it could not work out on its own. A repair costs one weak
  // call, where the alternative — running every edit on the strong model — costs 15x and
  // does not fix this case anyway.
  const { problems } = editViolations(items, first.ops, days);
  if (!problems.length) return first;
  const repaired = await askModel(
    `\n\nניסיון קודם שלך לבצע את הבקשה הזו יצר את הבעיות הבאות: ${problems.join(' | ')}. ` +
    `החזר סט ops מלא ומתוקן שמבצע את אותה בקשה בלי הבעיות האלה — כל יום בטווח הטיול עם 2-4 תחנות, וכל אזור על רצף ימים אחד. ` +
    `אל תעביר ואל תוסיף תחנות ליום שכבר יש בו 4 תחנות או יותר.`
  );
  let best = first;
  let bestProblems = problems;
  if (repaired) {
    const second = shape(repaired);
    if (second.ops.length) { // an empty retry is a worse answer than a flawed one
      const after = editViolations(items, second.ops, days);
      if (!after.problems.length) return second;
      if (after.problems.length < bestProblems.length) { best = second; bestProblems = after.problems; }
    }
  }
  // the model got its diagnosis and still broke a rule — from here the fix is
  // mechanical, and mechanical actually converges
  const fixed = rebalanceEdit(items, best.ops, days, areaNames);
  if (fixed) {
    const check = editViolations(items, fixed, days);
    if (!check.problems.length) return { ...best, ops: fixed };
    if (check.problems.length < bestProblems.length) { best = { ...best, ops: fixed }; bestProblems = check.problems; }
  }
  console.warn('trip_edit repair still violates:', bestProblems.join(' | '));
  return best;
}

// The edit path proposes places too — the same model that invents "Vanora, Athens" in
// a build invents it here, straight into the DB. Same deal as the build: geocode every
// proposed place_query, one correction round, drop what still fails. Runs as a wrapper
// so every exit path of the raw call is covered, and costs no edit quota — the
// correction is part of serving the one edit already paid for. One asymmetry: on an
// `update` op a dropped place becomes '' rather than null, because in an update null
// means "leave the field alone" — and leaving the OLD pin under a repurposed stop is
// exactly the wrong-pin problem this exists to stop ('' clears the pin downstream).
async function aiEditOps(args) {
  return verifyEditOps(await aiEditOpsRaw(args), args);
}

// the verification half on its own: the planning chat's turns produce ops through a
// different prompt, and meet exactly this check before anything is proposed or written
async function verifyEditOps(result, args) {
  if (!result || !Array.isArray(result.ops) || !result.ops.length) return result;
  const byId = new Map((args.items || []).map((it) => [it.id, it]));
  // an op whose place_query is a "no place" string ("null", "none") meant a cleared
  // pin, not a query — left alone it would be geocoded and stored verbatim
  for (const op of result.ops) {
    if ((op.action === 'add' || op.action === 'update') && typeof op.place_query === 'string'
        && op.place_query.trim() && !cleanPlaceQuery(op.place_query)) {
      op.place_query = op.action === 'update' ? '' : null;
      op.lat = null; op.lon = null;
    }
  }
  // which days already hold a travel stop comes from the full trip — the ops alone
  // can't show it, and a travel day's replacement circle must span the areas
  const tripTravelDays = new Set((args.items || [])
    .filter((it) => it.category === 'נסיעה').map((it) => it.day_number));
  const entries = result.ops
    .filter((op) => (op.action === 'add' || op.action === 'update') && cleanPlaceQuery(op.place_query))
    .map((op) => {
      const cur = op.id != null ? byId.get(op.id) : null;
      const day = op.day_number != null ? op.day_number : (cur ? cur.day_number : null);
      return {
        op,
        title: op.title || (cur && cur.title) || '',
        area: op.area || (cur && cur.area) || null,
        day_number: day,
        category: op.category || (cur && cur.category) || null,
        travelDay: day != null && tripTravelDays.has(day),
        place_query: cleanPlaceQuery(op.place_query),
      };
    });
  if (!entries.length) return result;
  const where = (args.dests || []).length ? args.dests.map((d) => d.name).join(', ') : args.destText || args.title;
  // the editor is the other door a foreign stop can walk through — "add a good sushi
  // place" answered with one in Osaka on a Roman holiday — so it meets the same check
  await repairPlaces(entries, {
    where,
    ph: args.ph,
    dests: args.dests,
    flagMore: (es) => foreignCountryStops(es, args.dests),
  });
  // an op that could not be brought back inside the trip's countries is abandoned whole:
  // an added stop never appears, and an edit that was moving a stop to another country
  // simply doesn't happen. Blanking only its query would leave the rest of the edit —
  // a new title, a new day — standing on a stop that no longer points anywhere.
  const dropped = new Set(entries.filter((e) => e.drop).map((e) => e.op));
  if (dropped.size) result.ops = result.ops.filter((op) => !dropped.has(op));
  for (const e of entries) {
    if (dropped.has(e.op)) continue;
    // a stop brought back from another country carries its new name onto the op, or the
    // itinerary ends up with a Paris title standing on a Tokyo address
    if (e.newTitle) e.op.title = e.newTitle;
    e.op.place_query = e.place_query != null ? e.place_query : (e.op.action === 'update' ? '' : null);
    // verified coordinates ride the op into the DB — the map pins without the client
    // having to re-geocode, and a moved stop can't keep pointing at its old spot
    if (e.place_query != null && e.lat != null) { e.op.lat = e.lat; e.op.lon = e.lon; }
    e.op.google_place_id = e.place_query != null ? (e.google_place_id || null) : null;
    e.op.osm_type = e.place_query != null ? (e.osm_type || null) : null;
    e.op.osm_id = e.place_query != null ? (e.osm_id || null) : null;
  }
  return result;
}

// Writing a set of ops into the trip, inside the caller's transaction: what the AI
// editor does with the model's answer, and what the planning chat does with a proposal
// the traveller approved (or, in its automatic mode, with every proposal as it lands).
// Returns the counts and the exact inverse of what was written — computed from the
// pre-edit rows, so an undo never touches a stop a co-planner changed meanwhile.
async function applyEditOps(client, trip, items, ops, { area = null, from = 1, to = null } = {}) {
  const last = to || trip.days;
  const byId = new Map(items.map((it) => [it.id, it]));
  const inScope = (day) => !area || (day >= from && day <= last);
  let added = 0, updated = 0, removed = 0;
  const undoOps = { added: [], updated: [], deleted: [] };
  for (const op of ops) {
    if (op.action === 'delete' && byId.has(op.id)) {
      if (!inScope(byId.get(op.id).day_number)) continue;
      undoOps.deleted.push(byId.get(op.id));
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
      const pre = {}; // the touched columns' pre-edit values, for the undo
      const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); pre[col] = target[col]; };
      if (newDay != null) add('day_number', newDay);
      if (op.time_label != null) add('time_label', cleanTime(op.time_label));
      if (op.title != null && String(op.title).trim()) add('title', String(op.title).slice(0, 200).trim());
      if (op.note != null) add('note', String(op.note).slice(0, 300) || null);
      if (op.place_query != null) {
        add('place_query', cleanPlaceQuery(op.place_query));
        // the stop points somewhere else now — verified coordinates when the place
        // check produced them, cleared otherwise (stale ones would pin the old spot)
        add('lat', Number.isFinite(op.lat) ? op.lat : null);
        add('lon', Number.isFinite(op.lon) ? op.lon : null);
        add('google_place_id', op.google_place_id ? String(op.google_place_id).slice(0, 300) : null);
        add('osm_type', op.osm_type ? String(op.osm_type).slice(0, 10) : null);
        add('osm_id', op.osm_id ? String(op.osm_id).slice(0, 20) : null);
      }
      if (op.category != null && AI_CATEGORIES.includes(op.category)) add('category', op.category);
      if (op.area != null) add('area', String(op.area).slice(0, 80) || null);
      if (op.cost != null) add('cost', cleanCost(op.cost));
      if (sets.length) {
        vals.push(op.id, trip.id);
        await client.query(
          `UPDATE trip_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND trip_id = $${vals.length}`, vals
        );
        undoOps.updated.push({ id: op.id, fields: pre });
        updated++;
      }
    } else if (op.action === 'add' && op.title && String(op.title).trim()) {
      const day = clampDay(op.day_number, trip.days, from);
      if (!inScope(day)) continue;
      const { rows: ins } = await client.query(
        `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, google_place_id, osm_type, osm_id, cost, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))
         RETURNING id`,
        [trip.id, day, cleanTime(op.time_label), String(op.title).slice(0, 200).trim(),
         op.note ? String(op.note).slice(0, 300) : null,
         cleanPlaceQuery(op.place_query),
         AI_CATEGORIES.includes(op.category) ? op.category : 'אטרקציה',
         op.area ? String(op.area).slice(0, 80) : (area || null),
         Number.isFinite(op.lat) ? op.lat : null,
         Number.isFinite(op.lon) ? op.lon : null,
         op.google_place_id ? String(op.google_place_id).slice(0, 300) : null,
         op.osm_type ? String(op.osm_type).slice(0, 10) : null,
         op.osm_id ? String(op.osm_id).slice(0, 20) : null,
         cleanCost(op.cost)]
      );
      undoOps.added.push(ins[0].id);
      added++;
    }
  }
  return { added, updated, removed, undoOps };
}

// the exact inverse applyEditOps recorded, replayed: added rows go, updated columns
// return to their pre-edit values, deleted rows come back in their old slot
async function undoApplied(client, trip, undo) {
  for (const id of undo.added || []) {
    await client.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [id, trip.id]);
  }
  for (const u of undo.updated || []) {
    const cols = Object.keys(u.fields || {});
    if (!cols.length) continue;
    const vals = cols.map((c) => u.fields[c]);
    await client.query(
      `UPDATE trip_items SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND trip_id = $${cols.length + 2}`,
      [...vals, u.id, trip.id]
    );
  }
  for (const it of undo.deleted || []) {
    await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, google_place_id, osm_type, osm_id, cost, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [trip.id, it.day_number, it.time_label, it.title, it.note, it.place_query, it.category, it.area,
       it.lat, it.lon, it.google_place_id, it.osm_type ?? null, it.osm_id ?? null, it.cost, it.sort_order ?? 0]
    );
  }
}

router.post('/api/trips/code/:code/ai-edit', authOptional, async (req, res) => {
  // acquired inside the try: when the database is unreachable this rejects, and an
  // await outside the try would leave the request hanging until the platform gave up
  // on it with a non-JSON 5xx the client can only call "unexpected"
  let client = null;
  try {
    client = await pool.connect();
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

    // 3 AI edits a day per user (editing requires login, so req.user is always set here)
    const quota = await editMeter.check(req);
    if (!quota) return exhausted(res, 'edit', 'ניצלתם את שינויי ה-AI להיום — אפשר להמשיך לערוך ידנית, או לנסות שוב מחר');

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
    quota.spend(); // the model call is the budgeted resource

    await client.query('BEGIN');
    const { added, updated, removed, undoOps } = await applyEditOps(client, trip, items, result.ops, { area, from, to });
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
      undo: added + updated + removed > 0 ? undoOps : null,
      remaining: quota.remaining, // null = unlimited (admin)
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

// =================================================================
//  המלצות — the trip page's chat: a question about the trip's places, answered in
//  Hebrew with recommendation cards that can drop straight into the itinerary
// =================================================================
//
// Same rules as every other model call here. The strong model answers, and no place it
// names reaches the client unverified: each card's place_query goes through verifyPlaces, a verdict of
// mismatch/none drops the card and logs it, a verified one carries the geocoder's
// coordinates and place_id into the stop when added. A card sitting in another
// country is dropped by the same foreignCountryStops rule the builder uses. Photos
// come from Wikipedia (free, keyless) and are never worth waiting for — the lookup
// races the verification and a miss simply means no photo.

const recsMeter = dailyQuota('recs', 30); // messages per user per day; AI_QUOTA_RECS overrides
const AI_RECS_MAX_MESSAGE = 300;
const AI_RECS_HISTORY = 8; // turns the model sees — enough for "and something cheaper?"
const REC_CATS = ['אטרקציה', 'אוכל', 'טבע', 'ים', 'תרבות', 'קניות', 'לינה', 'נוף', 'חיי לילה'];
const REC_COSTS = ['חינם', '₪', '₪₪', '₪₪₪'];

const RECS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          place_query: { type: 'string' },
          blurb: { type: 'string' },
          category: { type: 'string', enum: REC_CATS },
          duration: { type: 'string' },
          cost: { type: 'string', enum: REC_COSTS },
          time: { type: 'string' },
          area: { type: 'string' },
        },
        required: ['title', 'place_query', 'blurb', 'category', 'duration', 'cost', 'time', 'area'],
      },
    },
  },
  required: ['text', 'cards'],
};

function recsSystemPrompt({ trip, dests, items, edit = false }) {
  const destText = dests.length
    ? dests.map((d) => d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name).join(', ')
    : [trip.destination, trip.country].filter(Boolean).join(', ');
  const areaNames = dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
  const dates = trip.start_date ? `, החל מ-${String(trip.start_date).slice(0, 10)}` : '';
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
    byDay.get(it.day_number).push(it.title);
  }
  // in edit mode the stops carry their ids — an op has to name the stop it touches
  const itinerary = edit
    ? (items.map((it) => `#${it.id} | יום ${it.day_number} | ${it.time_label || '--:--'} | [${it.category || 'כללי'}] ${it.title}` +
        (areaNames.length > 1 && it.area ? ` | אזור: ${it.area}` : '')).join('\n') || '(עדיין ריק)')
    : ([...byDay.entries()].slice(0, 30)
      .map(([d, titles]) => `יום ${d}: ${titles.slice(0, 6).join(' · ')}`).join('\n') || '(עדיין ריק)');
  const editRules = edit ? `

עריכת המסלול (ops): המטיילים אפשרו לכם לשנות את המסלול בעצמכם, וכל שינוי שתציעו מוצג להם ככרטיס לאישור לפני שהוא נכנס.
- ops חוזר לא ריק אך ורק כשהבקשה היא במפורש לשנות את המסלול: "תוסיף את זה ליום 3", "תוריד את המוזיאון", "תזיז את השוק לבוקר", "תחליף את הארוחה במשהו אחר", "תכניס לי יום שלם ב…". כל שאלה אחרת — מה יש, מה כדאי, איפה אוכלים, טיפים, "תכננו לי יום" בלי בקשה להכניס — היא המלצה: ops ריק, ו-cards כרגיל.
- כשמציעים שינוי: text מנוסח כהצעה ("אני מציע להוסיף… מאשרים?") ובלי cards כפולים של אותם מקומות.
- add: title קצר בעברית, note טיפ פרקטי קצר, time_label בפורמט HH:MM או null, day_number בין 1 ל-${trip.days}, place_query באנגלית עם עיר ומדינה רק למקום אמיתי (אחרת null), cost הערכה לאדם בש"ח או null, category מתוך: ${AI_CATEGORIES.join(', ')}, area מתוך: ${areaNames.map((a) => `"${a}"`).join(', ')}.
- update/delete: id של תחנה קיימת מהמסלול למעלה; ב-update null בכל שדה שלא משתנה. לא נוגעים בתחנות שלא התבקשו.` : '';
  return `אתם המדריך המקומי של TRIP MAKER — מומחה לטיולים שמכיר את ${destText} לעומק, ועונים למטייל ישראלי שמתכנן את הטיול הזה.
עונים בעברית, בגוף רבים ("אתם"), בחום ובענייניות. השדה text — עד 80 מילים.

הטיול: "${trip.title}", ${trip.days} ימים${dates}. יעדים: ${destText}.
המסלול הנוכחי:
${itinerary}

כרטיסים (cards):
- כרטיס הוא מקום אמיתי אחד שאפשר להגיע אליו: אתר, מסעדה, שוק, פארק, שכונה, מוזיאון, חוף. לא רעיון כללי ולא "סיור" בלי מקום.
- כשהשאלה מבקשת מקומות, מה לעשות, איפה לאכול או תכנון של יום — 3 עד 4 כרטיסים, ובתכנון יום גם שעת התחלה לכל אחד. כשהיא שאלת מידע או טיפים — 0 כרטיסים, והתשובה כולה ב-text.
- אין להציע מקום שכבר נמצא במסלול.
- title: שם המקום בעברית, כפי שמטייל ישראלי מכיר אותו (עד 50 תווים).
- place_query: השם הרשמי באנגלית (או בשפה המקומית באותיות לטיניות), ואחריו העיר והמדינה מופרדים בפסיקים, כך שמנוע מפות ימצא אותו. למשל: "Mercato di Testaccio, Rome, Italy".
- blurb: משפט-שניים קונקרטיים (עד 160 תווים): מה עושים שם, מתי הכי טוב להגיע, טיפ אחד.
- category מתוך הרשימה. cost: חינם / ₪ / ₪₪ / ₪₪₪. duration בעברית קצרה ("שעה", "שעתיים", "חצי יום"). time: שעת התחלה מומלצת בפורמט HH:MM, או מחרוזת ריקה.
- area: שם היעד מהטיול שהמקום שייך אליו, בדיוק באחת הצורות האלה: ${areaNames.map((a) => `"${a}"`).join(', ')}.
- text מציג את הכרטיסים כשיש כאלה ("שלוש נקודות פתיחה:") ואינו חוזר על ה-blurb שלהם.
כל מקום בכרטיס חייב להיות מקום שקיים באמת ושאתם בטוחים בשמו; מקום שאינכם בטוחים בו לא נכנס לכרטיס.${editRules}`;
}

// the recs schema with ops on it — the same op shape the editor and the planner use
const RECS_EDIT_SCHEMA = {
  ...RECS_SCHEMA,
  properties: {
    ...RECS_SCHEMA.properties,
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
  required: [...RECS_SCHEMA.required, 'ops'],
};

// a proposed change as one line for the card (the planner's describeOp, same shape)
function describeRecOp(op, byId) {
  const when = (o, cur) => {
    const d = o.day_number != null ? o.day_number : (cur ? cur.day_number : null);
    const t = o.time_label != null ? o.time_label : (cur ? cur.time_label : null);
    return d != null ? `יום ${d}${t ? ' · ' + t : ''}` : '';
  };
  if (op.action === 'add') return { kind: 'add', title: op.title, when: when(op), note: op.note || '' };
  const cur = byId.get(op.id);
  if (op.action === 'delete') return { kind: 'delete', title: cur ? cur.title : `#${op.id}`, when: cur ? when({}, cur) : '' };
  const changes = [];
  if (op.day_number != null && cur && op.day_number !== cur.day_number) changes.push(`ליום ${op.day_number}`);
  if (op.time_label != null && cur && op.time_label !== cur.time_label) changes.push(`לשעה ${op.time_label}`);
  if (op.title != null && cur && op.title !== cur.title) changes.push(`שם: ${op.title}`);
  if (op.place_query != null) changes.push('מקום אחר');
  if (op.note != null) changes.push('הערה');
  if (op.category != null && cur && op.category !== cur.category) changes.push(op.category);
  if (op.area != null && cur && op.area !== cur.area) changes.push(`אזור ${op.area}`);
  return { kind: 'update', title: cur ? cur.title : `#${op.id}`, when: cur ? when(op, cur) : '', changes };
}

function recsUserPrompt(history, message) {
  const turns = history.slice(-AI_RECS_HISTORY)
    .map((h) => `${h.role === 'user' ? 'מטייל' : 'מדריך'}: ${h.text}`).join('\n');
  return (turns ? `השיחה עד כה:\n${turns}\n\n` : '') + `השאלה עכשיו:\n${message}`;
}

// the whole turn, model to verified cards — exported for tests, which stub fetch
// `edit`: the traveller switched the chat to אוטומטי — the model may answer an explicit
// change request with ops (verified like the editor's, returned as a proposal, never
// written here). Both modes run on the strong model now: the cards name places, and
// the two tiers answered in different registers within one thread.
async function tripRecs({ trip, items, message, history, edit = false, ph }) {
  const dests = Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [];
  const areaNames = dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
  const raw = await aiJson({
    system: recsSystemPrompt({ trip, dests, items, edit }),
    user: recsUserPrompt(history, message),
    schemaName: edit ? 'trip_recs_edit' : 'trip_recs',
    schema: edit ? RECS_EDIT_SCHEMA : RECS_SCHEMA,
    maxTokens: edit ? 2400 : 1400,
    model: AI_MODEL_STRONG,
    ph,
  });
  if (!raw) return null;
  const { cards: survivors, dropped } = await verifyRecCards(raw.cards, { dests, areaNames });
  const out = {
    text: String(raw.text || '').trim().slice(0, 1200),
    cards: survivors,
    dropped,
  };
  if (edit && Array.isArray(raw.ops) && raw.ops.length) {
    const verified = await verifyEditOps({ ops: raw.ops.slice(0, 20) }, {
      items, dests, destText: trip.destination, title: trip.title, ph,
    });
    if (verified.ops.length) {
      const byId = new Map(items.map((it) => [it.id, it]));
      out.ops = verified.ops;
      out.changes = verified.ops.map((op) => describeRecOp(op, byId));
      // a proposal that repeats its own places as cards is the same thing twice
      out.cards = [];
    }
  }
  return out;
}

// the two halves of a proposal the recs chat accepted — the ops written, or the
// recorded inverse replayed — for anyone who may edit the trip. The ops arrive from
// the client (the recs thread lives in the browser, not on the server), which is fine:
// applyEditOps sanitizes every field, and an editor could have made the same change by
// hand. A viewer without edit rights is refused by tripWithEditAuth.
async function applyClientOps(req, res, mode) {
  let client = null;
  try {
    client = await pool.connect();
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    await client.query('BEGIN');
    let result = null;
    if (mode === 'apply') {
      const ops = (Array.isArray(b.ops) ? b.ops : []).slice(0, 20)
        .filter((op) => op && ['add', 'update', 'delete'].includes(op.action));
      if (!ops.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'אין שינויים לבצע' }); }
      const items = await client.query(
        'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
      ).then((r) => r.rows);
      const r = await applyEditOps(client, trip, items, ops);
      const changed = r.added + r.updated + r.removed > 0;
      result = { applied: { added: r.added, updated: r.updated, removed: r.removed }, undo: changed ? r.undoOps : null };
    } else {
      const u = b.undo && typeof b.undo === 'object' ? b.undo : null;
      if (!u) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'אין מה לבטל' }); }
      await undoApplied(client, trip, {
        added: (Array.isArray(u.added) ? u.added : []).map((id) => parseInt(id, 10)).filter(Number.isInteger),
        updated: (Array.isArray(u.updated) ? u.updated : []).filter((x) => x && Number.isInteger(+x.id) && x.fields && typeof x.fields === 'object')
          .map((x) => ({ id: +x.id, fields: Object.fromEntries(Object.entries(x.fields)
            .filter(([k]) => ['day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area', 'lat', 'lon', 'google_place_id', 'osm_type', 'osm_id', 'cost'].includes(k))) })),
        deleted: (Array.isArray(u.deleted) ? u.deleted : []).filter((it) => it && it.title).slice(0, 20).map((it) => ({
          day_number: clampDay(it.day_number, trip.days), time_label: cleanTime(it.time_label), title: String(it.title).slice(0, 200),
          note: it.note ? String(it.note).slice(0, 500) : null, place_query: cleanPlaceQuery(it.place_query), category: it.category ? String(it.category).slice(0, 40) : null,
          area: it.area ? String(it.area).slice(0, 80) : null, lat: Number.isFinite(+it.lat) && it.lat !== null ? +it.lat : null,
          lon: Number.isFinite(+it.lon) && it.lon !== null ? +it.lon : null, google_place_id: it.google_place_id ? String(it.google_place_id).slice(0, 300) : null,
          osm_type: it.osm_type ? String(it.osm_type).slice(0, 10) : null, osm_id: it.osm_id ? String(it.osm_id).slice(0, 20) : null,
          cost: cleanCost(it.cost), sort_order: parseInt(it.sort_order, 10) || 0,
        })),
      });
      result = { undone: true };
    }
    const fresh = await client.query(
      'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    await client.query('COMMIT');
    res.json({ ...result, items: fresh.rows });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
}
router.post('/api/trips/code/:code/recs/apply', authOptional, (req, res) => applyClientOps(req, res, 'apply'));
router.post('/api/trips/code/:code/recs/undo', authOptional, (req, res) => applyClientOps(req, res, 'undo'));

// A stop added by hand is asked for what it is and when, never what kind of thing it is:
// the category is chosen here, while the add button waits. It is the smallest call in
// the codebase — a title and a place in, one word out, on the weak model — and it is
// never a reason for the stop not to be added: no key, no answer in time, too many
// asks, a word outside the list — each one answers { category: null }, the stop is
// saved without one, and its card shows the generic tile. The list is the stop sheet's
// own (the categories with an icon), plus the travel leg a hand-added flight is.
//
// Every category carries a one-line meaning, and "אחר" is a real answer: without the
// meanings the weak model filed a rooftop cocktail bar under food, a hotel check-in under
// travel and swimming under view; without "אחר" it forced "meeting Danny" into culture.
// With both, 15 of 16 typical hand-added stops land right (2026-09-17). אחר → null.
const STOP_CAT_MEANING = {
  'אוכל': 'a meal, café, restaurant, bakery, ice cream or food market',
  'חיי לילה': 'a bar, pub, club or evening drinks',
  'נסיעה': 'getting from one place to another: flight, train, bus, ferry, drive, transfer',
  'לינה': 'the hotel or apartment itself: check-in, check-out, resting at the hotel',
  'ים': 'a beach, swimming, snorkelling, or a boat trip on the sea or a river',
  'טבע': 'a park, garden, forest, hike, lake or nature walk',
  'נוף': 'a viewpoint or lookout, a place visited for the view',
  'תרבות': 'a museum, gallery, church, temple, show or concert',
  'קניות': 'shopping: a shopping street, mall, a market for goods, souvenirs',
  'אטרקציה': 'a landmark, monument, square, theme park or sight that fits nothing above',
};
const STOP_CATS = Object.keys(STOP_CAT_MEANING);
const STOP_CAT_SYSTEM = 'You label one stop of a travel itinerary with one category. The categories:\n'
  + STOP_CATS.map((c) => `${c} — ${STOP_CAT_MEANING[c]}`).join('\n')
  + '\nאחר — anything that is not a place to visit or a way to get there (meeting someone, free time, packing, a reminder).'
  + '\nAnswer the single best fit.';
const classifyLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 60, error: '' });
router.post('/api/trips/code/:code/classify-stop', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const title = String((req.body && req.body.title) || '').trim().slice(0, 120);
    const place = String((req.body && req.body.place) || '').trim().slice(0, 120);
    if (!title || !process.env.OPENAI_API_KEY || classifyLimit.blocked(req.ip)) return res.json({ category: null });
    classifyLimit.hit(req.ip);
    const r = await aiJson({
      system: STOP_CAT_SYSTEM,
      user: `Stop: ${title}${place ? `\nPlace: ${place}` : ''}\nDestination: ${trip.destination || ''}`,
      schemaName: 'stop_category',
      schema: {
        type: 'object', additionalProperties: false, required: ['category'],
        properties: { category: { type: 'string', enum: [...STOP_CATS, 'אחר'] } },
      },
      maxTokens: 30,
      timeoutMs: 6000,
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    const category = r && STOP_CATS.includes(r.category) ? r.category : null;
    res.json({ category });
  } catch (err) {
    console.error('classify-stop failed', err.message);
    res.json({ category: null });
  }
});

// model-proposed place cards → verified, geolocated, photographed cards; what the
// recs chat and the planning chat both show. Returns the survivors and how many fell.
async function verifyRecCards(rawCards, { dests, areaNames }) {
  const cards = (Array.isArray(rawCards) ? rawCards : []).slice(0, 4).map((c) => ({
    title: String(c.title || '').trim().slice(0, 80),
    blurb: String(c.blurb || '').trim().slice(0, 240),
    category: REC_CATS.includes(c.category) ? c.category : 'אטרקציה',
    duration: String(c.duration || '').trim().slice(0, 30),
    cost: REC_COSTS.includes(c.cost) ? c.cost : '₪₪',
    time: cleanTime(c.time),
    area: areaNames.includes(c.area) ? c.area : (areaNames[0] || null),
    place_query: cleanPlaceQuery(c.place_query),
    lat: null, lon: null, google_place_id: null, osm_type: null, osm_id: null, photos: [], photo_credit: null,
  })).filter((c) => c.title && c.place_query);

  // verify first — the verdict carries the place_id that a real Google photo needs, and
  // there's no point paying for a photo of a card that's about to be dropped
  const queries = [...new Set(cards.map((c) => c.place_query))];
  const verified = await verifyPlaces(queries, { timeoutMs: 4000 });

  const kept = [];
  const entries = [];
  for (const c of cards) {
    const v = verified.get(c.place_query);
    if (v && (v.verdict === 'mismatch' || v.verdict === 'none')) {
      console.warn(`recs: dropped unverified place "${c.place_query}" (${v.verdict})`);
      continue;
    }
    if (v && v.verdict === 'ok' && v.best) {
      c.lat = v.best.lat; c.lon = v.best.lon; c.google_place_id = v.best.place_id || null;
      // the OSM element rides along too, so a card the traveller drops into a day can be
      // asked about its hours afterwards without geocoding it a second time
      c.osm_type = v.best.osm_type || null; c.osm_id = v.best.osm_id || null;
      entries.push({ card: c, place_query: c.place_query, cc: v.best.cc, lat: v.best.lat, lon: v.best.lon, geoWhere: v.best.where });
    }
    kept.push(c); // 'skipped' (geocoder quiet) fails open, uncoordinated — same as a build
  }
  const foreign = new Set(foreignCountryStops(entries, dests).map((e) => e.card));
  for (const c of foreign) console.warn(`recs: dropped foreign place "${c.place_query}"`);
  const survivors = kept.filter((c) => !foreign.has(c));

  // photos for the survivors only: a real Google photo when the place verified with an id,
  // Wikipedia otherwise — placePhoto decides, and a failure just leaves the card imageless
  // (the client falls back to the destination's own picture)
  await Promise.all(survivors.map(async (c) => {
    const p = await placePhoto(c.place_query, { placeId: c.google_place_id }).catch(() => null);
    if (p) { c.photos = [p.url]; c.photo_credit = p.credit; }
  }));

  return { cards: survivors, dropped: cards.length - survivors.length };
}

router.post('/api/trips/code/:code/recs', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'ההמלצות לא זמינות כרגע' });
    const b = req.body || {};
    const message = String(b.message || '').trim();
    if (!message) return res.status(400).json({ error: 'כתבו שאלה' });
    if (message.length > AI_RECS_MAX_MESSAGE) {
      return res.status(400).json({ error: `השאלה ארוכה מדי — עד ${AI_RECS_MAX_MESSAGE} תווים`});
    }
    const history = (Array.isArray(b.history) ? b.history : []).slice(-AI_RECS_HISTORY)
      .map((h) => ({ role: h && h.role === 'user' ? 'user' : 'ai', text: String((h && h.text) || '').slice(0, 600) }))
      .filter((h) => h.text);

    const { rows } = await pool.query(
      'SELECT id, owner_id, title, destination, country, days, start_date, destinations FROM trips WHERE share_code = $1',
      [req.params.code]
    );
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    // אוטומטי: the chat may propose changes — only for someone who could make them by hand
    const edit = b.mode === 'auto' && (req.user.id === trip.owner_id
      || await isParticipant(trip.id, req.user.id) || await isAdmin(req));

    // 30 questions a day per user; admins are counted but never capped, as everywhere here
    const quota = await recsMeter.check(req);
    if (!quota) return exhausted(res, 'recs', 'ניצלתם את שאלות ההמלצות להיום — נסו שוב מחר');

    const { rows: items } = await pool.query(
      'SELECT id, day_number, time_label, title, category, area, place_query FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]
    );
    const result = await tripRecs({
      trip, items, message, history, edit,
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (!result) return res.status(502).json({ error: 'ה-AI לא הצליח לענות — נסו שוב עוד רגע' });
    quota.spend(); // the model call is the budgeted resource
    res.json({ ...result, remaining: quota.remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
// the edit route can only run on a trip that already exists in the DB, so tools/ai-eval
// reaches the model through this instead — everything it measures happens in here
module.exports.aiEditOps = aiEditOps;
// the eval checks edits against the same rules the repair pass enforces — one definition,
// so a tool that passes cannot mean something different from a trip that is valid
module.exports.editViolations = editViolations;
module.exports.applyOps = applyOps;
module.exports.daySpreadOutliers = daySpreadOutliers;
module.exports.repairPlaces = repairPlaces;
module.exports.foreignCountryStops = foreignCountryStops;
module.exports.tripCountryCodes = tripCountryCodes;
module.exports.tripRecs = tripRecs;
// the planning chat (routes/plan.js) runs the same build and the same op-writer
// inside a draft trip — one pipeline, so a chat-built trip is checked exactly like a
// wizard-built one
module.exports.buildItinerary = buildItinerary;
module.exports.buildQuota = buildQuota;
module.exports.buildErrorMessage = buildErrorMessage;
module.exports.BUILD_EXHAUSTED = BUILD_EXHAUSTED;
module.exports.applyEditOps = applyEditOps;
module.exports.undoApplied = undoApplied;
module.exports.verifyEditOps = verifyEditOps;
module.exports.verifyRecCards = verifyRecCards;
module.exports.REC_CATS = REC_CATS;
// the free-day picks (routes/day-recs.js) are the same card, verified the same way
module.exports.REC_CARD_SCHEMA = RECS_SCHEMA.properties.cards.items;
module.exports.REC_COSTS = REC_COSTS;
module.exports.aiJson = aiJson;
module.exports.aiClarify = aiClarify;
module.exports.aiTripMeta = aiTripMeta;
module.exports.cleanPresetPlan = cleanPresetPlan;
module.exports.destDescFull = destDescFull;
module.exports.cleanTime = cleanTime;
module.exports.cleanPlaceQuery = cleanPlaceQuery;
module.exports.cleanCost = cleanCost;
module.exports.AI_CATEGORIES = AI_CATEGORIES;
module.exports.AI_MODEL_STRONG = AI_MODEL_STRONG;
module.exports.AI_MODEL_WEAK = AI_MODEL_WEAK;
// routes/trips.js runs this after a publish-to-gallery toggle — fire-and-forget
module.exports.proofreadPublicTripCopy = proofreadPublicTripCopy;
