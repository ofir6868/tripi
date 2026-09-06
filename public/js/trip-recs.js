// המלצות — a chat with the AI about the area, answered with recommendation cards that
// drop straight into the itinerary.
//
// The ANSWERS are a mock for now: canned Hebrew replies templated on the trip's own
// destinations, with the destination pages' photos. Everything around them is real —
// the thread persists per trip, a card's ➕ opens the day picker and goes through the
// page's addItem (so the stop renders in both views like any other), and "תבחרו
// בשבילי" lands on the emptiest day in the card's area. When the server endpoint
// arrives, ask() is the one function to swap; the reply shape stays {text, cards}.
const TripRecs = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const IMG = (id, w = 720) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=70`;

  // the same photos the destination pages ship — proven to resolve, one per place
  const DEST_PHOTOS = {
    'רומא': 'photo-1552832230-c0197dd311b5', 'מילאנו': 'photo-1520440229-6469a149ac59', 'ברצלונה': 'photo-1583422409516-2895a77efded',
    'ליסבון': 'photo-1585208798174-6cedd86e019a', 'פריז': 'photo-1502602898657-3e91760cbb34', 'לונדון': 'photo-1513635269975-59663e0ac1ad',
    'אמסטרדם': 'photo-1534351590666-13e3e96b5017', 'ברלין': 'photo-1560930950-5cc20e80e392', 'פראג': 'photo-1541849546-216549ae216d',
    'בודפשט': 'photo-1541343672885-9be56236302a', 'וינה': 'photo-1516550893923-42d28e5677af', 'אתונה': 'photo-1555993539-1732b0258235',
    'סנטוריני': 'photo-1613395877344-13d4a8e0d49e', 'כרתים': 'photo-1533105079780-92b9be482077', 'רודוס': 'photo-1504512485720-7d83a16ee930',
    'קפריסין': 'photo-1601581875039-e899893d520c', 'טנריף': 'photo-1533130061792-64b345e4a833', 'מונטנגרו': 'photo-1614122027743-50a9e6e8002f',
    'אלבניה': 'photo-1483683804023-6ccdb62f86ef', 'דובאי': 'photo-1512453979798-5ea266f8880c', 'גאורגיה': 'photo-1565008447742-97f6f38c985c',
    'תאילנד': 'photo-1552465011-b4e21bf6e79a', 'וייטנאם': 'photo-1528127269322-539801943592', 'הודו': 'photo-1548013146-72479768bada',
    'נפאל': 'photo-1544735716-392fe2489ffa', 'סרי לנקה': 'photo-1612862862126-865765df2ded', 'יפן': 'photo-1540959733332-eab4deabeeaf',
    'טוקיו': 'photo-1540959733332-eab4deabeeaf', 'פרו': 'photo-1526392060635-9d6019884377', 'ארגנטינה': 'photo-1589909202802-8f4aadce1849',
    'קולומביה': 'photo-1583531352515-8884af319dc1', 'מקסיקו': 'photo-1518638150340-f706e86654de', 'ניו יורק': 'photo-1496442226666-8d4d0e62e6e9',
    'איסלנד': 'photo-1504829857797-ddff29c27927', 'בנסקו': 'photo-1551524559-8af4e6624178', 'רמת הגולן': 'photo-1544971587-b842c27f8e14',
    'קו פנגן': 'photo-1552465011-b4e21bf6e79a',
  };
  const GENERIC = ['photo-1469854523086-cc02fe5d8800', 'photo-1539635278303-d4002c07eae3', 'photo-1552733407-5d5c46c3bb3b', 'photo-1530521954074-e64f6810b32d'];

  const CAT_EMOJI = {
    'אטרקציה': '🎡', 'אוכל': '🍜', 'טבע': '🌿', 'ים': '🏖️', 'תרבות': '🎭',
    'קניות': '🛍️', 'לינה': '🏨', 'נוף': '🌄', 'חיי לילה': '🌙',
  };
  const AREA_COLORS = ['#ffb45f', '#8fd8c4', '#c9a7ff', '#7fb8ff', '#ff9db1', '#ffd166'];
  const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

  const ICON = {
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    map: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    send: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/></svg>',
  };

  // =================================================================
  //  THE MOCK — {d} is the destination the answer is about
  // =================================================================

  const POOL = {
    food: [
      { t: 'סיור אוכל רחוב ב{d}', b: 'שלוש-ארבע תחנות של אוכל מקומי במרחק הליכה, בדוכנים שהמקומיים עומדים בהם בתור. באים רעבים.', cat: 'אוכל', dur: 'כ-3 שעות', cost: '₪₪', time: '18:00' },
      { t: 'השוק המרכזי של {d}', b: 'הכי טוב לפני 11:00 — פירות, גבינות ומאפים חמים. מקום מצוין לארוחת בוקר על הרגליים.', cat: 'אוכל', dur: 'שעה-שעתיים', cost: '₪', time: '09:30' },
      { t: 'ארוחת ערב ברובע הישן של {d}', b: 'מסעדה משפחתית עם תפריט קצר שמתחלף לפי העונה. שווה להזמין מקום יום מראש.', cat: 'אוכל', dur: 'שעתיים', cost: '₪₪₪', time: '20:00' },
    ],
    nature: [
      { t: 'תצפית הזריחה מעל {d}', b: 'עלייה קצרה של 25 דקות, ונוף פנורמי על כל האזור. כדאי להביא משהו חם לשתות.', cat: 'נוף', dur: 'שעה וחצי', cost: 'חינם', time: '06:30' },
      { t: 'הפארק הגדול של {d}', b: 'הריאה הירוקה של העיר: שבילי הליכה, אגם קטן ופינות פיקניק. מושלם להפסקה בין אטרקציות.', cat: 'טבע', dur: 'שעה-שעתיים', cost: 'חינם', time: '11:00' },
      { t: 'שביל הליכה בפאתי {d}', b: 'מסלול מעגלי קל של כ-6 ק"מ עם כמה נקודות תצפית. מתאים גם למשפחות עם ילדים.', cat: 'טבע', dur: 'כ-3 שעות', cost: 'חינם', time: '08:00' },
    ],
    beach: [
      { t: 'החוף השקט של {d}', b: 'חוף חולי עם מים רדודים, שכפ"ץ להשכרה, ופחות תיירים מהחוף המרכזי.', cat: 'ים', dur: 'חצי יום', cost: '₪', time: '10:00' },
      { t: 'שייט שקיעה מול חופי {d}', b: 'סירה קטנה, שעתיים על המים, והשמש שוקעת מאחורי הקו. מזמינים יום קודם.', cat: 'ים', dur: 'שעתיים', cost: '₪₪', time: '18:30' },
      { t: 'מפרץ השנורקל ליד {d}', b: 'כניסה מהחוף, ראות מצוינת בבקרים, וציוד שמשכירים במקום.', cat: 'ים', dur: 'שעתיים-שלוש', cost: '₪', time: '09:00' },
    ],
    culture: [
      { t: 'המוזיאון הראשי של {d}', b: 'האוסף שמספר את הסיפור של האזור. שעתיים מספיקות, וכרטיס מראש חוסך את התור.', cat: 'תרבות', dur: 'שעתיים', cost: '₪₪', time: '10:00' },
      { t: 'סיור מודרך ברובע העתיק של {d}', b: 'שעתיים של סמטאות, כיכרות וסיפורים — הדרך הכי טובה להבין את המקום ביום הראשון.', cat: 'תרבות', dur: 'שעתיים', cost: '₪', time: '16:00' },
      { t: 'הופעה מקומית בערב ב{d}', b: 'מוזיקה חיה במקום קטן שהתושבים אוהבים. הכניסה בדרך כלל חופשית או סמלית.', cat: 'חיי לילה', dur: 'שעתיים', cost: '₪', time: '21:00' },
    ],
    night: [
      { t: 'ברים על הגג ב{d}', b: 'שניים-שלושה גגות במרחק הליכה זה מזה, עם נוף על העיר. מתחילים לפני השקיעה.', cat: 'חיי לילה', dur: 'ערב שלם', cost: '₪₪', time: '19:30' },
      { t: 'הרחוב שלא נרדם ב{d}', b: 'הרחוב שבו כל המקומיים נפגשים בסופי שבוע: ברים קטנים, מוזיקה מהחלונות ואוכל עד מאוחר.', cat: 'חיי לילה', dur: 'ערב שלם', cost: '₪₪', time: '22:00' },
      { t: 'ג׳אז בסמטה ב{d}', b: 'מועדון קטן עם הופעה כל ערב. שולחן ליד הבמה — להגיע חצי שעה לפני.', cat: 'חיי לילה', dur: 'שעתיים', cost: '₪₪', time: '21:00' },
    ],
    shop: [
      { t: 'שוק הפשפשים של {d}', b: 'וינטג׳, מפות ישנות וחפצים שאין להם שם. פעם-פעמיים בשבוע, לבדוק את היום מראש.', cat: 'קניות', dur: 'שעתיים', cost: '₪', time: '10:00' },
      { t: 'רחוב הבוטיקים ב{d}', b: 'מעצבים מקומיים, חנויות קונספט ובית קפה טוב באמצע.', cat: 'קניות', dur: 'שעתיים', cost: '₪₪', time: '15:00' },
      { t: 'סדנת אומן מקומית ב{d}', b: 'קרמיקה, עור או זכוכית — תלוי באזור. מזכרת שעושים בעצמכם.', cat: 'קניות', dur: 'שעתיים', cost: '₪₪', time: '11:30' },
    ],
    kids: [
      { t: 'האקווריום של {d}', b: 'שעתיים שהילדים לא ירצו לצאת מהן. מזג אוויר לא משנה.', cat: 'אטרקציה', dur: 'שעתיים', cost: '₪₪', time: '10:00' },
      { t: 'פארק הקרוסלות של {d}', b: 'פארק שעשועים קטן ומקומי, בלי תורים של שעה. הכי כיף אחר הצהריים.', cat: 'אטרקציה', dur: 'שלוש שעות', cost: '₪₪', time: '15:00' },
      { t: 'סדנת גלידה ב{d}', b: 'מכינים, טועמים, ולוקחים הביתה. שעה של שקט להורים.', cat: 'אוכל', dur: 'שעה', cost: '₪', time: '13:00' },
    ],
  };

  const TOP = [{ pool: 'culture', i: 1 }, { pool: 'food', i: 1 }, { pool: 'nature', i: 0 }];
  const DAY = [
    { pool: 'culture', i: 1, time: '09:30' }, { pool: 'food', i: 1, time: '12:30' },
    { pool: 'nature', i: 1, time: '16:00' }, { pool: 'food', i: 2, time: '20:00' },
  ];

  const TOPICS = [
    { key: 'day', re: /יום שלם|תכנן|מסלול|יום אחד|תוכנית|לו"ז|לוז/ },
    { key: 'kids', re: /ילד|משפח|תינוק/ },
    { key: 'tips', re: /טיפ|כדאי לדעת|מקומי|כסף|מטבע|תחבורה|בטיח|טעויות/ },
    { key: 'food', re: /אוכל|מסעד|לאכול|קפה|שוק|אוכלים|טעים|ארוחה|צמחוני|כשר/ },
    { key: 'beach', re: /\bים\b|חוף|לשחות|שחייה|שנורקל|בריכ/ },
    { key: 'nature', re: /טבע|נוף|הליכה|טרק|פארק|\bהר\b|הרים|מפל|יער/ },
    { key: 'night', re: /לילה|\bבר\b|ברים|מסיב|בילוי|בערב|ג'אז|ג׳אז/ },
    { key: 'shop', re: /קניות|שופינג|חנויות|מזכר|בוטיק/ },
    { key: 'culture', re: /מוזיאון|תרבות|היסטור|אמנות|כנסי|מקדש|ארכיטקט|לראות|אטרקצי|חובה/ },
  ];

  const REPLY = {
    top: 'הנה שלוש נקודות פתיחה טובות ב{d} — אחת להבין את המקום, אחת לאכול, ואחת לנשום:',
    food: 'ב{d} אוכלים הכי טוב איפה שהמקומיים אוכלים: שווקים בבוקר, סמטאות בערב. שלוש תחנות שאני הייתי מתחיל מהן:',
    nature: 'סביב {d} יש יותר ירוק ממה שנדמה מהמרכז. שלושה מקומות לצאת אליהם, מהקל לקצת יותר מאתגר:',
    beach: 'הים ליד {d} הוא לא רק החוף המרכזי. הנה שלוש אופציות, כולל אחת לשעות הערב:',
    culture: 'כדי להבין את {d} כדאי להתחיל מהסיפור שלה. שלושה מקומות שעושים את זה טוב:',
    night: 'הלילה ב{d} מתחיל מאוחר ונגמר מאוחר יותר. שלושה מקומות לפי מצב הרוח:',
    shop: 'קניות ב{d} זה בעיקר דברים שאין בבית. שלושה מקומות שלא מוכרים מגנטים:',
    kids: 'עם ילדים ב{d} הסוד הוא לסירוגין: משהו פעיל, משהו רגוע, ומשהו מתוק. שלוש אופציות:',
    day: 'הנה יום שלם ב{d}, מבוקר עד ערב: מתחילים ברובע העתיק כשעוד קריר, שוק לצהריים, אחר-צהריים ירוק, וארוחת ערב מקומית. אפשר להוסיף כל תחנה בנפרד — או את כל היום בלחיצה אחת.',
  };

  const tipsHtml = (d) => `כמה דברים שכדאי לדעת לפני ${esc(d)}:<ul>
    <li>מזומן קטן תמיד עוזר בשווקים ובדוכנים — כרטיס מתקבל כמעט בכל מקום אחר.</li>
    <li>כרטיס תחבורה יומי משתלם כבר מהנסיעה השלישית, ומונע התעסקות עם כרטיסים בודדים.</li>
    <li>בשעות הצהריים החמות המקומיים בפנים — זה הזמן למוזיאון או לארוחה ארוכה, לא להליכה.</li>
    <li>למקומות המבוקשים באמת (מוזיאון ראשי, תצפית, הופעה) מזמינים כרטיס מראש. השאר — פשוט מגיעים.</li>
  </ul>שאלו אותי על משהו ספציפי ואביא המלצות שאפשר להכניס לטיול.`;

  const WELCOME = (d) => `היי! אני מכיר את ${esc(d)} די טוב 😊 שאלו אותי על מקומות, אוכל, טבע, ערב בחוץ או תכנון של יום שלם — וכל המלצה שתאהבו נכנסת לטיול בלחיצה על ➕.`;

  const QUICK = (d) => [
    `מה חובה לראות ב${d}?`, 'איפה אוכלים טוב?', 'תכננו לי יום שלם', 'טבע ונופים באזור', 'מה עושים בערב?', 'טיפים למקומיים',
  ];

  const fill = (s, d) => s.replace(/\{d\}/g, d);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function pickDest(q, ctx, turn) {
    const dests = ctx.dests.filter(Boolean);
    if (!dests.length) return ctx.trip.destination || 'האזור';
    const named = dests.find((d) => q.includes(d));
    return named || dests[turn % dests.length];
  }

  function photosFor(d, n, ctx) {
    const pool = [];
    const push = (u) => { if (u && !pool.includes(u)) pool.push(u); };
    push(DEST_PHOTOS[d] && IMG(DEST_PHOTOS[d]));
    push(DEST_PHOTOS[ctx.trip.country] && IMG(DEST_PHOTOS[ctx.trip.country]));
    push(ctx.trip.cover_image);
    GENERIC.forEach((id) => push(IMG(id)));
    const k = 1 + (n % 3);
    return Array.from({ length: Math.min(k, pool.length) }, (_, i) => pool[(n + i) % pool.length]);
  }

  function card(tpl, d, time, n, ctx) {
    return {
      title: fill(tpl.t, d), blurb: fill(tpl.b, d), cat: tpl.cat, dur: tpl.dur, cost: tpl.cost,
      time: time || tpl.time || null, area: d, photos: photosFor(d, n, ctx), added: null,
    };
  }

  // the one function a real endpoint replaces: question in, {text|html, cards, kind} out
  async function ask(question, ctx, turn) {
    const q = question.trim();
    const d = pickDest(q, ctx, turn);
    const topic = (TOPICS.find((t) => t.re.test(q)) || { key: 'top' }).key;
    await delay(700 + Math.random() * 800);
    if (topic === 'tips') return { kind: 'tips', html: tipsHtml(d), cards: [] };
    const picks = topic === 'day' ? DAY : (POOL[topic] ? POOL[topic].map((_, i) => ({ pool: topic, i })) : TOP);
    return {
      kind: topic,
      text: fill(REPLY[topic] || REPLY.top, d),
      cards: picks.map((p, n) => card(POOL[p.pool][p.i], d, p.time, n + turn, ctx)),
    };
  }

  // =================================================================
  //  THREAD (persists per trip, in this browser)
  // =================================================================

  const threadKey = (ctx) => `tripmaker_recs_${ctx.trip.share_code}`;
  function loadThread(ctx) {
    try { return JSON.parse(localStorage.getItem(threadKey(ctx)) || '[]'); } catch { return []; }
  }
  function saveThread(ctx, msgs) {
    try { localStorage.setItem(threadKey(ctx), JSON.stringify(msgs.slice(-40))); } catch { /* full or private — the chat still works */ }
  }

  // =================================================================
  //  RENDER
  // =================================================================

  function cardHtml(c, i, j) {
    const em = CAT_EMOJI[c.cat] || '📍';
    return `
      <article class="rec-card" data-i="${i}" data-j="${j}">
        <div class="rec-media" data-emoji="${em}" title="${c.photos.length > 1 ? 'לחיצה לתמונה הבאה' : ''}">
          <img src="${esc(c.photos[0])}" alt="" loading="lazy" onerror="this.style.opacity=0">
          ${c.photos.length > 1 ? `<span class="rec-dots">${c.photos.map((_, k) => `<i${k === 0 ? ' class="on"' : ''}></i>`).join('')}</span>` : ''}
          <span class="rec-cat">${em} ${esc(c.cat)}</span>
        </div>
        <div class="rec-body">
          <h4 class="rec-title">${esc(c.title)}</h4>
          <p class="rec-blurb">${esc(c.blurb)}</p>
          <div class="rec-meta">
            ${c.time ? `<span>🕘 ${esc(c.time)}</span>` : ''}
            <span>⏱ ${esc(c.dur)}</span><span>💸 ${esc(c.cost)}</span><span>📍 ${esc(c.area)}</span>
          </div>
        </div>
        <div class="rec-actions">
          <a class="rec-map" href="${TRIPMAKER.mapsSearchUrl(`${c.title} ${c.area}`)}" target="_blank" rel="noopener">${ICON.map} מפה</a>
          ${c.added
            ? `<span class="rec-added">✓ נוסף ליום ${c.added}</span>`
            : `<button type="button" class="rec-add">${ICON.plus} הוספה לטיול</button>`}
        </div>
      </article>`;
  }

  function msgHtml(m, i) {
    if (m.role === 'user') return `<div class="chat-msg user"><div class="chat-bubble">${esc(m.text)}</div></div>`;
    const cards = m.cards || [];
    return `
      <div class="chat-msg ai" data-i="${i}">
        <span class="chat-avatar" aria-hidden="true">✨</span>
        <div class="chat-col">
          <div class="chat-bubble">${m.html || esc(m.text || '')}</div>
          ${cards.length ? `<div class="rec-strip">${cards.map((c, j) => cardHtml(c, i, j)).join('')}</div>` : ''}
          ${m.kind === 'day' && cards.some((c) => !c.added)
            ? `<button type="button" class="rec-add-all" data-i="${i}">${ICON.plus} הוספת כל היום לתאריך אחד</button>` : ''}
        </div>
      </div>`;
  }

  function render(slots, ctx) {
    const { page, body, foot } = slots;
    page.classList.add('page-chat');
    const mainDest = ctx.dests[0] || ctx.trip.destination || 'האזור';
    let msgs = loadThread(ctx);
    let turn = msgs.filter((m) => m.role === 'user').length;
    let busy = false;

    body.innerHTML = '<div class="chat-thread" id="chat-thread"></div>';
    foot.innerHTML = `
      <div class="chat-chips" id="chat-chips">${QUICK(mainDest).map((q) =>
        `<button type="button" class="chat-chip">${esc(q)}</button>`).join('')}</div>
      <form class="chat-form" id="chat-form">
        <input type="text" id="chat-input" maxlength="300" placeholder="שאלו על ${esc(mainDest)}…" autocomplete="off" enterkeyhint="send">
        <button type="submit" class="chat-send" aria-label="שליחה">${ICON.send}</button>
      </form>`;
    const thread = body.querySelector('#chat-thread');
    const input = foot.querySelector('#chat-input');

    const scrollDown = () => { body.scrollTop = body.scrollHeight; };

    function paint() {
      thread.innerHTML = msgHtml({ role: 'ai', html: WELCOME(mainDest) }, -1) + msgs.map(msgHtml).join('');
      if (busy) thread.insertAdjacentHTML('beforeend', `
        <div class="chat-msg ai"><span class="chat-avatar" aria-hidden="true">✨</span>
          <div class="chat-bubble chat-typing" aria-label="חושב…"><i></i><i></i><i></i></div></div>`);
      scrollDown();
    }

    // one delegated handler for everything inside the thread
    thread.addEventListener('click', (e) => {
      const media = e.target.closest('.rec-media');
      if (media) { cyclePhoto(media); return; }
      const add = e.target.closest('.rec-add');
      if (add) {
        const el = add.closest('.rec-card');
        const m = msgs[+el.dataset.i];
        const c = m && m.cards[+el.dataset.j];
        if (c) addRecs(ctx, [c], (day) => { c.added = day; saveThread(ctx, msgs); paint(); });
        return;
      }
      const all = e.target.closest('.rec-add-all');
      if (all) {
        const m = msgs[+all.dataset.i];
        const cards = m ? m.cards.filter((c) => !c.added) : [];
        if (cards.length) addRecs(ctx, cards, (day) => { cards.forEach((c) => { c.added = day; }); saveThread(ctx, msgs); paint(); });
      }
    });

    function cyclePhoto(media) {
      const el = media.closest('.rec-card');
      const c = msgs[+el.dataset.i]?.cards[+el.dataset.j];
      if (!c || c.photos.length < 2) return;
      const dots = [...media.querySelectorAll('.rec-dots i')];
      const cur = dots.findIndex((d) => d.classList.contains('on'));
      const next = (cur + 1) % c.photos.length;
      const img = media.querySelector('img');
      img.style.opacity = '';
      img.src = c.photos[next];
      dots.forEach((d, k) => d.classList.toggle('on', k === next));
    }

    async function send(text) {
      const q = text.trim();
      if (!q || busy) return;
      msgs.push({ role: 'user', text: q });
      turn++;
      busy = true;
      input.value = '';
      paint();
      try {
        const reply = await ask(q, ctx, turn);
        msgs.push({ role: 'ai', ...reply });
      } catch {
        msgs.push({ role: 'ai', text: 'משהו השתבש בדרך — נסו לשאול שוב בעוד רגע.' });
      }
      busy = false;
      saveThread(ctx, msgs);
      paint();
      TRIPMAKER.track?.('recs_ask', { code: ctx.trip.share_code });
    }

    foot.querySelector('#chat-form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
    foot.querySelectorAll('.chat-chip').forEach((b) => { b.onclick = () => send(b.textContent); });

    paint();
  }

  // =================================================================
  //  ADD TO TRIP — the "מתי?" day picker, or "תבחרו בשבילי"
  // =================================================================

  function addRecs(ctx, cards, onAdded) {
    if (!ctx.canEdit) {
      if (ctx.inviteToken) { ctx.requireSignup(); return; }
      TripPages.toast('רק משתתפי הטיול מוסיפים תחנות — שכפלו את הטיול כדי לערוך אותו');
      return;
    }
    openWhen(ctx, cards, async (day, why) => {
      try {
        for (const c of cards) {
          await ctx.addItem({
            day_number: day, title: c.title, category: c.cat, area: c.area, note: c.blurb,
            time_label: c.time || null, place_query: `${c.title}, ${c.area}`,
          });
        }
      } catch {
        TripPages.toast('ההוספה נכשלה — נסו שוב');
        return;
      }
      onAdded(day);
      TripPages.toast(`${cards.length > 1 ? 'נוספו' : 'נוסף'} ליום ${day}${why ? ' — ' + why : ''} ✓`, 'ok');
      TRIPMAKER.track?.('recs_add', { code: ctx.trip.share_code, count: cards.length, auto: !!why });
    });
  }

  const countLabel = (n) => n === 0 ? 'פנוי' : n === 1 ? 'תחנה אחת' : n === 2 ? 'שתי תחנות' : `${n} תחנות`;

  // the emptiest day in the card's area (or in the whole trip when no day is there yet)
  function pickDay(ctx, card, counts) {
    const days = Array.from({ length: ctx.trip.days }, (_, i) => i + 1);
    const inArea = days.filter((d) => ctx.defaultArea(d) === card.area);
    const pool = inArea.length ? inArea : days;
    let best = pool[0];
    for (const d of pool) if ((counts[d] || 0) < (counts[best] || 0)) best = d;
    return { day: best, why: inArea.length ? `היום הכי פנוי ב${card.area}` : 'היום הכי פנוי בטיול' };
  }

  function openWhen(ctx, cards, onPick) {
    const { trip } = ctx;
    const hasDates = !!trip.start_date;
    const counts = {};
    const byDay = {};
    for (const it of ctx.state.items) {
      counts[it.day_number] = (counts[it.day_number] || 0) + 1;
      (byDay[it.day_number] ||= []).push(it);
    }
    const areas = [...new Set(Array.from({ length: trip.days }, (_, i) => ctx.defaultArea(i + 1)).filter(Boolean))];
    const multi = areas.length > 1;
    const color = (a) => AREA_COLORS[areas.indexOf(a) % AREA_COLORS.length];

    const cells = [];
    for (let d = 1; d <= trip.days; d++) {
      const date = ctx.dayDate(d);
      const area = ctx.defaultArea(d);
      const n = counts[d] || 0;
      const styles = [];
      if (d === 1 && date) styles.push(`grid-column-start:${date.getDay() + 1}`);
      if (multi && area) styles.push(`--area-c:${color(area)}`);
      const dateLabel = !date ? '' : (d === 1 || date.getDate() === 1)
        ? date.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }) : date.getDate();
      cells.push(`
        <button type="button" class="cal-cell wc-day${n ? '' : ' free'}${multi && area ? ' has-area' : ''}"
          data-day="${d}" aria-label="יום ${d}${area ? ` · ${esc(area)}` : ''} · ${countLabel(n)}"
          ${styles.length ? ` style="${styles.join(';')}"` : ''}>
          <span class="cc-head"><span class="cc-num">${d}</span><span class="cc-date">${dateLabel}</span></span>
          ${multi && area ? `<span class="cc-area">${esc(area)}</span>` : ''}
          <span class="cc-dots" aria-hidden="true">${(byDay[d] || []).slice(0, 4).map((it) =>
            `<i${it.category === 'נסיעה' ? ' class="travel"' : ''}></i>`).join('')}${n > 4 ? '<em>+</em>' : ''}</span>
        </button>`);
    }

    const one = cards.length === 1;
    TripPages.sheet('when-sheet', {
      title: 'מתי להוסיף?',
      sub: one ? esc(cards[0].title) : `${cards.length} תחנות — כולן ליום אחד`,
      cls: 'when-card',
      html: `
        ${hasDates ? `<div class="cal-dow-row" aria-hidden="true">${DOW.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
        <div class="cal-grid wc-grid">${cells.join('')}</div>
        <div class="wc-why" aria-live="polite"></div>
        <div class="wc-foot">
          <button type="button" class="btn btn-amber wc-confirm" disabled>בחרו יום למעלה</button>
          <button type="button" class="btn btn-ghost wc-auto">✨ תבחרו בשבילי</button>
        </div>`,
      onOpen: (body) => {
        const confirm = body.querySelector('.wc-confirm');
        const why = body.querySelector('.wc-why');
        let picked = null;
        const select = (d, reason) => {
          picked = d;
          body.querySelectorAll('.wc-day').forEach((c) => c.classList.toggle('sel', +c.dataset.day === d));
          confirm.disabled = false;
          confirm.textContent = `${one ? 'הוספה' : 'הוספת הכול'} ליום ${d}`;
          why.textContent = reason || '';
        };
        body.querySelectorAll('.wc-day').forEach((c) => { c.onclick = () => select(+c.dataset.day); });
        confirm.onclick = () => { if (picked) TripPages.closeSheet(() => onPick(picked)); };
        body.querySelector('.wc-auto').onclick = () => {
          const { day, why: reason } = pickDay(ctx, cards[0], counts);
          select(day, reason);
          body.querySelector(`.wc-day[data-day="${day}"]`)?.scrollIntoView({ block: 'nearest' });
          // a beat to see the choice land, then it goes in
          setTimeout(() => TripPages.closeSheet(() => onPick(day, reason)), 520);
        };
      },
    });
  }

  return { render, ask };
})();
