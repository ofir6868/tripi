// תכנון — the planning chat of a draft trip, the tab that becomes המלצות once the trip
// is saved.
//
// The conversation and the trip's planning memory live on the server (routes/plan.js);
// this side paints the thread, sends turns, and shows what each turn did to the
// itinerary as a change card. The card is the same in both modes — in manual mode it
// waits for אישור, in automatic mode it is already done and offers ביטול — so switching
// modes never changes what the traveller looks at, only who taps first. Every itinerary
// change comes back as the full item list and goes through the page's own replaceItems,
// so the trip behind the chat is always the one the AI just wrote.
const TripPlan = (() => {
  const esc = (s) => TRIPMAKER.esc(s);
  const ICON = {
    send: TripRecs.ICON.send,
    check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    undo: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>',
    auto: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h6l-1 8 8-12h-6z"/></svg>',
    hand: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3 15.2a2 2 0 0 1 3-2.6L8 15"/></svg>',
  };
  const KIND = { add: { em: '➕', label: 'הוספה' }, update: { em: '✏️', label: 'שינוי' }, delete: { em: '🗑️', label: 'הסרה' } };
  const FILL_CHIP = '✨ להשלים את שאר הימים אוטומטית';
  const QUIPS = [
    'מדפדף במדריכי טיולים…', 'בוחר את המסעדות הכי שוות…', 'מסדר את הימים בסדר הגיוני…',
    'מוסיף נקודות תצפית…', 'מצייר את המסלול על המפה…', 'שוקל בין שוק למוזיאון…', 'עוד רגע קטן — מלטש פרטים…',
  ];

  const api = (ctx, path, opts) => TRIPMAKER.api(`/api/trips/code/${ctx.trip.share_code}/plan${path}`, opts);
  const WA = (text) => window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  const AREA_COLORS = ['#ffb45f', '#8fd8c4', '#c9a7ff', '#7fb8ff', '#ff9db1', '#ffd166'];

  // =================================================================
  //  CARDS SHARED WITH המלצות: the day's quota is spent, and "bring your friends"
  // =================================================================
  //
  // A quota is not an error, so it never reads as one: the AI says it ran out for
  // today, that the trip is fine — planning goes on by hand and it is back tomorrow —
  // and, only then, that sharing the app with three friends doubles the daily
  // allowance for good. The progress ("2 מתוך 3 נרשמו") comes from /api/me/referral.

  const QUOTA_LINES = {
    plan: 'ניצלנו להיום את מכסת הודעות התכנון שלי 🙏',
    recs: 'ניצלנו להיום את מכסת השאלות שלי 🙏',
    build: 'ניצלנו להיום את מכסת הבניות של ה-AI 🙏',
    edit: 'ניצלנו להיום את מכסת השינויים החכמים 🙏',
  };
  const quotaMsg = (kind) => ({ role: 'ai', quota: kind, payload: {}, transient: true });

  function quotaMsgHtml(m, referral, avatar = '🧭') {
    const bonus = referral && referral.bonus;
    const r = referral || {};
    const progress = referral && !bonus
      ? `<div class="qc-progress"><i style="--w:${Math.min(100, Math.round(100 * (r.referred || 0) / (r.needed || 3)))}%"></i></div>
         <small class="qc-count">${r.referred ? `נרשמו עד עכשיו ${r.referred} מתוך ${r.needed}` : `עדיין לא נרשם אף אחד — ${r.needed} חברים והמכסה מוכפלת`}</small>`
      : '';
    return `
      <div class="chat-msg ai">
        <span class="chat-avatar" aria-hidden="true">${avatar}</span>
        <div class="chat-col">
          <div class="chat-bubble">${esc(QUOTA_LINES[m.quota] || QUOTA_LINES.plan)} זה בסדר גמור — הטיול לא הולך לשום מקום: אפשר להמשיך לתכנן ידנית בדף הטיול, ואני חוזר מחר עם מכסה חדשה.${
            bonus ? ' המכסה שלכם כבר כפולה 💛 — נתראה מחר.' : ' ואם מתחשק לכם: שתפו את TRIP MAKER עם שלושה חברים — כשהם נרשמים דרך הקישור שלכם, המכסה היומית שלכם מוכפלת, לתמיד.'}</div>
          <div class="plan-card pc-quota">
            ${progress}
            <div class="pc-foot">
              ${bonus ? '' : `<button type="button" class="btn btn-amber qc-wa" ${referral ? '' : 'disabled'}>${TRIPMAKER.waIcon || '📱'} שיתוף בוואטסאפ</button>`}
              <button type="button" class="btn btn-ghost qc-manual">להמשיך ידנית ›</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  const inviteLink = (trip) => `${location.origin}/trip/${trip.share_code}?join=${trip.invite_token}`;
  function inviteHtml(trip) {
    if (!trip.invite_token) return '';
    return `
      <div class="plan-card pc-invite">
        <div class="pc-head">נראה שהטיול מתגבש יפה 🎉</div>
        <p class="pc-text-p">רוצים להזמין חברים לתכנן איתכם? הם נכנסים בקישור, נרשמים בשנייה — ועורכים את הטיול יחד אתכם.</p>
        <div class="pc-foot">
          <button type="button" class="btn btn-amber ic-wa">${TRIPMAKER.waIcon || '📱'} הזמנה בוואטסאפ</button>
          <button type="button" class="btn btn-ghost ic-copy">העתקת קישור</button>
        </div>
      </div>`;
  }

  // the referral numbers, fetched once per page and refreshed when a card needs them
  let referralInfo = null;
  async function loadReferral() {
    try { referralInfo = await TRIPMAKER.api('/api/me/referral'); } catch { referralInfo = referralInfo || null; }
    return referralInfo;
  }

  // one delegated handler both chats route their card clicks through; returns true
  // when the click was one of ours
  function handleCardClick(e, ctx) {
    const trip = ctx.trip;
    if (e.target.closest('.qc-manual')) { TripPages.close(); return true; }
    if (e.target.closest('.qc-wa')) {
      const link = referralInfo && referralInfo.link;
      if (!link) return true;
      WA(`אני מתכנן/ת טיול עם TRIP MAKER 🧭 — מתכנן טיולים בעברית, עם AI שבונה את המסלול איתך, צעד אחר צעד.\nנסו גם אתם: ${link}`);
      TRIPMAKER.track?.('referral_share', { code: trip.share_code });
      return true;
    }
    if (e.target.closest('.ic-wa')) {
      WA(`${trip.emoji || '🧭'} בואו לתכנן איתי את "${trip.title}"!\nנכנסים לקישור, נרשמים בשנייה — ועורכים את הטיול יחד:\n${inviteLink(trip)}`);
      TRIPMAKER.track?.('plan_invite', { code: trip.share_code, via: 'wa' });
      return true;
    }
    const copy = e.target.closest('.ic-copy');
    if (copy) {
      TRIPMAKER.copy(inviteLink(trip)).then(() => TripPages.toast('קישור ההזמנה הועתק ✓', 'ok'));
      return true;
    }
    return false;
  }

  // How a repaint moves the thread. Both chats repaint the whole list on every change,
  // so the helper remembers how many messages were on screen: the ones past that count
  // are new — they get the arrival animation, and the viewport goes to the START of the
  // first new AI message (a long answer scrolled to its end loses the traveller; the
  // bottom is right only when the new part fits). A first paint (history) just lands.
  function arrival(body, thread) {
    let first = true;
    return {
      settle(msgs, painted, ready) {
        // the "thinking" bubble is not a message: it never counts, and never animates twice
        const nodes = [...thread.children].filter((el) => !el.classList.contains('chat-wait'));
        const fresh = nodes.slice(painted);
        if (first || !ready) {
          body.scrollTop = body.scrollHeight;
          first = !ready;
          return nodes.length;
        }
        fresh.forEach((el, k) => { el.classList.add('chat-in'); el.style.animationDelay = `${Math.min(k, 4) * 90}ms`; });
        const firstAi = fresh.find((el) => el.classList.contains('ai') && !el.querySelector('.chat-typing')) || fresh[0];
        const bottom = body.scrollHeight - body.clientHeight;
        const top = firstAi ? Math.max(0, firstAi.offsetTop - thread.offsetTop - 8) : bottom;
        body.scrollTo({ top: Math.min(top, bottom), behavior: 'smooth' });
        return nodes.length;
      },
    };
  }

  // =================================================================
  //  RENDER
  // =================================================================

  function changeCardHtml(m, latestApplied) {
    const p = m.payload || {};
    const changes = p.changes || [];
    if (!changes.length) return '';
    const done = p.decision === 'applied';
    const head = {
      pending: 'שינויים מוצעים למסלול', deciding: 'שינויים מוצעים למסלול', applied: 'שינויים שבוצעו במסלול',
      rejected: 'הצעה שלא בוצעה', undone: 'שינויים שבוטלו',
    }[p.decision] || 'שינויים';
    const rows = changes.map((c) => {
      const k = KIND[c.kind] || KIND.update;
      const detail = c.kind === 'update' && c.changes && c.changes.length ? ` — ${c.changes.join(', ')}` : '';
      return `<li class="pc-row pc-${c.kind}"><span class="pc-em" aria-hidden="true">${k.em}</span>
        <span class="pc-text"><b>${esc(c.title || '')}</b>${c.when ? `<small>${esc(c.when)}</small>` : ''}${detail ? `<span class="pc-detail">${esc(detail)}</span>` : ''}</span></li>`;
    }).join('');
    let foot = '';
    if (p.decision === 'deciding') {
      // the tap landed: the buttons are gone and the card says what is happening
      // until the server answers — nothing else on screen moves yet
      foot = `<div class="pc-foot pc-busy"><span class="chat-typing" aria-hidden="true"><i></i><i></i><i></i></span>${p.deciding === 'accept' ? 'מכניסים למסלול…' : 'רגע…'}</div>`;
    } else if (p.decision === 'pending') {
      foot = `<div class="pc-foot">
        <button type="button" class="btn btn-amber pc-accept" data-id="${m.id}">${ICON.check} אישור</button>
        <button type="button" class="btn btn-ghost pc-reject" data-id="${m.id}">לא עכשיו</button></div>`;
    } else if (done && latestApplied === m.id && p.undo) {
      foot = `<div class="pc-foot"><button type="button" class="pc-undo" data-id="${m.id}">${ICON.undo} ביטול השינוי</button></div>`;
    } else if (p.decision === 'rejected') {
      foot = '<div class="pc-note">לא בוצע</div>';
    } else if (p.decision === 'undone') {
      foot = '<div class="pc-note">בוטל — המסלול חזר לקדמותו</div>';
    }
    return `<div class="plan-card pc-${p.decision || 'pending'}"><div class="pc-head">${esc(head)}</div><ul class="pc-list">${rows}</ul>${foot}</div>`;
  }

  function msgHtml(m, i, latestApplied, ctx) {
    if (m.role === 'user') return `<div class="chat-msg user"><div class="chat-bubble">${esc(m.text)}</div></div>`;
    if (m.quota) return quotaMsgHtml(m, referralInfo);
    const cards = m.cards || [];
    const p = m.payload || {};
    return `
      <div class="chat-msg ai" data-i="${i}">
        <span class="chat-avatar" aria-hidden="true">🧭</span>
        <div class="chat-col">
          <div class="chat-bubble">${esc(m.text || '')}</div>
          ${cards.length ? `<div class="rec-strip">${cards.map((c, j) => TripRecs.cardHtml(c, i, j)).join('')}</div>` : ''}
          ${changeCardHtml(m, latestApplied)}
          ${p.built ? `<div class="plan-card pc-applied"><div class="pc-head">${p.built.fill ? 'הימים הושלמו' : 'הטיול נבנה'} — ${p.built.count} תחנות</div></div>` : ''}
          ${p.invite ? inviteHtml(ctx.trip) : ''}
        </div>
      </div>`;
  }

  // =================================================================
  //  THE AREA CALENDAR — the split the AI proposed, painted by hand
  // =================================================================
  //
  // While the areas are being settled, the AI's day→area split is drawn on a month
  // calendar under the thread: pick an area, tap days to repaint them, confirm. The
  // confirmation is a normal turn ("מאשרים את החלוקה: …"), so the AI hears it the way
  // it hears everything else and moves on to the flights.

  function areaCalendarHtml(ctx, dayAreas, palette, selected) {
    const trip = ctx.trip;
    const color = (name) => AREA_COLORS[Math.max(palette.findIndex((a) => a.area === name), 0) % AREA_COLORS.length];
    const cell = (d, label) => `<button type="button" class="cal-cell has-area rc-day" data-d="${d}" style="--area-c:${color(dayAreas[d])}" aria-label="יום ${d + 1} · ${esc(dayAreas[d])}">` +
      `<span class="cc-head"><span class="cc-num">${label}</span></span><span class="cc-area">${esc(dayAreas[d])}</span></button>`;
    let grid = '';
    const start = trip.start_date ? new Date(trip.start_date) : null;
    if (start) {
      let monthKey = null, cells = '';
      const flush = () => { if (cells) grid += `<div class="cal-grid rc-grid">${cells}</div>`; cells = ''; };
      for (let d = 0; d < dayAreas.length; d++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
        const key = `${date.getFullYear()}-${date.getMonth()}`;
        if (key !== monthKey) {
          flush();
          monthKey = key;
          grid += `<div class="rc-month">${date.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })}</div>`;
          cells += '<span class="rc-pad"></span>'.repeat(date.getDay());
        }
        cells += cell(d, String(date.getDate()));
      }
      flush();
    } else {
      grid = `<div class="cal-grid rc-grid">${dayAreas.map((_, d) => cell(d, 'יום ' + (d + 1))).join('')}</div>`;
    }
    return `
      <div class="plan-card pc-areas" id="plan-areas">
        <div class="pc-head">חלוקת הימים לאזורים 🗺️</div>
        <div class="region-cal">${grid}</div>
        <div class="region-palette"><span class="rp-hint">בוחרים אזור ומקישים על ימים כדי לצבוע:</span>${palette.map((a) =>
          `<button type="button" class="rp-area${a.area === selected ? ' selected' : ''}" data-a="${esc(a.area)}"><i style="background:${color(a.area)}"></i>${esc(a.area)}</button>`).join('')}</div>
        <div class="pc-foot"><button type="button" class="btn btn-amber pa-confirm">${ICON.check} מאשרים את החלוקה</button></div>
      </div>`;
  }

  // consecutive same-area days → blocks; an area returning later yields separate blocks
  function blocksOf(dayAreas, palette) {
    const blocks = [];
    dayAreas.forEach((area, i) => {
      const last = blocks[blocks.length - 1];
      if (last && last.area === area) last.to = i + 1;
      else blocks.push({ area, from: i + 1, to: i + 1, cities: (palette.find((a) => a.area === area) || {}).cities || [] });
    });
    return blocks;
  }

  function render(slots, ctx) {
    const { page, body, foot } = slots;
    page.classList.add('page-chat', 'page-plan');
    let msgs = [];
    let state = ctx.trip.plan_state || { mode: 'manual', stage: 'clarify' };
    let busy = false;
    let loaded = false;

    body.innerHTML = '<div class="chat-thread" id="plan-thread"><div class="chat-msg ai"><span class="chat-avatar" aria-hidden="true">🧭</span><div class="chat-bubble chat-typing" aria-label="טוען…"><i></i><i></i><i></i></div></div></div>';
    foot.innerHTML = `
      <div class="chat-chips" id="plan-chips"></div>
      <form class="chat-form plan-form" id="plan-form">
        <button type="button" class="plan-mode" id="plan-mode" aria-live="polite"></button>
        <input type="text" id="plan-input" maxlength="400" placeholder="כתבו לי מה תרצו…" autocomplete="off" enterkeyhint="send">
        <button type="submit" class="chat-send" aria-label="שליחה">${ICON.send}</button>
      </form>
      <small class="chat-left" id="plan-left" hidden></small>`;
    const thread = body.querySelector('#plan-thread');
    const leftEl = foot.querySelector('#plan-left');
    const PLAN_NOUN = { one: 'הודעת תכנון', many: 'הודעות תכנון', last: 'הודעת התכנון האחרונה' };
    const chips = foot.querySelector('#plan-chips');
    const input = foot.querySelector('#plan-input');
    const modeBtn = foot.querySelector('#plan-mode');
    // what a new turn does to the viewport: a long answer must not be scrolled past —
    // the thread lands with the START of the newest message in view (the bottom only
    // when it fits), and only the newly arrived messages animate in
    let painted = 0;
    let deciding = false;
    const scroller = TripPlan.arrival(body, thread);

    const latestApplied = () => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'ai' && msgs[i].payload && msgs[i].payload.decision === 'applied') return msgs[i].id;
      }
      return null;
    };

    function paintMode() {
      const auto = state.mode === 'auto';
      modeBtn.className = `plan-mode ${auto ? 'auto' : 'manual'}`;
      modeBtn.innerHTML = `${auto ? ICON.auto : ICON.hand}<span>${auto ? 'אוטומטי' : 'ידני'}</span>`;
      modeBtn.title = auto
        ? 'מצב אוטומטי: ה-AI משנה את התחנות מיד, עם אפשרות ביטול. לחיצה עוברת למצב ידני'
        : 'מצב ידני: כל שינוי מוצג לאישור לפני שהוא נכנס למסלול. לחיצה עוברת למצב אוטומטי';
    }

    function paintChips() {
      const last = msgs[msgs.length - 1];
      const sugg = last && last.role === 'ai' && !busy ? (last.payload?.suggestions || []) : [];
      // the one chip that acts: offered once the days are being settled, and never while
      // a proposal is still waiting for a word
      const waiting = msgs.some((m) => m.role === 'ai' && m.payload && m.payload.decision === 'pending');
      const fill = !busy && loaded && !waiting && (state.stage === 'days' || state.stage === 'done') && !(last?.payload?.built);
      chips.innerHTML = sugg.map((q) => `<button type="button" class="chat-chip">${esc(q)}</button>`).join('') +
        (fill ? `<button type="button" class="chat-chip chip-build" id="plan-fill">${esc(FILL_CHIP)}</button>` : '');
      chips.querySelectorAll('.chat-chip:not(.chip-build)').forEach((b) => { b.onclick = () => send(b.textContent); });
      chips.querySelector('#plan-fill')?.addEventListener('click', () => build(true));
      chips.hidden = !chips.children.length;
    }

    // the calendar card's own state: one area per day, and the area being painted
    let dayAreas = null, palette = [], paintArea = null, paintedFrom = null;
    function syncCalendar() {
      const areas = state.areas || [];
      const show = loaded && !busy && state.stage === 'areas' && areas.length >= 2;
      if (!show) { dayAreas = null; return; }
      const key = JSON.stringify(areas);
      if (paintedFrom === key && dayAreas) return; // the traveller's painting survives repaints
      paintedFrom = key;
      palette = [...new Map(areas.map((a) => [a.area, a])).values()];
      dayAreas = new Array(ctx.trip.days).fill(palette[0].area);
      areas.forEach((a) => { for (let d = a.from; d <= a.to && d <= ctx.trip.days; d++) dayAreas[d - 1] = a.area; });
      paintArea = palette[0].area;
    }

    function paint() {
      const la = latestApplied();
      syncCalendar();
      thread.innerHTML = msgs.map((m, i) => msgHtml(m, i, la, ctx)).join('') +
        (dayAreas ? areaCalendarHtml(ctx, dayAreas, palette, paintArea) : '');
      // while a card shows its own "מכניסים למסלול…" the thinking bubble would be saying
      // the same thing twice — it waits until the card has flipped
      if (busy && !deciding) thread.insertAdjacentHTML('beforeend', `
        <div class="chat-msg ai chat-in chat-wait"><span class="chat-avatar" aria-hidden="true">🧭</span>
          <div class="chat-bubble chat-typing" aria-label="חושב…"><i></i><i></i><i></i></div></div>`);
      paintChips();
      paintMode();
      painted = scroller.settle(msgs, painted, loaded);
    }

    // the day's allowance is spent: the gentle card, with the referral numbers filled
    // in as soon as they arrive
    async function outOfQuota(kind) {
      if (kind === 'plan') leftLine(leftEl, 0, PLAN_NOUN);
      msgs.push(quotaMsg(kind));
      paint();
      await loadReferral();
      paint();
      TRIPMAKER.track?.('quota_hit', { code: ctx.trip.share_code, kind });
    }

    async function confirmAreas() {
      const blocks = blocksOf(dayAreas, palette);
      if (blocks.length > 12) { TripPages.toast('יותר מדי מעברים בין אזורים — כדאי לאחד ימים סמוכים'); return; }
      try {
        const r = await api(ctx, '', { method: 'PATCH', body: JSON.stringify({ areas: blocks }) });
        state = r.state;
        ctx.trip.plan_state = state;
      } catch (err) { TripPages.toast(err.message || 'לא הצלחתי לשמור את החלוקה'); return; }
      dayAreas = null;
      send('מאשרים את החלוקה: ' + blocks.map((b) => `${b.area} ימים ${b.from}–${b.to}`).join(', '));
    }

    const shape = (row) => ({ ...row, cards: (row.payload?.cards || []).map((c) => TripRecs.fromServerCard(c, ctx)) });

    async function load() {
      try {
        const r = await api(ctx, '');
        state = r.state;
        ctx.trip.plan_state = state;
        msgs = (r.messages || []).map(shape);
        loaded = true;
      } catch (err) {
        msgs = [{ role: 'ai', text: (err && err.message) || 'לא הצלחתי לטעון את התכנון — נסו לרענן', payload: {} }];
      }
      paint();
    }

    // =================================================================
    //  TURNS
    // =================================================================

    async function send(text) {
      const q = text.trim();
      if (!q || busy || !loaded) return;
      msgs.push({ role: 'user', text: q, payload: {} });
      busy = true;
      input.value = '';
      paint();
      try {
        const r = await api(ctx, '', { method: 'POST', body: JSON.stringify({ message: q, mode: state.mode }) });
        state = r.state;
        ctx.trip.plan_state = state;
        if (r.approved_message_id) {
          const m = msgs.find((x) => x.id === r.approved_message_id);
          if (m) m.payload = { ...m.payload, decision: 'applied', undo: true };
        }
        msgs.push(shape(r.message));
        if (r.items) ctx.replaceItems(r.items);
        if (r.remaining !== undefined) leftLine(leftEl, r.remaining, PLAN_NOUN);
        await promoteAreas();
        TRIPMAKER.track?.('plan_turn', { code: ctx.trip.share_code, stage: state.stage, mode: state.mode });
        busy = false;
        paint();
        if (r.message.payload && r.message.payload.build === 'once') build(false);
      } catch (err) {
        busy = false;
        if (err && err.quota) { outOfQuota(err.quota); return; }
        msgs.push({ role: 'ai', text: (err && err.message) || 'משהו השתבש בדרך — נסו שוב בעוד רגע.', payload: {}, transient: true });
        paint();
      }
    }

    // a tap on the card is an answer: the server writes (or refuses) the proposal, then
    // hears the decision as a turn and comes back with the next step — so the thread
    // shows the traveller's "✓ אישרתי…" and the AI's reply, exactly like a typed one
    async function decide(id, decision, btn) {
      if (busy) return;
      btn.disabled = true;
      const answered = decision !== 'undo';
      const target = msgs.find((m) => m.id === id);
      const was = target && target.payload ? target.payload.decision : null;
      if (target && answered) { target.payload = { ...target.payload, decision: 'deciding', deciding: decision }; busy = true; deciding = true; paint(); }
      try {
        const r = await api(ctx, '/decide', { method: 'POST', body: JSON.stringify({ message_id: id, decision }) });
        deciding = false;
        const i = msgs.findIndex((m) => m.id === id);
        if (i !== -1) msgs[i] = shape(r.message);
        if (r.said) msgs.push({ role: 'user', text: r.said, payload: {} });
        if (r.state) { state = r.state; ctx.trip.plan_state = state; }
        if (r.approved_message_id) {
          const m = msgs.find((x) => x.id === r.approved_message_id);
          if (m) m.payload = { ...m.payload, decision: 'applied', undo: true };
        }
        if (r.follow) msgs.push(shape(r.follow));
        if (r.items) ctx.replaceItems(r.items);
        if (r.remaining !== undefined) leftLine(leftEl, r.remaining, PLAN_NOUN);
        busy = false;
        if (r.quota) { outOfQuota(r.quota); return; }
        TripPages.toast(decision === 'accept' ? 'המסלול עודכן ✓' : decision === 'undo' ? 'השינוי בוטל' : 'ההצעה נדחתה', decision === 'accept' ? 'ok' : undefined);
        TRIPMAKER.track?.('plan_decide', { code: ctx.trip.share_code, decision });
        await promoteAreas();
        if (r.follow && r.follow.payload && r.follow.payload.build === 'once') { paint(); build(false); return; }
      } catch (err) {
        busy = false;
        deciding = false;
        if (target && was) target.payload = { ...target.payload, decision: was };
        TripPages.toast((err && err.message) || 'לא הצלחתי — נסו שוב');
      }
      paint();
    }

    async function setMode(mode) {
      state.mode = mode;
      paintMode();
      try {
        const r = await api(ctx, '', { method: 'PATCH', body: JSON.stringify({ mode }) });
        state = r.state;
        ctx.trip.plan_state = state;
      } catch { /* the next turn carries the mode anyway */ }
      paintMode();
    }

    // the areas the conversation settled become the trip's destinations — with
    // coordinates the browser geocodes from each area's first city, exactly as the
    // wizard did — so the calendar colors, the map and the per-area editor all see them
    let promoting = false;
    async function promoteAreas(plan) {
      const areas = plan || state.areas || [];
      const trip = ctx.trip;
      const base = (trip.destinations || [])[0];
      if (promoting || !base || (trip.destinations || []).length !== 1 || areas.length < 2) return;
      const names = [...new Set(areas.map((a) => a.area))];
      if (names.length < 2 || names.every((n) => n === base.name)) return;
      promoting = true;
      try {
        const dests = [];
        for (const name of names) {
          const city = (areas.find((a) => a.area === name)?.cities || [])[0];
          const hit = city && typeof GEO !== 'undefined' ? (await GEO.searchPlaces(city).catch(() => []))[0] : null;
          dests.push({ name, country: base.country || base.name, lat: hit ? hit.lat : base.lat, lon: hit ? hit.lon : base.lon });
        }
        const updated = await TRIPMAKER.api('/api/trips/' + trip.id, { method: 'PATCH', body: JSON.stringify({ destinations: dests }) });
        ctx.setDestinations(updated.destinations || dests);
      } catch { /* the areas still live in the plan state; the trip page catches up on reload */ }
      promoting = false;
    }

    // =================================================================
    //  THE BUILD — "בבת אחת", or filling the rest around the anchors
    // =================================================================

    let building = false;
    async function build(fill) {
      if (building) return;
      building = true;
      const overlay = showOverlay(fill ? 'את שאר הימים' : 'את הטיול');
      try {
        const r = await api(ctx, '/build', { method: 'POST', body: JSON.stringify({ fill }) });
        overlay.sub.textContent = 'שומרים את הטיול… ✈️';
        state = r.state;
        ctx.trip.plan_state = state;
        await promoteAreas(r.plan);
        TRIPMAKER.track?.('plan_build', { code: ctx.trip.share_code, fill, count: (r.items || []).length });
        // the itinerary is the point now: land on it, the chat stays a tab away
        location.href = `/trip/${ctx.trip.share_code}`;
      } catch (err) {
        overlay.remove();
        building = false;
        if (err && err.quota) { outOfQuota(err.quota); return; }
        msgs.push({ role: 'ai', text: '⚠️ ' + ((err && err.message) || 'הבנייה נכשלה — נסו שוב'), payload: {}, transient: true });
        paint();
      }
    }

    function showOverlay(label) {
      const el = document.createElement('div');
      el.className = 'ai-overlay open';
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = `
        <div class="ai-glow g1"></div><div class="ai-glow g2"></div>
        <div class="ai-overlay-content">
          <div class="ai-orb">🧭</div>
          <h2 class="ai-overlay-title">ה-AI בונה ${esc(label)}</h2>
          <div class="ai-overlay-sub">${esc(QUIPS[0])}</div>
        </div>`;
      document.body.appendChild(el);
      const sub = el.querySelector('.ai-overlay-sub');
      let i = 0;
      const timer = setInterval(() => {
        sub.classList.add('swap');
        setTimeout(() => { i = (i + 1) % QUIPS.length; sub.textContent = QUIPS[i]; sub.classList.remove('swap'); }, 400);
      }, 2400);
      return { sub, remove: () => { clearInterval(timer); el.remove(); } };
    }

    // =================================================================
    //  WIRING
    // =================================================================

    thread.addEventListener('click', (e) => {
      if (handleCardClick(e, ctx)) return;
      const day = e.target.closest('.rc-day');
      if (day && dayAreas) { dayAreas[+day.dataset.d] = paintArea; paint(); return; }
      const pal = e.target.closest('.rp-area');
      if (pal) { paintArea = pal.dataset.a; paint(); return; }
      if (e.target.closest('.pa-confirm')) { confirmAreas(); return; }
      const media = e.target.closest('.rec-media');
      if (media) {
        const el = media.closest('.rec-card');
        TripRecs.cyclePhotoOf(media, msgs[+el.dataset.i]?.cards[+el.dataset.j]);
        return;
      }
      const add = e.target.closest('.rec-add');
      if (add) {
        const el = add.closest('.rec-card');
        const c = msgs[+el.dataset.i]?.cards[+el.dataset.j];
        if (c) TripRecs.addRecs(ctx, [c], (day) => { c.added = day; paint(); });
        return;
      }
      const accept = e.target.closest('.pc-accept');
      if (accept) { decide(+accept.dataset.id, 'accept', accept); return; }
      const reject = e.target.closest('.pc-reject');
      if (reject) { decide(+reject.dataset.id, 'reject', reject); return; }
      const undo = e.target.closest('.pc-undo');
      if (undo) decide(+undo.dataset.id, 'undo', undo);
    });
    foot.querySelector('#plan-form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
    modeBtn.onclick = () => setMode(state.mode === 'auto' ? 'manual' : 'auto');

    paint();
    load();
  }

  // the quota card and its handler are shared with the recommendations chat
  // the "N left today" line under a composer — null (admin) shows nothing
  function leftLine(el, remaining, noun) {
    if (!el) return;
    if (remaining == null) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = remaining <= 0 ? `זו הייתה ${noun.last} להיום` : `נשאר${remaining === 1 ? 'ה' : 'ו'} ${remaining} ${remaining === 1 ? noun.one : noun.many} להיום`;
    el.classList.toggle('low', remaining <= 5);
  }

  return { render, arrival, quotaMsg, quotaMsgHtml, handleCardClick, loadReferral, referral: () => referralInfo, changeCardHtml, leftLine };
})();
