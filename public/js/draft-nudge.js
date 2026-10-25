// The draft that stopped, offered back (lib/draft-nudge.js): on the homepage and in the
// wizard, whoever has a recent draft sees it as one card — what is already planned, and
// a way straight into the planning chat where it left off. Guests too: their trips live
// on the token in this browser, and this card is how they find them again.
//
// "לא עכשיו" hides it for this draft for three days; a draft touched again since is a
// new reason to show it.
const DraftNudge = (() => {
  const HIDE_KEY = 'tripmaker_draft_nudge_hidden';
  const HIDE_MS = 3 * 24 * 60 * 60 * 1000;
  const hidden = () => {
    try { return JSON.parse(localStorage.getItem(HIDE_KEY) || '{}'); } catch { return {}; }
  };

  async function offer(anchor, { via, place = 'afterend', lead = '' } = {}) {
    if (!anchor || !TRIPMAKER.token) return;
    let r;
    try { r = await TRIPMAKER.api('/api/my-drafts/waiting'); } catch { return; }
    const d = r && r.draft;
    if (!d) return;
    const h = hidden()[d.share_code];
    if (h && h.until > Date.now() && h.active === d.last_active) return;
    const esc = TRIPMAKER.esc;
    const el = document.createElement('a');
    el.className = 'draft-waiting glass';
    el.href = `/trip/${encodeURIComponent(d.share_code)}#plan`;
    el.innerHTML = `
      <span class="dw-ic" aria-hidden="true">✍️</span>
      <span class="dw-text"><b>${esc((typeof lead === 'function' ? lead(d) : lead) || d.headline)}</b><small>${esc(d.line)}</small></span>
      <span class="dw-go">להמשיך לתכנן ›</span>
      <button type="button" class="dw-x" aria-label="לא עכשיו">✕</button>`;
    el.querySelector('.dw-x').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const all = hidden();
      all[d.share_code] = { until: Date.now() + HIDE_MS, active: d.last_active };
      try { localStorage.setItem(HIDE_KEY, JSON.stringify(all)); } catch { /* shown again next visit */ }
      el.remove();
      TRIPMAKER.track?.('draft_nudge_dismiss', { via, code: d.share_code });
    });
    el.addEventListener('click', () => TRIPMAKER.trackNow?.('draft_nudge_click', { via, code: d.share_code }));
    anchor.insertAdjacentElement(place, el);
    TRIPMAKER.track?.('draft_nudge_shown', { via, code: d.share_code, filled: d.filled_days, days: d.days });
  }

  return { offer };
})();
