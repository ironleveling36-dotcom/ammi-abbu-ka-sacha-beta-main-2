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
  await new Promise(r => setTimeout(r, 3000));

  // Click DELIVER HERE
  console.log('Clicking DELIVER HERE...');
  const deliverClicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  console.log('Deliver clicked:', deliverClicked);
  await new Promise(r => setTimeout(r, 3000));

  // Click PROCEED TO PAY
  console.log('Clicking PROCEED TO PAY...');
  const payClicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  console.log('Proceed to pay clicked:', payClicked);

  await new Promise(r => setTimeout(r, 6000));

  await page.screenshot({ path: 'swiggy_payment_step.png' });
  console.log('Screenshot saved to swiggy_payment_step.png');

  const paymentDOM = await page.evaluate(() => {
    const text = document.body.innerText;
    const clickable = Array.from(document.querySelectorAll('button, a, div[role="button"], span'))
      .map(e => e.innerText?.trim())
      .filter(t => t && t.length > 2 && t.length < 50);
    return {
      url: window.location.href,
      textSnippet: text.slice(0, 2000),
      clickable: [...new Set(clickable)].slice(0, 50)
    };
  });

  console.log('Payment DOM info:', JSON.stringify(paymentDOM, null, 2));

  await browser.close();
})();
