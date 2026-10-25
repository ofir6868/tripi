// The checklist's vocabulary — one table for the browser and the server.
//
// A "pro" tag is a colored state an item can carry (לקנות, למצוא אונליין, להזמין מראש…),
// and the server has to validate the same list the page paints and the model is asked
// to choose from. Written once here, under public/ like countries.js, so a tag can never
// be spelled one way in the schema the model sees and another in the chip the traveller
// taps. `later` is special: it is the snooze — an item wearing it leaves the main list
// for the "להמשך" tray until the tag comes off.
const CHECKLIST_TAGS = (() => {
  const TAGS = [
    { key: 'buy', label: 'לקנות', emoji: '🛒', hint: 'צריך לקנות לפני הטיול', color: '#ffb45f' },
    { key: 'online', label: 'למצוא אונליין', emoji: '🔎', hint: 'לחפש, להשוות ולהזמין ברשת', color: '#8fd8c4' },
    { key: 'book', label: 'להזמין מראש', emoji: '📅', hint: 'מקומות שנגמרים — מזמינים לפני', color: '#c9a7ff' },
    { key: 'print', label: 'להדפיס', emoji: '🖨️', hint: 'עותק פיזי לתיק', color: '#a9c3e8' },
    { key: 'pack', label: 'לארוז', emoji: '🎒', hint: 'נכנס למזוודה', color: '#9be37d' },
    { key: 'ask', label: 'לברר', emoji: '❓', hint: 'שאלה פתוחה שצריך לסגור', color: '#7fd3f7' },
    { key: 'urgent', label: 'דחוף', emoji: '🔥', hint: 'לא מחכה למחר', color: '#ff7a6e' },
    { key: 'later', label: 'להמשך', emoji: '⏳', hint: 'נדחה — יוצא מהרשימה הראשית', color: '#9a9a9a' },
  ];
  const KEYS = TAGS.map((t) => t.key);
  const byKey = Object.fromEntries(TAGS.map((t) => [t.key, t]));

  // "how many days before departure" an item is due — the only calendar the list has.
  // A trip without dates still shows the label ("שבוע לפני"); with dates it becomes a day.
  const DUE_OPTIONS = [
    { days: null, label: 'בלי מועד' },
    { days: 60, label: 'חודשיים לפני' },
    { days: 30, label: 'חודש לפני' },
    { days: 14, label: 'שבועיים לפני' },
    { days: 7, label: 'שבוע לפני' },
    { days: 3, label: '3 ימים לפני' },
    { days: 1, label: 'יום לפני' },
    { days: 0, label: 'ביום היציאה' },
  ];
  const dueLabel = (days) => {
    if (days === null || days === undefined) return '';
    const hit = DUE_OPTIONS.find((o) => o.days === days);
    return hit ? hit.label : `${days} ימים לפני`;
  };

  const SCOPES = ['shared', 'personal'];

  // the quick-add box reads "#לקנות מתאם" / "#buy adapter" / "!דחוף" — hashtags by key,
  // Hebrew label or emoji, and a leading "!" for urgent
  const aliases = {};
  for (const t of TAGS) {
    aliases[t.key] = t.key;
    aliases[t.label.replace(/\s+/g, '')] = t.key;
    aliases[t.emoji] = t.key;
  }
  Object.assign(aliases, { אונליין: 'online', להזמין: 'book', הזמנה: 'book', קניה: 'buy', קנייה: 'buy', אריזה: 'pack', לארוז: 'pack', דחוף: 'urgent', later: 'later', snooze: 'later' });
  function parseQuickAdd(text) {
    const tags = new Set();
    let title = String(text || '').trim();
    if (title.startsWith('!')) { tags.add('urgent'); title = title.slice(1).trim(); }
    title = title.replace(/#([^\s#]+)/g, (m, word) => {
      const k = aliases[word.replace(/\s+/g, '')];
      if (k) { tags.add(k); return ''; }
      return m;
    }).replace(/\s{2,}/g, ' ').trim();
    return { title, tags: [...tags] };
  }

  return { TAGS, KEYS, byKey, DUE_OPTIONS, dueLabel, SCOPES, parseQuickAdd };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CHECKLIST_TAGS;
