// Arrange mode — the iPhone home-screen gesture for stops. A long press on a stop
// card starts the mode: every card jiggles, and dragging lifts the card while a
// dashed placeholder marks its slot. The other stops are pushed aside LIVE as the
// ghost moves over them (Jira/iPhone style) — across days too — and the drop commits
// exactly the arrangement on screen: each affected day keeps its set of hours and
// deals them back to its stops in the new order, so the schedule's shape stays put
// and only the content moves. One mode instance for the whole page; the current view
// attaches its own cards/containers after every render, so the mode survives repaints.
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

  // FLIP: run a DOM mutation, then let every card glide from where it was to where
  // it ended up. The jiggle is suspended while dragging (.dragging), so the
  // transform channel is free for these slides.
  function flipMove(scope, cardsSel, mutate) {
    const cards = [...scope.querySelectorAll(cardsSel)];
    const before = new Map(cards.map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    for (const el of cards) {
      const b = before.get(el);
      if (!b) continue;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (!dx && !dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform .15s ease';
        el.style.transform = '';
      });
    }
  }

  function clearHints() {
    document.querySelectorAll('.drop-hint').forEach((n) => n.classList.remove('drop-hint'));
  }

  function startDrag(card, opts, id, pointerId, x0, y0) {
    const scope = current.scope;
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('jiggle');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    // the card itself becomes the dashed placeholder and is MOVED through the DOM
    // as the live preview — on drop, the DOM order IS the new arrangement
    card.classList.add('drag-src');
    document.body.classList.add('dragging');
    if (card.setPointerCapture) try { card.setPointerCapture(pointerId); } catch { /* gone mid-gesture */ }

    let chipDay = null; // fallback surface (the day strip) — no live preview there
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

    // Placement is computed from GEOMETRY, never from elementFromPoint over the
    // cards: while a FLIP slide is running, the element under the pointer is a card
    // mid-flight, and chasing it re-triggers moves that re-trigger slides — the
    // oscillating, incoherent drag this replaced. Instead: hit-test the CONTAINERS
    // (they never animate), and pick the insertion index by comparing the pointer to
    // each card's layout midpoint with its in-flight transform subtracted out. The
    // placeholder only moves when that index actually changes.
    const containers = opts.containers ? [...scope.querySelectorAll(opts.containers)] : [];
    const layoutTop = (el) => {
      const r = el.getBoundingClientRect();
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = new DOMMatrixReadOnly(t);
        return { top: r.top - m.m42, height: r.height };
      }
      return { top: r.top, height: r.height };
    };
    let lastContainer = card.parentElement;
    // the placeholder's starting index = how many sibling cards precede it
    let lastIdx = [...lastContainer.querySelectorAll(opts.cards)]
      .filter((el) => el !== card)
      .filter((el) => el.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
      .length;

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
      const EDGE = 80;
      scrollDir = ev.clientY < EDGE ? -14 : ev.clientY > innerHeight - EDGE ? 14 : 0;
      if (scrollDir && !scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
      clearHints();
      chipDay = null;

      let hit = null;
      for (const c of containers) {
        const r = c.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 8 && ev.clientY <= r.bottom + 8) { hit = c; break; }
      }
      if (hit) {
        const others = [...hit.querySelectorAll(opts.cards)].filter((el) => el !== card);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          const { top, height } = layoutTop(others[i]);
          if (ev.clientY < top + height / 2) { idx = i; break; }
        }
        if (hit === lastContainer && idx === lastIdx) return; // settled — no churn
        lastContainer = hit;
        lastIdx = idx;
        // anchor: the card that should follow the placeholder; past the last card,
        // land right after it (in front of trailing furniture like the add button)
        const anchor = others[idx] || (others.length ? others[others.length - 1].nextSibling : hit.firstChild);
        flipMove(scope, opts.cards, () => hit.insertBefore(card, anchor));
        return;
      }
      // outside every container: the placeholder stays where it is; a day chip or
      // header may still take the drop as a plain move
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!under) return;
      for (const z of opts.dayTargets || []) {
        const zone = under.closest(z.selector);
        if (!zone) continue;
        const day = z.getDay(zone);
        if (day != null && !Number.isNaN(day)) {
          chipDay = day;
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
      const chip = chipDay;
      clearHints();
      refresh();
      try {
        if (ev.type === 'pointercancel') opts.rerender(); // undo the preview
        else if (chip != null && opts.moveToDay) await opts.moveToDay(id, chip);
        else if (opts.containers) {
          // the DOM as arranged is the truth — hand each visible day's order back
          const layout = [...scope.querySelectorAll(opts.containers)].map((c) => ({
            day: opts.dayOf(c),
            ids: [...c.querySelectorAll(opts.cards)].map((el) => opts.idOf(el)).filter(Boolean),
          })).filter((l) => l.day != null && !Number.isNaN(l.day));
          await opts.commit(layout);
        }
      } catch (err) {
        opts.rerender();
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
  //   cards       selector for the draggable stop cards
  //   idOf(el)    card element → item id
  //   containers  selector for a day's card container (the live-preview surfaces)
  //   dayOf(el)   container element → day number
  //   commit(layout)      persist [{day, ids-in-visual-order}] — the dealt-hours rule
  //   moveToDay(id, day)  fallback for dayTargets (optional)
  //   dayTargets  [{ selector, getDay(el) }] drop surfaces with no live preview
  //   rerender()  repaint the view (drag cancelled or commit failed)
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
