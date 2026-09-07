// המלצות — a chat with the AI about the area, answered with recommendation cards that
// drop straight into the itinerary.
//
// ask() is one call to POST /api/trips/code/:code/recs: the server runs the model,
// verifies every place it names (an unverified one never reaches this file) and finds
// a photo where Wikipedia has one. This side keeps the thread per trip, renders the
// cards, and turns ➕ into the page's own addItem — with the verified coordinates and
// place_id riding along, so the stop pins without a second geocode. "תבחרו בשבילי"
// lands on the emptiest day in the card's area.
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
  //  ASK — the server answers; a place without a photo gets the destination's
  // =================================================================

  const WELCOME = (d) => `היי! אני מכיר את ${esc(d)} די טוב 😊 שאלו אותי על מקומות, אוכל, טבע, ערב בחוץ או תכנון של יום שלם — וכל המלצה שתאהבו נכנסת לטיול בלחיצה על ➕.`;

  const QUICK = (d) => [
    `מה חובה לראות ב${d}?`, 'איפה אוכלים טוב?', 'תכננו לי יום שלם', 'טבע ונופים באזור', 'מה עושים בערב?', 'טיפים למקומיים',
  ];

  function fallbackPhoto(area, ctx) {
    const id = DEST_PHOTOS[area] || DEST_PHOTOS[ctx.trip.country];
    return id ? IMG(id) : (ctx.trip.cover_image || IMG(GENERIC[0]));
  }

  async function ask(question, ctx, history) {
    const r = await TRIPMAKER.api(`/api/trips/code/${ctx.trip.share_code}/recs`, {
      method: 'POST',
      body: JSON.stringify({ message: question, history }),
    });
    const cards = (r.cards || []).map((c) => fromServerCard(c, ctx));
    return { kind: cards.length ? 'places' : 'text', text: r.text, cards, remaining: r.remaining };
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
          ${c.credit ? `<span class="rec-credit">${esc(c.credit)}</span>` : ''}
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
          <a class="rec-map" href="${TRIPMAKER.mapsSearchUrl(c.place_query || `${c.title} ${c.area}`, c.google_place_id)}" target="_blank" rel="noopener">${ICON.map} מפה</a>
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
          ${cards.filter((c) => !c.added).length >= 2
            ? `<button type="button" class="rec-add-all" data-i="${i}">${ICON.plus} הוספת כולם ליום אחד</button>` : ''}
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
      cyclePhotoOf(media, msgs[+el.dataset.i]?.cards[+el.dataset.j]);
    }

    async function send(text) {
      const q = text.trim();
      if (!q || busy) return;
      // the server meters questions per user, so a question needs a user
      if (!TRIPMAKER.user) {
        msgs.push({ role: 'user', text: q });
        msgs.push({ role: 'ai', html: `כדי לשאול צריך להיות מחוברים — זה לוקח רגע. <button type="button" class="chat-login">התחברות</button>` });
        paint();
        thread.querySelector('.chat-login:last-of-type')?.addEventListener('click', () => openAuthModal(() => location.reload(), 'login'));
        return;
      }
      // what the model sees of the conversation: the last turns, text only
      const history = msgs.filter((m) => m.text).slice(-8).map((m) => ({ role: m.role, text: m.text }));
      msgs.push({ role: 'user', text: q });
      turn++;
      busy = true;
      input.value = '';
      paint();
      try {
        const reply = await ask(q, ctx, history);
        msgs.push({ role: 'ai', ...reply });
      } catch (err) {
        msgs.push({ role: 'ai', text: (err && err.message) || 'משהו השתבש בדרך — נסו לשאול שוב בעוד רגע.' });
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

  // the card's photo carousel: one tap, next photo
  function cyclePhotoOf(media, c) {
    if (!c || c.photos.length < 2) return;
    const dots = [...media.querySelectorAll('.rec-dots i')];
    const cur = dots.findIndex((d) => d.classList.contains('on'));
    const next = (cur + 1) % c.photos.length;
    const img = media.querySelector('img');
    img.style.opacity = '';
    img.src = c.photos[next];
    dots.forEach((d, k) => d.classList.toggle('on', k === next));
  }

  // a server card → the shape the renderer and the day picker work with
  function fromServerCard(c, ctx) {
    return {
      title: c.title, blurb: c.blurb, cat: c.category, dur: c.duration, cost: c.cost,
      time: c.time || null, area: c.area, place_query: c.place_query || null,
      lat: c.lat ?? null, lon: c.lon ?? null, google_place_id: c.google_place_id || null,
      photos: c.photos && c.photos.length ? c.photos : [fallbackPhoto(c.area, ctx)],
      credit: c.photo_credit || null, added: c.added || null,
    };
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
            time_label: c.time || null, place_query: c.place_query || `${c.title}, ${c.area}`,
            lat: c.lat, lon: c.lon, google_place_id: c.google_place_id,
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

  // the planning chat (trip-plan.js) shows the same cards and adds them the same way
  return { render, ask, cardHtml, fromServerCard, cyclePhotoOf, addRecs, ICON };
})();
