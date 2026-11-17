// The phone-only "build this trip" bar on the server-rendered guides (lib/seo.js).
// Hidden at the top of the page, where the reader has not decided anything yet, and
// whenever one of the page's own call-to-action cards or the footer is on screen — two
// buttons saying the same thing in one view is noise, not emphasis.
(() => {
  const bar = document.getElementById('seo-sticky');
  if (!bar || !('IntersectionObserver' in window)) return;
  const link = bar.querySelector('a');
  const inView = new Set();
  let scrolled = false;

  function paint() {
    const on = scrolled && !inView.size;
    bar.classList.toggle('show', on);
    bar.setAttribute('aria-hidden', on ? 'false' : 'true');
    link.tabIndex = on ? 0 : -1;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) inView.add(e.target); else inView.delete(e.target); });
    paint();
  });
  document.querySelectorAll('.seo-cta, .site-footer').forEach((el) => io.observe(el));
  const onScroll = () => {
    const now = window.scrollY > 320;
    if (now !== scrolled) { scrolled = now; paint(); }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // the click leaves the page, so it can't wait for a batch
  link.addEventListener('click', () => {
    window.TRIPMAKER?.trackNow?.('seo_sticky_cta', {
      path: location.pathname,
      depth: Math.round((window.scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)) * 100),
    });
  });
})();
