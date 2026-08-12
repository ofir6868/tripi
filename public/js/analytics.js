// Product analytics + session replay (PostHog), active only when the server has
// POSTHOG_KEY configured — without it this file does nothing, same contract as
// push.js. Privacy posture: every input is masked in recordings, anything tagged
// .ph-mask (user's name in the header) or .copyable (share codes) has its text
// hidden, the auth modal is excluded from capture entirely (ph-no-capture in
// common.js), and users are identified by numeric id only — no email or name
// ever reaches PostHog. Not loaded on /admin, which renders other users' emails.
(async () => {
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

    // init runs after the window load event (config fetch + async script), and in
    // 'history_change' mode the SDK only fires pageviews on history API changes —
    // which a multi-page site never makes. Capture the load's pageview explicitly.
    posthog.capture('$pageview');

    const identify = () => {
      if (TRIPI.user && TRIPI.user.id != null) posthog.identify('user_' + TRIPI.user.id);
    };
    identify();

    // login can complete without a page load (authOnSuccess callbacks), and logout
    // must drop the identity before the shared-device next user shows up
    const saveAuth = TRIPI.saveAuth.bind(TRIPI);
    TRIPI.saveAuth = (token, user) => { saveAuth(token, user); identify(); };
    const logout = TRIPI.logout.bind(TRIPI);
    TRIPI.logout = () => { try { posthog.reset(); } catch { /* recorder gone — proceed */ } logout(); };
  };
  document.head.appendChild(s);
})();
