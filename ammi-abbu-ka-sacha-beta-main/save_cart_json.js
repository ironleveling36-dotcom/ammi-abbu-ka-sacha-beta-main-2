import puppeteer from 'puppeteer-core';
import fs from 'fs';
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

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 600));
  }
  await new Promise(r => setTimeout(r, 3500));

  let cartJson = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cartJson = await page.evaluate(async () => {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        return await res.json();
      });
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  fs.writeFileSync('cart_full_abbu.json', JSON.stringify(cartJson, null, 2));
  console.log('Saved cart_full_abbu.json!');

  // Also extract directly from /checkout page DOM
  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));

  const domDetails = await page.evaluate(() => {
    // Look for restaurant name, item rows, bill details
    const text = document.body.innerText;
    return {
      textSnippet: text.slice(0, 2000)
    };
  });

  console.log('DOM Snippet:\n', domDetails.textSnippet);

  await browser.close();
})();
