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

  // Intercept all requests
  page.on('request', req => {
    const u = req.url();
    if (u.includes('ofo') || u.includes('address') || u.includes('amqq8oRnM')) {
      console.log('REQUEST URL:', u);
    }
  });

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('ofo') || u.includes('amqq8oRnM')) {
      try {
        const text = await res.text();
        console.log('RESPONSE URL:', u);
        console.log('RESPONSE DATA:', text.slice(0, 300));
      } catch (e) {}
    }
  });

  console.log('Navigating to ofo link with logged in cookies...');
  await page.goto('https://www.swiggy.com/ofo/address/Umbashiya/amqq8oRnM?pushScreen=true', { waitUntil: 'networkidle2', timeout: 20000 }).catch(e => console.log('Err:', e.message));

  const text = await page.evaluate(() => document.body.innerText);
  console.log('Body Text:\n', text);

  await browser.close();
})();
