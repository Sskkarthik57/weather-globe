// Browser test for the Rivers layer. Run while `npm.cmd run preview` is running:
//   node scripts/check-rivers.mjs [url]
// Screenshots go to /screenshots (rivers-*.png).
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:4173/';
mkdirSync('screenshots', { recursive: true });
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
const errors = [];
const shot = (page, name) => page.screenshot({ path: `screenshots/rivers-${name}.png` });
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() || '', sel);

// ---------------------------------------------------------------- desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(url + '#fps', { waitUntil: 'load' });
  await page.waitForSelector('#loader', { state: 'detached', timeout: 60000 });
  await page.click('[data-layer="rivers"]');
  await page.waitForTimeout(3000);
  console.log('layer on:', await page.getAttribute('[data-layer="rivers"]', 'aria-pressed'), '| legend:', await text(page, '#legend'));
  await shot(page, '1-layer');

  // search a river by its other name
  await page.fill('#search-input', 'Ganga');
  await page.waitForSelector('#search-results li.sr-river', { timeout: 10000 }).catch(() => errors.push('no river in search results'));
  console.log('search:', await text(page, '#search-results li.sr-river'));
  await page.click('#search-results li.sr-river');
  await page.waitForSelector('.rv-journey', { timeout: 15000 }).catch(() => errors.push('river panel did not load'));
  await page.waitForTimeout(3500);
  console.log('panel:', (await text(page, '#pane-river')).slice(0, 700));
  console.log('markers:', await page.evaluate(() => [...document.querySelectorAll('.rv-marker:not([hidden])')].map((m) => m.className.replace('marker rv-marker ', '')).join(',')));
  await shot(page, '2-ganges');

  // open a drawn tributary from the list
  const trib = await page.$('.rv-tribs button.drawn');
  if (trib) {
    await trib.click();
    await page.waitForTimeout(3500);
    console.log('tributary panel:', (await text(page, '#pane-river')).slice(0, 300));
    await shot(page, '3-tributary');
  } else errors.push('no drawn tributary button');

  // dams: click the first dam card
  const dam = await page.$('.rv-dams button:not(:disabled)');
  if (dam) { await dam.click(); await page.waitForTimeout(2500); await shot(page, '4-dam'); }

  // picking: close the panel, zoom out a bit, sweep the mouse until the readout names a river, then click it
  await page.click('#sheet-close');
  await page.waitForTimeout(800);
  let found = null;
  outer: for (let y = 300; y <= 650; y += 9) {
    for (let x = 450; x <= 1000; x += 9) {
      await page.mouse.move(x, y);
      const r = await page.evaluate(() => document.querySelector('#readout .ro-river')?.textContent || '');
      if (r) { found = { x, y, r }; break outer; }
    }
  }
  if (found) {
    console.log('hover found river at', found.x, found.y, '->', found.r);
    await shot(page, '5-hover');
    await page.mouse.click(found.x, found.y);
    await page.waitForSelector('#pane-river:not([hidden]) .place-title', { timeout: 15000 }).catch(() => errors.push('click on river did not open the panel'));
    await page.waitForTimeout(3000);
    console.log('clicked river:', await text(page, '#pane-river .place-title'));
    await shot(page, '6-clicked');
  } else errors.push('no river found under the mouse in the sweep');
  console.log('fps:', await text(page, '#fps'));
  await ctx.close();
}

// ---------------------------------------------------------------- phone
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('phone pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#loader', { state: 'detached', timeout: 60000 });
  await page.tap('[data-layer="rivers"]');
  await page.fill('#search-input', 'Nile');
  await page.waitForSelector('#search-results li.sr-river', { timeout: 10000 }).catch(() => errors.push('phone: no river in search'));
  await page.tap('#search-results li.sr-river');
  await page.waitForSelector('.rv-journey', { timeout: 15000 }).catch(() => errors.push('phone: river panel did not load'));
  await page.waitForTimeout(3500);
  console.log('phone hScroll:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await shot(page, '7-phone');
  await ctx.close();
}

await browser.close();
console.log(errors.length ? 'ERRORS:\n  ' + errors.join('\n  ') : '\nNo errors.');
