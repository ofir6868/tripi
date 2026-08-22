// Homepage: search (destination autocomplete / 6-digit code) + suggested trips strip.
(() => {
  let mode = 'dest';
  const box = document.querySelector('.search-box');
  const input = document.getElementById('search-input');
  const hint = document.getElementById('search-hint');
  const results = document.getElementById('search-results');

  function openResults() {
    results.classList.add('open');
    box.classList.add('dd-open');
    input.setAttribute('aria-expanded', 'true');
  }
  function closeResults() {
    results.classList.remove('open');
    box.classList.remove('dd-open');
    input.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  // ---- tabs ----
  document.querySelectorAll('.search-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.search-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      closeResults();
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

  // ---- code lookup ----
  let codeBusy = false;
  async function goCode(q) {
    if (!/^\d{6}$/.test(q)) {
      hint.innerHTML = '<span class="err">קוד טיול מורכב מ-6 ספרות בדיוק</span>';
      return;
    }
    if (codeBusy) return;
    codeBusy = true;
    hint.textContent = 'רגע, מאתרים את הטיול…';
    try {
      await TRIPMAKER.api('/api/trips/code/' + q);
      location.href = '/trip/' + q;
    } catch (err) {
      hint.innerHTML = `<span class="err">${TRIPMAKER.esc(err.message)}</span>`;
      codeBusy = false;
    }
  }

  // ---- destination autocomplete ----
  let activeIdx = -1;
  let seq = 0; // stale-response guard: only the latest request may render

  const options = () => [...results.querySelectorAll('.search-result')];

  function setActive(idx) {
    const opts = options();
    if (!opts.length) return;
    activeIdx = (idx + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('sr-active', i === activeIdx));
    opts[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  const GO_ARROW = '<svg class="ic sr-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';

  // section 1 — creation, and it is rendered from the in-memory destination index,
  // so it is on screen before the trips request even leaves the browser. A matched
  // destination carries its country code (flag + a country the AI can anchor on);
  // the free-text CTA only appears when the index recognised nothing at all.
  function planCtaHtml(q) {
    const hits = DESTINATIONS.searchWithCountry(q, 3);
    if (!hits.length) {
      return `
        <a class="search-result plan-cta" href="/plan?dest=${encodeURIComponent(q)}" role="option">
          <span class="pc-icon"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg></span>
          <div>
            <div class="sr-title">מתכננים טיול חדש ל"${TRIPMAKER.esc(q)}"</div>
            <div class="sr-meta">בוחרים יעד, כמה ימים — וה-AI בונה את המסלול</div>
          </div>
          ${GO_ARROW}
        </a>`;
    }
    return hits.map((d) => {
      const params = new URLSearchParams({ dest: d.name, cc: d.cc, country: d.country });
      return `
        <a class="search-result plan-cta" href="/plan?${params}" role="option">
          <span class="sr-flag">${COUNTRIES.flagHtml(d.cc)}</span>
          <div>
            <div class="sr-title">${TRIPMAKER.esc(DESTINATIONS.tripPhrase(d.name))}</div>
            <div class="sr-meta">${TRIPMAKER.esc(DESTINATIONS.subtitle(d))} · ה-AI בונה את המסלול</div>
          </div>
          ${GO_ARROW}
        </a>`;
    }).join('');
  }

  const INSPIRATION_SKELETON = `
    <div class="skl-row">
      <span class="skl skl-thumb"></span>
      <div class="skl-sr-text"><span class="skl skl-sr-title"></span><span class="skl skl-sr-meta"></span></div>
    </div>`.repeat(2);

  // two independent sections: destinations re-render on every keystroke, while the
  // trips underneath keep the previous answer until the new one arrives — replacing
  // both at once would flash a skeleton through the whole dropdown as you type
  function sections() {
    if (!document.getElementById('sr-plan')) {
      results.innerHTML = '<div id="sr-plan"></div><div id="sr-inspiration"></div>';
    }
    return [document.getElementById('sr-plan'), document.getElementById('sr-inspiration')];
  }

  function renderDestinations(q) {
    const [plan, insp] = sections();
    plan.innerHTML = planCtaHtml(q);
    if (!insp.innerHTML) insp.innerHTML = INSPIRATION_SKELETON;
    activeIdx = -1;
    openResults();
  }

  async function autocomplete(q) {
    const mySeq = ++seq;
    renderDestinations(q);
    try {
      const rows = await TRIPMAKER.api('/api/trips/search?q=' + encodeURIComponent(q));
      if (mySeq !== seq) return; // a newer keystroke already took over
      const [, box] = sections();
      box.innerHTML = rows.length
        ? `<div class="sr-group-label">מקבלים השראה מטיולים של אחרים</div>` + rows.map((t) => `
          <a class="search-result" href="/trip/${t.share_code}" role="option">
            <img src="${TRIPMAKER.esc(t.cover_image || '')}" alt="" loading="lazy" onerror="this.style.display='none'">
            <div>
              <div class="sr-title">${t.emoji || '🧭'} ${TRIPMAKER.esc(t.title)}</div>
              <div class="sr-meta">${TRIPMAKER.esc(t.destination)}${t.country ? ' · ' + TRIPMAKER.esc(t.country) : ''} · ${t.days} ימים</div>
            </div>
            ${GO_ARROW}
          </a>`).join('')
        : `<div class="sr-empty">עוד אין טיולים ל"${TRIPMAKER.esc(q)}" — תהיו הראשונים 🌍</div>`;
    } catch (err) {
      if (mySeq !== seq) return;
      // the destination rows stand on their own — a failed trips lookup just empties
      // the inspiration section instead of taking the whole dropdown down with it
      sections()[1].innerHTML = '';
      hint.innerHTML = `<span class="err">${TRIPMAKER.esc(err.message)}</span>`;
    }
  }

  let debounceTimer = null;
  input.addEventListener('input', () => {
    if (mode === 'code') {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      if (input.value.length === 6) goCode(input.value); // full code — no button, just go
      return;
    }
    hint.textContent = '';
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { seq++; closeResults(); return; }
    renderDestinations(q); // local index — no reason to make anyone wait for it
    debounceTimer = setTimeout(() => autocomplete(q), 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (mode === 'code' || /^\d{6}$/.test(q)) { goCode(q); return; }
      const opts = options();
      if (results.classList.contains('open') && opts.length) {
        // chosen option wins; with nothing highlighted, the top result is the intent
        opts[activeIdx >= 0 ? activeIdx : 0].click();
      } else if (q.length >= 2) {
        clearTimeout(debounceTimer);
        autocomplete(q);
      }
    } else if (e.key === 'ArrowDown' && results.classList.contains('open')) {
      e.preventDefault();
      setActive(activeIdx + 1);
    } else if (e.key === 'ArrowUp' && results.classList.contains('open')) {
      e.preventDefault();
      setActive(activeIdx - 1);
    } else if (e.key === 'Escape') {
      closeResults();
    }
  });

  // the dropdown behaves like a native one: focus back in reopens it, click-away closes
  input.addEventListener('focus', () => {
    if (mode === 'dest' && results.children.length && input.value.trim().length >= 2) openResults();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!box.contains(e.target)) closeResults();
  });

  // ---- suggested strip ----
  const strip = document.getElementById('trip-strip');

  function cardHtml(t) {
    return `
      <a class="trip-card" href="/trip/${t.share_code}">
        <div class="tc-media">
          <img class="tc-img" src="${TRIPMAKER.esc(t.cover_image || '')}" alt="${TRIPMAKER.esc(t.destination)}" loading="lazy"
               onerror="this.removeAttribute('src')">
          <span class="tc-emoji">${t.emoji || '🧭'}</span>
          <span class="tc-days">${t.days} ימים</span>
          <div class="tc-body">
            <div class="tc-country">${TRIPMAKER.esc(t.country || '')}</div>
            <div class="tc-title">${TRIPMAKER.esc(t.title)}</div>
            <div class="tc-dest">${TRIPMAKER.esc((t.description || '').slice(0, 72))}…</div>
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
      const fetched = await TRIPMAKER.api('/api/trips/suggested');
      // near-duplicates (two 22-day Japan trips) crowd the shop window — keep one
      // card per country+length. The server pre-sorts by likes, so first-seen wins.
      const seen = new Set();
      const trips = fetched.filter((t) => {
        const key = `${(t.country || t.destination || '').trim()}|${t.days}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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
      maybeDrift();
    } catch {
      strip.innerHTML = '<div class="empty-day" style="width:100%">הטיולים המומלצים יופיעו כאן ממש בקרוב 🌍</div>';
    }
  }

  // arrows — with the loop active they never hit a dead end. Every click pauses
  // the drift first: a drift tick writes scrollLeft, and that cancels an in-flight
  // smooth scroll — without the pause the arrows lose the race and appear dead.
  const CARD = 312;
  document.getElementById('strip-next').addEventListener('click', () => {
    pauseDrift();
    if (loopEnabled && getPos() < CARD + 4) setPos(getPos() + setW()); // wrap before leaving the start
    strip.scrollBy({ left: CARD, behavior: 'smooth' });
  });
  document.getElementById('strip-prev').addEventListener('click', () => {
    pauseDrift();
    strip.scrollBy({ left: -CARD, behavior: 'smooth' }); // far-end wrap handled by the scroll listener
  });

  // gentle auto-drift, pauses on interaction. Perf: the rAF loop runs only while
  // it can actually move something — strip on screen, tab visible, not paused.
  // The moment any of that stops being true the loop cancels itself, and the
  // state-change listeners below restart it. An idle homepage burns zero frames.
  let paused = false, resumeTimer = null, rafId = null, stripOnScreen = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const driftAllowed = () => !paused && !document.hidden && stripOnScreen && !reducedMotion.matches;

  let dir = -1; // only used in non-loop fallback: bounce between the ends
  let acc = 0;
  function frame() {
    if (!driftAllowed()) { rafId = null; return; } // stop ticking — maybeDrift() restarts us
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
    rafId = requestAnimationFrame(frame);
  }
  function maybeDrift() {
    if (rafId == null && driftAllowed()) rafId = requestAnimationFrame(frame);
  }

  function pauseDrift() {
    paused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; maybeDrift(); }, 3500);
  }
  ['pointerdown', 'wheel', 'touchstart'].forEach((ev) => strip.addEventListener(ev, pauseDrift, { passive: true }));
  strip.addEventListener('pointerenter', () => { paused = true; clearTimeout(resumeTimer); });
  strip.addEventListener('pointerleave', pauseDrift);
  new IntersectionObserver((entries) => {
    stripOnScreen = entries[0].isIntersecting;
    maybeDrift();
  }).observe(strip);
  document.addEventListener('visibilitychange', maybeDrift);
  reducedMotion.addEventListener?.('change', maybeDrift);

  loadSuggested();
})();
