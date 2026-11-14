// Checks the fallback message appears when WebGL is disabled.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-webgl', '--disable-webgl2'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(process.argv[2] || 'http://localhost:4173/');
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(() => ({
  fallbackVisible: !document.getElementById('fallback').hidden,
  text: document.getElementById('fallback').innerText.slice(0, 80),
  loaderGone: !document.getElementById('loader'),
}))));
await browser.close();
