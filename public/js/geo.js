// Shared geo helpers: destination autocomplete (Open-Meteo geocoding, Hebrew),
// 7-day weather (Open-Meteo forecast) and nearby hotels (OSM Overpass).
// All keyless public APIs — no signup required.
const GEO = {
  async searchPlaces(q) {
    if (!q || q.length < 2) return [];
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=7&language=he&format=json&name=' + encodeURIComponent(q);
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r) => ({
      name: r.name,
      country: r.country || null,
      isCountry: r.feature_code === 'PCLI' || r.feature_code === 'PCL',
      admin: r.admin1 || null,
      lat: r.latitude,
      lon: r.longitude,
    }));
  },

  async forecast(lat, lon, days = 7) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${Math.min(days, 16)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('weather unavailable');
    const d = (await res.json()).daily;
    return d.time.map((t, i) => ({
      date: t,
      code: d.weather_code[i],
      max: Math.round(d.temperature_2m_max[i]),
      min: Math.round(d.temperature_2m_min[i]),
    }));
  },

  // typical weather for trip dates beyond the 16-day forecast horizon: the same
  // date span in the previous two years (Open-Meteo archive, keyless), averaged
  // and re-keyed to the trip's own dates. Same {date, code, max, min} shape as
  // forecast() so every badge renderer works unchanged; `est: true` marks the
  // numbers as historical estimates, not a forecast.
  async typicalWeather(lat, lon, tripDates) {
    if (!tripDates || !tripDates.length) return [];
    const shift = (iso, years) => {
      const [y, m, d] = iso.split('-').map(Number);
      const dt = new Date(y - years, m - 1, d); // Feb 29 rolls to Mar 1 — fine for an estimate
      return TRIPI.isoDate(dt);
    };
    const fetchYear = async (years) => {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
        `&start_date=${shift(tripDates[0], years)}&end_date=${shift(tripDates[tripDates.length - 1], years)}` +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto';
      const res = await fetch(url);
      if (!res.ok) throw new Error('archive unavailable');
      return (await res.json()).daily;
    };
    const settled = await Promise.allSettled([fetchYear(1), fetchYear(2)]);
    const samples = settled
      .map((r, k) => (r.status === 'fulfilled' ? { years: k + 1, daily: r.value } : null))
      .filter(Boolean);
    if (!samples.length) return [];
    // look each trip date up by ITS OWN shifted date, never by array position —
    // a span crossing Feb 29 is a day shorter/longer in a non-leap sample year,
    // and positional pairing would smear every later day onto the wrong sample
    const at = (s, date) => {
      const i = (s.daily.time || []).indexOf(shift(date, s.years));
      return i < 0 ? {} : {
        max: s.daily.temperature_2m_max?.[i],
        min: s.daily.temperature_2m_min?.[i],
        code: s.daily.weather_code?.[i],
      };
    };
    return tripDates.map((date) => {
      const days = samples.map((s) => at(s, date));
      const maxs = days.map((d) => d.max).filter(Number.isFinite);
      const mins = days.map((d) => d.min).filter(Number.isFinite);
      const codes = days.map((d) => d.code).filter(Number.isFinite);
      if (!maxs.length || !mins.length) return null;
      return {
        date,
        // the harsher of the sampled codes — for packing, over-warning beats under
        code: codes.length ? Math.max(...codes) : 1,
        max: Math.round(maxs.reduce((a, b) => a + b, 0) / maxs.length),
        min: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length),
        est: true,
      };
    }).filter(Boolean);
  },

  weatherIcon(code) {
    if (code === 0) return '☀️';
    if (code <= 2) return '🌤️';
    if (code === 3) return '☁️';
    if (code <= 48) return '🌫️';
    if (code <= 57) return '🌦️';
    if (code <= 67) return '🌧️';
    if (code <= 77) return '❄️';
    if (code <= 82) return '🌦️';
    if (code <= 86) return '🌨️';
    return '⛈️';
  },

  weatherLabel(code) {
    if (code === 0) return 'בהיר';
    if (code <= 2) return 'מעונן חלקית';
    if (code === 3) return 'מעונן';
    if (code <= 48) return 'ערפילי';
    if (code <= 57) return 'טפטוף';
    if (code <= 67) return 'גשום';
    if (code <= 77) return 'שלג';
    if (code <= 82) return 'ממטרים';
    if (code <= 86) return 'שלג';
    return 'סופות';
  },

  // driving legs between consecutive points, via the public OSRM server (keyless).
  // The in-flight promise is cached per coordinate chain, so a re-render reuses the
  // same answer (and two racing renders share one request); failures aren't kept.
  routeCache: new Map(),
  async routeLegs(points) {
    const chain = points.map((p) => `${(+p.lon).toFixed(5)},${(+p.lat).toFixed(5)}`).join(';');
    if (this.routeCache.has(chain)) return this.routeCache.get(chain);
    const promise = (async () => {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${chain}?overview=false`);
      if (!res.ok) throw new Error('routing unavailable');
      const legs = (await res.json()).routes?.[0]?.legs;
      if (!legs) throw new Error('no route');
      return legs.map((l) => ({
        minutes: Math.round(l.duration / 60),
        km: l.distance >= 9500 ? Math.round(l.distance / 1000) : +(l.distance / 1000).toFixed(1),
      }));
    })();
    this.routeCache.set(chain, promise);
    try { return await promise; } catch (err) { this.routeCache.delete(chain); throw err; }
  },

  // opts: {country, limit, radius} — country is the trip's Hebrew country name,
  // which the server maps to the ISO code providers like LiteAPI ask for
  async hotelsNear(lat, lon, opts = {}) {
    const p = new URLSearchParams({ lat, lon });
    if (opts.country) p.set('country', opts.country);
    if (opts.limit) p.set('limit', opts.limit);
    if (opts.radius) p.set('radius', opts.radius);
    const res = await fetch('/api/hotels?' + p);
    if (!res.ok) throw new Error('hotels unavailable');
    return res.json();
  },

  // cheapest offer per hotel id for one night (or range) — {} when the active
  // content provider can't price, which the caller renders as "no price line"
  async hotelPrices(ids, { checkin, checkout, adults, currency } = {}) {
    if (!ids || !ids.length || !checkin || !checkout) return {};
    const p = new URLSearchParams({ ids: ids.join(','), checkin, checkout });
    if (adults) p.set('adults', adults);
    if (currency) p.set('currency', currency);
    const res = await fetch('/api/hotels/prices?' + p);
    if (!res.ok) return {};
    return res.json();
  },

  async hotelDetail(id) {
    const res = await fetch('/api/hotels/detail?id=' + encodeURIComponent(id));
    if (!res.ok) throw new Error('hotel details unavailable');
    return res.json();
  },

  // POI/address search (Photon — keyless OSM autocomplete; finds restaurants, museums, beaches…)
  async searchPois(q, biasLat, biasLon) {
    if (!q || q.length < 2) return [];
    // lang=en: Photon's default is the local OSM name — Greek script for Athens,
    // Kanji for Tokyo. Latin names our travelers can actually read, and the
    // server-side place verifier (lib/places.js) matches Latin tokens anyway.
    let url = 'https://photon.komoot.io/api/?limit=6&lang=en&q=' + encodeURIComponent(q);
    if (Number.isFinite(biasLat) && Number.isFinite(biasLon)) url += `&lat=${biasLat}&lon=${biasLon}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map((f) => {
      const p = f.properties || {};
      return {
        name: p.name || [p.street, p.housenumber].filter(Boolean).join(' '),
        detail: [p.city || p.county, p.country].filter(Boolean).join(', '),
        kind: p.osm_value || p.osm_key || '',
        lat: f.geometry?.coordinates?.[1],
        lon: f.geometry?.coordinates?.[0],
      };
    }).filter((r) => r.name);
  },

  poiIcon(kind) {
    const map = {
      restaurant: '🍽️', cafe: '☕', bar: '🍸', fast_food: '🍔',
      hotel: '🏨', guest_house: '🏨', hostel: '🛏️',
      museum: '🖼️', attraction: '🎡', viewpoint: '🌄', artwork: '🎨',
      beach: '🏖️', beach_resort: '🏖️', peak: '⛰️', park: '🌳', garden: '🌷',
      castle: '🏰', ruins: '🏛️', monument: '🗿', place_of_worship: '⛪',
      airport: '✈️', station: '🚉', mall: '🛍️', marketplace: '🛒',
      city: '🏙️', town: '🏘️', village: '🏡', island: '🏝️',
    };
    return map[kind] || '📍';
  },

  // turn a text input into a place-picker dropdown; onPick({name, detail, lat, lon})
  attachPlaceAutocomplete(input, { getBias, onPick } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'autocomplete-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = document.createElement('div');
    list.className = 'autocomplete-list glass';
    wrap.appendChild(list);

    let timer = null;
    let lastPicked = null;
    input.addEventListener('input', () => {
      lastPicked = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { list.classList.remove('open'); return; }
      timer = setTimeout(async () => {
        const bias = getBias ? getBias() : {};
        const places = await this.searchPois(q, bias.lat, bias.lon).catch(() => []);
        if (!places.length) { list.classList.remove('open'); return; }
        list.innerHTML = places.map((p, i) => `
          <button type="button" class="autocomplete-item" data-i="${i}">
            <span class="ac-icon">${this.poiIcon(p.kind)}</span>
            <span class="ac-name">${p.name.replace(/</g, '&lt;')}</span>
            <span class="ac-meta">${(p.detail || '').replace(/</g, '&lt;')}</span>
          </button>`).join('');
        list.classList.add('open');
        list.querySelectorAll('.autocomplete-item').forEach((btn) => {
          btn.onclick = () => {
            const p = places[+btn.dataset.i];
            input.value = p.name;
            lastPicked = p;
            list.classList.remove('open');
            if (onPick) onPick(p);
          };
        });
      }, 300);
    });
    input.addEventListener('keydown', (e) => {
      const open = list.classList.contains('open');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (open) { e.preventDefault(); TRIPI.acMove(list, e.key === 'ArrowDown' ? 1 : -1); }
      } else if (e.key === 'Enter' && open) {
        const act = list.querySelector('.autocomplete-item.active') || list.querySelector('.autocomplete-item');
        if (act) { e.preventDefault(); act.click(); }
      } else if (e.key === 'Escape') {
        list.classList.remove('open');
      }
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) list.classList.remove('open');
    });
    return { getPicked: () => lastPicked, clear: () => { lastPicked = null; } };
  },

  // place photos from Wikimedia Commons (keyless, CORS-enabled); [] when nothing relevant
  photoCache: new Map(),
  async placePhotos(query, limit = 8) {
    if (!query) return [];
    if (this.photoCache.has(query)) return this.photoCache.get(query);
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      `&generator=search&gsrnamespace=6&gsrlimit=${limit}` +
      '&gsrsearch=' + encodeURIComponent('filetype:bitmap ' + query) +
      '&prop=imageinfo&iiprop=url|mime&iiurlwidth=480';
    try {
      const res = await fetch(url);
      const data = await res.json();
      const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      const photos = pages
        .map((p) => p.imageinfo?.[0])
        .filter((ii) => ii && /image\/(jpeg|png)/.test(ii.mime || ''))
        .map((ii) => ({ thumb: ii.thumburl || ii.url, full: ii.url }));
      this.photoCache.set(query, photos);
      return photos;
    } catch { return []; }
  },

  // fill a container with a horizontal photo strip; removes it when nothing found
  async renderGallery(container, query) {
    container.innerHTML = '<span class="gal-ph skl"></span>'.repeat(4);
    const photos = await this.placePhotos(query);
    if (!photos.length) { container.remove(); return; }
    // each photo keeps shimmering in its own slot and fades in once decoded — no empty boxes, no reflow
    container.innerHTML = photos.map((p) =>
      `<span class="gal-ph skl"><img src="${p.thumb}" data-full="${p.full}" loading="lazy" alt=""></span>`).join('');
    container.querySelectorAll('img').forEach((img) => {
      const reveal = () => { img.classList.add('loaded'); img.parentElement.classList.remove('skl'); };
      if (img.complete && img.naturalWidth) reveal(); else img.onload = reveal;
      img.onerror = () => img.parentElement.remove();
      img.onclick = (e) => { e.stopPropagation(); TRIPI.openLightbox(img.dataset.full); };
    });
  },
};
