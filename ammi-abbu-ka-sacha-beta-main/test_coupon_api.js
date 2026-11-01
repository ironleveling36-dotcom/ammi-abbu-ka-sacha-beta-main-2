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
  await page.setViewport({ width: 1280, height: 900 });

  const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
  await page.setCookie(...cookiePairs.map(p => {
    const [name, ...val] = p.split('=');
    return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
  })).catch(() => {});

  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));

  const couponTest = await page.evaluate(async () => {
    const results = {};
    const endpoints = [
      'https://www.swiggy.com/dapi/cart/offers',
      'https://www.swiggy.com/dapi/offers/v2/cart',
      'https://www.swiggy.com/dapi/cart/apply-coupon',
      'https://www.swiggy.com/dapi/coupon/list',
      'https://www.swiggy.com/dapi/offers/payment'
    ];

    for (const ep of endpoints) {
      try {
        const res = await fetch(ep);
        results[ep] = { status: res.status, text: (await res.text()).slice(0, 200) };
      } catch (e) {
        results[ep] = { err: e.message };
      }
    }

    // Try applying common coupons: WELCOME50, STEALDEAL, TRYNEW
    const testCodes = ['STEALDEAL', 'WELCOME50', 'TRYNEW', 'SWIGGYIT', 'FEAST50'];
    for (const code of testCodes) {
      try {
        const postRes = await fetch('https://www.swiggy.com/dapi/cart/apply-coupon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ couponCode: code })
        });
        results['apply_' + code] = { status: postRes.status, text: (await postRes.text()).slice(0, 200) };
      } catch (e) {}
    }

    return results;
  });

  console.log('Coupon Test Results:', JSON.stringify(couponTest, null, 2));

  await browser.close();
})();
