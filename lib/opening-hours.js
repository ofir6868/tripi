// Is the door open when we sent the traveller to it?
//
// lib/places.js verifies a place exists in SPACE — the geocoder was asked whether
// anything by that name stands there. Nothing has ever verified it in TIME, and the
// model is exactly as unreliable about "the museum is shut on Mondays" as it is about
// whether the restaurant exists at all. The difference is where the failure lands: an
// invented place is caught in the build, by us; a closed door is caught at the door, by
// the traveller, at 10:00, with no way to recover the morning.
//
// verifyOpen(hours, date, time) → { verdict, ... }
//   open      the door is open then
//   closed    it is shut then
//   unknown   we hold no hours, or the tag says something this parser will not guess at
//   skipped   network trouble — NOT evidence about the place; callers fail open
//
// The rule that governs every line below: a wrong 'closed' is worse than no answer. A
// traveller who drops the Louvre because we misread a tag lost more than one who was
// never warned. So anything the parser does not fully understand is 'unknown', never a
// guess, and the supported syntax is deliberately a subset of the opening_hours spec.
//
// Two sources, free one first, exactly as lib/hotel-content.js does with osm/liteapi:
//   OSM      the place's own `opening_hours` tag, keyless and unmetered
//   Google   regularOpeningHours, already structured — the paid upgrade, budgeted and
//            cached through lib/api-budget.js like every other Google call site
const { meter, cacheGet, cacheSet, once } = require('./api-budget');

const DAYS = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Syntax this parser will not guess at. Every one of these changes whether a door is
// open in a way we cannot compute here, so a tag carrying one is answered 'unknown'
// rather than approximated:
//   sunrise/sunset/dawn/dusk  needs the sun's position at that latitude and date
//   week / [ ]                "every second Tuesday", "the first Sunday of the month"
//   easter                    a moving feast
//   SH                        school holidays, which are a regional calendar
//   -                         (in a time) open-ended "09:00+" has no closing time
// "Jan 01,May 01,Dec 25 off" — one or more Month-Day pairs, then what happens on them
const DATE_LIST_RE = /^([A-Za-z]{3}\s+\d{1,2}(?:\s*,\s*[A-Za-z]{3}\s+\d{1,2})*)\s+(.+)$/;

const UNSUPPORTED = /sunrise|sunset|dawn|dusk|\bweek\b|\[|easter|\bSH\b|\d{2}:\d{2}\s*\+/i;

/* ------------------------------- parsing OSM -------------------------------- */

// "09:00-17:00" → { from: 540, to: 1020 }. A range that ends before it starts is an
// overnight one ("18:00-02:00"): kept as to > 1440 so the evaluator can spill it into
// the following day rather than silently treating it as an empty window.
function parseRange(text) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const from = +m[1] * 60 + +m[2];
  let to = +m[3] * 60 + +m[4];
  if (to === 0 && from > 0) to = 1440;        // "18:00-00:00" closes at midnight
  if (to <= from) to += 1440;                  // overnight
  if (from < 0 || from > 1440 || to > 2880) return null;
  return { from, to };
}

// "Mo-Fr" / "Mo,We,Fr" / "Tu" → a Set of weekday numbers, or null if unparseable
function parseDays(text) {
  const out = new Set();
  for (const part of text.split(',')) {
    const range = /^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/.exec(part.trim());
    if (range) {
      const a = DAYS[range[1].toLowerCase()];
      const b = DAYS[range[2].toLowerCase()];
      if (a === undefined || b === undefined) return null;
      // Sa-Su and Fr-Mo both wrap the week end — walk forward, never assume a < b
      for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
      continue;
    }
    const one = DAYS[part.trim().toLowerCase()];
    if (one === undefined) return null;
    out.add(one);
  }
  return out.size ? out : null;
}

// "Jan-Mar" → { from: 0, to: 2 }; a single month is a range of one
function parseMonths(text) {
  const range = /^([A-Za-z]{3})\s*-\s*([A-Za-z]{3})$/.exec(text.trim());
  if (range) {
    const a = MONTHS[range[1].toLowerCase()];
    const b = MONTHS[range[2].toLowerCase()];
    if (a === undefined || b === undefined) return null;
    return { from: a, to: b };
  }
  const one = MONTHS[text.trim().toLowerCase()];
  return one === undefined ? null : { from: one, to: one };
}

