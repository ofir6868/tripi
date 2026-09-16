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
  megaphone: `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>`,
};

document.addEventListener('DOMContentLoaded', async () => {
  const panel = document.getElementById('adm-panel');
  const statsEl = document.getElementById('adm-stats');
  const searchEl = document.getElementById('adm-search');
  const tabTrips = document.getElementById('tab-trips');
  const tabUsers = document.getElementById('tab-users');
  const tabAnnounce = document.getElementById('tab-announce');
  const addUserBtn = document.getElementById('adm-add-user');
  const addAnnounceBtn = document.getElementById('adm-add-announce');

  const locked = (msg) => {
    statsEl.innerHTML = '';
    panel.innerHTML = `<div class="empty-state"><div class="big">🔒</div><p>${TRIPMAKER.esc(msg)}</p></div>`;
  };

  if (!TRIPMAKER.token) {
    locked('צריך להתחבר כדי להיכנס לאזור הניהול.');
    openAuthModal(() => location.reload(), 'login', 'admin');
    return;
  }
  // the cached user can be stale in both directions — ask the server who we are
  await TRIPMAKER.refreshUser();
  if (!TRIPMAKER.user || !TRIPMAKER.user.is_admin) {
    locked('האזור הזה מיועד למנהלי המערכת.');
    return;
  }

  let tab = 'trips';
  let rows = [];

  const heDate = (s) => new Date(s).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' });

  async function loadStats() {
    try {
      const s = await TRIPMAKER.api('/api/admin/stats');
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
          <div class="adm-stat-sub">${TRIPMAKER.esc(sub)}</div>
        </div>`).join('');
    } catch (err) {
      statsEl.innerHTML = `<div class="form-error">${TRIPMAKER.esc(err.message)}</div>`;
    }
  }

  async function load() {
    panel.innerHTML = '<div class="skl-rows">' + '<span class="skl"></span>'.repeat(4) + '</div>';
    try {
      if (tab === 'announce') {
        rows = await TRIPMAKER.api('/api/admin/announcements');
        searchEl.style.display = 'none';
      } else {
        searchEl.style.display = '';
        const q = encodeURIComponent(searchEl.value.trim());
        rows = await TRIPMAKER.api(`/api/admin/${tab}?q=${q}`);
      }
      render();
    } catch (err) {
      panel.innerHTML = `<div class="empty-day">${TRIPMAKER.esc(err.message)}</div>`;
    }
  }

  function render() {
    if (!rows.length) {
      panel.innerHTML = tab === 'announce'
        ? '<div class="empty-day">עוד אין הודעות מערכת — שלחו את הראשונה בכפתור למעלה</div>'
        : '<div class="empty-day">אין תוצאות לחיפוש הזה</div>';
      return;
    }
    if (tab === 'trips') { panel.innerHTML = tripsTable(); wireTrips(); }
    else if (tab === 'users') { panel.innerHTML = usersTable(); wireUsers(); }
    else { panel.innerHTML = announceList(); wireAnnounce(); }
  }

  function tripsTable() {
    return `
      <table class="adm-table">
        <thead><tr>
          <th>טיול</th><th>בעלים</th><th>קוד</th><th class="num">תחנות</th>
          <th class="num">לייקים</th><th>נוצר</th><th>ציבורי</th><th></th>
        </tr></thead>
        <tbody>${rows.map((t) => `
          <tr data-id="${t.id}">
            <td>
              <a class="adm-link" href="/trip/${t.share_code}">${t.emoji || '🧭'} ${TRIPMAKER.esc(t.title)}</a>
              ${t.is_draft ? '<span class="adm-draft">✍️ בתכנון</span>' : ''}
              <div class="adm-sub">${TRIPMAKER.esc(t.destination)}${t.country ? ' · ' + TRIPMAKER.esc(t.country) : ''} · ${t.days} ימים</div>
            </td>
            <td>${t.owner_name ? TRIPMAKER.esc(t.owner_name) : '<span class="adm-sub">— ללא בעלים</span>'}
              ${t.owner_email ? `<div class="adm-sub" dir="ltr">${TRIPMAKER.esc(t.owner_email)}</div>` : ''}</td>
            <td dir="ltr" class="adm-codes">
              <span class="copyable adm-code" data-copy="${t.share_code}" title="קוד טיול — לחיצה מעתיקה">#${t.share_code}</span>
            </td>
            <td class="num">${t.item_count}</td>
            <td class="num">${t.likes}</td>
            <td class="adm-sub">${heDate(t.created_at)}</td>
            <td><label class="adm-switch"${t.is_draft ? ' title="טיוטה — הבעלים עוד לא סיימו לתכנן"' : ''}><input type="checkbox" class="adm-pub" ${t.is_public ? 'checked' : ''}${t.is_draft ? ' disabled' : ''}><span></span></label></td>
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
            <td>${TRIPMAKER.esc(u.name)}${u.id === TRIPMAKER.user.id ? ' <span class="adm-you">אתם</span>' : ''}</td>
            <td dir="ltr">${TRIPMAKER.esc(u.email)}</td>
            <td class="num">${u.trip_count}</td>
            <td class="adm-sub">${heDate(u.created_at)}</td>
            <td><label class="adm-switch"><input type="checkbox" class="adm-admin" ${u.is_admin ? 'checked' : ''}
              ${u.id === TRIPMAKER.user.id ? 'disabled title="אי אפשר להסיר הרשאות מעצמכם"' : ''}><span></span></label></td>
            <td>${u.id === TRIPMAKER.user.id
              ? `<button class="adm-del self" disabled title="אי אפשר למחוק את עצמכם" aria-label="אי אפשר למחוק את עצמכם">${ICON.trash}</button>`
              : `<button class="adm-del" title="מחיקת המשתמש" aria-label="מחיקת המשתמש">${ICON.trash}</button>`}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  // ---- modal shell, matching the auth modal's markup so it inherits its styling ----
  function admModal(inner) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal glass"><button class="modal-close" aria-label="סגירה">✕</button>${inner}</div>`;
    document.body.appendChild(wrap);
    void wrap.offsetWidth;
    wrap.classList.add('open');
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      document.removeEventListener('keydown', onKey);
      TRIPMAKER.closeOverlay(wrap, { remove: true });
    }
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
        const created = await TRIPMAKER.api('/api/admin/users', {
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
      <h2>${TRIPMAKER.esc(user.name)} נוצר/ה ✅</h2>
      <p class="modal-sub">זו ההצגה היחידה של הסיסמה הזמנית — העתיקו אותה עכשיו ומסרו למשתמש</p>
      <div class="adm-cred">
        <div class="adm-cred-row"><span class="adm-cred-k">אימייל</span>
          <span class="copyable adm-cred-v" dir="ltr">${TRIPMAKER.esc(user.email)}</span></div>
        <div class="adm-cred-row"><span class="adm-cred-k">סיסמה זמנית</span>
          <span class="copyable adm-cred-v" dir="ltr">${TRIPMAKER.esc(user.temp_password)}</span></div>
      </div>
      <button class="btn btn-amber btn-lg" id="au-done" style="width:100%;justify-content:center">סיימתי להעתיק</button>`);
    wrap.querySelector('#au-done').onclick = () => { close(); if (tab === 'users') load(); };
  }

  function confirmDeleteUser(u, onDone) {
    const owns = u.trip_count > 0;
    const { wrap, close } = admModal(`
      <h2>מחיקת משתמש</h2>
      <p class="modal-sub">${TRIPMAKER.esc(u.name)} · <span dir="ltr">${TRIPMAKER.esc(u.email)}</span></p>
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
        const r = await TRIPMAKER.api(`/api/admin/users/${u.id}${dropTrips ? '?trips=delete' : ''}`, { method: 'DELETE' });
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
          await TRIPMAKER.api('/api/trips/' + id, { method: 'PATCH', body: JSON.stringify({ is_public: box.checked }) });
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
          await TRIPMAKER.api('/api/trips/' + tr.dataset.id, { method: 'DELETE' });
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
          await TRIPMAKER.api('/api/admin/users/' + id, { method: 'PATCH', body: JSON.stringify({ is_admin: box.checked }) });
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

  function announceList() {
    return `
      <div class="adm-announce-list">
        ${rows.map((a) => {
          const live = !!a.published_at;
          const when = heDate(a.published_at || a.created_at);
          return `
            <article class="adm-announce glass" data-id="${a.id}">
              <div class="adm-announce-top">
                <span class="adm-announce-badge ${live ? 'live' : 'draft'}">${live ? 'פורסם' : 'טיוטה'}</span>
                <span class="adm-sub">${when}${a.author_name ? ` · ${TRIPMAKER.esc(a.author_name)}` : ''}</span>
                <span class="adm-announce-actions">
                  ${live ? '' : `<button type="button" class="btn btn-ghost adm-pub-ann" title="פרסום עכשיו">פרסום</button>`}
                  <button type="button" class="adm-del" title="מחיקת ההודעה" aria-label="מחיקה">${ICON.trash}</button>
                </span>
              </div>
              <h3 class="adm-announce-title">${TRIPMAKER.esc(a.title)}</h3>
              <p class="adm-announce-body">${TRIPMAKER.esc(a.body)}</p>
            </article>`;
        }).join('')}
      </div>`;
  }

  function openComposeAnnounce() {
    const { wrap, close } = admModal(`
      <h2>הודעת מערכת חדשה</h2>
      <p class="modal-sub">תוצג כבאנר לכל מי שיפתח את האתר בפעם הראשונה מאז הפרסום</p>
      <div class="field"><label>כותרת</label>
        <input type="text" id="an-title" maxlength="160" placeholder="מה חדש ב-TRIP MAKER"></div>
      <div class="field"><label>תוכן ההודעה</label>
        <textarea id="an-body" rows="6" maxlength="4000" placeholder="ספרו על העדכון — בקצרה ובבהירות"></textarea></div>
      <label class="adm-check"><input type="checkbox" id="an-publish" checked>
        <span>לפרסם מיד — המשתמשים יראו את ההודעה בכניסה הבאה</span></label>
      <label class="adm-check adm-check-switch" id="an-notify-row">
        <span class="adm-switch"><input type="checkbox" id="an-notify" checked><span></span></span>
        <span>לשלוח הודעת נוטיפיקציה לכולם — למי ששמר למסך הבית ואישר התראות</span></label>
      <div class="form-error" id="an-err"></div>
      <div class="adm-modal-actions">
        <button class="btn btn-ghost" id="an-cancel">ביטול</button>
        <button class="btn btn-amber" id="an-go">שליחה</button>
      </div>`);
    const publishEl = wrap.querySelector('#an-publish');
    const notifyEl = wrap.querySelector('#an-notify');
    const notifyRow = wrap.querySelector('#an-notify-row');
    const syncNotify = () => {
      const on = publishEl.checked;
      notifyEl.disabled = !on;
      if (!on) notifyEl.checked = false;
      notifyRow.classList.toggle('is-off', !on);
    };
    publishEl.addEventListener('change', syncNotify);
    syncNotify();
    wrap.querySelector('#an-cancel').onclick = close;
    wrap.querySelector('#an-go').onclick = async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const title = wrap.querySelector('#an-title').value.trim();
      const body = wrap.querySelector('#an-body').value.trim();
      const publish = publishEl.checked;
      const notify = publish && notifyEl.checked;
      const err = wrap.querySelector('#an-err');
      err.textContent = '';
      if (!title) { err.textContent = 'צריך כותרת'; return; }
      if (!body) { err.textContent = 'צריך תוכן'; return; }
      btn.disabled = true;
      try {
        await TRIPMAKER.api('/api/admin/announcements', {
          method: 'POST',
          body: JSON.stringify({ title, body, publish, notify }),
        });
        close();
        if (tab === 'announce') load();
        else setTab('announce');
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    };
  }

  function wireAnnounce() {
    panel.querySelectorAll('.adm-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.adm-announce');
        const title = card.querySelector('.adm-announce-title')?.textContent?.trim() || 'ההודעה';
        if (!confirm(`למחוק את "${title}"?`)) return;
        btn.disabled = true;
        try {
          await TRIPMAKER.api('/api/admin/announcements/' + card.dataset.id, { method: 'DELETE' });
          card.remove();
          rows = rows.filter((a) => String(a.id) !== card.dataset.id);
          if (!rows.length) render();
        } catch (err) { btn.disabled = false; alert(err.message); }
      });
    });
    panel.querySelectorAll('.adm-pub-ann').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.adm-announce');
        if (!confirm('לפרסם את ההודעה עכשיו?')) return;
        const notify = confirm('לשלוח גם הודעת נוטיפיקציה לכולם?');
        btn.disabled = true;
        try {
          const updated = await TRIPMAKER.api('/api/admin/announcements/' + card.dataset.id + '/publish', {
            method: 'POST',
            body: JSON.stringify({ notify }),
          });
          const i = rows.findIndex((a) => String(a.id) === card.dataset.id);
          if (i >= 0) rows[i] = { ...rows[i], ...updated };
          render();
        } catch (err) { btn.disabled = false; alert(err.message); }
      });
    });
  }

  function setTab(next) {
    tab = next;
    tabTrips.classList.toggle('active', next === 'trips');
    tabUsers.classList.toggle('active', next === 'users');
    tabAnnounce.classList.toggle('active', next === 'announce');
    searchEl.placeholder = next === 'trips'
      ? 'חיפוש לפי שם, יעד, אימייל או קוד טיול…'
      : 'חיפוש לפי שם או אימייל…';
    addUserBtn.style.display = next === 'users' ? '' : 'none';
    addAnnounceBtn.style.display = next === 'announce' ? '' : 'none';
    load();
  }
  addUserBtn.addEventListener('click', openAddUser);
  addAnnounceBtn.addEventListener('click', openComposeAnnounce);
  tabTrips.addEventListener('click', () => setTab('trips'));
  tabUsers.addEventListener('click', () => setTab('users'));
  tabAnnounce.addEventListener('click', () => setTab('announce'));

  let searchTimer;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  });

  loadStats();
  load();
});
