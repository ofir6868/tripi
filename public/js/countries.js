// Static country list (Hebrew name → ISO-3166 alpha-2) + flag helpers.
// Lives locally so the homepage country autocomplete is instant and offline —
// the geocoding API is bad at Hebrew prefix matches ("אל" won't surface אלבניה).
// Flags: emoji on mobile (renders natively), SVG images on desktop — Windows
// renders flag emoji as bare letters ("JP"), so desktop always gets images.
const COUNTRIES = (() => {
  const LIST = [
    ['אוגנדה', 'ug'], ['אוזבקיסטן', 'uz'], ['אוסטריה', 'at'], ['אוסטרליה', 'au'],
    ['אוקראינה', 'ua'], ['אורוגוואי', 'uy'], ['איחוד האמירויות', 'ae'], ['איטליה', 'it'],
    ['איי מרשל', 'mh'], ['איי פארו', 'fo'], ['איי קיימן', 'ky'], ['איי שלמה', 'sb'],
    ['אינדונזיה', 'id'], ['איסלנד', 'is'], ['איראן', 'ir'], ['אירלנד', 'ie'],
    ['אל סלוודור', 'sv'], ['אלבניה', 'al'], ['אלג\'יריה', 'dz'], ['אנגולה', 'ao'],
    ['אנדורה', 'ad'], ['אנטיגואה וברבודה', 'ag'], ['אסטוניה', 'ee'], ['אסוואטיני', 'sz'],
    ['אפגניסטן', 'af'], ['אקוודור', 'ec'], ['ארגנטינה', 'ar'], ['ארובה', 'aw'],
    ['אריתריאה', 'er'], ['ארמניה', 'am'], ['ארצות הברית', 'us'], ['אתיופיה', 'et'],
    ['בהאמה', 'bs'], ['בהוטן', 'bt'], ['בולגריה', 'bg'], ['בוליביה', 'bo'],
    ['בורונדי', 'bi'], ['בורקינה פאסו', 'bf'], ['בוסניה והרצגובינה', 'ba'], ['בוצואנה', 'bw'],
    ['בחריין', 'bh'], ['בלארוס', 'by'], ['בלגיה', 'be'], ['בליז', 'bz'],
    ['בנגלדש', 'bd'], ['בנין', 'bj'], ['ברבדוס', 'bb'], ['ברוניי', 'bn'],
    ['ברזיל', 'br'], ['בריטניה', 'gb'], ['ברמודה', 'bm'], ['גאבון', 'ga'],
    ['גאורגיה', 'ge'], ['גאנה', 'gh'], ['גואטמלה', 'gt'], ['גוואדלופ', 'gp'],
    ['גיאנה', 'gy'], ['גיברלטר', 'gi'], ['גינאה', 'gn'], ['גינאה ביסאו', 'gw'],
    ['גינאה המשוונית', 'gq'], ['גמביה', 'gm'], ['גרינלנד', 'gl'], ['גרמניה', 'de'],
    ['גרנדה', 'gd'], ['ג\'יבוטי', 'dj'], ['ג\'מייקה', 'jm'], ['דנמרק', 'dk'],
    ['דרום אפריקה', 'za'], ['דרום סודאן', 'ss'], ['דרום קוריאה', 'kr'], ['האיטי', 'ht'],
    ['הודו', 'in'], ['הולנד', 'nl'], ['הונג קונג', 'hk'], ['הונגריה', 'hu'],
    ['הונדורס', 'hn'], ['הוותיקן', 'va'], ['הפיליפינים', 'ph'],
    ['הרפובליקה הדומיניקנית', 'do'], ['הרפובליקה המרכז אפריקאית', 'cf'], ['וייטנאם', 'vn'],
    ['ונואטו', 'vu'], ['ונצואלה', 've'], ['זימבבואה', 'zw'], ['זמביה', 'zm'],
    ['חוף השנהב', 'ci'], ['טאיוואן', 'tw'], ['טג\'יקיסטן', 'tj'], ['טובאלו', 'tv'],
    ['טוגו', 'tg'], ['טונגה', 'to'], ['טורקיה', 'tr'], ['טורקמניסטן', 'tm'],
    ['טנזניה', 'tz'], ['טרינידד וטובגו', 'tt'], ['יוון', 'gr'], ['יפן', 'jp'],
    ['ירדן', 'jo'], ['ישראל', 'il'], ['כווית', 'kw'], ['כף ורדה', 'cv'],
    ['לאוס', 'la'], ['לבנון', 'lb'], ['לוב', 'ly'], ['לוקסמבורג', 'lu'],
    ['לטביה', 'lv'], ['ליבריה', 'lr'], ['ליטא', 'lt'], ['ליכטנשטיין', 'li'],
    ['לסוטו', 'ls'], ['מאוריטניה', 'mr'], ['מאוריציוס', 'mu'], ['מאלי', 'ml'],
    ['מדגסקר', 'mg'], ['מוזמביק', 'mz'], ['מולדובה', 'md'], ['מונגוליה', 'mn'],
    ['מונטנגרו', 'me'], ['מונקו', 'mc'], ['מזרח טימור', 'tl'], ['מיאנמר', 'mm'],
    ['מיקרונזיה', 'fm'], ['מלאווי', 'mw'], ['מלדיביים', 'mv'], ['מלזיה', 'my'],
    ['מלטה', 'mt'], ['מצרים', 'eg'], ['מקאו', 'mo'], ['מקסיקו', 'mx'],
    ['מרוקו', 'ma'], ['מרטיניק', 'mq'], ['נאורו', 'nr'], ['נורווגיה', 'no'],
    ['ניגריה', 'ng'], ['ניו זילנד', 'nz'], ['ניז\'ר', 'ne'], ['ניקרגואה', 'ni'],
    ['נמיביה', 'na'], ['נפאל', 'np'], ['סודאן', 'sd'], ['סוריה', 'sy'],
    ['סורינאם', 'sr'], ['סיישל', 'sc'], ['סיירה לאונה', 'sl'], ['סין', 'cn'],
    ['סינגפור', 'sg'], ['סלובניה', 'si'], ['סלובקיה', 'sk'], ['סמואה', 'ws'],
    ['סן מרינו', 'sm'], ['סנגל', 'sn'], ['סנט וינסנט', 'vc'], ['סנט לוסיה', 'lc'],
    ['סנט קיטס ונוויס', 'kn'], ['ספרד', 'es'], ['סרביה', 'rs'], ['סרי לנקה', 'lk'],
    ['עומאן', 'om'], ['עיראק', 'iq'], ['ערב הסעודית', 'sa'], ['פוארטו ריקו', 'pr'],
    ['פולין', 'pl'], ['פולינזיה הצרפתית', 'pf'], ['פורטוגל', 'pt'], ['פיג\'י', 'fj'],
    ['פינלנד', 'fi'], ['פלאו', 'pw'], ['פנמה', 'pa'], ['פפואה גינאה החדשה', 'pg'],
    ['פקיסטן', 'pk'], ['פרגוואי', 'py'], ['פרו', 'pe'], ['צ\'אד', 'td'],
    ['צ\'ילה', 'cl'], ['צ\'כיה', 'cz'], ['צפון מקדוניה', 'mk'], ['צפון קוריאה', 'kp'],
    ['צרפת', 'fr'], ['קובה', 'cu'], ['קולומביה', 'co'], ['קומורו', 'km'],
    ['קונגו', 'cg'], ['קונגו הדמוקרטית', 'cd'], ['קוסובו', 'xk'], ['קוסטה ריקה', 'cr'],
    ['קוראסאו', 'cw'], ['קזחסטן', 'kz'], ['קטאר', 'qa'], ['קירגיזסטן', 'kg'],
    ['קיריבטי', 'ki'], ['קלדוניה החדשה', 'nc'], ['קמבודיה', 'kh'], ['קמרון', 'cm'],
    ['קנדה', 'ca'], ['קניה', 'ke'], ['קפריסין', 'cy'], ['קרואטיה', 'hr'],
    ['ראוניון', 're'], ['רואנדה', 'rw'], ['רומניה', 'ro'], ['רוסיה', 'ru'],
    ['שוודיה', 'se'], ['שווייץ', 'ch'], ['תאילנד', 'th'], ['תוניסיה', 'tn'],
    ['תימן', 'ye'],
  ];

  // countries genuinely dangerous for Israelis (not mere passport bans — dual
  // citizens travel on their other passport). Kept in LIST so flags still
  // resolve anywhere (e.g. a stopover added by name), but never suggested.
  const RESTRICTED = new Set(['af', 'ir', 'iq', 'sy', 'lb', 'ye', 'ly', 'sd', 'so', 'kp']);

  const byName = new Map(LIST);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  function flagEmoji(cc) {
    if (!cc || cc.length !== 2) return '';
    const A = 0x1F1E6;
    const up = cc.toUpperCase();
    return String.fromCodePoint(A + up.charCodeAt(0) - 65, A + up.charCodeAt(1) - 65);
  }

  // emoji on mobile, SVG image on desktop (Windows shows flag emoji as letters)
  function flagHtml(cc) {
    if (!cc) return '';
    if (isMobile) return `<span class="flag-emoji">${flagEmoji(cc)}</span>`;
    // no loading="lazy": flags are ≤1KB and appear mid-interaction — defer buys nothing
    return `<img class="flag-img" src="https://flagcdn.com/w80/${cc}.png" alt="">`;
  }

  function search(q, max = 3) {
    q = (q || '').trim();
    if (q.length < 2) return [];
    const starts = [], words = [];
    for (const [name, cc] of LIST) {
      if (RESTRICTED.has(cc)) continue;
      if (name.startsWith(q)) starts.push({ name, cc });
      else if (name.split(/[\s-]+/).some((w) => w.startsWith(q))) words.push({ name, cc });
    }
    return [...starts, ...words].slice(0, max);
  }

  return {
    isMobile,
    search,
    flagEmoji,
    flagHtml,
    ccByName: (name) => byName.get((name || '').trim()) || null,
  };
})();