// A tag is rules separated by ';'. Later rules override earlier ones for the days they
// name — that is the spec's own semantics and the reason "Mo-Su 09:00-18:00; We off"
// means what a human reads it to mean.
//
// → { ok: true, rules, ignoresHolidays } | { ok: false, reason }
function parseOpeningHours(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (UNSUPPORTED.test(raw)) return { ok: false, reason: 'unsupported syntax' };
  if (/^24\/7$/i.test(raw)) return { ok: true, rules: [{ months: null, days: null, intervals: [{ from: 0, to: 1440 }] }], ignoresHolidays: false };

  const rules = [];
  let ignoresHolidays = false;

  for (const chunk of raw.split(';')) {
    let text = chunk.trim();
    if (!text) continue;

    // A public-holiday rule cannot be evaluated without a holiday calendar for the
    // destination, which we do not have. Dropping the rule keeps the rest of the tag
    // usable — the common "Mo-Su 10:00-18:00; PH off" still answers every ordinary day
    // correctly — and the flag travels with the verdict so a caller can say so out loud
    // rather than quietly promising a museum is open on Christmas.
    if (/\bPH\b/i.test(text)) { ignoresHolidays = true; continue; }

    // Specific calendar dates: "Jan 01,May 01,Dec 25 off". The national holidays a
    // museum shuts for, and the single most common thing in a real tag that this
    // refused to read — the Louvre's own tag ends in exactly that clause, and without
    // it the whole tag came back 'unknown' and the other four rules went to waste.
    const dateList = DATE_LIST_RE.exec(text);
    if (dateList) {
      const dates = [];
      for (const piece of dateList[1].split(',')) {
        const m = /^([A-Za-z]{3})\s+(\d{1,2})$/.exec(piece.trim());
        const mon = m && MONTHS[m[1].toLowerCase()];
        if (mon === undefined || mon === null) return { ok: false, reason: 'bad date list' };
        dates.push({ month: mon, day: +m[2] });
      }
      const rest = dateList[2].trim();
      if (/^(off|closed)$/i.test(rest)) { rules.push({ dates, months: null, days: null, intervals: null }); continue; }
      const ivs = [];
      for (const piece of rest.split(',')) {
        const r = parseRange(piece);
        if (!r) return { ok: false, reason: `unparsed time "${piece.trim()}" after a date` };
        ivs.push(r);
      }
      rules.push({ dates, months: null, days: null, intervals: ivs });
      continue;
    }

    let months = null;
    // a leading month range scopes the rule: "Apr-Oct Mo-Su 09:00-19:00"
    const monthLead = /^((?:[A-Za-z]{3})(?:\s*-\s*[A-Za-z]{3})?)\s+(?=[A-Za-z]{2}[\s,-]|\d)/.exec(text);
    if (monthLead && MONTHS[monthLead[1].slice(0, 3).toLowerCase()] !== undefined) {
      months = parseMonths(monthLead[1]);
      if (!months) return { ok: false, reason: 'bad month range' };
      text = text.slice(monthLead[0].length).trim();
    }

    if (/^(off|closed)$/i.test(text)) { rules.push({ months, days: null, intervals: null }); continue; }

    // what is left is [days] (times | off)
    const split = /^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s+(.+)$/.exec(text);
    let days = null;
    let rest = text;
    if (split) {
      days = parseDays(split[1]);
      if (!days) return { ok: false, reason: 'bad day range' };
      rest = split[2].trim();
    }

    if (/^(off|closed)$/i.test(rest)) { rules.push({ months, days, intervals: null }); continue; }

    const intervals = [];
    for (const piece of rest.split(',')) {
      const r = parseRange(piece);
      if (!r) return { ok: false, reason: `unparsed time "${piece.trim()}"` };
      intervals.push(r);
    }
    if (!intervals.length) return { ok: false, reason: 'no times' };
    rules.push({ months, days, intervals });
  }

  if (!rules.length) return { ok: false, reason: 'nothing parsed' };
  return { ok: true, rules, ignoresHolidays };
}

