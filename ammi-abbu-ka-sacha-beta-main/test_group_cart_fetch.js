import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const testUrl = 'https://swig.gy/gc/803172/Umbashiya-442849410';
  console.log('Resolving redirect for:', testUrl);

  const res1 = await fetch(testUrl, { redirect: 'manual' });
  const loc1 = res1.headers.get('location');
  console.log('Redirect 1:', loc1);

  let hostName = 'Umbashiya';
  let restaurantId = '803172';
  let groupCartId = '442849410';

  if (loc1) {
    const urlObj = new URL(loc1);
    const afDp = urlObj.searchParams.get('af_dp') || urlObj.searchParams.get('deep_link_value');
    if (afDp) {
      console.log('af_dp decoded:', decodeURIComponent(afDp));
      const parsedDp = new URL(afDp.replace('swiggy://', 'https://swiggy.com/'));
      if (parsedDp.searchParams.get('restaurant_id')) restaurantId = parsedDp.searchParams.get('restaurant_id');
      if (parsedDp.searchParams.get('group_cart_id')) groupCartId = parsedDp.searchParams.get('group_cart_id');
      if (parsedDp.searchParams.get('host_name')) hostName = parsedDp.searchParams.get('host_name');
    }
  }

  console.log('Extracted Params:', { hostName, restaurantId, groupCartId });

  // Now launch browser with prewarmed session to get restaurant details and cart details:
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

  // Intercept all responses to catch restaurant or cart info
  let restaurantName = null;
  let items = [];

  page.on('response', async r => {
    const u = r.url();
    if (u.includes('dapi') && (u.includes('menu') || u.includes('cart') || u.includes('restaurant'))) {
      try {
        const json = await r.json();
        console.log('Intercepted:', u.slice(0, 80));
        if (json?.data?.cards) {
          const info = json.data.cards.find(c => c.card?.card?.info)?.card?.card?.info;
          if (info?.name) {
            restaurantName = info.name;
            console.log('FOUND RESTAURANT NAME:', restaurantName);
          }
        }
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Search for the restaurant by ID on Swiggy search API
  const searchResult = await page.evaluate(async (rid) => {
    try {
      const sUrl = `https://www.swiggy.com/dapi/restaurants/search/v3?lat=26.83730&lng=80.91650&str=${rid}&trackingId=undefined&submitAction=ENTER&queryUniqueId=undefined`;
      const res = await fetch(sUrl);
      const json = await res.json();
      return json;
    } catch (e) {
      return { error: e.message };
    }
  }, restaurantId);

  console.log('Search API status:', searchResult?.statusCode);
  if (searchResult?.data?.cards) {
    for (const c of searchResult.data.cards) {
      const rList = c.groupedCard?.cardGroupMap?.RESTAURANT?.cards || [];
      for (const rc of rList) {
        const rInfo = rc.card?.card?.info;
        if (rInfo) {
          console.log(`Found matching restaurant: ${rInfo.name} (ID: ${rInfo.id}, City: ${rInfo.city})`);
          restaurantName = rInfo.name;
        }
      }
    }
  }

  console.log('FINAL DETAILS:', {
    hostName,
    restaurantId,
    groupCartId,
    restaurantName: restaurantName || `Swiggy Restaurant (${restaurantId})`
  });

  await browser.close();
})();
