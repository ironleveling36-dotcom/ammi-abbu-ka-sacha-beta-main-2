import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const db = getDb();
  const acc = db.config.accounts.ammi;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  if (acc.cookies) {
    const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    await page.setCookie(...parsedCookies).catch(() => {});
  }

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load', timeout: 30000 });
  for (let i = 0; i < 15; i++) {
    const c = await page.cookies();
    if (c.find(x => x.name === 'aws-waf-token')) break;
    await new Promise(r => setTimeout(r, 600));
  }

  const endpoints = [
    '/dapi/group-order/cart?groupCartId=442849410',
    '/dapi/group-order/get?groupCartId=442849410',
    '/dapi/group-cart/details?groupCartId=442849410',
    '/dapi/group-cart/442849410',
    '/dapi/cart/group?groupCartId=442849410',
    '/dapi/group-order/v1/cart?groupCartId=442849410',
    '/dapi/group-cart/info?groupCartId=442849410',
    '/dapi/group-order/info?groupCartId=442849410',
    '/dapi/group-order/details?groupCartId=442849410',
    '/dapi/order/group-cart?groupCartId=442849410'
  ];

  const results = await page.evaluate(async (eps) => {
    const out = {};
    for (const ep of eps) {
      try {
        const res = await fetch('https://www.swiggy.com' + ep);
        const text = await res.text();
        out[ep] = { status: res.status, text: text.slice(0, 400) };
      } catch (e) {
        out[ep] = { error: e.message };
      }
    }
    return out;
  }, endpoints);

  console.log('ENDPOINT PROBE RESULTS:');
  for (const [ep, res] of Object.entries(results)) {
    if (res.status !== 404 && res.status !== 500) {
      console.log(`\n✅ FOUND ${ep}: Status ${res.status}`);
      console.log('Data:', res.text);
    } else {
      console.log(`404: ${ep}`);
    }
  }

  await browser.close();
})();
