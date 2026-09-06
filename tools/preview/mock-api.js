// A stand-in for the trip API, for looking at the UI without a database: one fixed trip,
// with stops that can be added, edited and removed in memory. Isomorphic on purpose —
// tools/preview/server.js uses it in node, and the static demo build (Cloudflare Pages,
// the artifact preview) loads it in the browser and answers fetch('/api/…') with it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TripmakerMock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const U = (id, w = 1200) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

  const user = { id: 1, name: 'רגב כהן', email: 'demo@tripmaker.co.il', is_admin: false };
  const trip = {
    id: 1, share_code: '731502', owner_id: 1, title: 'רומא בארבעה ימים', emoji: '🍕',
    destination: 'רומא', country: 'איטליה', days: 5, start_date: '2026-10-12', end_date: '2026-10-16',
    description: 'ארבעה ימים ברומא הקלאסית — הקולוסיאום והפורום, הוותיקן, טרווי ופנתאון, ובערב טרסטוורה. יום חמישי חופשי לפסטה שלא סיימתם, או לטיול יום לטיבולי.',
    cover_image: U('photo-1552832230-c0197dd311b5'),
    destinations: [{ name: 'רומא', country: 'איטליה', cc: 'it', lat: 41.893, lon: 12.483 }],
    is_public: true, is_draft: false, likes: 12, invite_token: 'demo-invite-token', created_at: '2026-08-01T10:00:00Z',
  };
  let nextId = 100;
  const stop = (day, time, title, note, cat, lat, lon) => ({
    id: nextId++, trip_id: 1, day_number: day, time_label: time, title, note, place_query: `${title} Rome`,
    category: cat, area: 'רומא', lat, lon, cost: null, google_place_id: null, sort_order: nextId,
  });
  let items = [
    stop(1, '09:00', 'הקולוסיאום', 'כרטיס משולב עם הפורום — כניסה ב-9:00 לפני החום', 'תרבות', 41.8902, 12.4922),
    stop(1, '12:30', 'הפורום הרומי והפלטין', 'שעתיים של הליכה בין העמודים. כובע ומים', 'תרבות', 41.8925, 12.4853),
    stop(1, '19:30', 'טרסטוורה — ארוחת ערב', 'סמטאות, קקיו-א-פפה ויין הבית', 'אוכל', 41.8897, 12.4694),
    stop(2, '08:30', 'מוזיאוני הוותיקן והקפלה הסיסטינית', 'כרטיס מראש חובה. 3 שעות', 'תרבות', 41.9065, 12.4536),
    stop(2, '13:00', 'בזיליקת פטרוס הקדוש והכיפה', '551 מדרגות — הנוף שווה את זה', 'נוף', 41.9022, 12.4539),
    stop(3, '10:00', 'הפנתאון', 'חינם, ולהגיע מוקדם', 'תרבות', 41.8986, 12.4769),
    stop(3, '11:30', 'מזרקת טרווי', 'מטבע אחד — חוזרים לרומא', 'אטרקציה', 41.9009, 12.4833),
    stop(3, '16:00', 'המדרגות הספרדיות ו-ויה קונדוטי', 'שופינג בעיניים', 'קניות', 41.9058, 12.4823),
    stop(4, '10:00', 'וילה בורגזה', 'שכירת סירה באגם וגלריית בורגזה (כרטיס מראש)', 'טבע', 41.9142, 12.4922),
  ];

  const json = (status, body) => ({ status, body });

  function handle(method, url, body) {
    const p = new URL(url, 'http://x').pathname;
    body = body || {};
    if (p === '/api/me') return json(200, user);
    if (p === '/api/auth/providers') return json(200, { google: false });
    if (p === '/api/analytics/config') return json(200, {});
    if (p.startsWith('/api/push/')) return json(200, { key: null });
    if (p === '/api/trips/suggested' || p === '/api/my-trips' || p.startsWith('/api/hotels')) return json(200, []);
    const m = p.match(/^\/api\/trips\/code\/(\d+)(\/.*)?$/);
    if (m) {
      // any code opens the one demo trip — a host may put the page on any path
      const rest = m[2] || '';
      if (!rest) {
        return json(200, {
          trip, items, isOwner: true, canEdit: true, isAdmin: false,
          hotels: [], budget: null, expenses: [], participants: [{ id: 1, name: user.name, is_owner: true }],
        });
      }
      if (rest === '/votes') return json(200, []);
      if (rest === '/items' && method === 'POST') {
        if (!body.title) return json(400, { error: 'חסרה כותרת לתחנה' });
        const it = {
          id: nextId++, trip_id: 1, day_number: Math.min(Math.max(+body.day_number || 1, 1), trip.days),
          time_label: body.time_label || null, title: String(body.title).slice(0, 200), note: body.note || null,
          place_query: body.place_query || null, category: body.category || null, area: body.area || null,
          lat: body.lat ?? null, lon: body.lon ?? null, cost: null, google_place_id: null, sort_order: nextId,
        };
        items.push(it);
        return json(200, it);
      }
      const im = rest.match(/^\/items\/(\d+)$/);
      if (im) {
        const it = items.find((x) => x.id === +im[1]);
        if (!it) return json(404, { error: 'התחנה לא נמצאה' });
        if (method === 'PATCH') { Object.assign(it, body); return json(200, it); }
        if (method === 'DELETE') { items = items.filter((x) => x !== it); return json(200, { ok: true }); }
        return json(200, it);
      }
      if (rest === '/dates') { Object.assign(trip, body); return json(200, trip); }
      if (rest === '/locate') return json(200, { located: [] });
      return json(200, {});
    }
    return json(404, { error: 'mock: no route ' + p });
  }

  return { handle, trip, user };
});
