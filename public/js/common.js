// Shared: auth state, header rendering, auth modal, small helpers.

// The storage prefix moved with the rename (tripi_* → tripmaker_*). Carry over
// whatever a browser still holds so an open session keeps its login, likes and
// drafts instead of silently starting from scratch. Runs before anything reads a
// key, and is a no-op once the old keys are gone.
(() => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('tripi_')) continue;
      const renamed = 'tripmaker_' + key.slice('tripi_'.length);
      if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch { /* storage blocked — nothing to carry over */ }
})();

const TRIPMAKER = {
  token: localStorage.getItem('tripmaker_token'),
  user: JSON.parse(localStorage.getItem('tripmaker_user') || 'null'),

  saveAuth(token, user) {
    this.token = token; this.user = user;
    localStorage.setItem('tripmaker_token', token);
    localStorage.setItem('tripmaker_user', JSON.stringify(user));
  },
  // the cached user is whatever login returned, possibly months ago — re-read it so
  // an admin promotion (or rename) shows up without forcing a logout/login round
  async refreshUser() {
    if (!this.token) return false;
    try {
      const me = await this.api('/api/me');
      const changed = !this.user || this.user.is_admin !== me.is_admin || this.user.name !== me.name;
      this.user = me;
      localStorage.setItem('tripmaker_user', JSON.stringify(me));
      return changed;
    } catch {
      return false; // expired token / offline — every other call handles that on its own
    }
  },
  logout() {
    this.token = null; this.user = null;
    localStorage.removeItem('tripmaker_token');
    localStorage.removeItem('tripmaker_user');
    location.href = '/';
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
  // with a stored place_id the link opens THE place, not whatever a text search
  // happens to rank first — the id wins whenever a stop carries one
  mapsSearchUrl(q, placeId) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q)
      + (placeId ? '&query_place_id=' + encodeURIComponent(placeId) : '');
  },
  // fire-and-forget product event — PostHog may be absent (no key, blocker, offline)
  track(name, props) {
    try { window.posthog && posthog.capture && posthog.capture(name, props); } catch { /* analytics never breaks UX */ }
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
  // clipboard with an execCommand fallback for browsers that block the async API
  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
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
  more: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>',
  user: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  login: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
  logout: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
};

function renderHeader() {
  document.querySelector('.site-header')?.remove(); // re-render after refreshUser()
  document.getElementById('nav-menu-panel')?.remove(); // panel lives on body for real backdrop blur
  const el = document.createElement('header');
  el.className = 'site-header glass';
  const menuItems = [];
  if (TRIPMAKER.user) {
    if (TRIPMAKER.user.is_admin) {
      menuItems.push(`<a class="nav-menu-item nav-menu-admin" href="/admin">${NAV_ICON.gear}<span>ניהול</span></a>`);
    }
    menuItems.push(
      `<a class="nav-menu-item" href="/my">${NAV_ICON.map}<span class="ph-mask">הטיולים של ${TRIPMAKER.esc(TRIPMAKER.user.name.split(' ')[0])}</span></a>`,
      `<button type="button" class="nav-menu-item nav-menu-logout" id="nav-logout">${NAV_ICON.logout}<span>יציאה</span></button>`,
    );
  } else {
    menuItems.push(
      `<button type="button" class="nav-menu-item" id="nav-login">${NAV_ICON.login}<span>התחברות</span></button>`,
    );
  }
  const userName = TRIPMAKER.user
    ? `<span class="logo-user">שלום, <span class="ph-mask">${TRIPMAKER.esc(TRIPMAKER.user.name.split(' ')[0])}</span></span>`
    : `<span class="logo-he">מתכנן הטיולים שלך</span>`;
  el.innerHTML = `
    <a class="logo" href="/">
      <span class="logo-stack" dir="ltr" role="img" aria-label="TRIP MAKER">
        <span class="ls-trip" aria-hidden="true"><b>T</b><b>R</b><b>I</b><b>P</b></span>
        <span class="ls-maker" aria-hidden="true"><b>M</b><b>A</b><b>K</b><b>E</b><b>R</b></span>
      </span>
      ${userName}
    </a>
    <nav class="nav-actions">
      <div class="nav-menu">
        <button type="button" class="btn btn-ghost nav-menu-btn" id="nav-menu-btn"
          aria-haspopup="menu" aria-expanded="false" aria-controls="nav-menu-panel" title="תפריט">
          ${NAV_ICON.user}<span class="sr-only">תפריט</span>
        </button>
      </div>
      <a class="btn btn-amber" href="/plan">${NAV_ICON.plus}טיול חדש</a>
    </nav>`;
  document.body.prepend(el);

  const panel = document.createElement('div');
  panel.className = 'nav-menu-panel glass';
  panel.id = 'nav-menu-panel';
  panel.setAttribute('role', 'menu');
  panel.hidden = true;
  panel.innerHTML = menuItems.join('');
  document.body.appendChild(panel);

  const menu = el.querySelector('.nav-menu');
  const btn = el.querySelector('#nav-menu-btn');
  const placePanel = () => {
    const r = btn.getBoundingClientRect();
    const gap = 10;
    const edge = 14;
    panel.style.top = `${Math.round(r.bottom + gap)}px`;
    panel.style.right = 'auto';
    // desktop: align under the user button; phones: keep the left-corner dock
    if (window.matchMedia('(max-width: 640px)').matches) {
      panel.style.left = `${edge}px`;
      return;
    }
    panel.style.left = `${Math.round(r.left)}px`;
    requestAnimationFrame(() => {
      const pr = panel.getBoundingClientRect();
      if (pr.right > window.innerWidth - edge) {
        panel.style.left = `${Math.max(edge, Math.round(window.innerWidth - edge - pr.width))}px`;
      }
      if (pr.left < edge) panel.style.left = `${edge}px`;
    });
  };
  const setOpen = (open) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.classList.toggle('open', open);
    if (open) placePanel();
  };
  // abort previous document listeners when the header re-renders (refreshUser)
  if (renderHeader._ac) renderHeader._ac.abort();
  renderHeader._ac = new AbortController();
  const { signal } = renderHeader._ac;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setOpen(false), { signal });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  }, { signal });
  window.addEventListener('resize', () => { if (!panel.hidden) placePanel(); }, { signal });
  window.addEventListener('scroll', () => { if (!panel.hidden) placePanel(); }, { signal, capture: true });
  panel.querySelector('#nav-logout')?.addEventListener('click', () => TRIPMAKER.logout());
  panel.querySelector('#nav-login')?.addEventListener('click', () => {
    setOpen(false);
    openAuthModal();
  });
}

