// The day's pictures, on the trip map — chosen from the traveller's own Google Drive.
//
// Drive is the only copy and the source of truth (routes/day-photos.js has the why): the
// trip keeps which file belongs to which day, and every picture here is drawn through a
// signed link that reads Drive at that moment. Nothing is kept on the device either — no
// IndexedDB, no localStorage, no-store on the bytes, and the service worker steps aside.
//
// The whole feature stands on one condition: if the traveller has no Drive switched on
// and nobody on the trip has added a picture, it draws nothing at all — no card, no
// button, no empty state. With Drive on, each day gets a photo card at the end of the
// stop strip under the map (phone, small map and full page alike), a row of pictures in
// the full page's day panel (wide screens), and a round thumbnail on the map wherever a
// picture carries the place it was taken.
const TripDayPhotos = (() => {
  let ctx = null;     // { code, canEdit, dayDate, dayColor, onChange }
  let canAdd = false; // this traveller's Drive is on — the picker is theirs to open
  let photos = [];
  let loaded = null;

  const esc = (s) => TRIPMAKER.esc(s);
  const IC = {
    cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    drive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 3h7l6 10.5-3.5 6h-12L2.5 13.5 8.5 3Z"/><path d="m8.5 3 6 10.5h7M2.5 13.5h12L11 19.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  const active = () => !!ctx && (canAdd || photos.length > 0);
  const ofDay = (day) => photos.filter((p) => p.day === day);
  const isoOf = (day) => {
    const d = ctx && ctx.dayDate ? ctx.dayDate(day) : null;
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayTitle = (day) => {
    const d = ctx && ctx.dayDate ? ctx.dayDate(day) : null;
    return `יום ${day}${d ? ` · ${d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}` : ''}`;
  };
  const dayTint = (day) => (ctx && ctx.dayColor ? ctx.dayColor(day) : '#ffb45f');
  const clock = (p) => (p.taken ? p.taken.slice(11, 16) : '');
  const count = (n) => (n === 1 ? 'תמונה אחת' : `${n} תמונות`);

  function load() {
    if (!ctx || !ctx.code || !TRIPMAKER.token) return Promise.resolve();
    loaded = TRIPMAKER.api(`/api/trips/code/${encodeURIComponent(ctx.code)}/day-photos`)
      .then((r) => { canAdd = !!r.can_add && !!ctx.canEdit; photos = Array.isArray(r.photos) ? r.photos : []; })
      .catch(() => { canAdd = false; photos = []; }) // a feature that could not load is a feature that is not there
      .then(() => ctx.onChange && ctx.onChange());
    return loaded;
  }

  function init(c) {
    ctx = c;
    return load();
  }

  // ---- the strip card (under the map — the phone's way in, small and full) ----

  function stripHtml(day) {
    if (!active() || !day) return '';
    const list = ofDay(day);
    if (!list.length && !canAdd) return '';
    if (!list.length) {
      return `<button type="button" class="map-stop map-photos is-empty enter" data-photos-day="${day}" style="--day:${dayTint(day)}" title="בחירת תמונות של היום הזה מה-Google Drive שלכם">
          <span class="mph-add" aria-hidden="true">${IC.cam}</span>
          <span class="ms-body"><span class="ms-title">תמונות מהיום</span><span class="ms-cat">מה-Google Drive שלכם</span></span>
        </button>`;
    }
    const tiles = list.slice(0, 3).map((p, i) => `<img alt="" loading="lazy" decoding="async" src="${esc(p.thumb)}" style="--i:${i}" onerror="this.remove()">`).join('');
    return `<button type="button" class="map-stop map-photos enter" data-photos-day="${day}" style="--day:${dayTint(day)}" title="התמונות של יום ${day}">
        <span class="mph-stack n${Math.min(list.length, 3)}" aria-hidden="true">${tiles}</span>
        <span class="ms-body"><span class="ms-title">${count(list.length)}</span><span class="ms-cat">${canAdd ? 'צפייה והוספה' : 'צפייה'}</span></span>
      </button>`;
  }

  // ---- the full page's day panel (wide screens) ----

  function panelHtml(day) {
    if (!active()) return '';
    const list = ofDay(day);
    if (!list.length && !canAdd) return '';
    const shown = list.slice(0, 5);
    const more = list.length - shown.length;
    return `<div class="mp-photos" role="group" aria-label="תמונות של יום ${day}">
        ${shown.map((p) => `<button type="button" class="mp-photo" data-photo="${p.id}" aria-label="${esc(p.name || 'תמונה')}"><img alt="" loading="lazy" decoding="async" src="${esc(p.thumb)}" onerror="this.parentNode.remove()"></button>`).join('')}
        ${more > 0 ? `<button type="button" class="mp-photo mp-photo-more" data-photos-day="${day}">+${more}</button>` : ''}
        ${canAdd ? `<button type="button" class="mp-photo mp-photo-add" data-add-day="${day}" title="הוספת תמונות מה-Google Drive">${IC.plus}<span>${list.length ? '' : 'תמונות מה-Drive'}</span></button>` : ''}
      </div>`;
  }

  // one handler for whatever this module drew inside `root`
  function wire(root) {
    if (!root) return;
    root.querySelectorAll('[data-photos-day]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const day = +b.dataset.photosDay;
        if (!ofDay(day).length && canAdd) openPicker(day); else openAlbum(day);
      });
    });
    root.querySelectorAll('[data-photo]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = photos.find((x) => x.id === +b.dataset.photo);
        if (p) openViewer(p.day, ofDay(p.day).indexOf(p));
      });
    });
    root.querySelectorAll('[data-add-day]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); openPicker(+b.dataset.addDay); });
    });
  }

  // ---- on the map: a round thumbnail where a picture was taken ----

  function drawPins(layer, day) {
    if (!layer) return;
    layer.clearLayers();
    if (!active() || !day || typeof L === 'undefined') return;
    const list = ofDay(day);
    list.forEach((p, i) => {
      if (p.lat == null || p.lon == null) return;
      const m = L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: 'map-photo-pin-wrap',
          html: `<span class="map-photo-pin" style="--day:${ctx.dayColor ? ctx.dayColor(day) : '#ffb45f'}"><img alt="" src="${esc(p.thumb)}" onerror="this.parentNode.classList.add('broken');this.remove()"></span>`,
          iconSize: [34, 34], iconAnchor: [17, 17],
        }),
        alt: `תמונה${clock(p) ? ` מ-${clock(p)}` : ''}`,
        keyboard: true, zIndexOffset: -200,
      });
      m.on('click', () => openViewer(day, i));
      layer.addLayer(m);
    });
  }

  // ---- the album: every picture of the day, and the way to add more ----

  function openAlbum(day) {
    const list = ofDay(day);
    TripPages.sheet('day-photos-sheet', {
      title: `${IC.cam} תמונות · יום ${day}`,
      sub: `${esc(dayTitle(day).replace(/^יום \d+ · /, ''))} · ${count(list.length)} · מתוך Google Drive`,
      cls: 'day-photos-card',
      html: `
        <div class="dp-grid">${list.map((p, i) => `
          <button type="button" class="dp-tile" data-i="${i}" aria-label="${esc(p.name || 'תמונה')}">
            <img alt="" loading="lazy" decoding="async" src="${esc(p.thumb)}" onerror="this.parentNode.classList.add('broken');this.remove()">
            ${clock(p) ? `<span class="dp-time" dir="ltr">${clock(p)}</span>` : ''}
          </button>`).join('')}
        </div>
        ${canAdd ? `<button type="button" class="btn btn-amber dp-add">${IC.drive}<span>הוספה מה-Google Drive</span></button>` : ''}
        <p class="dp-note">התמונות נשארות ב-Drive — כאן מוצג רק קישור אליהן. תמונה שתימחק מה-Drive תיעלם גם מכאן.</p>`,
      onOpen: (body) => {
        body.querySelectorAll('.dp-tile').forEach((b) => { b.onclick = () => openViewer(day, +b.dataset.i); });
        const add = body.querySelector('.dp-add');
        if (add) add.onclick = () => openPicker(day);
      },
    });
  }

  // ---- the picker: the traveller's own Drive, this day's pictures first ----

  function openPicker(day) {
    if (!canAdd) return;
    const chosen = new Set(ofDay(day).map((p) => p.file_id));
    const picked = new Set();
    let next = null;
    let query = '';
    TripPages.sheet('day-photos-sheet', {
      title: `${IC.drive} תמונות מה-Drive · יום ${day}`,
      sub: esc(dayTitle(day).replace(/^יום \d+ · /, '')),
      cls: 'day-photos-card dp-picker',
      html: `
        <form class="dp-search" role="search"><input type="search" class="dp-q" placeholder="חיפוש לפי שם קובץ" aria-label="חיפוש תמונות ב-Drive" enterkeyhint="search"></form>
        <div class="dp-results" aria-live="polite"><div class="dp-loading"><span class="dp-spin"></span> קוראים את ה-Drive…</div></div>
        <div class="dp-foot">
          <button type="button" class="btn btn-amber dp-confirm" disabled>בחרו תמונות</button>
          <p class="dp-note">רק קישור נשמר בטיול. התמונה עצמה נשארת ב-Drive שלכם.</p>
        </div>`,
      onOpen: (body) => {
        const results = body.querySelector('.dp-results');
        const confirm = body.querySelector('.dp-confirm');
        const sync = () => {
          confirm.disabled = !picked.size;
          confirm.textContent = picked.size ? `הוספה ליום ${day} (${picked.size})` : 'בחרו תמונות';
        };
        const tile = (p) => {
          const have = chosen.has(p.file_id);
          return `<button type="button" class="dp-tile dp-pick${have ? ' is-in' : ''}${picked.has(p.file_id) ? ' on' : ''}" data-file="${esc(p.file_id)}" ${have ? 'disabled' : ''}
              aria-pressed="${picked.has(p.file_id)}" aria-label="${esc(p.name)}${have ? ' — כבר ביום' : ''}">
              <img alt="" loading="lazy" decoding="async" src="${esc(p.thumb)}" onerror="this.parentNode.classList.add('broken');this.remove()">
              ${p.taken ? `<span class="dp-time" dir="ltr">${p.taken.slice(8, 10)}/${p.taken.slice(5, 7)} ${p.taken.slice(11, 16)}</span>` : ''}
              <span class="dp-check" aria-hidden="true">${IC.check}</span>
            </button>`;
        };
        const wireTiles = (box) => box.querySelectorAll('.dp-pick:not([data-w])').forEach((b) => {
          b.dataset.w = '1';
          b.onclick = () => {
            const id = b.dataset.file;
            if (picked.has(id)) picked.delete(id); else picked.add(id);
            b.classList.toggle('on', picked.has(id));
            b.setAttribute('aria-pressed', picked.has(id));
            sync();
          };
        });
        const fetchPage = async (more) => {
          const p = new URLSearchParams();
          const iso = isoOf(day);
          if (iso) p.set('date', iso);
          if (query) p.set('q', query);
          if (more && next) p.set('page', next);
          return TRIPMAKER.api(`/api/connectors/drive/photos?${p}`);
        };
        const paint = async () => {
          results.innerHTML = '<div class="dp-loading"><span class="dp-spin"></span> קוראים את ה-Drive…</div>';
          let r;
          try { r = await fetchPage(false); } catch (err) {
            results.innerHTML = `<p class="dp-empty">${esc(err.message || 'לא הצלחנו לקרוא את ה-Drive')}</p>`;
            return;
          }
          next = r.next;
          const day0 = r.day || [];
          const rest = r.recent || [];
          if (!day0.length && !rest.length) {
            results.innerHTML = `<p class="dp-empty">${query ? 'לא נמצאו תמונות בשם הזה ב-Drive' : 'אין תמונות ב-Google Drive שלכם עדיין'}</p>`;
            return;
          }
          results.innerHTML = `
            ${day0.length ? `<h4 class="dp-h">צולמו ביום הזה <small>${day0.length}</small></h4><div class="dp-grid">${day0.map(tile).join('')}</div>` : (isoOf(day) && !query ? '<p class="dp-hint">לא מצאנו ב-Drive תמונות שצולמו בתאריך הזה — הנה האחרונות שלכם.</p>' : '')}
            ${rest.length ? `<h4 class="dp-h">${day0.length ? 'עוד מה-Drive' : 'אחרונות ב-Drive'}</h4><div class="dp-grid dp-rest">${rest.map(tile).join('')}</div>` : ''}
            ${next ? '<button type="button" class="btn btn-ghost dp-more">עוד תמונות</button>' : ''}`;
          wireTiles(results);
          const moreBtn = results.querySelector('.dp-more');
          if (moreBtn) {
            moreBtn.onclick = async () => {
              moreBtn.disabled = true;
              try {
                const r2 = await fetchPage(true);
                next = r2.next;
                let grid = results.querySelector('.dp-rest');
                if (!grid) { grid = document.createElement('div'); grid.className = 'dp-grid dp-rest'; moreBtn.before(grid); }
                grid.insertAdjacentHTML('beforeend', (r2.recent || []).map(tile).join(''));
                wireTiles(grid);
                if (next) moreBtn.disabled = false; else moreBtn.remove();
              } catch { moreBtn.disabled = false; }
            };
          }
        };
        const form = body.querySelector('.dp-search');
        let t = null;
        const input = form.querySelector('input');
        input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { query = input.value.trim(); paint(); }, 450); });
        form.onsubmit = (e) => { e.preventDefault(); clearTimeout(t); query = input.value.trim(); paint(); input.blur(); };
        confirm.onclick = async () => {
          if (!picked.size) return;
          confirm.disabled = true;
          confirm.innerHTML = '<span class="dp-spin"></span> מוסיפים…';
          try {
            const r = await TRIPMAKER.api(`/api/trips/code/${encodeURIComponent(ctx.code)}/day-photos`, {
              method: 'POST', body: JSON.stringify({ day, files: [...picked] }),
            });
            TRIPMAKER.track?.('day_photos_added', { code: ctx.code, day, count: r.added });
            await load();
            TripPages.toast?.(`${count(r.added)} נוספו ליום ${day}`);
            openAlbum(day);
          } catch (err) {
            TripPages.toast?.(err.message || 'לא הצלחנו להוסיף');
            sync();
          }
        };
        paint();
      },
    });
  }

  // ---- the viewer: one picture at a time, swipe or arrows ----

  let viewer = null;
  function openViewer(day, index) {
    const list = ofDay(day);
    if (!list.length) return;
    let i = Math.min(Math.max(index || 0, 0), list.length - 1);
    closeViewer(true);
    const el = document.createElement('div');
    el.className = 'dp-viewer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', `תמונות של יום ${day}`);
    el.innerHTML = `
      <div class="dpv-top">
        <button type="button" class="dpv-btn dpv-close" aria-label="סגירה">${IC.close}</button>
        <span class="dpv-count" dir="ltr"></span>
        <span class="dpv-actions"></span>
      </div>
      <div class="dpv-stage"><img class="dpv-img" alt=""><span class="dp-spin dpv-spin"></span></div>
      <button type="button" class="dpv-btn dpv-nav dpv-prev" aria-label="הקודמת">${IC.prev}</button>
      <button type="button" class="dpv-btn dpv-nav dpv-next" aria-label="הבאה">${IC.next}</button>
      <div class="dpv-cap"></div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('dp-viewer-open');
    const img = el.querySelector('.dpv-img');
    const show = () => {
      const p = list[i];
      el.classList.add('loading');
      img.onload = () => el.classList.remove('loading');
      img.onerror = () => { el.classList.remove('loading'); if (img.src !== new URL(p.thumb, location.href).href) img.src = p.thumb; };
      img.src = p.full;
      img.alt = p.name || '';
      el.querySelector('.dpv-count').textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
      el.querySelector('.dpv-cap').innerHTML = `<b>${esc(dayTitle(day))}</b>${clock(p) ? ` · <span dir="ltr">${clock(p)}</span>` : ''}`;
      el.querySelector('.dpv-actions').innerHTML = `
        ${p.link ? `<a class="dpv-btn" href="${esc(p.link)}" target="_blank" rel="noopener" title="פתיחה ב-Google Drive" aria-label="פתיחה ב-Google Drive">${IC.drive}</a>` : ''}
        ${ctx.canEdit ? `<button type="button" class="dpv-btn dpv-remove" title="הסרה מהיום (נשארת ב-Drive)" aria-label="הסרה מהיום">${IC.trash}</button>` : ''}`;
      const rm = el.querySelector('.dpv-remove');
      if (rm) rm.onclick = () => remove(p);
      el.querySelector('.dpv-prev').hidden = i === 0;
      el.querySelector('.dpv-next').hidden = i === list.length - 1;
      // the next picture is fetched while this one is looked at
      if (list[i + 1]) { const pre = new Image(); pre.src = list[i + 1].full; }
    };
    const go = (d) => { const j = i + d; if (j < 0 || j >= list.length) return; i = j; show(); };
    const remove = async (p) => {
      if (!confirm('להסיר את התמונה מהיום? היא תישאר ב-Google Drive.')) return;
      try {
        await TRIPMAKER.api(`/api/trips/code/${encodeURIComponent(ctx.code)}/day-photos/${p.id}`, { method: 'DELETE' });
        photos = photos.filter((x) => x.id !== p.id);
        list.splice(list.indexOf(p), 1);
        ctx.onChange && ctx.onChange();
        if (!list.length) { closeViewer(); return; }
        i = Math.min(i, list.length - 1);
        show();
      } catch (err) { TripPages.toast?.(err.message || 'לא הצלחנו להסיר'); }
    };
    el.querySelector('.dpv-close').onclick = () => closeViewer();
    // RTL: the "previous" arrow sits on the right, the way the page reads
    el.querySelector('.dpv-prev').onclick = () => go(-1);
    el.querySelector('.dpv-next').onclick = () => go(1);
    el.querySelector('.dpv-stage').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeViewer(); });
    let x0 = null;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 50) go(dx > 0 ? 1 : -1); // RTL: a swipe to the right brings the next one
    });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); go(1); }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); go(-1); }
    };
    document.addEventListener('keydown', onKey, true);
    // the phone's back closes the picture, not the page under it
    history.pushState({ ...(history.state || {}), tripmakerPhoto: 1 }, '', location.href);
    const onPop = () => closeViewer(true);
    window.addEventListener('popstate', onPop);
    viewer = { el, onKey, onPop };
    show();
    el.querySelector('.dpv-close').focus();
  }
  function closeViewer(fromHistory) {
    if (!viewer) return;
    const { el, onKey, onPop } = viewer;
    viewer = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    el.remove();
    document.documentElement.classList.remove('dp-viewer-open');
    if (!fromHistory && history.state && history.state.tripmakerPhoto) history.back();
  }

  return { init, load, active, ofDay, stripHtml, panelHtml, wire, drawPins, openAlbum, openPicker, openViewer };
})();
