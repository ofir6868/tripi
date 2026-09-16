// A stop's photo, on its card's tile.
//
// The server decides which stops have a photo we can vouch for (routes/photos.js,
// lib/stop-photos.js); this only draws. Like the closed-door mark (trip-hours.js) it is a
// pass over cards that already exist, not part of the card template: the itinerary
// renders at full speed without waiting on Wikimedia or Google, and a stop with no photo
// — or a photo that fails to load — keeps exactly the emoji tile it had.
const TripPhotos = (() => {
  let cache = null;    // { stops } — the last answer for this trip
  let pending = null;  // one request in flight, however many renders ask for it

  async function load(code) {
    if (cache) return cache;
    if (pending) return pending;
    pending = fetch(`/api/trips/code/${encodeURIComponent(code)}/photos`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => { cache = data; pending = null; return data; });
    return pending;
  }

  // a stop was added or its place changed — ask again (the server answers from its cache)
  function invalidate() { cache = null; }

  // the photo we hold for a stop, if the answer is already in — for the stop sheet
  const get = (id) => (cache && cache.stops && cache.stops[id]) || null;

  function paint(tile, photo) {
    if (tile.querySelector('img')) return; // a repaint must not stack a second image
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    // shown only once it has actually arrived: until then, and forever if it never does,
    // the emoji underneath is the tile
    img.onload = () => tile.classList.add('has-photo');
    img.onerror = () => img.remove();
    img.src = photo.url;
    tile.appendChild(img);
    if (photo.credit) tile.title = `📷 ${photo.credit}`;
  }

  async function apply(container, code) {
    if (!container || !code) return;
    const data = await load(code);
    if (!data || !data.stops) return;
    container.querySelectorAll('.sc-media[data-photo-stop]').forEach((tile) => {
      const photo = data.stops[tile.dataset.photoStop];
      if (photo && photo.url) paint(tile, photo);
    });
  }

  return { apply, invalidate, get, load };
})();
