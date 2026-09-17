// Walks the trip page's dock, המלצות, תכנון and מסמכים flows on a phone and a desktop
// viewport, screenshotting each step. Needs the preview server up and Playwright's
// chromium (NODE_PATH=$(npm root -g) node tools/preview/shots.js http://localhost:4173 out/).
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173';
const OUT = process.argv[3] || 'shots';
fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const login = { token: 'demo', user: { id: 1, name: 'רגב כהן', email: 'demo@tripmaker.co.il', is_admin: false } };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const wire = (page) => {
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/unsplash|open-meteo|osrm|net::ERR|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  };

  // ---- phone ----
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'he-IL' });
  await ctx.addInitScript((l) => {
    localStorage.setItem('tripmaker_token', l.token);
    localStorage.setItem('tripmaker_user', JSON.stringify(l.user));
  }, login);
  const page = await ctx.newPage();
  wire(page);
  await page.goto(`${BASE}/trip/731502`);
  await page.waitForSelector('#days-container .item-card:not(.skl-stop)', { timeout: 15000 });
  await page.waitForTimeout(1900);
  await shot(page, 'p1-itinerary');

  await page.click('#recs-btn');
  await page.waitForSelector('#chat-thread');
  await page.waitForTimeout(400);
  await shot(page, 'p2-recs-welcome');
  await page.click('.chat-chip:nth-child(2)');
  await page.waitForSelector('.rec-card', { timeout: 6000 });
  await page.waitForTimeout(500);
  await shot(page, 'p3-recs-cards');

  await page.click('.rec-card .rec-add');
  await page.waitForSelector('.tp-sheet.open .wc-grid');
  await page.waitForTimeout(350);
  await shot(page, 'p4-when-sheet');
  await page.click('.wc-auto');
  await page.waitForSelector('.rec-added', { timeout: 6000 });
  await page.waitForTimeout(300);
  await shot(page, 'p5-recs-added');

  await page.click('#docs-btn');
  await page.waitForSelector('.docs-empty');
  await page.waitForTimeout(400);
  await shot(page, 'p6-docs-empty');
  const png = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'apple-touch-icon.png'));
  await page.setInputFiles('#docs-file', [
    { name: 'ElAl_boarding_pass_LY385.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo') },
    { name: 'passport_scan.png', mimeType: 'image/png', buffer: png },
    { name: 'Hotel Artemide booking 4471.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo') },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.doc-tile').length === 3, null, { timeout: 8000 });
  await page.waitForTimeout(500);
  await shot(page, 'p7-docs-grid');
  await page.click('.doc-tile:nth-child(2)');
  await page.waitForSelector('.tp-sheet.open #ds-folder');
  await page.waitForTimeout(350);
  await shot(page, 'p8-doc-sheet');
  await page.click('.tp-sheet.open .tp-sheet-close');
  await page.waitForTimeout(300);

  await page.click('#itinerary-btn');
  await page.waitForTimeout(400);
  await page.click('#more-btn');
  await page.waitForSelector('.tp-sheet.open .more-list');
  await page.waitForTimeout(350);
  await shot(page, 'p9-more-sheet');
  await page.click('.tp-sheet.open .tp-sheet-close');
  await page.waitForTimeout(300);
  // the added stop is in the itinerary
  await page.locator('.show-rest-btn').click({ timeout: 1000 }).catch(() => {});
  const added = await page.locator('#days-container .item-card', { hasText: 'סיור אוכל רחוב' }).count();
  console.log('added stop visible in itinerary:', added);
  // the draft's planning chat: opening question → proposal card → approved
  await page.goto(`${BASE}/trip/000001#plan`);
  await page.waitForSelector('#plan-thread .chat-bubble:not(.chat-typing)', { timeout: 15000 });
  await page.waitForTimeout(2200);
  await shot(page, 'p8-plan-open');
  for (const reply of ['שניהם', 'שלב אחרי שלב', 'מתאים, נמשיך']) {
    await page.fill('#plan-input', reply);
    await page.press('#plan-input', 'Enter');
    await page.waitForFunction(() => !document.querySelector('#plan-thread .chat-typing'));
  }
  // the flights stage is a filled-in card now, not a round of questions: an hour, a
  // stopover, and one tap that writes the flights into the itinerary
  await page.waitForSelector('.pc-flights', { timeout: 6000 });
  await page.waitForTimeout(400);
  await shot(page, 'p9a-plan-flights');
  await page.locator('.pc-flights .fl-t-depart').first().fill('08:30');
  await page.locator('.pc-flights [data-act="stop-add"]').first().click();
  await page.waitForSelector('.pc-flights .fl-stop');
  await page.waitForTimeout(300);
  await shot(page, 'p9b-plan-flights-stopover');
  await page.click('.pc-flights .fl-save');
  await page.waitForFunction(() => !document.querySelector('.pc-flights'), null, { timeout: 8000 });
  await page.fill('#plan-input', 'מתאים');
  await page.press('#plan-input', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#plan-thread .chat-typing'));
  await page.waitForSelector('.plan-card.pc-pending', { timeout: 6000 });
  await shot(page, 'p9-plan-proposal');
  await page.click('.pc-accept');
  await page.waitForSelector('.plan-card.pc-applied', { timeout: 6000 });
  await page.waitForTimeout(300);
  await shot(page, 'p10-plan-applied');
  await page.goto(`${BASE}/trip/731502`);
  await page.waitForSelector('#days-container .item-card:not(.skl-stop)', { timeout: 15000 });
  await page.waitForTimeout(2200);

  // back gesture: recs page open → back closes it
  await page.click('#recs-btn');
  await page.waitForTimeout(300);
  await page.goBack();
  await page.waitForTimeout(300);
  console.log('page closed by back:', await page.evaluate(() => !document.body.classList.contains('page-open')));
  await ctx.close();

  // ---- desktop ----
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'he-IL' });
  await dctx.addInitScript((l) => {
    localStorage.setItem('tripmaker_token', l.token);
    localStorage.setItem('tripmaker_user', JSON.stringify(l.user));
  }, login);
  const d = await dctx.newPage();
  wire(d);
  await d.goto(`${BASE}/trip/731502`);
  await d.waitForSelector('#days-container .item-card:not(.skl-stop)', { timeout: 15000 });
  await d.waitForTimeout(1900);
  await d.evaluate(() => window.scrollTo(0, 260));
  await d.waitForTimeout(300);
  await shot(d, 'd1-itinerary');
  await d.click('#recs-btn');
  await d.waitForSelector('#chat-thread');
  await d.click('.chat-chip:nth-child(3)');
  await d.waitForSelector('.rec-card', { timeout: 6000 });
  await d.waitForTimeout(500);
  await shot(d, 'd2-recs');
  await d.click('.tp-back');
  await d.waitForTimeout(300);
  await d.click('#docs-btn');
  await d.waitForSelector('.docs-empty');
  await d.waitForTimeout(300);
  await shot(d, 'd3-docs');
  await dctx.close();
  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
})().catch((e) => { console.error(e); process.exit(1); });
