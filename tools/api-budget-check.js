// The budget meter's answer to Google's own gate, with no network, no key and no database
// (`npm test`). On 2026-11-01 Google refused SearchNearby with a 429 for its per-day
// quota while our monthly meter was still open, and every retry went back for another
// 429 that the page showed as a bare "502". The meter must take that 429 as "no budget"
// until the quota Google named opens again, and let the caller fall back without a call.
const { meter, clock } = require('../lib/api-budget');

let bad = 0;
const check = (ok, what) => { if (!ok) { bad++; console.log('  ✗ ' + what); } };

const realFetch = global.fetch;
const realWarn = console.warn;
let sent = 0;
let warned = 0;
console.warn = (msg) => { if (/Google refused/.test(String(msg))) warned++; }; // the no-database notice is not the one counted
const google = (status, body) => {
  sent++;
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
};

(async () => {
  // ---- a per-day refusal holds until the next Pacific midnight ----
  const m = meter('nearby_search');
  global.fetch = async () => google(429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'SearchNearbyRequest' and limit 'SearchNearbyRequest per day' of service 'places.googleapis.com'" } }));
  const first = await m.fetch('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST' });
  check(first && first.status === 429, 'the 429 itself is handed to the caller to read');
  check(sent === 1, 'the first ask reached Google');
  check(warned === 1, 'the hold is said in the log, once');
  const until = m.heldUntil();
  check(until instanceof Date, 'the meter is on hold');
  const reset = clock.nextDayReset();
  check(until && until.getTime() === reset.getTime(), 'the hold ends at the next Pacific midnight');
  const q = clock.ptParts(reset);
  check(q.h === 0 && q.d !== clock.ptParts().d, `midnight Pacific is midnight Pacific (${reset.toISOString()})`);

  global.fetch = async () => google(200, '{"places":[]}');
  const second = await m.fetch('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST' });
  check(second === null, 'while on hold, fetch answers null — the free path — without asking Google');
  check(sent === 1, 'no request left the process during the hold');
  check(warned === 1, 'a held call does not repeat the warning');
  check((await m.claim()) === false, 'claim() is refused during the hold');

  // ---- a per-minute refusal is a minute, not a day; a second one does not shorten a day ----
  const k = meter('nearby_kosher');
  global.fetch = async () => google(429, JSON.stringify({ error: { message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'" } }));
  await k.fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST' });
  const minute = k.heldUntil();
  check(minute && minute.getTime() - Date.now() <= 60 * 1000 && minute.getTime() > Date.now() + 50 * 1000, 'a per-minute quota holds for about a minute');
  global.fetch = async () => google(200, '{"places":[]}');
  check((await k.fetch('x', {})) === null, 'held for the minute too');
  m.hold('per minute');
  check(m.heldUntil().getTime() === until.getTime(), 'a shorter hold never cuts a longer one short');

  // ---- any other refusal is still a plain answer, and the meter stays open ----
  const p = meter('place_search');
  global.fetch = async () => google(400, '{"error":{"message":"bad field mask"}}');
  const r = await p.fetch('x', {});
  check(r && r.status === 400 && p.heldUntil() === null, 'a 400 is handed back and holds nothing');

  global.fetch = realFetch;
  console.warn = realWarn;
  console.log(bad ? `api-budget: ${bad} wrong` : 'api-budget: Google\'s 429 holds the meter until the quota it named opens; nothing else does');
  process.exit(bad ? 1 : 0);
})();
