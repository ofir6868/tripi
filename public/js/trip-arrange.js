// Arrange mode — the iPhone home-screen gesture for stops. A long press on a stop
// card starts the mode: every card jiggles, and dragging one onto another swaps the
// two (day, hour and slot trade together), while dropping it on a day target — a
// day block in the list, a column in the week view, a chip in the day strip — moves
// it to that day. One mode instance for the whole page; the current view attaches
// its own cards/targets after every render, so the mode survives repaints.
//
// The long press only ENTERS the mode; dragging starts from the next touch. On the
// activating press the browser has already claimed the gesture for scrolling
// (touch-action is read at gesture start), so lifting the card mid-press works on
// mouse but dies with a pointercancel on touch — two presses is the honest gesture.
const TripArrange = (() => {
  const LONG_PRESS_MS = 450;
  const DRIFT_PX = 8; // finger drift a long-press survives; more than this is a scroll
  const state = { active: false };
  let doneBtn = null;
  let current = null; // { scope, opts } of the view rendered last

  function refresh() {
    if (!current) return;
    const cards = [...current.scope.querySelectorAll(current.opts.cards)];
    cards.forEach((el, i) => {
      el.classList.toggle('jiggle', state.active);
      // spread the wiggle phases so the cards don't dance in formation
      if (state.active) el.style.setProperty('--jd', `-${(i % 7) * 47}ms`);
    });
  }

  function activate() {
    if (state.active) return;
    state.active = true;
    if (navigator.vibrate) navigator.vibrate(12);
    document.body.classList.add('arrange-mode');
    doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn btn-amber arrange-done';
    doneBtn.textContent = '✓ סיום סידור';
    doneBtn.onclick = deactivate;
    document.body.appendChild(doneBtn);
    refresh();
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    document.body.classList.remove('arrange-mode');
    if (doneBtn) { doneBtn.remove(); doneBtn = null; }
    refresh();
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') deactivate(); });

  function clearHints() {
    document.querySelectorAll('.drop-hint').forEach((n) => n.classList.remove('drop-hint'));
  }

  function startDrag(card, opts, id, pointerId, x0, y0) {
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('jiggle');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    card.classList.add('drag-src');
    if (card.setPointerCapture) try { card.setPointerCapture(pointerId); } catch { /* gone mid-gesture */ }

    document.body.classList.add('dragging'); // the done button must not eat the drop

    let target = null; // { kind: 'card', id } | { kind: 'day', day }
    // dragging against the viewport edge scrolls the page, iPhone-style — without
    // this, a stop can never travel further than one screenful
    let scrollDir = 0;
    let scrollRaf = 0;
    const autoScroll = () => {
      if (!scrollDir) { scrollRaf = 0; return; }
      // 'instant', explicitly: the page css sets scroll-behavior smooth, and a smooth
      // scroll restarted every frame animates nowhere at all
      window.scrollBy({ top: scrollDir, left: 0, behavior: 'instant' });
      scrollRaf = requestAnimationFrame(autoScroll);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
      const EDGE = 80;
      scrollDir = ev.clientY < EDGE ? -14 : ev.clientY > innerHeight - EDGE ? 14 : 0;
      if (scrollDir && !scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
      // the ghost ignores pointer events, so this reads what's underneath it
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      clearHints();
      target = null;
      if (!under) return;
      const overCard = under.closest(opts.cards);
      if (overCard && overCard !== card && opts.idOf(overCard)) {
        target = { kind: 'card', id: opts.idOf(overCard) };
        overCard.classList.add('drop-hint');
        return;
      }
      for (const z of opts.dayTargets || []) {
        const zone = under.closest(z.selector);
        if (!zone) continue;
        const day = z.getDay(zone);
        if (day != null && !Number.isNaN(day)) {
          target = { kind: 'day', day };
          zone.classList.add('drop-hint');
        }
        return;
      }
    };
    const finish = async (ev) => {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      scrollDir = 0;
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      document.body.classList.remove('dragging');
      ghost.remove();
      card.classList.remove('drag-src');
      const t = target;
      clearHints();
      if (ev.type === 'pointercancel' || !t) return;
      try {
        if (t.kind === 'card') await opts.swap(id, t.id);
        else if (opts.moveToDay) await opts.moveToDay(id, t.day);
      } catch (err) {
        alert(err.message || 'ההזזה נכשלה — נסו שוב');
      }
    };
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  function bindCard(card, opts) {
    const id = opts.idOf(card);
    if (!id) return;
    card.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const x0 = e.clientX, y0 = e.clientY;
      if (state.active) { startDrag(card, opts, id, e.pointerId, x0, y0); return; }
      // a still press this long is the enter gesture; drift means scrolling. A mouse
      // press gets the full iPhone move — enter AND lift in one hold — because no
      // scroll gesture competes for it.
      const timer = setTimeout(() => {
        cleanup();
        activate();
        if (e.pointerType === 'mouse') startDrag(card, opts, id, e.pointerId, x0, y0);
      }, LONG_PRESS_MS);
      const onMove = (ev) => {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > DRIFT_PX) cleanup();
      };
      const cleanup = () => {
        clearTimeout(timer);
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', cleanup);
        card.removeEventListener('pointercancel', cleanup);
      };
      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', cleanup);
      card.addEventListener('pointercancel', cleanup);
    });
  }

  // A view calls this after every render. opts:
  //   cards      selector for the draggable stop cards
  //   idOf(el)   card element → item id
  //   swap(aId, bId)      persist an a↔b swap
  //   moveToDay(id, day)  persist a move (optional)
  //   dayTargets [{ selector, getDay(el) }] drop surfaces that mean a day (optional)
  function attach(scope, opts) {
    if (!opts.canEdit) return;
    current = { scope, opts };
    scope.querySelectorAll(opts.cards).forEach((el) => bindCard(el, opts));
    // while arranging, taps on a CARD must not open the stop sheet, vote, or delete —
    // the capture phase eats them before any view handler sees them. Only card taps:
    // navigation (view toggle, week arrows, day strip) keeps working mid-jiggle,
    // exactly like the iPhone home screen keeps paging while icons wiggle.
    if (!scope.arrangeSwallowBound) {
      scope.arrangeSwallowBound = true;
      scope.addEventListener('click', (e) => {
        if (state.active && current && e.target.closest(current.opts.cards)) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
    }
    refresh();
  }

  return { attach, deactivate, isActive: () => state.active };
})();
