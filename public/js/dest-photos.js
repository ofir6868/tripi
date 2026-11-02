// One photo per place, for every page that pictures a destination before anything
// about the trip itself is known: the recommendations chat (a place with no photo of its
// own gets its area's) and the wizard (the trip's cover while it is being made).
//
// Every id here is one the destination guides already ship (lib/seo.js), each eyeballed
// against its place once. A destination not in the table gets its country's photo, and a
// country not in it a generic one — never a picture found by searching the name, which
// is how a Hiroshima food market once came to be illustrated with the bombing
// (lib/place-photos.js). Unsplash photos, under the Unsplash licence.
const DEST_PHOTOS = (() => {
  const BY_NAME = {
    'רומא': 'photo-1552832230-c0197dd311b5', 'מילאנו': 'photo-1520440229-6469a149ac59', 'ברצלונה': 'photo-1583422409516-2895a77efded',
    'ליסבון': 'photo-1585208798174-6cedd86e019a', 'פריז': 'photo-1502602898657-3e91760cbb34', 'לונדון': 'photo-1513635269975-59663e0ac1ad',
    'אמסטרדם': 'photo-1534351590666-13e3e96b5017', 'ברלין': 'photo-1560930950-5cc20e80e392', 'פראג': 'photo-1541849546-216549ae216d',
    'בודפשט': 'photo-1541343672885-9be56236302a', 'וינה': 'photo-1516550893923-42d28e5677af', 'אוסטריה': 'photo-1516550893923-42d28e5677af',
    'בריסל': 'photo-1573299867162-6e895f64bf23', 'בלגיה': 'photo-1573299867162-6e895f64bf23', 'אתונה': 'photo-1555993539-1732b0258235',
    'סנטוריני': 'photo-1613395877344-13d4a8e0d49e', 'כרתים': 'photo-1533105079780-92b9be482077', 'רודוס': 'photo-1504512485720-7d83a16ee930',
    'קפריסין': 'photo-1601581875039-e899893d520c', 'טנריף': 'photo-1533130061792-64b345e4a833', 'מונטנגרו': 'photo-1614122027743-50a9e6e8002f',
    'אלבניה': 'photo-1483683804023-6ccdb62f86ef', 'דובאי': 'photo-1512453979798-5ea266f8880c',
    'איחוד האמירויות': 'photo-1512453979798-5ea266f8880c', 'גאורגיה': 'photo-1565008447742-97f6f38c985c',
    'תאילנד': 'photo-1552465011-b4e21bf6e79a', 'וייטנאם': 'photo-1528127269322-539801943592', 'הודו': 'photo-1548013146-72479768bada',
    'נפאל': 'photo-1544735716-392fe2489ffa', 'סרי לנקה': 'photo-1612862862126-865765df2ded', 'יפן': 'photo-1540959733332-eab4deabeeaf',
    'טוקיו': 'photo-1540959733332-eab4deabeeaf', 'פרו': 'photo-1526392060635-9d6019884377', 'ארגנטינה': 'photo-1589909202802-8f4aadce1849',
    'קולומביה': 'photo-1583531352515-8884af319dc1', 'מקסיקו': 'photo-1518638150340-f706e86654de', 'ניו יורק': 'photo-1496442226666-8d4d0e62e6e9',
    'איסלנד': 'photo-1504829857797-ddff29c27927', 'בנסקו': 'photo-1551524559-8af4e6624178', 'רמת הגולן': 'photo-1544971587-b842c27f8e14',
    'קו פנגן': 'photo-1552465011-b4e21bf6e79a',
    // a country with no photo of its own wears its headline city's
    'איטליה': 'photo-1552832230-c0197dd311b5', 'ספרד': 'photo-1583422409516-2895a77efded', 'פורטוגל': 'photo-1585208798174-6cedd86e019a',
    'צרפת': 'photo-1502602898657-3e91760cbb34', 'בריטניה': 'photo-1513635269975-59663e0ac1ad', 'הולנד': 'photo-1534351590666-13e3e96b5017',
    'גרמניה': 'photo-1560930950-5cc20e80e392', "צ'כיה": 'photo-1541849546-216549ae216d', 'הונגריה': 'photo-1541343672885-9be56236302a',
    'יוון': 'photo-1613395877344-13d4a8e0d49e', 'ארצות הברית': 'photo-1496442226666-8d4d0e62e6e9', 'בולגריה': 'photo-1551524559-8af4e6624178',
  };
  const GENERIC = ['photo-1469854523086-cc02fe5d8800', 'photo-1539635278303-d4002c07eae3', 'photo-1552733407-5d5c46c3bb3b', 'photo-1530521954074-e64f6810b32d'];
  const img = (id, w = 720) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=70`;
  // a destination's own photo, else its country's; `exact` says which one it is
  function find(d) {
    if (!d) return null;
    if (BY_NAME[d.name]) return { id: BY_NAME[d.name], exact: true };
    if (d.country && BY_NAME[d.country]) return { id: BY_NAME[d.country], exact: false };
    return null;
  }
  return { byName: BY_NAME, generic: GENERIC, img, find };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DEST_PHOTOS;
