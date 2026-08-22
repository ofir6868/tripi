// Curated destination index: every country (from countries.js) plus the cities,
// islands and regions Israelis actually search for — a few hundred entries, all
// carrying a country code so every suggestion can show a flag.
//
// Why a local list and not a geocoder: the search has to answer while the person
// is still typing, in Hebrew, and land on ONE obvious result. Open-Meteo's Hebrew
// index misses ("טוקיו" returns nothing useful, "אילת" returns villages), and any
// network hop costs a keystroke's worth of latency. Everything here is in memory.
//
// Matching is fuzzy on purpose: Hebrew transliteration has no single spelling
// ("קופנהגן"/"קופנהאגן", "סנטוריני"/"סנטורני", "פוקט"/"פוקאט"), and a search that
// only does prefixes drops the traveller onto the free-text fallback — the one
// path where the AI has no country to anchor on. The fallback should be rare.
const DESTINATIONS = (() => {
  const COUNTRY_TABLE = (typeof module !== 'undefined' && module.exports)
    ? require('./countries.js')
    : COUNTRIES;

  // pop = how likely an Israeli is to search it (3 = headline destination, 1 = niche).
  // It only breaks ties between equally-good matches, so rough is fine.
  // kind: 'i' island, 'r' region/area, default city. 4th slot: extra spellings.
  const CITIES = {
    il: [['תל אביב', 3], ['ירושלים', 3], ['אילת', 3], ['חיפה', 2], ['ים המלח', 3, 'r'],
      ['מצפה רמון', 2], ['הגליל', 2, 'r'], ['רמת הגולן', 2, 'r', ['הגולן', 'גולן']], ['צפת', 2],
      ['טבריה', 2], ['הכנרת', 2, 'r'], ['נצרת', 1], ['עכו', 2], ['קיסריה', 1],
      ['עין גדי', 2], ['הנגב', 2, 'r'], ['ראש פינה', 2], ['זכרון יעקב', 1]],
    gr: [['אתונה', 3], ['סלוניקי', 3], ['סנטוריני', 3, 'i'], ['מיקונוס', 3, 'i'],
      ['כרתים', 3, 'i'], ['רודוס', 3, 'i'], ['קורפו', 3, 'i'], ['זקינתוס', 2, 'i'],
      ['פארוס', 2, 'i'], ['נאקסוס', 2, 'i'], ['קוס', 2, 'i'], ['חלקידיקי', 2, 'r', ['כלקידיקי']],
      ['סקיאתוס', 2, 'i'], ['לסבוס', 1, 'i'], ['סאמוס', 1, 'i'], ['לפקדה', 2, 'i'],
      ['קפלוניה', 2, 'i'], ['אגינה', 1, 'i'], ['מטאורה', 2], ['איוס', 2, 'i'],
      ['מילוס', 2, 'i'], ['סקופלוס', 1, 'i'], ['כיוס', 1, 'i']],
    it: [['רומא', 3], ['מילאנו', 3], ['ונציה', 3], ['פירנצה', 3], ['נאפולי', 3],
      ['טורינו', 2], ['בולוניה', 2], ['ורונה', 2], ['פיזה', 2], ['סיציליה', 3, 'i'],
      ['סרדיניה', 3, 'i'], ['קפרי', 2, 'i'], ['אמלפי', 2, 'r'], ['פוזיטנו', 2],
      ['סורנטו', 2], ['אגם קומו', 2, 'r', ['קומו']], ['אגם גארדה', 2, 'r', ['גארדה']],
      ['הדולומיטים', 2, 'r'], ['טוסקנה', 3, 'r'], ['פוליה', 2, 'r'], ['פלרמו', 2],
      ['קטניה', 2], ["ג'נובה", 2], ['בארי', 2], ['פומפיי', 2], ['טאורמינה', 2],
      ['סיינה', 2], ['לוקה', 1], ['טרייסטה', 1], ['ברגמו', 1], ['קורטינה', 1]],
    es: [['ברצלונה', 3, '', ['ברסלונה']], ['מדריד', 3], ['ולנסיה', 3], ['סביליה', 2],
      ['מלגה', 2], ['איביזה', 3, 'i'], ['מיורקה', 3, 'i', ['מיורקה', 'פלמה דה מיורקה', 'מאיורקה']],
      ['מנורקה', 2, 'i'], ['טנריף', 3, 'i'], ['גראן קנריה', 2, 'i'], ['לנסרוטה', 2, 'i'],
      ['פוארטוונטורה', 1, 'i'], ['האיים הקנריים', 2, 'r', ['קנריים']], ['בילבאו', 2],
      ['גרנדה', 2], ['קורדובה', 2], ['אליקנטה', 2], ['מרבייה', 2], ['סן סבסטיאן', 2],
      ['טולדו', 2], ['סרגוסה', 1], ['קוסטה ברווה', 2, 'r']],
    pt: [['ליסבון', 3], ['פורטו', 3], ['מדיירה', 2, 'i'], ['האיים האזוריים', 2, 'r', ['אזוריים']],
      ['אלגרבה', 2, 'r'], ['פארו', 2], ['סינטרה', 2], ['לגוש', 1], ['קסקאיס', 1], ['נזארה', 1]],
    fr: [['פריז', 3], ['ניס', 3], ['מרסיי', 2], ['ליון', 2], ['בורדו', 2], ['קאן', 2],
      ['אנטיב', 1], ['סן טרופה', 2], ['שאמוני', 2], ['שטרסבורג', 2], ['טולוז', 1],
      ['מונפלייה', 1], ['נורמנדי', 2, 'r'], ['פרובנס', 2, 'r'], ['קורסיקה', 2, 'i'],
      ['ביאריץ', 1], ['אביניון', 1], ['עמק הלואר', 1, 'r'], ['מון סן מישל', 1],
      ['קולמר', 1], ['אנסי', 2], ['גרנובל', 1], ['קורשבל', 1], ['ואל דיזר', 1], ['ליל', 1]],
    gb: [['לונדון', 3], ["מנצ'סטר", 2], ['אדינבורו', 3], ['ליברפול', 2], ['גלזגו', 1],
      ['אוקספורד', 2], ["קיימברידג'", 2], ['ברייטון', 2], ['בירמינגהם', 1], ['לידס', 1],
      ['בלפסט', 1], ['קרדיף', 1], ['סקוטלנד', 3, 'r'], ['ווילס', 1, 'r'], ['קורנוול', 1, 'r']],
    nl: [['אמסטרדם', 3], ['רוטרדם', 2], ['האג', 2], ['אוטרכט', 1], ['איינדהובן', 1]],
    be: [['בריסל', 2], ["ברוז'", 2], ['אנטוורפן', 2], ['גנט', 1]],
    de: [['ברלין', 3], ['מינכן', 3], ['פרנקפורט', 2], ['המבורג', 2], ['קלן', 2],
      ['דיסלדורף', 2], ['דרזדן', 2], ['שטוטגרט', 1], ['נירנברג', 2], ['היידלברג', 2],
      ['לייפציג', 1], ['ברמן', 1], ['היער השחור', 2, 'r', ['שוורצוואלד']], ['באדן באדן', 1],
      ['גרמיש', 1]],
    at: [['וינה', 3], ['זלצבורג', 3], ['אינסברוק', 2], ['גראץ', 1], ['האלשטאט', 2],
      ['קיצביהל', 1], ['אישגל', 1]],
    ch: [['ציריך', 3], ["ז'נבה", 3], ['לוצרן', 3], ['אינטרלאקן', 3], ['ברן', 2], ['בזל', 2],
      ['צרמט', 2], ['לוגאנו', 2], ['דאבוס', 2], ['גרינדלוואלד', 2], ['לוזאן', 2],
      ['מונטרה', 1], ['סנט מוריץ', 1], ['יונגפראו', 1]],
    cz: [['פראג', 3], ['קרלובי וארי', 2], ['ברנו', 1], ["צ'סקי קרומלוב", 1]],
    hu: [['בודפשט', 3], ['בלטון', 1]],
    pl: [['ורשה', 3], ['קרקוב', 3], ['גדנסק', 2], ['ורוצלב', 2], ['זקופנה', 2],
      ['אושוויץ', 2], ['פוזנן', 1], ["לודז'", 1]],
    sk: [['ברטיסלבה', 1]],
    si: [['לובליאנה', 2], ['בלד', 2], ['פירן', 1]],
    hr: [['זאגרב', 2], ['דוברובניק', 3], ['ספליט', 3], ['הוואר', 2, 'i'], ['זאדאר', 2],
      ['איסטריה', 2, 'r'], ['רובין', 1], ['פולה', 1], ['פליטביצה', 2]],
    me: [['בודווה', 2], ['קוטור', 2], ['פודגוריצה', 1], ['טיוואט', 1]],
    ba: [['סרייבו', 2], ['מוסטר', 2]],
    rs: [['בלגרד', 2], ['נובי סאד', 1]],
    al: [['טירנה', 2], ['סרנדה', 2], ['קסמיל', 1], ['דורס', 1]],
    mk: [['סקופיה', 2], ['אוחריד', 2]],
    bg: [['סופיה', 2], ['בורגס', 2], ['ורנה', 3], ['בנסקו', 3], ['פלובדיב', 2],
      ['נסבר', 2], ["סאני ביץ'", 2], ['בורובץ', 2], ['פמפורובו', 1]],
    ro: [['בוקרשט', 2], ['בראשוב', 2], ["קלוז'", 2], ['טרנסילבניה', 2, 'r'], ['סיביו', 1],
      ['טימישוארה', 1], ['פויאנה בראשוב', 1]],
    cy: [['לרנקה', 3], ['פאפוס', 3], ['אייה נאפה', 3], ['לימסול', 3], ['ניקוסיה', 2],
      ['פרוטראס', 2], ['טרודוס', 1]],
    tr: [['איסטנבול', 3], ['אנטליה', 3], ['קפדוקיה', 3], ['בודרום', 2], ['איזמיר', 2],
      ['אלניה', 2], ['מרמריס', 2], ['פטהיה', 2], ['אנקרה', 1], ['טרבזון', 1],
      ['קושאדסי', 1], ['פאמוקלה', 2]],
    ge: [['טביליסי', 3], ['בטומי', 3], ['קזבגי', 2], ["בורג'ומי", 1], ['גודאורי', 2],
      ['מצחתה', 1], ['סוואנטי', 1, 'r']],
    am: [['ירוואן', 2], ["דיליז'אן", 1], ['סבאן', 1]],
    az: [['באקו', 2]],
    ru: [['מוסקבה', 2], ['סנט פטרסבורג', 2], ["סוצ'י", 1]],
    ua: [['קייב', 2], ['אודסה', 2], ['לבוב', 2], ['אומן', 2]],
    se: [['שטוקהולם', 3], ['גטבורג', 2], ['מלמו', 1]],
    no: [['אוסלו', 3], ['ברגן', 2], ['טרומסה', 2], ['לופוטן', 2, 'i'], ['סטוונגר', 1],
      ['אלסונד', 1], ['הפיורדים', 2, 'r', ['פיורדים']]],
    dk: [['קופנהגן', 3], ['אורהוס', 1], ['בילונד', 1]],
    fi: [['הלסינקי', 2], ['רובנימי', 2], ['לפלנד', 2, 'r']],
    is: [['רייקיאוויק', 3], ['ויק', 1], ['אקוריירי', 1]],
    lv: [['ריגה', 2]],
    lt: [['וילנה', 2]],
    ee: [['טאלין', 2]],
    ie: [['דבלין', 2], ['גולוויי', 1], ['קורק', 1]],
    mt: [['ולטה', 2], ['סליימה', 1], ['גוזו', 1, 'i']],
    jo: [['פטרה', 3], ['עמאן', 2], ['ואדי רם', 2], ['עקבה', 2]],
    eg: [['קהיר', 2], ['שארם א-שייח', 3, '', ['שארם']], ['דהב', 3], ['טאבה', 3],
      ['נואיבה', 2], ['אלכסנדריה', 1], ['לוקסור', 2], ['הורגדה', 2], ['סיני', 3, 'r'],
      ['רס סודר', 1]],
    ae: [['דובאי', 3], ['אבו דאבי', 3], ['ראס אל חימה', 2], ["שארג'ה", 1]],
    ma: [['מרקש', 3], ['קזבלנקה', 2], ['פס', 2], ['אגדיר', 2], ['רבאט', 1], ['שפשאון', 2],
      ["טנג'יר", 2], ['אסאווירה', 1], ['ורזאזאת', 1], ['מדבר סהרה', 2, 'r', ['סהרה']]],
    tn: [['תוניס', 1], ["ג'רבה", 1]],
    bh: [['מנאמה', 1]],
    th: [['בנגקוק', 3], ['פוקט', 3], ['קו סמוי', 3, 'i', ['סמוי']], ['קו פנגן', 3, 'i', ['פנגן']],
      ["צ'אנג מאי", 3], ['קראבי', 3], ['קו טאו', 2, 'i'], ['פאי', 2], ['קו לנטה', 2, 'i'],
      ['אאו נאנג', 2], ['פטאיה', 2], ['קו פיפי', 2, 'i', ['פיפי']], ["קנצ'נבורי", 2],
      ["צ'אנג ראי", 2], ["קו צ'אנג", 2, 'i'], ['קו סמט', 1, 'i'], ['האט יאי', 1],
      ['איוטהאיה', 1]],
    vn: [['האנוי', 3], ["הו צ'י מין", 3, '', ['סייגון']], ['הוי אן', 3], ['דה נאנג', 2],
      ['האלונג', 3], ['סאפה', 2], ['ניה טראנג', 2], ['פו קווק', 2, 'i'], ['דלאת', 2],
      ['מוי נה', 1], ['נין בין', 2]],
    la: [['לואנג פרבנג', 2], ['ויינטיאן', 2], ['ואנג ויאנג', 2]],
    kh: [['סיאם ריפ', 2], ['פנום פן', 2], ['אנגקור ואט', 2], ['סיהאנוקוויל', 1], ['קמפוט', 1]],
    mm: [['יאנגון', 1], ['באגאן', 1]],
    id: [['באלי', 3, 'i'], ["ג'קרטה", 2], ['גילי', 2, 'i'], ['לומבוק', 2, 'i'],
      ["יוגיאקרטה", 2], ['אובוד', 3], ['נוסה פנידה', 2, 'i'], ['קומודו', 2, 'i'],
      ["ג'אווה", 1, 'i'], ['סומטרה', 1, 'i'], ["צ'אנגו", 2], ['סמיניאק', 2], ['אולובאטו', 1]],
    my: [['קואלה לומפור', 3], ['פנאנג', 2], ['לנקאווי', 2, 'i'], ['בורנאו', 1, 'i'], ['מלאקה', 1]],
    ph: [['מנילה', 2], ['בוראקאי', 2, 'i'], ['פלאוואן', 2, 'i'], ['סבו', 2, 'i'],
      ['אל נידו', 2], ['סיארגאו', 1, 'i']],
    jp: [['טוקיו', 3], ['קיוטו', 3], ['אוסקה', 3], ['הוקאידו', 2, 'i'], ['נארה', 2],
      ['הירושימה', 2], ['הר פוג\'י', 2, '', ["פוג'י"]], ['אוקינאווה', 2, 'i'], ['סאפורו', 2],
      ['קנזאווה', 1], ['האקונה', 2], ['ניסקו', 2], ['נגויה', 1], ['יוקוהמה', 1],
      ['טקאיאמה', 1], ['ניקו', 1]],
    kr: [['סיאול', 2], ['בוסאן', 1], ["ג'ג'ו", 1, 'i']],
    cn: [["בייג'ינג", 2, '', ['פקין']], ['שנחאי', 2], ["גואנגג'ואו", 1], ['שנזן', 1],
      ['שיאן', 1], ["צ'נגדו", 1], ['גויאלין', 1], ['האינאן', 1, 'i'], ['טיבט', 1, 'r'],
      ['חרבין', 1]],
    tw: [['טאיפיי', 1]],
    in: [['דלהי', 3], ['גואה', 3], ['מומבאי', 2], ['רישיקש', 3], ['מנאלי', 3],
      ['דהרמסלה', 2, '', ['דרמסלה']], ['קראלה', 2, 'r'], ['ואראנסי', 2], ['אגרה', 2],
      ["ג'איפור", 2], ["ראג'סטאן", 2, 'r'], ['המפי', 2], ["מקלאוד גאנג'", 2],
      ['לדאק', 2, 'r'], ['קשמיר', 2, 'r'], ['פושקר', 2], ['קסול', 2], ['אמריצר', 1]],
    np: [['קטמנדו', 3], ['פוקרה', 2], ['אנאפורנה', 2, 'r'], ['אוורסט', 2]],
    lk: [['קולומבו', 2], ['קנדי', 2], ['אלה', 2], ['סיגיריה', 2], ['מיריסה', 2],
      ['גאלה', 1], ['ארוגם ביי', 1]],
    us: [['ניו יורק', 3], ["לוס אנג'לס", 3], ['מיאמי', 3], ['לאס וגאס', 3], ['סן פרנסיסקו', 3],
      ['שיקגו', 2], ['בוסטון', 2], ['וושינגטון', 2], ['אורלנדו', 3], ['סיאטל', 2],
      ['סן דייגו', 2], ['הוואי', 3, 'i'], ['אלסקה', 2, 'r'], ['ניו אורלינס', 2],
      ['אוסטין', 1], ['דנבר', 1], ['פילדלפיה', 1], ['אטלנטה', 1], ['יוסטון', 1],
      ['נאשוויל', 1], ['פורטלנד', 1], ['גרנד קניון', 2], ['יוסמיטי', 2], ['ילוסטון', 2],
      ['קליפורניה', 2, 'r'], ['פלורידה', 2, 'r'], ['טקסס', 1, 'r'], ['אספן', 1]],
    ca: [['טורונטו', 2], ['מונטריאול', 2], ['ונקובר', 2], ['קוויבק', 2], ['קלגרי', 1],
      ['אוטווה', 1], ['בנף', 2], ['ניאגרה', 2], ['ויסלר', 1]],
    mx: [['מקסיקו סיטי', 2], ['קנקון', 3], ['טולום', 3], ['פלאיה דל כרמן', 2],
      ['גוודלחרה', 1], ['אואחקה', 2], ['קאבו', 1], ["צ'יצן איצה", 1],
      ['פוארטו וייארטה', 1], ['איסלה מוחרס', 1, 'i']],
    cu: [['הוואנה', 2], ['ורדרו', 2], ['טרינידד', 1]],
    do: [['פונטה קאנה', 2]],
    cr: [['סן חוסה', 1], ['מנואל אנטוניו', 1]],
    gt: [['אנטיגואה', 1], ['אטיטלן', 1], ['טיקאל', 1]],
    pa: [['פנמה סיטי', 1], ['בוקאס דל טורו', 1]],
    br: [["ריו דה ז'ניירו", 3, '', ['ריו']], ['סאו פאולו', 2], ['איגואסו', 2], ['סלבדור', 1],
      ['פלוריאנופוליס', 2], ['אמזונס', 2, 'r'], ['בוזיוס', 1]],
    ar: [['בואנוס איירס', 3], ['פטגוניה', 3, 'r'], ["ברילוצ'ה", 2], ['מנדוסה', 2],
      ['אושואיה', 2], ['אל קלפטה', 2], ['סלטה', 1], ["אל צ'לטן", 1]],
    cl: [['סנטיאגו', 2], ['אטקמה', 2, 'r'], ['איי הפסחא', 1, 'i'], ['ולפראיסו', 1],
      ['טורס דל פיינה', 2], ['פוארטו נטלס', 1]],
    pe: [['קוסקו', 3], ["מאצ'ו פיצ'ו", 3], ['לימה', 2], ['אריקיפה', 2], ['טיטיקקה', 2],
      ["הואקצ'ינה", 2], ['נאסקה', 1]],
    bo: [['לה פאס', 2], ['אויוני', 2], ['סוקרה', 1]],
    co: [['בוגוטה', 2], ['קרטחנה', 2], ["מדיין", 2], ['סנטה מרתה', 1]],
    ec: [['קיטו', 1], ['גלאפגוס', 2, 'i']],
    uy: [['מונטווידאו', 1], ['פונטה דל אסטה', 1]],
    za: [['קייפטאון', 3], ['יוהנסבורג', 2], ['פארק קרוגר', 2, 'r', ['קרוגר']], ['דרבן', 1]],
    ke: [['ניירובי', 2], ['מסאי מארה', 2, 'r']],
    tz: [['זנזיבר', 3, 'i'], ["קילימנג'רו", 2], ['סרנגטי', 2, 'r'], ['ארושה', 1]],
    et: [['אדיס אבבה', 1]],
    na: [['וינדהוק', 1], ['סוסוסוולי', 1]],
    zw: [['מפלי ויקטוריה', 1, '', ['ויקטוריה פולס']]],
    au: [['סידני', 3], ['מלבורן', 3], ['בריסביין', 2], ["פרת'", 2], ['גולד קוסט', 2],
      ['קיירנס', 2], ['אדלייד', 1], ['טסמניה', 1, 'i'], ['אולורו', 1]],
    nz: [['אוקלנד', 2], ['קווינסטאון', 2], ['וולינגטון', 1], ['רוטורואה', 1],
      ["כרייסטצ'רץ'", 1]],
  };

  // countries an Israeli is likely to type straight into the box — everything else
  // starts at 1, which only matters when two names match a query equally well
  const COUNTRY_POP = {
    th: 3, gr: 3, it: 3, es: 3, jp: 3, us: 3, vn: 3, ge: 3, cy: 3, tr: 3, pt: 3, fr: 3,
    nl: 3, gb: 3, de: 3, at: 3, ch: 3, cz: 3, hu: 3, il: 3, in: 3, id: 3, mv: 3, ae: 3,
    hr: 2, si: 2, me: 2, al: 2, bg: 2, ro: 2, pl: 2, rs: 2, mk: 2, ba: 2, mt: 2, is: 2,
    no: 2, se: 2, dk: 2, fi: 2, ie: 2, be: 2, jo: 2, eg: 2, ma: 2, lk: 2, np: 2, kh: 2,
    la: 2, my: 2, ph: 2, sg: 2, kr: 2, cn: 2, tw: 2, au: 2, nz: 2, ca: 2, mx: 2, br: 2,
    ar: 2, cl: 2, pe: 2, bo: 2, co: 2, cu: 2, cr: 2, za: 2, tz: 2, ke: 2, sc: 2, mu: 2,
    am: 2, az: 2, ua: 2, hk: 2, mo: 2, tn: 2,
  };

  // how people actually type a country when the canonical name isn't what comes to
  // hand. Normalisation already strips the punctuation, so one 'ארהב' key answers
  // "ארה\"ב", "ארה״ב" and "ארהב" alike.
  const COUNTRY_ALIASES = {
    us: ['ארהב', 'אמריקה', 'ארצות הברית של אמריקה'],
    gb: ['אנגליה', 'הממלכה המאוחדת', 'בריטניה הגדולה'],
    ae: ['אמירויות', 'איחוד האמירויות הערביות'],
    nl: ['הולנד', 'ארצות השפלה'],
    cz: ['צכיה'],
    vn: ['וייטנם'],
    mk: ['מקדוניה'],
    ba: ['בוסניה'],
    do: ['דומיניקנה', 'רפובליקה דומיניקנית'],
    mv: ['מלדיבים', 'האיים המלדיביים'],
    sc: ['איי סיישל'],
    kr: ['קוריאה'],
    ch: ['שוויץ'],
    th: ['טאילנד'],
    tw: ['טייוואן'],
    gr: ['איי יוון'],
    it: ['איטליה'],
    ru: ['רוסיה'],
    cn: ['סין'],
  };

  // names that carry the definite article, so the CTA reads "טיול לגליל" and not
  // "טיול להגליל". Everything else keeps its name whole ("הודו" → "טיול להודו").
  const DEFINITE = new Set([
    'הגליל', 'הכנרת', 'הנגב', 'הדולומיטים', 'האיים הקנריים', 'האיים האזוריים',
    'היער השחור', 'הפיורדים', 'הפיליפינים', 'הוותיקן', 'הרפובליקה הדומיניקנית',
    'הרפובליקה המרכז אפריקאית',
  ]);

  // --- Hebrew-tolerant normalisation -------------------------------------------------
  // Folds away everything people vary without meaning to: niqqud, geresh, spaces and
  // hyphens ("קו סמוי" = "קוסמוי"), final letters (typing mid-word ן before the נ is
  // typed), and doubled yud/vav ("טוקייו" = "טוקיו", "לאס ווגאס" = "לאס וגאס").
  const FINALS = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
  function norm(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[֑-ׇ]/g, '')
      .replace(/[^א-תa-z0-9]/g, '')
      .replace(/[םןץףך]/g, (c) => FINALS[c])
      .replace(/יי/g, 'י')
      .replace(/וו/g, 'ו');
  }

  // Damerau-Levenshtein between `q` and `k`, capped at `max`. `wholeWord = false`
  // measures `q` against the best PREFIX of `k` instead — "אמסטרד" is a clean typo-free
  // prefix of אמסטרדם, while "פריס" is a whole-word typo of פריז, and the two deserve
  // different scores. Bails the moment every path costs more than `max`, so a miss is
  // a couple of rows of arithmetic.
  function editDist(k, q, max, wholeWord) {
    if (Math.abs(k.length - q.length) > max && (wholeWord || k.length < q.length)) return max + 1;
    let prev2 = new Array(k.length + 1).fill(max + 1);
    let prev = new Array(k.length + 1);
    for (let j = 0; j <= k.length; j++) prev[j] = wholeWord ? j : 0; // free prefix unless whole-word
    let cur = new Array(k.length + 1);
    for (let i = 1; i <= q.length; i++) {
      cur[0] = i;
      let rowMin = i;
      for (let j = 1; j <= k.length; j++) {
        const cost = q[i - 1] === k[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        // two letters typed in the wrong order ("אתנוה") is ONE slip, not two —
        // which needs the row two back, the row where neither letter was consumed
        if (i > 1 && j > 1 && q[i - 1] === k[j - 2] && q[i - 2] === k[j - 1]) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      const t = prev2; prev2 = prev; prev = cur; cur = t;
    }
    return wholeWord ? prev[k.length] : Math.min(...prev);
  }

  // --- index -------------------------------------------------------------------------
  const INDEX = [];
  for (const { name, cc } of COUNTRY_TABLE.all()) {
    INDEX.push({
      name, cc, kind: 'country', country: name, pop: COUNTRY_POP[cc] || 1,
      keys: (COUNTRY_ALIASES[cc] || []).map(norm),
    });
  }
  for (const [cc, rows] of Object.entries(CITIES)) {
    if (COUNTRY_TABLE.isRestricted(cc)) continue;
    const country = COUNTRY_TABLE.nameByCc(cc);
    for (const [name, pop, kind, aliases] of rows) {
      INDEX.push({
        name,
        cc,
        kind: kind === 'i' ? 'island' : kind === 'r' ? 'region' : 'city',
        country,
        pop: pop || 1,
        keys: (aliases || []).map(norm),
      });
    }
  }
  // every entry matches on its own name, on its alternate spellings, and — for the
  // definite ones — on the bare noun people usually type ("גולן", "קנריים")
  for (const d of INDEX) {
    d.keys.unshift(norm(d.name));
    if (DEFINITE.has(d.name)) d.keys.push(norm(d.name.slice(1)));
    d.keys = [...new Set(d.keys)].filter(Boolean);
  }

  const EXACT = 1000, STARTS = 820, NEAR = 720, INSIDE = 620, FUZZY = 540, FLOOR = 380;

  function scoreEntry(d, q) {
    let best = 0;
    for (const k of d.keys) {
      if (k === q) return EXACT;
      let s = 0;
      if (k.startsWith(q)) s = STARTS - Math.min(k.length - q.length, 16) * 4;
      else if (k.includes(q)) s = INSIDE - Math.min(k.length - q.length, 16) * 4;
      else {
        // typo budget grows with the query — two edits inside three letters is noise.
        // A different first letter is almost never a typo and matches half the world,
        // so those get one edit at most ("סנטורני" must not surface אסטוניה).
        let tol = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
        // three letters get an edit only against an equally short name that starts the
        // same way ("פרז" → פריז), which is the one case where the pair can't drift far
        if (q.length === 3) tol = k[0] === q[0] && k.length <= 5 ? 1 : 0;
        else if (k[0] !== q[0]) tol = Math.min(tol, 1);
        if (tol) {
          const whole = editDist(k, q, tol, true);
          if (whole <= tol) s = NEAR - whole * 80;
          else {
            const pre = editDist(k, q, tol, false);
            if (pre <= tol) s = FUZZY - pre * 80 - Math.min(Math.max(k.length - q.length, 0), 16) * 3;
          }
        }
      }
      if (s > best) best = s;
    }
    return best;
  }

  // The whole point of the index: ONE confident answer per query, with a flag on it.
  // Returns [] only when nothing plausible exists — that is the only case where the
  // caller should fall back to free text.
  function search(q, max = 4) {
    const nq = norm(q);
    if (nq.length < 2) return [];
    const hits = [];
    for (const d of INDEX) {
      const base = scoreEntry(d, nq);
      if (base >= FLOOR) hits.push({ ...d, score: base + d.pop * 6 }); // popularity breaks near-ties
    }
    if (!hits.length) return hits;
    hits.sort((a, b) => b.score - a.score || b.pop - a.pop || a.name.length - b.name.length);
    // a confident leader silences the long tail: nobody typing "טוקיו" wants שטוקהולם
    // underneath it, and a shorter list is a faster decision
    const top = hits[0].score;
    const cutoff = top >= EXACT ? top - 150 : top >= STARTS ? top - 300 : top - 70;
    return hits.filter((h) => h.score >= cutoff).slice(0, max);
  }

  // a city hit implies a second, broader trip its country. Appended (never
  // replacing) so "אילת" offers both אילת and ישראל, and deduped against what the
  // search already surfaced.
  function searchWithCountry(q, max = 3) {
    const hits = search(q, max);
    if (!hits.length) return hits;
    const top = hits[0];
    if (top.kind === 'country' || hits.some((h) => h.kind === 'country' && h.cc === top.cc)) {
      return hits.slice(0, max);
    }
    const name = COUNTRY_TABLE.nameByCc(top.cc);
    if (!name) return hits.slice(0, max);
    return [...hits.slice(0, max - 1), {
      name, cc: top.cc, kind: 'country', country: name, pop: COUNTRY_POP[top.cc] || 1, score: 0,
    }];
  }

  const KIND_LABEL = { country: 'מדינה', city: 'עיר', island: 'אי', region: 'אזור' };

  return {
    search,
    searchWithCountry,
    count: INDEX.length,
    // "טיול ל…" with the article handled — the phrase every CTA in the app uses
    tripPhrase: (name) => 'טיול ל' + (DEFINITE.has(name) ? name.slice(1) : name),
    // one line under the CTA: what this place is, and where
    subtitle: (d) => (d.kind === 'country'
      ? KIND_LABEL.country
      : `${KIND_LABEL[d.kind]} ב${DEFINITE.has(d.country) ? d.country.slice(1) : d.country}`),
    normalize: norm,
  };
})();

// the wizard, the homepage and (in Node) the trip builder all resolve destinations
// through this one index — a second copy would drift out of sync with the flags
if (typeof module !== 'undefined' && module.exports) module.exports = DESTINATIONS;
