// The AI's window onto the web — a small one, on purpose.
//
// The model may search and read only a fixed list of sites a traveller actually books
// and checks with: hotels (Booking, Airbnb), activities (Klook, GetYourGuide, Viator,
// Tiqets), flights (SWISS, El Al, Skyscanner, Kayak), Google Maps, ground transport
// (Rome2rio, Omio, 12Go), guides (Wikipedia, Wikivoyage, Time Out, Lonely Planet, Atlas
// Obscura), food (Tripadvisor, TheFork, the Michelin guide) and a few references (XE for
// currency, gov.il for travel warnings). Everything else is filtered out of the results
// before the model sees them, and read_page refuses any host not on the list. An open
// web is where an invented restaurant finds a confirming blog post; a closed list of
// sites that themselves sell the thing is evidence of a different grade.
//
// Provider: Brave Search (BRAVE_SEARCH_API_KEY, 2,000 free queries a month) when there is
// a key, DuckDuckGo's HTML endpoint without one — keyless, so the feature works on a
// fresh deploy, and parsed defensively because it is a page and not an API. Both are
// behind the same allowlist; neither one being down breaks a turn (the tool answers
// with an error the model can say out loud). AI_SEARCH_EXTRA_SITES adds hosts
// ("example.com,other.org") without a code change.
const { cacheGet, cacheSet } = require('./api-budget');

const SCOPE = 'web_search';

