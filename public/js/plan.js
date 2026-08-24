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
        ${cc ? COUNTRIES.flagHtml(cc) + ' ' : ''}${TRIPMAKER.esc(d.name)}${d.country && d.country !== d.name ? `<small>${TRIPMAKER.esc(d.country)}</small>` : ''}
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
        return `<span class="dc-dest">${cc ? COUNTRIES.flagHtml(cc) + ' ' : ''}${TRIPMAKER.esc(d.name)}${d.country && d.country !== d.name ? `<small>, ${TRIPMAKER.esc(d.country)}</small>` : ''}</span>`;
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

  // a locally-matched destination has a name and a country but no coordinates —
  // they arrive from the geocoder a moment later, and the trip is saved again once
  // they do. The AI works off the name either way, so nothing waits for this.
  function fillCoords(d) {
    GEO.searchPlaces(d.name).then((places) => {
      const hit = (places || []).find((p) => (p.country || p.name) === d.country) || (places || [])[0];
      if (hit && d.lat == null) { d.lat = hit.lat; d.lon = hit.lon; scheduleSave(); }
    }).catch(() => { /* coordinates are a nice-to-have, not a blocker */ });
  }

  function localOptionsHtml(hits) {
    return hits.map((d, i) => `
      <button type="button" class="autocomplete-item" data-local="${i}">
        <span class="ac-icon">${COUNTRIES.flagHtml(d.cc)}</span>
        <span class="ac-name">${TRIPMAKER.esc(d.name)}</span>
        <span class="ac-meta">${TRIPMAKER.esc(DESTINATIONS.subtitle(d))}</span>
      </button>`).join('');
  }

  // The curated index answers first — it knows the Hebrew spellings the geocoder
  // misses, and it always carries a country code, so the chip gets a flag and the
  // AI gets a country. The geocoder still runs behind it for everything else
  // (a village, a national park, a place nobody thought to list).
  function bindOptions(hits, places, q) {
    suggBox.querySelectorAll('.autocomplete-item').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.free) {
          addDestination({ name: q, country: null, lat: null, lon: null });
        } else if (btn.dataset.local != null) {
          const d = hits[+btn.dataset.local];
          const dest = { name: d.name, country: d.country, lat: null, lon: null, cc: d.cc };
          addDestination(dest);
          fillCoords(dest);
        } else {
          const p = places[+btn.dataset.i];
          const country = p.isCountry ? p.name : p.country;
          addDestination({ name: p.name, country, lat: p.lat, lon: p.lon, cc: COUNTRIES.ccByName(country) });
        }
      };
    });
  }

  const FREE_TEXT_ITEM = (q) => `
    <button type="button" class="autocomplete-item free-text" data-free="1">
      <span class="ac-icon">✏️</span>
      <span class="ac-name">להוסיף "${TRIPMAKER.esc(q)}" כמו שהוא</span>
    </button>`;

  async function searchDestinations() {
    const q = destInput.value.trim();
    if (q.length < 2) { suggBox.classList.remove('open'); return; }
    const hits = DESTINATIONS.search(q, 4);
    const places = await GEO.searchPlaces(q).catch(() => []);
    if (destInput.value.trim() !== q) return; // stale response — user kept typing
    // the geocoder repeating what the index already offered is just a duplicate row
    const known = new Set(hits.map((d) => DESTINATIONS.normalize(d.name)));
    const extra = places.filter((p) => !known.has(DESTINATIONS.normalize(p.name)));
    const options = extra.map((p, i) => {
      const cc = p.isCountry ? COUNTRIES.ccByName(p.name) : null;
      return `
      <button type="button" class="autocomplete-item" data-i="${i}">
        <span class="ac-icon">${cc ? COUNTRIES.flagHtml(cc) : (p.isCountry ? '🌍' : '📍')}</span>
        <span class="ac-name">${TRIPMAKER.esc(p.name)}</span>
        <span class="ac-meta">${p.isCountry ? 'מדינה' : TRIPMAKER.esc([p.admin, p.country].filter(Boolean).join(', '))}</span>
      </button>`;
    }).join('');
    // free-text fallback appears only AFTER results loaded, so it can't be picked blindly
    suggBox.innerHTML = localOptionsHtml(hits) + options + FREE_TEXT_ITEM(q);
    suggBox.classList.add('open');
    bindOptions(hits, extra, q);
  }

  // the index is in memory, so its suggestions can be on screen on the keystroke
  // itself; only the geocoder round-trip is worth debouncing
  function showLocalSuggestions(q) {
    const hits = DESTINATIONS.search(q, 4);
    if (!hits.length) return;
    suggBox.innerHTML = localOptionsHtml(hits);
    suggBox.classList.add('open');
    bindOptions(hits, [], q);
  }

  destInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = destInput.value.trim();
    if (q.length < 2) { suggBox.classList.remove('open'); return; }
    showLocalSuggestions(q);
    debounceTimer = setTimeout(searchDestinations, 280);
  });

  destInput.addEventListener('keydown', (e) => {
    const open = suggBox.classList.contains('open');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (open) { e.preventDefault(); TRIPMAKER.acMove(suggBox, e.key === 'ArrowDown' ? 1 : -1); }
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

  // ---- days stepper + range calendar ----
  // Two views of the same decision: dragging a range on the calendar sets how many
  // days the trip is, and nudging the number moves the return date to match. Dates
  // stay optional — with none picked the stepper alone decides the length.
  const daysSel = document.getElementById('f-days');
  const endHint = document.getElementById('end-date-hint');
  const PICK_HINT = 'בוחרים את יום היציאה, ואז את יום החזרה';
  let tripStart = null; // ISO, or null while the trip has no dates

  const datesPicker = DATEPICKER.create(document.getElementById('plan-dates'), {
    maxDays: 60,
    onChange: ({ start, end, days }) => {
      tripStart = start;
      if (days) daysSel.value = days; // already capped at maxDays by the picker
      updateEndHint(!end); // half a range: say so instead of showing a return date
      userTouched = true;
      scheduleSave();
    },
  });

  function clampDays() {
    daysSel.value = Math.min(Math.max(parseInt(daysSel.value, 10) || 1, 1), 60);
    // the stepper is authoritative when it's the one being moved — the calendar
    // follows it, which is what keeps the two from disagreeing
    if (tripStart) syncPickerToDays();
    updateEndHint();
  }
  function syncPickerToDays() {
    datesPicker.set(tripStart, TRIPMAKER.isoDate(endDate())); // silent: it would echo the number back
  }
  // DATEPICKER.parse, not new Date(iso): a bare "2026-09-14" is read as UTC midnight,
  // which west of Greenwich is the day before the one the traveller picked
  function endDate() {
    if (!tripStart) return null;
    const end = DATEPICKER.parse(tripStart);
    end.setDate(end.getDate() + (+daysSel.value) - 1);
    return end;
  }
  function updateEndHint(pending) {
    const end = endDate();
    if (!end) { endHint.textContent = PICK_HINT; return; }
    if (pending) { endHint.textContent = 'ועכשיו את יום החזרה'; return; }
    endHint.textContent = `${daysSel.value} ימים · חוזרים ב-`
      + end.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  document.getElementById('days-minus').onclick = () => { daysSel.value = +daysSel.value - 1; clampDays(); };
  document.getElementById('days-plus').onclick = () => { daysSel.value = +daysSel.value + 1; clampDays(); };
  daysSel.addEventListener('change', clampDays);

  // ---- draft autosave: leave mid-creation, come back, continue ----
  // v3 covers steps 1-3 only — the itinerary itself lives on the server from the
  // moment it's built, so there's nothing heavier to keep here anymore
  const DRAFT_KEY = 'tripmaker_plan_draft';
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
      start: tripStart,
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
    panel3b.style.display = 'none'; // the region sub-step never survives navigation
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
    document.body.style.overflow = 'hidden';
  }
  function hideAiOverlay() {
    clearInterval(quipTimer);
    aiOverlay.classList.remove('open');
    document.body.style.overflow = '';
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
          <div class="field aiq" data-i="${i}" data-q="${TRIPMAKER.esc(q.question)}"${q.multi ? ' data-multi="1"' : ''}>
            <label>${TRIPMAKER.esc(q.question)}${q.multi ? ' <small>(אפשר לבחור כמה)</small>' : ''}</label>
            ${q.type === 'choice'
              ? `<div class="aiq-opts">${q.options.map((o) => `<button type="button" class="day-tab aiq-opt">${TRIPMAKER.esc(o)}</button>`).join('')}<button type="button" class="day-tab aiq-opt aiq-other">אחר…</button></div>
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
        const res = await TRIPMAKER.api('/api/ai/itinerary', {
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
    if (!TRIPMAKER.user) openAuthModal(go, 'register');
    else go();
  }

  function fullBuild() {
    runAi({ day_from: 1, day_to: +daysSel.value }, 'את הטיול');
  }
  // step 3 primary CTA — long trips take a detour through the region-edit screen
  // first, so the traveller sees (and can repaint) the day→area split before any
  // stop exists. Future idea, not built: a LONG trip whose destinations span several
  // different countries should be nudged back at step 1 to pick one country.
  document.getElementById('ai-full').onclick = () => {
    const days = +daysSel.value;
    if (days >= REGION_EDIT_MIN_DAYS) regionEditFlow(days);
    else fullBuild();
  };

  // ---- region-edit step (long trips): paint the AI's day→area split before building ----
  // From this many days the wizard inserts "עריכת אזורים" between step 3 and the
  // build: the AI splits the trip into areas first (no stops yet), the split is
  // painted on a month-view calendar, and the full build then runs with the
  // traveller's allocation as a given. A bare constant on purpose — easy to tune.
  const REGION_EDIT_MIN_DAYS = 9;
  // same palette as the trip page's calendar, so an area keeps its color there
  const AREA_COLORS = ['#ffb45f', '#8fd8c4', '#c9a7ff', '#7fb8ff', '#ff9db1', '#ffd166'];
  const DOW_HE = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const panel3b = document.getElementById('panel-3b');
  let regionPlan = null; // the AI's recommendation, untouched — what "דילוג" builds
  let regionDayAreas = null; // area name per trip day (index 0 = day 1) — what painting edits
  let paletteAreas = []; // [{name, cities}] in recommendation order — fixes each area's color
  let selectedArea = null;
  let regionBusy = false;

  const areaColor = (name) =>
    AREA_COLORS[Math.max(paletteAreas.findIndex((a) => a.name === name), 0) % AREA_COLORS.length];

  async function regionEditFlow(days) {
    const go = async () => {
      if (regionBusy || aiBusy) return;
      regionBusy = true;
      const btn = document.getElementById('ai-full');
      btn.disabled = true;
      // deliberately NOT the full-screen overlay: this wait is short and lands back
      // in the wizard — the glowing overlay is saved for the real build
      aiStatus.className = 'ai-status working';
      aiStatus.textContent = 'ה-AI מחלק את הטיול לאזורים…';
      try {
        const res = await TRIPMAKER.api('/api/ai/plan-regions', {
          method: 'POST',
          body: JSON.stringify({
            destinations,
            day_from: 1,
            day_to: days,
            interests: [...selectedInterests],
            notes: document.getElementById('ai-notes').value.trim() || null,
          }),
        });
        aiStatus.className = 'ai-status';
        aiStatus.textContent = '';
        const plan = Array.isArray(res.plan) ? res.plan.filter((b) => b && b.area) : [];
        if (new Set(plan.map((b) => b.area)).size >= 2) openRegionEditor(plan, days);
        // one area — nothing to paint; the preset still rides along so the popup
        // won't re-ask a region question the traveller never needed
        else if (plan.length) runAi({ day_from: 1, day_to: days, plan }, 'את הטיול');
        else fullBuild();
      } catch {
        // the region screen is an enhancement, never a gate — on failure the classic
        // flow (the split happens inside the build) takes over silently
        aiStatus.className = 'ai-status';
        aiStatus.textContent = '';
        fullBuild();
      } finally {
        regionBusy = false;
        btn.disabled = false;
      }
    };
    if (!TRIPMAKER.user) openAuthModal(go, 'register');
    else go();
  }

  function openRegionEditor(plan, days) {
    regionPlan = plan;
    paletteAreas = [...new Map(plan.map((b) => [b.area, b.cities || []])).entries()]
      .map(([name, cities]) => ({ name, cities }));
    regionDayAreas = new Array(days).fill(plan[0].area);
    plan.forEach((b) => {
      for (let d = b.from; d <= b.to && d <= days; d++) regionDayAreas[d - 1] = b.area;
    });
    selectedArea = paletteAreas[0].name;
    document.getElementById('region-question').textContent = `אילו אזורים משלבים ב-${days} הימים? 🗺️`;
    document.getElementById('err-3b').textContent = '';
    renderRegionPalette();
    renderRegionCalendar();
    panels[3].style.display = 'none';
    panel3b.style.display = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // the same cell the trip page's month calendar renders (.cal-cell/.cc-*), minus
  // the stops it doesn't have yet — .rc-day only shrinks it to paint-grid size
  function rcCell(d, label) {
    const area = regionDayAreas[d];
    return `<button type="button" class="cal-cell has-area rc-day" data-d="${d}" style="--area-c:${areaColor(area)}" aria-label="יום ${d + 1} · ${TRIPMAKER.esc(area)}">` +
      `<span class="cc-head"><span class="cc-num">${label}</span></span><span class="cc-area">${TRIPMAKER.esc(area)}</span></button>`;
  }

  // month view either way: with real dates the trip paints onto its actual months
  // (weekday headers, date numbers); without them it's the same grid of "יום N" cells
  function renderRegionCalendar() {
    const cal = document.getElementById('region-cal');
    const start = tripStart ? DATEPICKER.parse(tripStart) : null;
    let html = '';
    if (start) {
      let monthKey = null;
      let cells = '';
      const flush = () => {
        if (!cells) return;
        html += `<div class="cal-dow-row">${DOW_HE.map((x) => `<span>${x}</span>`).join('')}</div><div class="cal-grid rc-grid">${cells}</div>`;
        cells = '';
      };
      for (let d = 0; d < regionDayAreas.length; d++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
        const key = `${date.getFullYear()}-${date.getMonth()}`;
        if (key !== monthKey) {
          flush();
          monthKey = key;
          html += `<div class="rc-month">${date.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })}</div>`;
          cells += '<span class="rc-pad"></span>'.repeat(date.getDay());
        }
        cells += rcCell(d, String(date.getDate()));
      }
      flush();
    } else {
      html = '<div class="cal-grid rc-grid">' + regionDayAreas.map((_, d) => rcCell(d, 'יום ' + (d + 1))).join('') + '</div>';
    }
    cal.innerHTML = html;
    cal.querySelectorAll('.rc-day').forEach((el) => {
      el.onclick = () => {
        regionDayAreas[+el.dataset.d] = selectedArea;
        document.getElementById('err-3b').textContent = '';
        renderRegionCalendar();
      };
    });
  }

  function renderRegionPalette() {
    const pal = document.getElementById('region-palette');
    pal.innerHTML = '<span class="rp-hint">בוחרים אזור ומקישים על ימים בלוח כדי לצבוע:</span>' +
      paletteAreas.map((a) =>
        `<button type="button" class="rp-area${a.name === selectedArea ? ' selected' : ''}" data-a="${TRIPMAKER.esc(a.name)}">` +
        `<i style="background:${areaColor(a.name)}"></i>${TRIPMAKER.esc(a.name)}</button>`).join('');
    pal.querySelectorAll('.rp-area').forEach((b) => {
      b.onclick = () => { selectedArea = b.dataset.a; renderRegionPalette(); };
    });
  }

  // consecutive same-area days → the contiguous blocks the server builds from.
  // An area returning later (קיוטו→טוקיו→קיוטו) yields separate blocks — allowed.
  function paintedBlocks() {
    const blocks = [];
    regionDayAreas.forEach((area, i) => {
      const last = blocks[blocks.length - 1];
      if (last && last.area === area) last.to = i + 1;
      else blocks.push({ area, from: i + 1, to: i + 1, cities: (paletteAreas.find((a) => a.name === area) || {}).cities || [] });
    });
    return blocks;
  }

  // restore panel 3 underneath before building: the overlay covers the swap, and an
  // error (or the clarifying popup) lands the traveller back where #ai-status lives
  function closeRegionEditor() {
    panel3b.style.display = 'none';
    panels[3].style.display = '';
  }
  document.getElementById('back-to-3').onclick = closeRegionEditor;
  document.getElementById('regions-go').onclick = () => {
    const blocks = paintedBlocks();
    if (blocks.length > 12) {
      // every block is its own build call — a zebra of single days isn't a trip
      document.getElementById('err-3b').textContent = 'יותר מדי מעברים בין אזורים — כדאי לאחד ימים סמוכים לאותו אזור';
      return;
    }
    closeRegionEditor();
    runAi({ day_from: 1, day_to: regionDayAreas.length, plan: blocks }, 'את הטיול');
  };
  // the default: build with the recommendation exactly as it was shown
  document.getElementById('regions-skip').onclick = () => {
    closeRegionEditor();
    runAi({ day_from: 1, day_to: regionDayAreas.length, plan: regionPlan }, 'את הטיול');
  };

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
    const start = tripStart;
    // the very day the calendar and the hint show — anything that round-trips
    // through toISOString() hands the server the day before, east of Greenwich
    const end = start ? TRIPMAKER.isoDate(endDate()) : null;
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
      const trip = await TRIPMAKER.api('/api/trips', {
        method: 'POST', body: JSON.stringify({ ...payload, draft: true }),
      });
      clearDraft();
      location.href = '/trip/' + trip.share_code;
    } catch (e) {
      savingTrip = false;
      hideAiOverlay();
      aiStatus.className = 'ai-status error';
      aiStatus.innerHTML = `⚠️ הטיול נבנה אבל עוד לא נשמר (${TRIPMAKER.esc(e.message)}) ` +
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
    if (!TRIPMAKER.user) openAuthModal(go, 'register');
    else go();
  };

  // ---- saved draft: OFFER to continue (never auto-restore, never auto-nag) ----
  function applyDraft(draft) {
    destinations = (Array.isArray(draft.destinations) ? draft.destinations : []).filter((d) => d && d.name);
    renderChips();
    titleInput.value = draft.title || '';
    titleWasAutofilled = !!draft.titleWasAutofilled;
    daysSel.value = Math.min(Math.max(parseInt(draft.days, 10) || 4, 1), 60);
    tripStart = draft.start || null;
    if (tripStart) syncPickerToDays(); else datesPicker.set(null, null);
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
  // A pick off the destination index (?cc= present, and ?country= for a city) is
  // trusted as-is: the chip appears instantly and we land on step 2, while
  // coordinates fill in quietly in the background. Free text goes through the API —
  // only an EXACT match may auto-fill; anything else just pre-fills the search box
  // and opens suggestions.
  (function applyDestParam() {
    const params = new URLSearchParams(location.search);
    const q = (params.get('dest') || '').trim().slice(0, 60);
    const cc = (params.get('cc') || '').trim().toLowerCase().slice(0, 2);
    const country = (params.get('country') || '').trim().slice(0, 60);
    if (!q) return;
    history.replaceState(null, '', '/plan'); // one-shot: a reload shouldn't re-add it
    if (destinations.length) return;
    if (cc && /^[a-z]{2}$/.test(cc)) {
      // the country name comes from the same index that produced the code, so it is
      // only trusted when the two actually agree — a hand-edited URL falls back to
      // treating the destination as a country of its own
      const cn = country && COUNTRIES.ccByName(country) === cc ? country : q;
      const dest = { name: q, country: cn, lat: null, lon: null, cc };
      addDestination(dest);
      goStep(2); // dest-context line in the panel shows what was picked
      fillCoords(dest);
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
