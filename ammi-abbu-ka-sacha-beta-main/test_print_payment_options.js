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

  let paymentOptionsData = null;
  page.on('response', async res => {
    if (res.url().includes('get-payment-options')) {
      try {
        paymentOptionsData = await res.json();
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

  console.log('Payment Groups:');
  if (paymentOptionsData?.data?.payment_group) {
    for (const pg of paymentOptionsData.data.payment_group) {
      console.log(`- ${pg.group_name}: ${pg.display_name} (enabled: ${pg.enabled})`);
      if (pg.payment_methods) {
        for (const pm of pg.payment_methods) {
          console.log(`   * ${pm.payment_code || pm.name}: ${pm.display_name} (enabled: ${pm.enabled})`);
        }
      }
    }
  } else {
    console.log('No payment options received:', paymentOptionsData);
  }

  await browser.close();
})();
