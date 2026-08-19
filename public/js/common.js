// Shared: auth state, header rendering, auth modal, small helpers.
const TRIPI = {
  // iPadOS 13+ reports itself as a Mac; the touch points are what give it away.
  // Both the install card and the notification switch branch on these, and a
  // disagreement between them would offer a control that can't work.
  iOS: /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  standalone: window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches,

  token: localStorage.getItem('tripi_token'),
  user: JSON.parse(localStorage.getItem('tripi_user') || 'null'),

  saveAuth(token, user) {
    this.token = token; this.user = user;
    // private browsing can refuse the write; the session still works for this tab
    try {
      localStorage.setItem('tripi_token', token);
      localStorage.setItem('tripi_user', JSON.stringify(user));
    } catch { /* in-memory only from here */ }
  },

  // Safari empties script-written storage after seven days away, so a returning
  // visitor can look signed out while the server's session cookie is still valid.
  // One request puts the token back. Tried at most once per tab, and never when a
  // token is already in hand.
  async restoreSession() {
    if (this.token) return false;
    try {
      if (sessionStorage.getItem('tripi_restored')) return false;
      sessionStorage.setItem('tripi_restored', '1');
    } catch { /* no sessionStorage — the reload guard below still holds the line */ }
    try {
      const res = await fetch('/api/auth/session');
      if (!res.ok) return false;
      const { token, user } = await res.json();
      if (!token) return false;
      this.saveAuth(token, user);
      return true;
    } catch {
      return false; // offline — nothing was lost that a later visit can't recover
    }
  },
  // the cached user is whatever login returned, possibly months ago — re-read it so
  // an admin promotion (or rename) shows up without forcing a logout/login round
  async refreshUser() {
    if (!this.token) return false;
    try {
      const me = await this.api('/api/me');
      const changed = !this.user || this.user.is_admin !== me.is_admin || this.user.name !== me.name;
      this.user = me;
      localStorage.setItem('tripi_user', JSON.stringify(me));
      return changed;
    } catch {
      return false; // expired token / offline — every other call handles that on its own
    }
  },
  logout() {
    this.token = null; this.user = null;
    try {
      localStorage.removeItem('tripi_token');
      localStorage.removeItem('tripi_user');
    } catch { /* nothing stored to begin with */ }
    // the cookie has to go too, or the next page load restores the session that was
    // just ended — keepalive so the request survives the navigation below
    fetch('/api/auth/logout', { method: 'POST', keepalive: true })
      .catch(() => {})
      .finally(() => { location.href = '/'; });
  },
  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'שגיאה לא צפויה');
    return data;
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },
  mapsSearchUrl(q) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  },
  // the calendar day a Date falls on *here* — never toISOString(), which east of
  // UTC rolls local midnight back a day and pairs every itinerary day with the
  // previous day's forecast
  isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  routeIcon: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h6a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h6"/></svg>',
  externalIcon: '<svg class="ic ic-ext" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  // a day's stops as one Google Maps directions route — the official URL scheme,
  // no API key. Caps at 11 points (origin + 9 waypoints + destination), Google's limit.
  mapsRouteUrl(items) {
    const pts = items
      .filter((it) => it.place_query || (it.lat != null && it.lon != null))
      .map((it) => (it.lat != null && it.lon != null ? `${it.lat},${it.lon}` : it.place_query))
      .slice(0, 11);
    if (pts.length < 2) return null;
    const enc = encodeURIComponent;
    return 'https://www.google.com/maps/dir/?api=1&hl=he'
      + `&origin=${enc(pts[0])}&destination=${enc(pts[pts.length - 1])}`
      + (pts.length > 2 ? `&waypoints=${enc(pts.slice(1, -1).join('|'))}` : '');
  },
  // Pinning the page under a fullscreen overlay. `overflow: hidden` on <body> is
  // enough on Android and desktop and does nothing whatsoever on iOS Safari, where
  // the document goes on scrolling behind the overlay — the trip drifts away while
  // you read the thing covering it. Fixing the body and putting the offset back on
  // release is the technique that holds everywhere.
  scrollLockY: null,
  lockScroll() {
    if (this.scrollLockY !== null) return;   // already locked — nesting must not stack
    this.scrollLockY = window.scrollY;
    Object.assign(document.body.style, {
      position: 'fixed', top: `-${this.scrollLockY}px`, insetInline: '0',
      width: '100%', overflow: 'hidden',
    });
  },
  unlockScroll() {
    if (this.scrollLockY === null) return;
    const y = this.scrollLockY;
    this.scrollLockY = null;
    Object.assign(document.body.style, {
      position: '', top: '', insetInline: '', width: '', overflow: '',
    });
    // 'instant' overrides the page's scroll-behavior: smooth — releasing the lock
    // must put the page back where it was, not glide there from the top
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  },

  // Clipboard, with an execCommand fallback for browsers that refuse the async API
  // (an insecure context, a denied permission). The fallback copies out of a real,
  // on-screen element rather than a hidden <textarea>: a textarea's value is not a
  // text node, so a Range over it selects nothing, and iOS ignores select() on an
  // element it can't see — between them, the usual version silently copies air.
  // A 1px, near-transparent div holding the text as a node is selectable on every
  // browser, and the reader never sees it.
  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* denied, or an insecure context — fall through */ }

    const holder = document.createElement('div');
    holder.textContent = text;
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;'
      + 'opacity:.01;white-space:pre;font-size:16px;-webkit-user-select:text;user-select:text';
    document.body.appendChild(holder);

    const sel = document.getSelection();
    const previous = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const range = document.createRange();
    range.selectNodeContents(holder);
    sel?.removeAllRanges();
    sel?.addRange(range);

    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* nothing left to try */ }

    sel?.removeAllRanges();
    holder.remove();
    // put back whatever the reader had selected before we borrowed the selection
    if (previous) sel?.addRange(previous);
    return ok;
  },
  // arrow-key highlight for autocomplete dropdowns
  acMove(list, dir) {
    const items = [...list.querySelectorAll('.autocomplete-item')];
    if (!items.length) return;
    let idx = items.findIndex((i) => i.classList.contains('active'));
    idx = (idx + dir + items.length) % items.length;
    items.forEach((i) => i.classList.remove('active'));
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  },
  openLightbox(url) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${String(url).replace(/"/g, '')}" alt="">`;
    box.onclick = () => box.remove();
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(box);
  },
  mapsEmbedUrl(q) {
    return 'https://maps.google.com/maps?q=' + encodeURIComponent(q) + '&hl=he&z=12&output=embed';
  },
  // exact pin: coordinates when we have them, otherwise a zoomed place search
  mapsEmbedUrlExact(it) {
    if (it.lat != null && it.lon != null) {
      return `https://maps.google.com/maps?q=${it.lat},${it.lon}&hl=he&z=16&output=embed`;
    }
    return 'https://maps.google.com/maps?q=' + encodeURIComponent(it.place_query || '') + '&hl=he&z=15&output=embed';
  },
};

