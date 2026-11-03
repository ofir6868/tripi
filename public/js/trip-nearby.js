// "מה עושים עכשיו" — the trip page's in-trip screen.
//
// Opened while the trip is happening, it answers the two questions the itinerary does
// not: what is worth doing around here, and where do we eat. It opens by itself the
// first time the trip page is opened on a trip day (and again after a few hours), and a
// banner above the itinerary brings it back at any time.
//
// Where "here" is: the traveller's position if they allow it; if they don't (or the
// phone can't tell), the place the itinerary says they should be right now — today's
// next stop by the clock, else today's last one, else the day's area. The screen always
// says which of the two it is using, and switching is one tap.
//
// The lists come from routes/nearby.js (Google Places, budgeted and cached there). One
// answer carries everything a card's details show, so opening a card fetches nothing —
// only its photos, which bill per picture, load when they come into view.
const TripNearby = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const K = NEARBY_KINDS;
  const SEEN_KEY = 'tripmaker_nearby_seen';
  const AUTO_EVERY_MS = 3 * 60 * 60 * 1000; // the full screen on its own at most every three hours

  let ctx = null;
  let st = null;
  let slots = null;

  const ICON = {
    gmaps: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    waze: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 16.5A8 8 0 1 1 20 11c0 3.3-2.3 5.5-5 5.5H9.8"/><circle cx="8" cy="19" r="1.7"/><circle cx="16" cy="19" r="1.7"/><path d="M10 9.5h.01M15 9.5h.01"/><path d="M10 12.5a3 3 0 0 0 5 0"/></svg>',
    pin: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    route: TRIPMAKER.routeIcon,
    globe: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>',
    phone: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
  };

  // ---------------------------------------------------------------- the trip's day

  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  // the trip day today falls on, or 0 when today is not a trip day (same reading as
  // trip.js's trackInTripOpen, so the event and the screen agree on what "during" is)
  function liveDay() {
    const trip = ctx.trip;
    if (!trip.start_date) return 0;
    const start = startOfDay(trip.start_date);
    const end = trip.end_date ? startOfDay(trip.end_date) : start + Math.max((trip.days || 1) - 1, 0) * 86400000;
    const today = startOfDay(Date.now());
    if (today < start || today > end) return 0;
    return Math.round((today - start) / 86400000) + 1;
  }
  // the day the "by the plan" location is read from: today on a trip day, else day 1
  const planDay = () => liveDay() || 1;

  const clockMin = (t) => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(t || '').trim());
    return m ? +m[1] * 60 + +m[2] : null;
  };

  // where the itinerary says the traveller is: today's next stop by the clock, else the
  // last one already passed, else the first of the day — any stop that has coordinates
  async function planPoint() {
    const day = planDay();
    const stops = (ctx.state.items || []).filter((it) => it.day_number === day && it.lat != null && it.lon != null && it.category !== 'נסיעה');
    if (stops.length) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const timed = stops.filter((s) => clockMin(s.time_label) != null);
      let pick = null;
      if (liveDay() && timed.length) {
        pick = timed.find((s) => clockMin(s.time_label) >= nowMin - 30) || timed[timed.length - 1];
      }
      pick = pick || stops[0];
      return { lat: +pick.lat, lon: +pick.lon, label: `ליד ${pick.title}`, day };
    }
    // no located stop that day: the day's area, as the trip's destinations hold it
    const area = ctx.defaultArea(day) || ctx.trip.destination;
    const dests = Array.isArray(ctx.trip.destinations) ? ctx.trip.destinations : [];
    const d = dests.find((x) => x && x.name === area && x.lat != null) || dests.find((x) => x && x.lat != null);
    if (d && d.name === area) return { lat: +d.lat, lon: +d.lon, label: `ב${area}`, day };
    if (area && typeof GEO !== 'undefined') {
      const found = await GEO.searchPlaces(area).catch(() => []);
      if (found[0]) return { lat: +found[0].lat, lon: +found[0].lon, label: `ב${area}`, day };
    }
    if (d) return { lat: +d.lat, lon: +d.lon, label: `ב${d.name}`, day };
    return null;
  }

  // ---------------------------------------------------------------- geolocation

  function gps() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
      const ask = () => navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => reject(e),
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 2 * 60 * 1000 }
      );
      // an answer the traveller already gave is not asked again — "denied" goes straight
      // to the plan instead of waiting out a prompt that will never show
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' })
          .then((s) => (s.state === 'denied' ? reject(new Error('denied')) : ask()))
          .catch(ask);
      } else ask();
    });
  }

  // ---------------------------------------------------------------- geometry & text

  function dist(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
      + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function distText(m) {
    if (m == null) return '';
    const far = m < 1000 ? `${Math.round(m / 10) * 10} מ׳` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} ק״מ`;
    return m <= 2500 ? `${far} · ${Math.max(1, Math.round(m / 80))} דק׳ הליכה` : far;
  }
  const countText = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

  // open right now, at the place's own clock (Google's utcOffset), from its weekly periods
  function openState(p) {
    const periods = p.hours && p.hours.periods;
    if (!periods || !periods.length) return null;
    if (periods.length === 1 && !periods[0].close) return { open: true, text: 'פתוח 24 שעות' };
    const now = new Date();
    const local = p.utc != null ? new Date(now.getTime() + (p.utc + now.getTimezoneOffset()) * 60000) : now;
    const W = 7 * 1440;
    const t = local.getDay() * 1440 + local.getHours() * 60 + local.getMinutes();
    const at = (x) => x.day * 1440 + (x.hour || 0) * 60 + (x.minute || 0);
    const hhmm = (x) => `${String(x.hour || 0).padStart(2, '0')}:${String(x.minute || 0).padStart(2, '0')}`;
    let next = null;
    for (const per of periods) {
      if (!per.open || !per.close) continue;
      const o = at(per.open);
      let c = at(per.close);
      if (c <= o) c += W;
      for (const shift of [0, -W]) {
        if (t >= o + shift && t < c + shift) return { open: true, text: `פתוח עכשיו · עד ${hhmm(per.close)}`, soon: c + shift - t <= 45 };
      }
      const wait = (o - t + W) % W;
      if (!next || wait < next.wait) next = { wait, per };
    }
    if (!next) return null;
    const when = next.wait < 1440 - (t % 1440) ? hhmm(next.per.open) : `${['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][next.per.open.day]} ${hhmm(next.per.open)}`;
    return { open: false, text: `סגור עכשיו · נפתח ${next.wait < 1440 - (t % 1440) ? 'ב-' : 'ביום '}${when}` };
  }
  // Google orders weekdayDescriptions Monday first
  function todayLine(p) {
    const lines = p.hours && p.hours.lines;
    if (!lines || lines.length !== 7) return '';
    const now = new Date();
    const local = p.utc != null ? new Date(now.getTime() + (p.utc + now.getTimezoneOffset()) * 60000) : now;
    return lines[(local.getDay() + 6) % 7] || '';
  }

  const navLinks = (p) => ({
    gmaps: p.source && p.source !== 'google'
      ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat}%2C${p.lon}`
      : 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(p.name)
        + '&destination_place_id=' + encodeURIComponent(p.id),
    waze: `https://waze.com/ul?ll=${p.lat}%2C${p.lon}&navigate=yes&zoom=17`,
  });

  // a place the itinerary already holds — by Google's id, else by name
  function inTrip(p) {
    const name = p.name.toLowerCase();
    return (ctx.state.items || []).some((it) => (it.google_place_id && it.google_place_id === p.id)
      || (it.title && it.title.toLowerCase() === name));
  }

  // ---------------------------------------------------------------- data

  async function fetchKind(kind, cuisine) {
    const o = st.origin;
    const key = `${kind}|${cuisine || ''}|${o.lat.toFixed(3)},${o.lon.toFixed(3)}`;
    if (st.cache.has(key)) return st.cache.get(key);
    const q = new URLSearchParams({ kind, lat: o.lat.toFixed(5), lon: o.lon.toFixed(5) });
    if (cuisine) q.set('cuisine', cuisine);
    const p = TRIPMAKER.api(`/api/trips/code/${encodeURIComponent(ctx.trip.share_code)}/nearby?${q}`)
      .then((d) => {
        const list = d.places.map((x) => ({ ...x, dist: dist(o, x) }));
        list.source = d.source || 'google'; // sights may come from Wikipedia when Google is closed
        return list;
      })
      .catch(async (err) => {
        // Google closed (503): restaurants come from OpenStreetMap, asked from the phone —
        // the server answers sights from Wikipedia itself
        if (err.status === 503 && kind !== 'sights') {
          try { return fromOsm(kind, cuisine, await osmFood(o)); } catch { /* the original message says more */ }
        }
        st.cache.delete(key);
        throw err;
      });
    st.cache.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------- when Google is closed
  //
  // The restaurants' free answer: OpenStreetMap, through Overpass. Asked from the browser
  // and not the server, because every public Overpass mirror refuses datacenter addresses
  // (lib/hotel-content.js, measured 2026-08-19) — a phone is not a datacenter. OSM knows a
  // restaurant exists, its cuisine, its hours and often whether it is kosher (diet:kosher);
  // it does not know how good it is, so the list is by distance and says so. One question
  // per spot covers the general list, every cuisine chip and the kosher filter.
  const OSM_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  // OSM's cuisine values → the Google types the chips already match on
  const OSM_CUISINE = {
    burger: 'hamburger_restaurant', bbq: 'barbecue_restaurant', barbecue: 'barbecue_restaurant',
    steak_house: 'steak_house', steak: 'steak_house', fish: 'seafood_restaurant', seafood: 'seafood_restaurant',
    coffee_shop: 'coffee_shop', breakfast: 'breakfast_restaurant', brunch: 'brunch_restaurant',
    falafel: 'middle_eastern_restaurant', kebab: 'middle_eastern_restaurant', shawarma: 'middle_eastern_restaurant',
    noodle: 'ramen_restaurant', ramen: 'ramen_restaurant',
  };

  function osmCard(el) {
    const t = el.tags || {};
    const lat = el.lat != null ? el.lat : el.center && el.center.lat;
    const lon = el.lon != null ? el.lon : el.center && el.center.lon;
    const types = String(t.cuisine || '').split(';').map((c) => c.trim().toLowerCase()).filter(Boolean)
      .map((c) => OSM_CUISINE[c] || `${c}_restaurant`);
    if (t.amenity === 'cafe') types.push('cafe');
    if (t.amenity === 'fast_food') types.push('fast_food_restaurant');
    if (/^(yes|only)$/.test(t['diet:vegan'] || '')) types.push('vegan_restaurant');
    if (/^(yes|only)$/.test(t['diet:vegetarian'] || '') && /only/.test(t['diet:vegetarian'])) types.push('vegetarian_restaurant');
    types.push('restaurant');
    const name = t['name:he'] || t.name || '';
    const kosher = /^(yes|only)$/.test(t['diet:kosher'] || '') ? 'osm' : K.mentionsKosher(name) ? 'name' : null;
    const site = t.website || t['contact:website'] || null;
    // a place someone bothered to describe well tends to be one people go to: the only
    // quality hint OSM has, and only ever a nudge next to the distance
    const care = (site ? 1 : 0) + (t.opening_hours ? 1 : 0) + (t.cuisine ? 1 : 0) + (t.wikidata ? 2 : 0);
    return {
      id: `osm:${el.type}/${el.id}`,
      source: 'osm',
      name,
      type: '',
      ptype: types[0],
      types,
      status: 'OPERATIONAL',
      rating: null, count: 0, price: null,
      lat, lon,
      address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '),
      summary: '',
      hours: null,
      hoursText: t.opening_hours || '',
      utc: null,
      website: site && /^https?:\/\//i.test(site) ? site : null,
      phone: t.phone || t['contact:phone'] || null,
      maps: lat != null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : null,
      photos: [],
      he: 0,
      reviews: [],
      kosher,
      care,
    };
  }

  function osmFood(o) {
    const key = `osm|${o.lat.toFixed(3)},${o.lon.toFixed(3)}`;
    if (st.cache.has(key)) return st.cache.get(key);
    const q = `[out:json][timeout:15];nwr["amenity"~"^(restaurant|cafe|fast_food)$"]["name"](around:1500,${o.lat.toFixed(5)},${o.lon.toFixed(5)});out center tags 200;`;
    const p = (async () => {
      for (const url of OSM_MIRRORS) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 16000);
        try {
          const r = await fetch(url, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(q),
          });
          if (!r.ok) continue;
          const d = await r.json();
          return (d.elements || []).map(osmCard).filter((x) => x.name && x.lat != null)
            .map((x) => {
              const m = dist(o, x);
              return { ...x, dist: m, score: +(x.care * 0.15 - m / 1000).toFixed(4) };
            });
        } catch { /* the next mirror */ } finally { clearTimeout(timer); }
      }
      throw new Error('no answer from OpenStreetMap');
    })().catch((err) => { st.cache.delete(key); throw err; });
    st.cache.set(key, p);
    return p;
  }

  function fromOsm(kind, cuisine, all) {
    let list;
    if (kind === 'kosher') list = all.filter((x) => x.kosher);
    else if (cuisine) list = all.filter((x) => K.matches(cuisine, x.ptype, x.types));
    else {
      // the general list is "where to eat well", as with Google: fast food only if that is all there is
      const sit = all.filter((x) => !x.types.includes('fast_food_restaurant'));
      list = sit.length >= 5 ? sit : all;
    }
    list = list.slice();
    list.source = 'osm';
    return list;
  }

  // ---------------------------------------------------------------- painting

  const photoTile = (p, cls) => {
    const ph = p.photos && p.photos[0];
    const emoji = (K.cuisineOf(p.ptype, p.types) || {}).emoji || (st.view === 'food' ? '🍽️' : '📍');
    return `<span class="${cls}" data-emoji="${emoji}">${ph ? `<img src="${esc(ph.thumb)}" alt="" loading="lazy" decoding="async">` : `<i>${emoji}</i>`}</span>`;
  };

  function badges(p, { full = false } = {}) {
    const out = [];
    const os = openState(p);
    if (os) out.push(`<span class="nb-b ${os.open ? (os.soon ? 'warn' : 'ok') : 'shut'}">${esc(full ? os.text : os.open ? (os.soon ? 'נסגר בקרוב' : 'פתוח עכשיו') : 'סגור עכשיו')}</span>`);
    if (p.kosher) out.push('<span class="nb-b kosher" title="לפי שם המקום, התיאור או ביקורות — כדאי לוודא תעודת כשרות">✡ כשר</span>');
    if (p.he) out.push(`<span class="nb-b he" title="ביקורות שנכתבו במקור בעברית, מתוך אלה שגוגל מציג">🇮🇱 ${p.he > 1 ? `${p.he} ביקורות בעברית` : 'ביקורת בעברית'}</span>`);
    if (inTrip(p)) out.push('<span class="nb-b plan">כבר במסלול</span>');
    if (p.status === 'CLOSED_TEMPORARILY') out.push('<span class="nb-b shut">סגור זמנית</span>');
    return out.join('');
  }

  function meta(p) {
    const bits = [];
    if (p.rating) bits.push(`<span class="nb-star">★ ${p.rating.toFixed(1)}</span> <span class="nb-dim">(${countText(p.count)})</span>`);
    else if (p.views) bits.push(`<span class="nb-dim">${countText(p.views)} קוראים בחודש</span>`);
    const c = st.view === 'food' ? K.cuisineOf(p.ptype, p.types) : null;
    const type = c ? c.label : p.type;
    if (type) bits.push(esc(type));
    if (p.price) bits.push(`<span class="nb-dim" dir="ltr">${'$'.repeat(p.price)}</span>`);
    if (p.dist != null) bits.push(esc(distText(p.dist)));
    return bits.join('<span class="nb-sep">·</span>');
  }

  const navButtons = (p) => {
    const l = navLinks(p);
    return `<div class="nb-nav">
      <a class="nb-go gmaps" href="${esc(l.gmaps)}" target="_blank" rel="noopener" data-app="gmaps">${ICON.gmaps}<span>Google Maps</span></a>
      <a class="nb-go waze" href="${esc(l.waze)}" target="_blank" rel="noopener" data-app="waze">${ICON.waze}<span>Waze</span></a>
    </div>`;
  };

  // the details: drawn on the first open, from the answer already in hand
  function details(p) {
    const os = openState(p);
    const today = todayLine(p);
    const revs = p.reviews.slice().sort((a, b) => (b.he ? 1 : 0) - (a.he ? 1 : 0));
    const extra = (p.photos || []).slice(1);
    return `
      ${extra.length ? `<div class="nb-gallery">${extra.map((ph) => `<img src="${esc(ph.large)}" alt="" loading="lazy" decoding="async">`).join('')}</div>` : ''}
      ${p.summary ? `<p class="nb-desc">${esc(p.summary)}</p>` : ''}
      <ul class="nb-facts">
        ${os || today ? `<li><b>שעות</b><span>${os ? `<span class="nb-b ${os.open ? 'ok' : 'shut'}">${esc(os.text)}</span> ` : ''}${today ? esc(today) : ''}</span></li>` : ''}
        ${!os && !today && p.hoursText ? `<li><b>שעות</b><span dir="ltr">${esc(p.hoursText)}</span></li>` : ''}
        ${p.address ? `<li><b>כתובת</b><span>${esc(p.address)}</span></li>` : ''}
        ${p.kosher ? `<li><b>כשרות</b><span>${esc({ name: 'מופיע בשם המקום', summary: 'מופיע בתיאור המקום', reviews: 'מוזכר בביקורות', osm: 'מסומן ככשר ב-OpenStreetMap' }[p.kosher])} — כדאי לוודא תעודת כשרות במקום</span></li>` : ''}
      </ul>
      ${revs.length ? `<div class="nb-revs">${revs.map((r) => `
        <blockquote class="nb-rev">
          <span class="nb-rev-head">${r.rating ? `<span class="nb-star">${'★'.repeat(Math.round(r.rating))}</span>` : ''}${r.when ? ` <span class="nb-dim">${esc(r.when)}</span>` : ''}${r.he ? ' <span class="nb-b he">נכתב בעברית</span>' : ''}</span>
          <span class="nb-rev-text">${esc(r.text)}</span>
        </blockquote>`).join('')}</div>` : ''}
      <div class="nb-links">
        ${p.maps ? `<a href="${esc(p.maps)}" target="_blank" rel="noopener">${ICON.gmaps} בגוגל מפות</a>` : ''}
        ${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${ICON.globe} ${p.source === 'wikipedia' ? 'בוויקיפדיה' : 'אתר'}</a>` : ''}
        ${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${ICON.phone} ${esc(p.phone)}</a>` : ''}
      </div>
      ${(p.photos || []).some((ph) => ph.credit) ? `<p class="nb-credit"><span class="credit-i" role="button" tabindex="0" aria-label="קרדיט לתמונות" data-credit="📷 ${p.source === 'wikipedia' ? 'Wikipedia' : 'Google'} · ${esc(p.photos.map((ph) => ph.credit).filter(Boolean).slice(0, 2).join(', '))}">i</span></p>` : ''}`;
  }

  function card(p, i) {
    return `
      <article class="nb-card${st.open.has(p.id) ? ' open' : ''}" data-id="${esc(p.id)}">
        <button type="button" class="nb-main" aria-expanded="${st.open.has(p.id)}">
          ${photoTile(p, 'nb-photo')}
          <span class="nb-rank" aria-hidden="true">${i + 1}</span>
          <span class="nb-body">
            <span class="nb-name">${esc(p.name)}</span>
            <span class="nb-meta">${meta(p)}</span>
            ${p.summary ? `<span class="nb-sum">${esc(p.summary)}</span>` : ''}
            <span class="nb-badges">${badges(p)}</span>
            <span class="nb-more-hint">${st.open.has(p.id) ? 'פחות' : 'עוד פרטים'}</span>
          </span>
        </button>
        ${navButtons(p)}
        <div class="nb-more">${st.open.has(p.id) ? details(p) : ''}</div>
      </article>`;
  }

  function row(p) {
    return `
      <article class="nb-row${st.open.has(p.id) ? ' open' : ''}" data-id="${esc(p.id)}">
        <button type="button" class="nb-main" aria-expanded="${st.open.has(p.id)}">
          ${photoTile(p, 'nb-thumb')}
          <span class="nb-body">
            <span class="nb-name">${esc(p.name)}</span>
            <span class="nb-meta">${meta(p)}</span>
            <span class="nb-badges">${badges(p)}</span>
          </span>
        </button>
        <div class="nb-more">${st.open.has(p.id) ? details(p) + navButtons(p) : ''}</div>
      </article>`;
  }

  function whereBar() {
    const o = st.origin;
    const planLabel = `לפי המסלול · יום ${planDay()}`;
    let note = '';
    if (st.locating) note = '<span class="nb-dim">מאתרים את המיקום שלכם…</span>';
    else if (o) note = `<span>${esc(o.label)}</span>${st.gpsMiss ? ` <span class="nb-dim">· ${esc(st.gpsMiss)}</span>` : ''}`;
    if (st.far && st.mode === 'gps') note += ' <span class="nb-dim">· רחוק מהמסלול של היום</span>';
    return `
      <div class="nb-where">
        <div class="seg nb-seg" role="group" aria-label="לפי מה לחפש">
          <button type="button" data-mode="gps" class="${st.mode === 'gps' || st.locating ? 'active' : ''}">${ICON.pin} המיקום שלי</button>
          <button type="button" data-mode="plan" class="${st.mode === 'plan' && !st.locating ? 'active' : ''}">${ICON.route} ${esc(planLabel)}</button>
        </div>
        <div class="nb-where-note" role="status">${note}</div>
      </div>`;
  }

  const skeleton = (n, cls) => Array.from({ length: n }, () => `<div class="${cls} nb-skl"><span class="skl"></span><span class="skl"></span><span class="skl short"></span></div>`).join('');

  // "back at 17:00" in the phone's own clock: Google's day ends at midnight Pacific, which
  // is the afternoon in Japan and the morning in Israel — "tomorrow" was right for neither
  function reopens(until) {
    const t = new Date(until);
    if (!until || Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) return '';
    const hm = t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
    const days = Math.round((startOfDay(t) - startOfDay(Date.now())) / 86400000);
    if (days === 0) return ` — חוזרות היום ב-${hm}`;
    if (days === 1) return ` — חוזרות מחר ב-${hm}`;
    return ` — חוזרות ב-${t.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })} ב-${hm}`;
  }

  function problem(err) {
    const msg = (err && err.message ? err.message : 'משהו השתבש') + (err && err.until ? reopens(err.until) : '');
    const o = st.origin;
    const maps = o ? `https://www.google.com/maps/search/${encodeURIComponent(st.view === 'food' ? 'restaurants' : 'things to do')}/@${o.lat},${o.lon},15z` : null;
    return `<div class="nb-empty">
      <p>${esc(msg)}</p>
      <div class="nb-empty-acts">
        <button type="button" class="btn btn-ghost" data-act="retry">לנסות שוב</button>
        ${maps ? `<a class="btn btn-ghost" href="${esc(maps)}" target="_blank" rel="noopener">${ICON.gmaps} לחפש בגוגל מפות</a>` : ''}
      </div>
    </div>`;
  }

  function paintSights(inner) {
    const list = st.sights;
    let html = whereBar();
    html += `<button type="button" class="nb-food-cta" data-act="food">
      <span class="nb-food-emoji" aria-hidden="true">🍽️</span>
      <span class="nb-food-txt"><b>מסעדות באזור</b><span>הכי מדורגות · סינון כשר · לפי סוג אוכל</span></span>
      <span class="nb-food-go" aria-hidden="true">‹</span>
    </button>`;
    html += '<h3 class="nb-h">3 דברים לעשות עכשיו</h3>';
    if (st.error) html += problem(st.error);
    else if (!list) html += skeleton(3, 'nb-card');
    else if (!list.length) html += '<div class="nb-empty"><p>לא מצאנו כאן אטרקציות מדורגות. אולי מסעדה? 🍽️</p></div>';
    else {
      // the three on top are three the itinerary doesn't already hold, when there are three
      const fresh = list.filter((p) => !inTrip(p));
      const top = (fresh.length >= 3 ? fresh : list).slice(0, 3);
      const rest = list.filter((p) => !top.includes(p));
      html += `<div class="nb-top">${top.map(card).join('')}</div>`;
      if (rest.length) {
        html += st.moreSights
          ? `<h3 class="nb-h small">עוד רעיונות באזור</h3><div class="nb-list">${rest.map(row).join('')}</div>`
          : `<button type="button" class="nb-more-btn" data-act="more">עוד ${rest.length} רעיונות באזור</button>`;
      }
    }
    html += list && list.source === 'wikipedia'
      ? '<p class="nb-foot">גוגל לא זמין כרגע, אז הרשימה מוויקיפדיה: מקומות שיש עליהם ערך, לפי כמה אנשים קראו עליהם בחודש האחרון. בלי דירוגים ושעות — כדאי לבדוק בגוגל מפות לפני שיוצאים.</p>'
      : '<p class="nb-foot">דירוגים, שעות וביקורות מגוגל מפות. הדירוג מתחשב גם בכמות המדרגים — ובביקורות שנכתבו בעברית.</p>';
    inner.innerHTML = html;
  }

  function foodList() {
    const base = st.food[''] || [];
    const c = st.cuisine;
    let list;
    if (st.kosherOnly) {
      const pool = [...(st.kosher || []), ...base, ...(c ? st.food[c] || [] : [])].filter((p) => p.kosher);
      list = pool;
      if (c) list = list.filter((p) => K.matches(c, p.ptype, p.types));
    } else if (c) {
      list = [...(st.food[c] || []), ...base.filter((p) => K.matches(c, p.ptype, p.types))];
    } else list = base;
    const seen = new Set();
    list = list.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
    return list.sort(st.sort === 'near' ? (a, b) => a.dist - b.dist : (a, b) => b.score - a.score);
  }

  function paintFood(inner) {
    const waiting = st.foodLoading;
    let html = whereBar();
    html += `
      <div class="nb-filters">
        <button type="button" class="nb-kosher${st.kosherOnly ? ' on' : ''}" data-act="kosher" aria-pressed="${st.kosherOnly}">✡ כשר בלבד</button>
        <div class="seg nb-sort" role="group" aria-label="סדר">
          <button type="button" data-sort="score" class="${st.sort !== 'near' ? 'active' : ''}">הכי מדורגות</button>
          <button type="button" data-sort="near" class="${st.sort === 'near' ? 'active' : ''}">הכי קרובות</button>
        </div>
      </div>
      <div class="nb-chips" role="group" aria-label="סוג אוכל">
        <button type="button" data-cuisine="" class="${!st.cuisine ? 'on' : ''}">הכל</button>
        ${K.CUISINES.map((c) => `<button type="button" data-cuisine="${c.key}" class="${st.cuisine === c.key ? 'on' : ''}">${c.emoji} ${esc(c.label)}</button>`).join('')}
      </div>`;
    if (st.error) html += problem(st.error);
    else if (waiting && !foodList().length) html += skeleton(5, 'nb-row');
    else {
      const list = foodList();
      if (!list.length) {
        html += `<div class="nb-empty"><p>${st.kosherOnly ? 'לא מצאנו כאן מסעדה שמסומנת ככשרה' : 'לא מצאנו כאן מסעדות מהסוג הזה'}${st.cuisine ? ' — נסו "הכל"' : ''}.</p>
          ${st.kosherOnly && st.origin ? `<a class="btn btn-ghost" href="https://www.google.com/maps/search/kosher/@${st.origin.lat},${st.origin.lon},13z" target="_blank" rel="noopener">${ICON.gmaps} לחפש "kosher" בגוגל מפות</a>` : ''}</div>`;
      } else {
        html += `<div class="nb-list">${list.map(row).join('')}</div>`;
        if (waiting) html += '<p class="nb-foot">טוענים עוד…</p>';
      }
    }
    const fromOsmList = (st.food[''] || []).source === 'osm';
    html += `<p class="nb-foot">${st.kosherOnly || (st.food[''] || []).some((p) => p.kosher)
      ? `סימון "כשר" לפי ${fromOsmList ? 'OpenStreetMap או שם המקום' : 'שם המקום, התיאור או ביקורות'} — הוא רמז ולא תעודה, כדאי לוודא במקום. ` : ''}${fromOsmList
      ? 'גוגל לא זמין כרגע, אז המסעדות מ-OpenStreetMap — בלי דירוגים, לפי מרחק.'
      : 'דירוגים וביקורות מגוגל מפות; מקומות שישראלים כתבו עליהם בעברית עולים בדירוג.'}</p>`;
    inner.innerHTML = html;
  }

  function paint() {
    if (!slots) return;
    let inner = slots.body.querySelector('.nb');
    if (!inner) {
      slots.body.innerHTML = '<div class="tp-inner nb"></div>';
      inner = slots.body.querySelector('.nb');
    }
    inner.classList.toggle('is-food', st.view === 'food');
    if (st.view === 'food') paintFood(inner); else paintSights(inner);
  }

  // ---------------------------------------------------------------- flow

  async function locate(mode) {
    const seq = ++st.seq;
    st.error = null;
    st.gpsMiss = '';
    if (mode !== 'plan') {
      st.locating = true;
      paint();
      try {
        const pos = await gps();
        if (seq !== st.seq) return;
        st.mode = 'gps';
        st.origin = { lat: pos.lat, lon: pos.lon, label: 'סביב המיקום שלכם' };
        // far from where the plan puts today is worth saying — the switch is right there
        const plan = await planPoint().catch(() => null);
        if (seq !== st.seq) return;
        st.far = !!(plan && liveDay() && dist(st.origin, plan) > 150000);
      } catch (err) {
        if (seq !== st.seq) return;
        st.gpsMiss = err && (err.code === 1 || err.message === 'denied') ? 'המיקום לא אושר' : 'לא הצלחנו לאתר מיקום';
        mode = 'plan';
      }
      st.locating = false;
    }
    if (mode === 'plan') {
      st.mode = 'plan';
      st.far = false;
      const p = await planPoint().catch(() => null);
      if (seq !== st.seq) return;
      if (!p) { st.origin = null; st.error = new Error('אין במסלול של היום מקום עם מיקום — אשרו מיקום כדי לקבל המלצות'); paint(); return; }
      st.origin = p;
    }
    TRIPMAKER.track('nearby_where', { mode: st.mode, day: liveDay() });
    st.sights = null; st.food = {}; st.kosher = null;
    load();
  }

  async function load() {
    if (!st.origin) return;
    const seq = st.seq;
    st.error = null;
    if (st.view === 'sights') {
      paint();
      try {
        const list = await fetchKind('sights');
        if (seq !== st.seq) return;
        st.sights = list;
      } catch (err) { if (seq === st.seq) st.error = err; }
      if (seq === st.seq) paint();
      return;
    }
    st.foodLoading = true;
    paint();
    const want = [fetchKind('food').then((l) => { st.food[''] = l; })];
    if (st.cuisine) want.push(fetchKind('food', st.cuisine).then((l) => { st.food[st.cuisine] = l; }));
    if (st.kosherOnly) want.push(fetchKind('kosher').then((l) => { st.kosher = l; }));
    // each answer paints as it lands, so the general list is up while the filter's is on its way
    want.forEach((p) => p.then(() => { if (seq === st.seq) paint(); }).catch(() => {}));
    const results = await Promise.allSettled(want);
    if (seq !== st.seq) return;
    st.foodLoading = false;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && !foodList().length) st.error = failed.reason;
    paint();
  }

  function toggleOpen(el) {
    const id = el.dataset.id;
    const list = [...(st.sights || []), ...Object.values(st.food).flat(), ...(st.kosher || [])];
    const p = list.find((x) => x.id === id);
    if (!p) return;
    const open = !st.open.has(id);
    if (open) st.open.add(id); else st.open.delete(id);
    el.classList.toggle('open', open);
    el.querySelector('.nb-main').setAttribute('aria-expanded', String(open));
    const hint = el.querySelector('.nb-more-hint');
    if (hint) hint.textContent = open ? 'פחות' : 'עוד פרטים';
    const more = el.querySelector('.nb-more');
    if (open && !more.innerHTML.trim()) more.innerHTML = details(p) + (el.classList.contains('nb-row') ? navButtons(p) : '');
    if (open) TRIPMAKER.track('nearby_details', { view: st.view });
  }

  function wire(body) {
    if (body.dataset.nbWired) return;
    body.dataset.nbWired = '1';
    body.addEventListener('click', (e) => {
      const go = e.target.closest('.nb-go');
      if (go) { TRIPMAKER.track('nearby_nav', { app: go.dataset.app, view: st.view }); return; }
      if (e.target.closest('a')) return;
      const mode = e.target.closest('[data-mode]');
      if (mode) {
        const m = mode.dataset.mode;
        if (m !== st.mode || m === 'gps') locate(m);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'food' || a === 'sights') {
          st.view = a; st.error = null;
          slots.body.scrollTop = 0;
          if (a === 'food') TRIPMAKER.track('nearby_food', { from: 'screen' });
          load();
        } else if (a === 'more') { st.moreSights = true; paint(); }
        else if (a === 'kosher') {
          st.kosherOnly = !st.kosherOnly;
          TRIPMAKER.track('nearby_filter', { kosher: st.kosherOnly, cuisine: st.cuisine || null });
          load();
        } else if (a === 'retry') { if (st.origin) load(); else locate(st.mode || 'gps'); }
        return;
      }
      const chip = e.target.closest('[data-cuisine]');
      if (chip) {
        st.cuisine = chip.dataset.cuisine;
        TRIPMAKER.track('nearby_filter', { kosher: st.kosherOnly, cuisine: st.cuisine || null });
        load();
        return;
      }
      const sort = e.target.closest('[data-sort]');
      if (sort) { st.sort = sort.dataset.sort; paint(); return; }
      const main = e.target.closest('.nb-main');
      if (main) toggleOpen(main.closest('[data-id]'));
    });
    // a photo Google would not sell us (spent month, stale name) becomes the emoji tile
    body.addEventListener('error', (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const tile = img.closest('[data-emoji]');
      if (tile) tile.innerHTML = `<i>${tile.dataset.emoji}</i>`;
      else img.remove();
    }, true);
  }

  function render(s) {
    slots = s;
    wire(s.body);
    if (!st.origin && !st.locating && !st.error) { paint(); locate(st.startMode || 'gps'); }
    else paint();
  }

  // ---------------------------------------------------------------- entry points

  function open(view, source) {
    if (view === 'food' && st.view !== 'food') { st.view = 'food'; if (st.origin) setTimeout(load); }
    if (view === 'sights' && st.view !== 'sights') { st.view = 'sights'; if (st.origin) setTimeout(load); }
    TRIPMAKER.track('nearby_open', { source, view: st.view, day: liveDay() });
    try {
      const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
      seen[ctx.trip.share_code] = Date.now();
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch { /* no storage: the screen just opens again next time */ }
    if (TripPages.current() === 'nearby') paint();
    else TripPages.open('nearby');
  }

  // the strip above the itinerary, on trip days only
  function banner(day) {
    document.getElementById('nearby-banner')?.remove();
    if (!day) return;
    const el = document.createElement('section');
    el.id = 'nearby-banner';
    el.className = 'nb-banner glass';
    el.setAttribute('aria-label', 'מה עושים עכשיו באזור');
    el.innerHTML = `
      <div class="nb-banner-txt"><b>📍 יום ${day} בטיול</b><span>מה עושים עכשיו באזור?</span></div>
      <div class="nb-banner-acts">
        <button type="button" class="btn btn-amber" data-nb="sights">מה יש לעשות כאן</button>
        <button type="button" class="btn btn-ghost" data-nb="food">🍽️ מסעדות</button>
      </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nb]');
      if (b) open(b.dataset.nb, 'banner');
    });
    const main = document.querySelector('#trip-layout main');
    const anchor = document.getElementById('checklist-widget') || document.getElementById('days-container');
    main.insertBefore(el, anchor);
    gallery(el, day);
  }

  // Behind the banner's left side, the day's own places, one after another, faded into
  // the glass so the words and buttons stay the thing you read. The pictures are the ones
  // the itinerary's cards already show (trip-photos.js, one cached answer for the whole
  // trip), so this costs no lookup of its own; a day with none wears its area's photo.
  const GAL_MAX = 6;
  const GAL_EVERY_MS = 5200;
  let galTimer = null;

  async function gallery(el, day) {
    clearInterval(galTimer);
    const urls = [];
    const stops = (ctx.state.items || []).filter((it) => it.day_number === day && it.category !== 'נסיעה');
    const data = await TripPhotos.load(ctx.trip.share_code).catch(() => null);
    if (!el.isConnected) return;
    for (const s of stops) {
      const p = data && data.stops && data.stops[s.id];
      if (p && p.url && !urls.includes(p.url)) urls.push(p.url);
      if (urls.length >= GAL_MAX) break;
    }
    if (urls.length < 2 && typeof DEST_PHOTOS !== 'undefined') {
      const area = ctx.defaultArea(day) || ctx.trip.destination;
      const dests = Array.isArray(ctx.trip.destinations) ? ctx.trip.destinations : [];
      const hit = DEST_PHOTOS.find(dests.find((d) => d && d.name === area) || { name: area });
      if (hit) urls.push(DEST_PHOTOS.img(hit.id, 640));
    }
    if (!urls.length) return;

    const gal = document.createElement('div');
    gal.className = 'nb-gal';
    gal.setAttribute('aria-hidden', 'true');
    el.prepend(gal);
    el.classList.add('has-gal');
    const frames = [];
    urls.forEach((url, i) => {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        frames.push(img);
        if (frames.length === 1) img.classList.add('on');
      };
      img.onerror = () => img.remove();
      img.src = url;
      gal.appendChild(img);
      if (i === 0) img.fetchPriority = 'low';
    });
    if (urls.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let at = 0;
    galTimer = setInterval(() => {
      if (!el.isConnected) { clearInterval(galTimer); return; }
      if (document.hidden || frames.length < 2) return;
      frames[at].classList.remove('on');
      at = (at + 1) % frames.length;
      frames[at].classList.add('on');
    }, GAL_EVERY_MS);
  }

  // Registered for every participant of a saved trip: on a trip day it shows the banner
  // and may open itself; on any other day it is still reachable at #nearby.
  function init(c) {
    ctx = c;
    st = {
      seq: 0, mode: null, origin: null, locating: false, error: null, gpsMiss: '', far: false,
      view: 'sights', sights: null, moreSights: false,
      food: {}, kosher: null, cuisine: '', kosherOnly: false, sort: 'score', foodLoading: false,
      open: new Set(), cache: new Map(),
    };
    slots = null;
    TripPages.register('nearby', {
      title: '📍 מה עושים עכשיו',
      sub: 'הכי מומלצים סביבכם — לפי דירוגי גוגל ומה שישראלים כתבו',
      render,
      // the header's back arrow leaves the food list for the sights first, then the page
      back: () => {
        if (st.view !== 'food') return false;
        st.view = 'sights'; st.error = null;
        if (slots) slots.body.scrollTop = 0;
        load();
        return true;
      },
    });
    banner(liveDay());
  }

  // the screen opens by itself on a trip day — once, then not again for a few hours, so
  // checking the next stop twice in an afternoon doesn't mean dismissing it twice
  function autoOpen() {
    if (!ctx || !liveDay() || TripPages.current() || location.hash) return false;
    if (document.body.classList.contains('budget-open')) return false;
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { /* no storage */ }
    if (Date.now() - (seen[ctx.trip.share_code] || 0) < AUTO_EVERY_MS) return false;
    open('sights', 'auto');
    return true;
  }

  return { init, open, autoOpen, liveDay: () => (ctx ? liveDay() : 0) };
})();
