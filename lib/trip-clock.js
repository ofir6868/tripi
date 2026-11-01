// What day it is — for the model.
//
// Until 2026-11-01 neither chat knew today's date. A traveller in Takayama wrote "we're
// here today and tomorrow, today is the day we arrived" and the planner answered "to put
// that on the board — what is today's date?". A model has no clock: whatever it
// believes "today" is comes from its training, which is a year stale at best. So every
// prompt that may touch dates carries this block — today in Israel (where the
// travellers usually plan from) AND at the destination (where "tonight" happens once
// they land), which day of the trip today is, and the calendar date of every trip day,
// so "tomorrow", "on the arrival day" and "the last Friday" are arithmetic the model
// can do on the page instead of a question it asks back.
//
// Pure functions, no network: the destination's zone is passed in (lib/moments.js
// tzForTrip knows it, cached for a year) and a missing one simply leaves that half out.
const ISRAEL_TZ = 'Asia/Jerusalem';
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const WEEKDAY_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// A DATE column comes back from pg as a JS Date at local midnight of the server — read
// its local parts, never toISOString() (east of UTC that rolls back a day). A string is
// taken as written.
function isoOf(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const utcOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (iso, n) => new Date(utcOf(iso) + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (fromIso, toIso) => Math.round((utcOf(toIso) - utcOf(fromIso)) / 86400000);
const weekday = (iso) => new Date(utcOf(iso)).getUTCDay();

// the wall clock of a zone at an instant → { date: 'YYYY-MM-DD', time: 'HH:MM' }
function wallClock(tz, now = new Date()) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const p = {};
    for (const { type, value } of f.formatToParts(now)) p[type] = value;
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  } catch {
    return null;
  }
}

const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `יום ${WEEKDAYS[weekday(iso)]}, ${d} ב${MONTHS[m - 1]} ${y}`;
};
const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}.${m}`; };

// the calendar date of trip day n, or null for an undated trip
function dayDate(trip, n) {
  const start = isoOf(trip && trip.start_date);
  return start ? addDays(start, n - 1) : null;
}

// "יום 3 (28.10, ד׳)" — the label the itinerary lines carry, so a stop's date is read,
// not computed
function dayLabel(trip, n) {
  const iso = dayDate(trip, n);
  return iso ? `יום ${n} (${shortDate(iso)}, ${WEEKDAY_SHORT[weekday(iso)]})` : `יום ${n}`;
}

// where today sits against the trip: before / during (with the day number) / after
function tripPhase(trip, todayIso) {
  const start = isoOf(trip && trip.start_date);
  if (!start) return { phase: 'undated' };
  const days = Math.max(parseInt(trip.days, 10) || 1, 1);
  const n = dayDiff(start, todayIso) + 1;
  if (n < 1) return { phase: 'before', inDays: 1 - n };
  if (n > days) return { phase: 'after', agoDays: n - days };
  return { phase: 'during', day: n };
}

// The block itself. `tz`: the destination's IANA zone or null; `now` is injectable for
// the check script.
function promptBlock(trip, { tz = null, now = new Date() } = {}) {
  const il = wallClock(ISRAEL_TZ, now);
  const there = tz && tz !== ISRAEL_TZ ? wallClock(tz, now) : null;
  const lines = [];
  lines.push(`היום: ${longDate(il.date)} (${il.date}), השעה ${il.time} בישראל.`);
  if (there) {
    lines.push(`ביעד (${tz}) עכשיו ${there.time}${there.date !== il.date ? `, ${longDate(there.date)} (${there.date})` : ''}.`);
  }
  // "today" for the trip is the destination's day once the trip is under way — that is
  // where the travellers are — and Israel's before it starts
  const start = isoOf(trip && trip.start_date);
  const days = Math.max(parseInt(trip && trip.days, 10) || 1, 1);
  const during = start && there ? tripPhase(trip, there.date) : null;
  const today = during && during.phase === 'during' ? there.date : il.date;
  const ph = tripPhase(trip, today);
  if (ph.phase === 'undated') {
    lines.push(`לטיול אין עדיין תאריך יציאה (${days} ימים).`);
  } else {
    lines.push(`תאריכי הטיול: ${start} עד ${addDays(start, days - 1)} (${days} ימים).`);
    if (ph.phase === 'before') lines.push(`הטיול עוד לא התחיל — יוצאים בעוד ${ph.inDays} ימים.`);
    else if (ph.phase === 'during') lines.push(`המטיילים בטיול עכשיו: היום הוא יום ${ph.day} מתוך ${days}${ph.day < days ? `, ומחר יום ${ph.day + 1}` : ' — היום האחרון'}.`);
    else lines.push(`הטיול הסתיים לפני ${ph.agoDays} ימים.`);
    // every trip day with its date and weekday — a 60-day trip is still one line
    const cal = [];
    for (let n = 1; n <= days; n++) {
      const iso = addDays(start, n - 1);
      cal.push(`${n}=${shortDate(iso)} ${WEEKDAY_SHORT[weekday(iso)]}`);
    }
    lines.push(`לוח הימים: ${cal.join(' | ')}`);
  }
  return lines.join('\n');
}

// The rule that goes with it, in the allowed shape (PLAYBOOK §3): what to do with
// relative time, not "don't ask".
const PROMPT_RULES =
`זמן ותאריכים: התאריך והשעה של היום כתובים למעלה ("היום:") והם האמת — גם אם הם נראים לכם מאוחרים ממה שאתם מכירים. כל ביטוי יחסי — "היום", "מחר", "מחרתיים", "בעוד שבוע", "ביום ההגעה", "בשישי הקרוב" — מתרגמים בעצמכם לתאריך ולמספר יום בעזרת לוח הימים, ופועלים לפיו באותו תור. את התאריך של היום לעולם לא שואלים את המטיילים.
- כשהמטיילים מספרים איפה הם נמצאים עכשיו או מה קורה היום ("אנחנו היום ומחר בטקאיאמה", "היום יום ההגעה", "נחתנו") — זו עובדה שנמסרה: מעדכנים את הטיול כך שיתאים (dates_set כשיום 1 צריך לזוז להיום או כשאורך הטיול משתנה, ops לתחנות של היום ומחר) עם commit=true, ואומרים ב-text מה עדכנתם.
- לטיול בלי תאריך יציאה: כשהמטיילים אומרים שהטיול התחיל היום, או נותנים תאריך — dates_set.`;

module.exports = { ISRAEL_TZ, isoOf, addDays, dayDiff, dayDate, dayLabel, tripPhase, wallClock, promptBlock, PROMPT_RULES };
