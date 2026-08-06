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

  async forecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7';
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
};