// category → hosts. A search names a category, so the site: group stays short enough for
// a search engine to honour; "any" searches the open web and keeps only allowlisted hits.
const SITES = {
  hotels: ['booking.com', 'airbnb.com'],
  activities: ['klook.com', 'getyourguide.com', 'viator.com', 'tiqets.com'],
  flights: ['swiss.com', 'elal.com', 'elal.co.il', 'skyscanner.com', 'skyscanner.co.il', 'kayak.com'],
  maps: ['google.com/maps', 'maps.google.com', 'maps.app.goo.gl'],
  transport: ['rome2rio.com', 'omio.com', '12go.asia', 'trainline.com'],
  guides: ['wikipedia.org', 'wikivoyage.org', 'timeout.com', 'lonelyplanet.com', 'atlasobscura.com'],
  food: ['tripadvisor.com', 'thefork.com', 'guide.michelin.com'],
  reference: ['xe.com', 'gov.il', 'israir.com', 'arkia.com'],
};
const EXTRA = String(process.env.AI_SEARCH_EXTRA_SITES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALL_HOSTS = [...new Set([...Object.values(SITES).flat(), ...EXTRA])];
const CATEGORIES = Object.keys(SITES);

// a URL is allowed when its host is one of ours or a subdomain of one; the Google Maps
// entries carry a path, so the match covers host+path for those
function allowed(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const hostPath = host + u.pathname.toLowerCase();
  return ALL_HOSTS.some((h) => {
    if (h.includes('/')) return hostPath.startsWith(h) || hostPath.startsWith('www.' + h);
    return host === h || host.endsWith('.' + h);
  });
}

const siteFilter = (category) => {
  const hosts = SITES[category];
  if (!hosts) return '';
  return ' (' + hosts.map((h) => 'site:' + h.split('/')[0]).join(' OR ') + ')';
};

async function fetchText(url, { timeoutMs = 8000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TRIPMAKER/1.0; +https://tripmaker.co.il)',
        'Accept-Language': 'he,en;q=0.8',
        ...headers,
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, url: res.url || url, type: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

const decodeEntities = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const strip = (html) => decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function braveSearch(q, key) {
  const url = `https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(q)}`;
  const r = await fetchText(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  if (!r.ok) throw new Error(`brave ${r.status}`);
  const data = JSON.parse(r.text);
  return ((data.web && data.web.results) || []).map((x) => ({ title: strip(x.title), url: x.url, snippet: strip(x.description) }));
}

// DuckDuckGo's HTML results page: result links carry the target in `uddg`
async function ddgSearch(q) {
  const r = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`duckduckgo ${r.status}`);
  // the links first, then each one's snippet: the first result__snippet between a
  // link and the next link belongs to that link
  const links = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(r.text)) && links.length < 12) links.push({ href: m[1], title: m[2], at: m.index, end: re.lastIndex });
  const snippetRe = /<(?:a|div|span)[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g;
  return links.map((l, i) => {
    let href = decodeEntities(l.href);
    const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) { try { href = decodeURIComponent(u[1]); } catch { /* keep as is */ } }
    if (href.startsWith('//')) href = 'https:' + href;
    const until = links[i + 1] ? links[i + 1].at : r.text.length;
    snippetRe.lastIndex = l.end;
    const sm = snippetRe.exec(r.text);
    const snippet = sm && sm.index < until ? strip(sm[1]) : '';
    return { title: strip(l.title), url: href, snippet };
  });
}

// the tool: up to `limit` allowlisted results for a query in a category. Cached a day.
async function search(query, { category = 'any', limit = 6 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { error: 'חסרה שאילתת חיפוש' };
  const cat = CATEGORIES.includes(category) ? category : 'any';
  const full = q + siteFilter(cat);
  const key = `${cat}:${full.toLowerCase()}`;
  const hit = await cacheGet(SCOPE, key, { ttlDays: 1 });
  if (hit.hit && hit.value) return hit.value;
  const brave = process.env.BRAVE_SEARCH_API_KEY;
  let raw;
  try {
    raw = brave ? await braveSearch(full, brave) : await ddgSearch(full);
  } catch (err) {
    console.warn(`web-search: ${brave ? 'brave' : 'duckduckgo'} failed: ${err.message}`);
    // a key that failed still has the keyless road behind it
    if (brave) { try { raw = await ddgSearch(full); } catch { raw = null; } }
  }
  if (!raw) return { error: 'החיפוש לא זמין כרגע' };
  const results = raw.filter((x) => x.url && allowed(x.url)).slice(0, limit)
    .map((x) => ({ title: x.title.slice(0, 120), url: x.url.slice(0, 300), snippet: x.snippet.slice(0, 240) }));
  const out = { query: q, category: cat, results, sites: cat === 'any' ? 'allowlisted sites only' : SITES[cat].join(', ') };
  if (results.length) await cacheSet(SCOPE, key, out);
  return out;
}

// the tool: the readable text of one allowlisted page, bounded. Sites that refuse a bot
// (most booking sites do, sometimes) come back as an error the model can report.
async function readPage(url, { maxChars = 3000 } = {}) {
  if (!allowed(url)) return { error: 'האתר הזה לא ברשימת האתרים שמותר לקרוא' };
  const key = 'page:' + String(url).slice(0, 400);
  const hit = await cacheGet(SCOPE, key, { ttlDays: 1 });
  if (hit.hit && hit.value) return hit.value;
  let r;
  try { r = await fetchText(url, { timeoutMs: 10000 }); } catch (err) { return { error: `הדף לא נענה (${err.name === 'AbortError' ? 'timeout' : err.message})` }; }
  if (!r.ok) return { error: `הדף ענה ${r.status}` };
  if (!/html|text|json/i.test(r.type)) return { error: 'הדף אינו טקסט' };
  let html = r.text;
  const title = strip((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  html = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, ' ');
  // the main content when the page names one, the body otherwise
  const main = (/<main[^>]*>([\s\S]*?)<\/main>/i.exec(html) || /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html) || [])[1];
  const text = strip((main || html).replace(/<\/(p|div|li|h\d|tr|br)>/gi, '\n')).replace(/\n{2,}/g, '\n').slice(0, maxChars);
  const out = { url: r.url, title: title.slice(0, 160), text };
  if (text.length > 200) await cacheSet(SCOPE, key, out);
  return out;
}

module.exports = { search, readPage, allowed, SITES, CATEGORIES, ALL_HOSTS, _test: { ddgParse: ddgSearch, strip } };
