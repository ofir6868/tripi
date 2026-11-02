// The in-trip screen's reading of Google, with no network and no key (`npm test`).
//
// The part that must not drift is the kosher mark: a wrong "כשר" sends someone to eat
// somewhere because of it, so every case below is a sentence a real review could hold.
// Then the shape of a card and the order "most recommended" puts places in.
const K = require('../public/js/nearby-kinds');
const { shape, score } = require('../routes/nearby');

let bad = 0;
const check = (ok, what) => { if (!ok) { bad++; console.log('  ✗ ' + what); } };

// ---- kosher: evidence, and what only looks like it ----
const YES = [
  'Kosher Burger Bar',
  'Great glatt kosher steakhouse near the old town',
  'מסעדה כשרה ומעולה',
  'האוכל כשר למהדרין',
  'Chabad house serves shabbat dinner',
  'יש תעודת כשרות על הקיר',
  'וכשר, מה עוד צריך',
  'Restaurant casher à Paris',
];
const NO = [
  'Not kosher, but they have vegetarian options',
  'non-kosher seafood platter',
  'זה לא כשר אבל טעים',
  'צוות בעל כשרון רב',
  'הביאו מכשיר לתשלום',
  'עברו הכשרה מקצועית',
  'Lovely pasta and a great view',
  '',
];
for (const s of YES) check(K.mentionsKosher(s), `should read as kosher: "${s}"`);
for (const s of NO) check(!K.mentionsKosher(s), `should NOT read as kosher: "${s}"`);

// ---- cuisines: every chip resolves, and a place lands on the chip of its type ----
check(K.CUISINES.every((c) => c.key && c.label && c.types.length), 'every cuisine has a key, a label and types');
check((K.cuisineOf('sushi_restaurant', ['restaurant']) || {}).key === 'asian', 'sushi reads as the first chip that holds it');
check(K.matches('sushi', 'restaurant', ['sushi_restaurant']), 'a secondary type still matches its chip');
check(!K.matches('burgers', 'italian_restaurant', ['restaurant']), 'an Italian place is not a burger place');

// ---- shape: a Google answer becomes a card ----
const g = (over = {}) => ({
  id: 'ChIJ_test', displayName: { text: 'Trattoria Test' }, primaryType: 'italian_restaurant',
  primaryTypeDisplayName: { text: 'מסעדה איטלקית' }, types: ['italian_restaurant', 'restaurant'],
  rating: 4.6, userRatingCount: 1200, priceLevel: 'PRICE_LEVEL_MODERATE',
  location: { latitude: 41.9, longitude: 12.5 }, shortFormattedAddress: 'Via Test 1',
  photos: [{ name: 'places/ChIJ_test/photos/abc', authorAttributions: [{ displayName: 'Dana' }] }],
  reviews: [
    { rating: 5, text: { text: 'מעולה', languageCode: 'he' }, originalText: { text: 'מעולה', languageCode: 'iw' } },
    { rating: 4, text: { text: 'טוב מאוד', languageCode: 'he' }, originalText: { text: 'Very good', languageCode: 'en' } },
  ],
  ...over,
});
const c = shape(g());
check(c.name === 'Trattoria Test' && c.price === 2 && c.count === 1200, 'name, price level and count are read');
check(c.he === 1, 'only reviews written in Hebrew count as Hebrew (a translation does not)');
check(c.kosher === null, 'no evidence, no kosher mark');
check(c.photos.length === 1 && c.photos[0].ref && c.photos[0].credit === 'Dana', 'photo name and its author are kept');
const oneReview = g({ reviews: [{ rating: 5, text: { text: 'Kosher and tasty', languageCode: 'en' } }] });
check(shape(oneReview).kosher === null, 'one review mention is not enough on a general search');
check(shape(oneReview, { fromKosherSearch: true }).kosher === 'reviews', 'but it is when Google matched the place to "kosher"');
check(shape(g({ displayName: { text: 'Kosher Pizza Roma' } })).kosher === 'name', 'the name is evidence on its own');

