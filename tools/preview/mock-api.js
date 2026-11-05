// A stand-in for the trip API, for looking at the UI without a database: one fixed trip,
// with stops that can be added, edited and removed in memory. Isomorphic on purpose —
// tools/preview/server.js uses it in node, and the static demo build (Cloudflare Pages,
// the artifact preview) loads it in the browser and answers fetch('/api/…') with it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TripmakerMock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // switches for the node preview server; the in-browser demo has no process.env
  const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);
  const U = (id, w = 1200) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

  const user = { id: 1, name: 'רגב כהן', email: 'demo@tripmaker.co.il', is_admin: false };
  const trip = {
    id: 1, share_code: '731502', owner_id: 1, title: 'רומא בארבעה ימים', emoji: '🍕',
    destination: 'רומא', country: 'איטליה', days: 5, start_date: '2026-10-12', end_date: '2026-10-16',
    description: 'ארבעה ימים ברומא הקלאסית — הקולוסיאום והפורום, הוותיקן, טרווי ופנתאון, ובערב טרסטוורה. יום חמישי חופשי לפסטה שלא סיימתם, או לטיול יום לטיבולי.',
    cover_image: U('photo-1552832230-c0197dd311b5'),
    destinations: [{ name: 'רומא', country: 'איטליה', cc: 'it', lat: 41.893, lon: 12.483 }],
    is_public: true, is_draft: false, likes: 12, invite_token: 'demo-invite-token', created_at: '2026-08-01T10:00:00Z',
    // the wizard's interest chips ride on the trip: המלצות opens by naming them, the
    // free-day picks say what they were chosen around, and both prompts are built on
    // them (lib/trips.js tripPrefsBlock)
    plan_state: { mode: 'manual', stage: 'done', interests: ['אוכל ומסעדות', 'היסטוריה ותרבות'], notes: 'שני ילדים, קצב רגוע', facts: [], pending: [], areas: [] },
  };
  let nextId = 100;
  let expenseId = 1;
  let dayRecsFlip = false;
  const DAY_RECS_A = [
    { title: 'שוק קמפו דה פיורי', blurb: 'שוק הבוקר של מרכז רומא — פירות, גבינות ומאפים חמים. הכי טוב לפני 11:00.', category: 'אוכל', duration: 'שעה', cost: '₪', time: '09:30', area: 'רומא', place_query: 'Campo de\' Fiori, Rome, Italy', lat: 41.8955, lon: 12.4722, photos: [] },
    { title: 'גני וילה בורגזה', blurb: 'הריאה הירוקה של רומא — שכירת סירה באגם, ותצפית פינצ׳ו מעל פיאצה דל פופולו.', category: 'טבע', duration: 'שעתיים', cost: 'חינם', time: '13:00', area: 'רומא', place_query: 'Villa Borghese, Rome, Italy', lat: 41.9142, lon: 12.4922, photos: [] },
    { title: 'טרסטוורה בערב', blurb: 'סמטאות, כיכר סנטה מריה, ומסעדות משפחתיות — הרובע לארוחת ערב ארוכה.', category: 'חיי לילה', duration: 'ערב', cost: '₪₪', time: '20:00', area: 'רומא', place_query: 'Trastevere, Rome, Italy', lat: 41.8897, lon: 12.4694, photos: [] },
  ];
  const DAY_RECS_B = [
    { title: 'שוק טסטאצ׳ו', blurb: 'שוק מקורה עם דוכני אוכל מצוינים — הטריפה והסופלי של רומא האמיתית.', category: 'אוכל', duration: 'שעה-שעתיים', cost: '₪', time: '10:00', area: 'רומא', place_query: 'Mercato di Testaccio, Rome, Italy', lat: 41.8757, lon: 12.4781, photos: [] },
    { title: 'הפנתאון', blurb: 'הכיפה השלמה ביותר מהעת העתיקה, חינם, ולהגיע מוקדם לפני הקבוצות.', category: 'תרבות', duration: 'שעה', cost: 'חינם', time: '13:30', area: 'רומא', place_query: 'Pantheon, Rome, Italy', lat: 41.8986, lon: 12.4769, photos: [] },
    { title: 'ג׳אניקולו בשקיעה', blurb: 'הגבעה מעל טרסטוורה — הנוף הכי טוב על הגגות של רומא, בלי כרטיס ובלי תור.', category: 'נוף', duration: 'שעה', cost: 'חינם', time: '18:30', area: 'רומא', place_query: 'Gianicolo, Rome, Italy', lat: 41.8917, lon: 12.4614, photos: [] },
  ];
  // the draft's free days, once its pass has been asked for: three picks a day, the way
  // routes/day-recs.js writes them — nothing at all before that, which is what the page
  // sees while the planning chat is still settling the basics
  const DRAFT_RECS = [
    { title: 'שוק צוקיג׳י החיצוני', blurb: 'ארוחת בוקר של סושי, טמאגו וטה מאצ׳ה בין הדוכנים. סגור בימי רביעי.', category: 'אוכל', duration: 'שעה-שעתיים', cost: '₪₪', time: '09:00', area: 'טוקיו', place_query: 'Tsukiji Outer Market, Tokyo, Japan', lat: 35.6654, lon: 139.7707, photos: [] },
    { title: 'גני מייג׳י ג׳ינגו', blurb: 'יער בלב העיר ומקדש שינטו שקט — הפסקה מהעומס של הרג׳וקו הסמוכה.', category: 'טבע', duration: 'שעתיים', cost: 'חינם', time: '13:00', area: 'טוקיו', place_query: 'Meiji Jingu, Shibuya, Tokyo, Japan', lat: 35.6764, lon: 139.6993, photos: [] },
    { title: 'גולדן גאיי בערב', blurb: 'סמטאות של ברים זעירים בשינג׳וקו — שישה מושבים לכל אחד, וכל אחד שונה.', category: 'חיי לילה', duration: 'ערב', cost: '₪₪', time: '20:00', area: 'טוקיו', place_query: 'Golden Gai, Shinjuku, Tokyo, Japan', lat: 35.6938, lon: 139.7044, photos: [] },
  ];
  let draftRecsAsked = false; // the pass the planning chat starts when the basics land
  let expenses = [];
  // the demo trip's hotels and budget frame — what the chats' hotel / budget / date
  // actions write into (lib/plan-actions.js on the real server)
  let hotels = [];
  let budget = null;
  const MOCK_HOTELS = [
    { id: 'lp1', name: 'Hotel Artemide', stars: 4, rating: 9.1, reviewCount: 3120, distance: 380, price: 742, lat: 41.9009, lon: 12.4934, provider: 'liteapi', address: 'Via Nazionale 22, Roma', photo: U('photo-1566073771259-6a8506099945') },
    { id: 'lp2', name: 'The Pantheon Iconic', stars: 5, rating: 9.4, reviewCount: 980, distance: 620, price: 1890, lat: 41.8986, lon: 12.4769, provider: 'liteapi', address: 'Via di Santa Chiara 4, Roma', photo: U('photo-1551882547-ff40c63fe5fa') },
    { id: 'lp3', name: 'Hotel Campo de\' Fiori', stars: 4, rating: 8.7, reviewCount: 1544, distance: 910, price: 655, lat: 41.8957, lon: 12.4722, provider: 'liteapi', address: 'Via del Biscione 6, Roma', photo: U('photo-1582719478250-c89cae4dc85b') },
    { id: 'lp4', name: 'Trastevere Suites', stars: 3, rating: 8.9, reviewCount: 610, distance: 1300, price: 430, lat: 41.8893, lon: 12.4699, provider: 'liteapi', address: 'Via della Lungaretta 90, Roma', photo: U('photo-1590490360182-c33d57733427') },
    { id: 'lp5', name: 'Monti Boutique Rooms', stars: 3, rating: 9.0, reviewCount: 402, distance: 1500, price: 512, lat: 41.8955, lon: 12.4918, provider: 'liteapi', address: 'Via Urbana 11, Roma', photo: U('photo-1631049307264-da0ec9d70304') },
  ];
  let hotelId = 500;
  const sideState = () => ({ hotels, budget, trip: { start_date: trip.start_date, end_date: trip.end_date } });
  // the same canned reading of an attached file both chats answer with: a booking
  // confirmation becomes a hotel, a ticket fills the first flight's hour
  function fileUnderstanding(files, days) {
    const name = files[0] && files[0].name || 'הקובץ';
    const ticket = /ticket|boarding|flight|טיסה|LY/i.test(name);
    if (ticket) {
      return {
        text: `ראיתי שהעליתם כרטיס טיסה — אל על LY 385, המראה ב-06:10 ונחיתה ב-10:40 ✈️ עדכנתי את שעת הטיסה במסלול ואת תאריך היציאה. יש גם כרטיס חזור?`,
        actions: [{ kind: 'dates_set', start_date: '2026-11-03' }],
        changes: [{ kind: 'dates', title: 'תאריך היציאה: 3 בנובמבר 2026' }],
      };
    }
    return {
      text: `ראיתי שהעליתם אישור הזמנה ממלון Hotel Artemide, לילות 1–3, 540 € — איזה יופי! הוספתי אותו לרשימת המלונות עם המחיר. רוצים שאסמן אותו גם בתקציב?`,
      actions: [{ kind: 'hotel_add', name: 'Hotel Artemide', night_start: 1, night_end: Math.min(3, Math.max(days - 1, 1)), status: 'booked', stars: 4, price_total: 540, link: null, note: 'הזמנה #BK-20931' }],
      changes: [{ kind: 'hotel', title: 'Hotel Artemide', when: 'לילות 1–3', note: 'הוזמן · 540' }],
    };
  }
  function applyActions(acts) {
    const undo = [];
    for (const a of acts || []) {
      if (a.kind === 'hotel_add') { const h = { id: hotelId++, ...a, lat: null, lon: null }; delete h.kind; hotels.push(h); undo.unshift({ kind: 'hotel_delete', id: h.id }); }
      else if (a.kind === 'hotel_delete') { const h = hotels.find((x) => x.id === a.id); if (h) { hotels = hotels.filter((x) => x !== h); undo.unshift({ kind: 'hotel_restore', row: h }); } }
      else if (a.kind === 'budget_set') { undo.unshift(budget ? { kind: 'budget_restore', row: budget } : { kind: 'budget_clear' }); budget = { total: a.total, currency: a.currency || 'ILS', travelers: a.travelers || 2 }; }
      else if (a.kind === 'dates_set') { undo.unshift({ kind: 'dates_restore', start_date: trip.start_date }); trip.start_date = a.start_date; }
    }
    return undo;
  }
  function undoActions(undo) {
    for (const u of undo || []) {
      if (u.kind === 'hotel_delete') hotels = hotels.filter((x) => x.id !== u.id);
      else if (u.kind === 'hotel_restore') hotels.push(u.row);
      else if (u.kind === 'budget_restore') budget = u.row;
      else if (u.kind === 'budget_clear') budget = null;
      else if (u.kind === 'dates_restore') trip.start_date = u.start_date;
    }
  }
  const stop = (day, time, title, note, cat, lat, lon) => ({
    id: nextId++, trip_id: 1, day_number: day, time_label: time, title, note, place_query: `${title} Rome`,
    category: cat, area: 'רומא', lat, lon, cost: null, google_place_id: null, sort_order: nextId,
  });
  // The demo trip's stop photos, keyed by the ids its stops are created with (100-108,
  // in order below). Real ones, fetched once through lib/stop-photos.js's free road
  // (OSM element -> Wikidata -> Commons). The Spanish Steps have none there, so that card
  // keeps its emoji tile - the fallback is part of what the preview should show.
  const STOP_PHOTOS = {
    "100": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/330px-Colosseo_2020.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · FeaturedPics · CC BY-SA 4.0",
      "link": "https://commons.wikimedia.org/wiki/File:Colosseo_2020.jpg",
      "source": "commons"
    },
    "101": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/62/Palatine_Hill_from_across_the_Circus_Maximus_April_2019.jpg/330px-Palatine_Hill_from_across_the_Circus_Maximus_April_2019.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · Lil Herodotus · CC BY-SA 4.0",
      "link": "https://commons.wikimedia.org/wiki/File:Palatine_Hill_from_across_the_Circus_Maximus_April_2019.jpg",
      "source": "commons"
    },
    "102": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Santa_Maria_in_Trastevere_fountain.jpg/330px-Santa_Maria_in_Trastevere_fountain.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · Jensens · Public domain",
      "link": "https://commons.wikimedia.org/wiki/File:Santa_Maria_in_Trastevere_fountain.jpg",
      "source": "commons"
    },
    "103": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0e/Mura_vaticane_-_ingresso_ai_Musei_00410.JPG/330px-Mura_vaticane_-_ingresso_ai_Musei_00410.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · user:Lalupa · CC BY-SA 3.0",
      "link": "https://commons.wikimedia.org/wiki/File:Mura_vaticane_-_ingresso_ai_Musei_00410.JPG",
      "source": "commons"
    },
    "104": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f5/Basilica_di_San_Pietro_in_Vaticano_September_2015-1a.jpg/330px-Basilica_di_San_Pietro_in_Vaticano_September_2015-1a.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · Alvesgaspar · CC BY-SA 4.0",
      "link": "https://commons.wikimedia.org/wiki/File:Basilica_di_San_Pietro_in_Vaticano_September_2015-1a.jpg",
      "source": "commons"
    },
    "105": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7b/Pantheon_%28Rome%29_-_Right_side_and_front.jpg/330px-Pantheon_%28Rome%29_-_Right_side_and_front.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · NikonZ7II · CC BY-SA 4.0",
      "link": "https://commons.wikimedia.org/wiki/File:Pantheon_(Rome)_-_Right_side_and_front.jpg",
      "source": "commons"
    },
    "106": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c7/Trevi_Fountain_-_Roma.jpg/330px-Trevi_Fountain_-_Roma.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · NikonZ7II · CC BY-SA 4.0",
      "link": "https://commons.wikimedia.org/wiki/File:Trevi_Fountain_-_Roma.jpg",
      "source": "commons"
    },
    "108": {
      "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/39/Villa_Borghese_-_entrata_2669.JPG/330px-Villa_Borghese_-_entrata_2669.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      "credit": "Wikimedia Commons · user:Lalupa · Public domain",
      "link": "https://commons.wikimedia.org/wiki/File:Villa_Borghese_-_entrata_2669.JPG",
      "source": "commons"
    }
  };
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

  // a second demo trip, still a draft, opened on the planning chat: /trip/000001#plan.
  // The chat is canned — a fixed script of turns, so the cards, the proposal cards and
  // the build can be looked at without a model behind them
  const draft = {
    id: 2, share_code: '000001', owner_id: 1, title: 'טיול ליפן', emoji: '🧭',
    destination: 'יפן', country: 'יפן', days: 10, start_date: '2026-11-03', end_date: '2026-11-12',
    description: null, cover_image: U('photo-1469854523086-cc02fe5d8800'),
    destinations: [{ name: 'יפן', country: 'יפן', cc: 'jp', lat: 36.2, lon: 138.25 }],
    is_public: false, is_draft: true, likes: 0, invite_token: 'demo-invite-token-2', created_at: '2026-09-01T10:00:00Z',
    plan_state: { mode: 'manual', stage: 'clarify', interests: ['אוכל ומסעדות', 'היסטוריה ותרבות'], notes: 'קצב רגוע', facts: [], pending: [], areas: [] },
  };
  let draftItems = [];
  let planMsgs = [];
  let planNextId = 1;
  const planMsg = (role, text, payload = {}) => {
    const m = { id: planNextId++, role, text, payload, created_at: new Date().toISOString() };
    planMsgs.push(m);
    return m;
  };
  const CARD = (title, blurb, category, place_query, lat, lon) =>
    ({ title, blurb, category, duration: 'שעתיים', cost: '₪', time: '', area: 'יפן', place_query, lat, lon, photos: [] });
  function planTurn(text) {
    const st = draft.plan_state;
    if (st.stage === 'clarify') {
      st.stage = 'choose'; st.pending = []; st.facts = [`אזורים: ${text}`];
      return planMsg('ai', 'מעולה. איך נבנה אותו? 🧭 שלב אחרי שלב יוצא מדויק יותר — ותמיד אפשר לשנות.',
        { suggestions: ['שלב אחרי שלב 🪜', 'בבת אחת ✨'] });
    }
    if (st.stage === 'choose') {
      if (/בבת אחת|הכול|מהר/.test(text)) { st.build = 'once'; return planMsg('ai', 'סבבה, בונים את כל הטיול עכשיו ✨', { build: 'once' }); }
      st.stage = 'areas'; st.build = 'steps';
      st.areas = [{ area: 'טוקיו', from: 1, to: 5, cities: ['טוקיו', 'ניקו'] }, { area: 'קיוטו', from: 6, to: 10, cities: ['קיוטו', 'נארה', 'אוסקה'] }];
      return planMsg('ai', 'נתחיל מהאזורים: לעשרה ימים בקצב רגוע אני מציע חמישה ימים בטוקיו (עם יום לניקו) וחמישה בקיוטו, עם קפיצה לנארה ולאוסקה. מתאים לכם, או שתרצו לוותר על אחד מהם?',
        { suggestions: ['מתאים, נמשיך', 'רק טוקיו'] });
    }
    if (st.stage === 'areas') {
      // the flights stage is a card, not a round of questions: the turn that reaches it
      // fills the card in and says so (routes/plan.js seeds plan_state.flights the same way)
      st.stage = 'flights';
      st.flights = {
        legs: [
          { kind: 'out', day: 1, from: { code: 'TLV', name: 'תל אביב' }, to: { code: 'NRT', name: 'טוקיו' }, depart: '', arrive: '', stops: [] },
          { kind: 'return', day: 10, from: { code: 'KIX', name: 'אוסקה' }, to: { code: 'TLV', name: 'תל אביב' }, depart: '', arrive: '', stops: [] },
        ],
        confirmed: false,
        items: [],
      };
      return planMsg('ai', 'מצוין, החלוקה נשמרה. מילאתי לכם הצעה לטיסות — נחיתה בנריטה וחזרה מקנסאי. תקנו בכרטיס מה שצריך, ושעות אפשר להשאיר ריקות.', {});
    }
    if (st.stage === 'flights') {
      return planMsg('ai', 'הטיסות מחכות לכם בכרטיס למטה — אפשר לתקן שם הכול ולאשר, ואז נמשיך לימים.', {});
    }
    if (/מה יש|מה כדאי|אוכל|לאכול/.test(text)) {
      return planMsg('ai', 'בטוקיו הייתי פותח עם שני מקומות שמסבירים את העיר, ואחד לאוכל:', {
        suggestions: ['תוסיף את הראשון', 'משהו יותר רגוע'],
        cards: [
          CARD('מקדש סנסוג׳י ואסאקוסה', 'המקדש העתיק בעיר, ורחוב הדוכנים נקאמיסה שמוביל אליו. הכי טוב לפני 9:00.', 'תרבות', 'Sensoji Temple, Asakusa, Tokyo, Japan', 35.7148, 139.7967),
          CARD('שוק צוקיג׳י החיצוני', 'ארוחת בוקר של סושי, טמאגו וטה מאצ׳ה בין הדוכנים. סגור בימי רביעי.', 'אוכל', 'Tsukiji Outer Market, Tokyo, Japan', 35.6654, 139.7707),
          CARD('גני מייג׳י ג׳ינגו', 'יער בלב העיר ומקדש שינטו שקט — הפסקה מהעומס של הרג׳וקו הסמוכה.', 'טבע', 'Meiji Jingu, Shibuya, Tokyo, Japan', 35.6764, 139.6993),
        ],
      });
    }
    const ops = [{ action: 'add', id: null, day_number: 2, time_label: '09:00', title: 'מקדש סנסוג׳י ואסאקוסה', note: 'להגיע לפני 9:00, לפני הקבוצות', place_query: 'Sensoji Temple, Asakusa, Tokyo, Japan', category: 'תרבות', area: 'טוקיו', cost: null, lat: 35.7148, lon: 139.7967 }];
    // an explicit ask ("תוסיף") is committed on the spot; the AI's own anchor is proposed
    const asked = /תוסיף|תכניס/.test(text);
    const m = planMsg('ai', asked ? 'הוספתי את סנסוג׳י לבוקר של יום 2. ליום 3 — שוק צוקיג׳י בבוקר וטיול ערב בשיבויה?' : 'אני מציע לפתוח את יום 2 בסנסוג׳י ואסאקוסה. מאשרים? ואחרי זה נדבר על יום 3.',
      { suggestions: ['מאשרים', 'משהו אחר ליום 2'], ops, changes: [{ kind: 'add', title: ops[0].title, when: 'יום 2 · 09:00', note: ops[0].note }] });
    if (asked) applyOps(m); else m.payload.decision = 'pending';
    return m;
  }
  // the same moment routes/plan.js marks: the opening round is behind us AND something
  // was written down, so the trip page's dock arrives under a message of its own
  function planMilestone() {
    const st = draft.plan_state;
    if (st.basics || !['days', 'done'].includes(st.stage)) return null;
    if (!st.facts.length && !st.areas.length) return null;
    st.basics = true;
    return planMsg('ai', 'קבענו את הבסיס! עכשיו מתחילים באמת — זה הזמן לצפות במסלול, לצפות בהמלצות ולקבוע תחנות. תמיד אפשר לחזור לכאן.',
      { unlocked: true, suggestions: ["אני רוצה להמשיך בצ'אט"] });
  }

  function applyOps(m) {
    const undo = { added: [], updated: [], deleted: [] };
    for (const op of m.payload.ops || []) {
      if (op.action === 'add') {
        const it = { id: nextId++, trip_id: 2, day_number: op.day_number, time_label: op.time_label, title: op.title, note: op.note,
          place_query: op.place_query, category: op.category, area: op.area, lat: op.lat ?? null, lon: op.lon ?? null, cost: op.cost, google_place_id: null, sort_order: nextId };
        draftItems.push(it); undo.added.push(it.id);
      } else if (op.action === 'delete') {
        const it = draftItems.find((x) => x.id === op.id);
        if (it) { undo.deleted.push(it); draftItems = draftItems.filter((x) => x !== it); }
      }
    }
    m.payload.decision = 'applied';
    m.payload.undo = undo;
    m.payload.applied = { added: undo.added.length, updated: 0, removed: undo.deleted.length };
  }

  const json = (status, body) => ({ status, body });

  // The day's pictures from Google Drive (routes/day-photos.js). MOCK_NO_DRIVE=1 plays the
  // traveller whose Drive is not connected — the whole feature should then vanish. The
  // thumbnails are Commons pictures standing in for the signed Drive links.
  const WM = (f, w) => `https://upload.wikimedia.org/wikipedia/commons/thumb/${f}/${w}px-${f.split('/').pop()}`;
  const DRIVE = [
    { file_id: 'd1', name: 'IMG_2041.jpg', taken: '2026-10-12T09:41:00', lat: 41.8902, lon: 12.4922, f: 'd/de/Colosseo_2020.jpg' },
    { file_id: 'd2', name: 'IMG_2047.jpg', taken: '2026-10-12T11:05:00', lat: 41.8925, lon: 12.4853, f: '6/62/Palatine_Hill_from_across_the_Circus_Maximus_April_2019.jpg' },
    { file_id: 'd3', name: 'IMG_2060.jpg', taken: '2026-10-12T19:22:00', lat: 41.8894, lon: 12.4700, f: 'd/de/Santa_Maria_in_Trastevere_fountain.jpg' },
    { file_id: 'd4', name: 'IMG_2063.jpg', taken: '2026-10-12T20:10:00', lat: null, lon: null, f: '0/0e/Mura_vaticane_-_ingresso_ai_Musei_00410.JPG' },
    { file_id: 'd5', name: 'IMG_1990.jpg', taken: '2026-10-08T14:00:00', lat: null, lon: null, f: 'c/c7/Trevi_Fountain_-_Roma.jpg' },
    { file_id: 'd6', name: 'IMG_2052.jpg', taken: '2026-10-12T13:30:00', lat: 41.8986, lon: 12.4769, f: '7/7b/Pantheon_%28Rome%29_-_Right_side_and_front.jpg' },
  ].map((d) => ({ ...d, thumb: WM(d.f, 330), full: WM(d.f, 1280), link: 'https://drive.google.com/' }));
  let dayPhotos = [
    { id: 1, day: 1, mine: true, ...DRIVE[0] },
    { id: 2, day: 1, mine: true, ...DRIVE[1] },
    { id: 3, day: 1, mine: false, ...DRIVE[2], link: null },
  ];
  let dayPhotoId = 10;
  function driveMock(method, p, u, body) {
    const noDrive = !!env('MOCK_NO_DRIVE');
    const dp = p.match(/^\/api\/trips\/code\/\d+\/day-photos(?:\/(\d+))?$/);
    if (dp && method === 'GET') return json(200, noDrive ? { can_add: false, photos: [] } : { can_add: true, photos: dayPhotos });
    if (dp && method === 'POST') {
      const add = DRIVE.filter((d) => (body.files || []).includes(d.file_id) && !dayPhotos.some((x) => x.day === +body.day && x.file_id === d.file_id));
      add.forEach((d) => dayPhotos.push({ id: dayPhotoId++, day: +body.day, mine: true, ...d }));
      return json(200, { added: add.length, skipped: 0 });
    }
    if (dp && method === 'DELETE') { dayPhotos = dayPhotos.filter((x) => x.id !== +dp[1]); return json(200, { ok: true }); }
    if (p === '/api/connectors/drive/photos') {
      if (noDrive) return json(409, { error: 'Google Drive לא מחובר' });
      const date = u.searchParams.get('date');
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const hit = DRIVE.filter((d) => !q || d.name.toLowerCase().includes(q));
      return json(200, { day: hit.filter((d) => d.taken.slice(0, 10) === date), recent: hit.filter((d) => d.taken.slice(0, 10) !== date), next: null });
    }
    return null;
  }

  const deletedTrips = new Set();
  function myTrips() {
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const t = (o) => ({ is_public: false, is_draft: false, is_mine: true, likes: 0, emoji: '🧭', created_at: '2026-08-01T10:00:00Z', ...o });
    return [
      t({ ...draft, is_mine: true, start_date: day(70), end_date: day(79) }),
      t({ id: 11, share_code: '418265', title: 'ליסבון ופורטו', destination: 'ליסבון, פורטו', country: 'פורטוגל', days: 7,
        start_date: day(-2), end_date: day(4), cover_image: U('photo-1555881400-74d7acaacd8b'), destinations: [{ name: 'ליסבון', cc: 'pt' }, { name: 'פורטו', cc: 'pt' }] }),
      t({ id: 12, share_code: '553019', title: 'החגים בניו יורק', destination: 'ניו יורק', country: 'ארצות הברית', days: 6,
        start_date: day(23), end_date: day(28), cover_image: U('photo-1496442226666-8d4d0e62e6e9'), destinations: [{ name: 'ניו יורק', cc: 'us' }] }),
      t({ id: 13, share_code: '660412', title: 'טרק באנאפורנה', destination: 'פוקהרה', country: 'נפאל', days: 14, is_mine: false,
        start_date: day(130), end_date: day(143), cover_image: U('photo-1544735716-392fe2489ffa'), destinations: [{ name: 'פוקהרה', cc: 'np' }] }),
      t({ id: 14, share_code: '207731', title: 'סוף שבוע באתונה', destination: 'אתונה', country: 'יוון', days: 3,
        start_date: null, end_date: null, cover_image: U('photo-1555993539-1732b0258235'), destinations: [{ name: 'אתונה', cc: 'gr' }] }),
      t({ ...trip, is_mine: true }),
      t({ id: 15, share_code: '390218', title: 'קיץ בדולומיטים', destination: 'קורטינה', country: 'איטליה', days: 8, is_mine: false,
        start_date: '2026-07-04', end_date: '2026-07-11', cover_image: U('photo-1491555103944-7c647fd857e6'), destinations: [{ name: 'קורטינה', cc: 'it' }] }),
    ];
  }

  const weatherWatched = new Set();
  function handle(method, url, body) {
    const u = new URL(url, 'http://x');
    const p = u.pathname;
    body = body || {};
    const drv = driveMock(method, p, u, body);
    if (drv) return drv;
    if (p === '/api/me') return json(200, user);
    // referrals: two friends already in, one to go
    if (p === '/api/me/referral') return json(200, { code: 'demo123', link: 'https://tripmaker.co.il/?ref=demo123', referred: 2, needed: 3, bonus: false, multiplier: 2 });
    if (p === '/api/me/referral/claim') return json(200, { claimed: false });
    // the draft's planning chat
    const pm = p.match(/^\/api\/trips\/code\/000001\/plan(\/.*)?$/);
    if (pm) {
      const rest = pm[1] || '';
      if (!draft.is_draft) return json(409, { error: 'הטיול כבר נשמר' });
      if (!rest && method === 'GET') {
        if (!planMsgs.length) {
          draft.plan_state.pending = [{ question: 'באיזה אזור להתמקד בעשרת הימים?', options: ['טוקיו והסביבה (טוקיו, ניקו)', 'קנסאי (קיוטו, אוסקה, נארה)', 'שניהם'], multi: false }];
          planMsg('ai', 'היי! מתכננים יחד את הטיול ליפן — 10 ימים. שאלה קטנה קודם: באיזה אזור להתמקד בעשרת הימים?',
            { suggestions: ['טוקיו והסביבה (טוקיו, ניקו)', 'קנסאי (קיוטו, אוסקה, נארה)', 'שניהם'] });
        }
        return json(200, { state: draft.plan_state, messages: planMsgs, files_remaining: 3 });
      }
      if (!rest && method === 'PATCH') {
        if (body.areas) draft.plan_state.areas = body.areas;
        return json(200, { state: draft.plan_state });
      }
      if (!rest && method === 'POST') {
        // "מכסה" in a message plays the spent day; "מוכן" plays the AI judging the trip settled
        if (/מכסה/.test(String(body.message || ''))) return json(429, { error: 'ניצלתם את הודעות התכנון להיום', quota: 'plan' });
        // a document handed over with the +: the AI says what it read, then acts on it
        // (committed on the spot — a fact the travellers handed over, not an idea)
        const files = Array.isArray(body.attachments) ? body.attachments : [];
        if (files.length) {
          const text = String(body.message || '').trim() || (files.length === 1 ? `צירפתי קובץ: ${files[0].name}` : `צירפתי ${files.length} קבצים`);
          const sent = planMsg('user', text, { files: files.map((f) => ({ name: f.name, kind: f.kind, read: f.text ? 'text' : f.image ? 'image' : 'none' })) });
          const u = fileUnderstanding(files, draft.days);
          const undoActs = applyActions(u.actions);
          const m = planMsg('ai', u.text, { suggestions: ['כן, תסמן בתקציב', 'אין כרטיס חזור עדיין'], actions: u.actions, changes: u.changes, decision: 'applied', undo: null, undoActions: undoActs, applied: { added: 0, updated: 0, removed: 0, actions: u.actions.length } });
          return json(200, { message: m, sent, state: draft.plan_state, items: null, side: { hotels, budget, trip: { start_date: draft.start_date, end_date: draft.end_date } }, remaining: 48, files_remaining: 3 - files.length });
        }
        planMsg('user', String(body.message || ''), body.receipt ? { receipt: true } : {});
        if (/מוכן/.test(String(body.message || ''))) {
          const m = planMsg('ai', 'לדעתי הטיול כבר עומד על הרגליים: האזורים והטיסות סגורים ולכל יום יש עוגן. רוצים שנעבור על יום 4, או להשלים את השאר אוטומטית?', { suggestions: ['נעבור על יום 4'], invite: true });
          return json(200, { message: m, state: draft.plan_state, items: null, remaining: 40 });
        }
        const m = planTurn(String(body.message || ''));
        return json(200, { message: m, milestone: planMilestone(), state: draft.plan_state, items: m.payload.decision === 'applied' ? draftItems : null, remaining: 50 });
      }
      if (rest === '/decide') {
        const m = planMsgs.find((x) => x.id === +body.message_id);
        if (!m) return json(404, { error: 'לא נמצא' });
        if (body.decision === 'undo') {
          draftItems = draftItems.filter((x) => !((m.payload.undo && m.payload.undo.added) || []).includes(x.id));
          if (m.payload.undoActions) undoActions(m.payload.undoActions);
          m.payload.decision = 'undone'; m.payload.undo = null; m.payload.undoActions = null;
          return json(200, { message: m, items: draftItems, side: { hotels, budget, trip: { start_date: draft.start_date, end_date: draft.end_date } } });
        }
        if (body.decision === 'accept') applyOps(m); else m.payload.decision = 'rejected';
        // the decision is a turn: the AI answers it with the next step
        const titles = (m.payload.changes || []).map((c) => c.title).join(', ');
        const said = body.decision === 'accept' ? `✓ אישרתי את השינויים: ${titles}` : `לא עכשיו — בלי ${titles}`;
        planMsg('user', said, { receipt: true });
        const follow = body.decision === 'accept'
          ? planMsg('ai', 'מעולה, הטיסות במסלול. עכשיו הימים: נתחיל מטוקיו — ליום 2 אני חושב על סנסוג׳י ואסאקוסה בבוקר ושיבויה בערב. מתאים, או שתעדיפו התחלה רגועה יותר?', { suggestions: ['מתאים', 'משהו רגוע יותר'] })
          : planMsg('ai', 'אין בעיה. רוצים שנשאיר את הטיסות בחוץ בינתיים ונעבור לימים, או להזין אותן אחרת?', { suggestions: ['נעבור לימים', 'טיסה רק ביום 1'] });
        return json(200, { message: m, items: draftItems, said, follow, milestone: planMilestone(), state: draft.plan_state, remaining: 40 });
      }
      // the flights card, confirmed: stops written straight from the legs, no model turn
      if (rest === '/flights') {
        const st = draft.plan_state;
        const legs = body.skip ? [] : (body.legs || []);
        draftItems = draftItems.filter((it) => !(st.flights.items || []).includes(it.id));
        const label = (a) => (a && (a.name || a.code)) || '';
        const written = [];
        for (const l of legs) {
          const points = [l.from, ...(l.stops || []), l.to];
          for (let i = 0; i < points.length - 1; i++) {
            const it = { id: nextId++, trip_id: 2, day_number: l.day, time_label: (i === 0 ? l.depart : points[i].depart) || null,
              title: `טיסה מ${label(points[i])} ל${label(points[i + 1])}`,
              note: i > 0 ? `קונקשן ב${label(points[i])}` : 'עדכנו את השעות כשיהיו לכם',
              place_query: null, category: 'נסיעה', area: l.day > 5 ? 'קיוטו' : 'טוקיו', lat: null, lon: null, cost: null, google_place_id: null, sort_order: nextId };
            draftItems.push(it);
            written.push(it.id);
          }
        }
        st.flights = { legs, confirmed: true, items: written };
        const advancing = st.stage === 'flights';
        if (advancing) st.stage = 'days';
        const said = body.skip ? 'אין לנו עדיין פרטי טיסות — נמשיך לתכנן את הימים' : `✓ אישרנו את הטיסות (${legs.length})`;
        planMsg('user', said, { receipt: true });
        // where the basics land there is no model turn at all: the milestone is the whole
        // answer, and the days start on the next turn (routes/plan.js does the same)
        const milestone = planMilestone();
        if (milestone) return json(200, { items: draftItems, state: st, said, milestone });
        const follow = advancing
          ? planMsg('ai', 'מעולה, הטיסות במסלול. נתחיל מהימים: ליום 2 אני חושב על סנסוג׳י ואסאקוסה בבוקר. מתאים?', { suggestions: ['מתאים', 'משהו רגוע יותר'] })
          : planMsg('ai', 'עדכנתי את הטיסות במסלול.', {});
        return json(200, { items: draftItems, state: st, said, follow, remaining: 40 });
      }
      if (rest === '/build') {
        const fill = !!body.fill;
        if (!fill) draftItems = [];
        const add = (d, t, title, cat, area) => draftItems.push({ id: nextId++, trip_id: 2, day_number: d, time_label: t, title, note: null, place_query: null, category: cat, area, lat: null, lon: null, cost: null, google_place_id: null, sort_order: nextId });
        for (let d = 1; d <= 10; d++) {
          const area = d <= 5 ? 'טוקיו' : 'קיוטו';
          if (!draftItems.some((it) => it.day_number === d && it.time_label === '10:00')) add(d, '10:00', `בוקר ב${area} — יום ${d}`, 'תרבות', area);
          if (!draftItems.some((it) => it.day_number === d && it.time_label === '13:00')) add(d, '13:00', `צהריים ב${area}`, 'אוכל', area);
        }
        draft.plan_state.stage = 'done';
        draft.plan_state.basics = true;
        draft.description = draft.description || 'עשרה ימים ביפן בקצב רגוע: טוקיו וניקו, ואז קיוטו עם נארה ואוסקה — מקדשים, שווקים ואוכל.';
        const m = planMsg('ai', fill ? 'השלמתי את שאר הימים.' : 'בניתי את הטיול — 20 תחנות על פני 10 ימים.', { built: { count: 20, fill } });
        return json(200, { items: draftItems, plan: draft.plan_state.areas.length ? draft.plan_state.areas : [{ area: 'טוקיו', from: 1, to: 5, cities: ['טוקיו'] }, { area: 'קיוטו', from: 6, to: 10, cities: ['קיוטו'] }], message: m, state: draft.plan_state, trip: { description: draft.description, emoji: draft.emoji, cover_image: draft.cover_image } });
      }
      return json(404, { error: 'mock: no plan route' });
    }
    if (p === '/api/trips/2' && method === 'PATCH') { Object.assign(draft, body); return json(200, draft); }
    // production has Google configured, so the preview shows the button where people see it
    if (p === '/api/auth/providers') return json(200, { google: !env('MOCK_NO_GOOGLE') });
    if (p === '/api/analytics/config') return json(200, {});
    if (p.startsWith('/api/push/')) return json(200, { key: null });
    // nearby hotels for the night cards and the hotels page: a handful of Roman hotels
    // with photos, priced and with a detail sheet, the way LiteAPI answers in production
    if (p === '/api/hotels/prices') {
      const out = {};
      for (const id of (u.searchParams.get('ids') || '').split(',')) {
        const h = MOCK_HOTELS.find((x) => x.id === id);
        if (h && h.price) out[id] = { amount: h.price, currency: 'ILS' };
      }
      return json(200, out);
    }
    if (p === '/api/hotels/detail') {
      const h = MOCK_HOTELS.find((x) => x.id === u.searchParams.get('id'));
      if (!h) return json(404, { error: 'no details' });
      return json(200, {
        images: [h.photo, ...MOCK_HOTELS.filter((x) => x !== h).slice(0, 4).map((x) => x.photo)],
        categories: [{ name: 'Location', rating: 9.4 }, { name: 'Cleanliness', rating: 8.8 }, { name: 'Staff', rating: 9.1 }, { name: 'Value for money', rating: 8.2 }],
        pros: ['Great location, walking distance to everything', 'Lovely rooftop breakfast'],
        cons: ['Rooms are on the small side'],
        facilities: ['Wi-Fi', 'מיזוג', 'ארוחת בוקר', 'קבלה 24/7', 'גג'],
        checkin: '03:00 PM', checkout: '11:00 AM',
      });
    }
    if (p === '/api/hotels') return json(200, MOCK_HOTELS.map(({ price, ...h }) => ({ ...h })));
    if (p === '/api/trips/suggested') return json(200, []);
    // /my: a traveller with a past, a present and a future — dates are relative to
    // today so the page always has one of each (MOCK_MY_EMPTY=1 shows the empty state)
    if (p === '/api/my-trips') return json(200, env('MOCK_MY_EMPTY') ? [] : myTrips().filter((t) => !deletedTrips.has(t.id)));
    const dt = p.match(/^\/api\/trips\/(\d+)$/);
    if (dt && method === 'DELETE') { deletedTrips.add(+dt[1]); return json(200, { ok: true }); }
    // אהבתי, from the hero chip
    const lm = p.match(/^\/api\/trips\/(\d+)\/like$/);
    if (lm) {
      trip.likes = Math.max(0, trip.likes + (body && body.undo ? -1 : 1));
      return json(200, { likes: trip.likes });
    }
    const m = p.match(/^\/api\/trips\/code\/(\d+)(\/.*)?$/);
    if (m) {
      // any code opens the one demo trip — a host may put the page on any path —
      // except 000001, the draft, and 900001, the same trip seen by a gallery visitor
      // who may read it but not touch it (that is the only way to preview the copy card
      // in המלצות, and the page swapping itself over to the copy in place)
      const rest = m[2] || '';
      if (m[1] === '900001') {
        if (!rest) {
          return json(200, {
            trip: { ...trip, share_code: '900001', invite_token: null },
            items, isOwner: false, canEdit: false, isAdmin: false,
            hotels: [], budget: null, expenses: [], participants: [],
          });
        }
        // the copy lands in the visitor's account as the editable demo trip
        if (rest === '/clone' && method === 'POST') return json(200, trip);
        if (rest === '/votes' || rest === '/day-recs') return json(200, rest === '/votes' ? [] : { days: {}, running: false });
        if (rest === '/photos') return json(200, { stops: {} });
        return json(200, {});
      }
      if (m[1] === '000001') {
        if (!rest) {
          return json(200, {
            trip: draft, items: draftItems, isOwner: true, canEdit: true, isAdmin: false,
            hotels: [], budget: null, expenses: [], participants: [{ id: 1, name: user.name, is_owner: true }],
          });
        }
        if (rest === '/publish') { draft.is_draft = false; return json(200, draft); }
        if (rest === '/votes') return json(200, []);
        // the free days' picks: empty until something asks for them (the real pass is
        // started by routes/plan.js the moment the basics are settled), then ready
        if (rest === '/day-recs' || rest === '/day-recs/refresh') {
          if (rest === '/day-recs/refresh') draftRecsAsked = true;
          const days = {};
          if (draftRecsAsked) {
            for (let d = 1; d <= draft.days; d++) {
              if (draftItems.some((it) => it.day_number === d)) continue;
              days[d] = { status: 'ready', cards: DRAFT_RECS.map((c) => ({ ...c })), updated_at: new Date().toISOString() };
            }
          }
          return json(200, { days, running: false, ready: Object.keys(days).length, waiting: 0, remaining: 39 });
        }
        if (rest === '/items' && method === 'POST') {
          const it = { id: nextId++, trip_id: 2, day_number: +body.day_number || 1, time_label: body.time_label || null, title: String(body.title || ''), note: body.note || null,
            place_query: body.place_query || null, category: body.category || null, area: body.area || null, lat: body.lat ?? null, lon: body.lon ?? null, cost: body.cost != null && body.cost !== '' ? +body.cost : null, google_place_id: null, sort_order: nextId };
          draftItems.push(it);
          return json(200, it);
        }
        return json(200, {});
      }
      if (!rest) {
        return json(200, {
          trip, items, isOwner: true, canEdit: true, isAdmin: false,
          hotels, budget, expenses, participants: [{ id: 1, name: user.name, is_owner: true }],
          weatherWatch: [...weatherWatched],
        });
      }
      // the extreme-weather switch on a stop sheet — remembered for the session
      const wwm = rest.match(/^\/items\/(\d+)\/weather-watch$/);
      if (wwm && method === 'PUT') {
        if (body && body.on) weatherWatched.add(+wwm[1]); else weatherWatched.delete(+wwm[1]);
        return json(200, { ok: true, on: !!(body && body.on), watched: [...weatherWatched] });
      }
      // the model's category for a hand-added stop — a keyword guess here, and null
      // (the generic tile) for anything it cannot place, which is the path to preview
      if (rest === '/classify-stop' && method === 'POST') {
        const t = `${body.title || ''} ${body.place || ''}`;
        const guess = [[/ארוח|קפה|מסעד|פיצה|גלידה|שוק אוכל|בר /, 'אוכל'], [/טיסה|רכבת|אוטובוס|מעבורת|נסיעה|העברה/, 'נסיעה'],
          [/מוזיאון|גלריה|כנסי|מופע|קונצרט/, 'תרבות'], [/פארק|גן |טבע|יער|הליכה/, 'טבע'], [/חוף|ים /, 'ים'],
          [/קניות|קניון|שוק/, 'קניות'], [/תצפית|נוף/, 'נוף'], [/מלון|צ׳ק אין|צ'ק אין/, 'לינה']].find(([re]) => re.test(t));
        return json(200, { category: guess ? guess[1] : null });
      }
      if (rest === '/photos') {
        const stops = {};
        for (const it of items) if (STOP_PHOTOS[it.id]) stops[it.id] = STOP_PHOTOS[it.id];
        return json(200, { stops });
      }
      if (rest === '/votes') return json(200, []);
      // a lodging stop moved to the hotels page (routes/trips.js …/to-hotel): this stop
      // and every lodging stop of the same name become one stay idea
      const thm = rest.match(/^\/items\/(\d+)\/to-hotel$/);
      if (thm && method === 'POST') {
        const it = items.find((x) => x.id === +thm[1]);
        if (!it) return json(404, { error: 'התחנה לא נמצאה' });
        const name = String(it.title).replace(/^(צ['׳]?ק[\s-]?(אין|אאוט)|לינה|חזרה)\s*(ב|ל|מ)?-?\s*/, '').trim() || it.title;
        const same = items.filter((x) => x.category === 'לינה' && x.title.includes(name));
        const nights = same.map((x) => Math.min(x.day_number, trip.days - 1));
        const h = { id: hotelId++, name, night_start: Math.min(...nights), night_end: Math.max(...nights), status: 'idea', stars: null,
          lat: it.lat ?? null, lon: it.lon ?? null, price_total: null, link: null, note: it.note || null, photo: null, ref: null };
        hotels.push(h);
        items = items.filter((x) => !same.includes(x));
        return json(200, { hotel: h, removed: same.map((x) => x.id), hotels });
      }
      // the hotels page: add, edit and remove a stay
      if (rest === '/hotels' && method === 'POST') {
        if (!String(body.name || '').trim()) return json(400, { error: 'חסר שם למלון' });
        const h = { id: hotelId++, name: String(body.name).trim(), night_start: +body.night_start || 1, night_end: Math.max(+body.night_end || 1, +body.night_start || 1),
          status: body.status === 'idea' ? 'idea' : 'booked', stars: body.stars || null, lat: body.lat ?? null, lon: body.lon ?? null,
          price_total: body.price_total ? +body.price_total : null, link: body.link || null, note: body.note || null, photo: body.photo || null, ref: body.ref || null };
        hotels.push(h);
        return json(200, h);
      }
      const hm = rest.match(/^\/hotels\/(\d+)$/);
      if (hm) {
        const h = hotels.find((x) => x.id === +hm[1]);
        if (method === 'DELETE') { hotels = hotels.filter((x) => x !== h); return json(200, { ok: true }); }
        if (!h) return json(404, { error: 'המלון לא נמצא' });
        Object.assign(h, { ...body, id: h.id, price_total: body.price_total ? +body.price_total : null, photo: body.photo || null, ref: body.ref || null });
        return json(200, h);
      }
      if (rest === '/expenses' && method === 'POST') {
        const title = String(body.title || '').slice(0, 160).trim();
        const amount = +body.amount;
        if (!title) return json(400, { error: 'על מה הוצאתם? חסר תיאור' });
        if (!(amount > 0)) return json(400, { error: 'חסר סכום תקין' });
        const itemId = +body.item_id || null;
        if (itemId) {
          const existing = expenses.find((e) => +e.item_id === itemId);
          if (existing) return json(200, existing);
        }
        const e = {
          id: expenseId++, title, amount, category: body.category || 'אחר',
          day_number: +body.day_number || null, paid_by: user.name, item_id: itemId,
          created_at: new Date().toISOString(),
        };
        expenses.unshift(e);
        return json(200, e);
      }
      const em = rest.match(/^\/expenses\/(\d+)$/);
      if (em && method === 'DELETE') {
        expenses = expenses.filter((e) => e.id !== +em[1]);
        return json(200, { ok: true });
      }
      // the recommendations chat, canned: the demo has no model behind it
      if (rest === '/recs' && method === 'POST') {
        const q = String(body.message || '');
        if (/מכסה/.test(q)) return json(429, { error: 'ניצלתם את שאלות ההמלצות להיום', quota: 'recs' });
        // a document handed over with the +: the AI says what it read and proposes
        const files = Array.isArray(body.attachments) ? body.attachments : [];
        if (files.length) {
          const u = fileUnderstanding(files, trip.days);
          return json(200, { text: u.text.replace('הוספתי אותו', 'אני מציע להוסיף אותו').replace('עדכנתי', 'אני מציע לעדכן'), cards: [], ops: [], actions: u.actions, changes: u.changes,
            files: files.map((f) => ({ name: f.name, kind: f.kind, read: f.text ? 'text' : f.image ? 'image' : 'none' })), remaining: 27 });
        }
        // an explicit change request → a proposal, no cards
        if (/תוסיף|תכניס|תמחק|תוריד|תזיז/.test(q)) {
          const last = items[items.length - 1];
          const ops = /תמחק|תוריד/.test(q)
            ? [{ action: 'delete', id: last.id, day_number: null, time_label: null, title: null, note: null, place_query: null, category: null, area: null, cost: null }]
            : [{ action: 'add', id: null, day_number: 5, time_label: '10:00', title: 'שוק קמפו דה פיורי', note: 'שוק הבוקר — לפני 11:00', place_query: 'Campo de\' Fiori, Rome, Italy', category: 'אוכל', area: 'רומא', cost: null, lat: 41.8955, lon: 12.4722 }];
          const changes = ops.map((o) => o.action === 'delete'
            ? { kind: 'delete', title: last.title, when: `יום ${last.day_number}` }
            : { kind: 'add', title: o.title, when: 'יום 5 · 10:00', note: o.note });
          return json(200, { text: /תמחק|תוריד/.test(q) ? 'אני מציע להוריד את התחנה הזו מהמסלול. מאשרים?' : 'אני מציע לפתוח את יום 5 בשוק קמפו דה פיורי — בוקר של פירות, גבינות ומאפים. מאשרים?', cards: [], ops, changes, remaining: 27 });
        }
        const food = /אוכל|מסעד|לאכול|שוק/.test(q);
        const cards = /טיפ|כדאי לדעת/.test(q) ? [] : (food ? [
          { title: 'שוק קמפו דה פיורי', blurb: 'שוק הבוקר של מרכז רומא — פירות, גבינות ומאפים חמים. הכי טוב לפני 11:00.', category: 'אוכל', duration: 'שעה', cost: '₪', time: '09:30', area: 'רומא', place_query: 'Campo de\' Fiori, Rome, Italy', lat: 41.8955, lon: 12.4722, photos: [] },
          { title: 'טרסטוורה — סיור אוכל רחוב', blurb: 'סופלי, פיצה אל טליו וקרואסון בסמטאות שהמקומיים אוכלים בהן. באים רעבים.', category: 'אוכל', duration: 'כ-3 שעות', cost: '₪₪', time: '18:00', area: 'רומא', place_query: 'Trastevere, Rome, Italy', lat: 41.8897, lon: 12.4694, photos: [] },
          { title: 'שוק טסטאצ׳ו', blurb: 'שוק מקורה עם דוכני אוכל מצוינים — הטריפה והסופלי של רומא האמיתית.', category: 'אוכל', duration: 'שעה-שעתיים', cost: '₪', time: '12:30', area: 'רומא', place_query: 'Mercato di Testaccio, Rome, Italy', lat: 41.8757, lon: 12.4781, photos: [] },
        ] : [
          { title: 'הפנתאון', blurb: 'הכיפה השלמה ביותר מהעת העתיקה, חינם, ולהגיע מוקדם לפני הקבוצות.', category: 'תרבות', duration: 'שעה', cost: 'חינם', time: '09:00', area: 'רומא', place_query: 'Pantheon, Rome, Italy', lat: 41.8986, lon: 12.4769, photos: [] },
          { title: 'גני וילה בורגזה', blurb: 'הריאה הירוקה של רומא — שכירת סירה באגם, ותצפית פינצ׳ו מעל פיאצה דל פופולו בשקיעה.', category: 'טבע', duration: 'שעתיים', cost: 'חינם', time: '17:00', area: 'רומא', place_query: 'Villa Borghese, Rome, Italy', lat: 41.9142, lon: 12.4922, photos: [] },
          { title: 'טרסטוורה בערב', blurb: 'סמטאות, כיכר סנטה מריה, ומסעדות משפחתיות — הרובע לארוחת ערב ארוכה.', category: 'חיי לילה', duration: 'ערב', cost: '₪₪', time: '20:00', area: 'רומא', place_query: 'Trastevere, Rome, Italy', lat: 41.8897, lon: 12.4694, photos: [] },
        ]);
        const text = cards.length
          ? (food ? 'ברומא אוכלים הכי טוב איפה שהמקומיים אוכלים — שווקים בבוקר וסמטאות בערב. שלוש נקודות פתיחה:' : 'הנה שלוש נקודות פתיחה טובות ברומא — אחת להבין את העיר, אחת לנשום, ואחת לערב:')
          : 'כמה דברים שכדאי לדעת: קפה עומדים ליד הבר עולה אירו, אותו קפה בשולחן על הפיאצה — חמישה. לקולוסיאום ולוותיקן מזמינים כרטיס מראש; לכל השאר פשוט מגיעים.';
        return json(200, { text, cards, remaining: 29 });
      }
      // a free day's picks (trip_day_recs), canned: the demo's day 5 is free
      if (rest === '/day-recs' || rest === '/day-recs/refresh') {
        if (rest === '/day-recs/refresh' && Number.isInteger(+body.day) && body.day) dayRecsFlip = !dayRecsFlip;
        const set = dayRecsFlip ? DAY_RECS_B : DAY_RECS_A;
        const days = {};
        for (let d = 1; d <= trip.days; d++) {
          if (items.some((it) => it.day_number === d)) continue;
          days[d] = { status: 'ready', cards: set.map((c) => ({ ...c })), updated_at: new Date().toISOString() };
        }
        // the real route answers with the shape the page watches while a pass fills in
        // (routes/day-recs.js); nothing is ever pending here, so it is always done
        return json(200, { days, running: false, ready: Object.keys(days).length, waiting: 0, remaining: 39 });
      }
      if (rest === '/recs/apply' && method === 'POST') {
        const undo = { added: [], updated: [], deleted: [] };
        let added = 0, removed = 0;
        for (const op of body.ops || []) {
          if (op.action === 'add') {
            const it = { id: nextId++, trip_id: 1, day_number: op.day_number, time_label: op.time_label, title: op.title, note: op.note, place_query: op.place_query,
              category: op.category, area: op.area, lat: op.lat ?? null, lon: op.lon ?? null, cost: op.cost, google_place_id: null, sort_order: nextId };
            items.push(it); undo.added.push(it.id); added++;
          } else if (op.action === 'delete') {
            const it = items.find((x) => x.id === op.id);
            if (it) { undo.deleted.push(it); items = items.filter((x) => x !== it); removed++; }
          }
        }
        const undoActs = applyActions(body.actions);
        return json(200, { applied: { added, updated: 0, removed, actions: (body.actions || []).length }, undo: added + removed ? undo : null, undo_actions: undoActs.length ? undoActs : null, items, side: sideState() });
      }
      if (rest === '/recs/undo' && method === 'POST') {
        const u = body.undo || {};
        items = items.filter((x) => !(u.added || []).includes(x.id));
        for (const it of u.deleted || []) items.push({ ...it, id: nextId++ });
        undoActions(body.undo_actions);
        return json(200, { undone: true, items, side: sideState() });
      }
      if (rest === '/items' && method === 'POST') {
        if (!body.title) return json(400, { error: 'חסרה כותרת לתחנה' });
        const it = {
          id: nextId++, trip_id: 1, day_number: Math.min(Math.max(+body.day_number || 1, 1), trip.days),
          time_label: body.time_label || null, title: String(body.title).slice(0, 200), note: body.note || null,
          place_query: body.place_query || null, category: body.category || null, area: body.area || null,
          lat: body.lat ?? null, lon: body.lon ?? null, cost: body.cost != null && body.cost !== '' ? +body.cost : null, google_place_id: null, sort_order: nextId,
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
      if (rest === '/clone' && method === 'POST') return json(200, trip);
      if (rest === '/dates') { Object.assign(trip, body); return json(200, trip); }
      if (rest === '/locate') return json(200, { located: [] });
      return json(200, {});
    }
    return json(404, { error: 'mock: no route ' + p });
  }

  return { handle, trip, user };
});
