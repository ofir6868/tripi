// Which hotel content provider is live, and what does it actually return?
//
//   node tools/hotel-content-probe.js                     # configured provider, Osaka
//   node tools/hotel-content-probe.js liteapi 35.69 139.70 יפן
//
// Reads the key from .env like the server does — never pass a key on the command
// line, where it lands in your shell history.
require('../lib/env');
const { searchNear, activeProvider } = require('../lib/hotel-content');

const [, , providerArg, latArg, lonArg, countryArg] = process.argv;
if (providerArg) process.env.HOTEL_CONTENT_PROVIDER = providerArg;

const lat = parseFloat(latArg) || 34.6937;   // Osaka — the Far East hero trip
const lon = parseFloat(lonArg) || 135.5023;
const country = countryArg || null;

(async () => {
  const active = activeProvider();
  console.log(`requested: ${active.requested}   using: ${active.name}${active.note ? `   (${active.note})` : ''}`);
  console.log(`LITEAPI_KEY: ${process.env.LITEAPI_KEY ? 'present' : 'not set'}\n`);

  const t0 = Date.now();
  const rows = await searchNear({ lat, lon, country, limit: 8 });
  console.log(`${rows.length} hotels in ${Date.now() - t0}ms\n`);

  for (const h of rows) {
    console.log(`  ${h.name}`);
    console.log(`    ${h.provider} · ${h.distance != null ? h.distance + 'm' : 'distance ?'}` +
      `${h.stars ? ' · ' + h.stars + '★' : ''}` +
      `${h.rating != null ? ' · rating ' + h.rating + (h.reviewCount ? ` (${h.reviewCount} reviews)` : '') : ''}`);
    console.log(`    photo: ${h.photo ? h.photo.slice(0, 78) : '—'}`);
  }

  const withPhoto = rows.filter((h) => h.photo).length;
  const withRating = rows.filter((h) => h.rating != null).length;
  console.log(`\nphotos ${withPhoto}/${rows.length}   guest ratings ${withRating}/${rows.length}`);
  if (rows.length && !withPhoto) console.log('No photos — that provider is content-poor, or it fell back to OSM.');
})();