/* ------------------------------ evaluating ---------------------------------- */

const monthInRange = (m, r) => (r.from <= r.to ? m >= r.from && m <= r.to : m >= r.from || m <= r.to);

function ruleApplies(rule, date) {
  // a rule naming exact dates speaks only for those days, and is silent on every other
  // one — which is what lets "Dec 25 off" close Christmas without touching December
  if (rule.dates) return rule.dates.some((x) => x.month === date.getMonth() && x.day === date.getDate());
  if (rule.months && !monthInRange(date.getMonth(), rule.months)) return false;
  return rule.days === null || rule.days.has(date.getDay());
}

// The intervals in force on one date, in minutes from that date's midnight, including
// anything that spilled over from the night before. `covered` says whether any rule
// spoke for this date at all — silence and a closure are not the same thing.
function intervalsOn(rules, date) {
  const out = [];
  // last applicable rule wins for this day — later rules override earlier ones
  let chosen = null;
  for (const rule of rules) if (ruleApplies(rule, date)) chosen = rule;
  if (chosen && chosen.intervals) {
    for (const iv of chosen.intervals) out.push({ from: iv.from, to: Math.min(iv.to, 1440) });
  }
  out.covered = !!chosen;
  // yesterday's overnight tail: "Fr 18:00-02:00" is open on Saturday morning too
  const prev = new Date(date.getTime() - 86400000);
  let prevChosen = null;
  for (const rule of rules) if (ruleApplies(rule, prev)) prevChosen = rule;
  if (prevChosen && prevChosen.intervals) {
    for (const iv of prevChosen.intervals) if (iv.to > 1440) out.push({ from: 0, to: iv.to - 1440 });
  }
  return out;
}

const insideAny = (intervals, minutes) => intervals.some((iv) => minutes >= iv.from && minutes < iv.to);

/* --------------------------- the one public verdict -------------------------- */

// hours is whatever placeHours() returned: { source, tag } from OSM, { source, periods }
// from Google, or null. date is a Date (the stop's real calendar day), time is "HH:MM".
//
// A stop with no clock time is judged at noon: it is the hour that separates a place
// open during the day from one that is shut that day entirely, which is the distinction
// worth making when we do not know when they will actually walk up.
function verifyOpen(hours, date, time) {
  if (!hours) return { verdict: 'unknown', reason: 'no hours on file' };
  if (hours.source === 'error') return { verdict: 'skipped', reason: 'lookup failed' };

  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  const minutes = m ? +m[1] * 60 + +m[2] : 12 * 60;
  const assumedNoon = !m;

  if (hours.source === 'google') {
    // Google hands the week over already structured, so there is nothing to parse and
    // nothing to guess at. An empty periods array from Google means permanently closed.
    const periods = Array.isArray(hours.periods) ? hours.periods : null;
    if (!periods) return { verdict: 'unknown', reason: 'no hours on file' };
    if (!periods.length) return { verdict: 'closed', reason: 'גוגל מדווח שהמקום סגור', source: 'google', assumedNoon };
    const rules = periods.map((p) => {
      if (!p.open || typeof p.open.day !== 'number') return null;
      const from = (p.open.hour || 0) * 60 + (p.open.minute || 0);
      // a period with no close is open from then on — Google uses this for 24h places
      if (!p.close) return { months: null, days: new Set([p.open.day]), intervals: [{ from, to: 1440 }] };
      let to = (p.close.hour || 0) * 60 + (p.close.minute || 0);
      if (p.close.day !== p.open.day || to <= from) to += 1440;
      return { months: null, days: new Set([p.open.day]), intervals: [{ from, to }] };
    }).filter(Boolean);
    if (!rules.length) return { verdict: 'unknown', reason: 'hours unreadable' };
    // Google's periods are additive, not overriding: every one of them opens the door,
    // so they are evaluated together rather than last-wins the way an OSM tag is
    const all = rules.flatMap((r) => intervalsOn([r], date));
    return insideAny(all, minutes)
      ? { verdict: 'open', source: 'google', assumedNoon }
      : { verdict: 'closed', reason: 'סגור בשעה הזו לפי גוגל', source: 'google', assumedNoon };
  }

  const parsed = parseOpeningHours(hours.tag);
  if (!parsed.ok) return { verdict: 'unknown', reason: parsed.reason, source: 'osm', tag: hours.tag };
  const intervals = intervalsOn(parsed.rules, date);
  const common = { source: 'osm', tag: hours.tag, ignoresHolidays: parsed.ignoresHolidays, assumedNoon };
  if (insideAny(intervals, minutes)) return { verdict: 'open', ...common };

  // A day no rule speaks for is only shut if the tag says when the place IS open. Some
  // tags carry nothing but closures — "Su off" on its own is very common — and those say
  // "not on Sundays" while saying nothing whatever about Friday. Reading that as shut
  // produced three false 'closed' verdicts in the first real audit, on a market that was
  // open: exactly the wrong answer to give, since a traveller who drops a stop over it
  // loses more than one who was never warned.
  if (!intervals.covered && !parsed.rules.some((r) => r.intervals)) {
    return { verdict: 'unknown', reason: 'the tag only says when it is shut, never when it is open', ...common };
  }
  return { verdict: 'closed', reason: 'סגור בשעה הזו לפי OpenStreetMap', ...common };
}

