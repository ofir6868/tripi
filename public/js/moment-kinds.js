// The kinds of moment a trip has, and the words around them — one table for the server
// (lib/moments.js writes the push from it) and the browser (trip-moments.js paints the
// page from it), the same way public/js/countries.js serves both. A kind added here is a
// kind everywhere; a lead time changed here changes when the phone buzzes AND what the
// form offers as the default.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MOMENT_KINDS = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  // `lead`: minutes before the moment the push goes out when nobody said otherwise. Flights
  // long before (the airport is far and slow), a bus close (the ticket is the whole
  // errand), a check-in an hour and a half out (the confirmation and the address are what
  // the desk asks for).
  const KINDS = {
    flight: { emoji: '✈️', label: 'טיסה', lead: 180, hint: 'שעת ההמראה, בשעון שדה היציאה' },
    transport: { emoji: '🚌', label: 'אוטובוס / רכבת / מעבורת', lead: 45, hint: 'שעת היציאה' },
    hotel_checkin: { emoji: '🏨', label: 'צ׳ק-אין במלון', lead: 90, hint: 'מאיזו שעה אפשר להיכנס' },
    hotel_checkout: { emoji: '🧳', label: 'צ׳ק-אאוט', lead: 60, hint: 'עד איזו שעה עוזבים' },
    entry: { emoji: '🛂', label: 'כניסה למדינה', lead: 120, hint: 'שעת הנחיתה — ה-QR לביקורת הגבולות' },
    activity: { emoji: '🎟️', label: 'כרטיס / סיור', lead: 60, hint: 'שעת הכניסה שעל הכרטיס' },
    car: { emoji: '🚗', label: 'איסוף / החזרת רכב', lead: 60, hint: 'שעת האיסוף או ההחזרה' },
    other: { emoji: '⏰', label: 'תזכורת', lead: 60, hint: 'מתי זה קורה' },
  };
  const KIND_KEYS = Object.keys(KINDS);

  // what a moment may carry about itself, and how the page names each field
  const DETAIL_LABELS = {
    code: 'מספר הזמנה', number: 'מספר טיסה / קו', from: 'מ', to: 'אל', seat: 'מושב', gate: 'שער', terminal: 'טרמינל',
    platform: 'רציף', address: 'כתובת', phone: 'טלפון', provider: 'חברה', passenger: 'נוסע', price: 'מחיר', link: 'קישור', note: 'הערה',
  };
  const DETAIL_KEYS = Object.keys(DETAIL_LABELS);

  // the lead times the form offers
  const LEAD_OPTIONS = [
    [15, '15 דקות לפני'], [30, 'חצי שעה לפני'], [45, '45 דקות לפני'], [60, 'שעה לפני'], [90, 'שעה וחצי לפני'],
    [120, 'שעתיים לפני'], [180, '3 שעות לפני'], [240, '4 שעות לפני'], [720, '12 שעות לפני'], [1440, 'יום לפני'],
  ];

  // "עוד 45 דקות", "עוד 3 שעות", "עוד יום" — how far off a moment is; with prefix '' the
  // bare span ("45 דקות לפני")
  function leadText(minutes, { prefix = 'עוד ' } = {}) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 2) return prefix ? 'עכשיו' : 'דקה';
    if (m < 60) return `${prefix}${m} דקות`;
    const h = Math.round(m / 60);
    if (h < 24) return `${prefix}${h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`}`;
    const d = Math.round(h / 24);
    return `${prefix}${d === 1 ? 'יום' : d === 2 ? 'יומיים' : `${d} ימים`}`;
  }

  return { KINDS, KIND_KEYS, DETAIL_KEYS, DETAIL_LABELS, LEAD_OPTIONS, leadText };
});
