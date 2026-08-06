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

  // ---- step 1 widgets ----
  const daysSel = document.getElementById('f-days');
  for (let d = 1; d <= 21; d++) {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = d === 1 ? 'יום אחד' : `${d} ימים`;
    if (d === 4) opt.selected = true;
    daysSel.appendChild(opt);
  }

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

  // ---- wizard navigation ----
  const panels = { 1: document.getElementById('panel-1'), 2: document.getElementById('panel-2'), 3: document.getElementById('panel-3') };
  function goStep(n) {
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
    if (!document.getElementById('f-title').value.trim() || !document.getElementById('f-dest').value.trim()) {
      err.textContent = 'צריך לפחות שם טיול ויעד כדי להמשיך';
      return;
    }
    buildDayTabs();
    goStep(2);
  };
  document.getElementById('back-to-1').onclick = () => goStep(1);

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
      <div class="added-item">
        ${it.time_label ? `<span class="ai-time">${TRIPI.esc(it.time_label)}</span>` : ''}
        <span class="ai-title">${TRIPI.esc(it.title)}</span>
        <button class="ai-del" data-id="${it._id}" title="הסרה">✕</button>
      </div>`).join('');
    wrap.querySelectorAll('.ai-del').forEach((b) => {
      b.onclick = () => { items = items.filter((it) => it._id !== +b.dataset.id); refreshTabCounts(); renderItems(); };
    });
  }

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
    });
    ['i-title', 'i-place', 'i-note'].forEach((id) => { document.getElementById(id).value = ''; });
    refreshTabCounts();
    renderItems();
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
      destination: document.getElementById('f-dest').value.trim(),
      country: document.getElementById('f-country').value.trim() || null,
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
})();