/* --------------------------------- sources ---------------------------------- */

const OSM_SCOPE = 'osm_hours';
const GOOGLE_SCOPE = 'google_hours';
// Opening hours sit in Google's Place Details "Enterprise" SKU, whose free allowance is
// 1,000 calls a month — the same size as the photo tier's, but its own pool. The ceiling
// keeps the default configuration unable to bill; the durable cache is what makes 1,000
// plenty, because hours are near-static and the bill scales with distinct places rather
// than with trips.
const hoursBudget = meter('place_hours'); // lib/google-skus.js
const googleSaid = new Set(); // statuses already reported this process

// Failures carry their status and their body out with them. A source that stops
// answering has to leave a trace (PLAYBOOK §2), and the first run of this against
// production proved the point the hard way: 47 lookups came back 'skipped' with nothing
// anywhere saying whether that was a 403, a bad field name or a timeout.
async function fetchJson(url, timeoutMs, headers, doFetch = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, headers });
    if (!res) return { ok: false, refused: true, data: null, status: 0, body: 'budget' };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, data: null, status: res.status, body: body.slice(0, 300) };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, data: null, status: 0, body: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// The keyless road. Photon hands back the osm_id and osm_type of whatever it matched
// (lib/places.js carries them through verification), and the OSM element endpoint turns
// that pair into the element's full tag set — including opening_hours. Overpass would
// answer the same question, but every public mirror times out from the deployed host
// (lib/hotel-content.js, measured 2026-08-19), which is why this takes the plain element
// route instead: a different host, and a far lighter request.
// Accepts either spelling of the element kind. lib/places.js normalises Photon's single
// letter on the way in, but rows written before it did carry "n"/"w"/"r" — and a lookup
// that silently answers null for them looks exactly like a place with no hours, which is
// how the first full-chain run reported an untagged Louvre in 0ms without ever asking.
const OSM_KIND = { n: 'node', w: 'way', r: 'relation', node: 'node', way: 'way', relation: 'relation' };

