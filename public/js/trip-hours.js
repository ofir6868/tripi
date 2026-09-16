// The closed-door mark on the itinerary.
//
// The server decides (routes/hours.js, lib/opening-hours.js); this only draws. It is a
// decoration pass over cards that are already on the page rather than part of the card
// template, for two reasons: the itinerary must render at full speed without waiting on
// anyone else's server, and a check that fails — offline, blocked, nothing known about
// the place — has to leave the trip looking exactly as it did before.
//
// It marks the shut doors and says nothing about the open ones. A traveller who reads
// "פתוח" on eighty stops stops reading; the whole value here is that the one card
// carrying a warning is worth looking at.
const TripHours = (() => {
  let cache = null;    // the last answer for this trip
  let pending = null;  // one request in flight, however many renders ask for it

  async function load(code) {
    if (cache) return cache;
    if (pending) return pending;
    pending = fetch(`/api/trips/code/${encodeURIComponent(code)}/hours`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => { cache = data; pending = null; return data; });
    return pending;
  }

  // the itinerary changed, so the verdicts describe stops that may no longer be there
  function invalidate() { cache = null; }

  function chip(info) {
    const span = document.createElement('span');
    // A stop with no clock time was judged at noon, which is enough to tell "shut that
    // day" from "shut at that hour" but not enough to promise the second — so it says
    // the weaker thing it actually knows.
    span.className = 'item-shut' + (info.assumedNoon ? ' maybe' : '');
    span.textContent = info.assumedNoon ? '🚪 ייתכן שסגור' : '🚪 סגור';
    const why = [];
    if (info.tag) why.push(`שעות הפתיחה: ${info.tag}`);
    if (info.source === 'google') why.push('לפי גוגל');
    else if (info.source === 'osm') why.push('לפי OpenStreetMap');
    if (info.assumedNoon) why.push('לתחנה אין שעה — נבדק לפי צהריים');
    if (info.ignoresHolidays) why.push('לא כולל חגים');
    why.push('שווה לאמת לפני שיוצאים');
    span.title = why.join(' · ');
    return span;
  }

  // What the stop sheet reads. It is only ever populated by apply(), which both views
  // call on render, so by the time a sheet can be opened the answer is already here.
  function get(itemId) {
    return (cache && cache.stops && cache.stops[String(itemId)]) || null;
  }

  // The list view carries the id in data-item-id and the calendar in data-item, but both
  // draw through the same stopCardHtml and so both have a .sc-meta to hang this on.
  const CARDS = '.stop-card[data-item-id], .stop-card[data-item]';

  async function apply(container, code) {
    if (!container || !code) return;
    const data = await load(code);
    if (!data || !data.stops) return;

    container.querySelectorAll(CARDS).forEach((card) => {
      const info = data.stops[card.dataset.itemId || card.dataset.item];
      const existing = card.querySelector('.item-shut');
      if (!info || info.verdict !== 'closed') { if (existing) existing.remove(); return; }
      if (existing) return; // a repaint must not stack a second chip on the same card
      const badges = card.querySelector('.sc-meta');
      if (badges) badges.insertBefore(chip(info), badges.firstChild);
      card.classList.add('shut');
    });

    // The week view is seven columns of one-line stops and has no room for a chip with
    // words in it, so it gets the glyph alone. It is a pointer to the day view rather
    // than an explanation — which is what the rest of that view is too.
    container.querySelectorAll('.cal-wevt[data-item]').forEach((el) => {
      const info = data.stops[el.dataset.item];
      const existing = el.querySelector('.we-shut');
      if (!info || info.verdict !== 'closed') { if (existing) existing.remove(); el.classList.remove('shut'); return; }
      if (existing) return;
      const dot = document.createElement('span');
      dot.className = 'we-shut';
      dot.textContent = '🚪';
      dot.title = info.assumedNoon ? 'ייתכן שסגור בשעה הזו' : 'סגור בשעה הזו';
      el.insertBefore(dot, el.firstChild);
      el.classList.add('shut');
    });
  }

  return { apply, invalidate, get };
})();
