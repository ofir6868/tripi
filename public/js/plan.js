// AI-first plan wizard: destinations → dates → style → AI builds → review → ticket.
(() => {
  const DEFAULT_COVER = 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&w=1200&q=80';

  let aiMeta = { emoji: null, cover_image: null }; // chosen automatically by the AI
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
    renderDestContext();
  }

  // step 2 reminder of what was chosen — matters most when we jumped here automatically
  function renderDestContext() {
    const box = document.getElementById('dest-context');
    if (!box) return;
    if (!destinations.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<span class="dc-label">הטיול שלכם ל־</span>` + destinations
      .map((d) => `<span class="dc-dest">${TRIPI.esc(d.name)}${d.country && d.country !== d.name ? `<small>, ${TRIPI.esc(d.country)}</small>` : ''}</span>`)
      .join('<span class="dc-sep">·</span>') +
      ` <button type="button" class="dc-change" id="dc-change">שינוי</button>`;
    box.querySelector('#dc-change').onclick = () => goStep(1);
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

  async function searchDestinations() {
    const q = destInput.value.trim();
    if (q.length < 2) { suggBox.classList.remove('open'); return; }
    const places = await GEO.searchPlaces(q).catch(() => []);
    if (destInput.value.trim() !== q) return; // stale response — user kept typing
    const options = places.map((p, i) => `
      <button type="button" class="autocomplete-item" data-i="${i}">
        <span class="ac-icon">${p.isCountry ? '🌍' : '📍'}</span>
        <span class="ac-name">${TRIPI.esc(p.name)}</span>
        <span class="ac-meta">${p.isCountry ? 'מדינה' : TRIPI.esc([p.admin, p.country].filter(Boolean).join(', '))}</span>
      </button>`).join('');
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
          addDestination({ name: p.name, country: p.isCountry ? p.name : p.country, lat: p.lat, lon: p.lon });
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
  const DRAFT_KEY = 'tripi_plan_draft';
  let curStep = 1;
  let draftTimer = null;

  function saveDraft() {
    if (curStep === 5) return; // trip already created — nothing to keep
    if (!userTouched) return;  // programmatic changes alone never create a draft
    // no destinations = no draft, period. Anything else (orphan items, auto-title)
    // restores nothing visible and causes the phantom "continued from draft" banner.
    if (!destinations.length) { localStorage.removeItem(DRAFT_KEY); return; }
    const draft = {
      v: 2,
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
      aiMeta,
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
  ['panel-1', 'panel-2', 'panel-3', 'panel-4'].forEach((id) => {
    const p = document.getElementById(id);
    const onInteract = () => {
      userTouched = true;
      draftBanner.hidden = true; // started working → stop nagging about the old draft
      scheduleSave();
    };
    p.addEventListener('input', onInteract);
    p.addEventListener('click', onInteract);
  });

  // ---- wizard navigation (1 יעדים · 2 תאריכים · 3 סגנון · 4 מסלול · 5 שיתוף) ----
  const panels = {};
  for (let i = 1; i <= 5; i++) panels[i] = document.getElementById('panel-' + i);
  function goStep(n) {
    curStep = n;
    if (n === 5) clearDraft(); else scheduleSave();
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
  document.getElementById('back-to-3').onclick = () => goStep(3);
  document.getElementById('go-manual').onclick = () => {
    if (!titleInput.value.trim()) autoTitle();
    buildDayTabs();
    goStep(4);
    // manual path: open the form right away
    document.getElementById('manual-form-wrap').style.display = '';
    document.getElementById('manual-toggle').style.display = 'none';
  };

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
                     : '<div class="item-note">אין מיקום לתחנה הזו — אפשר להוסיף כאן למטה ↓</div>'}
            ${it.place_query ? '<div class="stop-gallery"></div>' : ''}
            <button type="button" class="edit-loc-btn">📍 ${it.place_query ? 'שינוי מיקום' : 'הוספת מיקום'}</button>
            <div class="edit-loc-form" hidden>
              <input type="text" class="edit-loc-input" maxlength="120" placeholder="הקלידו ובחרו מהרשימה…" autocomplete="off" value="${TRIPI.esc(it.place_query || '')}">
              <div style="display:flex;gap:8px;margin-top:8px">
                <button type="button" class="btn btn-amber edit-loc-save" style="flex:1;justify-content:center">שמירה</button>
                <button type="button" class="btn btn-ghost edit-loc-cancel">ביטול</button>
              </div>
            </div>`;
          more.dataset.loaded = '1';
          const gal = more.querySelector('.stop-gallery');
          if (gal) GEO.renderGallery(gal, it.place_query);

          const locForm = more.querySelector('.edit-loc-form');
          const locInput = more.querySelector('.edit-loc-input');
          const locPicker = GEO.attachPlaceAutocomplete(locInput, {
            getBias: () => ({ lat: it.lat ?? destinations[0]?.lat, lon: it.lon ?? destinations[0]?.lon }),
          });
          more.querySelector('.edit-loc-btn').onclick = (e) => {
            e.stopPropagation();
            locForm.hidden = false;
            e.target.hidden = true;
            locInput.focus();
          };
          more.querySelector('.edit-loc-cancel').onclick = (e) => { e.stopPropagation(); locForm.hidden = true; more.querySelector('.edit-loc-btn').hidden = false; };
          more.querySelector('.edit-loc-save').onclick = (e) => {
            e.stopPropagation();
            const picked = locPicker.getPicked();
            it.place_query = locInput.value.trim() || null;
            it.lat = picked ? picked.lat : null; // typed-only text gets no stale coords
            it.lon = picked ? picked.lon : null;
            scheduleSave();
            renderItems(); // rebuilds the row; reopening shows the updated map
          };
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

  // the AI edit box replaces the old rebuild / build-by-area buttons; the area+days
  // scope is integrated into it (multi-destination trips only)
  const planAiArea = document.getElementById('plan-ai-area');
  function setupAiPanel() {
    document.getElementById('plan-ai-scope').style.display = multiArea() ? '' : 'none';
    const prev = planAiArea.value;
    planAiArea.innerHTML = '<option value="">כל הטיול</option>' +
      destinations.map((d) => `<option>${TRIPI.esc(d.name)}</option>`).join('');
    if ([...planAiArea.options].some((o) => o.value === prev)) planAiArea.value = prev;
    syncAiScopeRange();
  }
  // picking an area reveals its day range, pre-filled with where that area sits today
  function syncAiScopeRange() {
    const area = planAiArea.value;
    document.getElementById('plan-ai-range').style.display = area ? '' : 'none';
    if (!area) return;
    const fromInp = document.getElementById('plan-ai-from');
    const toInp = document.getElementById('plan-ai-to');
    fromInp.max = toInp.max = +daysSel.value;
    const areaDays = items.filter((it) => it.area === area).map((it) => it.day_number);
    fromInp.value = areaDays.length ? Math.min(...areaDays) : 1;
    toInp.value = areaDays.length ? Math.min(Math.max(...areaDays), +daysSel.value) : +daysSel.value;
  }
  planAiArea.onchange = syncAiScopeRange;

  // clarifying-questions dialog: fixed components (choice chips / free text),
  // shown only when the AI decided it truly needs the answer
  function askAiQuestions(questions, payload, label, replaceRange) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop open';
    wrap.innerHTML = `
      <div class="modal glass">
        <h2>שאלה קטנה לפני שבונים 🧭</h2>
        <p class="modal-sub">התשובה תעזור ל-AI לסדר את הטיול נכון — ואפשר גם לדלג</p>
        ${questions.map((q, i) => `
          <div class="field aiq" data-i="${i}" data-q="${TRIPI.esc(q.question)}">
            <label>${TRIPI.esc(q.question)}</label>
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
      const otherText = opts.parentElement.querySelector('.aiq-other-text');
      opts.querySelectorAll('.aiq-opt').forEach((b) => {
        b.onclick = () => {
          opts.querySelectorAll('.aiq-opt').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          // "אחר" opens a free-text field; picking a regular option tucks it away
          const isOther = b.classList.contains('aiq-other');
          otherText.hidden = !isOther;
          if (isOther) otherText.focus();
        };
      });
    });
    const finish = (collect) => {
      const answers = collect
        ? [...wrap.querySelectorAll('.aiq')].map((f) => {
            const act = f.querySelector('.aiq-opt.active');
            const answer = act?.classList.contains('aiq-other')
              ? f.querySelector('.aiq-other-text').value.trim()
              : act?.textContent || f.querySelector('.aiq-text:not([hidden])')?.value.trim() || '';
            return { question: f.dataset.q, answer };
          }).filter((a) => a.answer)
        : [];
      wrap.remove();
      runAi({ ...payload, answers }, label, replaceRange); // answers present (even []) skips the question round
    };
    wrap.querySelector('#aiq-go').onclick = () => finish(true);
    wrap.querySelector('#aiq-skip').onclick = () => finish(false);
  }

  async function runAi(payload, label, replaceRange) {
    if (aiBusy) return;
    const go = async () => {
      aiBusy = true;
      aiStatus.className = 'ai-status';
      aiStatus.textContent = '';
      showAiOverlay(label);
      try {
        const descField = document.getElementById('f-desc');
        const res = await TRIPI.api('/api/ai/itinerary', {
          method: 'POST',
          body: JSON.stringify({
            destinations,
            interests: [...selectedInterests],
            notes: document.getElementById('ai-notes').value.trim() || null,
            want_meta: !payload.area, // full builds refresh description/emoji/cover
            ...payload,
          }),
        });
        // the AI may ask for a critical detail first (e.g. landing city)
        if (res.questions) {
          hideAiOverlay();
          aiBusy = false;
          askAiQuestions(res.questions, payload, label, replaceRange);
          return;
        }
        // AI-picked meta: description (if empty), emoji + cover always refreshed on full builds
        if (res.meta) {
          if (res.meta.description && !descField.value.trim()) descField.value = res.meta.description;
          if (res.meta.emoji) aiMeta.emoji = res.meta.emoji;
          if (res.meta.cover_image) aiMeta.cover_image = res.meta.cover_image;
        }
        // replace only after a SUCCESSFUL generation — a failed run never wipes anything
        if (replaceRange) {
          items = items.filter((it) => it.day_number < replaceRange.from || it.day_number > replaceRange.to);
        }
        res.items.forEach((it) => items.push({ _id: idSeq++, ...it }));
        items.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')));
        if (!titleInput.value.trim()) autoTitle();
        buildDayTabs();
        if (curStep !== 4) goStep(4); // land on the itinerary review
        aiStatus.className = 'ai-status done';
        collapseManualForm(); // the AI did the heavy lifting — tuck the manual form away
        refreshTabCounts();
        renderItems();
        refreshAreaField();
        scheduleSave();
      } catch (e) {
        if (curStep >= 4) {
          alert('⚠️ ' + e.message); // the status line lives on step 3 — surface errors here directly
        } else {
          aiStatus.className = 'ai-status error';
          aiStatus.textContent = '⚠️ ' + e.message;
        }
      } finally {
        hideAiOverlay();
        aiBusy = false;
      }
    };
    if (!TRIPI.user) openAuthModal(go, 'register');
    else go();
  }

  function fullBuild() {
    const days = +daysSel.value;
    if (items.length && !confirm(`הבנייה מחדש תחליף את כל ${items.length} התחנות הקיימות במסלול. להמשיך?`)) return;
    runAi({ day_from: 1, day_to: days }, 'את כל הטיול', { from: 1, to: days });
  }
  document.getElementById('ai-full').onclick = fullBuild; // step 3 primary CTA

  // ---- step 4 AI edit box: free-text changes over the draft itinerary ----
  const planAiInput = document.getElementById('plan-ai-input');
  const planAiBtn = document.getElementById('plan-ai-btn');
  const planAiCount = document.getElementById('plan-ai-count');
  const planAiResult = document.getElementById('plan-ai-result');
  planAiInput.addEventListener('input', () => { planAiCount.textContent = `${planAiInput.value.length}/100`; });
  document.getElementById('plan-ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = planAiInput.value.trim();
    if (!prompt || planAiBtn.disabled) return;
    const go = async () => {
      planAiBtn.disabled = true;
      planAiInput.disabled = true;
      const prevLabel = planAiBtn.textContent;
      planAiBtn.textContent = 'רגע… ⏳';
      planAiResult.hidden = true;
      planAiResult.className = 'ai-edit-result';
      try {
        const area = multiArea() ? planAiArea.value || null : null;
        const r = await TRIPI.api('/api/ai/edit-draft', {
          method: 'POST',
          body: JSON.stringify({
            title: titleInput.value.trim() || null,
            destinations,
            days: +daysSel.value,
            items: items.map((it) => ({
              id: it._id, day_number: it.day_number, time_label: it.time_label, title: it.title,
              note: it.note, place_query: it.place_query, category: it.category, area: it.area,
            })),
            prompt,
            area,
            day_from: area ? +document.getElementById('plan-ai-from').value || 1 : null,
            day_to: area ? +document.getElementById('plan-ai-to').value || +daysSel.value : null,
          }),
        });
        let added = 0, updated = 0, removed = 0;
        for (const op of r.ops) {
          if (op.action === 'delete') {
            const before = items.length;
            items = items.filter((it) => it._id !== op.id);
            removed += before - items.length;
          } else if (op.action === 'update') {
            const it = items.find((x) => x._id === op.id);
            if (!it) continue;
            if (op.day_number != null) it.day_number = op.day_number;
            if (op.time_label != null) it.time_label = op.time_label;
            if (op.title != null) it.title = op.title;
            if (op.note != null) it.note = op.note;
            if (op.place_query != null) { it.place_query = op.place_query; it.lat = null; it.lon = null; }
            if (op.category != null) it.category = op.category;
            if (op.area != null) it.area = op.area;
            updated++;
          } else if (op.action === 'add') {
            items.push({
              _id: idSeq++, day_number: op.day_number, time_label: op.time_label, title: op.title,
              note: op.note, place_query: op.place_query, category: op.category, area: op.area,
              lat: null, lon: null,
            });
            added++;
          }
        }
        items.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || '')));
        buildDayTabs();
        scheduleSave();
        const changed = added + updated + removed > 0;
        planAiResult.classList.add(changed ? 'ok' : 'info');
        planAiResult.textContent = r.summary;
        if (changed) { planAiInput.value = ''; planAiCount.textContent = '0/100'; }
      } catch (err) {
        planAiResult.classList.add('err');
        planAiResult.textContent = err.message;
      } finally {
        planAiResult.hidden = false;
        planAiBtn.disabled = false;
        planAiInput.disabled = false;
        planAiBtn.textContent = prevLabel;
      }
    };
    if (!TRIPI.user) openAuthModal(go, 'register');
    else go();
  });

  // ---- create ----
  let creatingTrip = false; // double-tap on the create button must not create two trips
  async function createTrip() {
    if (creatingTrip) return;
    creatingTrip = true;
    const createBtn = document.getElementById('create-trip');
    createBtn.disabled = true;
    const prevLabel = createBtn.textContent;
    createBtn.textContent = 'יוצרים… ⏳';
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
    if (!document.getElementById('f-title').value.trim()) autoTitle();
    const payload = {
      title: document.getElementById('f-title').value.trim(),
      destinations,
      description: document.getElementById('f-desc').value.trim() || null,
      cover_image: aiMeta.cover_image || DEFAULT_COVER, // chosen by the AI
      start_date: start, end_date: end, days,
      emoji: aiMeta.emoji || '🧭',
      items: items.sort((a, b) => a.day_number - b.day_number || String(a.time_label || '').localeCompare(String(b.time_label || ''))),
    };
    try {
      const trip = await TRIPI.api('/api/trips', { method: 'POST', body: JSON.stringify(payload) });
      const newCode = document.getElementById('new-code');
      newCode.textContent = trip.share_code;
      newCode.classList.add('copyable');
      newCode.title = 'לחיצה מעתיקה את קוד הטיול';
      document.getElementById('new-title').textContent = `${trip.emoji || ''} ${trip.title}`;
      document.getElementById('view-trip').href = '/trip/' + trip.share_code;
      const tripLink = location.origin + '/trip/' + trip.share_code;
      document.getElementById('wa-share-new').onclick = () => {
        const text = `${trip.emoji || '🧭'} ${trip.title}\n${tripLink}`;
        window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
      };
      document.getElementById('copy-new-link').onclick = async () => {
        await TRIPI.copy(tripLink);
        const f = document.getElementById('new-feedback');
        f.textContent = 'הקישור הועתק! ✓';
        setTimeout(() => { f.textContent = ''; }, 2200);
      };
      goStep(5);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      creatingTrip = false;
      createBtn.disabled = false;
      createBtn.textContent = prevLabel;
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

  // ---- saved draft: OFFER to continue (never auto-restore, never auto-nag) ----
  function applyDraft(draft) {
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
    if (draft.aiMeta && typeof draft.aiMeta === 'object') {
      aiMeta = { emoji: draft.aiMeta.emoji || null, cover_image: draft.aiMeta.cover_image || null };
    }
    (Array.isArray(draft.interests) ? draft.interests : []).forEach((name) => selectedInterests.add(name));
    interestRow.querySelectorAll('.interest-chip').forEach((b) => {
      b.classList.toggle('selected', selectedInterests.has(b.textContent.replace(/^[^ ]+ /, '')));
    });
    currentDay = Math.max(parseInt(draft.currentDay, 10) || 1, 1);
    const step = (draft.items || []).length ? 4 : Math.min(Math.max(parseInt(draft.step, 10) || 1, 1), 4);
    if (step >= 4) buildDayTabs();
    if (step > 1) goStep(step);
    userTouched = true; // continuing a draft counts as an active session
  }

  (function offerDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* corrupt */ }
    if (!draft || ![1, 2].includes(draft.v)) { if (draft) clearDraft(); return; }
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
  // Only an EXACT cities/countries API match may auto-fill; then we jump straight to
  // step 2 with the chosen destination shown. Anything else just pre-fills the search
  // box and opens real suggestions — raw text is never added as a destination.
  (function applyDestParam() {
    const q = (new URLSearchParams(location.search).get('dest') || '').trim().slice(0, 60);
    if (!q) return;
    history.replaceState(null, '', '/plan'); // one-shot: a reload shouldn't re-add it
    if (destinations.length) return;
    GEO.searchPlaces(q)
      .then((places) => {
        const exact = (places || []).find((p) => p.name.trim().toLowerCase() === q.toLowerCase());
        if (exact) {
          addDestination({ name: exact.name, country: exact.isCountry ? exact.name : exact.country, lat: exact.lat, lon: exact.lon });
          goStep(2); // dest-context line in the panel shows what was picked
        } else {
          destInput.value = q;
          searchDestinations();
        }
      })
      .catch(() => { destInput.value = q; });
  })();
})();
