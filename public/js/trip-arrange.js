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
    // the bin: a fixed strip across the top of the screen, there only while a
    // card is in the air — carrying a stop up to it deletes the stop (after the
    // same confirm the trash buttons ask for). Hit-tested by geometry like the
    // day containers, so it never intercepts the pointer itself.
    let trash = null;
    let overTrash = false;
    if (opts.deleteStop) {
      trash = document.createElement('div');
      trash.className = 'arrange-trash';
      trash.setAttribute('aria-hidden', 'true');
      trash.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg><span>גררו לכאן למחיקת התחנה</span>';
      document.body.appendChild(trash);
    }
    const setOverTrash = (on) => {
      if (on === overTrash) return;
      overTrash = on;
      trash.classList.toggle('hot', on);
      ghost.classList.toggle('over-trash', on);
      if (on && navigator.vibrate) navigator.vibrate(8);
    };

    let chipDay = null; // fallback surface (the day strip) — no live preview there
    // dragging against the viewport edge scrolls the page, iPhone-style — without
    // this, a stop can never travel further than one screenful. Every scrolled frame
    // re-places the placeholder too: while the finger holds still at the edge, the
    // list is what moves, and no pointermove will ever fire to say so.
    let scrollDir = 0;
    let scrollRaf = 0;
    const autoScroll = () => {
      if (!scrollDir) { scrollRaf = 0; return; }
      // 'instant', explicitly: the page css sets scroll-behavior smooth, and a smooth
      // scroll restarted every frame animates nowhere at all
      window.scrollBy({ top: scrollDir, left: 0, behavior: 'instant' });
      evaluate();
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

    // one placement pass, run at most once a frame from wherever the pointer last
    // was — fast sweeps coalesce into single clean flips instead of a thrash
    let lastX = x0, lastY = y0;
    const evaluate = () => {
      clearHints();
      chipDay = null;
      if (trash) {
        const r = trash.getBoundingClientRect();
        const inBin = lastX >= r.left && lastX <= r.right && lastY <= r.bottom + 6;
        setOverTrash(inBin);
        if (inBin) return; // the placeholder stays put — nothing to preview for a delete
      }
      // NEAREST container, not strict containment: a fast drag spends half its life
      // over the gaps between days (headers, margins), and a placeholder that stops
      // updating there is the "floating card, nothing moves" bug
      let hit = null;
      let best = Infinity;
      for (const c of containers) {
        const r = c.getBoundingClientRect();
        const dx = lastX < r.left ? r.left - lastX : lastX > r.right ? lastX - r.right : 0;
        const dy = lastY < r.top ? r.top - lastY : lastY > r.bottom ? lastY - r.bottom : 0;
        const dist = dx + dy;
        if (dist < best) { best = dist; hit = c; }
      }
      const placeAt = (container) => {
        const others = [...container.querySelectorAll(opts.cards)].filter((el) => el !== card);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          const { top, height } = layoutTop(others[i]);
          if (lastY < top + height / 2) { idx = i; break; }
        }
        if (container === lastContainer && idx === lastIdx) return; // settled — no churn
        lastContainer = container;
        lastIdx = idx;
        // anchor: the card that should follow the placeholder; past the last card,
        // land right after it (in front of trailing furniture like the add button)
        const anchor = others[idx] || (others.length ? others[others.length - 1].nextSibling : container.firstChild);
        flipMove(scope, opts.cards, () => container.insertBefore(card, anchor));
      };

      // priority: right at a day's cards → live placement; an explicit drop surface
      // (strip chip, day/column header) → plain move; anywhere loosely near a day →
      // live placement again, so the gaps a fast drag crosses never go dead
      if (hit && best <= 40) { placeAt(hit); return; }
      const under = document.elementFromPoint(lastX, lastY);
      for (const z of (under ? opts.dayTargets || [] : [])) {
        const zone = under.closest(z.selector);
        if (!zone) continue;
        const day = z.getDay(zone);
        if (day != null && !Number.isNaN(day)) {
          chipDay = day;
          zone.classList.add('drop-hint');
          return;
        }
      }
      if (hit && best <= 140) placeAt(hit);
    };

    // time-based coalescing, not rAF: placement caps at one pass per 16ms with a
    // trailing call for the last position — a 120Hz touch stream halves, and the
    // math never starves in environments where frames are throttled
    let evalTimer = 0;
    let lastEval = 0;
    const requestEvaluate = () => {
      const wait = 16 - (performance.now() - lastEval);
      if (wait <= 0) { lastEval = performance.now(); evaluate(); }
      else if (!evalTimer) evalTimer = setTimeout(() => { evalTimer = 0; lastEval = performance.now(); evaluate(); }, wait);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      lastX = ev.clientX;
      lastY = ev.clientY;
      ghost.style.transform = `translate(${lastX - x0}px, ${lastY - y0}px)`;
      const EDGE = 80;
      scrollDir = lastY < EDGE ? -14 : lastY > innerHeight - EDGE ? 14 : 0;
      if (trash && lastY <= trash.getBoundingClientRect().bottom + 6) scrollDir = 0;
      if (scrollDir && !scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
      requestEvaluate();
    };

    const finish = async (ev) => {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      scrollDir = 0;
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (evalTimer) clearTimeout(evalTimer);
      document.body.classList.remove('dragging');
      ghost.remove();
      if (trash) trash.remove();
      card.classList.remove('drag-src');
      const chip = chipDay;
      const binned = overTrash && ev.type !== 'pointercancel';
      clearHints();
      refresh();
      try {
        if (ev.type === 'pointercancel') opts.rerender(); // undo the preview
        else if (binned) {
          // a drop in the bin, declined, is just a cancelled drag
          if (confirm('למחוק את התחנה?')) await opts.deleteStop(id);
          else opts.rerender();
        }
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
  //   deleteStop(id)      delete a stop dropped in the bin at the top (optional —
  //                       the bin only appears when a view provides this)
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
