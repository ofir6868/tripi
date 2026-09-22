// The road between stops, drawn on the itinerary — and the stops it puts out of reach.
//
// A decoration pass over cards already on the page, like trip-hours.js: the itinerary
// renders at full speed, the routing (OSRM, via GEO.routeLegs) lands afterwards, and a
// router that does not answer leaves the trip looking exactly as it did. It draws three
// things:
//
//   the leg      "🚗 25 דק׳ · 12 ק״מ" under a card, when the drive is worth a row;
//   the load     a chip on the day's header once the day holds three hours behind the wheel;
//   the mark     "⏱ לא מספיקים" on a stop whose written hour comes before anyone can be
//                there — judged by public/js/travel-rules.js, the same rule the build
//                corrects by (lib/travel-fit.js), so a stop added by hand or an hour changed
//                by hand gets the same verdict a built one would have. For an editor the
//                mark is the fix: one tap moves the stop to the first hour it can be reached.
//
// Works in the list view and in the calendar's day view, which are the two places a day is
// laid out as a sequence; the week and month grids have no room for a road.
const TripTravel = (() => {
  const carIcon = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>';
  const fmtDrive = (min) => (min < 60 ? `${min} דק׳` : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} שע׳`);
  const CARDS = '.stop-card[data-item-id], .stop-card[data-item]';
  const idOf = (card) => +(card.dataset.itemId || card.dataset.item);

  // every laid-out day in the container: the list's timelines, or the calendar's one day
  function dayGroups(container) {
    return [...container.querySelectorAll('.day-block .timeline, .cal-day-list')].map((list) => ({
      list,
      cards: [...list.querySelectorAll(CARDS)],
      header: list.closest('.day-block')?.querySelector('.day-title') || container.querySelector('.cal-day-head'),
    }));
  }
  const cardFor = (g, id) => g.list.querySelector(`.stop-card[data-item-id="${id}"], .stop-card[data-item="${id}"]`);

  // consecutive stops with coordinates — a coordless stop breaks the chain
  function locatedRuns(stops) {
    const runs = [];
    let run = [];
    for (const it of stops) {
      if (it.lat != null && it.lon != null) run.push(it);
      else { if (run.length > 1) runs.push(run); run = []; }
    }
    if (run.length > 1) runs.push(run);
    return runs;
  }

  function mark(card, info, ctx) {
    if (!card || card.querySelector('.item-tight')) return; // a repaint must not stack a second chip
    const badges = card.querySelector('.sc-meta');
    if (!badges) return;
    const fixable = !!info.to && ctx.canEdit && typeof ctx.saveItem === 'function';
    const el = document.createElement(fixable ? 'button' : 'span');
    if (fixable) el.type = 'button';
    el.className = 'item-tight' + (fixable ? ' fixable' : '');
    el.textContent = fixable ? `⏱ להזיז ל־${info.to}` : '⏱ לא מספיקים';
    const why = [`${info.travel} דק׳ נסיעה מ־${info.prevId.title}, ועוד לפחות ${info.stay} דק׳ שם`];
    if (info.to) why.push(fixable ? `לחיצה מזיזה את התחנה ל־${info.to}` : `מגיעים הכי מוקדם ב־${info.to}`);
    else if (info.reason === 'past the next stop') why.push(`מגיעים הכי מוקדם ב־${info.earliest} — אחרי התחנה הבאה (${info.ceiling})`);
    else why.push(`מגיעים הכי מוקדם ב־${info.earliest} — כבר לא היום`);
    el.title = why.join(' · ');
    if (fixable) {
      el.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation(); // the card itself opens the stop sheet
        el.disabled = true;
        ctx.saveItem(info.id, { time_label: info.to }).catch(() => { el.disabled = false; });
      };
    }
    badges.insertBefore(el, badges.firstChild);
    card.classList.add('tight');
  }

  // ctx: { items, canEdit, saveItem(item, patch) }
  async function apply(container, ctx) {
    if (!container || !ctx || !Array.isArray(ctx.items) || typeof GEO === 'undefined') return;
    const byId = new Map(ctx.items.map((it) => [it.id, it]));
    for (const g of dayGroups(container)) {
      const stops = g.cards.map((c) => byId.get(idOf(c))).filter(Boolean);
      const runs = locatedRuns(stops);
      if (!runs.length) continue;
      let totalMin = 0;
      await Promise.all(runs.map(async (r) => {
        const legs = await GEO.routeLegs(r).catch(() => null);
        if (!legs || !g.list.isConnected) return; // the list may have re-rendered since this began
        legs.forEach((leg, i) => {
          totalMin += leg.minutes;
          if (leg.minutes < TRAVEL_RULES.MIN_LEG_MINUTES) return; // a hop across the street isn't worth a row
          const card = cardFor(g, r[i].id);
          if (!card || card.nextElementSibling?.classList.contains('travel-leg')) return;
          const el = document.createElement('div');
          el.className = 'travel-leg';
          el.innerHTML = `${carIcon} ${fmtDrive(leg.minutes)} · ${leg.km} ק״מ`;
          card.insertAdjacentElement('afterend', el);
        });
        const { moves, tight } = TRAVEL_RULES.fitDay(
          r.map((it) => ({ id: it, time: it.time_label, category: it.category })), legs
        );
        for (const m of moves) mark(cardFor(g, m.id.id), m, ctx);
        for (const t of tight) mark(cardFor(g, t.id.id), t, ctx);
      }));
      // three hours behind the wheel is where a day out becomes a road day
      if (totalMin >= 180 && g.header && !g.header.querySelector('.day-load')) {
        const chip = document.createElement('span');
        chip.className = 'day-load';
        chip.title = 'יום עמוס בנסיעות — אולי שווה לפצל אותו';
        chip.innerHTML = `${carIcon} ${fmtDrive(totalMin)} נסיעה`;
        g.header.appendChild(chip);
      }
    }
  }

  return { apply };
})();
