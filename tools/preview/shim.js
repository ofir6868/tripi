// Demo mode, in the browser: answers every fetch('/api/…') from tools/preview/mock-api.js
// so the UI runs with no server at all (Cloudflare Pages, the single-file preview).
// Loaded before common.js by the build in tools/preview/build.js — never in production.
(function () {
  if (!window.TripmakerMock) return;
  document.documentElement.setAttribute('dir', 'rtl');
  document.documentElement.setAttribute('lang', 'he');
  document.documentElement.classList.add('demo');
  // a signed-in owner, so the page opens with edit rights (documents need a user too)
  try {
    if (!localStorage.getItem('tripmaker_token')) {
      localStorage.setItem('tripmaker_token', 'demo');
      localStorage.setItem('tripmaker_user', JSON.stringify(window.TripmakerMock.user));
    }
  } catch { /* storage blocked — the page still renders as a viewer */ }
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^\/api\//.test(url)) return realFetch(input, init);
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { /* not json */ }
    const r = window.TripmakerMock.handle((init && init.method) || 'GET', url, body);
    return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(r.body), {
      status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })), 120));
  };
  // no service worker in a demo — it would pin the shell
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    navigator.serviceWorker.register = () => Promise.reject(new Error('demo'));
  }
})();
