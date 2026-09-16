// The /my page: the trips you own, the drafts you have not shared yet, and the ones
// friends let you into — three sections off one /api/my-trips call.
//
// This lived inline in my.html until the page's scripts were deferred. A deferred
// script executes after parsing but BEFORE DOMContentLoaded, while an inline script
// runs during it — so an inline DOMContentLoaded listener is always registered
// first, and would run before common.js has built the auth modal this page opens
// for a signed-out visitor. As a file loaded last, it registers last and runs last,
// which is the order it always relied on.
document.addEventListener('DOMContentLoaded', async () => {
  const wrap = document.getElementById('my-wrap');
  const grid = document.getElementById('my-grid');
  if (!TRIPMAKER.user) { grid.innerHTML = ''; openAuthModal(() => location.reload(), 'login', 'my_trips'); return; }
  // a draft card shows a "בתכנון" tag where the (not yet revealed) code chip
  // would be; everything else — cover, delete, link — behaves the same
  const card = (t) => `
      <a class="trip-card" href="/trip/${t.share_code}">
        <div class="tc-media">
          <img class="tc-img" src="${TRIPMAKER.esc(t.cover_image || '')}" alt="" loading="lazy" onerror="this.removeAttribute('src')">
          <span class="tc-emoji">${t.emoji || '🧭'}</span>
          <span class="tc-days">${t.days} ימים</span>
          ${t.is_draft ? '<span class="tc-role draft">✍️ בתכנון</span>' : (t.is_mine ? '' : '<span class="tc-role">משתתף</span>')}
          ${!t.is_mine ? '' : `<button class="tc-delete" data-id="${t.id}" title="מחיקת הטיול" aria-label="מחיקת הטיול">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path class="td-lid" d="M3.5 6h17M9.5 6V4.4A1.4 1.4 0 0 1 10.9 3h2.2a1.4 1.4 0 0 1 1.4 1.4V6"/>
              <path d="M18.4 6l-.8 12.7A2 2 0 0 1 15.6 20.6H8.4a2 2 0 0 1-2-1.9L5.6 6"/>
              <path d="M10.3 10.4v5.9M13.7 10.4v5.9"/>
            </svg>
          </button>`}
          ${t.is_draft ? '' : `<span class="tc-code-chip copyable" data-copy="${t.share_code}" title="לחיצה מעתיקה את קוד הטיול">#${t.share_code}</span>`}
          <div class="tc-body">
            <div class="tc-country">${TRIPMAKER.esc(t.country || '')}</div>
            <div class="tc-title">${TRIPMAKER.esc(t.title)}</div>
            <div class="tc-dest">${TRIPMAKER.esc(t.destination)}</div>
          </div>
        </div>
      </a>`;
  try {
    const trips = await TRIPMAKER.api('/api/my-trips');
    if (!trips.length) { grid.innerHTML = ''; document.getElementById('empty').style.display = ''; return; }
    // three sections, in this order: trips friends shared with me (joined as a
    // participant), my own drafts, then the trips I own. A section with nothing
    // in it is skipped — except "הטיולים שלי", which explains itself instead
    const shared = trips.filter((t) => !t.is_mine);
    const drafts = trips.filter((t) => t.is_mine && t.is_draft);
    const mine = trips.filter((t) => t.is_mine && !t.is_draft);
    const section = (title, list) => `
        <h2 class="my-sec">${title}</h2>
        <div class="my-grid">${list.map(card).join('')}</div>`;
    if (shared.length || drafts.length) {
      const mineHint = drafts.length
        ? 'כשמסיימים לתכנן טיוטה — הטיול עובר לכאן, עם קוד שיתוף'
        : 'עוד לא תכננתם טיול משלכם — <a href="/plan">מתכננים אחד עכשיו</a>';
      wrap.innerHTML = `
        ${shared.length ? section('🤝 טיולים משותפים', shared) : ''}
        ${drafts.length ? section('✍️ בתכנון', drafts) : ''}
        ${mine.length ? section('🧳 הטיולים שלי', mine) : `<h2 class="my-sec">🧳 הטיולים שלי</h2><div class="my-sec-hint">${mineHint}</div>`}`;
    } else {
      grid.innerHTML = mine.map(card).join('');
    }
    wrap.querySelectorAll('.tc-delete').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (b.disabled) return;
        if (!confirm('למחוק את הטיול לצמיתות?')) return;
        b.disabled = true;
        try { await TRIPMAKER.api('/api/trips/' + b.dataset.id, { method: 'DELETE' }); }
        catch { b.disabled = false; return; }
        location.reload();
      });
    });
  } catch (err) {
    grid.innerHTML = '<div class="empty-day">' + TRIPMAKER.esc(err.message) + '</div>';
  }
});
