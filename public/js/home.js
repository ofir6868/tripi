// Homepage: search (destination / 6-digit code) + suggested trips strip.
(() => {
  let mode = 'dest';
  const input = document.getElementById('search-input');
  const hint = document.getElementById('search-hint');
  const results = document.getElementById('search-results');

  // ---- tabs ----
  document.querySelectorAll('.search-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.search-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      results.classList.remove('open');
      hint.textContent = '';
      input.value = '';
      if (mode === 'code') {
        input.classList.add('code-mode');
        input.placeholder = '● ● ● ● ● ●';
        input.inputMode = 'numeric';
        input.maxLength = 6;
      } else {
        input.classList.remove('code-mode');
        input.placeholder = 'לאן חולמים לנסוע? נסו: רומא, טוקיו, גולן…';
        input.inputMode = 'text';
        input.maxLength = 80;
      }
      input.focus();
    });
  });

  // ---- search ----
  async function doSearch() {
    const q = input.value.trim();
    hint.textContent = '';
    results.classList.remove('open');
    if (!q) { input.focus(); return; }

    if (mode === 'code' || /^\d{6}$/.test(q)) {
      if (!/^\d{6}$/.test(q)) {
        hint.innerHTML = '<span class="err">קוד טיול מורכב מ-6 ספרות בדיוק</span>';
        return;
      }
      hint.textContent = 'רגע, מאתרים את הטיול…';
      try {
        await TRIPI.api('/api/trips/code/' + q);
        location.href = '/trip/' + q;
      } catch (err) {
        hint.innerHTML = `<span class="err">${TRIPI.esc(err.message)}</span>`;
      }
      return;
    }

    hint.textContent = 'מחפשים…';
    results.innerHTML = '<span class="skl skl-result"></span>'.repeat(3);
    results.classList.add('open');
    try {
      const rows = await TRIPI.api('/api/trips/search?q=' + encodeURIComponent(q));
      hint.textContent = '';
      // every search ends with a "plan this destination" CTA — the wizard pre-fills it
      const planCta = `
        <a class="search-result plan-cta" href="/plan?dest=${encodeURIComponent(q)}">
          <span class="pc-icon">✨</span>
          <div>
            <div class="sr-title">מתכננים טיול חדש ל"${TRIPI.esc(q)}"</div>
            <div class="sr-meta">בוחרים יעד, כמה ימים — וה-AI בונה את המסלול</div>
          </div>
        </a>`;
      results.innerHTML = rows.map((t) => `
        <a class="search-result" href="/trip/${t.share_code}">
          <img src="${TRIPI.esc(t.cover_image || '')}" alt="" loading="lazy" onerror="this.style.display='none'">
          <div>
            <div class="sr-title">${t.emoji || '🧭'} ${TRIPI.esc(t.title)}</div>
            <div class="sr-meta">${TRIPI.esc(t.destination)}${t.country ? ' · ' + TRIPI.esc(t.country) : ''} · ${t.days} ימים</div>
          </div>
        </a>`).join('') + planCta;
      if (!rows.length) hint.textContent = `לא מצאנו טיול קיים ל"${q}" — אבל אפשר להיות הראשונים:`;
      results.classList.add('open');
    } catch (err) {
      hint.innerHTML = `<span class="err">${TRIPI.esc(err.message)}</span>`;
    }
  }

  document.getElementById('search-btn').addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  input.addEventListener('input', () => {
    if (mode === 'code') input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });

  // ---- suggested strip ----
  const strip = document.getElementById('trip-strip');

  function cardHtml(t) {
    return `
      <a class="trip-card" href="/trip/${t.share_code}">
        <div class="tc-media">
          <img class="tc-img" src="${TRIPI.esc(t.cover_image || '')}" alt="${TRIPI.esc(t.destination)}" loading="lazy"
               onerror="this.removeAttribute('src')">
          <span class="tc-emoji">${t.emoji || '🧭'}</span>
          <span class="tc-days">${t.days} ימים</span>
          <div class="tc-body">
            <div class="tc-country">${TRIPI.esc(t.country || '')}</div>
            <div class="tc-title">${TRIPI.esc(t.title)}</div>
            <div class="tc-dest">${TRIPI.esc((t.description || '').slice(0, 72))}…</div>
          </div>
        </div>
      </a>`;
  }

  // infinite loop: the card set is rendered twice; crossing a copy boundary
  // teleports the scroll position by one set-width — identical content, invisible jump
  let loopEnabled = false;
  let sign = -1; // RTL Chrome scrolls into negative scrollLeft; some engines use positive

  const setW = () => strip.scrollWidth / 2;
  const getPos = () => Math.abs(strip.scrollLeft);
  const setPos = (p) => { strip.scrollLeft = sign * p; };

  function setupLoop() {
    strip.scrollLeft = -1;
    sign = strip.scrollLeft < 0 ? -1 : 1;
    strip.scrollLeft = 0;
    loopEnabled = true;
    strip.addEventListener('scroll', () => {
      const W = setW();
      const pos = getPos();
      // hysteresis: wrap only a full card into the second copy, so a jump landing
      // exactly at W (the backward-guard) isn't immediately undone mid-animation
      if (pos >= W + CARD) setPos(pos - W);
    }, { passive: true });
  }

  async function loadSuggested() {
    try {
      const trips = await TRIPI.api('/api/trips/suggested');
      const cardsHtml = trips.map(cardHtml).join('');
      const loop = trips.length > 3;
      strip.innerHTML = loop ? cardsHtml + cardsHtml : cardsHtml;
      const all = [...strip.querySelectorAll('.trip-card')];
      // clones are pre-revealed and hidden from a11y; originals get the staggered reveal
      all.slice(trips.length).forEach((c) => { c.classList.add('revealed'); c.setAttribute('aria-hidden', 'true'); c.tabIndex = -1; });
      const originals = all.slice(0, trips.length);
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const idx = originals.indexOf(en.target);
            setTimeout(() => en.target.classList.add('revealed'), (idx % 6) * 90);
            observer.unobserve(en.target);
          }
        });
      }, { threshold: 0.15 });
      originals.forEach((c) => observer.observe(c));
      if (loop) setupLoop();
      startDrift();
    } catch {
      strip.innerHTML = '<div class="empty-day" style="width:100%">הטיולים המומלצים יופיעו כאן ממש בקרוב 🌍</div>';
    }
  }

  // arrows — with the loop active they never hit a dead end
  const CARD = 312;
  document.getElementById('strip-next').addEventListener('click', () => {
    if (loopEnabled && getPos() < CARD + 4) setPos(getPos() + setW()); // wrap before leaving the start
    strip.scrollBy({ left: CARD, behavior: 'smooth' });
  });
  document.getElementById('strip-prev').addEventListener('click', () => {
    strip.scrollBy({ left: -CARD, behavior: 'smooth' }); // far-end wrap handled by the scroll listener
  });

  // gentle auto-drift, pauses on interaction
  let paused = false, resumeTimer = null;
  function pauseDrift() {
    paused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, 3500);
  }
  ['pointerdown', 'wheel', 'touchstart'].forEach((ev) => strip.addEventListener(ev, pauseDrift, { passive: true }));
  strip.addEventListener('pointerenter', () => { paused = true; clearTimeout(resumeTimer); });
  strip.addEventListener('pointerleave', pauseDrift);

  function startDrift() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let dir = -1; // only used in non-loop fallback: bounce between the ends
    let acc = 0;
    function frame() {
      if (!paused && !document.hidden) {
        const max = strip.scrollWidth - strip.clientWidth;
        if (max > 0) {
          acc += 0.5;
          if (acc >= 1) {
            const step = Math.floor(acc);
            acc -= step;
            if (loopEnabled) {
              setPos(getPos() + step); // always forward — the wrap listener makes it endless
            } else {
              const pos = getPos();
              if (pos >= max - 4) dir = 1;
              if (pos <= 4) dir = -1;
              strip.scrollLeft += dir * step;
            }
          }
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  loadSuggested();
})();
