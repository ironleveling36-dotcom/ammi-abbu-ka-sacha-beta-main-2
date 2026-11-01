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

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('payment') || u.includes('upi') || u.includes('qr') || u.includes('juspay')) {
      console.log(`[RESP] ${res.status()} ${u.slice(0, 100)}`);
      try {
        const text = await res.text();
        console.log(`  Data: ${text.slice(0, 200)}`);
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 3000));

  // Click DELIVER HERE if present
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  // Check PROCEED TO PAY button
  const payBtnText = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    return btn ? btn.innerText : null;
  });
  console.log('Found pay button:', payBtnText);

  if (payBtnText) {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
      if (btn) btn.click();
    });
    console.log('Clicked PROCEED TO PAY, waiting 6s...');
    await new Promise(r => setTimeout(r, 6000));

    console.log('Current URL on payment step:', page.url());

    const paymentDetails = await page.evaluate(() => {
      const upiElements = Array.from(document.querySelectorAll('*'))
        .filter(e => e.innerText && (e.innerText.includes('UPI') || e.innerText.includes('QR') || e.innerText.includes('GPay') || e.innerText.includes('PhonePe')))
        .map(e => ({ tag: e.tagName, text: e.innerText?.trim()?.slice(0, 50) }));

      return {
        url: window.location.href,
        title: document.title,
        upiElements: upiElements.slice(0, 15)
      };
    });

    console.log('Payment details:', JSON.stringify(paymentDetails, null, 2));
    await page.screenshot({ path: 'swiggy_real_payment_screen.png' });
  }

  await browser.close();
})();
