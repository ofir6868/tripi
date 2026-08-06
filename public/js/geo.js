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

  async hotelsNear(lat, lon) {
    const res = await fetch(`/api/hotels?lat=${lat}&lon=${lon}`);
    if (!res.ok) throw new Error('hotels unavailable');
    return res.json();
  },

  // POI/address search (Photon — keyless OSM autocomplete; finds restaurants, museums, beaches…)
  async searchPois(q, biasLat, biasLon) {
    if (!q || q.length < 2) return [];
    let url = 'https://photon.komoot.io/api/?limit=6&q=' + encodeURIComponent(q);
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
      if (e.key === 'Escape') list.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) list.classList.remove('open');
    });
    return { getPicked: () => lastPicked };
  },
};
