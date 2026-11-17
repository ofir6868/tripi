// A Hebrew range calendar, shared by everywhere a trip's dates get chosen: the plan
// wizard, where the range also decides how many days the trip is, and the trip page,
// where the day count already exists — so there the departure is the only thing
// picked and the return paints itself in.
//
// Vanilla on purpose: <input type="date"> hands the phone its native picker but the
// desktop one can't show a range at all, and the whole point here is seeing the trip
// as a block of days on a month.
const DATEPICKER = (() => {
  const DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const DAY = 86400000;

  // ISO in, local Date out. The API hands back full timestamps ("2026-11-01T22:00:00Z"
  // — midnight *here*, stored as a date), the wizard hands back plain "YYYY-MM-DD";
  // both have to land on the day a person would name, never the one before it.
  function parse(v) {
    if (!v) return null;
    if (v instanceof Date) return startOfDay(v);
    const s = String(v);
    if (s.includes('T')) return startOfDay(new Date(s));
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  }
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const iso = (d) => (d ? TRIPMAKER.isoDate(d) : null);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => !!a && !!b && a.getTime() === b.getTime();
  // whole days apart — built from calendar days, so a DST shift can't make it 0.96
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

  const CHEV_PREV = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  const CHEV_NEXT = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';

  // host: the element the calendar is rendered into.
  // opts.fixedDays — the trip's length is already decided, so a click sets the whole
  //   block at once. Without it the second click sets the return date (free range).
  // opts.maxDays  — free-range ceiling, matching the wizard's own cap.
  // opts.onChange({ start, end, days }) — ISO strings (end may be null mid-pick).
  // opts.allowPast — let days before today be picked. Off everywhere today: a trip is
  //   planned forward, and a calendar that pages back forever is where strangers got
  //   lost (Nov 1: "previous month" pressed eight times before anyone found January).
  function create(host, opts = {}) {
    const fixedDays = opts.fixedDays || null;
    const maxDays = opts.maxDays || 60;
    const onChange = opts.onChange || (() => {});
    const today = startOfDay(new Date());

    let start = parse(opts.start);
    let end = parse(opts.end);
    let hover = null;           // the day under the cursor while a range is half-picked
    let view = new Date((start || today).getFullYear(), (start || today).getMonth(), 1);
    let floor = null;           // the first pickable day; null when the past is open
    function setFloor() {
      // a trip already under way keeps its own start reachable, so re-opening its dates
      // doesn't strand the departure behind a wall
      floor = opts.allowPast ? null : (start && start < today ? start : today);
    }
    setFloor();
    const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
    const MONTHS_AHEAD = 18;    // how far the month strip reaches — a year and a half

    host.classList.add('dp');
    host.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-step="-1" aria-label="החודש הקודם" title="החודש הקודם">${CHEV_PREV}</button>
        <div class="dp-month" aria-live="polite"></div>
        <button type="button" class="dp-nav" data-step="1" aria-label="החודש הבא" title="החודש הבא">${CHEV_NEXT}</button>
      </div>
      <div class="dp-strip" role="group" aria-label="קפיצה לחודש"></div>
      <div class="dp-dow">${DOW.map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="dp-grid"></div>`;
    const monthEl = host.querySelector('.dp-month');
    const stripEl = host.querySelector('.dp-strip');
    const grid = host.querySelector('.dp-grid');
    const prevBtn = host.querySelector('.dp-nav[data-step="-1"]');

    host.querySelectorAll('.dp-nav').forEach((b) => {
      b.onclick = () => {
        if (b.disabled) return;
        view = new Date(view.getFullYear(), view.getMonth() + (+b.dataset.step), 1);
        renderMonth();
      };
    });

    // The month strip: every month of the next year and a half, always on screen, one
    // tap each. It used to be a grid hidden behind the month's title — and in the week
    // after it shipped, of six strangers who reached this calendar none opened it,
    // while they pressed "next month" 2, 7, 10, 14 and 32 times and two of them left
    // without a trip. A jump nobody finds is not a jump, so it is now the first thing
    // under the title and the arrows are the fallback.
    function buildStrip() {
      const first = monthStart(floor || today);
      const cells = [];
      for (let i = 0; i < MONTHS_AHEAD; i++) {
        const m = new Date(first.getFullYear(), first.getMonth() + i, 1);
        // the year rides on the first chip and on every January — enough to know which
        // March this is without printing a year eighteen times
        const year = i === 0 || m.getMonth() === 0 ? `<small>${m.getFullYear()}</small>` : '';
        cells.push(`<button type="button" class="dp-mo" data-m="${iso(m)}" data-i="${i}"
          aria-label="${m.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })}">${m.toLocaleDateString('he-IL', { month: 'short' })}${year}</button>`);
      }
      stripEl.innerHTML = cells.join('');
    }
    function paintStrip(smooth) {
      let cur = null;
      stripEl.querySelectorAll('.dp-mo').forEach((b) => {
        const on = parse(b.dataset.m).getTime() === view.getTime();
        b.classList.toggle('is-current', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) cur = b;
      });
      // centre the shown month in the strip. scrollTo on the strip itself, never
      // scrollIntoView: that one is allowed to scroll the whole page to get there
      if (!cur) return;
      if (!stripEl.clientWidth) {
        // rendered inside a sheet that isn't on screen yet (the trip page's dates
        // panel): there is no width to centre in until it opens, so look again then
        if (!paintStrip.waiting) {
          paintStrip.waiting = true;
          requestAnimationFrame(() => setTimeout(() => { paintStrip.waiting = false; if (stripEl.clientWidth) paintStrip(false); }, 120));
        }
        return;
      }
      const left = cur.offsetLeft - (stripEl.clientWidth - cur.offsetWidth) / 2;
      stripEl.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    }
    stripEl.addEventListener('click', (e) => {
      const b = e.target.closest('.dp-mo');
      if (!b) return;
      view = parse(b.dataset.m);
      renderMonth(true);
      window.TRIPMAKER?.track?.('dp_month_jump', { ahead: +b.dataset.i });
    });

    // the range as it stands right now — including the one being dragged out, so the
    // shading follows the cursor before the second click lands
    function span() {
      if (!start) return [null, null];
      if (end) return [start, end];
      if (fixedDays) return [start, addDays(start, fixedDays - 1)];
      if (hover && hover > start) return [start, hover];
      return [start, start];
    }

    // classes only — repainting the whole month on every mouseover would fight the
    // cursor on a slow device
    function paint() {
      const [from, to] = span();
      grid.querySelectorAll('.dp-day').forEach((cell) => {
        const d = parse(cell.dataset.d);
        const inRange = from && to && d >= from && d <= to;
        cell.classList.toggle('in-range', !!inRange);
        cell.classList.toggle('is-start', sameDay(d, from));
        cell.classList.toggle('is-end', !!inRange && sameDay(d, to));
        cell.classList.toggle('is-solo', !!inRange && sameDay(from, to));
      });
    }

    function renderMonth(smooth) {
      if (floor && view < monthStart(floor)) view = monthStart(floor);
      monthEl.textContent = view.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
      // no way back past the first pickable month — the only live arrow is the right one
      prevBtn.disabled = !!floor && view.getTime() <= monthStart(floor).getTime();
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const total = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const cells = [];
      // grid column 1 is the right edge in RTL, so Sunday-first needs no offset math
      for (let i = 0; i < first.getDay(); i++) cells.push('<span class="dp-pad"></span>');
      for (let n = 1; n <= total; n++) {
        const d = new Date(view.getFullYear(), view.getMonth(), n);
        const label = d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
        const past = !!floor && d < floor;
        cells.push(`<button type="button" class="dp-day${sameDay(d, today) ? ' is-today' : ''}${past ? ' is-past' : ''}"
          data-d="${iso(d)}" aria-label="${label}"${past ? ' disabled' : ''}>${n}</button>`);
      }
      grid.innerHTML = cells.join('');
      paint();
      paintStrip(smooth);
    }

    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.dp-day');
      if (!cell || cell.disabled) return;
      const d = parse(cell.dataset.d);
      if (fixedDays) {
        start = d;
        end = addDays(d, fixedDays - 1);
      } else if (!start || end || d < start) {
        start = d;                       // every click that can't close a range opens one
        end = null;
      } else {
        end = daysBetween(start, d) + 1 > maxDays ? addDays(start, maxDays - 1) : d;
      }
      hover = null;
      paint();
      fire();
    });
    grid.addEventListener('mouseover', (e) => {
      if (!start || end || fixedDays) return;
      const cell = e.target.closest('.dp-day');
      if (!cell || cell.disabled) return;
      hover = parse(cell.dataset.d);
      paint();
    });
    grid.addEventListener('mouseleave', () => { if (hover) { hover = null; paint(); } });

    function value() {
      const to = end || (fixedDays && start ? addDays(start, fixedDays - 1) : null);
      return { start: iso(start), end: iso(to), days: start && to ? daysBetween(start, to) + 1 : null };
    }
    function fire() { onChange(value()); }

    buildStrip();
    renderMonth();

    return {
      el: host,
      value,
      // set from outside (a restored draft, the day stepper next door) — deliberately
      // silent, or the caller that owns the number would hear its own echo
      set(nextStart, nextEnd) {
        start = parse(nextStart);
        // a fixed-length range has only one degree of freedom — the caller can't hand
        // it an end that disagrees with the length it asked for
        end = fixedDays && start ? addDays(start, fixedDays - 1) : parse(nextEnd);
        hover = null;
        setFloor();
        buildStrip();
        // re-opening lands on the chosen month, or on this one when there's nothing
        // chosen yet — never on whatever month was last browsed away to
        const anchor = start || today;
        view = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        renderMonth();
      },
    };
  }

  return { create, parse, iso };
})();
