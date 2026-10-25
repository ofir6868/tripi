// The trip's flights, as a structure instead of a conversation.
//
// Settling the flights used to be four or five turns of chat: where do you fly from,
// when do you land, is there a connection, and the same again for the way back — every
// one of them a model call, and every answer a sentence the model had to parse back
// into a stop. The travellers' half of that was never free text to begin with: it is two
// airports, a day, two optional hours and, sometimes, a stopover.
//
// So it is a form now (the card in public/js/trip-plan.js), and this file is what the
// form is made of:
//   - the DEFAULTS it opens with, picked from the trip itself — the nearest real airport
//     to each area (public/js/airports.js), TLV at the near end;
//   - the CLEANING every saved plan goes through, so a code that is not an airport, a
//     day outside the trip or an invented hour never reaches the itinerary;
//   - the STOPS it writes: one per flown segment, so a connection in Istanbul is two
//     lines in the itinerary and not a sentence inside one.
// Nothing here calls a model, and nothing here invents an hour: a flight whose times the
// travellers don't know yet keeps the hour empty and says so in its note (PLAYBOOK §3 —
// an invented departure is a missed flight).
const AIRPORTS = require('../public/js/airports.js');
const COUNTRIES = require('../public/js/countries.js');
const DESTINATIONS = require('../public/js/destinations.js');

