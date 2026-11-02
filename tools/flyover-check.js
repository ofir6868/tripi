// The flyover reads Google Maps Timeline exports on the device (public/js/trip-flyover.js
// parseTimeline). Google has shipped four shapes of that file over the years, and the one
// a traveller has depends on their phone and on when they exported it. Each one here is a
// tiny real-shaped sample; a parser that silently returns nothing for one of them is a
// flyover that quietly falls back to straight lines for everyone with that phone.
const assert = require('assert');
const { parseTimeline } = require('../public/js/trip-flyover.js');

const near = (p, t, lat, lon) => p.some((x) => Math.abs(x[0] - t) < 1000 && Math.abs(x[1] - lat) < 1e-4 && Math.abs(x[2] - lon) < 1e-4);
const T = Date.parse('2026-10-12T09:00:00+02:00');
let n = 0;

// Android, on-device export (2024+): semanticSegments + rawSignals, "lat°, lon°" strings
{
  const p = parseTimeline({
    semanticSegments: [
      { startTime: '2026-10-12T09:00:00.000+02:00', endTime: '2026-10-12T10:00:00.000+02:00', visit: { topCandidate: { placeLocation: { latLng: '41.8902°, 12.4922°' } } } },
      { startTime: '2026-10-12T10:00:00.000+02:00', endTime: '2026-10-12T10:30:00.000+02:00', timelinePath: [{ point: '41.8910°, 12.4900°', time: '2026-10-12T10:10:00.000+02:00' }] },
      { startTime: '2026-10-12T10:00:00.000+02:00', endTime: '2026-10-12T10:30:00.000+02:00', activity: { start: { latLng: '41.8902°, 12.4922°' }, end: { latLng: '41.8925°, 12.4853°' } } },
    ],
    rawSignals: [{ position: { LatLng: '41.8920°, 12.4860°', timestamp: '2026-10-12T10:25:00.000+02:00' } }],
  });
  assert(near(p, T, 41.8902, 12.4922), 'android: visit');
  assert(near(p, T + 70 * 60000, 41.891, 12.49), 'android: timelinePath');
  assert(near(p, T + 90 * 60000, 41.8925, 12.4853), 'android: activity end');
  assert(near(p, T + 85 * 60000, 41.892, 12.486), 'android: rawSignals');
  n++;
}
// iPhone export: a bare array, "geo:lat,lon", path times as minute offsets
{
  const p = parseTimeline([
    { startTime: '2026-10-12T09:00:00.000+02:00', endTime: '2026-10-12T10:00:00.000+02:00', visit: { topCandidate: { placeLocation: 'geo:41.890200,12.492200' } } },
    { startTime: '2026-10-12T10:00:00.000+02:00', endTime: '2026-10-12T10:30:00.000+02:00', timelinePath: [{ point: 'geo:41.891000,12.490000', durationMinutesOffsetFromStartTime: '10' }] },
  ]);
  assert(near(p, T, 41.8902, 12.4922), 'iphone: visit');
  assert(near(p, T + 70 * 60000, 41.891, 12.49), 'iphone: path offset');
  n++;
}
// Takeout Records.json: E7 integers, timestamp or timestampMs
{
  const p = parseTimeline({ locations: [
    { latitudeE7: 418902000, longitudeE7: 124922000, timestamp: '2026-10-12T07:00:00Z' },
    { latitudeE7: 418925000, longitudeE7: 124853000, timestampMs: String(T + 3600000) },
  ] });
  assert(near(p, T, 41.8902, 12.4922), 'records: timestamp');
  assert(near(p, T + 3600000, 41.8925, 12.4853), 'records: timestampMs');
  n++;
}
// Takeout Semantic Location History: placeVisit + activitySegment (raw path, or waypoints)
{
  const p = parseTimeline({ timelineObjects: [
    { placeVisit: { location: { latitudeE7: 418902000, longitudeE7: 124922000 }, duration: { startTimestamp: '2026-10-12T07:00:00Z', endTimestamp: '2026-10-12T08:00:00Z' } } },
    { activitySegment: { startLocation: { latitudeE7: 418902000, longitudeE7: 124922000 }, endLocation: { latitudeE7: 418925000, longitudeE7: 124853000 },
      duration: { startTimestampMs: String(T + 3600000), endTimestampMs: String(T + 5400000) },
      waypointPath: { waypoints: [{ latE7: 418910000, lngE7: 124900000 }] } } },
  ] });
  assert(near(p, T, 41.8902, 12.4922), 'semantic: visit');
  assert(near(p, T + 4500000, 41.891, 12.49), 'semantic: waypoint interpolated mid-segment');
  assert(near(p, T + 5400000, 41.8925, 12.4853), 'semantic: segment end');
  n++;
}
// junk is nothing, not a crash
assert.deepStrictEqual(parseTimeline({ hello: 1 }), []);
assert.deepStrictEqual(parseTimeline([{ visit: { topCandidate: { placeLocation: 'nowhere' } } }]), []);

console.log(`flyover: ${n}/4 Google Timeline export shapes read`);
