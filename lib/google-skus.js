// Every Google Places call this codebase makes, in one place: what Google bills it as,
// how much of it is free, where we stop, and what the traveller gets instead once we do.
//
// This table is the definition the rest is built on — the meters in lib/api-budget.js are
// created from it, the admin page (/admin/google) renders it, and the numbers in it are
// Google's, checked against the pricing pages on 2026-09-16:
//   https://developers.google.com/maps/billing-and-pricing/pricing
//   https://developers.google.com/maps/billing-and-pricing/sku-details
//
// Three facts from those pages decide how everything downstream counts:
//
//   1. A SKU bills a *successful* request ("Billable event: Successful request for …").
//      A 400, a 403, a 429 at the quota gate, a 500 — none of them is on the invoice, so
//      every one of them gives its claim back. A timeout is the exception: Google may
//      well have answered and billed after we stopped listening, so it stays counted.
//   2. The free usage "resets on the first day of each month, at midnight Pacific US
//      time" — not UTC. A meter keyed by the UTC month starts a new month up to eight
//      hours before Google does, and spends the new allowance on the old invoice.
//   3. The free usage is per SKU per *billing account*, shared by every project on it.
//      Our counter only sees this app, so the limits below sit under the free tier with
//      room for anything else on the same account.
//
// The SKU a request bills as is decided by the most expensive field in its field mask,
// so the mask and the `sku` line below must change together. `method` is the API method
// the request goes to — the name Google's per-method quotas and Cloud Monitoring use,
// and the level the reconciliation on the admin page compares at.

const GOOGLE_METHOD = {
  GetPlace: 'google.maps.places.v1.Places.GetPlace',
  SearchText: 'google.maps.places.v1.Places.SearchText',
  AutocompletePlaces: 'google.maps.places.v1.Places.AutocompletePlaces',
  GetPhotoMedia: 'google.maps.places.v1.Places.GetPhotoMedia',
};

// The per-day quotas set in Cloud Console (Google Maps Platform → Quotas → Places API
// (New)), as of 2026-09-16. They live over there, not here — this is a copy, so the admin
// page can put today's calls next to the ceiling Google will enforce, and it has to be
// changed together with the console. Google resets them at midnight Pacific, the same
// clock the meters run on.
//
// Each is (free a month) ÷ 31 or under, so even a day-after-day run at the ceiling cannot
// leave the free tier — except GetPlace, which three SKUs share (photo lookups: free;
// picker coordinates: 10,000 free; opening hours: 1,000 free). A daily quota cannot tell
// them apart, so the one that protects the Enterprise hours allowance is the place_hours
// meter, not this number.
const CONSOLE_DAILY_QUOTA = {
  GetPlace: 100,
  SearchText: 150,
  AutocompletePlaces: 300,
  GetPhotoMedia: 30,
};

const SKUS = [
  {
    meter: 'place_photo',
    method: 'GetPhotoMedia',
    sku: 'Place Details Photos',
    tier: 'Enterprise',
    free: 1000,
    pricePer1k: 7,
    limit: 900,
    env: 'PLACE_PHOTO_MONTHLY_LIMIT',
    scopes: ['place_photo'],
    what: 'תמונה אמיתית של המקום בכרטיסי ההמלצות',
    fallback: 'תמונה מוויקיפדיה, ואם אין — תמונת היעד',
    where: 'lib/place-photos.js',
  },
  {
    meter: 'place_photo_ref',
    method: 'GetPlace',
    sku: 'Place Details Essentials (IDs Only)',
    tier: 'Essentials',
    free: null, // unlimited — counted so the GetPlace quota adds up, never capped
    pricePer1k: 0,
    limit: null,
    env: null,
    scopes: ['place_photo_ref'],
    what: 'איתור התמונה של המקום (fields=photos), לפני הורדתה',
    fallback: '—',
    where: 'lib/place-photos.js',
  },
  {
    meter: 'place_hours',
    method: 'GetPlace',
    sku: 'Place Details Enterprise',
    tier: 'Enterprise',
    free: 1000,
    pricePer1k: 20,
    limit: 900,
    env: 'PLACE_HOURS_MONTHLY_LIMIT',
    scopes: ['google_hours'],
    what: 'שעות פתיחה לתחנות ש-OpenStreetMap לא יודע עליהן',
    fallback: 'בלי סימון "סגור" לתחנות האלה',
    where: 'lib/opening-hours.js',
  },
  {
    meter: 'places_details',
    method: 'GetPlace',
    sku: 'Place Details Essentials',
    tier: 'Essentials',
    free: 10000,
    pricePer1k: 5,
    limit: 5000,
    env: 'PLACES_DETAILS_MONTHLY_LIMIT',
    scopes: ['places_detail'],
    what: 'קואורדינטות למקום שנבחר בבוחר המקומות',
    fallback: 'הבוחר עובר ל-Photon (OpenStreetMap)',
    where: 'routes/places.js',
  },
  {
    meter: 'places_autocomplete',
    method: 'AutocompletePlaces',
    sku: 'Autocomplete Requests',
    tier: 'Essentials',
    free: 10000,
    pricePer1k: 2.83,
    limit: 4000,
    env: 'PLACES_AUTOCOMPLETE_MONTHLY_LIMIT',
    scopes: ['places_ac'],
    what: 'השלמה אוטומטית בבוחר המקומות (בלי session token — כל הקלדה נספרת)',
    fallback: 'הבוחר עובר ל-Photon (OpenStreetMap)',
    where: 'routes/places.js',
  },
  {
    meter: 'place_search',
    method: 'SearchText',
    sku: 'Text Search Pro',
    tier: 'Pro',
    free: 5000,
    pricePer1k: 32,
    limit: 4000,
    env: 'PLACE_SEARCH_MONTHLY_LIMIT',
    scopes: ['place_search.v1'],
    what: 'דעה שנייה על מקום שה-AI הציע, כש-OpenStreetMap לא מכיר אותו',
    fallback: 'האימות נשען על OpenStreetMap בלבד',
    where: 'lib/places.js',
  },
];

const byMeter = new Map(SKUS.map((s) => [s.meter, s]));

// the configured ceiling: the env override when it parses, the table's default otherwise
function limitOf(s) {
  if (s.limit === null) return null;
  const raw = s.env ? parseInt(process.env[s.env], 10) : NaN;
  return Number.isInteger(raw) && raw >= 0 ? raw : s.limit;
}

module.exports = { SKUS, GOOGLE_METHOD, CONSOLE_DAILY_QUOTA, byMeter, limitOf };
