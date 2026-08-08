// Admin panel: site-wide view of trips and users.
// Everything here is a convenience layer — the server rejects each of these calls
// for non-admins, so a curious visitor who loads /admin just gets a locked page.
// Inline stroke icons — they inherit currentColor, so hover and disabled states
// tint them for free. The trash matches the one on the my-trips cards.
const ICON = {
  trash: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path class="td-lid" d="M3.5 6h17M9.5 6V4.4A1.4 1.4 0 0 1 10.9 3h2.2a1.4 1.4 0 0 1 1.4 1.4V6"/>
      <path d="M18.4 6l-.8 12.7A2 2 0 0 1 15.6 20.6H8.4a2 2 0 0 1-2-1.9L5.6 6"/>
      <path d="M10.3 10.4v5.9M13.7 10.4v5.9"/></svg>`,
  compass: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/><path d="m15.6 8.4-2 5.2-5.2 2 2-5.2Z"/></svg>`,
  users: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13A4 4 0 0 1 16 11"/></svg>`,
  userPlus: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
      <path d="M19 8v6M22 11h-6"/></svg>`,
  pencil: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
};

document.addEventListener('DOMContentLoaded', async () => {
  const panel = document.getElementById('adm-panel');
  const statsEl = document.getElementById('adm-stats');
  const searchEl = document.getElementById('adm-search');
  const tabTrips = document.getElementById('tab-trips');
  const tabUsers = document.getElementById('tab-users');
  const addUserBtn = document.getElementById('adm-add-user');

  const locked = (msg) => {
    statsEl.innerHTML = '';
    panel.innerHTML = `<div class="empty-state"><div class="big">🔒</div><p>${TRIPI.esc(msg)}</p></div>`;
  };

  if (!TRIPI.token) {
    locked('צריך להתחבר כדי להיכנס לאזור הניהול.');
    openAuthModal(() => location.reload());
    return;
  }
  // the cached user can be stale in both directions — ask the server who we are
  await TRIPI.refreshUser();
  if (!TRIPI.user || !TRIPI.user.is_admin) {
    locked('האזור הזה מיועד למנהלי המערכת.');
    return;
  }

  let tab = 'trips';
  let rows = [];

  const heDate = (s) => new Date(s).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' });

  async function loadStats() {
    try {
      const s = await TRIPI.api('/api/admin/stats');
      const tiles = [
        ['משתמשים', s.users, `+${s.new_users} בשבוע`],
        ['טיולים', s.trips, `+${s.new_trips} בשבוע`],
        ['טיולים ציבוריים', s.public_trips, 'מופיעים בדף הבית'],
        ['תחנות במסלולים', s.items, 'סה״כ באתר'],
      ];
      statsEl.innerHTML = tiles.map(([label, n, sub]) => `
        <div class="adm-stat glass">
          <div class="adm-stat-n">${n}</div>
          <div class="adm-stat-label">${label}</div>
          <div class="adm-stat-sub">${TRIPI.esc(sub)}</div>
        </div>`).join('');
    } catch (err) {
      statsEl.innerHTML = `<div class="form-error">${TRIPI.esc(err.message)}</div>`;
    }
  }

  async function load() {
    panel.innerHTML = '<div class="skl-rows">' + '<span class="skl"></span>'.repeat(4) + '</div>';
    const q = encodeURIComponent(searchEl.value.trim());
    try {
      rows = await TRIPI.api(`/api/admin/${tab}?q=${q}`);
      render();
    } catch (err) {
      panel.innerHTML = `<div class="empty-day">${TRIPI.esc(err.message)}</div>`;
    }
  }

  function render() {
    if (!rows.length) {
      panel.innerHTML = '<div class="empty-day">אין תוצאות לחיפוש הזה</div>';
      return;
    }
    panel.innerHTML = tab === 'trips' ? tripsTable() : usersTable();
    if (tab === 'trips') wireTrips(); else wireUsers();
  }

  function tripsTable() {
    return `
      <table class="adm-table">
        <thead><tr>
          <th>טיול</th><th>בעלים</th><th>קודים</th><th class="num">תחנות</th>
          <th class="num">לייקים</th><th>נוצר</th><th>ציבורי</th><th></th>
        </tr></thead>
        <tbody>${rows.map((t) => `
          <tr data-id="${t.id}">
            <td>
              <a class="adm-link" href="/trip/${t.share_code}">${t.emoji || '🧭'} ${TRIPI.esc(t.title)}</a>
              <div class="adm-sub">${TRIPI.esc(t.destination)}${t.country ? ' · ' + TRIPI.esc(t.country) : ''} · ${t.days} ימים</div>
            </td>
            <td>${t.owner_name ? TRIPI.esc(t.owner_name) : '<span class="adm-sub">— ללא בעלים</span>'}
              ${t.owner_email ? `<div class="adm-sub" dir="ltr">${TRIPI.esc(t.owner_email)}</div>` : ''}</td>
            <td dir="ltr" class="adm-codes">
              <span class="copyable adm-code" data-copy="${t.share_code}" title="קוד טיול — לחיצה מעתיקה">#${t.share_code}</span>
              <span class="copyable adm-code edit" data-copy="${t.edit_code || ''}" title="קוד עריכה — לחיצה מעתיקה">${ICON.pencil}${t.edit_code || '—'}</span>
            </td>
            <td class="num">${t.item_count}</td>
            <td class="num">${t.likes}</td>
            <td class="adm-sub">${heDate(t.created_at)}</td>
            <td><label class="adm-switch"><input type="checkbox" class="adm-pub" ${t.is_public ? 'checked' : ''}><span></span></label></td>
            <td><button class="adm-del" title="מחיקת הטיול" aria-label="מחיקת הטיול">${ICON.trash}</button></td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  function usersTable() {
    return `
      <table class="adm-table">
        <thead><tr>
          <th>שם</th><th>אימייל</th><th class="num">טיולים</th><th>נרשם</th><th>מנהל</th><th></th>
        </tr></thead>
        <tbody>${rows.map((u) => `
          <tr data-id="${u.id}">
            <td>${TRIPI.esc(u.name)}${u.id === TRIPI.user.id ? ' <span class="adm-you">אתם</span>' : ''}</td>
            <td dir="ltr">${TRIPI.esc(u.email)}</td>
            <td class="num">${u.trip_count}</td>
            <td class="adm-sub">${heDate(u.created_at)}</td>
            <td><label class="adm-switch"><input type="checkbox" class="adm-admin" ${u.is_admin ? 'checked' : ''}
              ${u.id === TRIPI.user.id ? 'disabled title="אי אפשר להסיר הרשאות מעצמכם"' : ''}><span></span></label></td>
            <td>${u.id === TRIPI.user.id
              ? `<button class="adm-del self" disabled title="אי אפשר למחוק את עצמכם" aria-label="אי אפשר למחוק את עצמכם">${ICON.trash}</button>`
              : `<button class="adm-del" title="מחיקת המשתמש" aria-label="מחיקת המשתמש">${ICON.trash}</button>`}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  // ---- modal shell, matching the auth modal's markup so it inherits its styling ----
  function admModal(inner) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop open';
    wrap.innerHTML = `<div class="modal glass"><button class="modal-close" aria-label="סגירה">✕</button>${inner}</div>`;
    document.body.appendChild(wrap);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { wrap.remove(); document.removeEventListener('keydown', onKey); }
    wrap.querySelector('.modal-close').onclick = close;
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    return { wrap, close };
  }

  function openAddUser() {
    const { wrap, close } = admModal(`
      <h2>משתמש חדש</h2>
      <p class="modal-sub">נוצר מיד ומוכן להתחברות — בלי אימות אימייל</p>
      <form id="au-form">
        <div class="field">
          <label for="au-name">שם מלא</label>
          <input id="au-name" type="text" required placeholder="למשל: דנה לוי">
        </div>
        <div class="field">
          <label for="au-email">אימייל</label>
          <input id="au-email" type="email" required placeholder="you@example.com" dir="ltr" style="text-align:left">
        </div>
        <div class="field">
          <label for="au-pass">סיסמה <span class="adm-sub" style="display:inline">— אפשר להשאיר ריק</span></label>
          <input id="au-pass" type="text" placeholder="ריק = סיסמה זמנית אוטומטית" dir="ltr" style="text-align:left">
        </div>
        <label class="adm-check"><input type="checkbox" id="au-admin"> <span>הרשאות מנהל</span></label>
        <div class="form-error" id="au-err"></div>
        <button class="btn btn-amber btn-lg" type="submit" id="au-submit" style="width:100%;justify-content:center">יוצרים משתמש</button>
      </form>`);
    wrap.querySelector('#au-name').focus();

    wrap.querySelector('#au-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = wrap.querySelector('#au-submit');
      if (btn.disabled) return; // a double submit would try to create the account twice
      btn.disabled = true;
      const errEl = wrap.querySelector('#au-err');
      errEl.textContent = '';
      try {
        const created = await TRIPI.api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            name: wrap.querySelector('#au-name').value,
            email: wrap.querySelector('#au-email').value,
            password: wrap.querySelector('#au-pass').value,
            is_admin: wrap.querySelector('#au-admin').checked,
          }),
        });
        loadStats();
        if (created.temp_password) showTempPassword(created, close);
        else { close(); if (tab === 'users') load(); }
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // the generated password is shown once — there is no way back to it after this modal
  function showTempPassword(user, closeForm) {
    closeForm();
    const { wrap, close } = admModal(`
      <h2>${TRIPI.esc(user.name)} נוצר/ה ✅</h2>
      <p class="modal-sub">זו ההצגה היחידה של הסיסמה הזמנית — העתיקו אותה עכשיו ומסרו למשתמש</p>
      <div class="adm-cred">
        <div class="adm-cred-row"><span class="adm-cred-k">אימייל</span>
          <span class="copyable adm-cred-v" dir="ltr">${TRIPI.esc(user.email)}</span></div>
        <div class="adm-cred-row"><span class="adm-cred-k">סיסמה זמנית</span>
          <span class="copyable adm-cred-v" dir="ltr">${TRIPI.esc(user.temp_password)}</span></div>
      </div>
      <button class="btn btn-amber btn-lg" id="au-done" style="width:100%;justify-content:center">סיימתי להעתיק</button>`);
    wrap.querySelector('#au-done').onclick = () => { close(); if (tab === 'users') load(); };
  }

  function confirmDeleteUser(u, onDone) {
    const owns = u.trip_count > 0;
    const { wrap, close } = admModal(`
      <h2>מחיקת משתמש</h2>
      <p class="modal-sub">${TRIPI.esc(u.name)} · <span dir="ltr">${TRIPI.esc(u.email)}</span></p>
      ${owns ? `
        <p class="adm-warn">למשתמש הזה ${u.trip_count} טיולים. כברירת מחדל הם יישארו באתר בלי בעלים.</p>
        <label class="adm-check"><input type="checkbox" id="du-trips">
          <span>למחוק גם את ${u.trip_count} הטיולים — כולל התחנות, המלונות וההוצאות שלהם</span></label>`
        : '<p class="adm-warn">למשתמש הזה אין טיולים.</p>'}
      <div class="form-error" id="du-err"></div>
      <div class="adm-modal-actions">
        <button class="btn btn-ghost" id="du-cancel">ביטול</button>
        <button class="btn btn-danger" id="du-go">מחיקה לצמיתות</button>
      </div>`);
    wrap.querySelector('#du-cancel').onclick = close;
    wrap.querySelector('#du-go').onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      const dropTrips = owns && wrap.querySelector('#du-trips').checked;
      try {
        const r = await TRIPI.api(`/api/admin/users/${u.id}${dropTrips ? '?trips=delete' : ''}`, { method: 'DELETE' });
        close();
        onDone(r);
      } catch (err) {
        wrap.querySelector('#du-err').textContent = err.message;
        btn.disabled = false;
      }
    };
  }

  function wireTrips() {
    panel.querySelectorAll('.adm-pub').forEach((box) => {
      box.addEventListener('change', async () => {
        const id = box.closest('tr').dataset.id;
        box.disabled = true; // a second click mid-flight can land out of order
        try {
          await TRIPI.api('/api/trips/' + id, { method: 'PATCH', body: JSON.stringify({ is_public: box.checked }) });
          loadStats();
        } catch (err) { box.checked = !box.checked; alert(err.message); }
        finally { box.disabled = false; }
      });
    });
    panel.querySelectorAll('.adm-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const title = tr.querySelector('.adm-link').textContent.trim();
        if (!confirm(`למחוק לצמיתות את "${title}"? כל התחנות, המלונות וההוצאות יימחקו איתו.`)) return;
        btn.disabled = true;
        try {
          await TRIPI.api('/api/trips/' + tr.dataset.id, { method: 'DELETE' });
          tr.remove();
          rows = rows.filter((t) => String(t.id) !== tr.dataset.id);
          loadStats();
          if (!rows.length) render();
        } catch (err) { btn.disabled = false; alert(err.message); }
      });
    });
  }

  function wireUsers() {
    panel.querySelectorAll('.adm-admin').forEach((box) => {
      box.addEventListener('change', async () => {
        const id = box.closest('tr').dataset.id;
        box.disabled = true;
        try {
          await TRIPI.api('/api/admin/users/' + id, { method: 'PATCH', body: JSON.stringify({ is_admin: box.checked }) });
        } catch (err) { box.checked = !box.checked; alert(err.message); }
        finally { box.disabled = false; }
      });
    });
    panel.querySelectorAll('.adm-del:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tr = btn.closest('tr');
        const user = rows.find((u) => String(u.id) === tr.dataset.id);
        if (!user) return;
        confirmDeleteUser(user, (r) => {
          tr.remove();
          rows = rows.filter((u) => String(u.id) !== tr.dataset.id);
          loadStats();
          if (!rows.length) render();
          if (r.trips_orphaned) {
            alert(`${r.trips_orphaned} טיולים של המשתמש נשארו באתר ללא בעלים — אפשר למצוא אותם בלשונית הטיולים.`);
          }
        });
      });
    });
  }

  function setTab(next) {
    tab = next;
    tabTrips.classList.toggle('active', next === 'trips');
    tabUsers.classList.toggle('active', next === 'users');
    searchEl.placeholder = next === 'trips'
      ? 'חיפוש לפי שם, יעד, אימייל או קוד טיול…'
      : 'חיפוש לפי שם או אימייל…';
    addUserBtn.style.display = next === 'users' ? '' : 'none';
    load();
  }
  addUserBtn.addEventListener('click', openAddUser);
  tabTrips.addEventListener('click', () => setTab('trips'));
  tabUsers.addEventListener('click', () => setTab('users'));

  let searchTimer;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  });

  loadStats();
  load();
});
