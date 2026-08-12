// The site-wide WebMCP tools — the ones that mean the same thing on every page.
// Tools that only exist while a trip is open (add/edit/delete a stop) are declared by
// trip.js instead, because they run through that page's live state so the itinerary
// repaints instead of going stale behind the agent's back.
//
// Descriptions are English on purpose: the agent reads them, the user never does. The
// *values* stay Hebrew, because that is what the product stores and displays.
(function () {
  'use strict';
  // needs both halves: the registry from webmcp.js and the API client from common.js
  if (!window.tripiTools || typeof TRIPI === 'undefined' || !TRIPI.mcp) return;

  const { register, ok, fail } = TRIPI.mcp;

  // the item shape both create_trip and the trip-page tools accept, kept in one place
  // so a stop means the same thing wherever an agent writes one
  const STOP_PROPS = {
    day_number: { type: 'integer', minimum: 1, description: 'Which day of the trip this stop belongs to (1-based).' },
    title: { type: 'string', description: 'Name of the stop, in Hebrew. Required.' },
    time_label: { type: 'string', description: 'Time of day as free text, e.g. "09:00" or "בוקר".' },
    note: { type: 'string', description: 'Free-text note shown under the stop.' },
    place_query: { type: 'string', description: 'Search string used to build the Google Maps link, e.g. "Sagrada Familia, Barcelona".' },
    category: {
      type: 'string',
      description: 'One of: אטרקציה, אוכל, טבע, ים, תרבות, קניות, לינה, נוף, חיי לילה, נסיעה.',
    },
    area: { type: 'string', description: 'Which of the trip destinations this stop sits in. Only meaningful on multi-destination trips.' },
    lat: { type: 'number', description: 'Latitude. Give it when known — it makes the map pin exact instead of a text search.' },
    lon: { type: 'number', description: 'Longitude.' },
    cost: { type: 'number', minimum: 0, description: 'Estimated cost per person.' },
  };
  // trip.js builds its stop tools from the same definition, so a stop's fields never
  // drift between "create the trip with an itinerary" and "add one stop to it"
  TRIPI.mcp.stopProps = STOP_PROPS;

  const tripUrl = (code) => location.origin + '/trip/' + code;

  // trims a trip row down to what an agent actually reasons about
  const tripSummary = (t) => ({
    code: t.share_code,
    url: tripUrl(t.share_code),
    title: t.title,
    emoji: t.emoji || null,
    destination: t.destination,
    country: t.country || null,
    destinations: Array.isArray(t.destinations) ? t.destinations : [],
    days: t.days,
    start_date: t.start_date || null,
    end_date: t.end_date || null,
    description: t.description || null,
    is_draft: !!t.is_draft,
    is_public: !!t.is_public,
    likes: t.likes ?? 0,
  });

  const requireAuth = () => (TRIPI.token
    ? null
    : fail('Not signed in. The user has to sign in through the site header first — an agent must not enter credentials on their behalf.'));

  // ---------- who and where ----------
  register({
    name: 'tripmaker_whoami',
    title: 'Current user and page',
    description: 'Who is signed in and what page of TRIP MAKER is open. Call this first — most write tools need a signed-in user, and the trip-scoped tools only exist while a trip page is open.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ok({
      signed_in: !!TRIPI.token,
      user: TRIPI.user ? { name: TRIPI.user.name, email: TRIPI.user.email, is_admin: !!TRIPI.user.is_admin } : null,
      url: location.href,
      // the trip page registers extra tools; this is how an agent knows to expect them
      open_trip_code: /^\/trip\/(\d{6})$/.test(location.pathname) ? location.pathname.split('/').pop() : null,
      tools: window.tripiTools.list().map((t) => t.name),
    }),
  });

  // ---------- reading ----------
  register({
    name: 'tripmaker_search_trips',
    title: 'Search trips',
    description: 'Search public trips by title, destination or country (Hebrew text), or look up one trip by its 6-digit code. A code match also finds unlisted trips; a text search only returns published public ones.',
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Hebrew search text, or a 6-digit trip code.' },
      },
      required: ['query'],
    },
    execute: async ({ query }) => {
      const q = String(query || '').trim();
      if (!q) return fail('query is required');
      const rows = await TRIPI.api('/api/trips/search?q=' + encodeURIComponent(q));
      return ok({ count: rows.length, trips: rows.map(tripSummary) });
    },
  });

  register({
    name: 'tripmaker_list_suggested_trips',
    title: 'Suggested trips',
    description: 'The curated public trips shown on the home page, most-liked first. Useful as a starting point to clone or as inspiration for a new itinerary.',
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const rows = await TRIPI.api('/api/trips/suggested');
      return ok({ count: rows.length, trips: rows.map(tripSummary) });
    },
  });

  register({
    name: 'tripmaker_get_trip',
    title: 'Read a trip',
    description: 'Full detail for one trip by its 6-digit code: the itinerary grouped by day, hotels, and — for trip participants — the budget and expense log. Every stop comes back with its id, which is what the stop-editing tools take.',
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^\\d{6}$', description: 'The 6-digit trip code.' } },
      required: ['code'],
    },
    execute: async ({ code }) => {
      const c = String(code || '').trim();
      if (!/^\d{6}$/.test(c)) return fail('code must be 6 digits');
      const data = await TRIPI.api('/api/trips/code/' + encodeURIComponent(c));
      const byDay = new Map();
      for (const it of data.items || []) {
        if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
        byDay.get(it.day_number).push({
          id: it.id,
          title: it.title,
          time_label: it.time_label || null,
          category: it.category || null,
          area: it.area || null,
          note: it.note || null,
          place_query: it.place_query || null,
          lat: it.lat ?? null,
          lon: it.lon ?? null,
          cost: it.cost ?? null,
        });
      }
      return ok({
        trip: tripSummary(data.trip),
        can_edit: !!data.canEdit,
        is_owner: !!data.isOwner,
        participants: (data.participants || []).map((p) => ({ name: p.name, is_owner: !!p.is_owner })),
        days: [...byDay.keys()].sort((a, b) => a - b).map((day) => ({ day, stops: byDay.get(day) })),
        hotels: data.hotels || [],
        budget: data.budget || null,
        expenses: data.expenses || [],
      });
    },
  });

  register({
    name: 'tripmaker_list_my_trips',
    title: 'My trips',
    description: "The signed-in user's own trips plus the ones they joined as a participant. is_mine tells the two apart; drafts are included.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const denied = requireAuth();
      if (denied) return denied;
      const rows = await TRIPI.api('/api/my-trips');
      return ok({
        count: rows.length,
        trips: rows.map((t) => ({ ...tripSummary(t), is_mine: !!t.is_mine })),
      });
    },
  });

  register({
    name: 'tripmaker_search_destinations',
    title: 'Look up a destination',
    description: 'Geocode a place name to Hebrew name, country and coordinates (Open-Meteo). Use it to resolve destinations before creating a trip, so the trip carries real coordinates instead of just text.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Place name, Hebrew or English. At least 2 characters.' } },
      required: ['query'],
    },
    execute: async ({ query }) => {
      if (typeof GEO === 'undefined') return fail('destination lookup is not available on this page');
      const places = await GEO.searchPlaces(String(query || '').trim());
      return ok({ count: places.length, places });
    },
  });

  // ---------- writing ----------
  register({
    name: 'tripmaker_create_trip',
    title: 'Create a trip',
    description: 'Create a trip, optionally with its whole itinerary in one call. Returns the 6-digit code and the trip URL. Prefer passing all the stops here over adding them one at a time — it is a single transaction. Create it as a draft while still planning: a draft keeps its code hidden until it is published.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Trip name, in Hebrew. Required. Do not put a flag emoji in it — flags are rendered from the destination countries.' },
        destination: { type: 'string', description: 'Display text for the destination. Derived from `destinations` when omitted.' },
        country: { type: 'string', description: 'Country name in Hebrew. Derived from `destinations` when omitted.' },
        destinations: {
          type: 'array',
          description: 'The places this trip covers, in order. Resolve them with tripmaker_search_destinations first so the coordinates are real.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              country: { type: 'string' },
              lat: { type: 'number' },
              lon: { type: 'number' },
            },
            required: ['name'],
          },
        },
        description: { type: 'string', description: 'A short paragraph about the trip, in Hebrew.' },
        emoji: { type: 'string', description: 'One emoji for the trip. Not a flag.' },
        days: { type: 'integer', minimum: 1, maximum: 60, description: 'Length in days, 1–60.' },
        start_date: { type: 'string', description: 'ISO date, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'ISO date, YYYY-MM-DD.' },
        cover_image: { type: 'string', description: 'Absolute URL of a cover image.' },
        draft: { type: 'boolean', description: 'Create as a draft (default false). A draft is not shareable until published.' },
        items: {
          type: 'array',
          description: 'The itinerary. Each stop needs at least a title and a day_number.',
          items: { type: 'object', properties: STOP_PROPS, required: ['title'] },
        },
      },
      required: ['title'],
    },
    execute: async (input) => {
      const denied = requireAuth();
      if (denied) return denied;
      if (!String(input.title || '').trim()) return fail('title is required');
      if (!String(input.destination || '').trim() && !(input.destinations || []).length) {
        return fail('give either destination text or a destinations array');
      }
      const trip = await TRIPI.api('/api/trips', { method: 'POST', body: JSON.stringify(input) });
      return ok({
        created: true,
        ...tripSummary(trip),
        note: 'Open the URL to see it, or use tripmaker_get_trip with the code.',
      });
    },
  });

  register({
    name: 'tripmaker_open',
    title: 'Open a page',
    description: 'Navigate the browser to a page of the site. Navigating replaces the page, so the tool list changes right after — call tripmaker_whoami again to see what is available. Opening a trip is what makes the stop-editing tools appear.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', enum: ['home', 'plan', 'my', 'trip'], description: 'Which page. "trip" also needs `code`.' },
        code: { type: 'string', pattern: '^\\d{6}$', description: 'Trip code, when page is "trip".' },
      },
      required: ['page'],
    },
    execute: async ({ page, code }) => {
      const paths = { home: '/', plan: '/plan', my: '/my' };
      let path = paths[page];
      if (page === 'trip') {
        if (!/^\d{6}$/.test(String(code || ''))) return fail('page "trip" needs a 6-digit code');
        path = '/trip/' + code;
      }
      if (!path) return fail('unknown page: ' + page);
      // navigate after the result has been handed back — tearing the document down
      // mid-call would lose the answer the agent is waiting on
      setTimeout(() => { location.href = path; }, 50);
      return ok({ navigating_to: location.origin + path });
    },
  });
}());
