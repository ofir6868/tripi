# TRIPI · טריפי 🧭

מתכנן טיולים בעברית — בונים מסלול יום-אחר-יום, מקבלים קוד שיתוף בן 6 ספרות, ושולחים לחברים.

## מה יש בפנים

- **עמוד בית** עם חיפוש יעדים / קוד טיול וקרוסלת טיולים מומלצים
- **עמוד טיול** עם מסלול יומי, קישורי גוגל מפות לכל תחנה, מפה מוטמעת וכרטיס שיתוף בסגנון כרטיס עלייה למטוס
- **אשף תכנון** בשלושה צעדים
- **חשבונות משתמשים** (JWT + bcrypt) ועמוד "הטיולים שלי"
- **WebMCP** — כלים בשם לסוכני AI, במקום ניחושים על ה-DOM (ראו למטה)

## סטאק

- Node.js + Express, PostgreSQL (Render)
- Frontend: HTML/CSS/JS ללא פריימוורק, RTL מלא, עיצוב זכוכית
- APIs חינמיים ללא מפתח: Open-Meteo (חיזוי מזג אוויר + Geocoding לאוטוקומפליט יעדים בעברית), OSM Overpass (מלונות באזור, עם קאש בצד השרת), Google Maps Embed

## WebMCP — ממשק לסוכני AI

האתר מצהיר על עצמו לסוכנים דרך [WebMCP](https://webmachinelearning.github.io/webmcp/): במקום שסוכן ינחש איפה
לוחצים, הדף מגיש לו כלים בשם, עם סכימת קלט ותוצאה מובנית.

הכלים נרשמים לכל מארח שהדפדפן חושף, לפי הסדר: `document.modelContext` (הטיוטה של W3C),
`navigator.modelContext` (Edge 147 / ה-origin trial של Chrome 149), ובכל מקרה גם `window.tripiTools` —
גשר משלנו. הגשר הוא זה שעובד היום בפועל: תמיכה נייטיבית עדיין דקה, ורוב הסוכנים שמגיעים לאתר עושים זאת
דרך דפדפן headless שבו הערוץ היחיד הוא הרצת JS.

```js
window.tripiTools.host              // 'document' | 'navigator' | null
window.tripiTools.list()            // כל הכלים: שם, תיאור, inputSchema, annotations
await window.tripiTools.call(name, input)
```

התוצאה תמיד באותו מבנה — `content` קריא לאדם ו-`structuredContent` לפרסור. כישלון חוזר כתוצאה עם
`isError: true` ולא כחריגה, כדי שסוכן יוכל לקרוא את הסיבה ולנסות מהלך אחר.

**בכל דף** (`webmcp-tools.js`): `tripmaker_whoami` · `tripmaker_search_trips` ·
`tripmaker_list_suggested_trips` · `tripmaker_get_trip` · `tripmaker_list_my_trips` ·
`tripmaker_search_destinations` · `tripmaker_create_trip` · `tripmaker_open`

**רק כשטיול פתוח** (נרשמים מ-`trip.js`): `tripmaker_current_trip` · `tripmaker_add_stop` ·
`tripmaker_update_stop` · `tripmaker_delete_stop`

כלי התחנות עוברים דרך `addItem`/`saveItem`/`deleteItem` של הדף עצמו, לא ישר ל-API — כך עריכה של סוכן
מתרנדרת בשתי התצוגות בדיוק כמו עריכה של אדם, במקום להשאיר על המסך מסלול שכבר לא קיים.

הערות אבטחה: כלי קריאה מסומנים `readOnlyHint`, וכל כלי שמחזיר תוכן שנוצר על ידי משתמשים אחרים מסומן גם
`untrustedContentHint`. הרשאות לא נעקפות — הכלים רוכבים על אותו JWT ואותן בדיקות הרשאה של ה-API, וסוכן
לא מתחבר בשם המשתמש. `/admin` לא טוען את הכלים בכוונה.

## הרצת מיגרציות

`node db/migrate.js` — עמודת destinations (ריבוי יעדים + קואורדינטות), אידמפוטנטי.

## הרצה מקומית

```bash
npm install
# צרו קובץ .env עם:
# DATABASE_URL=postgresql://...
node db/setup.js   # פעם אחת: סכימה + טיולים מומלצים
npm start          # http://localhost:3000
```

## משתני סביבה

| משתנה | תיאור |
|---|---|
| `DATABASE_URL` | כתובת חיבור ל-PostgreSQL |
| `JWT_SECRET` | סוד לחתימת טוקנים |
| `PORT` | פורט (ברירת מחדל 3000) |
