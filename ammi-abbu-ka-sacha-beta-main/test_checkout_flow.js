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
  const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
  await page.setCookie(...cookiePairs.map(p => {
    const [name, ...val] = p.split('=');
    return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
  }));

  // Intercept all API calls during checkout
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/dapi/payment') || u.includes('/dapi/order') || u.includes('/checkout') || u.includes('/api/v') || u.includes('juspay')) {
      console.log('INTERCEPTED API:', res.status(), u);
      try {
        const text = await res.text();
        console.log('RESPONSE SNIPPET:', text.slice(0, 300));
      } catch (e) {}
    }
  });

  console.log('1. Loading swiggy.com...');
  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 800));
  }
  await new Promise(r => setTimeout(r, 2000));

  console.log('2. Navigating to /checkout...');
  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => console.log('Checkout nav:', e.message));
  await new Promise(r => setTimeout(r, 4000));

  console.log('3. Current URL:', page.url());

  // Check what buttons and steps exist on checkout page
  const pageState = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]')).map(b => ({
      text: b.innerText?.trim(),
      tag: b.tagName,
      class: b.className
    })).filter(b => b.text && b.text.length < 50);

    const bodySnippet = document.body.innerText.slice(0, 800);
    return { buttons: buttons.slice(0, 20), bodySnippet };
  });

  console.log('Page State:', JSON.stringify(pageState, null, 2));

  await browser.close();
})();
