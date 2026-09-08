// Homepage: search (destination autocomplete / 6-digit code) + suggested trips strip.
(() => {
  let mode = 'dest';
  const box = document.querySelector('.search-box');
  const input = document.getElementById('search-input');
  const promptSubmit = document.getElementById('prompt-submit');
  const hint = document.getElementById('search-hint');
  const results = document.getElementById('search-results');
  const isPhrase = (q) => q.split(/\s+/).filter(Boolean).length >= 2;
  const isAiFallback = (q) => isPhrase(q) && !DESTINATIONS.searchWithCountry(q, 1).length;

  // the dropdown used to be an absolutely-positioned child of .search-box, glued to
  // the input via normal document flow. That put it inside the hero's isolated
  // stacking context (isolation: isolate for the ken-burns clip), which traps even
  // fixed-position descendants below the site header's z-index — so as the page
  // scrolled, the open dropdown scrolled up with the hero and vanished behind the
  // header instead of staying put. Reparenting to <body> escapes that stacking
  // context; position: fixed + tracking the input's rect on scroll/resize keeps it
  // glued to the input and visible above the header the whole time it's open.
  function positionResults() {
    const r = input.getBoundingClientRect();
    results.style.top = `${r.bottom - 1}px`;
    results.style.left = `${r.left}px`;
    results.style.width = `${r.width}px`;
  }
  function openResults() {
    if (results.parentElement !== document.body) document.body.appendChild(results);
    positionResults();
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
  window.addEventListener('scroll', () => {
    if (results.classList.contains('open')) positionResults();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (results.classList.contains('open')) positionResults();
  });

  // ---- tabs ----
  document.querySelectorAll('.search-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      // "הטיולים שלי" is a real link to /my — leave the dest/code widget as-is
      if (tab.dataset.mode === 'mine') return;
      document.querySelectorAll('.search-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      closeResults();
      promptSubmit.hidden = true;
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
        input.maxLength = 500;
      }
      input.focus();
    });
  });

  // ---- popular strip: a tile is the wizard with its chips already in ----
  // A single destination takes the same ?dest= road as a pick from the dropdown.
  // A multi-country route travels as one id (?combo=) that the wizard resolves
  // from the same list, so the tile and the chips can never disagree.
  (function renderPopular() {
    const strip = document.getElementById('popular-strip');
    if (!strip || typeof POPULAR === 'undefined') return;
    const flags = (dests) => `<span class="pop-flags">${dests.map((d) => COUNTRIES.flagHtml(d.cc)).join('')}</span>`;
    const tile = ({ href, img, name, cls, dests, badge }) => `
      <a class="pop-tile ${cls}" href="${href}" title="${TRIPMAKER.esc(name)}">
        <span class="pop-img" style="background-image:url('${img}')" aria-hidden="true"></span>
        ${badge ? `<span class="pop-badge">${TRIPMAKER.esc(badge)}</span>` : ''}
        <span class="pop-text">${flags(dests)}<span class="pop-name">${TRIPMAKER.esc(name)}</span></span>
      </a>`;
    // the multi-country routes lead: they are the thing a single destination name
    // can't be searched for, so they're worth the first two slots
    strip.innerHTML =
      POPULAR.combos.map((c) => tile({
        href: '/plan?combo=' + encodeURIComponent(c.id),
        img: c.img, name: c.title, cls: 'pop-combo', dests: c.dests, badge: 'טיול גדול',
      })).join('') +
      POPULAR.singles.map((d) => tile({
        href: '/plan?' + new URLSearchParams({ dest: d.name, cc: d.cc, country: POPULAR.countryOf(d) }),
        img: d.img, name: d.name, cls: 'pop-single', dests: [d],
      })).join('');
    strip.addEventListener('click', (e) => {
      const a = e.target.closest('.pop-tile');
      if (a) TRIPMAKER.track?.('popular_pick', { name: a.title, combo: a.classList.contains('pop-combo') });
    });

    // ---- reaching the far end with a mouse ----
    // The strip scrolls by swipe on a phone, but a desktop mouse had nothing to
    // grab: the scrollbar is hidden and a wheel only scrolls the page. Arrows for
    // the pointer, and a vertical wheel over the strip moves it sideways.
    const nextBtn = document.getElementById('pop-next');
    const prevBtn = document.getElementById('pop-prev');
    // one probe: RTL scroll offsets run negative in modern engines and positive in
    // the legacy WebKit model. Either way, further into the list is a DECREASE —
    // only the range the wheel has to stay inside differs.
    strip.scrollLeft = -1;
    const negModel = strip.scrollLeft < 0;
    strip.scrollLeft = 0;
    const span = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      return negModel ? [-max, 0] : [0, max];
    };
    const STEP = 260;
    const nudge = (d) => strip.scrollBy({ left: d, behavior: 'smooth' });
    nextBtn.onclick = () => nudge(-STEP);
    prevBtn.onclick = () => nudge(STEP);
    function paintNav() {
      const [lo, hi] = span();
      const pos = strip.scrollLeft;
      nextBtn.disabled = pos - 1 <= lo;
      prevBtn.disabled = pos + 1 >= hi;
    }
    strip.addEventListener('scroll', paintNav, { passive: true });
    window.addEventListener('resize', paintNav);
    paintNav();
    strip.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // a real sideways gesture already works
      const [lo, hi] = span();
      if (hi - lo <= 0) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // Firefox reports lines
      const target = strip.scrollLeft - dy;
      // past either end the wheel goes back to being the page's — the strip never
      // swallows a scroll it can't act on
      if (target < lo || target > hi) return;
      e.preventDefault();
      strip.scrollLeft = target;
    }, { passive: false });
  })();

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

  // Normal destination matches stay the primary flow. A free-text AI request is
  // handled separately only when a long query produced no destination match.
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

  let promptBusy = false;
  async function goPrompt(prompt) {
    if (promptBusy) return;
    promptBusy = true;
    closeResults();
    input.disabled = true;
    promptSubmit.disabled = true;
    hint.textContent = 'ה-AI מבין לאן תרצו לנסוע…';
    try {
      const intake = await TRIPMAKER.api('/api/ai/resolve-trip-prompt', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      sessionStorage.setItem('tripmaker_plan_intake', JSON.stringify(intake));
      location.href = '/plan?intake=1';
    } catch (err) {
      hint.innerHTML = `<span class="err">${TRIPMAKER.esc(err.message)}</span>`;
      input.disabled = false;
      promptSubmit.disabled = false;
      input.focus();
      promptBusy = false;
    }
  }

  promptSubmit.addEventListener('click', () => goPrompt(input.value.trim()));

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
    const aiFallback = isAiFallback(q);
    promptSubmit.hidden = !aiFallback;
    if (q.length < 2 || aiFallback) {
      seq++;
      closeResults();
      return;
    }
    renderDestinations(q); // local index — no reason to make anyone wait for it
    debounceTimer = setTimeout(() => autocomplete(q), 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (mode === 'code' || /^\d{6}$/.test(q)) { goCode(q); return; }
      if (isAiFallback(q)) { goPrompt(q); return; }
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

  // the dropdown behaves like a native one: focus back in reopens it, click-away closes.
  // results now lives under <body> (see openResults), not inside .search-box, so
  // click-away has to check both.
  //
  // 'click', not 'pointerdown': pointerdown fires the instant a touch begins, including
  // the touchstart that starts a scroll swipe — so on a phone, starting a scroll gesture
  // anywhere outside the box (the dropdown floats over the whole page now) closed the
  // dropdown before any scrolling even happened. A browser only synthesizes 'click' for
  // an actual tap, never after a touchstart that turns into a pan/scroll, so this closes
  // on a real click-away without also closing on every scroll-swipe that starts outside.
  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (mode === 'dest' && !isAiFallback(q) && results.children.length && q.length >= 2) openResults();
  });
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && !results.contains(e.target)) closeResults();
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
