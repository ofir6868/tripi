// Admin panel: site-wide view of trips and users.
// Everything here is a convenience layer — the server rejects each of these calls
// for non-admins, so a curious visitor who loads /admin just gets a locked page.
document.addEventListener('DOMContentLoaded', async () => {
  const panel = document.getElementById('adm-panel');
  const statsEl = document.getElementById('adm-stats');
  const searchEl = document.getElementById('adm-search');
  const tabTrips = document.getElementById('tab-trips');
  const tabUsers = document.getElementById('tab-users');

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
    panel.innerHTML = '<span class="skl skl-row"></span><span class="skl skl-row"></span><span class="skl skl-row"></span>';
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
              <span class="copyable adm-code edit" data-copy="${t.edit_code || ''}" title="קוד עריכה — לחיצה מעתיקה">✏️${t.edit_code || '—'}</span>
            </td>
            <td class="num">${t.item_count}</td>
            <td class="num">${t.likes}</td>
            <td class="adm-sub">${heDate(t.created_at)}</td>
            <td><label class="adm-switch"><input type="checkbox" class="adm-pub" ${t.is_public ? 'checked' : ''}><span></span></label></td>
            <td><button class="adm-del" title="מחיקת הטיול">🗑</button></td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  function usersTable() {
    return `
      <table class="adm-table">
        <thead><tr>
          <th>שם</th><th>אימייל</th><th class="num">טיולים</th><th>נרשם</th><th>מנהל</th>
        </tr></thead>
        <tbody>${rows.map((u) => `
          <tr data-id="${u.id}">
            <td>${TRIPI.esc(u.name)}${u.id === TRIPI.user.id ? ' <span class="adm-you">אתם</span>' : ''}</td>
            <td dir="ltr">${TRIPI.esc(u.email)}</td>
            <td class="num">${u.trip_count}</td>
            <td class="adm-sub">${heDate(u.created_at)}</td>
            <td><label class="adm-switch"><input type="checkbox" class="adm-admin" ${u.is_admin ? 'checked' : ''}
              ${u.id === TRIPI.user.id ? 'disabled title="אי אפשר להסיר הרשאות מעצמכם"' : ''}><span></span></label></td>
          </tr>`).join('')}</tbody>
      </table>`;
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
  }

  function setTab(next) {
    tab = next;
    tabTrips.classList.toggle('active', next === 'trips');
    tabUsers.classList.toggle('active', next === 'users');
    searchEl.placeholder = next === 'trips'
      ? 'חיפוש לפי שם, יעד, אימייל או קוד טיול…'
      : 'חיפוש לפי שם או אימייל…';
    load();
  }
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
