// "הוספה למסך הבית" — the affordance iOS never offers on its own.
//
// On Android and desktop Chrome the browser raises its own install prompt, so the
// site never needed one. iOS has no equivalent: Apple ships no beforeinstallprompt,
// and Add to Home Screen lives unlabelled inside the Share sheet. The result was
// that the one platform where installing actually unlocks something — push only
// exists in an installed iOS PWA — was the one platform that never mentioned it.
//
// So this card is the hint on every platform: a one-tap button where the browser
// gave us a prompt to fire, and the literal Share-sheet steps where it didn't.
const TRIPI_INSTALL = (() => {
  const { iOS, standalone } = TRIPI;  // one definition, shared with push.js

  const DISMISS_KEY = 'tm_install_dismissed';
  const VISITS_KEY = 'tm_visits';
  const DISMISS_DAYS = 30;  // asked and declined is an answer, but not forever
  const MIN_VISITS = 2;     // never on the first look around — the same restraint
                            // the notification card shows: earn the ask first

  // Chromium hands us the prompt exactly once, and only if we cancel its own
  // mini-infobar. Two things about its timing: it can fire before this script runs,
  // and it can fire well after DOMContentLoaded — Chrome runs its own installability
  // audit (manifest, icons, service worker) on its own schedule. So it is captured
  // at module load, and a card that already gave up waiting is told when it lands.
  let deferredPrompt = null;
  let waiting = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const fn = waiting;
    waiting = null;
    fn?.();
  });
  // Chrome fires this on a successful install from any surface, including its own
  // menu — the card has nothing left to offer once it does
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    document.querySelector('.install-ask')?.remove();
    track('pwa_installed');
  });

  function track(event, props) {
    try { window.posthog?.capture(event, props); } catch { /* analytics is never worth an error */ }
  }

  const dismissed = () => {
    try {
      const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return at > 0 && Date.now() - at < DISMISS_DAYS * 86400000;
    } catch { return false; }
  };

  // counted once per page load, at load — "visits" here means page views, which is
  // what a browser's own install heuristics measure too
  const visits = (() => {
    const n = Math.min(Number(localStorage.getItem(VISITS_KEY) || 0) + 1, 99);
    try { localStorage.setItem(VISITS_KEY, String(n)); } catch { /* private mode */ }
    return n;
  })();

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
  };

  return {
    iOS, standalone, visits, MIN_VISITS, dismissed, dismiss, track,
    prompt: () => deferredPrompt,
    onPrompt: (fn) => { waiting = fn; },
  };
})();

/* ---------------- the card ---------------- */

const INSTALL_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 8v7"/><path d="m9 12 3 3 3-3"/></svg>';
// iOS's Share glyph, drawn rather than described: "the square with the arrow" is
// only obvious to someone who already knows which button it is
const SHARE_ICON = '<svg class="ios-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v13"/><path d="m8 7 4-4 4 4"/><path d="M6 12H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>';
const PLUS_BOX_ICON = '<svg class="ios-share" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';

// Mounted by the pages people land on (home, my trips) — never mid-wizard and never
// on a trip, where the action dock already owns the bottom of the screen.
function offerInstall() {
  if (TRIPI_INSTALL.standalone) return;            // already an app
  if (TRIPI_INSTALL.dismissed()) return;
  if (TRIPI_INSTALL.visits < TRIPI_INSTALL.MIN_VISITS) return;
  // a browser that gave us no prompt and isn't iOS has nothing we can describe —
  // Firefox, in-app webviews. Silence beats a dead-end hint. But Chrome's prompt
  // routinely arrives after this runs, so wait for it rather than giving up.
  if (!TRIPI_INSTALL.iOS && !TRIPI_INSTALL.prompt()) {
    TRIPI_INSTALL.onPrompt(mountInstallCard);
    return;
  }
  mountInstallCard();
}

function mountInstallCard() {
  if (document.querySelector('.install-ask')) return;

  const card = document.createElement('div');
  card.className = 'install-ask glass';
  card.setAttribute('role', 'complementary');
  card.innerHTML = TRIPI_INSTALL.iOS ? iosMarkup() : promptMarkup();
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('in'));
  TRIPI_INSTALL.track('pwa_install_hint_shown', { platform: TRIPI_INSTALL.iOS ? 'ios' : 'prompt' });

  const close = (why) => {
    TRIPI_INSTALL.dismiss();
    TRIPI_INSTALL.track('pwa_install_hint_dismissed', { why });
    card.classList.remove('in');
    setTimeout(() => card.remove(), 300);
  };
  card.querySelector('.ia-no').onclick = () => close('declined');

  const yes = card.querySelector('.ia-yes');
  if (yes) {
    yes.onclick = async () => {
      const p = TRIPI_INSTALL.prompt();
      if (!p) return close('prompt_lost');
      yes.disabled = true;
      p.prompt();
      const { outcome } = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
      TRIPI_INSTALL.track('pwa_install_choice', { outcome });
      // accepted → appinstalled removes the card. Declined → don't nag on the next
      // page load either; the browser won't re-offer this prompt anyway.
      if (outcome !== 'accepted') close('prompt_declined');
    };
  }
}

function promptMarkup() {
  return `
    <span class="ia-icon">${INSTALL_ICON}</span>
    <span class="ia-text">
      <strong class="ia-title">להתקין את TRIP MAKER על המכשיר?</strong>
      <span class="ia-sub">אייקון במסך הבית, פתיחה במסך מלא, והמסלולים שכבר צפיתם בהם זמינים גם בלי רשת.</span>
    </span>
    <span class="ia-actions">
      <button type="button" class="btn btn-amber ia-yes">התקנה</button>
      <button type="button" class="ia-no">לא עכשיו</button>
    </span>`;
}

function iosMarkup() {
  return `
    <span class="ia-icon">${INSTALL_ICON}</span>
    <span class="ia-text">
      <strong class="ia-title">רוצים את TRIP MAKER כאפליקציה?</strong>
      <span class="ia-sub">אייקון במסך הבית, פתיחה במסך מלא, והתראות כשחבר מצטרף לתכנון — שני צעדים:</span>
      <span class="ia-steps">
        <span class="ia-step"><b>1</b> מקישים על ${SHARE_ICON} <span class="ia-step-t">שיתוף</span> בסרגל של Safari</span>
        <span class="ia-step"><b>2</b> בוחרים ${PLUS_BOX_ICON} <span class="ia-step-t">הוספה למסך הבית</span></span>
      </span>
    </span>
    <span class="ia-actions">
      <button type="button" class="ia-no">הבנתי</button>
    </span>`;
}
