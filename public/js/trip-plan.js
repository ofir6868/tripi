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
    // the מסלול tab's own glyph: the button points at a tab the traveller is about to meet
    route: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h6a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h6"/></svg>',
  };
  const KIND = { add: { em: '➕', label: 'הוספה' }, update: { em: '✏️', label: 'שינוי' }, delete: { em: '🗑️', label: 'הסרה' } };
  const FILL_CHIP = '✨ להשלים את שאר הימים אוטומטית';
  const QUIPS = [
    'מדפדף במדריכי טיולים…', 'בוחר את המסעדות הכי שוות…', 'מסדר את הימים בסדר הגיוני…',
    'מוסיף נקודות תצפית…', 'מצייר את המסלול על המפה…', 'שוקל בין שוק למוזיאון…', 'עוד רגע קטן — מלטש פרטים…',
  ];

  const api = (ctx, path, opts) => TRIPMAKER.api(`/api/trips/code/${ctx.trip.share_code}/plan${path}`, opts);
  const WA = (text) => window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');

  // =================================================================
  //  THE FIRST SECONDS — nothing on screen may wait for the model
  // =================================================================
  //
  // A fresh trip's chat used to open on three dots and stay there: the opening turn is
  // minted on the first load, and for a multi-country or a whole-country trip that load
  // waits for the clarifying question (a strong-model call, seconds). The traveller had
  // just tapped "start planning" and saw nothing answer — the taps that followed were
  // rage clicks in the data. But the opening's first sentence is fixed text the server
  // writes word for word (routes/plan.js, openingMessage: `hello`), so it is painted the
  // moment the chat opens, and only the question after it is waited for — inside the
  // same bubble, which grows into the full message when it lands.
  const listNames = (names) => (names.length > 1
    ? `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`
    : names[0] || '');
  function openingHello(trip) {
    const names = (Array.isArray(trip.destinations) ? trip.destinations : []).filter((d) => d && d.name).map((d) => d.name);
    const where = listNames(names) || trip.destination || '';
    return where ? `היי! מתכננים יחד את הטיול ל${where} — ${trip.days} ימים.` : '';
  }

  // What a long wait says, by how long it has been. Three dots are enough for a second;
  // after that, silence reads as a hang — and a hang is what gets tapped again. Every
  // line is true at every stage (a turn reads the trip, checks places on the map, and
  // writes), so no line promises a step that is not happening.
  const WAIT_LINES = [
    [5, 'חושב על זה…'],
    [12, 'עובר על המסלול ובודק מקומות במפה…'],
    [25, 'לוקח קצת יותר מהרגיל — עוד רגע'],
    [60, 'עדיין עובד על זה. אפשר להציץ במסלול בינתיים — לא אאבד את ההודעה'],
  ];
  const waitLine = (since, lines = WAIT_LINES) => {
    const s = (Date.now() - since) / 1000;
    let text = '';
    for (const [at, line] of lines) if (s >= at) text = line;
    return text;
  };

  // the line under the dots, and the one ticker per chat that keeps it current — both
  // chats use them, so a wait reads the same in תכנון and in המלצות
  const OPENING_LINES = [[3, 'מכין לכם שאלה ראשונה…'], [12, 'עוד רגע…'], [30, 'לוקח יותר מהרגיל — אם זה נתקע, רעננו את הדף']];
  const waitNoteHtml = (since, kind = '') =>
    `<small class="chat-wait-note" data-since="${since}"${kind ? ` data-kind="${kind}"` : ''}>${esc(since ? waitLine(since, kind === 'opening' ? OPENING_LINES : WAIT_LINES) : '')}</small>`;
  function startWaitTicker(thread) {
    const ticker = setInterval(() => {
      if (!thread.isConnected) { clearInterval(ticker); return; }
      thread.querySelectorAll('.chat-wait-note').forEach((el) => {
        const since = +el.dataset.since;
        if (!since) return;
        const line = waitLine(since, el.dataset.kind === 'opening' ? OPENING_LINES : WAIT_LINES);
        if (el.textContent !== line) el.textContent = line;
      });
    }, 1000);
  }

  // The trip page asks for the thread as it starts, beside its own request for the trip,
  // instead of after it: on a fresh trip that GET is the one that mints the opening, so
  // it is worth the head start. A failed prefetch is not an answer — load() asks again.
  let prefetched = null;
  function prefetch(code) {
    const promise = TRIPMAKER.api(`/api/trips/code/${encodeURIComponent(code)}/plan`);
    promise.catch(() => {}); // unhandled until load() picks it up
    prefetched = { code, promise, at: Date.now() };
  }
  function takePrefetch(code) {
    const p = prefetched;
    prefetched = null;
    return p && p.code === code && Date.now() - p.at < 60000 ? p.promise : null;
  }
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

  // The milestone's panel: the basics are settled, the dock has just arrived, and there
  // are exactly two ways on — the trip's own page (this button) or another turn here
  // (a chip under the composer, a suggestion like any other). One button and nothing
  // else: the message above it already said the whole thing.
  const unlockedHtml = () =>
    `<div class="plan-card pc-unlocked"><button type="button" class="btn btn-amber pu-go">${ICON.route} עבור לדף המסלול</button></div>`;

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
    // a receipt — the line a tap on a card writes so the model hears the decision — is
    // for the model only: on screen the card itself already shows what happened, and an
    // "✓ אישרנו" bubble under it is the app telling the traveller what they just did
    if (m.role === 'user') return m.payload && m.payload.receipt
      ? ''
      : `<div class="chat-msg user"><div class="chat-bubble">${esc(m.text)}</div></div>`;
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
          ${p.unlocked ? unlockedHtml() : ''}
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

  // =================================================================
  //  THE FLIGHTS CARD — the stage that used to be five questions
  // =================================================================
  //
  // Settling the flights was the one part of the conversation that was never a
  // conversation: where do you fly from, when do you land, is there a connection, and the
  // same again for the way back — five turns, five model calls, and every answer a
  // sentence the model had to turn back into a stop. None of it is free text. It is two
  // airports, a day, two hours nobody always knows, and sometimes a stopover.
  //
  // So it is a card: filled in advance (the model's airports, or the ones the server
  // worked out from the trip — lib/flights.js), every field editable, hours optional, and
  // one button that writes the flights into the itinerary. The airport picker answers off
  // the index in memory (public/js/airports.js), so it is instant and keyless.
  //
  // The card's element is kept across repaints rather than re-rendered into the thread:
  // an hour someone is halfway through typing must survive the AI's next message.

  const FLIGHT_KIND = { out: 'טיסת הלוך', inner: 'טיסה פנימית', return: 'טיסת חזור' };
  const FL_X = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // what the field shows for an airport: the index's own words for a code we know, and
  // the traveller's own words for one we don't
  const airportText = (a) => {
    if (!a) return '';
    const k = AIRPORTS.byCode(a.code);
    return k ? `${k.city}${k.name ? ` · ${k.name}` : ''} (${k.code})` : (a.name || '');
  };

  // a typed field → the airport it names, or the words themselves. Never a fuzzy best
  // guess: a half-typed field is not an airport until somebody picks one.
  function resolveAirport(typed, cur) {
    const q = String(typed || '').trim();
    if (!q) return { code: '', name: '' };
    if (cur && cur.code && airportText(cur) === q) return { code: cur.code, name: cur.name };
    const hit = AIRPORTS.exact(q);
    return hit ? { code: hit.code, name: hit.city } : { code: '', name: q.slice(0, 60) };
  }

  // one closer for every airport dropdown this file opens — a listener per field would
  // pile up with every rebuild of the card
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.pc-flights .autocomplete-list.open').forEach((list) => {
      if (!list.parentNode.contains(e.target)) list.classList.remove('open');
    });
  });

  // The airport picker. The index is in memory, so it answers on the keystroke itself —
  // no debounce, no network, and no free-text row: a name it doesn't know is simply kept
  // as typed (resolveAirport), which is what somebody flying from a field we never heard
  // of actually means.
  function attachAirportPicker(input, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'autocomplete-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = document.createElement('div');
    list.className = 'autocomplete-list glass';
    wrap.appendChild(list);
    let hits = [];
    const close = () => list.classList.remove('open');
    const open = () => {
      hits = AIRPORTS.search(input.value.trim(), 6);
      if (!hits.length) { close(); return; }
      list.innerHTML = hits.map((a, i) => `
        <button type="button" class="autocomplete-item" data-i="${i}">
          <span class="ac-icon">✈️</span>
          <span class="ac-name">${esc(a.city)}${a.name ? ` · ${esc(a.name)}` : ''}</span>
          <span class="ac-meta">${esc(a.country)} · ${esc(a.code)}</span>
        </button>`).join('');
      list.classList.add('open');
      list.querySelectorAll('.autocomplete-item').forEach((b) => {
        b.onclick = () => {
          const a = hits[+b.dataset.i];
          input.value = airportText({ code: a.code });
          close();
          onPick({ code: a.code, name: a.city });
        };
      });
    };
    input.addEventListener('input', open);
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) open(); });
    input.addEventListener('keydown', (e) => {
      const isOpen = list.classList.contains('open');
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && isOpen) {
        e.preventDefault();
        TRIPMAKER.acMove(list, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' && isOpen) {
        const act = list.querySelector('.autocomplete-item.active') || list.querySelector('.autocomplete-item');
        if (act) { e.preventDefault(); act.click(); }
      } else if (e.key === 'Escape') close();
    });
  }

  function flightDayOptions(ctx, day) {
    let out = '';
    for (let n = 1; n <= ctx.trip.days; n++) {
      const d = ctx.dayDate ? ctx.dayDate(n) : null;
      const date = d ? ` · ${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}` : '';
      out += `<option value="${n}"${n === day ? ' selected' : ''}>יום ${n}${date}</option>`;
    }
    return out;
  }

  const flTime = (label, cls, val, i, k) =>
    `<label class="fl-time"><span>${label}</span><input type="time" class="${cls}" data-i="${i}"${k != null ? ` data-k="${k}"` : ''} value="${esc(val || '')}" autocomplete="off"></label>`;

  // the id is the leg and the side it belongs to, so every field on the card carries a
  // label a tap or a screen reader can reach it by
  const flAir = (label, side, a, i, k) => {
    const id = `fl-${i}-${side}${k != null ? `-${k}` : ''}`;
    return `
    <div class="fl-air-field">
      <label for="${id}">${label}</label>
      <input type="text" id="${id}" class="fl-air" data-i="${i}"${k != null ? ` data-k="${k}"` : ''} data-side="${side}"
        value="${esc(airportText(a))}" placeholder="עיר, שדה תעופה או קוד…" maxlength="60" autocomplete="off">
    </div>`;
  };

  function flightLegHtml(ctx, leg, i) {
    const stops = leg.stops.map((s, k) => `
      <div class="fl-stop">
        ${flAir('עצירת ביניים', 'stop', s, i, k)}
        ${flTime('נחיתה', 'fl-t-sarrive', s.arrive, i, k)}
        ${flTime('המראה', 'fl-t-sdepart', s.depart, i, k)}
        <button type="button" class="fl-x" data-act="stop-del" data-i="${i}" data-k="${k}" aria-label="הסרת עצירת הביניים">${FL_X}</button>
      </div>`).join('');
    return `
      <div class="fl-leg">
        <div class="fl-leg-head">
          <span class="fl-kind">${esc(FLIGHT_KIND[leg.kind] || 'טיסה')}</span>
          <select class="fl-day" data-i="${i}" aria-label="יום הטיסה">${flightDayOptions(ctx, leg.day)}</select>
          <button type="button" class="fl-x fl-leg-x" data-act="leg-del" data-i="${i}" aria-label="הסרת הטיסה">${FL_X}</button>
        </div>
        <div class="fl-row fl-airports">${flAir('ממריאים מ', 'from', leg.from, i)}${flAir('נוחתים ב', 'to', leg.to, i)}</div>
        <div class="fl-row fl-times">${flTime('המראה', 'fl-t-depart', leg.depart, i)}${flTime('נחיתה', 'fl-t-arrive', leg.arrive, i)}</div>
        ${stops}
        ${leg.stops.length < 2 ? `<button type="button" class="fl-add" data-act="stop-add" data-i="${i}">+ עצירת ביניים</button>` : ''}
      </div>`;
  }

  // מצב אוטומטי / ידני of the planning chat lives in the trip's plan state on the
  // server — it follows the traveller between devices, and the trip page can turn it on
  // from outside ("עבור לסוכן החכם") before this chat ever paints.
  async function setMode(trip, mode) {
    trip.plan_state = { ...(trip.plan_state || { stage: 'clarify' }), mode };
    try {
      const r = await TRIPMAKER.api(`/api/trips/code/${trip.share_code}/plan`, {
        method: 'PATCH', body: JSON.stringify({ mode }),
      });
      trip.plan_state = r.state;
    } catch { /* the next turn carries the mode anyway */ }
    return trip.plan_state;
  }

  // a message handed over from outside — the trip page's bottom ask bar (see
  // TripRecs.say): held until the thread has loaded, since a turn can't go out before
  // the conversation it belongs to is on screen
  let queued = null;
  let flush = null;
  function say(text) {
    queued = String(text || '').trim() || null;
    flush?.();
  }

  function render(slots, ctx) {
    const { page, body, foot } = slots;
    page.classList.add('page-chat', 'page-plan');
    flush = null; // a chat painted earlier is gone — nothing handed over reaches it
    let msgs = [];
    let state = ctx.trip.plan_state || { mode: 'manual', stage: 'clarify' };
    let busy = false;
    let loaded = false;
    // a turn typed while the previous one is still being answered: it waits on screen,
    // marked as waiting, and goes out the moment the answer lands — the send button is
    // never a dead tap
    let nextQ = null;
    // since when the chat has been waiting, for the line under the dots
    let busySince = 0;

    // A trip whose chat never opened gets its first sentence now (see openingHello);
    // anything else — a thread that exists — waits for its history behind the dots.
    const hello = !(ctx.trip.plan_state || {}).opened ? openingHello(ctx.trip) : '';
    const openedAt = Date.now();
    body.innerHTML = `<div class="chat-thread" id="plan-thread"><div class="chat-msg ai${hello ? ' chat-in' : ''}"><span class="chat-avatar" aria-hidden="true">🧭</span>${hello
      ? `<div class="chat-col"><div class="chat-bubble">${esc(hello)} <span class="chat-typing chat-typing-inline" aria-label="כותב…"><i></i><i></i><i></i></span></div>${waitNoteHtml(openedAt, 'opening')}</div>`
      : '<div class="chat-bubble chat-typing" aria-label="טוען…"><i></i><i></i><i></i></div>'}</div></div>`;
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
    // what a new turn does to the viewport: a long answer must not be scrolled past —
    // the thread lands with the START of the newest message in view (the bottom only
    // when it fits), and only the newly arrived messages animate in
    let painted = 0;
    let deciding = false;
    // the dock owes an entrance: the milestone message goes up first, and the tabs
    // arrive under it a beat later, so the two read as one sentence
    let dockOwed = false;
    function milestone(row) {
      if (!row) return;
      msgs.push(shape(row));
      dockOwed = true;
    }
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
      // choose is the one stage that offers a fork rather than a shortcut — שלב אחרי שלב
      // או בבת אחת — so its suggestions are not suggestions: they ARE the question the
      // message just asked, and they get painted as the choice, wide and loud, instead
      // of two quiet chips that scroll away with the rest
      const choosing = state.stage === 'choose' && sugg.length > 1;
      // flight hours arrive weeks after the flights do — the card comes back on a chip,
      // instead of the traveller having to describe the change in words
      const reopenFlights = !busy && loaded && !flightsOpen && state.flights && state.flights.confirmed && state.stage !== 'flights';
      chips.className = choosing ? 'chat-chips chips-choice' : 'chat-chips';
      chips.innerHTML = sugg.map((q) => `<button type="button" class="chat-chip${choosing ? ' chip-choice' : ''}">${esc(q)}</button>`).join('') +
        (fill ? `<button type="button" class="chat-chip chip-build" id="plan-fill">${esc(FILL_CHIP)}</button>` : '') +
        (reopenFlights ? '<button type="button" class="chat-chip chip-flights" id="plan-flights-edit">✈️ עדכון הטיסות</button>' : '');
      chips.querySelectorAll('.chat-chip:not(.chip-build):not(.chip-flights)').forEach((b) => { b.onclick = () => send(b.textContent); });
      chips.querySelector('#plan-fill')?.addEventListener('click', () => build(true));
      chips.querySelector('#plan-flights-edit')?.addEventListener('click', () => { flightsOpen = true; paint(); });
      chips.hidden = !chips.children.length;
    }

    // the calendar card's own state: one area per day, and the area being painted
    let dayAreas = null, palette = [], paintArea = null, paintedFrom = null;
    function syncCalendar() {
      const areas = state.areas || [];
      // the card is for choosing between areas: with one area (however many blocks the
      // AI cut it into) there is nothing to paint, so it stays off
      const distinct = [...new Map(areas.map((a) => [a.area, a])).values()];
      const show = loaded && !busy && state.stage === 'areas' && distinct.length >= 2;
      if (!show) { dayAreas = null; return; }
      const key = JSON.stringify(areas);
      if (paintedFrom === key && dayAreas) return; // the traveller's painting survives repaints
      paintedFrom = key;
      palette = distinct;
      dayAreas = new Array(ctx.trip.days).fill(palette[0].area);
      areas.forEach((a) => { for (let d = a.from; d <= a.to && d <= ctx.trip.days; d++) dayAreas[d - 1] = a.area; });
      paintArea = palette[0].area;
    }

    // the flights card's own state. `flightCard` is a live element, not markup: a repaint
    // re-appends it, so an hour half-typed into it survives the AI's next message.
    let flightLegs = null;
    let flightCard = null;
    let flightsFrom = null;
    let flightsBusy = false;
    let flightsOpen = false; // reopened from the chip, after the flights were settled

    function syncFlights() {
      const f = state.flights;
      const show = loaded && f && ((state.stage === 'flights' && !f.confirmed) || flightsOpen);
      if (!show) { flightLegs = null; flightCard = null; flightsFrom = null; return; }
      const key = JSON.stringify(f.legs) + (flightsOpen ? '|open' : '');
      if (flightsFrom === key && flightCard) return; // what is typed in the card stays
      flightsFrom = key;
      flightLegs = JSON.parse(JSON.stringify(f.legs || []));
      flightCard = document.createElement('div');
      flightCard.className = 'plan-card pc-flights';
      renderFlightCard();
    }

    function renderFlightCard() {
      if (!flightCard) return;
      const legs = flightLegs || [];
      flightCard.innerHTML = `
        <div class="pc-head">✈️ הטיסות</div>
        <p class="pc-text-p">${flightsOpen
          ? 'מה שתשנו כאן יחליף את תחנות הטיסה שבמסלול.'
          : 'מילאתי הצעה לפי היעדים שלכם — תקנו מה שצריך. שעות הן לא חובה, ואפשר להוסיף עצירות ביניים.'}</p>
        <div class="fl-legs">${legs.map((l, i) => flightLegHtml(ctx, l, i)).join('')
          || '<p class="pc-note">אין כאן טיסות — אפשר להוסיף אחת, או לדלג.</p>'}</div>
        <button type="button" class="fl-add fl-add-leg" data-act="leg-add">+ טיסה נוספת</button>
        <div class="pc-foot">
          <button type="button" class="btn btn-amber fl-save"${flightsBusy ? ' disabled' : ''}>${ICON.check} ${flightsOpen ? 'עדכון הטיסות' : 'שומרים את הטיסות'}</button>
          <button type="button" class="btn btn-ghost fl-skip"${flightsBusy ? ' disabled' : ''}>${flightsOpen ? 'ביטול' : 'אין לנו טיסות עדיין'}</button>
        </div>`;
      // the picker is attached per field, and a rebuild makes new fields — so it is
      // attached here rather than once, and the pick writes straight into the model
      flightCard.querySelectorAll('.fl-air').forEach((input) => {
        attachAirportPicker(input, (picked) => {
          const leg = flightLegs[+input.dataset.i];
          if (!leg) return;
          if (input.dataset.side === 'stop') Object.assign(leg.stops[+input.dataset.k] || {}, picked);
          else leg[input.dataset.side] = picked;
        });
      });
    }

    // The card is the truth about what is typed in it; flightLegs is the truth about its
    // structure. Read before anything rebuilds the markup, and before saving.
    function readFlightCard() {
      if (!flightCard || !flightLegs) return;
      const legOf = (el) => flightLegs[+el.dataset.i];
      flightCard.querySelectorAll('.fl-day').forEach((sel) => { if (legOf(sel)) legOf(sel).day = +sel.value; });
      const times = [
        ['.fl-t-depart', (leg, el) => { leg.depart = el.value; }],
        ['.fl-t-arrive', (leg, el) => { leg.arrive = el.value; }],
        ['.fl-t-sarrive', (leg, el) => { if (leg.stops[+el.dataset.k]) leg.stops[+el.dataset.k].arrive = el.value; }],
        ['.fl-t-sdepart', (leg, el) => { if (leg.stops[+el.dataset.k]) leg.stops[+el.dataset.k].depart = el.value; }],
      ];
      for (const [sel, apply] of times) {
        flightCard.querySelectorAll(sel).forEach((el) => { const leg = legOf(el); if (leg) apply(leg, el); });
      }
      flightCard.querySelectorAll('.fl-air').forEach((input) => {
        const leg = legOf(input);
        if (!leg) return;
        if (input.dataset.side === 'stop') {
          const stop = leg.stops[+input.dataset.k];
          if (stop) Object.assign(stop, resolveAirport(input.value, stop));
        } else {
          leg[input.dataset.side] = resolveAirport(input.value, leg[input.dataset.side]);
        }
      });
    }

    // add / remove a leg or a stopover: read what is on screen, change the shape, redraw
    function editFlights(fn) {
      readFlightCard();
      fn();
      renderFlightCard();
    }

    function addLeg() {
      // a new leg starts where the trip currently is — the last flight that was not the
      // way home, since chaining off the return leg would start it back at TLV. One end
      // pre-filled, so only the other has to be typed.
      const prior = [...flightLegs].reverse().find((l) => l.kind !== 'return');
      const last = flightLegs[flightLegs.length - 1];
      flightLegs.push({
        kind: 'inner',
        day: Math.min((prior ? prior.day : (last ? last.day : 0)) + 1, ctx.trip.days),
        from: prior ? { ...prior.to } : { code: '', name: '' },
        to: { code: '', name: '' },
        depart: '', arrive: '', stops: [],
      });
    }

    async function saveFlights() {
      if (flightsBusy || busy || !flightLegs) return;
      readFlightCard();
      const legs = flightLegs;
      const named = (a) => !!(a && (a.code || a.name));
      if (!legs.length || legs.some((l) => !named(l.from) || !named(l.to))) {
        TripPages.toast('לכל טיסה צריך שדה תעופה בשני הקצוות');
        return;
      }
      flightsBusy = true;
      busy = true;
      renderFlightCard();
      paint();
      try {
        const r = await api(ctx, '/flights', { method: 'POST', body: JSON.stringify({ legs }) });
        state = r.state;
        ctx.trip.plan_state = state;
        if (r.items) ctx.replaceItems(r.items);
        if (r.said) msgs.push({ role: 'user', text: r.said, payload: { receipt: true } });
        if (r.follow) msgs.push(shape(r.follow));
        milestone(r.milestone);
        flightsOpen = false;
        flightLegs = null;
        flightCard = null;
        flightsFrom = null;
        flightsBusy = false;
        busy = false;
        paint();
        if (r.quota) { outOfQuota(r.quota); return; }
        drainNext();
        TripPages.toast('הטיסות נכנסו למסלול ✓', 'ok');
        TRIPMAKER.track?.('plan_flights', { code: ctx.trip.share_code, legs: legs.length });
      } catch (err) {
        flightsBusy = false;
        busy = false;
        renderFlightCard();
        paint();
        TripPages.toast((err && err.message) || 'לא הצלחתי לשמור את הטיסות');
      }
    }

    // "אין לנו טיסות עדיין" — the stage moves on and nothing is written. Reopened from
    // the chip, the same button is a plain ביטול and touches nothing at all.
    async function skipFlights() {
      if (flightsBusy || busy) return;
      if (flightsOpen) {
        flightsOpen = false;
        flightLegs = null;
        flightCard = null;
        flightsFrom = null;
        paint();
        return;
      }
      flightsBusy = true;
      busy = true;
      renderFlightCard();
      paint();
      try {
        const r = await api(ctx, '/flights', { method: 'POST', body: JSON.stringify({ skip: true }) });
        state = r.state;
        ctx.trip.plan_state = state;
        if (r.items) ctx.replaceItems(r.items);
        if (r.said) msgs.push({ role: 'user', text: r.said, payload: { receipt: true } });
        if (r.follow) msgs.push(shape(r.follow));
        milestone(r.milestone);
        flightLegs = null;
        flightCard = null;
        flightsFrom = null;
        flightsBusy = false;
        busy = false;
        paint();
        if (r.quota) outOfQuota(r.quota);
        else drainNext();
      } catch (err) {
        flightsBusy = false;
        busy = false;
        renderFlightCard();
        paint();
        TripPages.toast((err && err.message) || 'לא הצלחתי — נסו שוב');
      }
    }

    // the opening sentence painted before the thread arrived, kept until it does: a paint
    // before load (the composer's own first paint) must not blank the chat back to nothing
    const placeholder = thread.innerHTML;
    // the opening grows once: the stored message starts with the very sentence already on
    // screen, so that part stays put and only the rest fades in after it
    let grown = !hello;
    const pendingHtml = () => `
      <div class="chat-msg user chat-in chat-pending"><div class="chat-bubble">${esc(nextQ)}</div>
        <small class="chat-pending-note">יישלח ברגע שאסיים לענות</small></div>`;
    function growOpening() {
      if (grown || !loaded) return;
      grown = true;
      const bubble = thread.querySelector('.chat-msg.ai .chat-bubble');
      const text = msgs[0] && msgs[0].role === 'ai' ? msgs[0].text || '' : '';
      if (!bubble || !text.startsWith(hello)) return;
      bubble.innerHTML = `${esc(hello)} <span class="chat-rest">${esc(text.slice(hello.length).trim())}</span>`;
    }

    function paint() {
      if (busy && !busySince) busySince = Date.now();
      if (!busy) busySince = 0;
      const la = latestApplied();
      syncCalendar();
      syncFlights();
      if (!loaded && !msgs.length) {
        if (!thread.querySelector('.chat-msg.ai')) thread.innerHTML = placeholder; // never re-animate it
        thread.querySelector('.chat-pending')?.remove();
        if (nextQ) thread.insertAdjacentHTML('beforeend', pendingHtml());
        paintChips();
        paintMode();
        return;
      }
      thread.innerHTML = msgs.map((m, i) => msgHtml(m, i, la, ctx)).join('') +
        (dayAreas ? areaCalendarHtml(ctx, dayAreas, palette, paintArea) : '');
      // re-appended, never re-rendered: the element holds what is typed in it. Its two
      // buttons are the one thing a repaint does touch — they follow `busy`, so the card
      // never offers a save while the chat is mid-turn.
      if (flightCard) {
        thread.appendChild(flightCard);
        flightCard.querySelectorAll('.fl-save, .fl-skip').forEach((b) => { b.disabled = busy || flightsBusy; });
      }
      // while a card shows its own "מכניסים למסלול…" the thinking bubble would be saying
      // the same thing twice — it waits until the card has flipped
      if (busy && !deciding) thread.insertAdjacentHTML('beforeend', `
        <div class="chat-msg ai chat-in chat-wait"><span class="chat-avatar" aria-hidden="true">🧭</span>
          <div class="chat-col"><div class="chat-bubble chat-typing" aria-label="חושב…"><i></i><i></i><i></i></div>
          ${waitNoteHtml(busySince)}</div></div>`);
      // the turn typed ahead sits under the dots, plainly not sent yet
      if (nextQ) thread.insertAdjacentHTML('beforeend', pendingHtml());
      foot.querySelector('.chat-send').classList.toggle('is-busy', busy);
      input.placeholder = busy ? 'אפשר כבר לכתוב — אשלח כשאסיים' : 'כתבו לי מה תרצו…';
      paintChips();
      paintMode();
      growOpening();
      painted = scroller.settle(msgs, painted, loaded);
      if (dockOwed) {
        dockOwed = false;
        // the picks for the free days are due now, with everything the conversation just
        // settled behind them — the server started the pass as it wrote the milestone, and
        // this is the page joining it, so the itinerary one tap away is already filling
        TripDayRecs.start();
        // the message lands first, the tabs arrive under it a beat later, and only then
        // does the thread settle on the panel: a normal turn scrolls to the START of the
        // new answer, and here the end of it — the two ways on — is the whole point
        setTimeout(() => {
          TripPages.revealDock({ spark: true });
          setTimeout(() => body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }), 700);
        }, 500);
      }
    }

    // the day's allowance is spent: the gentle card, with the referral numbers filled
    // in as soon as they arrive
    async function outOfQuota(kind) {
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
        // the server reads the split in the model's shape (day_from/day_to)
        const areas = blocks.map((b) => ({ area: b.area, day_from: b.from, day_to: b.to, cities: b.cities }));
        const r = await api(ctx, '', { method: 'PATCH', body: JSON.stringify({ areas }) });
        state = r.state;
        ctx.trip.plan_state = state;
      } catch (err) { TripPages.toast(err.message || 'לא הצלחתי לשמור את החלוקה'); return; }
      dayAreas = null;
      send('מאשרים את החלוקה: ' + blocks.map((b) => `${b.area} ימים ${b.from}–${b.to}`).join(', '), { receipt: true });
    }

    const shape = (row) => ({ ...row, cards: (row.payload?.cards || []).map((c) => TripRecs.fromServerCard(c, ctx)) });

    async function load() {
      try {
        const early = takePrefetch(ctx.trip.share_code);
        const r = early ? await early.catch(() => api(ctx, '')) : await api(ctx, '');
        state = r.state;
        ctx.trip.plan_state = state;
        msgs = (r.messages || []).map(shape);
        loaded = true;
      } catch (err) {
        msgs = [{ role: 'ai', text: (err && err.message) || 'לא הצלחתי לטעון את התכנון — נסו לרענן', payload: {} }];
        // nothing can be sent into a thread that did not load: what was typed goes back
        if (nextQ) { input.value = nextQ; nextQ = null; }
      }
      paint();
      flush = () => {
        if (!queued || !loaded) return;
        const q = queued;
        queued = null;
        send(q);
      };
      flush();
      drainNext();
    }

    // the turn typed ahead goes out once the chat is free again — never while a card is
    // still deciding, a build is running, or the thread has not loaded
    function drainNext() {
      if (!nextQ || busy || !loaded || building) return;
      const q = nextQ;
      nextQ = null;
      send(q);
    }

    startWaitTicker(thread);

    // =================================================================
    //  TURNS
    // =================================================================

    async function send(text, { receipt = false } = {}) {
      const q = text.trim();
      if (!q) return;
      // mid-turn, or before the thread is in: the message waits on screen instead of the
      // tap doing nothing. One waits at a time; a second one joins it as a new line.
      if (busy || !loaded || building) {
        if (receipt) return;
        nextQ = nextQ ? `${nextQ}\n${q}` : q;
        input.value = '';
        paint();
        return;
      }
      msgs.push({ role: 'user', text: q, payload: receipt ? { receipt: true } : {} });
      busy = true;
      input.value = '';
      paint();
      try {
        const r = await api(ctx, '', { method: 'POST', body: JSON.stringify({ message: q, mode: state.mode, receipt }) });
        state = r.state;
        ctx.trip.plan_state = state;
        if (r.approved_message_id) {
          const m = msgs.find((x) => x.id === r.approved_message_id);
          if (m) m.payload = { ...m.payload, decision: 'applied', undo: true };
        }
        msgs.push(shape(r.message));
        milestone(r.milestone);
        if (r.items) ctx.replaceItems(r.items);
        await promoteAreas();
        TRIPMAKER.track?.('plan_turn', { code: ctx.trip.share_code, stage: state.stage, mode: state.mode });
        busy = false;
        paint();
        if (r.message.payload && r.message.payload.build === 'once') build(false);
        else drainNext();
      } catch (err) {
        busy = false;
        // what was typed ahead goes back into the box rather than out after a failure
        if (nextQ) { input.value = nextQ; nextQ = null; }
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
        if (r.said) msgs.push({ role: 'user', text: r.said, payload: { receipt: true } });
        if (r.state) { state = r.state; ctx.trip.plan_state = state; }
        if (r.approved_message_id) {
          const m = msgs.find((x) => x.id === r.approved_message_id);
          if (m) m.payload = { ...m.payload, decision: 'applied', undo: true };
        }
        if (r.follow) msgs.push(shape(r.follow));
        milestone(r.milestone);
        if (r.items) ctx.replaceItems(r.items);
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
      drainNext();
    }

    // The toggle used to flip without a word, and the data shows it tapped back and forth
    // — people trying to find out what it does. The flip now says it, once, in one line.
    async function switchMode(mode) {
      state.mode = mode;
      paintMode(); // the button flips at the tap; the write follows
      TripPages.toast(mode === 'auto'
        ? 'מצב אוטומטי: שינויים נכנסים למסלול מיד, ואפשר לבטל כל אחד'
        : 'מצב ידני: כל שינוי מחכה לאישור שלכם לפני שהוא נכנס');
      state = await setMode(ctx.trip, mode);
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
        overlay.say('שומרים את הטיול… ✈️');
        state = r.state;
        ctx.trip.plan_state = state;
        await promoteAreas(r.plan);
        TRIPMAKER.track?.('plan_build', { code: ctx.trip.share_code, fill, count: (r.items || []).length });
        // the free days' picks start now, behind the same screen. The screen waits for
        // the first of them and no longer: on a month-long trip the picks are minutes
        // of model calls, and holding the traveller in front of a loading screen for
        // all of them is how they used to arrive — the rest land on the itinerary
        // itself, day after day, while it is already being read.
        if (TripDayRecs.hasFreeDays(r.items, ctx.trip.days)) {
          overlay.say('מכינים המלצות לימים הפנויים… ✨');
          await TripDayRecs.prepare(ctx.trip, {
            onProgress: (snap) => { if (snap.ready) overlay.say(`מכינים המלצות לימים הפנויים… ${snap.ready} ימים מוכנים ✨`); },
          }).catch(() => { /* the itinerary asks again on open */ });
        }
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
      // say(): a line that stays — the quips stop cycling over it
      const say = (text) => { clearInterval(timer); sub.classList.remove('swap'); sub.textContent = text; };
      return { sub, say, remove: () => { clearInterval(timer); el.remove(); } };
    }

    // =================================================================
    //  WIRING
    // =================================================================

    thread.addEventListener('click', (e) => {
      if (handleCardClick(e, ctx)) return;
      // "עבור לדף המסלול" — the chat closes the way its own back button closes it, so
      // the history entry it holds goes with it
      if (e.target.closest('.pu-go')) { TripPages.close(); return; }
      const day = e.target.closest('.rc-day');
      if (day && dayAreas) { dayAreas[+day.dataset.d] = paintArea; paint(); return; }
      const pal = e.target.closest('.rp-area');
      if (pal) { paintArea = pal.dataset.a; paint(); return; }
      if (e.target.closest('.pa-confirm')) { confirmAreas(); return; }
      const fl = e.target.closest('.fl-x, .fl-add, .fl-save, .fl-skip');
      if (fl) {
        if (fl.classList.contains('fl-save')) { saveFlights(); return; }
        if (fl.classList.contains('fl-skip')) { skipFlights(); return; }
        const i = +fl.dataset.i;
        const k = +fl.dataset.k;
        if (fl.dataset.act === 'leg-add') editFlights(addLeg);
        else if (fl.dataset.act === 'leg-del') editFlights(() => flightLegs.splice(i, 1));
        else if (fl.dataset.act === 'stop-add') editFlights(() => flightLegs[i].stops.push({ code: '', name: '', arrive: '', depart: '' }));
        else if (fl.dataset.act === 'stop-del') editFlights(() => flightLegs[i].stops.splice(k, 1));
        return;
      }
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
    modeBtn.onclick = () => switchMode(state.mode === 'auto' ? 'manual' : 'auto');

    paint();
    load();
  }

  // the quota card and its handler are shared with the recommendations chat
  return { render, prefetch, waitNoteHtml, startWaitTicker, arrival, setMode, say, quotaMsg, quotaMsgHtml, handleCardClick, loadReferral, referral: () => referralInfo, changeCardHtml };
})();
