// Plan wizard: 3 steps → create trip → show share code ticket.
(() => {
  const EMOJIS = ['🧭', '🏖️', '🏔️', '🏛️', '🌸', '🎡', '🍜', '🚐', '🤿', '🎿', '🐫', '🦁'];
  const COVERS = [
    'photo-1469854523086-cc02fe5d8800', // road trip
    'photo-1507525428034-b723cf961d3e', // beach
    'photo-1464822759023-fed622ff2c3b', // mountains
    'photo-1552832230-c0197dd311b5',    // rome
    'photo-1540959733332-eab4deabeeaf', // tokyo
    'photo-1502602898657-3e91760cbb34', // paris
    'photo-1613395877344-13d4a8e0d49e', // santorini
    'photo-1476514525535-07fb3b4ae5f1', // canoe lake
  ].map((id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=80`);

  let selectedEmoji = EMOJIS[0];
  let selectedCover = COVERS[0];
  let currentDay = 1;
  let items = []; // {day_number, time_label, title, note, place_query, category}
  let destinations = []; // [{name, country, lat, lon}]

  // ---- destination autocomplete (multi-city chips) ----
  const destInput = document.getElementById('f-dest-search');
  const suggBox = document.getElementById('dest-suggestions');
  const chipsBox = document.getElementById('dest-chips');
  const titleInput = document.getElementById('f-title');
  let debounceTimer = null;
  let titleWasAutofilled = false;

  function renderChips() {
    chipsBox.innerHTML = destinations.map((d, i) => `
      <span class="dest-chip">
        ${TRIPI.esc(d.name)}${d.country && d.country !== d.name ? `<small>${TRIPI.esc(d.country)}</small>` : ''}
        <button type="button" data-i="${i}" aria-label="הסרת יעד">✕</button>
      </span>`).join('');
    chipsBox.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { destinations.splice(+b.dataset.i, 1); renderChips(); autoTitle(); };
    });
  }

  function autoTitle() {
    if (titleInput.value && !titleWasAutofilled) return; // never overwrite the user's own title
    if (!destinations.length) { if (titleWasAutofilled) { titleInput.value = ''; titleWasAutofilled = false; } return; }
    const names = destinations.map((d) => d.name);
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

  destInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = destInput.value.trim();
    if (q.length < 2) { suggBox.classList.remove('open'); return; }
    debounceTimer = setTimeout(async () => {
      const places = await GEO.searchPlaces(q).catch(() => []);
      const options = places.map((p, i) => `
        <button type="button" class="autocomplete-item" data-i="${i}">
          <span class="ac-icon">${p.isCountry ? '🌍' : '📍'}</span>
          <span class="ac-name">${TRIPI.esc(p.name)}</span>
          <span class="ac-meta">${p.isCountry ? 'מדינה' : TRIPI.esc([p.admin, p.country].filter(Boolean).join(', '))}</span>
        </button>`).join('');
      // always offer free-text as a fallback so nobody gets stuck
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
            addDestination({ name: p.name, country: p.isCountry ? p.name : p.country, lat: p.lat, lon: p.lon });
          }
        };
      });
    }, 280);
  });

  destInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = suggBox.querySelector('.autocomplete-item');
      if (suggBox.classList.contains('open') && first) first.click();
      else if (destInput.value.trim()) addDestination({ name: destInput.value.trim(), country: null, lat: null, lon: null });
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

  const emojiRow = document.getElementById('emoji-row');
  EMOJIS.forEach((em, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'emoji-opt' + (i === 0 ? ' selected' : ''); b.textContent = em;
    b.onclick = () => {
      emojiRow.querySelectorAll('.emoji-opt').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected'); selectedEmoji = em;
    };
    emojiRow.appendChild(b);
  });

  const coverGrid = document.getElementById('cover-grid');
  COVERS.forEach((url, i) => {
    const d = document.createElement('div');
    d.className = 'cover-opt' + (i === 0 ? ' selected' : '');
    d.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
    d.onclick = () => {
      coverGrid.querySelectorAll('.cover-opt').forEach((x) => x.classList.remove('selected'));
      d.classList.add('selected'); selectedCover = url;
    };
    coverGrid.appendChild(d);
  });

  // ---- draft autosave: leave mid-creation, come back, continue ----
  const DRAFT_KEY = 'tripi_plan_draft';
  let curStep = 1;
  let draftTimer = null;

  function saveDraft() {
    if (curStep === 3) return; // trip already created — nothing to keep
    const draft = {
      v: 1,
      savedAt: Date.now(),
      step: curStep,
      currentDay,
      destinations,
      items: items.map(({ _id, ...it }) => it),
      title: titleInput.value,
      titleWasAutofilled,
      days: daysSel.value,
      start: startInput.value,
      desc: document.getElementById('f-desc').value,
      emoji: selectedEmoji,
      cover: selectedCover,
      interests: [...selectedInterests],
      aiNotes: document.getElementById('ai-notes').value,
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full — skip */ }
  }
  function scheduleSave() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 600); }
  function clearDraft() { clearTimeout(draftTimer); localStorage.removeItem(DRAFT_KEY); }

  // any interaction inside the wizard panels schedules a save
  ['panel-1', 'panel-2'].forEach((id) => {
    const p = document.getElementById(id);
    p.addEventListener('input', scheduleSave);
    p.addEventListener('click', scheduleSave);
  });

  document.getElementById('draft-reset').onclick = () => {
    if (!confirm('למחוק את הטיוטה ולהתחיל מחדש?')) return;
    clearDraft();
    location.reload();
  };

  // ---- wizard navigation ----
  const panels = { 1: document.getElementById('panel-1'), 2: document.getElementById('panel-2'), 3: document.getElementById('panel-3') };
  function goStep(n) {
    curStep = n;
    if (n === 3) clearDraft(); else scheduleSave();
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
      // user typed but didn't pick — add it for them instead of nagging
      addDestination({ name: destInput.value.trim(), country: null, lat: null, lon: null });
    }
    if (!destinations.length) { err.textContent = 'לאן נוסעים? הוסיפו לפחות יעד אחד'; return; }
    if (!titleInput.value.trim()) autoTitle();
    buildDayTabs();
    goStep(2);
  };
  document.getElementById('back-to-1').onclick = () => goStep(1);

  // ---- area helpers (multi-destination trips only) ----
  const areaField = document.getElementById('i-area-field');
  const areaSel = document.getElementById('i-area');
  const multiArea = () => destinations.length > 1;

  // default area = last stop of this day; if the day is empty — the last stop of the closest previous day
  function defaultArea(day) {
    const sameDay = items.filter((it) => it.day_number === day);
    if (sameDay.length) return sameDay[sameDay.length - 1].area || destinations[0]?.name;
    for (let d = day - 1; d >= 1; d--) {
      const prev = items.filter((it) => it.day_number === d);
      if (prev.length) return prev[prev.length - 1].area || destinations[0]?.name;
    }
    return destinations[0]?.name;
  }

  function refreshAreaField() {
    if (!multiArea()) { areaField.style.display = 'none'; return; }
    areaField.style.display = '';
    areaSel.innerHTML = destinations.map((d) => `<option>${TRIPI.esc(d.name)}</option>`).join('');
    areaSel.value = defaultArea(currentDay);
  }

  // ---- step 2: itinerary builder ----
  function buildDayTabs() {
    const n = +daysSel.value;
    if (currentDay > n) currentDay = 1;
    items = items.filter((it) => it.day_number <= n);
    const tabs = document.getElementById('day-tabs');
    tabs.innerHTML = '';
    for (let d = 1; d <= n; d++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-tab' + (d === currentDay ? ' active' : '');
      b.dataset.day = d;
      b.onclick = () => { currentDay = d; buildDayTabs(); };
      tabs.appendChild(b);
    }
    refreshTabCounts();
    renderItems();
    refreshAreaField();
    setupAiPanel();
  }

  function refreshTabCounts() {
    document.querySelectorAll('.day-tab').forEach((b) => {
      const d = +b.dataset.day;
      const cnt = items.filter((it) => it.day_number === d).length;
      b.innerHTML = `יום ${d} ${cnt ? `<span class="cnt">· ${cnt}</span>` : ''}`;
    });
  }

  function renderItems() {
    const wrap = document.getElementById('added-items');
    const dayItems = items.filter((it) => it.day_number === currentDay);
    if (!dayItems.length) {
      wrap.innerHTML = '<div class="empty-day">היום הזה עדיין ריק — מוסיפים תחנה ראשונה למעלה ⤴</div>';
      return;
    }
    wrap.innerHTML = dayItems.map((it) => `
      <div class="added-item-wrap" data-id="${it._id}">
        <div class="added-item">
          ${it.time_label ? `<span class="ai-time">${TRIPI.esc(it.time_label)}</span>` : ''}
          <span class="ai-title">${TRIPI.esc(it.title)}${multiArea() && it.area ? ` <small class="ai-area">· ${TRIPI.esc(it.area)}</small>` : ''}</span>
          <span class="item-chevron" title="פרטים">▾</span>
          <button class="ai-del" data-id="${it._id}" title="הסרה">✕</button>
        </div>
        <div class="item-more" hidden></div>
      </div>`).join('');
    wrap.querySelectorAll('.ai-del').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); items = items.filter((it) => it._id !== +b.dataset.id); refreshTabCounts(); renderItems(); refreshAreaField(); };
    });
    // expand a row → full details + exact-location mini map
    wrap.querySelectorAll('.added-item-wrap').forEach((row) => {
      row.querySelector('.added-item').addEventListener('click', (e) => {
        if (e.target.closest('.ai-del')) return;
        const it = items.find((x) => x._id === +row.dataset.id);
        const more = row.querySelector('.item-more');
        const open = !more.hidden;
        if (open) { more.hidden = true; row.classList.remove('expanded'); return; }
        if (!more.dataset.loaded) {
          const hasMap = !!(it.place_query || (it.lat != null && it.lon != null));
          more.innerHTML = `
            <div class="item-more-details">
              ${it.category ? `<span class="item-cat">${TRIPI.esc(it.category)}</span>` : ''}
              ${it.area ? `<span class="item-area">📍 ${TRIPI.esc(it.area)}</span>` : ''}
            </div>
            ${it.note ? `<div class="item-note">${TRIPI.esc(it.note)}</div>` : ''}
            ${it.place_query ? `<div class="item-more-place">📌 ${TRIPI.esc(it.place_query)}</div>` : ''}
            ${hasMap ? `<iframe class="item-mini-map" loading="lazy" title="מפת התחנה" src="${TRIPI.mapsEmbedUrlExact(it)}"></iframe>`
                     : '<div class="item-note">אין מיקום לתחנה הזו — אפשר להוסיף דרך שדה המיקום</div>'}
            ${it.place_query ? '<div class="stop-gallery"></div>' : ''}`;
          more.dataset.loaded = '1';
          const gal = more.querySelector('.stop-gallery');
          if (gal) GEO.renderGallery(gal, it.place_query);
        }
        more.hidden = false;
        row.classList.add('expanded');
      });
    });
  }

  // place field: real dropdown of POIs (restaurants, museums, beaches…) biased to the chosen destination
  const placePicker = GEO.attachPlaceAutocomplete(document.getElementById('i-place'), {
    getBias: () => ({ lat: destinations[0]?.lat, lon: destinations[0]?.lon }),
  });

  let idSeq = 1;
  document.getElementById('add-item').onclick = () => {
    const err = document.getElementById('err-2');
    err.textContent = '';
    const title = document.getElementById('i-title').value.trim();
    if (!title) { err.textContent = 'מה עושים? — זה שדה חובה'; return; }
    items.push({
      _id: idSeq++,
      day_number: currentDay,
      time_label: document.getElementById('i-time').value || null,
      title,
      note: document.getElementById('i-note').value.trim() || null,
      place_query: document.getElementById('i-place').value.trim() || null,
      category: document.getElementById('i-cat').value,
      area: multiArea() ? areaSel.value : (destinations[0]?.name || null),
      lat: placePicker.getPicked()?.lat ?? null,
      lon: placePicker.getPicked()?.lon ?? null,
    });
    ['i-title', 'i-place', 'i-note'].forEach((id) => { document.getElementById(id).value = ''; });
    placePicker.clear(); // don't leak the previous pick's coordinates into the next stop
    refreshTabCounts();
    renderItems();
    // the freshly used area becomes the default for the next stop
    if (multiArea()) areaSel.value = defaultArea(currentDay);
  };

  // ---- manual form collapse (after an AI build it's rarely needed) ----
  const manualWrap = document.getElementById('manual-form-wrap');
  const manualToggle = document.getElementById('manual-toggle');
  function collapseManualForm() {
    manualWrap.style.display = 'none';
    manualToggle.style.display = '';
  }
  manualToggle.onclick = () => {
    manualWrap.style.display = '';
    manualToggle.style.display = 'none';
    document.getElementById('i-title').focus();
  };

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

  function setupAiPanel() {
    const byAreaBtn = document.getElementById('ai-by-area');
    byAreaBtn.style.display = multiArea() ? '' : 'none';
    if (!multiArea()) document.getElementById('ai-area-form').style.display = 'none';
    const sel = document.getElementById('ai-area-sel');
    sel.innerHTML = destinations.map((d) => `<option>${TRIPI.esc(d.name)}</option>`).join('');
    const to = document.getElementById('ai-day-to');
    const from = document.getElementById('ai-day-from');
    from.max = to.max = +daysSel.value;
    if (+to.value > +daysSel.value) to.value = daysSel.value;
  }

  async function runAi(payload, label) {
    if (aiBusy) return;
    const go = async () => {
      aiBusy = true;
      aiStatus.className = 'ai-status working';
      aiStatus.textContent = `✨ ה-AI מתכנן ${label}… זה לוקח בערך חצי דקה`;
      try {
        const res = await TRIPI.api('/api/ai/itinerary', {
          method: 'POST',
          body: JSON.stringify({
            destinations,
            interests: [...selectedInterests],
            notes: document.getElementById('ai-notes').value.trim() || null,
            ...payload,
          }),
        });
        res.items.forEach((it) => items.push({ _id: idSeq++, ...it }));
        items.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')));
        aiStatus.className = 'ai-status done';
        aiStatus.textContent = `✅ נוספו ${res.items.length} תחנות — עברו על הימים ותתאימו לטעמכם`;
        collapseManualForm(); // the AI did the heavy lifting — tuck the manual form away
        refreshTabCounts();
        renderItems();
        refreshAreaField();
      } catch (e) {
        aiStatus.className = 'ai-status error';
        aiStatus.textContent = '⚠️ ' + e.message;
      } finally {
        aiBusy = false;
      }
    };
    if (!TRIPI.user) openAuthModal(go, 'register');
    else go();
  }

  document.getElementById('ai-full').onclick = () => {
    const existing = items.length;
    if (existing && !confirm('יש כבר תחנות במסלול. ה-AI יוסיף תחנות חדשות לצידן — להמשיך?')) return;
    runAi({ day_from: 1, day_to: +daysSel.value }, 'את כל הטיול');
  };
  document.getElementById('ai-by-area').onclick = () => {
    const f = document.getElementById('ai-area-form');
    f.style.display = f.style.display === 'none' ? '' : 'none';
  };
  document.getElementById('ai-area-go').onclick = () => {
    const area = document.getElementById('ai-area-sel').value;
    const from = +document.getElementById('ai-day-from').value || 1;
    const to = +document.getElementById('ai-day-to').value || from;
    if (to < from) { aiStatus.className = 'ai-status error'; aiStatus.textContent = '⚠️ טווח הימים הפוך'; return; }
    runAi({ area, day_from: from, day_to: Math.min(to, +daysSel.value) }, `את ${area}`);
  };

  // ---- create ----
  async function createTrip() {
    const err = document.getElementById('err-2');
    err.textContent = '';
    const days = +daysSel.value;
    const start = document.getElementById('f-start').value || null;
    let end = null;
    if (start) {
      const e = new Date(start);
      e.setDate(e.getDate() + days - 1);
      end = e.toISOString().slice(0, 10);
    }
    const payload = {
      title: document.getElementById('f-title').value.trim(),
      destinations,
      description: document.getElementById('f-desc').value.trim() || null,
      cover_image: selectedCover,
      start_date: start, end_date: end, days,
      emoji: selectedEmoji,
      items: items.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || ''))),
    };
    try {
      const trip = await TRIPI.api('/api/trips', { method: 'POST', body: JSON.stringify(payload) });
      document.getElementById('new-code').textContent = trip.share_code;
      document.getElementById('new-title').textContent = `${trip.emoji || ''} ${trip.title}`;
      document.getElementById('view-trip').href = '/trip/' + trip.share_code;
      document.getElementById('copy-new-code').onclick = async () => {
        await navigator.clipboard.writeText(trip.share_code).catch(() => {});
        const f = document.getElementById('new-feedback');
        f.textContent = 'הקוד הועתק! ✓';
        setTimeout(() => { f.textContent = ''; }, 2200);
      };
      goStep(3);
    } catch (e) {
      err.textContent = e.message;
    }
  }

  document.getElementById('create-trip').onclick = () => {
    if (!TRIPI.user) {
      openAuthModal(() => { renderHeaderRefresh(); createTrip(); }, 'register');
      return;
    }
    createTrip();
  };

  function renderHeaderRefresh() {
    document.querySelector('.site-header')?.remove();
    renderHeader();
  }

  // ---- restore a saved draft (runs last, after all widgets exist) ----
  (function restoreDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* corrupt */ }
    if (!draft || draft.v !== 1) return;
    if (Date.now() - (draft.savedAt || 0) > 14 * 24 * 60 * 60 * 1000) { clearDraft(); return; }
    const hasContent = (draft.destinations || []).length || (draft.items || []).length || (draft.title || '').trim();
    if (!hasContent) return;

    destinations = (Array.isArray(draft.destinations) ? draft.destinations : []).filter((d) => d && d.name);
    renderChips();
    items = (Array.isArray(draft.items) ? draft.items : [])
      .filter((it) => it && it.title)
      .map((it) => ({ _id: idSeq++, ...it }));
    titleInput.value = draft.title || '';
    titleWasAutofilled = !!draft.titleWasAutofilled;
    daysSel.value = Math.min(Math.max(parseInt(draft.days, 10) || 4, 1), 60);
    startInput.value = draft.start || '';
    updateEndHint();
    document.getElementById('f-desc').value = draft.desc || '';
    document.getElementById('ai-notes').value = draft.aiNotes || '';

    if (draft.emoji && EMOJIS.includes(draft.emoji)) {
      selectedEmoji = draft.emoji;
      emojiRow.querySelectorAll('.emoji-opt').forEach((b) => b.classList.toggle('selected', b.textContent === draft.emoji));
    }
    if (draft.cover && COVERS.includes(draft.cover)) {
      selectedCover = draft.cover;
      coverGrid.querySelectorAll('.cover-opt').forEach((d) => d.classList.toggle('selected', d.querySelector('img').src === draft.cover));
    }
    (Array.isArray(draft.interests) ? draft.interests : []).forEach((name) => selectedInterests.add(name));
    interestRow.querySelectorAll('.interest-chip').forEach((b) => {
      b.classList.toggle('selected', selectedInterests.has(b.textContent.replace(/^[^ ]+ /, '')));
    });

    currentDay = Math.max(parseInt(draft.currentDay, 10) || 1, 1);
    if (draft.step === 2 && destinations.length) {
      buildDayTabs();
      goStep(2);
    }
    document.getElementById('draft-banner').hidden = false;
  })();

  // ---- ?dest= from the homepage search: geocode it and pre-fill the destination chip ----
  (function applyDestParam() {
    const q = (new URLSearchParams(location.search).get('dest') || '').trim().slice(0, 60);
    if (!q) return;
    history.replaceState(null, '', '/plan'); // one-shot: a reload shouldn't re-add it
    if (destinations.some((d) => d.name === q)) return;
    GEO.searchPlaces(q)
      .then((places) => {
        const p = places[0];
        if (p && !destinations.some((d) => d.name === p.name)) {
          addDestination({ name: p.name, country: p.isCountry ? p.name : p.country, lat: p.lat, lon: p.lon });
        } else if (!p) {
          addDestination({ name: q, country: null, lat: null, lon: null });
        }
      })
      .catch(() => addDestination({ name: q, country: null, lat: null, lon: null }));
  })();
})();