// ---------- header ----------
// nav icons (lucide strokes, not emoji): currentColor keeps them in step with
// each button's hover and state tints
const NAV_ICON = {
  gear: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  map: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
  plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
};

function renderHeader() {
  document.querySelector('.site-header')?.remove(); // re-render after refreshUser()
  const el = document.createElement('header');
  el.className = 'site-header glass';
  const adminPart = TRIPI.user && TRIPI.user.is_admin
    ? `<a class="btn btn-ghost nav-admin" href="/admin" title="ניהול">${NAV_ICON.gear}<span class="nav-label">ניהול</span></a>`
    : '';
  const authPart = TRIPI.user
    ? `${adminPart}
       <a class="btn btn-ghost" href="/my" title="הטיולים שלי">${NAV_ICON.map}<span class="nav-label ph-mask">הטיולים של ${TRIPI.esc(TRIPI.user.name.split(' ')[0])}</span></a>
       <button class="btn btn-ghost nav-logout" id="nav-logout" title="התנתקות">יציאה</button>`
    : `<button class="btn btn-ghost" id="nav-login">התחברות</button>`;
  el.innerHTML = `
    <a class="logo" href="/">
      <span class="logo-stack" dir="ltr" role="img" aria-label="TRIP MAKER">
        <span class="ls-trip" aria-hidden="true"><b>T</b><b>R</b><b>I</b><b>P</b></span>
        <span class="ls-maker" aria-hidden="true"><b>M</b><b>A</b><b>K</b><b>E</b><b>R</b></span>
      </span>
      <span class="logo-he">מתכנן הטיולים שלך</span>
    </a>
    <nav class="nav-actions">
      ${authPart}
      <a class="btn btn-amber" href="/plan">${NAV_ICON.plus}טיול חדש</a>
    </nav>`;
  document.body.prepend(el);
  el.querySelector('#nav-login')?.addEventListener('click', () => openAuthModal());
  el.querySelector('#nav-logout')?.addEventListener('click', () => TRIPI.logout());
}

// ---------- click-to-copy ----------
// any element marked .copyable copies data-copy (or its own text) — delegated once,
// so codes rendered later by trip.js / plan.js / my.html work without extra wiring
document.addEventListener('click', async (e) => {
  const el = e.target.closest('.copyable');
  if (!el) return;
  e.preventDefault();   // codes often sit inside a card <a> — copy instead of navigating
  e.stopPropagation();
  const ok = await TRIPI.copy(el.dataset.copy || el.textContent.trim());
  el.classList.remove('copied', 'copy-failed');
  void el.offsetWidth; // restart the bubble even on a rapid second click
  el.classList.add(ok ? 'copied' : 'copy-failed');
  setTimeout(() => el.classList.remove('copied', 'copy-failed'), 1500);
});

