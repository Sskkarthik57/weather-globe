// Automated smoke test: opens the site in the locally installed Chrome/Edge, collects console
// errors, takes screenshots at phone / tablet / desktop widths, clicks the globe and reads the FPS box.
// Usage: node scripts/check.mjs [url]     (default http://localhost:4173/ â€“ run `npm run preview` first)
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:4173/';
const out = 'screenshots';
mkdirSync(out, { recursive: true });
const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const browser = await chromium.launch({
  executablePath: exe, headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
});
const sizes = [
  { name: 'phone-360', width: 360, height: 760, mobile: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true },
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false },
];
let failures = 0;
for (const s of sizes) {
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.mobile ? 2 : 1, isMobile: s.mobile, hasTouch: s.mobile,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(url + '#fps', { waitUntil: 'load' });
  await page.waitForSelector('#loader', { state: 'detached', timeout: 60000 }).catch(() => errors.push('loader did not finish'));
  await page.waitForTimeout(4500);
  const info = await page.evaluate(() => ({
    fps: document.getElementById('fps')?.textContent,
    banner: document.getElementById('banner')?.hidden ? '' : document.getElementById('banner')?.textContent,
    legend: document.getElementById('legend')?.textContent,
    time: document.getElementById('time-main')?.textContent + ' | ' + document.getElementById('time-sub')?.textContent,
    updated: document.getElementById('updated')?.textContent,
    hScroll: document.documentElement.scrollWidth > innerWidth,
    overlaps: (() => {
      const ids = ['.topbar', '.layers', '.bottom', '.footer'];
      const r = ids.map((q) => [q, document.querySelector(q)?.getBoundingClientRect()]);
      const hits = [];
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        const [a, A] = r[i], [b, B] = r[j];
        if (A && B && A.left < B.right && B.left < A.right && A.top < B.bottom && B.top < A.bottom) hits.push(`${a}/${b}`);
      }
      return hits;
    })(),
  }));
  await page.screenshot({ path: `${out}/${s.name}-1-globe.png` });
  // toggle cyclones, open storm list
  await page.click('[data-layer="cyclones"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${s.name}-2-cyclones.png` });
  await page.click('#sheet-close');
  // click / tap the centre of the globe â†’ local weather panel
  if (s.mobile) await page.touchscreen.tap(s.width / 2, s.height * 0.45);
  else await page.mouse.click(s.width / 2, s.height / 2);
  await page.waitForSelector('.now-temp', { timeout: 20000 }).catch(() => errors.push('local weather panel did not load'));
  await page.waitForTimeout(2500);
  const place = await page.evaluate(() => document.querySelector('.place-title')?.textContent + ' | ' + document.querySelector('.now-temp')?.textContent);
  await page.screenshot({ path: `${out}/${s.name}-3-place.png` });
  // search
  await page.click('#sheet-close');
  await page.fill('#search-input', 'Lagos');
  await page.waitForSelector('#search-results li[role=option]:not(.msg)', { timeout: 10000 }).catch(() => errors.push('search gave no results'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3500);
  const searched = await page.evaluate(() => document.querySelector('.place-title')?.textContent);
  await page.screenshot({ path: `${out}/${s.name}-4-search.png` });
  let extra = {};
  if (!s.mobile) {
    // zoom out, rotate toward the sunset side to see the day/night terminator
    await page.click('#sheet-close');
    await page.mouse.move(s.width / 2, s.height / 2);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(60); }
    await page.waitForTimeout(800);
    await page.mouse.move(s.width * 0.3, s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.width * 0.55, s.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${s.name}-5-daynight.png` });
    // play the forecast for 2 s
    const t0 = await page.textContent('#time-main');
    await page.click('#play-btn');
    await page.waitForTimeout(2000);
    await page.click('#play-btn');
    const t1 = await page.textContent('#time-main');
    // settings: switch to imperial units
    await page.click('#settings-btn');
    await page.click('[data-units="imperial"]');
    const legendF = await page.textContent('#legend');
    await page.screenshot({ path: `${out}/${s.name}-6-settings.png` });
    await page.click('[data-units="metric"]');
    await page.keyboard.press('Escape');
    extra = { playFrom: t0, playTo: t1, legendImperial: legendF, settingsClosed: await page.isHidden('#settings') };
  }
  Object.assign(info, extra);
  console.log(`\n=== ${s.name}`);
  console.log(JSON.stringify({ ...info, place, searched }, null, 1));
  if (errors.length) { failures++; console.log('ERRORS:\n  ' + errors.join('\n  ')); }
  await ctx.close();
}
await browser.close();
console.log(failures ? `\n${failures} viewport(s) had console errors` : '\nNo console errors.');
