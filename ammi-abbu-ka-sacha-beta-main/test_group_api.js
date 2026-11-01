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

  // Intercept all dapi calls
  page.on('response', async res => {
    const u = res.url();
    if (u.includes('/dapi/') && (u.includes('group') || u.includes('cart') || u.includes('menu'))) {
      try {
        const json = await res.json();
        console.log('Intercepted API:', u);
        console.log('API DATA:', JSON.stringify(json, null, 2).slice(0, 500));
      } catch (e) {}
    }
  });

  // Navigate to Swiggy menu for this restaurant!
  // In Swiggy web, menu URL is: https://www.swiggy.com/restaurants/x-803172 or https://www.swiggy.com/menu/803172
  console.log('Testing restaurant 803172 menu...');
  await page.goto('https://www.swiggy.com/restaurants/restaurant-803172', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 4000));

  const pageInfo = await page.evaluate(() => {
    const name = document.querySelector('h1, [class*="Header_name"], [class*="header_name"]')?.innerText;
    const items = Array.from(document.querySelectorAll('[class*="itemRow"], [class*="Item_root"], div[data-testid="normal-dish-item"]')).map(el => {
      const dish = el.querySelector('[class*="name"], h3')?.innerText;
      const price = el.querySelector('[class*="price"]')?.innerText;
      return { dish, price };
    }).slice(0, 5);
    return { name, items, title: document.title, url: window.location.href };
  });

  console.log('Page Info:', JSON.stringify(pageInfo, null, 2));

  // Now let's test group-order endpoint in page context:
  const groupCartApiTest = await page.evaluate(async () => {
    const results = {};
    const endpoints = [
      '/dapi/group-order/cart?groupCartId=442849410',
      '/dapi/cart/group?group_cart_id=442849410',
      '/dapi/group-cart/442849410',
      '/dapi/group-order/442849410',
      '/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=26.83730&lng=80.91650&restaurantId=803172',
      '/dapi/cart'
    ];
    for (const ep of endpoints) {
      try {
        const res = await fetch('https://www.swiggy.com' + ep);
        const data = await res.json();
        results[ep] = { status: res.status, data: data };
      } catch (e) {
        results[ep] = { error: e.message };
      }
    }
    return results;
  });

  console.log('Group Cart & Menu API Responses:');
  for (const [ep, res] of Object.entries(groupCartApiTest)) {
    console.log(`\nEndpoint: ${ep}`);
    console.log(JSON.stringify(res, null, 2).slice(0, 400));
  }

  await browser.close();
})();
