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

console.log(bad ? `${bad} nearby check(s) failed` : 'nearby: kosher reading, cards and ranking hold');
process.exit(bad ? 1 : 0);