// where an Israeli trip starts and ends unless the travellers say otherwise. It is a
// default, not an assumption: both ends of every leg are editable in the card.
const HOME_CODE = 'TLV';
// When two consecutive areas are a flight rather than a drive. Distance alone cannot say
// it: Tokyo to Osaka is 400km and nobody flies it, while Athens to Santorini is 230km and
// everybody does — what separates them is the water. So an island at either end lowers
// the bar a long way, and everything else has to be far enough that a train stops being
// the answer. Under the bar the default plan simply stays quiet, and the travellers (or
// the model, which knows the routes) add the leg themselves.
const INNER_FLIGHT_MIN_KM = 600;
const ISLAND_FLIGHT_MIN_KM = 150;
const MAX_LEGS = 8;
const MAX_STOPS_PER_LEG = 2;
const KINDS = ['out', 'inner', 'return'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const cleanTime = (v) => (HHMM.test(String(v || '').trim()) ? String(v).trim() : '');

// "תל אביב" → "מתל אביב" / "לתל אביב"; a definite name loses its ה after ל, the way
// destinations.js builds "טיול ל…" ("האיים האזוריים" → "לאיים האזוריים")
const from = (name) => 'מ' + String(name || '');
const to = (name) => 'ל' + (String(name || '').startsWith('ה') ? String(name).slice(1) : String(name || ''));

// An airport as the card and the itinerary speak about it: a code from the index, or —
// when a traveller's airport is not in it — the name they typed, with no code. Both are
// honest; only the first can be put on a map.
function cleanAirport(raw) {
  if (!raw) return null;
  const code = String(raw.code || '').trim().toUpperCase();
  const known = AIRPORTS.byCode(code);
  if (known) return { code: known.code, name: known.city };
  const name = String(raw.name || '').trim().slice(0, 60);
  return name ? { code: '', name } : null;
}
const airportLabel = (a) => (a ? (AIRPORTS.byCode(a.code) || {}).city || a.name || a.code : '');
const airportFull = (a) => {
  const k = a && AIRPORTS.byCode(a.code);
  return k ? `${k.city}${k.name ? ` · ${k.name}` : ''} (${k.code})` : airportLabel(a);
};

function cleanLeg(raw, days) {
  if (!raw || typeof raw !== 'object') return null;
  const fromA = cleanAirport(raw.from);
  const toA = cleanAirport(raw.to);
  if (!fromA || !toA) return null;
  const day = Math.min(Math.max(parseInt(raw.day, 10) || 1, 1), Math.max(days, 1));
  const stops = (Array.isArray(raw.stops) ? raw.stops : []).slice(0, MAX_STOPS_PER_LEG)
    .map((s) => {
      const air = cleanAirport(s);
      return air ? { ...air, arrive: cleanTime(s.arrive), depart: cleanTime(s.depart) } : null;
    }).filter(Boolean);
  return {
    kind: KINDS.includes(raw.kind) ? raw.kind : 'inner',
    day,
    from: fromA,
    to: toA,
    depart: cleanTime(raw.depart),
    arrive: cleanTime(raw.arrive),
    stops,
  };
}

// the whole flights block of the planning memory — model-written and client-written JSON
// headed for a JSONB column, so every field is known and capped, exactly as the rest of
// cleanPlanState treats its own
function cleanFlights(raw, days) {
  if (!raw || typeof raw !== 'object') return null;
  const legs = (Array.isArray(raw.legs) ? raw.legs : []).slice(0, MAX_LEGS)
    .map((l) => cleanLeg(l, days)).filter(Boolean)
    .sort((a, b) => a.day - b.day);
  return {
    legs,
    confirmed: !!raw.confirmed,
    // the stops this card wrote last time: re-confirming replaces them instead of
    // laying a second set of flights on top of the first
    items: (Array.isArray(raw.items) ? raw.items : []).slice(0, 24)
      .map((n) => parseInt(n, 10)).filter(Number.isInteger),
  };
}

// ---------- the defaults ----------

// the trip as a list of stretches, each with the destination it belongs to: the split the
// travellers settled if there is one, the trip's destinations otherwise
function stretches(trip, state) {
  const dests = (Array.isArray(trip.destinations) ? trip.destinations : []).filter((d) => d && d.name);
  const areas = (state && Array.isArray(state.areas) ? state.areas : []).filter((a) => a && a.area);
  const byName = new Map(dests.map((d) => [d.name, d]));
  if (areas.length) {
    // consecutive blocks of the same area are one stretch — a flight is not taken twice
    // to the same place because the calendar was painted in two strokes
    const out = [];
    for (const a of areas) {
      const last = out[out.length - 1];
      if (last && last.name === a.area) { last.to = a.to; continue; }
      out.push({ name: a.area, from: a.from, to: a.to, dest: byName.get(a.area) || null, cities: a.cities || [] });
    }
    return out;
  }
  if (dests.length) {
    // no split yet: the destinations, in order, each given an equal share of the days
    const per = Math.max(1, Math.floor(trip.days / dests.length));
    return dests.map((d, i) => ({
      name: d.name,
      from: i * per + 1,
      to: i === dests.length - 1 ? trip.days : (i + 1) * per,
      dest: d,
      cities: [],
    }));
  }
  return [{ name: trip.destination || '', from: 1, to: trip.days, dest: null, cities: [] }];
}

// is this stretch an island? The curated index marks them (kind 'island'), which is the
// only place in the codebase that knows Koh Samui is not simply 460km from Bangkok.
function isIsland(s) {
  const name = (s.dest && s.dest.name) || s.name;
  const hit = DESTINATIONS.search(name, 1)[0];
  return !!hit && hit.kind === 'island';
}

// which country a stretch is in. The destination's own country when it has one; else
// the curated index, which knows that "פוקט" is Thailand — a destination typed as free
// text in the wizard arrives here with neither a country nor coordinates, and without
// this the card would open on a trip with no flights in it at all.
function ccOfStretch(s) {
  const name = (s.dest && (s.dest.country || s.dest.name)) || s.name;
  return COUNTRIES.ccByName(name)
    || (DESTINATIONS.search(name, 1)[0] || {}).cc
    || null;
}

// which airport serves a stretch. Coordinates first — that is the honest question ("what
// is nearest") — and the country as the fallback, because a destination that is a whole
// country ("יפן") has no coordinates worth measuring from.
function airportForStretch(s) {
  const d = s.dest;
  const cc = ccOfStretch(s);
  if (d && Number.isFinite(+d.lat) && Number.isFinite(+d.lon)) {
    const hit = AIRPORTS.near(+d.lat, +d.lon, { cc, max: 1 })[0];
    if (hit) return hit;
  }
  if (!cc) return null;
  // a country with one obvious way in gets it; otherwise the airport the index knows by
  // the place's own name ("פוקט" is HKT, not Bangkok) before the country's busiest
  const named = AIRPORTS.search(s.dest ? s.dest.name : s.name, 1)[0];
  if (named && named.cc === cc) return named;
  return AIRPORTS.inCountry(cc)[0] || null;
}

const ref = (a) => (a ? { code: a.code, name: a.city } : null);

// The plan the flights card opens with: out on day 1, back on the last day, and an
// internal flight wherever two consecutive areas are too far apart to drive. Hours are
// left empty on purpose — we do not know them, and the card asks for them as optional.
function defaultLegs(trip, state) {
  const home = AIRPORTS.byCode(HOME_CODE);
  const blocks = stretches(trip, state);
  const air = blocks.map(airportForStretch);
  const legs = [];
  const blank = { depart: '', arrive: '', stops: [] };
  const firstAir = air.find(Boolean);
  if (home && firstAir) legs.push({ kind: 'out', day: 1, from: ref(home), to: ref(firstAir), ...blank });
  for (let i = 1; i < blocks.length; i++) {
    const a = air[i - 1];
    const b = air[i];
    if (!a || !b || a.code === b.code) continue;
    const overSea = isIsland(blocks[i - 1]) || isIsland(blocks[i]);
    const bar = overSea ? ISLAND_FLIGHT_MIN_KM : INNER_FLIGHT_MIN_KM;
    if (AIRPORTS.distanceKm(a.lat, a.lon, b.lat, b.lon) < bar) continue;
    legs.push({ kind: 'inner', day: blocks[i].from, from: ref(a), to: ref(b), ...blank });
  }
  const lastAir = [...air].reverse().find(Boolean);
  if (home && lastAir) legs.push({ kind: 'return', day: trip.days, from: ref(lastAir), to: ref(home), ...blank });
  return legs.slice(0, MAX_LEGS);
}

// the model's answer (IATA codes only — it is never asked for hours) → legs, or null when
// it named an airport that does not exist, which is the whole reason the index is here
function legsFromModel(raw, days) {
  const rows = Array.isArray(raw) ? raw.slice(0, MAX_LEGS) : [];
  if (!rows.length) return null;
  const legs = [];
  for (const r of rows) {
    const fromA = AIRPORTS.byCode(r && r.from);
    const toA = AIRPORTS.byCode(r && r.to);
    if (!fromA || !toA || fromA.code === toA.code) return null;
    const via = (Array.isArray(r.via) ? r.via : []).slice(0, MAX_STOPS_PER_LEG).map((c) => AIRPORTS.byCode(c));
    if (via.some((v) => !v)) return null;
    legs.push({
      kind: KINDS.includes(r.kind) ? r.kind : 'inner',
      day: Math.min(Math.max(parseInt(r.day, 10) || 1, 1), Math.max(days, 1)),
      from: ref(fromA),
      to: ref(toA),
      depart: '',
      arrive: '',
      stops: via.map((v) => ({ ...ref(v), arrive: '', depart: '' })),
    });
  }
  return legs.sort((a, b) => a.day - b.day);
}

// ---------- what the itinerary gets ----------

// one leg → its flown segments: [{from, to, depart, arrive, connection}]. A connection is
// a segment of its own, because that is what it is to the traveller — a second boarding,
// at an hour they can miss.
function segmentsOf(leg) {
  const points = [{ ...leg.from, depart: leg.depart }, ...leg.stops.map((s) => ({ ...s })), { ...leg.to, arrive: leg.arrive }];
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push({
      from: points[i],
      to: points[i + 1],
      depart: points[i].depart || '',
      arrive: points[i + 1].arrive || '',
      connection: i > 0,
    });
  }
  return out;
}

