import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const db = getDb();
  const acc = db.config.accounts.abbu;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  // Set Mobile User Agent
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
  await page.setCookie(...cookiePairs.map(p => {
    const [name, ...val] = p.split('=');
    return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
  })).catch(() => {});

  await page.goto('https://www.swiggy.com/payments', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 4000));

  await page.screenshot({ path: 'swiggy_mobile_payment.png' });

  const info = await page.evaluate(() => {
    return {
      url: window.location.href,
      text: document.body.innerText.slice(0, 1500),
      buttons: Array.from(document.querySelectorAll('button, div, span, a'))
        .map(e => e.innerText?.trim())
        .filter(t => t && t.length > 2 && t.length < 40)
        .slice(0, 40)
    };
  });

  console.log('Mobile Payment Page Info:', JSON.stringify(info, null, 2));

  await browser.close();
})();
