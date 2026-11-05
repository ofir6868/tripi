// The /my page: every trip the traveller has, ordered by the only thing that matters
// on a phone — when it is. The trip under way (or the next one) is a big card with
// its countdown; everything else is a row: ahead, still being planned, and behind.
// Trips friends let you into sit among your own, by date, with a "משותף" tag —
// a joined trip to Nepal in March is "the next trip" exactly like one you made.
//
// Until 2026-11 this was a grid of 250px cover cards in three ownership sections:
// on a phone, seven trips were seven screens of scrolling, and no card said when.
//
// This lived inline in my.html until the page's scripts were deferred. A deferred
// script executes after parsing but BEFORE DOMContentLoaded, while an inline script
// runs during it — so an inline DOMContentLoaded listener is always registered
// first, and would run before common.js has built the auth modal this page opens
// for a signed-out visitor. As a file loaded last, it registers last and runs last,
// which is the order it always relied on.
document.addEventListener('DOMContentLoaded', async () => {
  const wrap = document.getElementById('my-wrap');
  const sub = document.getElementById('my-sub');
  const esc = TRIPMAKER.esc;
  const done = () => wrap.removeAttribute('aria-busy');

  // signed out: the page says what it is for, instead of a blank under the modal
  if (!TRIPMAKER.user) {
    done();
    wrap.innerHTML = `
      <div class="my-gate glass">
        <div class="my-gate-art" aria-hidden="true"><span>🧳</span></div>
        <h2>כל הטיולים שלכם, בכל מכשיר</h2>
        <p>מתחברים — ורואים כאן את הטיול הבא עם ספירה לאחור, את מה שבתכנון, ואת כל מה שכבר עשיתם.</p>
        <div class="my-gate-actions">
          <button type="button" class="btn btn-amber btn-lg" data-auth="login">התחברות</button>
          <button type="button" class="btn btn-ghost btn-lg" data-auth="register">הרשמה חינם</button>
        </div>
      </div>`;
    wrap.querySelectorAll('[data-auth]').forEach((b) => {
      b.onclick = () => openAuthModal(() => location.reload(), b.dataset.auth, 'my_trips');
    });
    openAuthModal(() => location.reload(), 'login', 'my_trips');
    return;
  }

  const flags = (t) => {
    const ccs = [...new Set((t.destinations || []).map((d) => d.cc).filter(Boolean))].slice(0, 3);
    if (!ccs.length && window.COUNTRIES) { const cc = COUNTRIES.ccByName(t.country); if (cc) ccs.push(cc); }
    return window.COUNTRIES ? ccs.map((cc) => COUNTRIES.flagHtml(cc)).join('') : '';
  };
  const place = (t) => esc(t.destination || t.country || '');
  const daysTxt = (n) => (n === 1 ? 'יום אחד' : n === 2 ? 'יומיים' : `${n} ימים`);
  const href = (t) => `/trip/${encodeURIComponent(t.share_code)}${t.is_draft && t.is_mine ? '#plan' : ''}`;
  const img = (t, cls) => (t.cover_image
    ? `<img class="${cls}" src="${esc(t.cover_image)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : '');
  const dots = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

  // ---- the next trip: big, with the countdown (or the day you're on) ----
  function feature(t) {
    const w = t.when;
    let big, small;
    if (w.phase === 'now') { big = w.dayNo; small = w.total > 1 ? `יום מתוך ${w.total}` : 'היום'; }
    else if (w.inDays === 0) { big = '🛫'; small = 'יוצאים היום'; }
    else { big = w.inDays; small = w.inDays === 1 ? 'יום ליציאה' : 'ימים ליציאה'; }
    const eyebrow = w.phase === 'now' ? '<span class="live-dot" aria-hidden="true"></span>עכשיו בטיול' : (t.is_draft ? '✍️ הטיול הבא · בתכנון' : 'הטיול הבא');
    const progress = w.phase === 'now'
      ? `<div class="mn-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${w.total}" aria-valuenow="${w.dayNo}" aria-label="יום ${w.dayNo} מתוך ${w.total}">${
        Array.from({ length: Math.min(w.total, 30) }, (_, i) => `<i class="${i + 1 < w.dayNo ? 'past' : i + 1 === w.dayNo ? 'today' : ''}"></i>`).join('')}</div>`
      : '';
    return `
      <a class="my-next${w.phase === 'now' ? ' is-now' : ''}" href="${href(t)}" data-id="${t.id}">
        ${img(t, 'mn-img')}
        <span class="mn-emoji" aria-hidden="true">${esc(t.emoji || '🧭')}</span>
        <div class="mn-shade"></div>
        <div class="mn-count" aria-hidden="true"><b>${big}</b><small>${small}</small></div>
        <div class="mn-body">
          <div class="mn-eyebrow">${eyebrow}</div>
          <h2 class="mn-title">${esc(t.title)}</h2>
          <div class="mn-meta"><span class="mn-flags">${flags(t)}</span>${place(t)} · ${TripWhen.range(w)}</div>
          ${progress}
          <div class="mn-cta">${w.phase === 'now' ? 'לתוכנית של היום' : t.is_draft && t.is_mine ? 'להמשיך לתכנן' : 'לפתוח את הטיול'} <span aria-hidden="true">←</span></div>
        </div>
        ${t.is_mine ? '' : '<span class="mt-tag shared mn-tag">👥 משותף</span>'}
      </a>`;
  }

  // ---- a row: thumbnail, title, where + when, and one chip that says the time ----
  function row(t) {
    const w = t.when;
    const chip = t.is_draft && w.phase !== 'past'
      ? `<span class="mt-chip draft">✍️ ${w.phase === 'next' ? TripWhen.label(w) : 'בתכנון'}</span>`
      : `<span class="mt-chip ${w.phase}">${TripWhen.label(w)}</span>`;
    const when = w.start ? TripWhen.range(w) + ' · ' + daysTxt(w.days) : daysTxt(w.days);
    return `
      <div class="mt-row ${w.phase}" data-id="${t.id}">
        <a class="mt-link" href="${href(t)}">
          <span class="mt-thumb"><span class="mt-emoji" aria-hidden="true">${esc(t.emoji || '🧭')}</span>${img(t, 'mt-img')}</span>
          <span class="mt-text">
            <span class="mt-title">${esc(t.title)}</span>
            <span class="mt-place">${t.is_mine ? '' : '<span class="mt-tag shared">👥 משותף</span>'}<span class="mt-flags">${flags(t)}</span>${place(t)}</span>
            <span class="mt-when">${when}</span>
          </span>
          ${chip}
        </a>
        <button type="button" class="mt-more" aria-label="פעולות ל${esc(t.title)}" data-id="${t.id}">${dots}</button>
      </div>`;
  }

  const section = (key, title, list, hint = '') => (list.length ? `
      <section class="mt-sec" data-sec="${key}">
        <h2 class="mt-sec-title">${title}<span class="mt-count">${list.length}</span></h2>
        ${hint ? `<p class="mt-sec-hint">${hint}</p>` : ''}
        <div class="mt-list">${list.map(row).join('')}</div>
      </section>` : '');

  // ---- empty: a first trip, or a friend's code ----
  function empty() {
    sub.textContent = 'כאן יחכו הטיול הבא, מה שבתכנון, וכל מה שכבר עשיתם';
    wrap.innerHTML = `
      <div class="my-empty glass">
        <div class="my-gate-art" aria-hidden="true"><span>🗺️</span></div>
        <h2>עוד אין כאן טיולים</h2>
        <p>בוחרים יעד ותאריכים, וה-AI בונה איתכם מסלול <span class="nowrap">יום־אחר־יום</span>.</p>
        <a class="btn btn-amber btn-lg" href="/plan">+ מתכננים טיול ראשון</a>
        <form class="my-join" id="my-join" novalidate>
          <label for="my-join-code">קיבלתם קוד טיול מחבר?</label>
          <div class="my-join-row">
            <input id="my-join-code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="off" placeholder="6 ספרות" dir="ltr">
            <button type="submit" class="btn btn-ghost">פתיחה</button>
          </div>
          <div class="form-error" id="my-join-err" role="alert"></div>
        </form>
      </div>`;
    const form = wrap.querySelector('#my-join');
    const input = form.querySelector('input');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) { form.querySelector('#my-join-err').textContent = 'קוד טיול הוא 6 ספרות'; input.focus(); return; }
      location.href = '/trip/' + code;
    });
  }

  let trips;
  try {
    trips = await TRIPMAKER.api('/api/my-trips');
  } catch (err) {
    done();
    wrap.innerHTML = `<div class="my-empty glass"><h2>לא הצלחנו לטעון את הטיולים</h2><p>${esc(err.message)}</p>
      <button type="button" class="btn btn-ghost" onclick="location.reload()">לנסות שוב</button></div>`;
    return;
  }
  done();

  // a guest's trips live on a token in this browser and nowhere else — the one
  // place this is said out loud, above the trips it is about
  if (TRIPMAKER.isGuest() && trips.length) {
    const note = document.createElement('div');
    note.className = 'guest-note glass';
    note.innerHTML = `<span>🧳 הטיולים האלה שמורים בדפדפן הזה בלבד. חשבון חינם שומר אותם לכל מכשיר — ולא מאבד כלום.</span>
      <button type="button" class="btn btn-amber" id="guest-signup">הרשמה</button>`;
    wrap.before(note);
    note.querySelector('#guest-signup').onclick = () => openAuthModal(() => location.reload(), 'register', 'my_trips_guest');
  }
  if (!trips.length) { empty(); return; }

  const byId = new Map();
  trips.forEach((t) => { t.when = TripWhen.of(t); byId.set(String(t.id), t); });

  const render = () => {
    const all = [...byId.values()];
    const now = all.filter((t) => t.when.phase === 'now').sort((a, b) => a.when.start - b.when.start);
    const next = all.filter((t) => t.when.phase === 'next').sort((a, b) => a.when.start - b.when.start);
    // the big card: the trip under way, else the nearest dated one ahead
    const hero = now[0] || next[0] || null;
    const rest = all.filter((t) => t !== hero);
    const ahead = rest.filter((t) => (t.when.phase === 'now' || t.when.phase === 'next') && !(t.is_draft && t.is_mine))
      .sort((a, b) => a.when.start - b.when.start);
    // still being planned: my drafts, dated or not, and any undated trip — a trip
    // with no date is a plan, not a memory
    const planning = rest.filter((t) => t.when.phase !== 'past' && ((t.is_draft && t.is_mine) || t.when.phase === 'undated'))
      .sort((a, b) => (a.when.start || Infinity) - (b.when.start || Infinity));
    const past = rest.filter((t) => t.when.phase === 'past').sort((a, b) => b.when.end - a.when.end);

    const counts = [];
    const aheadN = now.length + next.length;
    if (aheadN) counts.push(aheadN === 1 ? 'טיול אחד לפניכם' : `${aheadN} טיולים לפניכם`);
    if (past.length) counts.push(past.length === 1 ? 'אחד מאחוריכם' : `${past.length} מאחוריכם`);
    sub.textContent = counts.join(' · ') || 'המסלולים שיצרתם והטיולים שהצטרפתם אליהם, במקום אחד';

    wrap.innerHTML = `
      ${hero ? feature(hero) : ''}
      ${section('ahead', 'בקרוב', ahead)}
      ${section('planning', 'בתכנון', planning, ahead.length || hero ? '' : 'כשקובעים תאריך הטיול עובר ל"בקרוב", עם ספירה לאחור')}
      ${section('past', 'טיולים שהיו', past)}
      <a class="my-new" href="/plan"><span aria-hidden="true">+</span> טיול חדש</a>`;
    if (!byId.size) empty();
  };
  render();

  // ---- the ⋯ sheet: copy the code, send it, delete (owner only) ----
  let sheet = null;
  const closeSheet = () => {
    if (!sheet) return;
    const s = sheet; sheet = null;
    s.classList.remove('open');
    setTimeout(() => s.remove(), 220);
  };
  function openSheet(t) {
    closeSheet();
    const shareText = `מצטרפים לטיול שלי "${t.title}" ב-TRIP MAKER — קוד ${t.share_code}\n${location.origin}/trip/${t.share_code}`;
    const el = document.createElement('div');
    el.className = 'mt-sheet-back';
    el.innerHTML = `
      <div class="mt-sheet glass" role="dialog" aria-modal="true" aria-label="${esc(t.title)}">
        <div class="mt-sheet-grab" aria-hidden="true"></div>
        <div class="mt-sheet-head">
          <span class="mt-thumb sm"><span class="mt-emoji" aria-hidden="true">${esc(t.emoji || '🧭')}</span>${img(t, 'mt-img')}</span>
          <div><b>${esc(t.title)}</b><small>${t.when.start ? TripWhen.range(t.when) : place(t)}</small></div>
        </div>
        <a class="mt-act" href="${href(t)}"><span aria-hidden="true">🧭</span>פתיחת הטיול</a>
        ${t.is_draft ? '' : `
        <button type="button" class="mt-act" data-act="copy"><span aria-hidden="true">#</span>העתקת קוד הטיול <b dir="ltr">${esc(t.share_code)}</b></button>
        <a class="mt-act" data-act="wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText)}">${TRIPMAKER.waIcon}שליחה לחברים בוואטסאפ</a>`}
        ${t.is_mine ? '<button type="button" class="mt-act danger" data-act="del"><span aria-hidden="true">🗑</span>מחיקת הטיול</button>' : ''}
        <button type="button" class="mt-act cancel" data-act="close">סגירה</button>
      </div>`;
    document.body.appendChild(el);
    sheet = el;
    requestAnimationFrame(() => el.classList.add('open'));
    el.addEventListener('click', async (e) => {
      if (e.target === el) return closeSheet();
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') return closeSheet();
      if (act === 'wa') { setTimeout(closeSheet, 300); return; }
      if (act === 'copy') {
        const ok = await TRIPMAKER.copy(t.share_code);
        b.innerHTML = ok ? '<span aria-hidden="true">✓</span>הקוד הועתק' : '<span aria-hidden="true">!</span>ההעתקה נכשלה';
        setTimeout(closeSheet, 700);
        return;
      }
      if (act === 'del') {
        // two taps, in place — the second one is the confirmation
        if (!b.classList.contains('armed')) {
          b.classList.add('armed');
          b.innerHTML = '<span aria-hidden="true">⚠️</span>למחוק לצמיתות? לחיצה נוספת מוחקת';
          return;
        }
        if (b.disabled) return;
        b.disabled = true;
        b.textContent = 'מוחקים…';
        try { await TRIPMAKER.api('/api/trips/' + t.id, { method: 'DELETE' }); }
        catch (err) { b.disabled = false; b.classList.remove('armed'); b.textContent = err.message || 'המחיקה נכשלה'; return; }
        closeSheet();
        const node = wrap.querySelector(`[data-id="${t.id}"]`);
        byId.delete(String(t.id));
        if (node) { node.classList.add('leaving'); setTimeout(render, 260); } else render();
      }
    });
  }
  wrap.addEventListener('click', (e) => {
    const more = e.target.closest('.mt-more');
    if (!more) return;
    e.preventDefault();
    const t = byId.get(more.dataset.id);
    if (t) openSheet(t);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
});
