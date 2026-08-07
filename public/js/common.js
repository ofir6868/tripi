// Shared: auth state, header rendering, auth modal, small helpers.
const TRIPI = {
  token: localStorage.getItem('tripi_token'),
  user: JSON.parse(localStorage.getItem('tripi_user') || 'null'),

  saveAuth(token, user) {
    this.token = token; this.user = user;
    localStorage.setItem('tripi_token', token);
    localStorage.setItem('tripi_user', JSON.stringify(user));
  },
  logout() {
    this.token = null; this.user = null;
    localStorage.removeItem('tripi_token');
    localStorage.removeItem('tripi_user');
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
  mapsSearchUrl(q) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
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
function renderHeader() {
  const el = document.createElement('header');
  el.className = 'site-header glass';
  const authPart = TRIPI.user
    ? `<a class="btn btn-ghost" href="/my">✈️ הטיולים של ${TRIPI.esc(TRIPI.user.name.split(' ')[0])}</a>
       <button class="btn btn-ghost" id="nav-logout" title="התנתקות">יציאה</button>`
    : `<button class="btn btn-ghost" id="nav-login">התחברות</button>`;
  el.innerHTML = `
    <a class="logo" href="/">
      <span class="logo-mark">TRIPI</span>
      <span class="logo-he">מתכנן הטיולים שלך</span>
    </a>
    <nav class="nav-actions">
      ${authPart}
      <a class="btn btn-amber" href="/plan">+ טיול חדש</a>
    </nav>`;
  document.body.prepend(el);
  el.querySelector('#nav-login')?.addEventListener('click', () => openAuthModal());
  el.querySelector('#nav-logout')?.addEventListener('click', () => TRIPI.logout());
}

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
      <form id="auth-form">
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
