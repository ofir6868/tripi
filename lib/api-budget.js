// Budget and cache for the paid third-party APIs — today, every Google Places call site.
// What each of them bills as, and where it stops, is defined once in lib/google-skus.js;
// this module is the machinery that holds the line.
//
// This is lib/quota.js's lesson applied to money instead of fairness. Every one of those
// call sites kept its own `new Map()` for the answers and, where it bothered to cap at
// all, its own `let used = 0` for the month. On the free Render instance — which restarts
// on every deploy and sleeps after fifteen idle minutes — a cache that lives in the
// process is not a cache and a monthly cap that lives in the process is not a cap: the
// same place was paid for again after every deploy, and the cap counted back from zero
// each time. A limit that forgets itself whenever the process does is not a limit; the
// same is true of a cache, except that a cache forgetting itself arrives as a bill.
//
// Three tables:
//   api_usage        (meter, month, count)  — what this month has cost, per SKU: the gate
//   api_usage_daily  (meter, day, …)        — what each day's calls came to: the record
//   api_cache        (scope, key, value)    — what we already bought
//
// The two usage tables ride in the escrow backup (lib/db-restore.js). The free database
// is replaced every month, a few days into it, and a counter that starts again from zero
// on the new one hands out an allowance Google has already half billed. A restored
// counter is at most one backup interval behind; a missing one is the whole month behind.
// The cache stays out: losing it costs repeat lookups, which the meters still bound.
const { pool } = require('./db');
const { byMeter, limitOf, SKUS } = require('./google-skus');