function segmentNote(seg) {
  const parts = [];
  if (seg.connection) parts.push(`קונקשן ב${airportLabel(seg.from)}`);
  if (seg.depart && seg.arrive) parts.push(`המראה ${seg.depart}, נחיתה ${seg.arrive}`);
  else if (seg.depart) parts.push(`המראה ${seg.depart} — עדכנו את שעת הנחיתה כשתדעו`);
  else if (seg.arrive) parts.push(`נחיתה ${seg.arrive} — עדכנו את שעת ההמראה כשתדעו`);
  else parts.push('עדכנו את השעות כשיהיו לכם');
  return parts.join(' · ');
}

// the area a day belongs to, so a flight lands in the same column as the days around it
function areaOfDay(trip, state, day) {
  const areas = (state && Array.isArray(state.areas) ? state.areas : []);
  const block = areas.find((a) => day >= a.from && day <= a.to);
  if (block) return block.area;
  const dests = (Array.isArray(trip.destinations) ? trip.destinations : []).filter((d) => d && d.name);
  return dests.length ? dests[0].name : (trip.destination || null);
}

// legs → rows for trip_items. place_query stays null: an airport is not a stop we ask the
// geocoder to vouch for, and a travel leg never wants a photo or opening hours.
function flightItems(legs, trip, state) {
  const rows = [];
  for (const leg of legs) {
    // a flight that lands the day after it took off is still one day's business here:
    // the itinerary has no overnight column, and the note carries the landing hour.
    // A CONNECTION that takes off after midnight is another matter: TLV 21:30 → DXB,
    // DXB 04:15 → HND is two days, and on one day the 04:15 leg sorted ahead of the
    // 21:30 one — the trip read as if it started in Dubai. A segment whose clock runs
    // earlier than the one before it has crossed midnight, and moves a day forward.
    let day = leg.day;
    let clock = '';
    for (const seg of segmentsOf(leg)) {
      const at = seg.depart || seg.arrive || '';
      if (clock && at && at < clock) day = Math.min(day + 1, Math.max(trip.days, 1));
      if (at) clock = at;
      rows.push({
        day_number: day,
        time_label: seg.depart || null,
        title: `טיסה ${from(airportLabel(seg.from))} ${to(airportLabel(seg.to))}`.slice(0, 200),
        note: segmentNote(seg).slice(0, 500),
        category: 'נסיעה',
        area: areaOfDay(trip, state, day),
      });
    }
  }
  return rows;
}

// one line per leg, for the chat's own message and for the planning memory the model
// reads back ("what did we settle about the flights?")
function legLine(leg) {
  const via = leg.stops.length ? ` (דרך ${leg.stops.map(airportLabel).join(', ')})` : '';
  const when = [leg.depart && `המראה ${leg.depart}`, leg.arrive && `נחיתה ${leg.arrive}`].filter(Boolean).join(', ');
  const label = { out: 'הלוך', inner: 'טיסה פנימית', return: 'חזור' }[leg.kind] || 'טיסה';
  return `${label} · יום ${leg.day}: ${airportFull(leg.from)} ${to(airportLabel(leg.to))}${via}${when ? ` — ${when}` : ' — בלי שעות עדיין'}`;
}
const legsSummary = (legs) => legs.map(legLine).join(' | ');

module.exports = {
  HOME_CODE,
  cleanFlights,
  cleanLeg,
  defaultLegs,
  legsFromModel,
  flightItems,
  legsSummary,
  legLine,
  segmentsOf,
  airportLabel,
  airportFull,
};
