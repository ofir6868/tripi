// The AI screen's shared pieces — what תכנון and המלצות have in common once they look
// like one product instead of two chats that grew up separately.
//
// The look follows the phone screens of the big assistants, down to the details that
// make them feel settled: the assistant's words sit on the page, not in a box; the
// traveller's words sit in one soft bubble at the far edge; the composer is a single
// pill that grows with what is typed, a + at its start for everything that is not
// typing (a document, a pasted plan, the connectors), and a round send button that
// becomes a quiet ring while the answer is on its way. Under an answer that looked
// things up, a row of small pills says what it checked — and while it is still looking,
// the same row says what it is checking right now (polled from the turn's progress).
//
// Nothing here knows about turns, ops or the trip; the two chats keep their own logic
// and call in for the pieces: md() for the assistant's text, workHtml() for the tool
// row, composer() for the pill, plusMenu() for the +, importSheet() for the pasted
// plan, connectorsSheet() for the traveller's accounts, progressPoll() for the live
// row, scrollButton() for the way back down.
const ChatUI = (() => {
  const esc = (s) => TRIPMAKER.esc(s);

  const ICON = {
    up: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    down: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    clip: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.4 11.1-8.9 8.9a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/></svg>',
    import: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    plug: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0Z"/><path d="M12 18v4"/></svg>',
    copy: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    rebuild: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>',
    fix: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4Z"/><path d="m16 8 .01 0"/></svg>',
  };

  // =================================================================
  //  TEXT — the model writes a little markdown; it is rendered, safely
  // =================================================================
  //
  // Escape first, then the few forms a chat answer uses: **bold**, bullet and numbered
  // lists, paragraphs, and bare https links (target blank, no referrer). Anything else
  // stays as typed. The model is asked for short answers, so this is a renderer for
  // emphasis and lists, not a markdown engine.
  const URL_RE = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;
  function inline(s) {
    let h = esc(s);
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(URL_RE, (u) => {
      let label = u.replace(/^https?:\/\/(www\.)?/, '');
      if (label.length > 40) label = label.slice(0, 38) + '…';
      return `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
    });
    return h;
  }
  function md(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    let list = null; // { tag, items }
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    for (const raw of lines) {
      const line = raw.trim();
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      const num = /^\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || num) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(inline((bullet || num)[1]));
        continue;
      }
      flushList();
      if (!line) { flushPara(); continue; }
      const head = /^#{1,3}\s+(.*)$/.exec(line);
      if (head) { flushPara(); out.push(`<p><b>${inline(head[1])}</b></p>`); continue; }
      para.push(inline(line));
    }
    flushList();
    flushPara();
    return out.join('');
  }

  // =================================================================
  //  THE WORK ROW — what the turn checked, or is checking
  // =================================================================
  function workHtml(steps, { live = false } = {}) {
    const list = Array.isArray(steps) ? steps.filter((s) => s && s.tool) : [];
    if (!list.length) return live ? '<div class="chat-work is-live" hidden></div>' : '';
    const pills = list.map((s) => `<span class="cw-pill is-${s.status || 'done'}"><span class="cw-ic" aria-hidden="true">${esc(s.icon || '🛠️')}</span>${esc(s.label || s.tool)}${s.detail ? `<em>${esc(s.detail)}</em>` : ''}</span>`).join('');
    return `<div class="chat-work${live ? ' is-live' : ''}">${pills}</div>`;
  }
  // the live row is repainted in place, so a poll never rebuilds the thread
  function paintWork(el, steps) {
    if (!el) return;
    const list = Array.isArray(steps) ? steps : [];
    el.hidden = !list.length;
    if (list.length) el.innerHTML = workHtml(list, { live: true }).replace(/^<div[^>]*>|<\/div>$/g, '');
  }

  // GET /api/ai/progress/:id every so often while a turn runs; stop() ends it
  function progressPoll(turnId, onSteps, { every = 1500 } = {}) {
    let stopped = false;
    let timer = null;
    let seen = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await TRIPMAKER.api(`/api/ai/progress/${encodeURIComponent(turnId)}`);
        if (stopped) return;
        const steps = r.steps || [];
        if (steps.length || seen) { seen = steps.length; onSteps(steps); }
      } catch { /* a missed poll is a missed poll */ }
      if (!stopped) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, every);
    return () => { stopped = true; clearTimeout(timer); };
  }
  const turnId = () => (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  // the small actions under an assistant message
  const actionsHtml = () => `<div class="chat-actions"><button type="button" class="ca-btn ca-copy" aria-label="העתקה">${ICON.copy}</button></div>`;
  function handleActionClick(e, text) {
    const copy = e.target.closest('.ca-copy');
    if (!copy) return false;
    const plain = String(text || '').replace(/\*\*/g, '');
    (TRIPMAKER.copy ? TRIPMAKER.copy(plain) : navigator.clipboard.writeText(plain)).then(() => {
      copy.classList.add('is-done');
      copy.innerHTML = ICON.check;
      setTimeout(() => { copy.classList.remove('is-done'); copy.innerHTML = ICON.copy; }, 1400);
    }).catch(() => TripPages.toast('לא הצלחתי להעתיק'));
    return true;
  }

  // =================================================================
  //  THE COMPOSER
  // =================================================================
  //
  // One pill: + at the start, a textarea that grows to five lines, a round send button.
  // Enter sends on a keyboard, inserts a line on a touch screen (where the button is the
  // way to send, as in every chat on the phone). While the turn is out the button turns
  // into a ring; the tap still lands — the chats queue it.
  function composer(foot, { id = 'chat', placeholder = '', maxLength = 400, onSend, plusLabel = 'עוד' } = {}) {
    foot.insertAdjacentHTML('beforeend', `
      <div class="chat-dock" id="${id}-dock">
        <form class="chat-pill" id="${id}-form">
          <button type="button" class="cp-plus" id="${id}-plus" aria-label="${esc(plusLabel)}" aria-haspopup="menu">${ICON.plus}</button>
          <textarea id="${id}-input" class="cp-input" rows="1" maxlength="${maxLength}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="send"></textarea>
          <button type="submit" class="cp-send" aria-label="שליחה"><span class="cp-send-ic">${ICON.up}</span><span class="cp-ring" aria-hidden="true"></span></button>
        </form>
      </div>`);
    const form = foot.querySelector(`#${id}-form`);
    const input = foot.querySelector(`#${id}-input`);
    const plus = foot.querySelector(`#${id}-plus`);
    const send = foot.querySelector(`.cp-send`);
    const coarse = matchMedia('(pointer: coarse)').matches;
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      form.classList.toggle('is-tall', input.scrollHeight > 48);
      send.classList.toggle('has-text', !!input.value.trim());
    };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.onsubmit = (e) => { e.preventDefault(); onSend(input.value); };
    grow();
    return {
      form, input, plus, send,
      value: () => input.value,
      clear: () => { input.value = ''; grow(); },
      set: (v) => { input.value = v; grow(); },
      focus: () => input.focus(),
      setBusy: (busy) => { send.classList.toggle('is-busy', !!busy); form.classList.toggle('is-busy', !!busy); },
      setPlaceholder: (p) => { input.placeholder = p; },
      setPlusState: (cls, on) => plus.classList.toggle(cls, !!on),
    };
  }

  // the + menu: a small sheet that rises from the button, one line per thing the chat
  // can take besides words. Closes on a pick, a tap outside, Escape.
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener('click', (e) => { if (openMenu && !e.target.closest('.cp-menu, .cp-plus')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  function plusMenu(button, items) {
    if (openMenu) { closeMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'cp-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.filter(Boolean).map((it, i) => `
      <button type="button" class="cp-item${it.disabled ? ' is-disabled' : ''}" role="menuitem" data-i="${i}">
        <span class="cpi-ic" aria-hidden="true">${it.icon}</span>
        <span class="cpi-body"><span class="cpi-label">${esc(it.label)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
        ${it.badge ? `<span class="cpi-badge">${esc(it.badge)}</span>` : ''}
      </button>`).join('');
    const dock = button.closest('.chat-dock') || button.parentElement;
    dock.appendChild(menu);
    menu.querySelectorAll('.cp-item').forEach((b) => {
      b.onclick = () => { const it = items.filter(Boolean)[+b.dataset.i]; closeMenu(); if (it && !it.disabled) it.onClick(); };
    });
    openMenu = menu;
    requestAnimationFrame(() => menu.classList.add('open'));
  }

  // the floating "back to the bottom" button over a thread that has been scrolled up
  function scrollButton(body) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-down';
    btn.setAttribute('aria-label', 'לסוף השיחה');
    btn.innerHTML = ICON.down;
    btn.hidden = true;
    body.parentElement.appendChild(btn);
    const check = () => { btn.hidden = body.scrollHeight - body.clientHeight - body.scrollTop < 160; };
    body.addEventListener('scroll', check, { passive: true });
    btn.onclick = () => body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
    return { check };
  }

  // =================================================================
  //  IMPORT — a plan written elsewhere, pasted in whole
  // =================================================================
  //
  // Easy to reach (the + menu and the header), never in the way: a sheet with one big
  // box and two ways to use what is in it, each named by what it does to the trip.
  // "בנה מחדש" throws the itinerary away for the text; "תקן" keeps what matches and
  // changes the rest. The text is the truth in both — the server's prompt says so.
  const IMPORT_MIN = 40;
  const IMPORT_MAX = 16000;
  const IMPORT_LINES = ['קוראים את התוכנית…', 'מחלקים לימים…', 'מאמתים כל מקום במפה…', 'כותבים את התחנות למסלול…', 'עוד רגע — מסדרים את השעות…'];
  function importSheet(ctx, { onDone } = {}) {
    const hasItems = !!(ctx.state && ctx.state.items && ctx.state.items.length);
    TripPages.sheet('import-sheet', {
      title: `${ICON.import} ייבוא תוכנית`,
      sub: 'הדביקו תוכנית מ-ChatGPT, Claude, Gemini, חבר או פורום — והיא הופכת למסלול הזה',
      cls: 'import-card',
      html: `
        <textarea class="imp-text" rows="9" maxlength="${IMPORT_MAX}" placeholder="יום 1 — נחיתה בטוקיו, שוק צוקיג׳י בבוקר, אחר הצהריים שינג׳וקו…&#10;יום 2 — …" aria-label="התוכנית"></textarea>
        <div class="imp-meta"><span class="imp-count">0 תווים</span><span class="imp-hint">התוכנית היא מקור האמת: מה שכתוב בה נכנס, מה שלא — לא.</span></div>
        <div class="imp-modes">
          <button type="button" class="imp-mode" data-mode="rebuild">
            <span class="im-ic">${ICON.rebuild}</span>
            <span class="im-body"><b>בנה מחדש</b><small>${hasItems ? 'מוחק את המסלול הנוכחי ובונה אותו מהתוכנית בלבד' : 'בונה את המסלול מהתוכנית, יום אחרי יום'}</small></span>
          </button>
          <button type="button" class="imp-mode" data-mode="fix"${hasItems ? '' : ' disabled'}>
            <span class="im-ic">${ICON.fix}</span>
            <span class="im-body"><b>תקן</b><small>${hasItems ? 'משאיר מה שתואם, מוסיף מה שחסר, מסיר מה שלא בתוכנית' : 'אין עדיין מסלול לתקן — התחילו מבנייה'}</small></span>
          </button>
        </div>
        <div class="imp-busy" hidden><span class="chat-orb" aria-hidden="true"></span><span class="imp-busy-line"></span></div>
        <p class="imp-foot">עולה בנייה אחת מהמכסה היומית · עד ${IMPORT_MAX.toLocaleString('en-US')} תווים</p>`,
      onOpen: (body) => {
        const ta = body.querySelector('.imp-text');
        const count = body.querySelector('.imp-count');
        const modes = [...body.querySelectorAll('.imp-mode')];
        const busyEl = body.querySelector('.imp-busy');
        const line = body.querySelector('.imp-busy-line');
        const paint = () => {
          const n = ta.value.trim().length;
          count.textContent = `${n.toLocaleString('he-IL')} תווים`;
          count.classList.toggle('is-short', n > 0 && n < IMPORT_MIN);
          modes.forEach((b) => { if (!(b.dataset.mode === 'fix' && !hasItems)) b.disabled = n < IMPORT_MIN; });
        };
        ta.addEventListener('input', paint);
        paint();
        setTimeout(() => ta.focus(), 250);
        // the clipboard is probably exactly what they came with
        ta.addEventListener('paste', () => setTimeout(paint, 0));
        modes.forEach((b) => {
          b.onclick = async () => {
            const mode = b.dataset.mode;
            const text = ta.value.trim();
            if (text.length < IMPORT_MIN) return;
            if (mode === 'rebuild' && hasItems && !confirm('לבנות מחדש? המסלול הנוכחי יימחק וייבנה מהתוכנית שהדבקתם.')) return;
            modes.forEach((x) => { x.disabled = true; x.classList.toggle('is-picked', x === b); });
            ta.disabled = true;
            busyEl.hidden = false;
            let i = 0;
            line.textContent = IMPORT_LINES[0];
            const timer = setInterval(() => { i = (i + 1) % IMPORT_LINES.length; line.textContent = IMPORT_LINES[i]; }, 3200);
            try {
              const r = await TRIPMAKER.api(`/api/trips/code/${ctx.trip.share_code}/ai-import`, { method: 'POST', body: JSON.stringify({ mode, text }) });
              clearInterval(timer);
              TRIPMAKER.track?.('ai_import', { code: ctx.trip.share_code, mode, chars: text.length, added: r.imported?.added });
              TripPages.closeSheet(() => onDone?.(r, mode));
            } catch (err) {
              clearInterval(timer);
              busyEl.hidden = true;
              ta.disabled = false;
              modes.forEach((x) => x.classList.remove('is-picked'));
              paint();
              if (err && err.quota) { TripPages.closeSheet(() => onDone?.(null, mode, err)); return; }
              TripPages.toast((err && err.message) || 'הייבוא נכשל — נסו שוב');
            }
          };
        });
      },
    });
  }

  // the card a finished import leaves in the thread
  function importedHtml(imp) {
    if (!imp) return '';
    const parts = [];
    if (imp.added) parts.push(`${imp.added} נוספו`);
    if (imp.updated) parts.push(`${imp.updated} עודכנו`);
    if (imp.removed) parts.push(`${imp.removed} הוסרו`);
    if (imp.actions) parts.push(`${imp.actions} שינויים במלונות/תקציב/תאריכים`);
    const ignored = (imp.ignored || []).length
      ? `<ul class="pc-ignored">${imp.ignored.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '';
    return `<div class="plan-card pc-applied pc-imported"><div class="pc-head">${ICON.import} ${imp.mode === 'fix' ? 'המסלול תוקן לפי התוכנית' : 'המסלול נבנה מהתוכנית'}</div>
      <p class="pc-text-p">${esc(parts.join(' · ') || 'בלי שינוי')}</p>${ignored ? `<div class="pc-note">לא נכנס:</div>${ignored}` : ''}</div>`;
  }

  // =================================================================
  //  CONNECTORS — the traveller's own accounts, one switch each
  // =================================================================
  function connectorsSheet(ctx) {
    TripPages.sheet('connectors-sheet', {
      title: `${ICON.plug} חיבורים`,
      sub: 'מה ה-AI רשאי לקרוא מהחשבונות שלכם. הכול לקריאה בלבד, הכול באישורכם, והכול ניתן לניתוק בכל רגע',
      cls: 'connectors-card',
      html: '<div class="cn-list"><div class="cn-loading"><span class="chat-orb" aria-hidden="true"></span> טוענים…</div></div>',
      onOpen: async (body) => {
        const list = body.querySelector('.cn-list');
        let st;
        try { st = await TRIPMAKER.api('/api/connectors'); } catch (err) {
          list.innerHTML = `<p class="pc-text-p">${esc((err && err.message) || 'לא הצלחתי לטעון את החיבורים')}</p>`;
          return;
        }
        if (!st.configured) {
          list.innerHTML = '<div class="plan-card pc-quota"><div class="pc-head">עוד לא זמין כאן</div><p class="pc-text-p">חיבור חשבון Google לא הוגדר בשרת הזה. כשיוגדר, תוכלו לתת ל-AI לקרוא את היומן, המיילים והקבצים שלכם — רק לקריאה, ורק מה שתבחרו.</p></div>';
          return;
        }
        const paint = () => {
          list.innerHTML = `
            ${st.account ? `<p class="cn-account">מחובר לחשבון <b>${esc(st.account)}</b></p>` : '<p class="cn-account">בהפעלה הראשונה Google יבקש אישור — לכל שירות בנפרד, לקריאה בלבד.</p>'}
            ${st.services.map((s) => `
              <label class="cn-row${s.on ? ' is-on' : ''}">
                <span class="cn-ic" aria-hidden="true">${esc(s.icon)}</span>
                <span class="cn-body"><b>${esc(s.label)}</b><small>${esc(s.sees)}</small></span>
                <span class="cn-switch"><input type="checkbox" data-key="${esc(s.key)}"${s.on ? ' checked' : ''}><i></i></span>
              </label>`).join('')}
            <p class="cn-foot">ה-AI קורא רק כשאתם שואלים משהו שנוגע לשירות, ומה שהוא מוצא נכנס לטיול דרך כרטיס שינוי כמו כל דבר אחר. הסודות נשמרים מוצפנים, וניתוק מוחק אותם.</p>`;
          list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
            cb.onchange = async () => {
              const key = cb.dataset.key;
              if (cb.checked) {
                // off to Google, and back to this very screen — the chat's hash included
                const next = location.pathname + location.hash;
                const p = new URLSearchParams({ t: TRIPMAKER.token || '', services: key, next });
                cb.disabled = true;
                TRIPMAKER.track?.('connector_start', { service: key });
                location.href = `/api/connectors/google/start?${p}`;
                return;
              }
              cb.disabled = true;
              try {
                st = await TRIPMAKER.api(`/api/connectors/google/${encodeURIComponent(key)}`, { method: 'DELETE' });
                paint();
                TripPages.toast('החיבור נותק');
              } catch (err) {
                cb.checked = true;
                cb.disabled = false;
                TripPages.toast((err && err.message) || 'לא הצלחתי לנתק');
              }
            };
          });
        };
        paint();
      },
    });
  }

  // back from Google: the query names what was switched on (or why not); say it, and
  // leave the address clean so a reload does not say it twice
  function handleReturn() {
    const q = new URLSearchParams(location.search);
    const on = q.get('connected');
    const refused = q.get('refused');
    const err = q.get('connectors_error');
    if (!on && !refused && !err) return;
    ['connected', 'refused', 'connectors_error'].forEach((k) => q.delete(k));
    history.replaceState(history.state, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    const LABEL = { calendar: 'יומן Google', gmail: 'Gmail', drive: 'Google Drive' };
    const say = (msg, kind) => { const t = () => (typeof TripPages !== 'undefined' ? TripPages.toast(msg, kind) : alert(msg)); setTimeout(t, 600); };
    if (err) say(err);
    else if (on) say(`חיברנו: ${on.split(',').filter(Boolean).map((k) => LABEL[k] || k).join(', ')} ✓`, 'ok');
    else if (refused) say('החיבור לא אושר ב-Google');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleReturn); else handleReturn();

  return { ICON, md, workHtml, paintWork, progressPoll, turnId, actionsHtml, handleActionClick, composer, plusMenu, closeMenu, scrollButton, importSheet, importedHtml, connectorsSheet };
})();
