// Where a trip sits in the traveller's time: ahead, under way, behind, or not yet
// dated — and the words for it. One definition for every page that lists trips
// ("הטיולים שלי", the homepage's "the next trip" card), so a trip can't be "in 3
// days" on one screen and "in 2" on another.
//
// Dates arrive the way pg serialises a DATE column (midnight, ISO) or as a bare
// "YYYY-MM-DD"; both are read the way trip.js reads them — as the local calendar
// day — so the countdown here and the day numbers on the trip page agree.
const TripWhen = (() => {
  const DAY = 864e5;
  const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

  const localDay = (v) => {
    if (!v) return null;
    const s = String(v);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
    if (isNaN(d)) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const diffDays = (a, b) => Math.round((a - b) / DAY);

  // { phase: 'now'|'next'|'past'|'undated', start, end, days, inDays, dayNo, agoDays }
  function of(t) {
    const start = localDay(t.start_date);
    const days = Math.max(1, +t.days || 1);
    if (!start) return { phase: 'undated', days };
    let end = localDay(t.end_date);
    if (!end || end < start) { end = new Date(start); end.setDate(end.getDate() + days - 1); }
    const now = today();
    if (now < start) return { phase: 'next', start, end, days, inDays: diffDays(start, now) };
    if (now > end) return { phase: 'past', start, end, days, agoDays: diffDays(now, end) };
    return { phase: 'now', start, end, days, dayNo: diffDays(now, start) + 1, total: diffDays(end, start) + 1 };
  }

  // "12–16 באוק׳" · "28 בנוב׳ – 3 בדצמ׳" · a year only when it isn't this one
  function range(w) {
    if (!w.start) return '';
    const { start: a, end: b } = w;
    const yr = (d) => (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
    if (+a === +b) return `${a.getDate()} ב${MONTHS[a.getMonth()]}${yr(a)}`;
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
      return `${a.getDate()}–${b.getDate()} ב${MONTHS[a.getMonth()]}${yr(a)}`;
    }
    return `${a.getDate()} ב${MONTHS[a.getMonth()]}${a.getFullYear() !== b.getFullYear() ? yr(a) : ''} – ${b.getDate()} ב${MONTHS[b.getMonth()]}${yr(b)}`;
  }

  const plural = (n, one, two, many) => (n === 1 ? one : n === 2 ? two : `${n} ${many}`);

  // the short phrase on a row's chip
  function label(w) {
    if (w.phase === 'now') return w.total > 1 ? `יום ${w.dayNo} מתוך ${w.total}` : 'היום!';
    if (w.phase === 'next') {
      const n = w.inDays;
      if (n === 0) return 'יוצאים היום';
      if (n === 1) return 'יוצאים מחר';
      if (n < 60) return 'בעוד ' + plural(n, 'יום', 'יומיים', 'ימים');
      const m = Math.round(n / 30.4);
      return 'בעוד ' + plural(m, 'חודש', 'חודשיים', 'חודשים');
    }
    if (w.phase === 'past') {
      const n = w.agoDays;
      if (n <= 1) return 'חזרתם אתמול';
      if (n < 14) return 'לפני ' + plural(n, 'יום', 'יומיים', 'ימים');
      if (n < 60) return 'לפני ' + plural(Math.round(n / 7), 'שבוע', 'שבועיים', 'שבועות');
      if (n < 365) return 'לפני ' + plural(Math.round(n / 30.4), 'חודש', 'חודשיים', 'חודשים');
      return 'לפני ' + plural(Math.round(n / 365), 'שנה', 'שנתיים', 'שנים');
    }
    return 'בלי תאריך';
  }

  return { of, range, label };
})();
