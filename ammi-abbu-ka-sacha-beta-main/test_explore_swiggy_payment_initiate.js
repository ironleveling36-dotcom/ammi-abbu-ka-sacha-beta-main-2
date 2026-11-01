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

  page.on('request', req => {
    const u = req.url();
    if (u.includes('payment') || u.includes('order') || u.includes('juspay') || u.includes('coupon')) {
      console.log(`[REQ] ${req.method()} ${u.slice(0, 100)}`);
      if (req.method() === 'POST') {
        try {
          console.log(`   Post Data: ${req.postData()?.slice(0, 300)}`);
        } catch (e) {}
      }
    }
  });

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('payment') || u.includes('order') || u.includes('juspay') || u.includes('coupon') || u.includes('initiate')) {
      console.log(`[RESP] ${res.status()} ${u.slice(0, 100)}`);
      try {
        const text = await res.text();
        console.log(`   Resp Data: ${text.slice(0, 300)}`);
      } catch (e) {}
    }
  });

  console.log('Navigating to checkout...');
  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));

  // Check coupon list
  const couponData = await page.evaluate(async () => {
    try {
      const res = await fetch('https://www.swiggy.com/dapi/offers/restaurant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cartId: '120109599' })
      });
      return await res.json();
    } catch (e) {
      return { err: e.message };
    }
  });
  console.log('Restaurant offers/coupon endpoint test:', JSON.stringify(couponData).slice(0, 500));

  // Click DELIVER HERE
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 3000));

  // Check Apply Coupon button on checkout page
  const couponClickResult = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const applyBtn = els.find(e => e.innerText?.trim() === 'Apply Coupon');
    if (applyBtn) {
      applyBtn.click();
      return true;
    }
    return false;
  });
  console.log('Clicked Apply Coupon:', couponClickResult);
  await new Promise(r => setTimeout(r, 3000));

  // See if coupon drawer opened
  const drawerText = await page.evaluate(() => {
    return document.body.innerText.slice(0, 1500);
  });
  console.log('Page text with coupons:\n', drawerText);

  // Click PROCEED TO PAY
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 6000));

  console.log('On Payments Page: URL =', page.url());

  await browser.close();
})();
