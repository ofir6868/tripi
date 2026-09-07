// AI-first plan wizard: destinations → dates → style → the trip is CREATED on the
// spot — an empty draft on the server, opened on its own page (/trip/CODE) straight
// into the planning chat (#plan), where the AI builds it with the traveller. The style
// answers ride along as the chat's opening memory. Publishing ("שמירת הטיול") happens
// over there.
(() => {
  const DEFAULT_COVER = 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=1200&q=80';

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

  // step 2 reminder of what was chosen, as a quiet line under the panel title —
  // matters most when we jumped here automatically. Changing destinations is the
  // back arrow's job; the line only offers the add-another shortcut.
  function renderDestContext() {
    const box = document.getElementById('dest-context');
    if (!box) return;
    if (!destinations.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = destinations
      .map((d) => {
        const cc = ccFor(d);
        return `<span class="dc-dest">${cc ? COUNTRIES.flagHtml(cc) + ' ' : ''}${TRIPMAKER.esc(d.name)}${d.country && d.country !== d.name ? `<small>, ${TRIPMAKER.esc(d.country)}</small>` : ''}</span>`;
      })
      .join('<span class="dc-sep">·</span>') +
      ` <button type="button" class="dc-change" id="dc-add">+ עוד יעד</button>`;
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

  // ---- style ----
  const aiStatus = document.getElementById('ai-status');

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

  // ---- create (as a draft) ----

  // the AI path: the trip is created empty and opens on the planning chat, where the
  // AI asks what it needs, then builds — step by step or all at once, as the traveller
  // picks there. Nothing is generated here anymore.
  const aiBtn = document.getElementById('ai-full');
  const aiLabel = aiBtn.textContent;
  aiBtn.onclick = () => {
    const go = async () => {
      if (savingTrip) return;
      aiBtn.disabled = true;
      aiBtn.textContent = 'פותחים את התכנון…';
      await saveDraftTrip(buildTripPayload([]), {
        plan_state: { interests: [...selectedInterests], notes: document.getElementById('ai-notes').value.trim(), mode: 'manual' },
        hash: '#plan',
      });
      // still here = the save failed and rendered a retry into #ai-status
      aiBtn.disabled = false;
      aiBtn.textContent = aiLabel;
    };
    if (!TRIPMAKER.user) openAuthModal(go, 'register');
    else go();
  };

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
      description: null, // the AI writes one when it builds the itinerary
      cover_image: DEFAULT_COVER, // swapped for the AI's pick at build time
      start_date: start, end_date: end, days,
      emoji: '🧭',
      items: builtItems.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || ''))),
    };
  }

  // POST the draft and move to the trip page (`hash` picks the tab it opens on). A
  // failed save keeps the payload for a retry that costs nothing.
  let savingTrip = false;
  async function saveDraftTrip(payload, { plan_state = null, hash = '' } = {}) {
    if (savingTrip) return;
    savingTrip = true;
    try {
      const trip = await TRIPMAKER.api('/api/trips', {
        method: 'POST', body: JSON.stringify({ ...payload, draft: true, plan_state }),
      });
      clearDraft();
      location.href = '/trip/' + trip.share_code + hash;
    } catch (e) {
      savingTrip = false;
      aiStatus.className = 'ai-status error';
      aiStatus.innerHTML = `⚠️ הטיול עוד לא נוצר (${TRIPMAKER.esc(e.message)}) ` +
        `<button type="button" class="btn btn-amber" id="retry-save">ניסיון נוסף</button>`;
      document.getElementById('retry-save').onclick = () => {
        aiStatus.textContent = 'יוצרים את הטיול…';
        saveDraftTrip(payload, { plan_state, hash });
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

  // ---- AI request from the homepage ----
  // sessionStorage keeps a potentially long free-text request out of the URL. The
  // resolved destinations become normal chips, while the original request becomes
  // builder notes so preferences and constraints survive destination extraction.
  (function applyHomepageIntake() {
    const params = new URLSearchParams(location.search);
    if (params.get('intake') !== '1') return;
    history.replaceState(null, '', '/plan');
    let intake = null;
    try {
      intake = JSON.parse(sessionStorage.getItem('tripmaker_plan_intake') || 'null');
      sessionStorage.removeItem('tripmaker_plan_intake');
    } catch {
      sessionStorage.removeItem('tripmaker_plan_intake');
    }
    const incoming = (Array.isArray(intake?.destinations) ? intake.destinations : [])
      .filter((d) => d && String(d.name || '').trim())
      .slice(0, 6);
    if (!incoming.length) return;

    clearDraft();
    draftBanner.hidden = true;
    destinations = [];
    incoming.forEach((d) => {
      const dest = {
        name: String(d.name).trim().slice(0, 80),
        country: d.country ? String(d.country).trim().slice(0, 60) : null,
        lat: null,
        lon: null,
      };
      addDestination(dest);
      fillCoords(dest);
    });
    document.getElementById('ai-notes').value = String(intake.prompt || '').trim().slice(0, 500);
    goStep(2);
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
