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
    if (u.includes('payment') || u.includes('order') || u.includes('dapi') || u.includes('juspay')) {
      try {
        const text = await res.text();
        console.log(`[RESP] ${res.status()} ${u.slice(0, 80)}`);
        if (u.includes('payment') || u.includes('initiate') || u.includes('options')) {
          console.log(`Data: ${text.slice(0, 500)}`);
        }
      } catch (e) {}
    }
  });

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

  await new Promise(r => setTimeout(r, 6000));

  // Let's see what happens if we click "Pay on Delivery"
  console.log('Testing click on "Pay on Delivery"...');
  const podResult = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const pod = els.find(e => e.innerText?.trim() === 'Pay on Delivery\nPay in cash or pay online.' || e.innerText?.trim() === 'Pay on Delivery');
    if (pod) {
      pod.click();
      return true;
    }
    return false;
  });
  console.log('POD clicked:', podResult);

  await new Promise(r => setTimeout(r, 4000));

  const afterPodText = await page.evaluate(() => {
    return document.body.innerText;
  });
  console.log('After POD Text snippet:\n', afterPodText.slice(0, 1500));

  await page.screenshot({ path: 'after_pod_click.png' });

  await browser.close();
})();