// ---- Google's calendar, not ours ----
// Free usage resets at midnight Pacific time on the 1st (lib/google-skus.js, fact 2), so
// the month a call belongs to — and the day, for the record — is read on that clock.
const PT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
function ptParts(at = new Date()) {
  const p = Object.fromEntries(PT.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}
const pad = (n) => String(n).padStart(2, '0');
const month = (at) => { const p = ptParts(at); return `${p.y}-${pad(p.m)}`; };
const day = (at) => { const p = ptParts(at); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const daysInMonth = (at) => { const p = ptParts(at); return new Date(Date.UTC(p.y, p.m, 0)).getUTCDate(); };
// the instant the next month's allowance opens: 00:00 Pacific on the 1st, which is 07:00
// or 08:00 UTC depending on daylight saving — whichever of the two reads as midnight there
function resetOf(y, m) {
  for (const h of [7, 8]) {
    const t = new Date(Date.UTC(y, m - 1, 1, h));
    const q = ptParts(t);
    if (q.d === 1 && q.h === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, 1, 8));
}
function nextReset(at = new Date()) {
  const p = ptParts(at);
  return p.m === 12 ? resetOf(p.y + 1, 1) : resetOf(p.y, p.m + 1);
}
const monthStart = (at = new Date()) => { const p = ptParts(at); return resetOf(p.y, p.m); };

// ---- pacing ----
// A month's allowance is released day by day, not all on the 1st: by day d of a month of
// D days a meter may have used d/D of it, plus PACE_AHEAD_DAYS days' worth of headroom.
// What a quiet day leaves unused carries forward. The point is the shape of the month —
// a crawler, a bug in a loop or one busy afternoon can use a few days of the allowance
// early, but it cannot use the month and leave the feature dark until the 1st. A refusal
// from pacing is the same null as a spent month, so the fallback is already in place.
const PACE_AHEAD_DAYS = 2;
function allowedBy(limit, at = new Date()) {
  if (limit === null) return null;
  return Math.min(limit, Math.ceil(limit * (ptParts(at).d + PACE_AHEAD_DAYS) / daysInMonth(at)));
}

// No DATABASE_URL at all is not "the database blinked" — it is a standalone run of one
// of the tools (tools/ai-eval, the probes), which has no server and no Postgres beside
// it. Those fall back to the in-process behaviour this module replaced: a counter and a
// cache that live for the length of the run. That is the right shape for a tool the
// PLAYBOOK says you run knowingly and pay for on purpose, and it keeps the audit's
// numbers comparable to the ones taken before any of this existed. Production always has
// DATABASE_URL, so production is always on the durable path.
const HAS_DB = !!process.env.DATABASE_URL;
let toldNoDb = false;
function noDbOnce() {
  if (toldNoDb) return;
  toldNoDb = true;
  console.warn('api-budget: no DATABASE_URL — budgets and caches are per-process for this run');
}

/* ------------------------------- the daily record ----------------------------- */

// What happened to every call, per meter per (Pacific) day — the admin page's numbers.
// Kept in memory and written once a minute, because a cache hit is the common case and a
// database write per hit would cost more than the hit saved. This is a record, not a
// gate: the gate is api_usage, written atomically on every claim. A crash loses at most a
// minute of the record and never a unit of the budget.
//
//   ok         answered 2xx — billed
//   rejected   answered anything else — not billed, claim given back
//   timeouts   never answered (timeout, network) — may have billed, so kept counted
//   refused    not sent: pacing or the month said no
//   cache_hits answered from api_cache — the call we did not have to make
const tally = new Map(); // "meter|day" → counts + last error
function note(meter, field, err) {
  const k = `${meter}|${day()}`;
  let t = tally.get(k);
  if (!t) { t = { ok: 0, rejected: 0, timeouts: 0, refused: 0, cache_hits: 0, last_error: null, last_error_at: null }; tally.set(k, t); }
  t[field]++;
  if (err) { t.last_error = String(err).slice(0, 300); t.last_error_at = new Date(); }
}

let flushing = null;
async function flushStats() {
  if (!HAS_DB) return;
  if (flushing) return flushing;
  const rows = [...tally.entries()];
  tally.clear();
  flushing = (async () => {
    for (const [k, t] of rows) {
      const [meter, d] = k.split('|');
      try {
        await pool.query(
          `INSERT INTO api_usage_daily (meter, day, ok, rejected, timeouts, refused, cache_hits, last_error, last_error_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (meter, day) DO UPDATE SET
             ok = api_usage_daily.ok + EXCLUDED.ok,
             rejected = api_usage_daily.rejected + EXCLUDED.rejected,
             timeouts = api_usage_daily.timeouts + EXCLUDED.timeouts,
             refused = api_usage_daily.refused + EXCLUDED.refused,
             cache_hits = api_usage_daily.cache_hits + EXCLUDED.cache_hits,
             last_error = COALESCE(EXCLUDED.last_error, api_usage_daily.last_error),
             last_error_at = COALESCE(EXCLUDED.last_error_at, api_usage_daily.last_error_at)`,
          [meter, d, t.ok, t.rejected, t.timeouts, t.refused, t.cache_hits, t.last_error, t.last_error_at]
        );
      } catch (err) {
        console.error(`api-budget: could not write the daily record for ${meter} (${err.code || err.message})`);
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
if (HAS_DB) setInterval(flushStats, 60 * 1000).unref();

/* ------------------------------- monthly meters ------------------------------ */

// One Google SKU's monthly allowance, as lib/google-skus.js defines it. claim() reserves
// calls atomically and answers whether they may go ahead; fetch() is claim + the call +
// giving the claim back when Google did not serve it, and it is what every call site uses.
//
// Two deliberate departures from lib/quota.js, both because the resource here is a bill
// rather than a traveller's patience:
//
//   1. It counts BEFORE the call, not after. Two requests landing together must not both
//      squeeze past the last unit, and a request that never answers may still have been
//      billed. What provably was not billed — any non-2xx answer — is given back after.
//      quota.js spends after the model answered for the mirrored reason: there, a failed
//      call gave the traveller nothing.
//
//   2. It fails CLOSED. quota.js lets a traveller through when the database blinks,
//      because refusing them costs us nothing. Here, letting the call through when the
//      counter cannot be read is exactly how an unbounded bill runs up with nobody
//      watching — so an unreachable database means "no budget", and the caller takes its
//      free path. Every paid call site has one.
const meters = new Map();
function meter(name) {
  if (meters.has(name)) return meters.get(name);
  const def = byMeter.get(name);
  if (!def) throw new Error(`api-budget: no SKU named ${name} in lib/google-skus.js`);
  const limit = limitOf(def); // null = unmetered: counted, never refused
  let warned = '';
  let local = { month: '', count: 0 }; // only used without a database — see HAS_DB above

  const m = {
    name,
    def,
    limit,
    allowedNow: (at) => allowedBy(limit, at),

    // true = n calls are reserved and already counted; false = paced out, spent, or unreadable
    async claim(n = 1) {
      const ceiling = allowedBy(limit);
      if (ceiling !== null && (ceiling <= 0 || n > ceiling)) { note(name, 'refused'); return false; }
      if (!HAS_DB) {
        noDbOnce();
        if (local.month !== month()) local = { month: month(), count: 0 };
        if (ceiling !== null && local.count + n > ceiling) { note(name, 'refused'); return false; }
        local.count += n;
        return true;
      }
      try {
        // One statement, so two requests landing together cannot both squeeze past the
        // last unit: the conditional DO UPDATE is what makes the claim atomic. The bare
        // INSERT path needs no condition — n <= ceiling is checked above, and it only
        // runs for the month's first call.
        const { rowCount } = await pool.query(
          `INSERT INTO api_usage (meter, month, count) VALUES ($1, $2, $3)
           ON CONFLICT (meter, month) DO UPDATE SET count = api_usage.count + $3
           WHERE $4::int IS NULL OR api_usage.count + $3 <= $4::int`,
          [name, month(), n, ceiling]
        );
        if (!rowCount) {
          note(name, 'refused');
          // routine per call but news per day — said once, so the day a feature quietly
          // starts serving its free path is a day somebody can find in the log
          if (warned !== day()) {
            warned = day();
            const why = ceiling < limit ? `paced at ${ceiling}/${limit} for day ${ptParts().d}` : `spent for ${month()} (${limit}/${limit})`;
            console.warn(`api-budget: ${name} ${why} — falling back to the free path`);
          }
          return false;
        }
        return true;
      } catch (err) {
        note(name, 'refused', `database: ${err.code || err.message}`);
        console.error(`api-budget: could not claim ${name} (${err.code || err.message}) — refusing the paid call`);
        return false; // fail closed: see (2) above
      }
    },

    // Give back a claim for a call that provably never billed. Without this, one
    // misconfigured field mask quietly eats a whole month's allowance on retries: the
    // errors are (correctly) never cached, so every boot asks again.
    async refund(n = 1) {
      if (!HAS_DB) { local.count = Math.max(0, local.count - n); return; }
      try {
        await pool.query(
          `UPDATE api_usage SET count = GREATEST(0, count - $3) WHERE meter = $1 AND month = $2`,
          [name, month(), n]
        );
      } catch (err) {
        console.error(`api-budget: could not refund ${name} (${err.code || err.message})`);
      }
    },

    // The one way a call site talks to Google. Same arguments as fetch; answers the
    // Response (ok or not, for the caller to read), or null when the budget said no —
    // which callers treat exactly like a missing key. A request that never answered
    // rethrows after it is recorded, and keeps its claim (fact 1 in lib/google-skus.js).
    async fetch(url, init) {
      if (!(await m.claim())) return null;
      return m.send(url, init);
    },

    // The call after a claim the caller already holds — for a call site that has to
    // wait for something between deciding it may spend and spending (lib/places.js
    // claims before its rate limiter, so a spent month costs no waiting).
    async send(url, init) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (err) {
        note(name, 'timeouts', err.name === 'AbortError' ? 'timeout' : `network: ${err.message}`);
        throw err;
      }
      if (res.ok) { note(name, 'ok'); return res; }
      await m.refund();
      const body = await res.clone().text().catch(() => '');
      note(name, 'rejected', `HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 240)}`);
      return res;
    },

    // for the admin page and the probes — never gates anything
    async used() {
      if (!HAS_DB) return local.month === month() ? local.count : 0;
      try {
        const { rows } = await pool.query(
          'SELECT count FROM api_usage WHERE meter = $1 AND month = $2', [name, month()]
        );
        return rows[0] ? rows[0].count : 0;
      } catch { return null; }
    },
  };
  meters.set(name, m);
  return m;
}

// every cache scope a SKU answers from, so a hit is credited to the call it saved
const scopeMeter = new Map(SKUS.flatMap((s) => s.scopes.map((sc) => [sc, s.meter])));

/* -------------------------------- answer cache ------------------------------- */

// Google's terms let us keep a place_id indefinitely but any other Places content for at
// most 30 consecutive days, so this is a ceiling on every scope rather than a tuning
// knob. It happens to be right for the photo URLs too: the lh3.googleusercontent.com
// link Google hands back is time-limited, and one kept forever eventually resolves to
// nothing and leaves the card blank.
const TTL_DAYS = 30;

const L1_MAX = 5000;
const l1 = new Map(); // "scope<NUL>key" → { value, at } — saves a query per card, not a bill

const SEP = String.fromCharCode(0); // a byte no scope name can contain, kept out of the source as an escape
const l1Key = (scope, key) => scope + SEP + key;
const fresh = (at, ttlDays) => Date.now() - at < ttlDays * 86400000;

function remember(lk, value) {
  if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value);
  l1.set(lk, { value, at: Date.now() });
}

const saved = (scope) => { const m = scopeMeter.get(scope); if (m) note(m, 'cache_hits'); };

// { hit, value } — `hit: true` with `value: null` is a remembered miss, and that is the
// entry that matters most: a place Google has no photo for costs exactly as much to ask
// about as one it does, so failing to remember the "no" is paying for it on repeat.
async function cacheGet(scope, key, { ttlDays = TTL_DAYS } = {}) {
  const lk = l1Key(scope, key);
  const hot = l1.get(lk);
  if (hot && fresh(hot.at, ttlDays)) { saved(scope); return { hit: true, value: hot.value }; }
  if (hot) l1.delete(lk);
  if (!HAS_DB) { noDbOnce(); return { hit: false, value: null }; }
  try {
    const { rows } = await pool.query(
      `SELECT value FROM api_cache
       WHERE scope = $1 AND key = $2 AND fetched_at > now() - ($3 || ' days')::interval`,
      [scope, key, String(ttlDays)]
    );
    if (!rows.length) return { hit: false, value: null };
    remember(lk, rows[0].value);
    saved(scope);
    return { hit: true, value: rows[0].value };
  } catch (err) {
    // a blinking database costs a cache hit, never a wrong answer — the caller pays for
    // a lookup it could have skipped, which is the safe direction to fail in
    console.error(`api-budget: cache read failed for ${scope} (${err.code || err.message})`);
    return { hit: false, value: null };
  }
}

async function cacheSet(scope, key, value) {
  remember(l1Key(scope, key), value);
  if (!HAS_DB) return;
  try {
    await pool.query(
      `INSERT INTO api_cache (scope, key, value, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
      [scope, key, value === null ? null : JSON.stringify(value)]
    );
  } catch (err) {
    console.error(`api-budget: cache write failed for ${scope} (${err.code || err.message})`);
  }
}

// Rows past the ceiling are unusable and must never be served, so they are swept rather
// than left to grow — one pass at boot is plenty for a table this size.
async function sweep() {
  if (!HAS_DB) return;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM api_cache WHERE fetched_at < now() - ($1 || ' days')::interval`, [String(TTL_DAYS)]
    );
    if (rowCount) console.log(`api-budget: swept ${rowCount} cache rows past ${TTL_DAYS} days`);
  } catch { /* the sweep is hygiene, never a reason to fail a boot */ }
}

// One promise per in-flight key, so N cards naming the same place pay for one lookup
// instead of N. Without it the recs route's Promise.all over the survivors is a race:
// they all miss the cache together, and they all buy the same answer.
const inFlight = new Map();
function once(key, run) {
  const running = inFlight.get(key);
  if (running) return running;
  const p = Promise.resolve().then(run).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

module.exports = {
  meter, cacheGet, cacheSet, sweep, once, flushStats, TTL_DAYS,
  clock: { month, day, daysInMonth, nextReset, monthStart, ptParts, allowedBy, PACE_AHEAD_DAYS },
};