// ---------- auth modal ----------
let authMode = 'login';
let authOnSuccess = null;

function renderAuthModal() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.id = 'auth-modal';
  wrap.innerHTML = `
    <div class="modal glass">
      <button class="modal-close" aria-label="סגירה">✕</button>
      <h2 id="auth-title">ברוכים השבים</h2>
      <p class="modal-sub" id="auth-sub">מתחברים וממשיכים לתכנן</p>
      <form id="auth-form" class="ph-no-capture">
        <div class="field" id="auth-name-field" style="display:none">
          <label for="auth-name">שם מלא</label>
          <input id="auth-name" type="text" autocomplete="name" placeholder="למשל: דנה לוי">
        </div>
        <div class="field">
          <label for="auth-email">אימייל</label>
          <input id="auth-email" type="email" autocomplete="email" required placeholder="you@example.com" dir="ltr" style="text-align:left">
        </div>
        <div class="field">
          <label for="auth-password">סיסמה</label>
          <input id="auth-password" type="password" autocomplete="current-password" required placeholder="לפחות 6 תווים" dir="ltr" style="text-align:left">
        </div>
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-amber btn-lg" type="submit" style="width:100%;justify-content:center" id="auth-submit">התחברות</button>
      </form>
      <div class="switch-auth" id="auth-switch">
        אין לכם חשבון? <a id="auth-toggle">הרשמה מהירה</a>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const setMode = (mode) => {
    authMode = mode;
    wrap.querySelector('#auth-name-field').style.display = mode === 'register' ? '' : 'none';
    wrap.querySelector('#auth-title').textContent = mode === 'register' ? 'נעים להכיר!' : 'ברוכים השבים';
    wrap.querySelector('#auth-sub').textContent = mode === 'register' ? 'חשבון חינם — 20 שניות ואתם בפנים' : 'מתחברים וממשיכים לתכנן';
    wrap.querySelector('#auth-submit').textContent = mode === 'register' ? 'יוצרים חשבון' : 'התחברות';
    wrap.querySelector('#auth-switch').innerHTML = mode === 'register'
      ? 'כבר יש חשבון? <a id="auth-toggle">התחברות</a>'
      : 'אין לכם חשבון? <a id="auth-toggle">הרשמה מהירה</a>';
    wrap.querySelector('#auth-toggle').onclick = () => setMode(mode === 'register' ? 'login' : 'register');
    wrap.querySelector('#auth-error').textContent = '';
  };
  wrap.querySelector('#auth-toggle').onclick = () => setMode('register');

  wrap.querySelector('.modal-close').onclick = () => wrap.classList.remove('open');
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.classList.remove('open'); });

  wrap.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = wrap.querySelector('#auth-submit');
    if (submitBtn.disabled) return; // double-submit → one account, not two attempts
    submitBtn.disabled = true;
    const errEl = wrap.querySelector('#auth-error');
    errEl.textContent = '';
    const email = wrap.querySelector('#auth-email').value;
    const password = wrap.querySelector('#auth-password').value;
    const name = wrap.querySelector('#auth-name').value;
    try {
      const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = authMode === 'register' ? { name, email, password } : { email, password };
      const data = await TRIPI.api(path, { method: 'POST', body: JSON.stringify(body) });
      TRIPI.saveAuth(data.token, data.user);
      wrap.classList.remove('open');
      if (authOnSuccess) { const cb = authOnSuccess; authOnSuccess = null; cb(); }
      else location.reload();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  window.setAuthMode = setMode;
}

function openAuthModal(onSuccess, mode = 'login') {
  authOnSuccess = onSuccess || null;
  window.setAuthMode?.(mode);
  document.getElementById('auth-modal').classList.add('open');
}

// ---------- atmosphere + boot ----------
document.addEventListener('DOMContentLoaded', () => {
  const atm = document.createElement('div');
  atm.className = 'atmosphere';
  document.body.prepend(atm);
  renderHeader();
  renderAuthModal();
  if (TRIPI.token) {
    TRIPI.refreshUser().then((changed) => { if (changed) renderHeader(); });
  } else {
    // the page has already rendered as a signed-out one, so a recovered session has
    // to start it over. Only reload once the token is provably readable back —
    // otherwise a browser refusing to store it would reload forever.
    TRIPI.restoreSession().then((ok) => {
      if (ok && localStorage.getItem('tripi_token')) location.reload();
    });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