// ---- score: many good ratings beat a few perfect ones; Hebrew reviews tip a tie ----
const s = (rating, count, he = 0) => score({ rating, count, he }, 40);
check(s(4.6, 3000) > s(5.0, 6), '4.6 from 3,000 outranks 5.0 from 6');
check(s(4.5, 800, 2) > s(4.5, 800, 0), 'Hebrew reviews lift an otherwise equal place');
check(s(4.8, 2000) > s(4.2, 2000, 3), 'but not over a clearly better-rated one');

// ---- a closed Google: what we already bought still answers (2026-11-02) ----
(async () => {
  const { cacheSet, meter, clock } = require('../lib/api-budget');
  const { fromCache, cellKey } = require('../routes/nearby');
  const cell = 0.02;
  const clat = Math.round(35.6895 / cell) * cell; // Tokyo
  const clon = Math.round(139.6917 / cell) * cell;
  check(await fromCache('sights', null, clat, clon) === null, 'nothing bought nearby, nothing to fall back to');
  await cacheSet('nearby.v1', cellKey('sights', null, clat + cell, clon - cell), [c]);
  const kept = await fromCache('sights', null, clat, clon);
  check(kept && kept[0].name === 'Trattoria Test', 'a neighbouring square\'s list answers when Google is closed');
  check(await fromCache('food', null, clat, clon) === null, 'but only for the same kind');
  await cacheSet('nearby.v1', cellKey('sights', null, clat, clon), []);
  check((await fromCache('sights', null, clat, clon) || [])[0] === c, 'an empty list here does not hide a full one next door');

  // ---- Wikipedia, when nothing was bought: places to visit, by how many read about them ----
  const { wikiPick } = require('../routes/nearby');
  const pg = (pageid, title, description, views, extra = {}) => ({
    pageid, title, description, coordinates: [{ lat: 35.71, lon: 139.79 }],
    pageviews: { '2026-10-01': views, '2026-10-02': null }, ...extra,
  });
  const picked = wikiPick([
    pg(1, 'Ueno Station', 'railway station in Tokyo, Japan', 90000),
    pg(2, 'Taitō', 'special ward of Tokyo, Japan', 80000),
    pg(3, 'Sensō-ji', 'Buddhist temple in Asakusa, Tokyo', 60000, { langlinks: [{ lang: 'he', title: 'סנסו-ג׳י' }], thumbnail: { source: 'https://upload.wikimedia.org/x/480px-a.jpg' } }),
    pg(4, 'Tokyo National Museum', 'art museum in Ueno Park', 40000),
    pg(5, 'Ueno Park', 'public park in Tokyo', 50000),
    pg(6, 'Asakusa Elementary School', 'school in Tokyo', 100),
    pg(7, 'Kappabashi', '', 9000),
  ]);
  check(picked.map((p) => p.id).join() === 'wiki:3,wiki:5,wiki:4', 'stations, wards and schools are not sights, and readers rank the rest: ' + picked.map((p) => p.id).join());
  check(picked[0].name === 'סנסו-ג׳י' && /he\.wikipedia/.test(picked[0].website), 'the Hebrew title and article are used when there is one');
  check(picked[0].photos.length === 1 && picked[0].views === 60000 && picked[0].rating === null, 'a photo, the readers, and no made-up rating');
  const few = wikiPick([pg(1, 'Ueno Station', 'railway station', 9), pg(7, 'Kappabashi', '', 9000), pg(8, 'Yanaka', '', 500)]);
  check(few.map((p) => p.id).join() === 'wiki:7,wiki:8', 'with too few sure sights, articles that are not plainly something else fill in');

  const m = meter('nearby_search');
  const want = clock.nextDayReset().toISOString();
  m.hold("Quota exceeded for limit 'SearchNearbyRequest per day'");
  check(m.reopensAt().toISOString() === want, 'Google\'s daily hold names midnight Pacific');
  m.hold('per minute'); // a shorter hold never shortens the daily one
  check(m.reopensAt().toISOString() === want, 'a per-minute 429 does not shorten the daily hold');

  console.log(bad ? `${bad} nearby check(s) failed` : 'nearby: kosher reading, cards, ranking and the closed-Google fallbacks hold');
  process.exit(bad ? 1 : 0);
})();
