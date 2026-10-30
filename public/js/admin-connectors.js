// /admin/connectors — the Google Cloud checklist for the AI's connectors (lib/connectors.js).
// Everything here comes from GET /api/admin/connectors-setup: the redirect URI to paste, the
// three APIs, the three scopes, and console links already opened on the right project.
// The last step is a real connection by the admin — the callback comes back here with
// ?connected=… or ?connectors_error=…, which is the proof the console work is done.
document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('cs-root');
  const esc = (s) => TRIPMAKER.esc(s == null ? '' : String(s));
  const locked = (msg) => { root.innerHTML = `<div class="adm-panel glass"><div class="empty-state"><div class="big">🔒</div><p>${esc(msg)}</p></div></div>`; };
  if (!TRIPMAKER.token) { locked('צריך להתחבר כדי להיכנס לאזור הניהול.'); openAuthModal(() => location.reload(), 'login', 'admin'); return; }
  await TRIPMAKER.refreshUser();
  if (!TRIPMAKER.user || !TRIPMAKER.user.is_admin) { locked('האזור הזה מיועד למנהלי המערכת.'); return; }

  let d;
  try { d = await TRIPMAKER.api('/api/admin/connectors-setup'); } catch (err) { locked((err && err.message) || 'לא הצלחתי לטעון'); return; }

  const q = new URLSearchParams(location.search);
  const connected = q.get('connected');
  const err = q.get('connectors_error') || (q.get('refused') ? 'Google לא אישר את ההרשאות שנבחרו' : '');
  if (connected || err) history.replaceState(null, '', location.pathname);

  // the project the console links open on: what the admin typed here last time, else
  // what the server derived. Links are built here so a change applies at once.
  const PKEY = 'tripmaker_gcp_project';
  let project = localStorage.getItem(PKEY) || d.project || '';
  const pq = () => (project ? `?project=${encodeURIComponent(project)}` : "");
  const links = () => ({
    apis: d.apis.map((api) => ({ api, label: api.split('.')[0].replace('calendar-json', 'Calendar').replace('gmail', 'Gmail').replace('drive', 'Drive'), href: `https://console.cloud.google.com/apis/library/${api}${pq()}` })),
    client: d.client_id ? `https://console.cloud.google.com/auth/clients/${encodeURIComponent(d.client_id)}${pq()}` : `https://console.cloud.google.com/auth/clients${pq()}`,
    clients: `https://console.cloud.google.com/auth/clients${pq()}`,
    scopes: `https://console.cloud.google.com/auth/scopes${pq()}`,
    audience: `https://console.cloud.google.com/auth/audience${pq()}`,
  });
  const copyRow = (value) => `<div class="cs-copy"><code>${esc(value)}</code><button type="button" data-copy="${esc(value)}">העתקה</button></div>`;
  const go = (href, label, ghost = false) => `<a class="cs-go${ghost ? ' ghost' : ''}" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg></a>`;
  const on = (d.mine && d.mine.on) || [];
  const allOn = ['calendar', 'gmail', 'drive'].every((k) => on.includes(k));
  const next = encodeURIComponent('/admin/connectors');
  const testHref = `/api/connectors/google/start?t=${encodeURIComponent(TRIPMAKER.token)}&services=calendar,gmail,drive&next=${next}`;

  const render = () => {
  const L = links();
  root.innerHTML = `
    ${connected ? `<div class="cs-result glass ok">✓ החיבור עובד — Google החזיר: ${esc(connected)}</div>` : ''}
    <section class="cs-step glass" style="margin-bottom:14px">
      <div class="cs-head"><span class="cs-num">⚙</span><h2>הפרויקט ב-Google Cloud</h2></div>
      <p>הקישורים למטה נפתחים על הפרויקט הזה. ה-OAuth client של ההתחברות יושב בפרויקט שמספרו <b dir="ltr">${esc((d.client_id || '').split('-')[0])}</b> — אם הקונסולה נפתחת על פרויקט אחר, בוחרים את הנכון בבורר הפרויקטים למעלה, מעתיקים את ה-<b>Project ID</b> שלו (למשל tripmaker-gsc) ומדביקים כאן.</p>
      <div class="cs-copy"><input id="cs-project" dir="ltr" value="${esc(project)}" placeholder="project-id" style="flex:1;min-width:0;background:transparent;border:0;color:var(--paper);font:inherit;font-size:.9rem;outline:none"><button type="button" id="cs-project-save">שמירה</button></div>
    </section>
    ${err ? `<div class="cs-result glass bad">✗ ${esc(err)}</div>` : ''}
    ${!d.configured ? '<div class="cs-result glass bad">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET לא מוגדרים בשרת — ההתחברות עם Google וגם החיבורים כבויים</div>' : ''}
    <div class="cs-steps">
      <section class="cs-step glass">
        <div class="cs-head"><span class="cs-num">1</span><h2>להדליק את שלושת ה-APIs</h2></div>
        <p>שלושה קישורים, כל אחד נפתח על ה-API שלו${project ? ` בפרויקט <b dir="ltr">${esc(project)}</b>` : ''}. בכל אחד לוחצים <b>Enable</b>. אם כתוב <b>Manage</b> — הוא כבר דלוק.</p>
        ${L.apis.map((a) => go(a.href, `הפעלת ${a.label} API`)).join('')}
      </section>

      <section class="cs-step glass">
        <div class="cs-head"><span class="cs-num">2</span><h2>להוסיף redirect ל-OAuth client</h2></div>
        <p>בדף שנפתח, תחת <b>Authorized redirect URIs</b> לוחצים <b>+ Add URI</b>, מדביקים, ו-<b>Save</b>. הכתובת הקיימת של ההתחברות נשארת.</p>
        ${copyRow(d.redirect_uri)}
        ${go(L.client, 'פתיחת ה-OAuth client')}
        <div class="cs-note">אם הקישור לא נוחת ישר על הלקוח: ${go(L.clients, 'רשימת הלקוחות', true)} ובוחרים את זה שה-ID שלו מתחיל ב-<span dir="ltr">${esc((d.client_id || '').slice(0, 14))}…</span></div>
      </section>

      <section class="cs-step glass">
        <div class="cs-head"><span class="cs-num">3</span><h2>להוסיף את שלושת ה-scopes</h2></div>
        <p><b>Add or remove scopes</b> → בתיבת <b>Manually add scopes</b> מדביקים את השלוש (שורה לכל אחת) → <b>Add to table</b> → <b>Update</b> → <b>Save</b>.</p>
        ${copyRow(d.scopes.join('\n'))}
        ${go(L.scopes, 'פתיחת Data access (scopes)')}
      </section>

      <section class="cs-step glass">
        <div class="cs-head"><span class="cs-num">4</span><h2>Testing + משתמשי בדיקה</h2></div>
        <p>Gmail ו-Drive הם scopes "מוגבלים": בלי אימות של Google הם עובדים רק כשהאפליקציה ב-<b>Testing</b> ורק למשתמשים ברשימת הבדיקה. בדף שנפתח: Publishing status → <b>Testing</b>, ואז <b>+ Add users</b> עם המיילים שלכם.</p>
        ${d.admin_email ? copyRow(d.admin_email) : ''}
        ${go(L.audience, 'פתיחת Audience')}
        <div class="cs-note">היומן לבדו הוא scope "רגיש" — הוא עובד גם ב-In production עם מסך אזהרה. כדי שכולם יוכלו לחבר Gmail/Drive צריך לעבור אימות אפליקציה של Google (טופס + וידאו), וזה שלב נפרד.</div>
      </section>

      <section class="cs-step glass${allOn ? ' is-done' : ''}">
        <div class="cs-head"><span class="cs-num">${allOn ? '✓' : '5'}</span><h2>בדיקה</h2></div>
        <p>${allOn
          ? `מחובר${d.mine.account ? ` לחשבון <b>${esc(d.mine.account)}</b>` : ''}: יומן, Gmail ו-Drive. אפשר לפתוח צ'אט בטיול ולשאול "מה יש לי ביומן בתאריכי הטיול?".`
          : 'לוחצים, מאשרים את שלושת השירותים אצל Google, וחוזרים לכאן. אם Google מציג <b>redirect_uri_mismatch</b> — שלב 2 לא נשמר; אם <b>access blocked</b> — שלב 4.'}</p>
        ${d.configured ? `<a class="cs-go${allOn ? ' ghost' : ''}" href="${testHref}">${allOn ? 'לחבר שוב' : 'התחברות לשלושת השירותים'}</a>` : ''}
      </section>
    </div>`;

  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try { await TRIPMAKER.copy(b.dataset.copy); b.textContent = 'הועתק ✓'; b.classList.add('is-done'); setTimeout(() => { b.textContent = 'העתקה'; b.classList.remove('is-done'); }, 1600); } catch { b.textContent = 'לא הצלחתי'; }
    };
  });
  const input = root.querySelector('#cs-project');
  const save = () => { project = input.value.trim(); localStorage.setItem(PKEY, project); render(); };
  root.querySelector('#cs-project-save').onclick = save;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  };
  render();
});
