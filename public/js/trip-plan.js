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

  // =================================================================
  //  RENDER
  // =================================================================

  function changeCardHtml(m, latestApplied) {
    const p = m.payload || {};
    const changes = p.changes || [];
    if (!changes.length) return '';
    const done = p.decision === 'applied';
    const head = {
      pending: 'שינויים מוצעים למסלול', applied: 'שינויים שבוצעו במסלול',
      rejected: 'הצעה שלא בוצעה', undone: 'שינויים שבוטלו',
    }[p.decision] || 'שינויים';
    const rows = changes.map((c) => {
      const k = KIND[c.kind] || KIND.update;
      const detail = c.kind === 'update' && c.changes && c.changes.length ? ` — ${c.changes.join(', ')}` : '';
      return `<li class="pc-row pc-${c.kind}"><span class="pc-em" aria-hidden="true">${k.em}</span>
        <span class="pc-text"><b>${esc(c.title || '')}</b>${c.when ? `<small>${esc(c.when)}</small>` : ''}${detail ? `<span class="pc-detail">${esc(detail)}</span>` : ''}</span></li>`;
    }).join('');
    let foot = '';
    if (p.decision === 'pending') {
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

  function msgHtml(m, i, latestApplied) {
    if (m.role === 'user') return `<div class="chat-msg user"><div class="chat-bubble">${esc(m.text)}</div></div>`;
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
        </div>
      </div>`;
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
      </form>`;
    const thread = body.querySelector('#plan-thread');
    const chips = foot.querySelector('#plan-chips');
    const input = foot.querySelector('#plan-input');
    const modeBtn = foot.querySelector('#plan-mode');
    const scrollDown = () => { body.scrollTop = body.scrollHeight; };

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

    function paint() {
      const la = latestApplied();
      thread.innerHTML = msgs.map((m, i) => msgHtml(m, i, la)).join('');
      if (busy) thread.insertAdjacentHTML('beforeend', `
        <div class="chat-msg ai"><span class="chat-avatar" aria-hidden="true">🧭</span>
          <div class="chat-bubble chat-typing" aria-label="חושב…"><i></i><i></i><i></i></div></div>`);
      paintChips();
      paintMode();
      scrollDown();
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
        await promoteAreas();
        TRIPMAKER.track?.('plan_turn', { code: ctx.trip.share_code, stage: state.stage, mode: state.mode });
        busy = false;
        paint();
        if (r.message.payload && r.message.payload.build === 'once') build(false);
      } catch (err) {
        busy = false;
        msgs.push({ role: 'ai', text: (err && err.message) || 'משהו השתבש בדרך — נסו שוב בעוד רגע.', payload: {}, transient: true });
        paint();
      }
    }

    async function decide(id, decision, btn) {
      if (busy) return;
      btn.disabled = true;
      try {
        const r = await api(ctx, '/decide', { method: 'POST', body: JSON.stringify({ message_id: id, decision }) });
        const i = msgs.findIndex((m) => m.id === id);
        if (i !== -1) msgs[i] = shape(r.message);
        if (r.items) ctx.replaceItems(r.items);
        TripPages.toast(decision === 'accept' ? 'המסלול עודכן ✓' : decision === 'undo' ? 'השינוי בוטל' : 'ההצעה נדחתה', decision === 'accept' ? 'ok' : undefined);
        TRIPMAKER.track?.('plan_decide', { code: ctx.trip.share_code, decision });
      } catch (err) {
        btn.disabled = false;
        TripPages.toast((err && err.message) || 'לא הצלחתי — נסו שוב');
        return;
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

  return { render };
})();
