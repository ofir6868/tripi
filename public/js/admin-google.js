// /admin/google — the Google Places ledger. Everything here is read from
// GET /api/admin/google (routes/admin.js), which is built from lib/google-skus.js and the
// meters in lib/api-budget.js; this file only draws it. The server rejects non-admins, so
// a curious visitor who loads the page gets a locked panel.
document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('gg-root');
  const sub = document.getElementById('gg-sub');
  const tip = document.getElementById('gg-tip');
  const esc = (s) => TRIPMAKER.esc(s == null ? '' : String(s));
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL'));
  const usd = (v) => `$${Number(v || 0).toFixed(2)}`;

  const locked = (msg) => {
    root.innerHTML = `<div class="adm-panel glass"><div class="empty-state"><div class="big">🔒</div><p>${esc(msg)}</p></div></div>`;
  };
  if (!TRIPMAKER.token) {
    locked('צריך להתחבר כדי להיכנס לאזור הניהול.');
    openAuthModal(() => location.reload(), 'login', 'admin');
    return;
  }
  await TRIPMAKER.refreshUser();
  if (!TRIPMAKER.user || !TRIPMAKER.user.is_admin) { locked('האזור הזה מיועד למנהלי המערכת.'); return; }

  // Hebrew for every state a SKU can be in. Status is never colour alone: an icon and a
  // word ride with it, so the chip reads the same in forced colours and to a screen reader.
  const STATUS = {
    ok: { label: 'תקין', cls: 'ok', icon: '<path d="M20 6 9 17l-5-5"/>' },
    near: { label: 'מתקרב לתקרה', cls: 'warn', icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>' },
    paced: { label: 'הגיע לקצב של היום — ממשיך מחר', cls: 'warn', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    spent: { label: 'התקרה החודשית נוצלה — עובד בחלופה', cls: 'bad', icon: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>' },
    off: { label: 'אין מפתח Google — עובד בחלופה', cls: 'off', icon: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' },
  };
  const chip = (s) => `<span class="gg-chip ${STATUS[s].cls}"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${STATUS[s].icon}</svg>${STATUS[s].label}</span>`;

  const heDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
  const heWhen = (iso) => new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  let data;
  try {
    data = await TRIPMAKER.api('/api/admin/google');
  } catch (err) {
    root.innerHTML = `<div class="adm-panel glass"><div class="empty-day">${esc(err.message)}</div></div>`;
    return;
  }

  const daysLeft = Math.max(0, Math.ceil((new Date(data.next_reset) - new Date(data.now)) / 86400000));
  sub.textContent = `החודש של גוגל מתאפס ב-${heWhen(data.next_reset)} (שעון ישראל) — בעוד ${daysLeft} ימים`;

  const billed = data.skus.filter((s) => s.free !== null);
  const overFree = billed.filter((s) => s.used > s.free);
  const totals = {
    cost: data.skus.reduce((a, s) => a + s.projected_cost, 0),
    used: billed.reduce((a, s) => a + s.used, 0),
    saved: data.skus.reduce((a, s) => a + s.month.cache_hits, 0),
    refused: data.skus.reduce((a, s) => a + s.month.refused, 0),
    rejected: data.skus.reduce((a, s) => a + s.month.rejected, 0),
  };

  root.innerHTML = `
    ${data.has_key ? '' : '<div class="gg-banner bad">GOOGLE_PLACES_API_KEY לא מוגדר בשרת — אף קריאה לא יוצאת לגוגל, וכל הפיצ׳רים עובדים בחלופה.</div>'}
    <div class="adm-stats">
      <div class="adm-stat glass">
        <div class="adm-stat-n">${usd(totals.cost)}</div>
        <div class="adm-stat-label">עלות צפויה החודש</div>
        <div class="adm-stat-sub">מעבר לשכבה החינמית, בקצב של השבוע האחרון</div>
      </div>
      <div class="adm-stat glass">
        <div class="adm-stat-n">${n(totals.used)}</div>
        <div class="adm-stat-label">קריאות שחויבו החודש</div>
        <div class="adm-stat-sub">${overFree.length
          ? `מעבר לחינם ב-${overFree.map((s) => esc(s.sku)).join(', ')}`
          : 'כל סוג בתוך המכסה החינמית שלו'}</div>
      </div>
      <div class="adm-stat glass">
        <div class="adm-stat-n">${n(totals.saved)}</div>
        <div class="adm-stat-label">נענו מהמטמון</div>
        <div class="adm-stat-sub">קריאות שלא היינו צריכים לשלוח</div>
      </div>
      <div class="adm-stat glass">
        <div class="adm-stat-n">${n(totals.refused)}</div>
        <div class="adm-stat-label">נעצרו אצלנו</div>
        <div class="adm-stat-sub">${totals.rejected ? `ועוד ${n(totals.rejected)} שגוגל דחה (לא חויבו)` : 'קצב או תקרה — עברו לחלופה'}</div>
      </div>
    </div>

    <h2 class="gg-h2">לפי סוג קריאה (SKU)</h2>
    <p class="gg-lede">כל שורה היא דבר אחד שגוגל מחייב עליו בנפרד, עם מכסה חינמית משלו. התקרה שלנו יושבת מתחת לחינמית, והיא משתחררת לאורך החודש — כך שיום עמוס אחד לא יכול לגמור את החודש.</p>
    <div class="gg-skus">${data.skus.map(skuCard).join('')}</div>

    <h2 class="gg-h2">מכסות יומיות בקונסול של גוגל</h2>
    <p class="gg-lede">המכסות שהוגדרו ב-Google Cloud Console, ליד מה שנשלח היום. מתאפסות בחצות שעון פסיפיק, כמו החודש. בקשה שנחסמה במכסה לא מחויבת, והפיצ׳ר עובר לחלופה שלו.</p>
    <div class="adm-panel glass">${methodsTable()}</div>

    <h2 class="gg-h2">השוואה מול המונה של גוגל</h2>
    ${reconcile()}

    <details class="gg-how glass">
      <summary>איך הספירה עובדת</summary>
      <ul>
        <li><b>נספר רק מה שגוגל מחייב:</b> בקשה שנענתה בהצלחה (2xx). כל תשובה אחרת — 400, 403, 429, 500 — מוחזרת למונה, כי גוגל לא מחייב עליה.</li>
        <li><b>בקשה שלא נענתה בזמן נשארת ספורה:</b> ייתכן שגוגל ענה וחייב אחרי שהפסקנו לחכות.</li>
        <li><b>החודש מתאפס לפי שעון פסיפיק,</b> כמו אצל גוגל, ולא לפי UTC.</li>
        <li><b>קצב:</b> התקרה החודשית משתחררת לאורך החודש — עד היום ה-${data.day_of_month} מתוך ${data.days_in_month} מותר להשתמש בחלק של ${data.day_of_month + data.pace_ahead_days} ימים ממנה (עוד ${data.pace_ahead_days} ימים של מרווח). מה שלא נוצל עובר הלאה.</li>
        <li><b>המכסה החינמית של גוגל היא לכל חשבון החיוב,</b> משותפת לכל הפרויקטים שעליו. המונה כאן רואה רק את TRIP MAKER — ולכן התקרות מתחת לחינמית.</li>
        <li><b>המונים נשמרים בגיבוי החודשי,</b> כך שהחלפת מסד הנתונים באמצע החודש לא מאפסת אותם.</li>
        <li>המספרים מתעדכנים כל דקה. התקרות משתנות במשתני סביבה (שם המשתנה מופיע בכל כרטיס); ההגדרות עצמן ב-<code dir="ltr">lib/google-skus.js</code>.</li>
      </ul>
    </details>`;

  wireTips();

  function skuCard(s) {
    const unmetered = s.limit === null;
    // the track is our ceiling; Google's free line only gets a mark when an env override
    // has put the ceiling above it — which is the one case it is news
    const scale = unmetered ? Math.max(1, s.used) : Math.max(1, s.limit, s.used);
    const pct = (v) => `${Math.min(100, (v / scale) * 100).toFixed(2)}%`;
    const sev = s.status === 'spent' ? 'bad' : (s.status === 'paced' || s.status === 'near') ? 'warn' : 'ok';
    const today = s.today || { ok: 0, rejected: 0, timeouts: 0, refused: 0, cache_hits: 0 };
    return `
      <article class="gg-sku glass">
        <header class="gg-sku-head">
          <div>
            <h3>${esc(s.what)}</h3>
            <div class="gg-sku-id" dir="ltr">${esc(s.sku)} · ${esc(s.method)}</div>
          </div>
          ${chip(s.status)}
        </header>

        ${unmetered ? `
          <p class="gg-free-note">חינמי ללא הגבלה אצל גוגל. נספר רק כדי שמכסת ${esc(s.method)} בקונסול תסתכם נכון — ${n(s.used)} החודש.</p>` : `
          <div class="gg-meter ${sev}" role="img" aria-label="${n(s.used)} מתוך ${n(s.limit)} החודש">
            <span class="gg-fill" style="width:${pct(s.used)}"></span>
            ${s.allowed_now < s.limit ? `<span class="gg-mark pace" style="inset-inline-start:${pct(s.allowed_now)}" title="מותר עד היום: ${n(s.allowed_now)}"></span>` : ''}
            ${s.free && s.free < scale ? `<span class="gg-mark free" style="inset-inline-start:${pct(s.free)}" title="חינם אצל גוגל עד ${n(s.free)}"></span>` : ''}
          </div>
          <div class="gg-meter-legend">
            <span><b>${n(s.used)}</b> מתוך ${n(s.limit)} (התקרה שלנו)</span>
            ${s.allowed_now < s.limit ? `<span><i class="gg-key pace"></i>מותר עד היום ${n(s.allowed_now)}</span>` : ''}
            <span>${s.free && s.free < scale ? '<i class="gg-key free"></i>' : ''}גוגל: חינם עד ${n(s.free)}, אחר כך $${s.price_per_1k} ל-1,000</span>
          </div>`}

        <dl class="gg-facts">
          <div><dt>היום</dt><dd>${n(today.ok)} חויבו${today.rejected ? ` · ${n(today.rejected)} נדחו` : ''}${today.timeouts ? ` · ${n(today.timeouts)} לא נענו` : ''}${today.refused ? ` · ${n(today.refused)} נעצרו` : ''} · ${n(today.cache_hits)} מהמטמון</dd></div>
          ${unmetered ? '' : `<div><dt>צפי לסוף החודש</dt><dd>${n(s.projected)}${s.projected_cost ? ` · <span class="gg-cost">${usd(s.projected_cost)}</span>` : ''}</dd></div>`}
          ${unmetered ? '' : `<div><dt>כשזה נגמר</dt><dd>${esc(s.fallback)}</dd></div>`}
          ${s.env ? `<div><dt>התקרה נקבעת ב-</dt><dd dir="ltr" class="gg-env">${esc(s.env)}</dd></div>` : ''}
        </dl>

        ${spark(s)}

        ${s.last_error ? `<div class="gg-err"><b>שגיאה אחרונה · ${esc(heWhen(s.last_error.at))}</b><code dir="ltr">${esc(s.last_error.text)}</code></div>` : ''}
      </article>`;
  }

  // 30 days of billed calls, one column a day. A single series, so no legend: the caption
  // names it. Past days are the recessive tone and today carries the accent. Every column
  // has a hover/focus tooltip with the day's full breakdown, and the same numbers sit in
  // a table under the chart for anyone who cannot use the hover.
  function spark(s) {
    const byDay = new Map(s.days.map((d) => [d.day, d]));
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const iso = new Date(new Date(`${data.today}T12:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
      days.push(byDay.get(iso) || { day: iso, ok: 0, rejected: 0, timeouts: 0, refused: 0, cache_hits: 0 });
    }
    const max = Math.max(1, ...days.map((d) => d.ok + d.timeouts));
    const any = days.some((d) => d.ok || d.timeouts || d.rejected || d.refused || d.cache_hits);
    if (!any) return '<p class="gg-spark-empty">עוד אין רישום יומי — הוא מתחיל להצטבר מהקריאה הראשונה.</p>';
    return `
      <figure class="gg-spark">
        <figcaption>קריאות שחויבו ביום · 30 הימים האחרונים</figcaption>
        <div class="gg-cols" dir="ltr">
          ${days.map((d) => {
            const v = d.ok + d.timeouts;
            const h = v ? Math.max(6, (v / max) * 100) : 0;
            const tipText = `${heDay(d.day)}|חויבו ${n(d.ok)}${d.timeouts ? ` · לא נענו ${n(d.timeouts)}` : ''}|נדחו ע״י גוגל ${n(d.rejected)} · נעצרו אצלנו ${n(d.refused)}|מהמטמון ${n(d.cache_hits)}`;
            return `<span class="gg-col${d.day === data.today ? ' today' : ''}" tabindex="0" data-tip="${esc(tipText)}"
              aria-label="${esc(tipText.replace(/\|/g, ', '))}"><i style="height:${h}%"></i></span>`;
          }).join('')}
        </div>
        <div class="gg-axis" dir="ltr"><span>${heDay(days[0].day)}</span><span>היום</span></div>
        <details class="gg-table">
          <summary>טבלה</summary>
          <table class="adm-table">
            <thead><tr><th>יום</th><th class="num">חויבו</th><th class="num">לא נענו</th><th class="num">נדחו</th><th class="num">נעצרו</th><th class="num">מטמון</th></tr></thead>
            <tbody>${days.filter((d) => d.ok || d.timeouts || d.rejected || d.refused || d.cache_hits).reverse().map((d) => `
              <tr><td>${heDay(d.day)}</td><td class="num">${n(d.ok)}</td><td class="num">${n(d.timeouts)}</td><td class="num">${n(d.rejected)}</td><td class="num">${n(d.refused)}</td><td class="num">${n(d.cache_hits)}</td></tr>`).join('')}
            </tbody>
          </table>
        </details>
      </figure>`;
  }

  function methodsTable() {
    return `
      <table class="adm-table">
        <thead><tr><th>מתודה בגוגל</th><th>מה עובר בה</th><th class="num">נשלחו היום</th><th class="num">מכסה יומית</th><th></th></tr></thead>
        <tbody>${data.methods.map((m) => {
          const q = m.console_daily_quota;
          const ratio = q ? m.today_sent / q : 0;
          const sev = ratio >= 1 ? 'bad' : ratio >= 0.8 ? 'warn' : 'ok';
          const names = m.meters.map((k) => data.skus.find((s) => s.meter === k).sku);
          return `
            <tr>
              <td dir="ltr" class="gg-method">${esc(m.method)}Request</td>
              <td class="adm-sub">${names.map(esc).join(' · ')}</td>
              <td class="num">${n(m.today_sent)}</td>
              <td class="num">${n(q)}</td>
              <td class="gg-mini-cell"><div class="gg-meter mini ${sev}" role="img" aria-label="${Math.round(ratio * 100)}% מהמכסה היומית"><span class="gg-fill" style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></span></div></td>
            </tr>`;
        }).join('')}</tbody>
      </table>
      <p class="gg-foot">המספרים כאן הם העתק של הקונסול (<code dir="ltr">CONSOLE_DAILY_QUOTA</code> ב-<code dir="ltr">lib/google-skus.js</code>) — שינוי בקונסול צריך להיכנס גם לשם.</p>`;
  }

  function reconcile() {
    const g = data.google;
    if (!g.connected) {
      return `
        <div class="adm-panel glass gg-connect">
          <p><b>לא מחובר.</b> המונה שלנו סופר את מה שהאפליקציה שלחה. כדי לוודא שהוא מדויק — שאין קריאה שעוקפת אותו, ושהחלפת מסד נתונים לא איפסה אותו — אפשר לחבר את המונה של גוגל עצמו (Cloud Monitoring), והטבלה תופיע כאן.</p>
          <ol>
            <li>ב-Google Cloud Console, בפרויקט שבו נמצא מפתח ה-Places, בעמוד IAM: לתת ל-service account את התפקיד <b dir="ltr">Monitoring Viewer</b> — או ליצור service account חדש רק בשביל זה.</li>
            <li>ליצור לו מפתח מסוג JSON.</li>
            <li>ב-Render, משתנה סביבה <code dir="ltr">GOOGLE_MONITORING_KEY</code> עם תוכן ה-JSON.</li>
          </ol>
          ${g.error ? `<div class="gg-err"><code dir="ltr">${esc(g.error)}</code></div>` : ''}
        </div>`;
    }
    if (g.error) {
      return `<div class="adm-panel glass gg-connect"><p><b>לא הצלחתי לקרוא את המונה של גוגל.</b></p><div class="gg-err"><code dir="ltr">${esc(g.error)}</code></div></div>`;
    }
    return `
      <div class="adm-panel glass">
        <table class="adm-table">
          <thead><tr><th>מתודה</th><th class="num">אצלנו (חויבו)</th><th class="num">אצל גוגל (2xx)</th><th class="num">הפרש</th><th class="num">גוגל: לא 2xx</th></tr></thead>
          <tbody>${data.methods.map((m) => {
            const gm = m.google || { ok: 0, other: 0 };
            const diff = gm.ok - m.month_billed;
            return `
              <tr>
                <td dir="ltr" class="gg-method">${esc(m.method)}</td>
                <td class="num">${n(m.month_billed)}</td>
                <td class="num">${n(gm.ok)}</td>
                <td class="num ${Math.abs(diff) > Math.max(3, gm.ok * 0.05) ? 'gg-diff' : ''}"><bdi dir="ltr">${diff > 0 ? '+' : ''}${n(diff)}</bdi></td>
                <td class="num">${n(gm.other)}</td>
              </tr>`;
          }).join('')}</tbody>
        </table>
        <p class="gg-foot">פרויקט <span dir="ltr">${esc(g.project)}</span> · נקרא ב-${esc(heWhen(g.fetched_at))} · הנתונים של גוגל מתעכבים בכמה דקות. הפרש חיובי = גוגל ספר יותר מאיתנו: קריאה שעוקפת את המונה, שימוש אחר באותו פרויקט, או מונה שאופס. בקשות שלא נענו אצלנו בזמן נספרות אצלנו גם אם גוגל לא השלים אותן.</p>
      </div>`;
  }

  function wireTips() {
    const show = (el) => {
      const [head, ...lines] = el.dataset.tip.split('|');
      tip.innerHTML = `<b>${esc(head)}</b>${lines.map((l) => `<span>${esc(l)}</span>`).join('')}`;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
    };
    const hide = () => { tip.hidden = true; };
    root.querySelectorAll('.gg-col').forEach((el) => {
      el.addEventListener('mouseenter', () => show(el));
      el.addEventListener('focus', () => show(el));
      el.addEventListener('mouseleave', hide);
      el.addEventListener('blur', hide);
    });
    window.addEventListener('scroll', hide, { passive: true });
  }
});
