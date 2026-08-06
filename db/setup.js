// One-time database setup: schema + seed of curated public trips.
// Usage: DATABASE_URL=postgres://... node db/setup.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  owner_id INT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  country TEXT,
  description TEXT,
  cover_image TEXT,
  start_date DATE,
  end_date DATE,
  days INT DEFAULT 1,
  share_code CHAR(6) UNIQUE NOT NULL,
  is_public BOOLEAN DEFAULT false,
  emoji TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trip_items (
  id SERIAL PRIMARY KEY,
  trip_id INT REFERENCES trips(id) ON DELETE CASCADE,
  day_number INT NOT NULL DEFAULT 1,
  time_label TEXT,
  title TEXT NOT NULL,
  note TEXT,
  place_query TEXT,
  category TEXT,
  sort_order INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trips_share_code ON trips(share_code);
CREATE INDEX IF NOT EXISTS idx_trips_public ON trips(is_public);
CREATE INDEX IF NOT EXISTS idx_items_trip ON trip_items(trip_id);
`;

const U = (id, w = 1200) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

const TRIPS = [
  {
    title: 'קסם הקיקלדים', destination: 'סנטוריני', country: 'יוון', emoji: '🏛️',
    share_code: '284917', days: 4,
    cover_image: U('photo-1613395877344-13d4a8e0d49e'),
    description: 'ארבעה ימים של בתים לבנים, כיפות כחולות ושקיעות שאין כמותן באיה. טיול רגוע עם הרבה ים, יין מקומי וכפרים תלויים על צוק.',
    items: [
      { day: 1, time: '10:00', title: 'נחיתה והתמקמות בפירה', note: 'צ׳ק-אין במלון עם נוף לקלדרה', place: 'Fira Santorini', cat: 'לינה' },
      { day: 1, time: '13:00', title: 'ארוחת צהריים יוונית', note: 'סלט יווני, סובלאקי וצלחת מזטים', place: 'Fira restaurants', cat: 'אוכל' },
      { day: 1, time: '18:30', title: 'שקיעה ראשונה מהקלדרה', note: 'להגיע חצי שעה לפני השקיעה לתפוס מקום', place: 'Caldera view Fira', cat: 'נוף' },
      { day: 2, time: '09:00', title: 'הליכה מפירה לאיה', note: 'מסלול של כ-3 שעות לאורך הצוק — נעלי הליכה!', place: 'Fira to Oia hike', cat: 'טבע' },
      { day: 2, time: '17:00', title: 'שיטוט באיה', note: 'הסמטאות, הכיפות הכחולות והגלריות', place: 'Oia Santorini', cat: 'עיר' },
      { day: 3, time: '10:00', title: 'חוף אדום', note: 'חוף געשי מרשים — כדאי להגיע מוקדם', place: 'Red Beach Santorini', cat: 'ים' },
      { day: 3, time: '15:00', title: 'טעימות יין ביקב סנטו', note: 'יין אסירטיקו עם נוף לשקיעה', place: 'Santo Wines Santorini', cat: 'אוכל' },
      { day: 4, time: '09:00', title: 'שייט בקלדרה', note: 'שייט למעיינות החמים והאי הגעשי', place: 'Santorini volcano tour', cat: 'ים' },
    ],
  },
  {
    title: 'רומא בארבעה ימים', destination: 'רומא', country: 'איטליה', emoji: '🍕',
    share_code: '731502', days: 4,
    cover_image: U('photo-1552832230-c0197dd311b5'),
    description: 'העיר הנצחית: קולוסיאום, ותיקן, פסטה קאצ׳ו אה פפה וג׳לטו בכל פינה. מסלול הליכה נוח שמכסה את כל הקלאסיקות בלי להתרוצץ.',
    items: [
      { day: 1, time: '09:00', title: 'הקולוסיאום', note: 'להזמין כרטיסים מראש באתר הרשמי', place: 'Colosseum Rome', cat: 'היסטוריה' },
      { day: 1, time: '12:00', title: 'הפורום הרומאי והפלטין', note: 'כלול באותו כרטיס של הקולוסיאום', place: 'Roman Forum', cat: 'היסטוריה' },
      { day: 1, time: '19:00', title: 'ערב בטרסטוורה', note: 'השכונה הכי שווה לארוחת ערב', place: 'Trastevere Rome', cat: 'אוכל' },
      { day: 2, time: '08:30', title: 'מוזיאוני הותיקן והקפלה הסיסטינית', note: 'להגיע מוקדם! הזמנה מראש חובה', place: 'Vatican Museums', cat: 'אמנות' },
      { day: 2, time: '14:00', title: 'בזיליקת פטרוס הקדוש', note: 'עלייה לכיפה — 551 מדרגות ונוף מטורף', place: 'St Peters Basilica', cat: 'היסטוריה' },
      { day: 3, time: '10:00', title: 'מזרקת טרווי והפנתאון', note: 'לזרוק מטבע ולהיכנס לפנתאון (חינם)', place: 'Trevi Fountain', cat: 'עיר' },
      { day: 3, time: '13:00', title: 'פסטה בקמפו דה פיורי', note: 'קאצ׳ו אה פפה או קרבונרה אמיתית', place: 'Campo de Fiori Rome', cat: 'אוכל' },
      { day: 4, time: '10:00', title: 'וילה בורגזה', note: 'שכירת סירה באגם וגלריית בורגזה', place: 'Villa Borghese Rome', cat: 'טבע' },
    ],
  },
  {
    title: 'טוקיו בין ניאון למקדשים', destination: 'טוקיו', country: 'יפן', emoji: '🗼',
    share_code: '590346', days: 5,
    cover_image: U('photo-1540959733332-eab4deabeeaf'),
    description: 'חמישה ימים בעיר שלא מפסיקה להפתיע: מקדשים שקטים, מעברי חצייה מטורפים, ראמן בצ׳ופסטיקס וקניות בשיבויה. ',
    items: [
      { day: 1, time: '10:00', title: 'מקדש סנסוג׳י באסקוסה', note: 'המקדש העתיק בטוקיו + רחוב נקמיסה לקניות', place: 'Sensoji Temple Tokyo', cat: 'תרבות' },
      { day: 1, time: '18:00', title: 'מגדל טוקיו סקייטרי', note: 'נוף לילה על כל העיר', place: 'Tokyo Skytree', cat: 'נוף' },
      { day: 2, time: '09:00', title: 'שוק הדגים טסוקיג׳י', note: 'ארוחת בוקר של סושי טרי', place: 'Tsukiji Market Tokyo', cat: 'אוכל' },
      { day: 2, time: '14:00', title: 'שיבויה קרוסינג והאצ׳יקו', note: 'מעבר החצייה המפורסם בעולם', place: 'Shibuya Crossing', cat: 'עיר' },
      { day: 3, time: '10:00', title: 'הרג׳וקו ורחוב טקשיטה', note: 'אופנה, קרפים וחנויות מוזרות', place: 'Takeshita Street Harajuku', cat: 'קניות' },
      { day: 3, time: '13:00', title: 'מקדש מייג׳י', note: 'יער שקט באמצע העיר', place: 'Meiji Shrine Tokyo', cat: 'תרבות' },
      { day: 4, time: '09:00', title: 'יום טיול להאקונה', note: 'אונסן, רכבל ונוף להר פוג׳י', place: 'Hakone Japan', cat: 'טבע' },
      { day: 5, time: '11:00', title: 'אקיהברה', note: 'גיימינג, אנימה ואלקטרוניקה', place: 'Akihabara Tokyo', cat: 'קניות' },
    ],
  },
  {
    title: 'ליסבון והחוף הפורטוגלי', destination: 'ליסבון', country: 'פורטוגל', emoji: '🚋',
    share_code: '417829', days: 4,
    cover_image: U('photo-1585208798174-6cedd86e019a'),
    description: 'חשמליות צהובות, אריחי אזולז׳ו, פסטל דה נאטה חם מהתנור ויום קסום בסינטרה. הטיול המושלם לסופ״ש ארוך.',
    items: [
      { day: 1, time: '10:00', title: 'שכונת אלפמה', note: 'ללכת לאיבוד בסמטאות ולעלות על חשמלית 28', place: 'Alfama Lisbon', cat: 'עיר' },
      { day: 1, time: '17:00', title: 'נקודת תצפית סאו ז׳ורז׳ה', note: 'הטירה עם הנוף הכי יפה בעיר', place: 'Sao Jorge Castle', cat: 'נוף' },
      { day: 2, time: '09:30', title: 'בלם: מגדל ומנזר', note: 'פסטל דה נאטה המקורי ב-Pasteis de Belem', place: 'Belem Tower Lisbon', cat: 'היסטוריה' },
      { day: 2, time: '15:00', title: 'שקיעה בברייו אלטו', note: 'ברים, פאדו ואווירה', place: 'Bairro Alto Lisbon', cat: 'חיי לילה' },
      { day: 3, time: '09:00', title: 'יום שלם בסינטרה', note: 'ארמון פנה הצבעוני וקינטה דה רגליירה', place: 'Pena Palace Sintra', cat: 'טבע' },
      { day: 3, time: '17:00', title: 'קאבו דה רוקה', note: 'הנקודה המערבית ביותר של אירופה', place: 'Cabo da Roca', cat: 'נוף' },
      { day: 4, time: '10:00', title: 'שוק טיים אאוט', note: 'כל האוכל הפורטוגלי במקום אחד', place: 'Time Out Market Lisbon', cat: 'אוכל' },
    ],
  },
  {
    title: 'איי תאילנד: קופנגן וקוסמוי', destination: 'קו פנגן', country: 'תאילנד', emoji: '🥥',
    share_code: '863054', days: 7,
    cover_image: U('photo-1552465011-b4e21bf6e79a'),
    description: 'שבוע של חופים לבנים, קוקוסים, מסאז׳ תאילנדי ופאד תאי על החוף. השילוב המנצח של שקט ומסיבות — בקצב שלכם.',
    items: [
      { day: 1, time: '12:00', title: 'הגעה לקוסמוי', note: 'מעבורת או טיסה פנימית מבנגקוק', place: 'Koh Samui', cat: 'לינה' },
      { day: 2, time: '10:00', title: 'חוף צ׳אוונג', note: 'החוף המרכזי — ג׳ט סקי ושמש', place: 'Chaweng Beach', cat: 'ים' },
      { day: 3, time: '09:00', title: 'מעבורת לקופנגן', note: 'כ-30 דקות שיט', place: 'Koh Phangan', cat: 'תחבורה' },
      { day: 3, time: '16:00', title: 'שקיעה בזן ביץ׳', note: 'החוף הכי רגוע באי', place: 'Zen Beach Koh Phangan', cat: 'ים' },
      { day: 4, time: '10:00', title: 'מפל פאנג', note: 'טרק קצר ובריכה טבעית', place: 'Phaeng Waterfall', cat: 'טבע' },
      { day: 5, time: '11:00', title: 'בוטל ביץ׳', note: 'מגיעים בסירה או בטרק — גן עדן קטן', place: 'Bottle Beach Koh Phangan', cat: 'ים' },
      { day: 6, time: '18:00', title: 'שוק לילה בתונגסלה', note: 'אוכל רחוב תאילנדי אמיתי', place: 'Thongsala Night Market', cat: 'אוכל' },
      { day: 7, time: '20:00', title: 'מסיבת ירח מלא (אם יוצא)', note: 'האדרין ביץ׳ — לבדוק תאריכים מראש', place: 'Haad Rin Beach', cat: 'חיי לילה' },
    ],
  },
  {
    title: 'ניו יורק קלאסית', destination: 'ניו יורק', country: 'ארה"ב', emoji: '🗽',
    share_code: '925471', days: 5,
    cover_image: U('photo-1496442226666-8d4d0e62e6e9'),
    description: 'התפוח הגדול בחמישה ימים: סנטרל פארק, ברוקלין, מחזמר בברודווי ופיצה במשולשים ענקיים. עיר שלא ישנה — וגם אתם לא תרצו.',
    items: [
      { day: 1, time: '10:00', title: 'טיימס סקוור ומידטאון', note: 'להתחיל מהלב הפועם', place: 'Times Square NYC', cat: 'עיר' },
      { day: 1, time: '20:00', title: 'מחזמר בברודווי', note: 'כרטיסי הנחה בדוכן TKTS באותו יום', place: 'Broadway theater NYC', cat: 'תרבות' },
      { day: 2, time: '09:00', title: 'סנטרל פארק', note: 'השכרת אופניים או פיקניק על הדשא', place: 'Central Park NYC', cat: 'טבע' },
      { day: 2, time: '14:00', title: 'מוזיאון המט', note: 'אחד המוזיאונים הגדולים בעולם', place: 'Metropolitan Museum NYC', cat: 'אמנות' },
      { day: 3, time: '09:00', title: 'פסל החירות ואליס איילנד', note: 'מעבורת מבטרי פארק — להזמין מראש', place: 'Statue of Liberty', cat: 'היסטוריה' },
      { day: 3, time: '16:00', title: 'וול סטריט והשור', note: 'הרובע הפיננסי ואנדרטת ה-9/11', place: 'Wall Street NYC', cat: 'עיר' },
      { day: 4, time: '10:00', title: 'גשר ברוקלין ברגל', note: 'לחצות לדמבו ולצלם את קו הרקיע', place: 'Brooklyn Bridge', cat: 'נוף' },
      { day: 4, time: '13:00', title: 'פיצה בברוקלין', note: 'Juliana’s או Grimaldi’s — שווה את התור', place: 'Juliana’s Pizza Brooklyn', cat: 'אוכל' },
      { day: 5, time: '11:00', title: 'הביג ליין וצ׳לסי מרקט', note: 'פארק על פסי רכבת ישנים', place: 'High Line NYC', cat: 'עיר' },
    ],
  },
  {
    title: 'פריז של הרגעים הקטנים', destination: 'פריז', country: 'צרפת', emoji: '🥐',
    share_code: '308156', days: 4,
    cover_image: U('photo-1502602898657-3e91760cbb34'),
    description: 'קרואסון חמאתי בבוקר, שיטוט לאורך הסן, מונמארטר בשקיעה ומגדל אייפל שנוצץ בלילה. פריז כמו שצריך — לאט.',
    items: [
      { day: 1, time: '09:00', title: 'מגדל אייפל', note: 'לעלות ברגל לקומה השנייה — תור קצר יותר', place: 'Eiffel Tower', cat: 'נוף' },
      { day: 1, time: '13:00', title: 'פיקניק בשאן דה מארס', note: 'באגט, גבינות ויין מהשוק', place: 'Champ de Mars Paris', cat: 'אוכל' },
      { day: 2, time: '09:00', title: 'מוזיאון הלובר', note: 'להזמין כרטיס מראש ולבחור 3 אגפים בלבד', place: 'Louvre Museum', cat: 'אמנות' },
      { day: 2, time: '15:00', title: 'שיטוט במארה', note: 'פלאפל ברחוב רוזייה וחנויות וינטג׳', place: 'Le Marais Paris', cat: 'עיר' },
      { day: 3, time: '10:00', title: 'מונמארטר והסקרה קר', note: 'הרובע של האמנים — לעלות בפוניקולר', place: 'Sacre Coeur Montmartre', cat: 'תרבות' },
      { day: 3, time: '19:00', title: 'שייט על הסן בשקיעה', note: 'באטו מוש — שעה של קסם', place: 'Seine river cruise Paris', cat: 'נוף' },
      { day: 4, time: '10:00', title: 'גני לוקסמבורג', note: 'קפה וקרואסון על כיסא ירוק מול הבריכה', place: 'Luxembourg Gardens Paris', cat: 'טבע' },
    ],
  },
  {
    title: 'סופ״ש בצפון: גולן וגליל', destination: 'רמת הגולן', country: 'ישראל', emoji: '⛰️',
    share_code: '652093', days: 3,
    cover_image: U('photo-1544971587-b842c27f8e14'),
    description: 'שלושה ימים של מסלולי מים, יקבים, זיתים וג׳יפים. הטיול המושלם בלי לעלות על מטוס — צימר, מנגל ושקיעה על הכנרת.',
    items: [
      { day: 1, time: '09:00', title: 'נחל ג׳ילבון', note: 'מסלול מים עם מפל דבורה — כ-3 שעות', place: 'Gilabun stream Golan', cat: 'טבע' },
      { day: 1, time: '14:00', title: 'יקב ברקן או יקב גולן', note: 'סיור וטעימות בקצרין', place: 'Golan Heights Winery Katzrin', cat: 'אוכל' },
      { day: 1, time: '18:00', title: 'צ׳ק-אין בצימר', note: 'ג׳קוזי ומרפסת נוף — להזמין מראש', place: 'Merom Golan', cat: 'לינה' },
      { day: 2, time: '08:30', title: 'הר בנטל', note: 'תצפית על החרמון וסוריה + קפה אנן', place: 'Mount Bental', cat: 'נוף' },
      { day: 2, time: '11:00', title: 'עין זיוון וטעימות שוקולד', note: 'דה קרינה — סדנת שוקולד', place: 'Ein Zivan Golan', cat: 'אוכל' },
      { day: 2, time: '16:00', title: 'שקיעה על הכנרת', note: 'חוף גופרה או מצפה אופיר', place: 'Sea of Galilee viewpoint', cat: 'נוף' },
      { day: 3, time: '09:00', title: 'נחל יהודייה', note: 'מהמסלולים היפים בארץ — כולל בריכות', place: 'Yehudiya stream', cat: 'טבע' },
    ],
  },
];

async function main() {
  console.log('Creating schema...');
  await pool.query(SCHEMA);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM trips WHERE is_public = true');
  if (rows[0].n > 0) {
    console.log(`Seed skipped — ${rows[0].n} public trips already exist.`);
    await pool.end();
    return;
  }

  console.log('Seeding suggested trips...');
  for (const t of TRIPS) {
    const res = await pool.query(
      `INSERT INTO trips (title, destination, country, description, cover_image, days, share_code, is_public, emoji)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING id`,
      [t.title, t.destination, t.country, t.description, t.cover_image, t.days, t.share_code, t.emoji]
    );
    const tripId = res.rows[0].id;
    for (let i = 0; i < t.items.length; i++) {
      const it = t.items[i];
      await pool.query(
        `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tripId, it.day, it.time, it.title, it.note, it.place, it.cat, i]
      );
    }
    console.log(`  + ${t.title} (${t.share_code})`);
  }
  console.log('Done.');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
