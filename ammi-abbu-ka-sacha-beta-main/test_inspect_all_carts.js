import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const db = getDb();
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
  });

  for (const [key, acc] of Object.entries(db.config.accounts)) {
    console.log(`\n================== Checking Account: ${key} (${acc.name} - ${acc.phone}) ==================`);
    if (!acc.cookies) {
      console.log('No cookies for', key);
      continue;
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
    await page.setCookie(...cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    })).catch(() => {});

    // Solve WAF challenge and wait for page reload to settle
    await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
    for (let i = 0; i < 15; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) break;
      await new Promise(r => setTimeout(r, 600));
    }
    // Wait 3 seconds for WAF auto-reload to finish
    await new Promise(r => setTimeout(r, 3000));

    // Evaluate /dapi/cart with retry
    let cartResult = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        cartResult = await page.evaluate(async () => {
          const res = await fetch('https://www.swiggy.com/dapi/cart');
          const json = await res.json();
          return { status: res.status, data: json };
        });
        break;
      } catch (e) {
        console.log(`Retry attempt ${attempt + 1} due to: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    console.log(`Cart result for ${key}:`, JSON.stringify(cartResult, null, 2).slice(0, 1500));

    // Also check checkout page DOM
    await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => console.log('Checkout nav err:', e.message));
    await new Promise(r => setTimeout(r, 3000));

    const checkoutText = await page.evaluate(() => {
      return document.body.innerText.slice(0, 1000);
    });
    console.log(`Checkout DOM snippet for ${key}:\n`, checkoutText);

    await page.close();
  }

  await browser.close();
})();