async function osmHours(osmType, osmId, { timeoutMs = 5000 } = {}) {
  const type = OSM_KIND[String(osmType || '').toLowerCase()];
  if (!type || !/^\d+$/.test(String(osmId))) return null;
  const key = `${type}/${osmId}`;

  const hit = await cacheGet(OSM_SCOPE, key);
  if (hit.hit) return hit.value;

  return once(OSM_SCOPE + key, async () => {
    const again = await cacheGet(OSM_SCOPE, key);
    if (again.hit) return again.value;
    const res = await fetchJson(`https://api.openstreetmap.org/api/0.6/${type}/${osmId}.json`, timeoutMs,
      { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; opening hours)', Accept: 'application/json' });
    if (!res.ok) {
      console.warn(`opening-hours: OSM ${type}/${osmId} failed (${res.status || 'network'}) ${String(res.body || '').slice(0, 120)}`);
      return { source: 'error' }; // never cached — a blip is not an answer
    }
    const el = res.data && Array.isArray(res.data.elements) ? res.data.elements[0] : null;
    const tag = el && el.tags ? el.tags.opening_hours : null;
    // a place with no opening_hours tag is cached as such: the absence is a real finding
    // about OSM's coverage, and asking again tomorrow will not change it
    const out = tag ? { source: 'osm', tag } : null;
    await cacheSet(OSM_SCOPE, key, out);
    return out;
  });
}

// The paid road, for what OSM has no tag for.
async function googleHours(placeId, { timeoutMs = 5000 } = {}) {
  const key = String(placeId || '');
  if (!key || !process.env.GOOGLE_PLACES_API_KEY) return null;

  const hit = await cacheGet(GOOGLE_SCOPE, key);
  if (hit.hit) return hit.value;

  return once(GOOGLE_SCOPE + key, async () => {
    const again = await cacheGet(GOOGLE_SCOPE, key);
    if (again.hit) return again.value;
    // the meter claims, calls, and gives the claim back for anything Google did not serve —
    // a 429 at the daily quota gate included (lib/api-budget.js)
    const res = await fetchJson(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(key)}?fields=regularOpeningHours,businessStatus`,
      timeoutMs, { 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, Accept: 'application/json' },
      hoursBudget.fetch
    );
    if (res.refused) return null; // spent or paced → we simply do not know
    if (!res.ok) {
      // once per process per status: a whole trip's worth of the same 403 is one fact,
      // not forty-seven, but the fact itself must not go unsaid
      if (!googleSaid.has(res.status)) {
        googleSaid.add(res.status);
        console.error(`opening-hours: Google hours failed (HTTP ${res.status || 'network'}) — ${String(res.body || '').slice(0, 220)}`);
      }
      return { source: 'error' };
    }
    const d = res.data || {};
    // a place Google knows to be gone is the strongest signal either source can give
    if (d.businessStatus === 'CLOSED_PERMANENTLY') {
      const gone = { source: 'google', periods: [], permanentlyClosed: true };
      await cacheSet(GOOGLE_SCOPE, key, gone);
      return gone;
    }
    const periods = d.regularOpeningHours && Array.isArray(d.regularOpeningHours.periods)
      ? d.regularOpeningHours.periods : null;
    const out = periods ? { source: 'google', periods } : null;
    await cacheSet(GOOGLE_SCOPE, key, out);
    return out;
  });
}

// Free source first, paid one only for what it could not answer — the same shape as
// every other optional provider in this codebase.
async function placeHours({ osmType = null, osmId = null, googlePlaceId = null } = {}) {
  // A source that could not be reached must not come back looking like a source that
  // answered "nothing known". Both are non-committal, so neither ever shuts a door on a
  // traveller — but an audit that reads an unreachable host as "OSM has no hours for
  // this place" concludes that coverage is poor when the truth is that the host is
  // blocked, and then someone buys a Google plan to fix a firewall. A failure that
  // disguises itself as a finding is the dangerous kind (PLAYBOOK §2).
  let unreachable = false;

  if (osmType && osmId) {
    const osm = await osmHours(osmType, osmId).catch(() => ({ source: 'error' }));
    if (osm && osm.source === 'osm') return osm;
    if (osm && osm.source === 'error') unreachable = true;
  }
  if (googlePlaceId) {
    const g = await googleHours(googlePlaceId).catch(() => ({ source: 'error' }));
    if (g && g.source === 'google') return g;
    if (g && g.source === 'error') unreachable = true;
  }
  return unreachable ? { source: 'error' } : null;
}

module.exports = {
  verifyOpen, placeHours, osmHours, googleHours, hoursBudget,
  _test: { parseOpeningHours, intervalsOn, parseRange, parseDays },
};
