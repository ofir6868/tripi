// המלצות — a chat with the AI about the area, answered with recommendation cards that
// drop straight into the itinerary. For an editor, an explicit "add / remove / move X",
// "we booked the Hilton" or a ticket handed over with the + comes back as a proposal
// card instead — the planning chat's card, stops and hotels/budget/dates alike, written
// on approval through /recs/apply, reversible through /recs/undo. The model tells a
// question from a request by the words; there is no switch to set.
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
    'בודפשט': 'photo-1541343672885-9be56236302a', 'וינה': 'photo-1516550893923-42d28e5677af', 'אוסטריה': 'photo-1516550893923-42d28e5677af',
    'בריסל': 'photo-1573299867162-6e895f64bf23', 'בלגיה': 'photo-1573299867162-6e895f64bf23', 'אתונה': 'photo-1555993539-1732b0258235',
    'סנטוריני': 'photo-1613395877344-13d4a8e0d49e', 'כרתים': 'photo-1533105079780-92b9be482077', 'רודוס': 'photo-1504512485720-7d83a16ee930',
    'קפריסין': 'photo-1601581875039-e899893d520c', 'טנריף': 'photo-1533130061792-64b345e4a833', 'מונטנגרו': 'photo-1614122027743-50a9e6e8002f',
    'אלבניה': 'photo-1483683804023-6ccdb62f86ef', 'דובאי': 'photo-1512453979798-5ea266f8880c',
    'איחוד האמירויות': 'photo-1512453979798-5ea266f8880c', 'גאורגיה': 'photo-1565008447742-97f6f38c985c',
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
    copy: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  // =================================================================
  //  ASK — the server answers; a place without a photo gets the destination's
  // =================================================================

  // The opening line names the preferences the trip carries, when it has any. Not
  // decoration: those chips now steer the prompt behind every answer here
  // (lib/trips.js tripPrefsBlock), and a traveller who ticked "חיי לילה" in the wizard
  // had no way to tell whether anyone had read it.
  const interestsOf = (ctx) => ((ctx.trip.plan_state && ctx.trip.plan_state.interests) || []).slice(0, 4);
  const WELCOME = (d, interests = []) => `היי! אני מכיר את ${esc(d)} די טוב 😊 ` +
    (interests.length
      ? `אני זוכר שאתם אחרי ${esc(interests.join(', '))} — אתאים לזה את ההמלצות. `
      : '') +
    'שאלו אותי על מקומות, אוכל, טבע, ערב בחוץ או תכנון של יום שלם — וכל המלצה שתאהבו נכנסת לטיול בלחיצה על ➕.';

  const QUICK = (d) => [
    `מה חובה לראות ב${d}?`, 'איפה אוכלים טוב?', 'תכננו לי יום שלם', 'טבע ונופים באזור', 'מה עושים בערב?', 'טיפים למקומיים',
  ];

  function fallbackPhoto(area, ctx) {
    const id = DEST_PHOTOS[area] || DEST_PHOTOS[ctx.trip.country];
    return id ? IMG(id) : (ctx.trip.cover_image || IMG(GENERIC[0]));
  }

  // an editor's explicit change request comes back as a proposal — stops (ops) and
  // hotels / budget / dates (actions) on the same card the planning chat uses, written
  // only on approval. `files`: documents read on the device (TripPlan.attachments).
  async function ask(question, ctx, history, files = []) {
    const r = await TRIPMAKER.api(`/api/trips/code/${ctx.trip.share_code}/recs`, {
      method: 'POST',
      body: JSON.stringify({ message: question, history, attachments: files }),
    });
    const cards = (r.cards || []).map((c) => fromServerCard(c, ctx));
    const out = { kind: cards.length ? 'places' : 'text', text: r.text, cards, remaining: r.remaining, files: r.files, payload: {} };
    if ((Array.isArray(r.ops) && r.ops.length) || (Array.isArray(r.actions) && r.actions.length)) {
      out.payload = { ops: r.ops || [], actions: r.actions || [], changes: r.changes || [], decision: 'pending', undo: null, undoActions: null };
    }
    return out;
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

  // a message handed over from outside the chat — the trip page's bottom ask bar
  // types it and the chat sends it as its own first turn, so the traveller lands on a
  // conversation already under way. Held until the chat has painted (and, on a
  // re-open, sent by the fresh paint), so the order of open() and say() doesn't matter.
  let queued = null;
  let flush = null; // the painted chat's "send whatever is queued"
  function say(text) {
    queued = String(text || '').trim() || null;
    flush?.();
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

  // The card that stands between a gallery visitor and this chat. The recommendations
  // are only worth anything if they have somewhere to go, and on someone else's trip
  // they don't — so instead of letting the visitor ask three questions and then meet a
  // toast telling them they may not keep any of the answers, the way in is the first
  // thing under the AI's opening line. The opening line still comes first, signed in or
  // not: it is what makes anyone want the trip in the first place.
  function unlockCardHtml(ctx) {
    const draft = !!ctx.trip.is_draft;   // still being planned — there is nothing to copy yet
    const join = !!ctx.inviteToken;      // invited to co-plan: joining beats copying
    const head = join ? 'הוזמנתם לתכנן את הטיול הזה' : draft ? 'הטיול עוד בתכנון' : 'הטיול הזה עדיין לא שלכם';
    const text = draft
      ? 'מי שבונה אותו עוד לא סיים, ולכן אי אפשר להעתיק אותו לעצמכם כרגע. כשהטיול יהיה מוכן — השיחה כאן נפתחת.'
      : join
        ? 'רגע של הרשמה ואתם משתתפים מלאים: אפשר לשאול כאן כל דבר, וכל המלצה נכנסת למסלול בלחיצה.'
        : 'אפשר לקרוא אותו כמה שרוצים — אבל כדי לשאול כאן ולהכניס המלצות למסלול צריך עותק משלכם. לחיצה אחת, והשיחה ממשיכה מכאן בדיוק, באותו מסך.';
    const foot = draft ? '' : join
      ? '<div class="pc-foot"><button type="button" class="btn btn-amber pc-unlock-join">הרשמה והצטרפות</button></div>'
      : `<div class="pc-foot"><button type="button" class="btn btn-amber pc-unlock-cta">${ICON.copy} העתקת הטיול אליי</button></div>`;
    return `
      <div class="chat-msg ai" id="recs-unlock">
        <span class="chat-avatar" aria-hidden="true">🧳</span>
        <div class="chat-col">
          <div class="plan-card pc-unlock">
            <div class="pc-head">${esc(head)}</div>
            <p class="pc-text-p">${esc(text)}</p>
            ${foot}
            ${draft || join ? '' : '<div class="pc-note">חינם · נשמר ב"הטיולים שלי" · התחנות, המלונות והתאריכים עוברים איתו</div>'}
          </div>
        </div>
      </div>`;
  }

  function msgHtml(m, i, latestApplied) {
    if (m.role === 'user') return `<div class="chat-msg user"><div class="chat-bubble">${esc(m.text)}</div>${TripPlan.sentFilesHtml(m.files)}</div>`;
    if (m.quota) return TripPlan.quotaMsgHtml(m, TripPlan.referral(), '✨'); // the day's allowance is spent — the gentle card
    const cards = m.cards || [];
    return `
      <div class="chat-msg ai" data-i="${i}">
        <span class="chat-avatar" aria-hidden="true">✨</span>
        <div class="chat-col">
          <div class="chat-bubble">${m.html || esc(m.text || '')}</div>
          ${cards.length ? `<div class="rec-strip">${cards.map((c, j) => cardHtml(c, i, j)).join('')}</div>` : ''}
          ${cards.filter((c) => !c.added).length >= 2
            ? `<button type="button" class="rec-add-all" data-i="${i}">${ICON.plus} הוספת כולם ליום אחד</button>` : ''}
          ${m.payload && m.payload.changes ? TripPlan.changeCardHtml(m, latestApplied) : ''}
        </div>
      </div>`;
  }

  function render(slots, ctx) {
    const { page, body, foot } = slots;
    page.classList.add('page-chat');
    flush = null; // a chat painted earlier is gone — nothing handed over reaches it
    const mainDest = ctx.dests[0] || ctx.trip.destination || 'האזור';
    let msgs = loadThread(ctx);
    // proposal cards need a stable id to answer to — local, monotonic, survives a reload
    let nextId = msgs.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
    msgs.forEach((m) => { if (!m.id) m.id = nextId++; });
    let turn = msgs.filter((m) => m.role === 'user').length;
    let busy = false;
    let busySince = 0;
    // a question typed while the last one is being answered waits on screen and goes out
    // when the answer lands (the same rule as the planning chat — a send is never dead)
    let nextQ = null;
    // a visitor reading someone else's trip: the composer is shut and the way to open
    // it is the card at the top of the thread. It stays on screen the whole time rather
    // than being hidden, so the moment the copy lands there is nothing to go looking for
    let locked = !ctx.canEdit;

    body.innerHTML = '<div class="chat-thread" id="chat-thread"></div>';
    const thread = body.querySelector('#chat-thread');
    let input = null;
    let attach = null; // the + beside the composer (editors only)

    function paintFoot() {
      foot.innerHTML = locked ? `
        <form class="chat-form chat-locked" id="chat-form">
          <input type="text" id="chat-input" placeholder="העתיקו את הטיול כדי לשוחח עם ה-AI" disabled>
          <button type="submit" class="chat-send" aria-label="שליחה" disabled>${ICON.send}</button>
        </form>` : `
        <div class="chat-chips" id="chat-chips">${QUICK(mainDest).map((q) =>
          `<button type="button" class="chat-chip">${esc(q)}</button>`).join('')}</div>
        <form class="chat-form" id="chat-form">
          <input type="text" id="chat-input" maxlength="300" placeholder="${ctx.canEdit ? 'שאלו, או בקשו שינוי בטיול…' : `שאלו על ${esc(mainDest)}…`}" autocomplete="off" enterkeyhint="send">
          <button type="submit" class="chat-send" aria-label="שליחה">${ICON.send}</button>
        </form>`;
      input = foot.querySelector('#chat-input');
      foot.querySelector('#chat-form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
      foot.querySelectorAll('.chat-chip').forEach((b) => { b.onclick = () => send(b.textContent); });
      // a ticket or a booking handed to the chat — read on the device, sent as text —
      // for someone whose trip it can land on
      attach = ctx.canEdit ? TripPlan.attachments(foot.querySelector('#chat-form'), {
        onChange: () => {
          input.placeholder = attach.count() ? 'מה לעשות עם זה? (אפשר גם לשלוח ככה)' : 'שאלו, או בקשו שינוי בטיול…';
          if (!attach.reading() && nextQ) { const q = nextQ; nextQ = null; send(q); }
        },
      }) : null;
    }

    let painted = 0;
    const scroller = TripPlan.arrival(body, thread);
    const latestApplied = () => {
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].payload && msgs[i].payload.decision === 'applied') return msgs[i].id;
      return null;
    };

    function paint() {
      const la = latestApplied();
      thread.innerHTML = msgHtml({ role: 'ai', html: WELCOME(mainDest, interestsOf(ctx)) }, -1)
        + (locked ? unlockCardHtml(ctx) : '')
        + msgs.map((m, i) => msgHtml(m, i, la)).join('');
      if (busy && !busySince) busySince = Date.now();
      if (!busy) busySince = 0;
      if (busy) thread.insertAdjacentHTML('beforeend', `
        <div class="chat-msg ai chat-in chat-wait"><span class="chat-avatar" aria-hidden="true">✨</span>
          <div class="chat-col"><div class="chat-bubble chat-typing" aria-label="חושב…"><i></i><i></i><i></i></div>
          ${TripPlan.waitNoteHtml(busySince)}</div></div>`);
      if (nextQ) thread.insertAdjacentHTML('beforeend', `
        <div class="chat-msg user chat-in chat-pending"><div class="chat-bubble">${esc(nextQ)}</div>
          <small class="chat-pending-note">יישלח ברגע שאסיים לענות</small></div>`);
      foot.querySelector('.chat-send')?.classList.toggle('is-busy', busy);
      painted = scroller.settle(msgs, painted, true);
    }

    // the proposal card's buttons: the ops (or the recorded inverse) go to the server,
    // and the decision is written into the thread in the traveller's words, so the next
    // question's history carries it
    async function decide(id, decision, btn) {
      const m = msgs.find((x) => x.id === id);
      if (!m || !m.payload || busy) return;
      btn.disabled = true;
      const base = `/api/trips/code/${ctx.trip.share_code}/recs`;
      const titles = (m.payload.changes || []).map((c) => c.title).join(', ');
      const was = m.payload.decision;
      if (decision !== 'undo') { m.payload.decision = 'deciding'; m.payload.deciding = decision; paint(); }
      try {
        if (decision === 'accept') {
          const r = await TRIPMAKER.api(`${base}/apply`, { method: 'POST', body: JSON.stringify({ ops: m.payload.ops || [], actions: m.payload.actions || [] }) });
          const a = r.applied || {};
          const changed = (a.added + a.updated + a.removed + (a.actions || 0)) > 0;
          m.payload.decision = changed ? 'applied' : 'rejected';
          m.payload.undo = changed ? r.undo : null;
          m.payload.undoActions = changed ? r.undo_actions : null;
          if (r.items) ctx.replaceItems(r.items);
          if (r.side) ctx.applySide?.(r.side);
          msgs.push({ id: nextId++, role: 'user', text: `✓ אישרתי את השינויים${titles ? ': ' + titles : ''}` });
          TripPages.toast('הטיול עודכן ✓', 'ok');
        } else if (decision === 'reject') {
          m.payload.decision = 'rejected';
          msgs.push({ id: nextId++, role: 'user', text: `לא עכשיו — בלי ${titles || 'ההצעה הזו'}` });
        } else {
          const r = await TRIPMAKER.api(`${base}/undo`, { method: 'POST', body: JSON.stringify({ undo: m.payload.undo, undo_actions: m.payload.undoActions }) });
          m.payload.decision = 'undone';
          m.payload.undo = null;
          m.payload.undoActions = null;
          if (r.items) ctx.replaceItems(r.items);
          if (r.side) ctx.applySide?.(r.side);
          TripPages.toast('השינוי בוטל');
        }
        TRIPMAKER.track?.('recs_decide', { code: ctx.trip.share_code, decision });
      } catch (err) {
        m.payload.decision = was;
        paint();
        TripPages.toast((err && err.message) || 'לא הצלחתי — נסו שוב');
        return;
      }
      saveThread(ctx, msgs);
      paint();
    }

    // The copy, taken without leaving this screen: the wait happens inside the card,
    // the ✓ lands in it, and only then does it go and the composer open. Nothing here is
    // allowed to look like a new page — the whole point is that the conversation the
    // visitor started is the conversation they keep.
    let unlocking = false;
    async function unlockFlow(btn) {
      if (unlocking) return; // one copy per visitor, however many times the card is tapped
      unlocking = true;
      const card = btn.closest('.pc-unlock');
      const msg = card.closest('.chat-msg');
      const cardFoot = card.querySelector('.pc-foot');
      const back = cardFoot.innerHTML;
      cardFoot.className = 'pc-foot pc-busy';
      cardFoot.innerHTML = '<span class="chat-typing" aria-hidden="true"><i></i><i></i><i></i></span>מעתיקים את הטיול אליכם…';
      try {
        await ctx.cloneInPlace();
      } catch (err) {
        unlocking = false;
        cardFoot.className = 'pc-foot';
        cardFoot.innerHTML = back;
        TripPages.toast((err && err.message) || 'ההעתקה נכשלה — נסו שוב');
        return;
      }
      card.classList.add('pc-done');
      cardFoot.className = 'pc-foot pc-ok';
      cardFoot.innerHTML = `${ICON.check} הטיול שלכם — אפשר להמשיך`;
      TRIPMAKER.track?.('recs_unlocked', { code: ctx.trip.share_code });
      setTimeout(() => {
        msg.classList.add('chat-gone');
        setTimeout(() => {
          locked = false;
          // the copy is theirs to change: ask for a change and it comes back as a proposal
          paint();
          paintFoot();
          input.focus();
        }, 320);
      }, 950);
    }

    // one delegated handler for everything inside the thread
    thread.addEventListener('click', (e) => {
      if (TripPlan.handleCardClick(e, ctx)) return;
      const unlockBtn = e.target.closest('.pc-unlock-cta');
      if (unlockBtn) {
        // the copy needs an account to land in — register first, and it runs on from
        // there without the visitor having to find this card again
        if (!TRIPMAKER.user) { openAuthModal(() => unlockFlow(unlockBtn), 'register', 'recs_unlock'); return; }
        unlockFlow(unlockBtn);
        return;
      }
      if (e.target.closest('.pc-unlock-join')) { ctx.requireSignup(); return; }
      const accept = e.target.closest('.pc-accept');
      if (accept) { decide(+accept.dataset.id, 'accept', accept); return; }
      const reject = e.target.closest('.pc-reject');
      if (reject) { decide(+reject.dataset.id, 'reject', reject); return; }
      const undo = e.target.closest('.pc-undo');
      if (undo) { decide(+undo.dataset.id, 'undo', undo); return; }
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
      let q = text.trim();
      if (locked) return;
      const files = attach ? attach.list() : [];
      if (!q && !files.length) {
        if (attach && attach.reading()) TripPages.toast('רגע — עוד קוראים את הקובץ במכשיר');
        return;
      }
      if (attach && attach.reading()) {
        TripPages.toast('רגע — עוד קוראים את הקובץ, ואז אשלח');
        nextQ = nextQ || q || ' ';
        return;
      }
      if (busy) {
        nextQ = nextQ ? `${nextQ}\n${q}` : (q || ' ');
        input.value = '';
        paint();
        return;
      }
      if (!q) q = files.length === 1 ? `צירפתי קובץ: ${files[0].name}` : `צירפתי ${files.length} קבצים`;
      // the server meters questions per user, so a question needs a user
      if (!TRIPMAKER.user) {
        msgs.push({ role: 'user', text: q });
        msgs.push({ role: 'ai', html: `כדי לשאול צריך להיות מחוברים — זה לוקח רגע. <button type="button" class="chat-login">התחברות</button>` });
        paint();
        thread.querySelector('.chat-login:last-of-type')?.addEventListener('click', () => openAuthModal(() => location.reload(), 'login', 'recs_chat'));
        return;
      }
      // what the model sees of the conversation: the last turns, text only
      const history = msgs.filter((m) => m.text).slice(-8).map((m) => ({ role: m.role, text: m.text }));
      const mine = { id: nextId++, role: 'user', text: q, files: files.length ? files.map((f) => ({ name: f.name, kind: f.kind })) : undefined };
      msgs.push(mine);
      turn++;
      busy = true;
      input.value = '';
      paint();
      try {
        const reply = await ask(text.trim(), ctx, history, files);
        if (attach) attach.clear();
        if (reply.files) mine.files = reply.files; // how each one was read, for the bubble
        delete reply.files;
        msgs.push({ id: nextId++, role: 'ai', ...reply });
      } catch (err) {
        if (err && err.quota) {
          busy = false;
          if (nextQ) { input.value = nextQ; nextQ = null; }
          msgs.push(TripPlan.quotaMsg(err.quota));
          paint();
          TripPlan.loadReferral().then(paint); // the referral numbers fill the card as they arrive
          return; // never stored: tomorrow it isn't true anymore
        }
        msgs.push({ role: 'ai', text: (err && err.message) || 'משהו השתבש בדרך — נסו לשאול שוב בעוד רגע.' });
      }
      busy = false;
      saveThread(ctx, msgs);
      paint();
      TRIPMAKER.track?.('recs_ask', { code: ctx.trip.share_code });
      if (nextQ) { const q2 = nextQ; nextQ = null; send(q2); }
    }

    paintFoot();
    paint();
    TripPlan.startWaitTicker(thread);
    flush = () => {
      if (!queued) return;
      const q = queued;
      queued = null;
      send(q);
    };
    flush();
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
      osm_type: c.osm_type || null, osm_id: c.osm_id || null,
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
            osm_type: c.osm_type || null, osm_id: c.osm_id || null,
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
  return { render, ask, cardHtml, fromServerCard, cyclePhotoOf, addRecs, say, ICON };
})();
