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

  async function apply(container, code) {
    if (!container || !code) return;
    const data = await load(code);
    if (!data || !data.stops) return;
    container.querySelectorAll('.item-card[data-item-id]').forEach((card) => {
      const info = data.stops[card.dataset.itemId];
      const existing = card.querySelector('.item-shut');
      if (!info || info.verdict !== 'closed') { if (existing) existing.remove(); return; }
      if (existing) return; // a repaint must not stack a second chip on the same card
      const badges = card.querySelector('.item-badges');
      if (badges) badges.insertBefore(chip(info), badges.firstChild);
      card.classList.add('shut');
    });
  }

  return { apply, invalidate };
})();
