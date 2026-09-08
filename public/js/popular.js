// The popular strip under the homepage search: a short, hand-picked list — the
// places Israelis actually type into the box, plus the classic multi-country
// routes ("the big trip", South America) that no single destination name covers.
//
// One list for two pages: the homepage draws the tiles from it, and the wizard
// resolves a combo id (/plan?combo=east) back into the same destinations — so the
// countries on the tile are exactly the chips that land in the wizard. Names and
// country codes are the ones the destination index (destinations.js) and the
// country table (countries.js) already use; a name spelled differently here would
// lose its flag and, on the server, its country check.
//
// Every photo id below is one that already ships elsewhere in the app (the
// destination guides, the cover pool) — each was eyeballed against its place once,
// and reusing them keeps the strip from ever showing a wrong landmark.
const POPULAR = (() => {
  const IMG = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=360&h=240&q=70`;

  // singles: the tile opens the wizard with this one chip. `country` only for
  // cities — for a country the name is the country.
  const SINGLES = [
    { name: 'רומא', cc: 'it', country: 'איטליה', img: IMG('photo-1552832230-c0197dd311b5') },
    { name: 'יוון', cc: 'gr', img: IMG('photo-1613395877344-13d4a8e0d49e') },
    { name: 'ברצלונה', cc: 'es', country: 'ספרד', img: IMG('photo-1583422409516-2895a77efded') },
    { name: 'ליסבון', cc: 'pt', country: 'פורטוגל', img: IMG('photo-1585208798174-6cedd86e019a') },
    { name: 'לונדון', cc: 'gb', country: 'בריטניה', img: IMG('photo-1513635269975-59663e0ac1ad') },
    { name: 'פראג', cc: 'cz', country: "צ'כיה", img: IMG('photo-1541849546-216549ae216d') },
    { name: 'בודפשט', cc: 'hu', country: 'הונגריה', img: IMG('photo-1541343672885-9be56236302a') },
    { name: 'דובאי', cc: 'ae', country: 'איחוד האמירויות', img: IMG('photo-1512453979798-5ea266f8880c') },
    { name: 'תאילנד', cc: 'th', img: IMG('photo-1552465011-b4e21bf6e79a') },
    { name: 'יפן', cc: 'jp', img: IMG('photo-1540959733332-eab4deabeeaf') },
    { name: 'גאורגיה', cc: 'ge', img: IMG('photo-1565008447742-97f6f38c985c') },
    { name: 'קפריסין', cc: 'cy', img: IMG('photo-1601581875039-e899893d520c') },
  ];

  // combos: several countries in one trip. `days` is the wizard's starting length
  // (the traveller changes it on step 2). The planning chat spots a multi-country
  // trip on its own and plans it step by step, one country at a time — nothing
  // here needs to tell it.
  const COMBOS = [
    {
      id: 'east', title: 'הטיול הגדול במזרח', days: 30,
      dests: [{ name: 'תאילנד', cc: 'th' }, { name: 'לאוס', cc: 'la' }, { name: 'וייטנאם', cc: 'vn' }],
      img: IMG('photo-1528127269322-539801943592'),
    },
    {
      id: 'south-america', title: 'דרום אמריקה', days: 30,
      dests: [{ name: 'פרו', cc: 'pe' }, { name: 'בוליביה', cc: 'bo' }, { name: 'ארגנטינה', cc: 'ar' }],
      img: IMG('photo-1526392060635-9d6019884377'),
    },
  ];

  const countryOf = (d) => d.country || d.name;
  const combo = (id) => COMBOS.find((c) => c.id === id) || null;

  return {
    singles: SINGLES,
    combos: COMBOS,
    combo,
    countryOf,
    // the chips a tile puts in the wizard — the same shape the wizard's own
    // autocomplete produces, coordinates left for the geocoder
    chips: (dests) => dests.map((d) => ({ name: d.name, country: countryOf(d), cc: d.cc, lat: null, lon: null })),
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = POPULAR;
