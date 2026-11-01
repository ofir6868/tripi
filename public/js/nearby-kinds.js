// What "מסעדות באזור" can be narrowed to, and how a place is read as kosher — one table
// that both sides read. The server asks Google for exactly these types when a cuisine is
// picked (routes/nearby.js), and the page filters the list it already holds by the same
// types, so a chip can never mean one thing on the request and another on the screen.
//
// Every type here is from Google's Table A (Places API New) — an unknown type in
// includedTypes is a 400 for the whole request, not an ignored entry, so a new chip is
// added only with a type Google documents.
const NEARBY_KINDS = (() => {
  const CUISINES = [
    { key: 'burgers', label: 'המבורגרים', emoji: '🍔', types: ['hamburger_restaurant', 'american_restaurant'] },
    { key: 'italian', label: 'איטלקי', emoji: '🍝', types: ['italian_restaurant', 'pizza_restaurant'] },
    { key: 'pizza', label: 'פיצה', emoji: '🍕', types: ['pizza_restaurant'] },
    { key: 'asian', label: 'אסייתי', emoji: '🥢', types: ['chinese_restaurant', 'japanese_restaurant', 'thai_restaurant', 'vietnamese_restaurant', 'korean_restaurant', 'ramen_restaurant', 'sushi_restaurant', 'indonesian_restaurant'] },
    { key: 'sushi', label: 'סושי', emoji: '🍣', types: ['sushi_restaurant', 'japanese_restaurant'] },
    { key: 'meat', label: 'בשרים', emoji: '🥩', types: ['steak_house', 'barbecue_restaurant'] },
    { key: 'fish', label: 'דגים', emoji: '🐟', types: ['seafood_restaurant'] },
    { key: 'med', label: 'ים-תיכוני', emoji: '🥙', types: ['mediterranean_restaurant', 'middle_eastern_restaurant', 'greek_restaurant', 'lebanese_restaurant', 'turkish_restaurant'] },
    { key: 'mexican', label: 'מקסיקני', emoji: '🌮', types: ['mexican_restaurant'] },
    { key: 'indian', label: 'הודי', emoji: '🍛', types: ['indian_restaurant'] },
    { key: 'veg', label: 'צמחוני', emoji: '🥗', types: ['vegetarian_restaurant', 'vegan_restaurant'] },
    { key: 'cafe', label: 'בתי קפה', emoji: '☕', types: ['cafe', 'coffee_shop', 'breakfast_restaurant', 'brunch_restaurant', 'bakery'] },
  ];
  const byKey = new Map(CUISINES.map((c) => [c.key, c]));

  // the cuisine a place reads as, by its primary type first and any type after — so a
  // sushi bar Google also files under "restaurant" lands on סושי, not on nothing
  function cuisineOf(primaryType, types = []) {
    for (const t of [primaryType, ...types]) {
      if (!t) continue;
      const hit = CUISINES.find((c) => c.types.includes(t));
      if (hit) return hit;
    }
    return null;
  }
  const matches = (key, primaryType, types = []) => {
    const c = byKey.get(key);
    return !!c && [primaryType, ...types].some((t) => t && c.types.includes(t));
  };

  // ---- kosher ----
  // Google has no kosher field, so the mark rests on what the place says about itself
  // (its name, its description) or what diners say about it (reviews). A wrong "כשר" is
  // worse than none — someone eats there because of it — so the reading is strict:
  //   · the Hebrew word stands alone (כשרון and מכשיר contain it; הכשרה is skipped),
  //   · a negated mention ("לא כשר", "not kosher", "non-kosher") is not evidence,
  //   · and the page always says to check the certificate at the door.
  const LATIN = /(kosher|chabad|glatt|mehadrin|koscher|cacher|casher)/gi;
  const HEBREW = /(^|[^א-ת])([והבש]?)(כשר|כשרה|כשרים|כשרות|חב"ד|חב״ד|חבד|מהדרין|גלאט)(?![א-ת])/g;
  const NEG = /(לא|אינו|אינה|איננו|not|non|isn't|isnt|no)[\s\-–]*$/i;

  function mentionsKosher(text) {
    const s = String(text || '');
    if (!s) return false;
    for (const re of [LATIN, HEBREW]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        // הכשרה is "training" far more often than "the kosher one"
        if (re === HEBREW && m[2] === 'ה' && m[3] === 'כשרה') continue;
        const at = re === HEBREW ? m.index + m[1].length : m.index;
        if (!NEG.test(s.slice(Math.max(0, at - 12), at))) return true;
      }
    }
    return false;
  }

  return { CUISINES, byKey, cuisineOf, matches, mentionsKosher };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NEARBY_KINDS;
