import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const db = getDb();
  const acc = db.config.accounts.ammi;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  if (acc.cookies) {
    const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
    const parsedCookies = cookiePairs.map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    await page.setCookie(...parsedCookies).catch(() => {});
  }

  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/dapi/cart') || u.includes('/group-order') || u.includes('/dapi/order')) {
      try {
        const json = await res.json();
        console.log('Intercepted:', u);
        console.log('JSON:', JSON.stringify(json, null, 2).slice(0, 1000));
      } catch (e) {}
    }
  });

  console.log('Navigating to https://www.swiggy.com/checkout ...');
  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'networkidle2', timeout: 20000 }).catch(e => console.log('Err:', e.message));

  const content = await page.evaluate(() => {
    return {
      title: document.title,
      text: document.body.innerText.slice(0, 500)
    };
  });
  console.log('Page content:', content);

  await browser.close();
})();
