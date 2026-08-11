// Notification opt-in. The browser's permission prompt is a one-shot resource —
// deny it once and it's gone for good on that device — so it is never fired on
// page load. It fires only from a deliberate tap on our own card, which explains
// what the notifications are for before the OS dialog appears.
const TRIPI_PUSH = (() => {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // iOS only exposes push to a PWA that was added to the home screen (16.4+), so
  // in mobile Safari we don't offer a switch that can't be flipped — we say why
  const iOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  const needsInstall = iOS && !standalone;

  const b64ToU8 = (base64) => {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  };

  let keyPromise = null;
  const serverKey = () => {
    if (!keyPromise) keyPromise = TRIPI.api('/api/push/key').catch(() => ({ enabled: false }));
    return keyPromise;
  };

  const state = async () => {
    if (!supported || needsInstall || !TRIPI.user) return 'unavailable';
    const { enabled } = await serverKey();
    if (!enabled) return 'unavailable';
    if (Notification.permission === 'denied') return 'blocked';
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  };

  async function enable() {
    const { enabled, key } = await serverKey();
    if (!enabled || !key) throw new Error('התראות אינן זמינות כרגע');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('ההתראות חסומות בדפדפן — אפשר להפעיל אותן בהגדרות האתר');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
    await TRIPI.api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    return true;
  }

  async function disable() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return true;
    // tell the server first — if unsubscribing locally succeeded but the row
    // stayed, we'd keep pushing into a dead endpoint until it 410s
    await TRIPI.api('/api/push/unsubscribe', {
      method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
    return true;
  }

  return { supported, needsInstall, state, enable, disable };
})();

/* ---------------- the ask ---------------- */
/* A slim card under the action bar, shown once to a co-planner who hasn't decided
   yet. Dismiss is remembered; the switch inside the participants screen stays as
   the permanent control either way. */

const PUSH_BELL = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

async function offerPushOptIn(anchor) {
  if (localStorage.getItem('tm_push_asked')) return;
  if (await TRIPI_PUSH.state() !== 'off') return;

  const card = document.createElement('div');
  card.className = 'push-ask glass';
  card.innerHTML = `
    <span class="pa-icon">${PUSH_BELL}</span>
    <span class="pa-text">
      <strong class="pa-title">שנודיע לכם כשמישהו מצטרף?</strong>
      <span class="pa-sub">התראה קצרה כשחבר נכנס לתכנון או משנה משהו במסלול. שום דבר מעבר.</span>
    </span>
    <span class="pa-actions">
      <button type="button" class="btn btn-amber pa-yes">כן, עדכנו אותי</button>
      <button type="button" class="pa-no">לא עכשיו</button>
    </span>`;
  anchor.insertAdjacentElement('afterend', card);
  requestAnimationFrame(() => card.classList.add('in'));

  const close = () => {
    localStorage.setItem('tm_push_asked', '1');
    card.classList.remove('in');
    setTimeout(() => card.remove(), 300);
  };
  card.querySelector('.pa-no').onclick = close;
  card.querySelector('.pa-yes').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'מפעילים…';
    try {
      await TRIPI_PUSH.enable();
      card.classList.add('done');
      card.querySelector('.pa-title').textContent = 'מעולה — נעדכן אתכם 🔔';
      card.querySelector('.pa-sub').textContent = 'אפשר לכבות בכל רגע במסך המשתתפים.';
      card.querySelector('.pa-actions').remove();
      setTimeout(close, 2600);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'כן, עדכנו אותי';
      card.querySelector('.pa-sub').textContent = err.message;
    }
  };
}
