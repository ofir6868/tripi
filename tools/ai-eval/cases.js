// Scenarios for the AI trip builder. Every case is a trip someone would actually
// plan — the long-haul Japan trip, the Rome+Florence week, the four-day city break —
// picked so that each one lands on a DIFFERENT decision in routes/ai.js. If two cases
// would exercise the same branch, only the more realistic one belongs here.
//
// `phase` decides what a run costs:
//   ask   — the clarifying round answers and the request stops there. One cheap call.
//   build — a full itinerary: one OpenAI call per area, the expensive ones.
//
// `expect` is deliberately structural. Whether "קנסאי (קיוטו, אוסקה)" is a good option
// is a judgement call for the person reading the output — the runner prints every
// question and plan in full for exactly that reason. What it checks automatically is
// the part that should never drift: which branch fired, and whether the itinerary it
// produced is internally coherent.

module.exports = [
  // ---------- the clarifying round ----------
  {
    id: 'japan-14-country',
    phase: 'ask',
    why: 'The classic long-haul trip: a whole country, long enough for several areas. '
      + 'Should offer to COMBINE regions, multi-select, with options that name real places.',
    body: {
      destinations: [{ name: 'יפן', country: 'יפן', lat: 36.2, lon: 138.25 }],
      day_from: 1, day_to: 14, interests: ['תרבות', 'אוכל'],
    },
    expect: { questions: 1, multi: true, optionsAtLeast: 3, regionOptions: true },
  },
  {
    id: 'italy-6-country',
    phase: 'ask',
    why: 'Same shape, under the combine threshold — a week in Italy is one region, not four. '
      + 'Guards the focus/combine split at COMBINE_REGIONS_FROM_DAYS.',
    body: {
      destinations: [{ name: 'איטליה', country: 'איטליה', lat: 41.87, lon: 12.56 }],
      day_from: 1, day_to: 6, interests: ['היסטוריה', 'אוכל'],
    },
    expect: { questions: 1, multi: false, optionsAtLeast: 3, regionOptions: true },
  },
  {
    id: 'greece-8-islands',
    phase: 'ask',
    why: 'A country whose regions are islands, with the traveller saying so. The options '
      + 'should follow the note rather than defaulting to the mainland.',
    body: {
      destinations: [{ name: 'יוון', country: 'יוון', lat: 39.07, lon: 21.82 }],
      day_from: 1, day_to: 8, interests: ['ים'], notes: 'בעיקר איים, פחות אתונה',
    },
    expect: { questions: 1, multi: false, optionsAtLeast: 3 },
  },
  {
    id: 'usa-ny-la-10',
    phase: 'ask',
    why: 'Two cities a continent apart. This is the multi-destination branch: landing city '
      + 'plus how to cross. A boat between New York and Los Angeles means the distance '
      + 'line in the prompt stopped being read.',
    body: {
      destinations: [
        { name: 'ניו יורק', country: 'ארצות הברית', lat: 40.71, lon: -74.0 },
        { name: 'לוס אנג\'לס', country: 'ארצות הברית', lat: 34.05, lon: -118.24 },
      ],
      day_from: 1, day_to: 10, interests: ['עיר'],
    },
    expect: { questions: 2, multi: false, transportOptionsExclude: ['שיט', 'מעבורת'] },
  },
  {
    id: 'italy-rome-florence-ask',
    phase: 'ask',
    why: 'The other end of the same branch: two cities 230km apart. Offering an internal '
      + 'flight for a 90-minute train ride is the failure this case exists to catch.',
    body: {
      destinations: [
        { name: 'רומא', country: 'איטליה', lat: 41.9, lon: 12.5 },
        { name: 'פירנצה', country: 'איטליה', lat: 43.77, lon: 11.26 },
      ],
      day_from: 1, day_to: 5, interests: ['תרבות'],
    },
    expect: { questions: 2, transportOptionsExclude: ['טיסה פנימית', 'טיסה', 'שיט'] },
  },
  {
    id: 'thailand-12-freetext',
    phase: 'ask',
    why: 'A country typed as free text, so it arrives with no country field and no '
      + 'coordinates — the shape that used to skip the question entirely and build a trip '
      + 'that hopped islands daily.',
    body: {
      destinations: [{ name: 'תאילנד', country: null, lat: null, lon: null }],
      day_from: 1, day_to: 12, interests: ['ים', 'טבע'],
    },
    expect: { questions: 1, multi: true, optionsAtLeast: 3, regionOptions: true },
  },

  // ---------- the build ----------
  {
    id: 'japan-14-combined',
    phase: 'build',
    why: 'The core case: three regions ticked in the modal. They must come out as three '
      + 'contiguous blocks with a travel stop into each, not a trip that ping-pongs.',
    body: {
      destinations: [{ name: 'יפן', country: 'יפן', lat: 36.2, lon: 138.25 }],
      day_from: 1, day_to: 14, interests: ['תרבות'],
      answers: [{
        question: 'אילו אזורים לשלב ב-14 הימים?',
        answer: 'אזור טוקיו (טוקיו, יוקוהמה), אזור קיוטו (קיוטו, נארה), הירושימה (הירושימה, מיאג\'ימה)',
        picked: ['אזור טוקיו (טוקיו, יוקוהמה)', 'אזור קיוטו (קיוטו, נארה)', 'הירושימה (הירושימה, מיאג\'ימה)'],
      }],
    },
    expect: { areas: [3, 3], areasDifferFromDestination: true, transferStops: true },
  },
  {
    id: 'japan-5-skipped',
    phase: 'build',
    why: 'The traveller pressed דילוג. A country still has to come out as areas — that is '
      + 'what the calendar and the per-area generation calls hang on — and five days is '
      + 'one or two of them, not five.',
    body: {
      destinations: [{ name: 'יפן', country: 'יפן', lat: 36.2, lon: 138.25 }],
      day_from: 1, day_to: 5, interests: ['תרבות'], answers: [],
    },
    expect: { areas: [1, 2], areasDifferFromDestination: true },
  },
  {
    id: 'japan-12-slow-pace',
    phase: 'build',
    why: 'Same country and length as a fast-paced trip, but the note says they hate moving. '
      + 'Pacing is the model\'s judgement — this case fails if the note stops mattering.',
    body: {
      destinations: [{ name: 'יפן', country: 'יפן', lat: 36.2, lon: 138.25 }],
      day_from: 1, day_to: 12, interests: ['אוכל'],
      notes: 'קצב רגוע מאוד, שונאים לארוז ולזוז, מעדיפים להכיר מקום אחד לעומק',
      answers: [],
    },
    expect: { areas: [1, 2], areasDifferFromDestination: true },
  },
  {
    id: 'usa-parks-14-skipped',
    phase: 'build',
    why: 'Interests that point away from cities, over a country big enough to get it wrong. '
      + 'Areas should be park country, and none of them should get a single day — a flight '
      + 'for one night is the pacing failure this guards.',
    body: {
      destinations: [{ name: 'ארצות הברית', country: 'ארצות הברית', lat: 39.78, lon: -100.44 }],
      day_from: 1, day_to: 14, interests: ['טבע'],
      notes: 'בעיקר פארקים לאומיים ומסלולי הליכה, פחות ערים', answers: [],
    },
    expect: { areas: [2, 5], areasDifferFromDestination: true, minDaysPerArea: 2, transferStops: true },
  },
  {
    id: 'rome-florence-answered',
    phase: 'build',
    why: 'The multi-destination build, with the clarifying answers fed back in. Two cities, '
      + 'two contiguous blocks, and a נסיעה stop on the day they move.',
    body: {
      destinations: [
        { name: 'רומא', country: 'איטליה', lat: 41.9, lon: 12.5 },
        { name: 'פירנצה', country: 'איטליה', lat: 43.77, lon: 11.26 },
      ],
      day_from: 1, day_to: 5, interests: ['תרבות'],
      answers: [
        { question: 'באיזו עיר נוחתים?', answer: 'רומא', picked: ['רומא'] },
        { question: 'איך עוברים בין רומא לפירנצה?', answer: 'רכבת', picked: ['רכבת'] },
      ],
    },
    expect: { areas: [2, 2], transferStops: true },
  },
  {
    id: 'berlin-4-city-break',
    phase: 'build',
    why: 'A single city, not a country: the long-weekend break. Nothing to clarify and '
      + 'nothing to split — one block, one area, and the region machinery stays out of it.',
    body: {
      destinations: [{ name: 'ברלין', country: 'גרמניה', lat: 52.52, lon: 13.405 }],
      day_from: 1, day_to: 4, interests: ['תרבות', 'חיי לילה'], answers: [],
    },
    expect: { questions: false, areas: [1, 1], areaIs: 'ברלין' },
  },
];
