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
  // ---------- the smart edit ----------
  // These reach aiEditOps directly: the HTTP route can only edit a trip that already
  // exists in the DB, and everything worth measuring happens inside that function.
  // They run against a fixture — a real 14-day, 46-stop itinerary the builder produced —
  // so the same request is judged against the same trip every time.
  {
    id: 'edit-repace-crowded',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'הטיול צפוף מדי, תפרסו אותו יותר רגוע',
    why: 'The request the edit prompt was largely written against: "too crowded" answered '
      + 'with mass deletions leaves a few packed days and a tail of empty ones. Spreading '
      + 'is the right answer, emptying days is not.',
    expect: { opsAtLeast: 1, noEmptyDays: true, areasContiguous: true },
  },
  {
    id: 'edit-targeted-delete',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תמחקו את התחנה הראשונה ביום 1',
    why: 'The narrowest request there is — one named stop, one operation. Touching '
      + 'anything else means the model rewrote a trip nobody asked it to rewrite.',
    expect: { opsAtMost: 2, onlyActions: ['delete', 'update'], onlyTouchesDays: [1, 1] },
  },
  {
    id: 'edit-add-food-range',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תוסיפו יותר אוכל רחוב בימים 6-10',
    why: 'A scoped addition. The days are named in the sentence and nowhere else — this '
      + 'is what tells us whether a free-text scope is respected without a day picker.',
    expect: { opsAtLeast: 1, onlyTouchesDays: [6, 10], noEmptyDays: true },
  },
  {
    id: 'edit-move-stop',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תעבירו את שוק צוקיג\'י מיום 1 ליום 2',
    why: 'A one-stop move between days, named the way a traveller names it (not by the '
      + 'exact title). The right shape is a single update changing day_number — the '
      + 'failure modes are delete+add, which loses the stop\'s identity and notes, and '
      + 'rewriting both days around a request that named one stop.',
    expect: { opsAtLeast: 1, opsAtMost: 2, onlyActions: ['update'], onlyTouchesDays: [1, 2], noEmptyDays: true, areasContiguous: true },
  },
  {
    id: 'edit-swap-days',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תחליפו בין יום 2 ליום 3 — מה שמתוכנן ליום 2 יעבור ליום 3 ולהפך',
    why: 'A day swap is bulk movement with an exact right answer: the two days trade '
      + 'their stops, ids intact. The failure modes are a half-swap that merges the two '
      + 'days, and delete+add instead of moving.',
    expect: { opsAtLeast: 4, onlyActions: ['update'], onlyTouchesDays: [2, 3], swapDays: [2, 3], noEmptyDays: true, areasContiguous: true },
  },
  {
    id: 'edit-late-start',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'אנחנו קמים מאוחר — תזיזו כל תחנה שמתחילה לפני 10:00 לשעה מאוחרת יותר, בלי לשנות את התחנות עצמן',
    why: 'A schedule-only request across the whole trip. Times move; nothing else may — '
      + 'no stop swapped out, none pushed to another day. This is the request most '
      + 'tempting to answer with a rewrite.',
    expect: { opsAtLeast: 1, onlyActions: ['update'], noDayMoves: true, minTouchedTime: '10:00', noEmptyDays: true, areasContiguous: true },
  },
  {
    id: 'edit-out-of-scope',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תזיזו את הטיול לאוגוסט במקום ביולי',
    why: 'Dates are explicitly outside what the editor may touch. It should say so rather '
      + 'than simulate the move by shuffling stops between days.',
    expect: { noOps: true },
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

  // ---------- the clarifying round, continued ----------
  {
    id: 'spain-10-combine-edge',
    phase: 'ask',
    why: 'Exactly COMBINE_REGIONS_FROM_DAYS. Ten days is the first length that asks which '
      + 'regions to COMBINE — one day less and the focus question in italy-6-country is the '
      + 'right one. The two of them fence the threshold from both sides; the boundary itself '
      + 'is where an off-by-one lives.',
    body: {
      destinations: [{ name: 'ספרד', country: 'ספרד', lat: 40.42, lon: -3.7 }],
      day_from: 1, day_to: 10, interests: ['אוכל', 'תרבות'],
    },
    expect: { questions: 1, multi: true, optionsAtLeast: 3, regionOptions: true },
  },
  {
    id: 'berlin-prague-8-border',
    phase: 'ask',
    why: 'Two cities in two countries, 280km apart — the shape neither existing pair has. '
      + 'A border is not a distance: the answer is still the train, and offering a flight '
      + 'because the trip "crosses countries" is the failure this catches.',
    body: {
      destinations: [
        { name: 'ברלין', country: 'גרמניה', lat: 52.52, lon: 13.405 },
        { name: 'פראג', country: 'צ\'כיה', lat: 50.08, lon: 14.44 },
      ],
      day_from: 1, day_to: 8, interests: ['תרבות', 'היסטוריה'],
    },
    expect: { questions: [1, 2], transportOptionsExclude: ['טיסה', 'שיט', 'מעבורת'] },
  },
  {
    id: 'greece-3-islands',
    phase: 'ask',
    why: 'Three destinations, so the proximity ordering runs — and two of them are islands. '
      + 'Every other transport case checks what must NOT be offered; this is the one where '
      + 'a mode is mandatory. Athens→Naxos→Santorini by train is not a slow answer, it is '
      + 'an impossible one.',
    body: {
      destinations: [
        { name: 'אתונה', country: 'יוון', lat: 37.98, lon: 23.72 },
        { name: 'נאקסוס', country: 'יוון', lat: 37.1, lon: 25.37 },
        { name: 'סנטוריני', country: 'יוון', lat: 36.39, lon: 25.46 },
      ],
      day_from: 1, day_to: 10, interests: ['ים', 'אוכל'],
    },
    expect: {
      questions: [1, 2],
      transportOptionsAnyOf: ['מעבורת', 'שיט', 'טיסה'],
      transportOptionsExclude: ['רכבת', 'רכב שכור'],
    },
  },
  {
    id: 'range-over-30-days',
    phase: 'ask',
    why: 'The half-year-abroad request. The cap is checked before anything reaches OpenAI, '
      + 'so this case costs nothing — and if it ever stops firing, a 45-day trip becomes '
      + 'forty-five days of generation calls on one request.',
    body: {
      destinations: [{ name: 'יפן', country: 'יפן', lat: 36.2, lon: 138.25 }],
      day_from: 1, day_to: 45, interests: ['תרבות'],
    },
    expect: { httpStatus: 400, errorIncludes: 'עד 30 ימים' },
  },

  // ---------- the build, continued ----------
  {
    id: 'barcelona-days-9-12',
    phase: 'build',
    why: 'Days 9 to 12 of a trip that already exists — the "add a few days" flow, where '
      + 'day_from is not 1. Everything the calendar hangs on is absolute day numbers, so a '
      + 'build that quietly returns days 1-4 lands four stops on top of the first week.',
    body: {
      destinations: [{ name: 'ברצלונה', country: 'ספרד', lat: 41.39, lon: 2.17 }],
      day_from: 9, day_to: 12, interests: ['אמנות', 'אוכל'], answers: [],
    },
    expect: { questions: false, areas: [1, 1], areaIs: 'ברצלונה' },
  },
  {
    id: 'rome-area-only',
    phase: 'build',
    why: 'Rebuilding ONE area of a multi-city trip — what the per-area regenerate button '
      + 'sends. The area is named, so there is nothing to clarify and nothing to allocate: '
      + 'one block over the given days, and not a single stop from Florence in it.',
    body: {
      destinations: [
        { name: 'רומא', country: 'איטליה', lat: 41.9, lon: 12.5 },
        { name: 'פירנצה', country: 'איטליה', lat: 43.77, lon: 11.26 },
      ],
      area: 'רומא', day_from: 1, day_to: 3, interests: ['תרבות'],
    },
    expect: { questions: false, areas: [1, 1], areaIs: 'רומא' },
  },
  {
    id: 'japan-8-freetext-answer',
    phase: 'build',
    why: 'They typed into the region question instead of ticking it, and what they typed has '
      + 'commas in it. Only `picked` may become areas — read from the text, this trip gets '
      + 'built as "אוהבים אוכל רחוב" and "קצב רגוע", two imaginary regions with a train ride '
      + 'between them. The typed text still has to reach the model as a preference.',
    body: {
      destinations: [{ name: 'יפן', country: 'יפן', lat: 36.2, lon: 138.25 }],
      day_from: 1, day_to: 8, interests: ['אוכל'],
      answers: [{
        question: 'אילו אזורים לשלב ב-8 הימים?',
        answer: 'לא משנה לנו, אוהבים אוכל רחוב, קצב רגוע',
        picked: [],
      }],
    },
    expect: {
      areas: [1, 3], areasDifferFromDestination: true, transferStops: true,
      areasExclude: ['אוכל', 'רגוע', 'משנה'],
    },
  },

  // ---------- the smart edit, continued ----------
  {
    id: 'edit-drop-area',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תוותרו על הירושימה ותחלקו את ארבעת הימים שלה בין טוקיו לקיוטו',
    why: 'A whole area leaves the trip. The days do not: the remaining two must stretch to '
      + 'cover all fourteen, each still sitting on one run of days. This is also the one '
      + 'edit that leaves the description untrue — it names Hiroshima — so it is the case '
      + 'that says whether the rewrite rule fires when it should.',
    expect: {
      opsAtLeast: 4, areaGone: 'הירושימה', noEmptyDays: true, areasContiguous: true,
      descriptionChanged: true,
    },
  },
  {
    id: 'edit-strip-a-theme',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'נמאס לנו ממקדשים וממוזיאונים — תורידו אותם ותשאירו טיול שאפשר לעשות',
    why: 'A deletion big enough to gut the trip: most of this fixture is temples and '
      + 'museums. The days stay, so what leaves has to be replaced, or the rest spread over '
      + 'them. Answered literally, this is the "a few packed days and a tail of empty ones" '
      + 'failure at full size.',
    expect: { opsAtLeast: 3, noEmptyDays: true, areasContiguous: true },
  },
  {
    id: 'edit-foreign-place',
    phase: 'edit',
    fixture: 'japan-14',
    prompt: 'תוסיפו ביקור במגדל אייפל ביום 3',
    why: 'The editor is the second door a stop in the wrong country walks through, and here '
      + 'the traveller holds it open. Whatever comes back — a refusal, or a Tokyo landmark '
      + 'in its place — no stop on this trip may point at Paris. Adding one stop also '
      + 'leaves the description true, so it has to come back null.',
    expect: {
      opsAtMost: 2, noPlaceMatching: ['Paris', 'France', 'Eiffel', 'אייפל'],
      noEmptyDays: true, descriptionChanged: false,
    },
  },
];
