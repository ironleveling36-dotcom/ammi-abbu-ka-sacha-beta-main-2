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

  console.log('Navigating to swiggy.com homepage...');
  await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));

  const menuData = await page.evaluate(async (restId) => {
    try {
      const res = await fetch(`https://www.swiggy.com/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=26.83730&lng=80.91650&restaurantId=${restId}`);
      const json = await res.json();
      return json;
    } catch (e) {
      return { error: e.message };
    }
  }, '803172');

  console.log('MENU API DATA STATUS:', menuData?.statusCode, menuData?.statusMessage);
  if (menuData?.data?.cards) {
    console.log('Cards found:', menuData.data.cards.length);
    const restInfo = menuData.data.cards.find(c => c.card?.card?.info)?.card?.card?.info;
    console.log('Restaurant Info:', restInfo?.name, restInfo?.city, restInfo?.slugs);
    
    // Check group cart API with this restaurant:
    const gcApi = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/group-order/cart?groupCartId=442849410');
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('Group Cart API:', JSON.stringify(gcApi, null, 2).slice(0, 500));
  } else {
    console.log('Raw data preview:', JSON.stringify(menuData).slice(0, 500));
  }

  await browser.close();
})();
