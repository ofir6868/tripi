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
    try {
      const rows = await TRIPI.api('/api/trips/search?q=' + encodeURIComponent(q));
      hint.textContent = '';
      if (!rows.length) {
        hint.innerHTML = `לא מצאנו טיול ל"${TRIPI.esc(q)}" — אולי תהיו הראשונים? <a href="/plan" style="color:var(--amber);font-weight:700">מתכננים אחד ›</a>`;
        return;
      }
      results.innerHTML = rows.map((t) => `
        <a class="search-result" href="/trip/${t.share_code}">
          <img src="${TRIPI.esc(t.cover_image || '')}" alt="" loading="lazy" onerror="this.style.display='none'">
          <div>
            <div class="sr-title">${t.emoji || '🧭'} ${TRIPI.esc(t.title)}</div>
            <div class="sr-meta">${TRIPI.esc(t.destination)}${t.country ? ' · ' + TRIPI.esc(t.country) : ''} · ${t.days} ימים</div>
          </div>
        </a>`).join('');
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

  async function loadSuggested() {
    try {
      const trips = await TRIPI.api('/api/trips/suggested');
      strip.innerHTML = trips.map(cardHtml).join('');
      // staggered reveal
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const idx = [...strip.children].indexOf(en.target);
            setTimeout(() => en.target.classList.add('revealed'), (idx % 6) * 90);
            observer.unobserve(en.target);
          }
        });
      }, { threshold: 0.15 });
      strip.querySelectorAll('.trip-card').forEach((c) => observer.observe(c));
      startDrift();
    } catch {
      strip.innerHTML = '<div class="empty-day" style="width:100%">הטיולים המומלצים יופיעו כאן ממש בקרוב 🌍</div>';
    }
  }

  // arrows (RTL: scrollLeft goes negative)
  const CARD = 312;
  document.getElementById('strip-next').addEventListener('click', () => strip.scrollBy({ left: CARD, behavior: 'smooth' }));
  document.getElementById('strip-prev').addEventListener('click', () => strip.scrollBy({ left: -CARD, behavior: 'smooth' }));

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
    let dir = -1; // RTL: content extends toward negative scrollLeft
    let acc = 0;
    function frame() {
      if (!paused && !document.hidden) {
        const max = strip.scrollWidth - strip.clientWidth;
        if (max > 0) {
          // in RTL scrollLeft ranges 0 → -max (chrome) — normalize
          const pos = Math.abs(strip.scrollLeft);
          if (pos >= max - 4) dir = 1;
          if (pos <= 4) dir = -1;
          acc += 0.5;
          if (acc >= 1) { strip.scrollLeft += dir * Math.floor(acc); acc -= Math.floor(acc); }
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  loadSuggested();
})();
