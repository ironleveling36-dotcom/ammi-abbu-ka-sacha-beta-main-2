import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  
  // Test opening a real restaurant page on Swiggy Lucknow
  console.log('Testing restaurant navigation...');
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/dapi/menu') || u.includes('/dapi/restaurants/list') || u.includes('/group-order')) {
      console.log('Intercepted:', u.slice(0, 100));
    }
  });

  await page.goto('https://www.swiggy.com/city/lucknow', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 4000));
  
  const restLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/city/lucknow/"]')).map(a => a.href).slice(0, 3);
  });
  console.log('Sample Restaurant Links:', restLinks);

  if (restLinks.length > 0) {
    await page.goto(restLinks[0], { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 4000));
    const restData = await page.evaluate(() => {
      const name = document.querySelector('h1, [class*="Header_name"]')?.innerText;
      const items = Array.from(document.querySelectorAll('[class*="itemRow"], [class*="Item_root"], div[data-testid="normal-dish-item"]')).map(el => {
        const dish = el.querySelector('[class*="name"], h3')?.innerText;
        const price = el.querySelector('[class*="price"]')?.innerText;
        return { dish, price };
      }).slice(0, 5);
      return { name, items };
    });
    console.log('Restaurant Scraped Data:', JSON.stringify(restData, null, 2));
  }

  await browser.close();
})();
