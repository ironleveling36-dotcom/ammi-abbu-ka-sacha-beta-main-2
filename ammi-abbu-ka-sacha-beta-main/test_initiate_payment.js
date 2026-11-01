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

  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'load' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 600));
  }
  await new Promise(r => setTimeout(r, 2000));

  // Click DELIVER HERE
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 3000));

  // Click PROCEED TO PAY
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 5000));

  // Check window object in browser for Juspay or Swiggy payment functions
  const paymentWindowInfo = await page.evaluate(async () => {
    const keys = Object.keys(window).filter(k => k.toLowerCase().includes('payment') || k.toLowerCase().includes('swiggy') || k.toLowerCase().includes('juspay'));
    
    // Check if there is an initiate payment endpoint in webpack or scripts
    let initiateResult = null;
    try {
      // Check csrf token in cookies
      const csrf = document.cookie.split('; ').find(row => row.startsWith('_csrf='))?.split('=')[1];
      const res = await fetch('https://payments.swiggy.com/api/v3/payment/initiate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'csrf-token': csrf || ''
        },
        body: JSON.stringify({
          payment_method: 'UPI',
          payment_code: 'UPI_QR'
        })
      });
      initiateResult = { status: res.status, text: await res.text() };
    } catch (e) {
      initiateResult = { error: e.message };
    }

    return { keys, initiateResult };
  });

  console.log('Payment Window Info:', JSON.stringify(paymentWindowInfo, null, 2));

  await browser.close();
})();