// ---------- click-to-copy ----------
// any element marked .copyable copies data-copy (or its own text) — delegated once,
// so codes rendered later by trip.js / plan.js / my.html work without extra wiring
document.addEventListener('click', async (e) => {
  const el = e.target.closest('.copyable');
  if (!el) return;
  e.preventDefault();   // codes often sit inside a card <a> — copy instead of navigating
  e.stopPropagation();
  const ok = await TRIPMAKER.copy(el.dataset.copy || el.textContent.trim());
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
        <p class="auth-legal">בהרשמה ובהתחברות אתם מאשרים את <a href="/terms" target="_blank" rel="noopener">תנאי השימוש</a> ואת <a href="/privacy" target="_blank" rel="noopener">מדיניות הפרטיות</a>. מסירת הפרטים אינה חובה על פי חוק, אך בלעדיהם לא ניתן לפתוח חשבון.</p>
      </form>
      <div class="auth-google-wrap" id="auth-google-wrap" hidden>
        <div class="auth-divider"><span>או</span></div>
        <a class="btn btn-google" id="auth-google" href="/api/auth/google">
          <svg class="google-g" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          המשך עם Google
        </a>
      </div>
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && wrap.classList.contains('open')) wrap.classList.remove('open'); });

  // only show Google when the server has credentials configured
  fetch('/api/auth/providers').then((r) => r.json()).then((p) => {
    if (!p.google) return;
    const wrapEl = wrap.querySelector('#auth-google-wrap');
    const link = wrap.querySelector('#auth-google');
    wrapEl.hidden = false;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const next = location.pathname + location.search;
      location.href = '/api/auth/google?next=' + encodeURIComponent(next);
    });
  }).catch(() => {});

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
      const data = await TRIPMAKER.api(path, { method: 'POST', body: JSON.stringify(body) });
      TRIPMAKER.saveAuth(data.token, data.user);
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
async function consumeGoogleAuthHash() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  const token = params.get('google_token');
  if (!token) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    TRIPMAKER.token = token;
    localStorage.setItem('tripmaker_token', token);
    const me = await TRIPMAKER.api('/api/me');
    TRIPMAKER.saveAuth(token, me);
    return true;
  } catch {
    TRIPMAKER.token = null;
    TRIPMAKER.user = null;
    localStorage.removeItem('tripmaker_token');
    localStorage.removeItem('tripmaker_user');
    return false;
  }
}

function showGoogleAuthError() {
  const q = new URLSearchParams(location.search);
  const err = q.get('google_error');
  if (!err) return;
  q.delete('google_error');
  const clean = q.toString();
  history.replaceState(null, '', location.pathname + (clean ? `?${clean}` : ''));
  openAuthModal();
  const errEl = document.querySelector('#auth-error');
  if (errEl) errEl.textContent = err;
}

document.addEventListener('DOMContentLoaded', async () => {
  const atm = document.createElement('div');
  atm.className = 'atmosphere';
  document.body.prepend(atm);
  const fromGoogle = await consumeGoogleAuthHash();
  renderHeader();
  renderAuthModal();
  showGoogleAuthError();
  if (!fromGoogle) {
    TRIPMAKER.refreshUser().then((changed) => { if (changed) renderHeader(); });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
