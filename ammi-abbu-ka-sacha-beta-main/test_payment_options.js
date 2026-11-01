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
  }));

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 800));
  }
  await new Promise(r => setTimeout(r, 2000));

  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));

  // Click DELIVER HERE via page.evaluate
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 3000));

  // Click PROCEED TO PAY via page.evaluate
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    if (btn) btn.click();
  });

  console.log('Waiting 8s for payment methods...');
  await new Promise(r => setTimeout(r, 8000));

  await page.screenshot({ path: 'payment_options_rendered.png' });
  console.log('Screenshot saved to payment_options_rendered.png');

  const pageInfo = await page.evaluate(() => {
    const allText = document.body.innerText;
    const clickable = Array.from(document.querySelectorAll('div, button, span, a'))
      .map(el => el.innerText?.trim())
      .filter(t => t && t.length > 2 && t.length < 40);
    return {
      allTextSnippet: allText.slice(0, 1500),
      clickable: [...new Set(clickable)].slice(0, 40)
    };
  });

  console.log('Page Info:', JSON.stringify(pageInfo, null, 2));

  await browser.close();
})();
