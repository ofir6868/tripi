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
  let expenseId = 1;
  let expenses = [];
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
      st.stage = 'flights';
      return planMsg('ai', 'מצוין, החלוקה נשמרה. עכשיו הטיסות: מאיפה ממריאים ולאן נוחתים — ואם יש קונקשן, איפה? אם השעות עוד לא ידועות, נשאיר אותן ריקות ותעדכנו אחר כך.',
        { suggestions: ['נחיתה בטוקיו, חזרה מאוסקה', 'עוד לא הזמנו'] });
    }
    if (st.stage === 'flights') {
      st.stage = 'days';
      const ops = [
        { action: 'add', id: null, day_number: 1, time_label: null, title: 'טיסה מתל אביב לטוקיו', note: 'עדכנו את השעה כשהכרטיס אצלכם', place_query: null, category: 'נסיעה', area: 'טוקיו', cost: null },
        { action: 'add', id: null, day_number: 1, time_label: null, title: 'נחיתה בנריטה ונסיעה למלון', note: 'רכבת Narita Express לתחנת טוקיו, כשעה', place_query: null, category: 'נסיעה', area: 'טוקיו', cost: 140 },
        { action: 'add', id: null, day_number: 10, time_label: null, title: 'טיסת חזרה מאוסקה', note: 'קנסאי — להגיע 3 שעות לפני', place_query: null, category: 'נסיעה', area: 'קיוטו', cost: null },
      ];
      const m = planMsg('ai', 'רשמתי. אני מציע להכניס למסלול את ההמראה, הנחיתה בנריטה עם הרכבת לעיר, ואת טיסת החזרה מקנסאי ביום האחרון. מאשרים?',
        { suggestions: ['מאשרים', 'תוסיף גם קונקשן'], ops, changes: ops.map((o) => ({ kind: 'add', title: o.title, when: `יום ${o.day_number}`, note: o.note })) });
      if (st.mode === 'auto') applyOps(m); else m.payload.decision = 'pending';
      return m;
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
    const m = planMsg('ai', st.mode === 'auto' ? 'הוספתי את סנסוג׳י לבוקר של יום 2. ליום 3 — שוק צוקיג׳י בבוקר וטיול ערב בשיבויה?' : 'אני מציע לפתוח את יום 2 בסנסוג׳י ואסאקוסה. מאשרים? ואחרי זה נדבר על יום 3.',
      { suggestions: ['מאשרים', 'משהו אחר ליום 2'], ops, changes: [{ kind: 'add', title: ops[0].title, when: 'יום 2 · 09:00', note: ops[0].note }] });
    if (st.mode === 'auto') applyOps(m); else m.payload.decision = 'pending';
    return m;
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

  function handle(method, url, body) {
    const p = new URL(url, 'http://x').pathname;
    body = body || {};
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
        return json(200, { state: draft.plan_state, messages: planMsgs });
      }
      if (!rest && method === 'PATCH') {
        if (body.mode) draft.plan_state.mode = body.mode;
        if (body.areas) draft.plan_state.areas = body.areas;
        return json(200, { state: draft.plan_state });
      }
      if (!rest && method === 'POST') {
        // "מכסה" in a message plays the spent day; "מוכן" plays the AI judging the trip settled
        if (/מכסה/.test(String(body.message || ''))) return json(429, { error: 'ניצלתם את הודעות התכנון להיום', quota: 'plan' });
        planMsg('user', String(body.message || ''));
        if (/מוכן/.test(String(body.message || ''))) {
          const m = planMsg('ai', 'לדעתי הטיול כבר עומד על הרגליים: האזורים והטיסות סגורים ולכל יום יש עוגן. רוצים שנעבור על יום 4, או להשלים את השאר אוטומטית?', { suggestions: ['נעבור על יום 4'], invite: true });
          return json(200, { message: m, state: draft.plan_state, items: null, remaining: 40 });
        }
        if (body.mode) draft.plan_state.mode = body.mode;
        const m = planTurn(String(body.message || ''));
        return json(200, { message: m, state: draft.plan_state, items: m.payload.decision === 'applied' ? draftItems : null, remaining: 50 });
      }
      if (rest === '/decide') {
        const m = planMsgs.find((x) => x.id === +body.message_id);
        if (!m) return json(404, { error: 'לא נמצא' });
        if (body.decision === 'undo') {
          draftItems = draftItems.filter((x) => !(m.payload.undo.added || []).includes(x.id));
          m.payload.decision = 'undone'; m.payload.undo = null;
          return json(200, { message: m, items: draftItems });
        }
        if (body.decision === 'accept') applyOps(m); else m.payload.decision = 'rejected';
        // the decision is a turn: the AI answers it with the next step
        const titles = (m.payload.changes || []).map((c) => c.title).join(', ');
        const said = body.decision === 'accept' ? `✓ אישרתי את השינויים: ${titles}` : `לא עכשיו — בלי ${titles}`;
        planMsg('user', said);
        const follow = body.decision === 'accept'
          ? planMsg('ai', 'מעולה, הטיסות במסלול. עכשיו הימים: נתחיל מטוקיו — ליום 2 אני חושב על סנסוג׳י ואסאקוסה בבוקר ושיבויה בערב. מתאים, או שתעדיפו התחלה רגועה יותר?', { suggestions: ['מתאים', 'משהו רגוע יותר'] })
          : planMsg('ai', 'אין בעיה. רוצים שנשאיר את הטיסות בחוץ בינתיים ונעבור לימים, או להזין אותן אחרת?', { suggestions: ['נעבור לימים', 'טיסה רק ביום 1'] });
        return json(200, { message: m, items: draftItems, said, follow, state: draft.plan_state, remaining: 40 });
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
        draft.description = draft.description || 'עשרה ימים ביפן בקצב רגוע: טוקיו וניקו, ואז קיוטו עם נארה ואוסקה — מקדשים, שווקים ואוכל.';
        const m = planMsg('ai', fill ? 'השלמתי את שאר הימים.' : 'בניתי את הטיול — 20 תחנות על פני 10 ימים.', { built: { count: 20, fill } });
        return json(200, { items: draftItems, plan: draft.plan_state.areas.length ? draft.plan_state.areas : [{ area: 'טוקיו', from: 1, to: 5, cities: ['טוקיו'] }, { area: 'קיוטו', from: 6, to: 10, cities: ['קיוטו'] }], message: m, state: draft.plan_state, trip: { description: draft.description, emoji: draft.emoji, cover_image: draft.cover_image } });
      }
      return json(404, { error: 'mock: no plan route' });
    }
    if (p === '/api/trips/2' && method === 'PATCH') { Object.assign(draft, body); return json(200, draft); }
    if (p === '/api/auth/providers') return json(200, { google: false });
    if (p === '/api/analytics/config') return json(200, {});
    if (p.startsWith('/api/push/')) return json(200, { key: null });
    if (p === '/api/trips/suggested' || p === '/api/my-trips' || p.startsWith('/api/hotels')) return json(200, []);
    const m = p.match(/^\/api\/trips\/code\/(\d+)(\/.*)?$/);
    if (m) {
      // any code opens the one demo trip — a host may put the page on any path —
      // except 000001, the draft
      const rest = m[2] || '';
      if (m[1] === '000001') {
        if (!rest) {
          return json(200, {
            trip: draft, items: draftItems, isOwner: true, canEdit: true, isAdmin: false,
            hotels: [], budget: null, expenses: [], participants: [{ id: 1, name: user.name, is_owner: true }],
          });
        }
        if (rest === '/publish') { draft.is_draft = false; return json(200, draft); }
        if (rest === '/votes') return json(200, []);
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
          hotels: [], budget: null, expenses, participants: [{ id: 1, name: user.name, is_owner: true }],
        });
      }
      if (rest === '/votes') return json(200, []);
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
        // אוטומטי + an explicit change request → a proposal, no cards
        if (body.mode === 'auto' && /תוסיף|תכניס|תמחק|תוריד|תזיז/.test(q)) {
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
        return json(200, { applied: { added, updated: 0, removed }, undo: added + removed ? undo : null, items });
      }
      if (rest === '/recs/undo' && method === 'POST') {
        const u = body.undo || {};
        items = items.filter((x) => !(u.added || []).includes(x.id));
        for (const it of u.deleted || []) items.push({ ...it, id: nextId++ });
        return json(200, { undone: true, items });
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
      if (rest === '/dates') { Object.assign(trip, body); return json(200, trip); }
      if (rest === '/locate') return json(200, { located: [] });
      return json(200, {});
    }
    return json(404, { error: 'mock: no route ' + p });
  }

  return { handle, trip, user };
});
