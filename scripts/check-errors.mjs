// Checks the UI shows clear messages when data is missing.
// Usage: node scripts/check-errors.mjs   (expects `npm run preview` running with files removed from dist/data)
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(process.argv[2] || 'http://localhost:4173/');
await page.waitForSelector('#loader', { state: 'detached', timeout: 60000 }).catch(() => pageErrors.push('loader stuck'));
await page.waitForTimeout(1500);
await page.click('[data-layer="cyclones"]').catch(() => {});
await page.waitForTimeout(800);
const r = await page.evaluate(() => ({
  banner: document.getElementById('banner').hidden ? '(none)' : document.getElementById('banner').innerText,
  storms: document.getElementById('pane-storms').innerText,
  tempDisabled: document.querySelector('[data-layer="temp"]').disabled,
}));
await page.screenshot({ path: 'screenshots/error-state.png' });
console.log(JSON.stringify({ ...r, pageErrors }, null, 1));
await browser.close();
