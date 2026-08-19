// AI-first plan wizard: destinations → dates → style → the AI builds, and the trip
// is CREATED on the spot — saved to the server as a draft and opened on its own
// page (/trip/CODE) in edit mode. Publishing ("שמירת הטיול") happens over there.
(() => {
  const DEFAULT_COVER = 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=1200&q=80';

  let aiMeta = { emoji: null, cover_image: null }; // chosen automatically by the AI
  let aiDesc = null; // AI-written description — shown on the trip page, not here
  let destinations = []; // [{name, country, lat, lon}]

  // ---- destination autocomplete (multi-city chips) ----
  const destInput = document.getElementById('f-dest-search');
  const suggBox = document.getElementById('dest-suggestions');
  const chipsBox = document.getElementById('dest-chips');
  const titleInput = document.getElementById('f-title');
  let debounceTimer = null;
  let titleWasAutofilled = false;

  // a destination's country code: carried from the homepage (?cc=) or looked up
  // by the Hebrew country name — powers every flag in the wizard
  const ccFor = (d) => d.cc || COUNTRIES.ccByName(d.country || d.name);
  const tripCcs = () => [...new Set(destinations.map(ccFor).filter(Boolean))];

  function renderChips() {
    chipsBox.innerHTML = destinations.map((d, i) => {
      const cc = ccFor(d);
      return `
      <span class="dest-chip">
        ${cc ? COUNTRIES.flagHtml(cc) + ' ' : ''}${TRIPI.esc(d.name)}${d.country && d.country !== d.name ? `<small>${TRIPI.esc(d.country)}</small>` : ''}
        <button type="button" data-i="${i}" aria-label="הסרת יעד">✕</button>
      </span>`;
    }).join('');
    chipsBox.querySelectorAll('.dest-chip > button').forEach((b) => {
      b.onclick = () => { destinations.splice(+b.dataset.i, 1); renderChips(); autoTitle(); };
    });
    // once something is picked, the input invites the next stop instead of the first
    destInput.placeholder = destinations.length
      ? 'מוסיפים עוד יעד? עיר או מדינה נוספת…'
      : 'הקלידו יעד… למשל: טוקיו, יוון, רומא';
    renderTitleFlags();
    renderDestContext();
  }

  // flags live beside the trip-name label, never inside the stored title —
  // flagHtml picks emoji on mobile and SVG images on desktop
  function renderTitleFlags() {
    const el = document.getElementById('title-flags');
    if (!el) return;
    el.innerHTML = tripCcs().map((cc) => COUNTRIES.flagHtml(cc)).join('');
  }

  // step 2 reminder of what was chosen — matters most when we jumped here automatically
  function renderDestContext() {
    const box = document.getElementById('dest-context');
    if (!box) return;
    if (!destinations.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<span class="dc-label">הטיול שלכם ל־</span>` + destinations
      .map((d) => {
        const cc = ccFor(d);
        return `<span class="dc-dest">${cc ? COUNTRIES.flagHtml(cc) + ' ' : ''}${TRIPI.esc(d.name)}${d.country && d.country !== d.name ? `<small>, ${TRIPI.esc(d.country)}</small>` : ''}</span>`;
      })
      .join('<span class="dc-sep">·</span>') +
      ` <button type="button" class="dc-change" id="dc-add">+ עוד יעד</button>` +
      ` <button type="button" class="dc-change" id="dc-change">שינוי</button>`;
    box.querySelector('#dc-change').onclick = () => goStep(1);
    // the homepage country flow lands directly on step 2 — this is where a
    // multi-country trip picks up its second destination
    box.querySelector('#dc-add').onclick = () => { goStep(1); destInput.focus(); };
  }

  function autoTitle() {
    if (titleInput.value && !titleWasAutofilled) return; // never overwrite the user's own title
    if (!destinations.length) { if (titleWasAutofilled) { titleInput.value = ''; titleWasAutofilled = false; } return; }
    const names = destinations.map((d) => d.name);
    // the stored title stays flag-free: a title created on one platform is read on
    // others, and emoji flags degrade to bare letters ("IE") on Windows. Flags are
    // a DISPLAY concern — rendered beside the title per-platform (renderTitleFlags)
    titleInput.value = names.length === 1 ? `טיול ל${names[0]}` : `${names.slice(0, 3).join(' · ')} — הטיול הגדול`;
    titleWasAutofilled = true;
  }
  titleInput.addEventListener('input', () => { titleWasAutofilled = false; });

  function addDestination(d) {
    if (destinations.some((x) => x.name === d.name && x.country === d.country)) return;
    destinations.push(d);
    renderChips();
    autoTitle();
    destInput.value = '';
    suggBox.classList.remove('open');
    destInput.focus();
    scheduleSave(); // also covers programmatic adds (?dest= pre-fill)
  }

  async function searchDestinations() {
    const q = destInput.value.trim();
    if (q.length < 2) { suggBox.classList.remove('open'); return; }
    const places = await GEO.searchPlaces(q).catch(() => []);
    if (destInput.value.trim() !== q) return; // stale response — user kept typing
    const options = places.map((p, i) => {
      const cc = p.isCountry ? COUNTRIES.ccByName(p.name) : null;
      return `
      <button type="button" class="autocomplete-item" data-i="${i}">
        <span class="ac-icon">${cc ? COUNTRIES.flagHtml(cc) : (p.isCountry ? '🌍' : '📍')}</span>
        <span class="ac-name">${TRIPI.esc(p.name)}</span>
        <span class="ac-meta">${p.isCountry ? 'מדינה' : TRIPI.esc([p.admin, p.country].filter(Boolean).join(', '))}</span>
      </button>`;
    }).join('');
    // free-text fallback appears only AFTER results loaded, so it can't be picked blindly
    suggBox.innerHTML = options + `
      <button type="button" class="autocomplete-item free-text" data-free="1">
        <span class="ac-icon">✏️</span>
        <span class="ac-name">להוסיף "${TRIPI.esc(q)}" כמו שהוא</span>
      </button>`;
    suggBox.classList.add('open');
    suggBox.querySelectorAll('.autocomplete-item').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.free) addDestination({ name: q, country: null, lat: null, lon: null });
        else {
          const p = places[+btn.dataset.i];
          const country = p.isCountry ? p.name : p.country;
          addDestination({ name: p.name, country, lat: p.lat, lon: p.lon, cc: COUNTRIES.ccByName(country) });
        }
      };
    });
  }

  destInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = destInput.value.trim();
    if (q.length < 2) { suggBox.classList.remove('open'); return; }
    debounceTimer = setTimeout(searchDestinations, 280);
  });

  destInput.addEventListener('keydown', (e) => {
    const open = suggBox.classList.contains('open');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (open) { e.preventDefault(); TRIPI.acMove(suggBox, e.key === 'ArrowDown' ? 1 : -1); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) {
        (suggBox.querySelector('.autocomplete-item.active') || suggBox.querySelector('.autocomplete-item'))?.click();
      } else {
        // results not in yet — run the search now instead of adding raw text
        clearTimeout(debounceTimer);
        searchDestinations();
      }
    } else if (e.key === 'Escape') {
      suggBox.classList.remove('open');
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-wrap')) suggBox.classList.remove('open');
  });

  // ---- days stepper + auto end date ----
  const daysSel = document.getElementById('f-days');
  const startInput = document.getElementById('f-start');
  const endHint = document.getElementById('end-date-hint');

  function clampDays() {
    daysSel.value = Math.min(Math.max(parseInt(daysSel.value, 10) || 1, 1), 60);
    updateEndHint();
  }
  function updateEndHint() {
    if (!startInput.value) { endHint.textContent = ''; return; }
    const end = new Date(startInput.value);
    end.setDate(end.getDate() + (+daysSel.value) - 1);
    endHint.textContent = 'חוזרים ב-' + end.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  document.getElementById('days-minus').onclick = () => { daysSel.value = +daysSel.value - 1; clampDays(); };
  document.getElementById('days-plus').onclick = () => { daysSel.value = +daysSel.value + 1; clampDays(); };
  daysSel.addEventListener('change', clampDays);
  startInput.addEventListener('change', updateEndHint);

  // ---- draft autosave: leave mid-creation, come back, continue ----
  // v3 covers steps 1-3 only — the itinerary itself lives on the server from the
  // moment it's built, so there's nothing heavier to keep here anymore
  const DRAFT_KEY = 'tripi_plan_draft';
  let curStep = 1;
  let draftTimer = null;

  function saveDraft() {
    if (!userTouched) return;  // programmatic changes alone never create a draft
    // no destinations = no draft, period. Anything else (auto-title, notes) restores
    // nothing visible and causes the phantom "continued from draft" banner.
    if (!destinations.length) { localStorage.removeItem(DRAFT_KEY); return; }
    const draft = {
      v: 3,
      savedAt: Date.now(),
      step: curStep,
      destinations,
      title: titleInput.value,
      titleWasAutofilled,
      days: daysSel.value,
      start: startInput.value,
      interests: [...selectedInterests],
      aiNotes: document.getElementById('ai-notes').value,
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full — skip */ }
  }
  function scheduleSave() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 600); }
  function clearDraft() { clearTimeout(draftTimer); localStorage.removeItem(DRAFT_KEY); }

  // drafts exist only after REAL user interaction — programmatic pre-fills
  // (?dest= from the homepage search) must not silently create one
  let userTouched = false;
  const draftBanner = document.getElementById('draft-banner');
  ['panel-1', 'panel-2', 'panel-3'].forEach((id) => {
    const p = document.getElementById(id);
    const onInteract = () => {
      userTouched = true;
      draftBanner.hidden = true; // started working → stop nagging about the old draft
      scheduleSave();
    };
    p.addEventListener('input', onInteract);
    p.addEventListener('click', onInteract);
  });

  // ---- wizard navigation (1 יעדים · 2 תאריכים · 3 סגנון) ----
  const panels = {};
  for (let i = 1; i <= 3; i++) panels[i] = document.getElementById('panel-' + i);
  function goStep(n) {
    curStep = n;
    scheduleSave();
    Object.entries(panels).forEach(([k, p]) => { p.style.display = +k === n ? '' : 'none'; });
    document.querySelectorAll('.wp-step').forEach((s) => {
      const sn = +s.dataset.step;
      s.classList.toggle('active', sn === n);
      s.classList.toggle('done', sn < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.getElementById('to-step-2').onclick = () => {
    const err = document.getElementById('err-1');
    err.textContent = '';
    if (!destinations.length && destInput.value.trim()) {
      // typed but never picked — a raw string isn't a real place, so ask for a pick
      err.textContent = 'בחרו יעד מהרשימה שנפתחת כדי שנדע בדיוק לאן';
      searchDestinations();
      return;
    }
    if (!destinations.length) { err.textContent = 'לאן נוסעים? הוסיפו לפחות יעד אחד'; return; }
    goStep(2);
  };
  document.getElementById('back-to-1').onclick = () => goStep(1);
  document.getElementById('to-step-3').onclick = () => goStep(3);
  document.getElementById('back-to-2').onclick = () => goStep(2);

  // ---- full-screen AI overlay ----
  const aiOverlay = document.getElementById('ai-overlay');
  const AI_QUIPS = [
    'מדפדף במדריכי טיולים…', 'בוחר את המסעדות הכי שוות…', 'מסדר את הימים בסדר הגיוני…',
    'מוסיף נקודות תצפית…', 'מצייר את המסלול על המפה…', 'שוקל בין שוק למוזיאון…',
    'מתייעץ עם מקומיים דמיוניים…', 'עוד רגע קטן — מלטש פרטים…',
  ];
  let quipTimer = null;
  function showAiOverlay(label) {
    document.getElementById('ai-overlay-title').textContent = `ה-AI מתכנן ${label}`;
    const sub = document.getElementById('ai-overlay-sub');
    let i = 0;
    sub.textContent = AI_QUIPS[0];
    clearInterval(quipTimer);
    quipTimer = setInterval(() => {
      sub.classList.add('swap');
      setTimeout(() => {
        i = (i + 1) % AI_QUIPS.length;
        sub.textContent = AI_QUIPS[i];
        sub.classList.remove('swap');
      }, 400);
    }, 2400);
    aiOverlay.classList.add('open');
    TRIPI.lockScroll();
  }
  function hideAiOverlay() {
    clearInterval(quipTimer);
    aiOverlay.classList.remove('open');
    TRIPI.unlockScroll();
  }

  // ---- AI builder ----
  const aiStatus = document.getElementById('ai-status');
  let aiBusy = false;

  const INTERESTS = ['🍜 אוכל ומסעדות', '🥾 טבע והליכות', '🏛️ היסטוריה ותרבות', '🖼️ אמנות ומוזיאונים',
    '🏖️ חופים וים', '🌃 חיי לילה', '🛍️ קניות', '👨‍👩‍👧 מתאים לילדים', '💰 תקציב נמוך',
    '💎 יוקרתי ומפנק', '📸 נקודות צילום', '🧗 אקסטרים וספורט', '☕ בתי קפה', '🎶 מוזיקה והופעות'];
  const selectedInterests = new Set();
  const interestRow = document.getElementById('interest-row');
  INTERESTS.forEach((label) => {
    const clean = label.replace(/^[^ ]+ /, ''); // interest text without the emoji
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'interest-chip'; b.textContent = label;
    b.onclick = () => {
      b.classList.toggle('selected');
      if (selectedInterests.has(clean)) selectedInterests.delete(clean);
      else selectedInterests.add(clean);
    };
    interestRow.appendChild(b);
  });

  // clarifying-questions dialog: fixed components (choice chips / free text),
  // shown only when the AI decided it truly needs the answer
  function askAiQuestions(questions, payload, label) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop open';
    wrap.innerHTML = `
      <div class="modal glass">
        <h2>שאלה קטנה לפני שבונים 🧭</h2>
        <p class="modal-sub">התשובה תעזור ל-AI לסדר את הטיול נכון — ואפשר גם לדלג</p>
        ${questions.map((q, i) => `
          <div class="field aiq" data-i="${i}" data-q="${TRIPI.esc(q.question)}"${q.multi ? ' data-multi="1"' : ''}>
            <label>${TRIPI.esc(q.question)}${q.multi ? ' <small>(אפשר לבחור כמה)</small>' : ''}</label>
            ${q.type === 'choice'
              ? `<div class="aiq-opts">${q.options.map((o) => `<button type="button" class="day-tab aiq-opt">${TRIPI.esc(o)}</button>`).join('')}<button type="button" class="day-tab aiq-opt aiq-other">אחר…</button></div>
                 <input type="text" class="aiq-text aiq-other-text" maxlength="120" placeholder="ספרו במילים שלכם (עד 15 מילים)…" hidden>`
              : `<input type="text" class="aiq-text" maxlength="120" placeholder="התשובה שלכם (עד 15 מילים)…">`}
          </div>`).join('')}
        <div style="display:flex;gap:8px;margin-top:18px">
          <button class="btn btn-amber btn-lg" id="aiq-go" style="flex:1;justify-content:center">בונים את הטיול ✨</button>
          <button class="btn btn-ghost" id="aiq-skip">דילוג</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    // free text is capped at 15 words (typing past the limit trims back)
    const clampWords = (inp) => {
      const words = inp.value.split(/\s+/).filter(Boolean);
      if (words.length > 15) inp.value = words.slice(0, 15).join(' ');
    };
    wrap.querySelectorAll('.aiq-text').forEach((inp) => inp.addEventListener('input', () => clampWords(inp)));
    wrap.querySelectorAll('.aiq-opts').forEach((opts) => {
      const field = opts.parentElement;
      const otherText = field.querySelector('.aiq-other-text');
      // "which regions to combine" lets several chips stay lit; every other
      // question is a pick-one, where a new choice replaces the previous
      const multi = field.dataset.multi === '1';
      opts.querySelectorAll('.aiq-opt').forEach((b) => {
        b.onclick = () => {
          if (multi) b.classList.toggle('active');
          else {
            opts.querySelectorAll('.aiq-opt').forEach((x) => x.classList.remove('active'));
            b.classList.add('active');
          }
          // "אחר" opens a free-text field; dropping it tucks the field away again
          const other = opts.querySelector('.aiq-other');
          otherText.hidden = !other.classList.contains('active');
          if (!otherText.hidden && b === other) otherText.focus();
        };
      });
    });
    const finish = (collect) => {
      const answers = collect
        ? [...wrap.querySelectorAll('.aiq')].map((f) => {
            // a multi question can contribute several chips plus the "אחר" text;
            // a single one has at most one chip, so the same join covers both
            const picked = [...f.querySelectorAll('.aiq-opt.active:not(.aiq-other)')].map((b) => b.textContent);
            const parts = [...picked];
            if (f.querySelector('.aiq-other.active')) parts.push(f.querySelector('.aiq-other-text').value.trim());
            const answer = parts.filter(Boolean).join(', ')
              || f.querySelector('.aiq-text:not(.aiq-other-text)')?.value.trim() || '';
            // `picked` stays separate from the answer text: the server splits a trip
            // into areas by the options ticked, and typed text is never an area
            return { question: f.dataset.q, answer, picked };
          }).filter((a) => a.answer)
        : [];
      wrap.remove();
      runAi({ ...payload, answers }, label); // answers present (even []) skips the question round
    };
    wrap.querySelector('#aiq-go').onclick = () => finish(true);
    wrap.querySelector('#aiq-skip').onclick = () => finish(false);
  }

  async function runAi(payload, label) {
    if (aiBusy) return;
    const go = async () => {
      aiBusy = true;
      aiStatus.className = 'ai-status';
      aiStatus.textContent = '';
      showAiOverlay(label);
      try {
        const res = await TRIPI.api('/api/ai/itinerary', {
          method: 'POST',
          body: JSON.stringify({
            destinations,
            interests: [...selectedInterests],
            notes: document.getElementById('ai-notes').value.trim() || null,
            want_meta: true, // description/emoji/cover for the trip that's about to exist
            ...payload,
          }),
        });
        // the AI may ask for a critical detail first (e.g. landing city)
        if (res.questions) {
          hideAiOverlay();
          aiBusy = false;
          askAiQuestions(res.questions, payload, label);
          return;
        }
        // AI-picked meta rides into the trip row
        if (res.meta) {
          if (res.meta.description && !aiDesc) aiDesc = res.meta.description;
          if (res.meta.emoji) aiMeta.emoji = res.meta.emoji;
          if (res.meta.cover_image) aiMeta.cover_image = res.meta.cover_image;
        }
        // title FIRST, off the destination the traveller actually typed ("טיול ליפן") —
        // the region swap below would otherwise retitle the trip after its own areas
        if (!titleInput.value.trim()) autoTitle();
        const regions = await regionDestinations(res.plan);
        if (regions) { destinations = regions; renderChips(); }
        // the build IS the creation: persist as a draft and land on the real trip
        // page in edit mode. The overlay stays up through the save + navigation.
        document.getElementById('ai-overlay-sub').textContent = 'שומרים את הטיול… ✈️';
        await saveDraftTrip(buildTripPayload(res.items || []));
        aiBusy = false; // reached only when the save failed — success navigates away
      } catch (e) {
        hideAiOverlay();
        aiBusy = false;
        aiStatus.className = 'ai-status error';
        aiStatus.textContent = '⚠️ ' + e.message;
      }
    };
    if (!TRIPI.user) openAuthModal(go, 'register');
    else go();
  }

  function fullBuild() {
    runAi({ day_from: 1, day_to: +daysSel.value }, 'את הטיול');
  }
  document.getElementById('ai-full').onclick = fullBuild; // step 3 primary CTA

  // ---- create (as a draft) ----

  // A one-country trip is built as areas — the ones the traveller ticked, or the ones
  // the AI broke the country into — and those areas ARE the trip: promoting them to
  // destinations is what gives the trip page its area badges and per-area AI scope.
  // The server reports them in `plan`, already ordered. Coordinates come from the
  // cities it names alongside each one: a region label on its own geocodes to nothing,
  // or worse — "קנטו" resolves to Cork, Ireland.
  async function regionDestinations(plan) {
    if (destinations.length !== 1 || !Array.isArray(plan) || plan.length < 2) return null;
    const base = destinations[0];
    if (plan.every((b) => b.area === base.name)) return null;
    const out = [];
    for (const b of plan) {
      const city = (b.cities || [])[0];
      const hit = city ? (await GEO.searchPlaces(city).catch(() => []))[0] : null;
      out.push({
        name: b.area,
        country: base.country || base.name,
        lat: hit ? hit.lat : base.lat, // the country centroid still beats no map at all
        lon: hit ? hit.lon : base.lon,
        cc: base.cc,
      });
    }
    return out;
  }

  function buildTripPayload(builtItems) {
    const days = +daysSel.value;
    const start = startInput.value || null;
    let end = null;
    if (start) {
      const e = new Date(start);
      e.setDate(e.getDate() + days - 1);
      end = e.toISOString().slice(0, 10);
    }
    if (!titleInput.value.trim()) autoTitle();
    return {
      title: titleInput.value.trim(),
      destinations,
      description: aiDesc || null,
      cover_image: aiMeta.cover_image || DEFAULT_COVER, // chosen by the AI
      start_date: start, end_date: end, days,
      emoji: aiMeta.emoji || '🧭',
      items: builtItems.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || ''))),
    };
  }

  // POST the draft and move to the trip page. A failed save keeps the built payload
  // for a retry that costs nothing — the AI quota was already spent on the build.
  let savingTrip = false;
  async function saveDraftTrip(payload) {
    if (savingTrip) return;
    savingTrip = true;
    try {
      const trip = await TRIPI.api('/api/trips', {
        method: 'POST', body: JSON.stringify({ ...payload, draft: true }),
      });
      clearDraft();
      location.href = '/trip/' + trip.share_code;
    } catch (e) {
      savingTrip = false;
      hideAiOverlay();
      aiStatus.className = 'ai-status error';
      aiStatus.innerHTML = `⚠️ הטיול נבנה אבל עוד לא נשמר (${TRIPI.esc(e.message)}) ` +
        `<button type="button" class="btn btn-amber" id="retry-save">שמירה מחדש</button>`;
      document.getElementById('retry-save').onclick = () => {
        aiStatus.textContent = 'שומרים את הטיול…';
        saveDraftTrip(payload);
      };
    }
  }

  // manual path: same creation moment, just with an empty itinerary — stops are
  // added on the trip page itself, which is the only manual builder now
  const goManualBtn = document.getElementById('go-manual');
  const goManualLabel = goManualBtn.textContent;
  goManualBtn.onclick = () => {
    const go = async () => {
      if (savingTrip) return;
      goManualBtn.disabled = true;
      goManualBtn.textContent = 'יוצרים את הטיול…';
      await saveDraftTrip(buildTripPayload([]));
      // still here = the save failed and rendered a retry into #ai-status
      goManualBtn.disabled = false;
      goManualBtn.textContent = goManualLabel;
    };
    if (!TRIPI.user) openAuthModal(go, 'register');
    else go();
  };

  // ---- saved draft: OFFER to continue (never auto-restore, never auto-nag) ----
  function applyDraft(draft) {
    destinations = (Array.isArray(draft.destinations) ? draft.destinations : []).filter((d) => d && d.name);
    renderChips();
    titleInput.value = draft.title || '';
    titleWasAutofilled = !!draft.titleWasAutofilled;
    daysSel.value = Math.min(Math.max(parseInt(draft.days, 10) || 4, 1), 60);
    startInput.value = draft.start || '';
    updateEndHint();
    document.getElementById('ai-notes').value = draft.aiNotes || '';
    (Array.isArray(draft.interests) ? draft.interests : []).forEach((name) => selectedInterests.add(name));
    interestRow.querySelectorAll('.interest-chip').forEach((b) => {
      b.classList.toggle('selected', selectedInterests.has(b.textContent.replace(/^[^ ]+ /, '')));
    });
    const step = Math.min(Math.max(parseInt(draft.step, 10) || 1, 1), 3);
    if (step > 1) goStep(step);
    userTouched = true; // continuing a draft counts as an active session
  }

  (function offerDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* corrupt */ }
    // v1/v2 drafts carried a step-4 itinerary that no longer exists here — purge them
    if (!draft || draft.v !== 3) { if (draft) clearDraft(); return; }
    if (Date.now() - (draft.savedAt || 0) > 14 * 24 * 60 * 60 * 1000) { clearDraft(); return; }
    const draftDests = (Array.isArray(draft.destinations) ? draft.destinations : []).filter((d) => d && d.name);
    if (!draftDests.length) { clearDraft(); return; } // orphan draft — purge silently
    const dTitle = (draft.title || '').trim() || draftDests.map((d) => d.name).join(' · ');
    document.getElementById('draft-banner-text').textContent = `✍️ יש טיוטה שמורה (${dTitle}) — להמשיך ממנה?`;
    draftBanner.hidden = false;
    document.getElementById('draft-continue').onclick = () => {
      draftBanner.hidden = true;
      applyDraft(draft);
    };
    document.getElementById('draft-reset').onclick = () => {
      clearDraft();
      draftBanner.hidden = true;
    };
  })();

  // ---- ?dest= from the homepage search ----
  // A country pick (?cc= present, from the static list) is trusted as-is: the chip
  // appears instantly and we land on step 2, while coordinates fill in quietly in
  // the background. Free text goes through the API — only an EXACT match may
  // auto-fill; anything else just pre-fills the search box and opens suggestions.
  (function applyDestParam() {
    const params = new URLSearchParams(location.search);
    const q = (params.get('dest') || '').trim().slice(0, 60);
    const cc = (params.get('cc') || '').trim().toLowerCase().slice(0, 2);
    if (!q) return;
    history.replaceState(null, '', '/plan'); // one-shot: a reload shouldn't re-add it
    if (destinations.length) return;
    if (cc && /^[a-z]{2}$/.test(cc)) {
      addDestination({ name: q, country: q, lat: null, lon: null, cc });
      goStep(2); // dest-context line in the panel shows what was picked
      GEO.searchPlaces(q).then((places) => {
        const hit = (places || []).find((p) => p.isCountry) || (places || [])[0];
        const d = destinations.find((x) => x.name === q && x.cc === cc);
        if (hit && d && d.lat == null) { d.lat = hit.lat; d.lon = hit.lon; scheduleSave(); }
      }).catch(() => { /* coords are a nice-to-have — the AI works off the name */ });
      return;
    }
    GEO.searchPlaces(q)
      .then((places) => {
        const exact = (places || []).find((p) => p.name.trim().toLowerCase() === q.toLowerCase());
        if (exact) {
          const country = exact.isCountry ? exact.name : exact.country;
          addDestination({ name: exact.name, country, lat: exact.lat, lon: exact.lon, cc: COUNTRIES.ccByName(country) });
          goStep(2); // dest-context line in the panel shows what was picked
        } else {
          destInput.value = q;
          searchDestinations();
        }
      })
      .catch(() => { destInput.value = q; });
  })();
})();
