// Product analytics + session replay (PostHog), active only when the server has
// POSTHOG_KEY configured — without it this file does nothing, same contract as
// push.js. Privacy posture: every input is masked in recordings, anything tagged
// .ph-mask (user's name in the header) or .copyable (share codes) has its text
// hidden, the auth modal is excluded from capture entirely (ph-no-capture in
// common.js), and users are identified by numeric id only — no email or name
// ever reaches PostHog. Not loaded on /admin, which renders other users' emails.
(async () => {
  // the privacy page (/privacy) sets this; respecting it before the SDK even loads
  // means no request ever leaves the browser for an opted-out user
  if (localStorage.getItem('tm_analytics_optout') === '1') return;
  let cfg;
  try {
    cfg = await (await fetch('/api/analytics/config')).json();
  } catch {
    return; // offline / server hiccup — analytics is never worth an error
  }
  if (!cfg || !cfg.enabled || !cfg.key) return;

  // PostHog serves the library from a per-region assets host mirroring the API host
  const assets = cfg.host.replace('.i.posthog.com', '-assets.i.posthog.com');
  const s = document.createElement('script');
  s.src = assets + '/static/array.js';
  s.async = true;
  s.onload = () => {
    if (!window.posthog || !posthog.init) return;
    posthog.init(cfg.key, {
      api_host: cfg.host,
      defaults: '2025-05-24',
      person_profiles: 'identified_only',
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '.ph-mask, .copyable',
      },
    });

    // ---- acquisition: where a visit came from is a property, not a guess.
    // visit_source rides on every event of this load (register), and the first
    // source that ever brought this browser here is stamped once onto the person
    // after identify — so signups can be broken down by their original channel.
    // App-generated share links carry utm_source (invite / trip_share / referral);
    // everything else falls back to the referrer. 'internal' (same-host referrer,
    // e.g. a hard navigation between pages) never overwrites a real source.
    const params = new URLSearchParams(location.search);
    const visitSource = (() => {
      const utm = params.get('utm_source');
      if (utm) return utm.slice(0, 60);
      if (params.get('ref')) return 'referral';
      if (params.get('join')) return 'invite';
      if (!document.referrer) return 'direct';
      try {
        const host = new URL(document.referrer).hostname;
        if (host === location.hostname) return 'internal';
        if (/(^|\.)google\./.test(host)) return 'organic_search';
        return host.replace(/^www\./, '');
      } catch { return 'direct'; }
    })();
    if (visitSource !== 'internal') {
      posthog.register({ visit_source: visitSource, visit_medium: params.get('utm_medium') || null });
    }
    let firstTouch = null;
    try {
      firstTouch = JSON.parse(localStorage.getItem('tm_first_touch') || 'null');
      if (!firstTouch && visitSource !== 'internal') {
        firstTouch = {
          source: visitSource,
          medium: params.get('utm_medium') || null,
          landing: location.pathname,
          ts: new Date().toISOString(),
        };
        localStorage.setItem('tm_first_touch', JSON.stringify(firstTouch));
      }
    } catch { /* no storage — visit_source still rides the session's events */ }

    // init runs after the window load event (config fetch + async script), and in
    // 'history_change' mode the SDK only fires pageviews on history API changes —
    // which a multi-page site never makes. Capture the load's pageview explicitly.
    posthog.capture('$pageview');

    const identify = () => {
      if (TRIPMAKER.user && TRIPMAKER.user.id != null) {
        posthog.identify('user_' + TRIPMAKER.user.id);
        // set-once: the person keeps the channel that first brought them, however
        // many times this runs — which lets signed_up (server-side) join to it
        if (firstTouch) {
          posthog.setPersonProperties({}, {
            first_source: firstTouch.source,
            first_medium: firstTouch.medium,
            first_landing: firstTouch.landing,
            first_touch_at: firstTouch.ts,
          });
        }
      }
    };
    identify();

    // login can complete without a page load (authOnSuccess callbacks), and logout
    // must drop the identity before the shared-device next user shows up
    const saveAuth = TRIPMAKER.saveAuth.bind(TRIPMAKER);
    TRIPMAKER.saveAuth = (token, user) => { saveAuth(token, user); identify(); };
    const logout = TRIPMAKER.logout.bind(TRIPMAKER);
    TRIPMAKER.logout = () => { try { posthog.reset(); } catch { /* recorder gone — proceed */ } logout(); };
  };
  document.head.appendChild(s);
})();
