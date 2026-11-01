import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  
  // Set location cookies for Lucknow
  await page.setCookie(
    { name: 'userLocation', value: '%7B%22lat%22%3A%2226.83730%22%2C%22lng%22%3A%2280.91650%22%2C%22address%22%3A%22Lucknow%22%2C%22area%22%3A%22Hazratganj%22%2C%22showUserDefaultAddressHint%22%3Afalse%7D', domain: '.swiggy.com', path: '/' },
    { name: '_is_logged_in', value: '1', domain: '.swiggy.com', path: '/' }
  );

  console.log('Navigating to Lucknow restaurants with location cookie...');
  await page.goto('https://www.swiggy.com/city/lucknow', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));

  const pageData = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/city/lucknow/"]')).map(a => a.href);
    return {
      title: document.title,
      links: links.slice(0, 5),
      bodySample: document.body.innerText.slice(0, 300)
    };
  });

  console.log('Page Data:', JSON.stringify(pageData, null, 2));

  if (pageData.links.length > 0) {
    const testUrl = pageData.links[0];
    console.log('Opening restaurant:', testUrl);
    await page.goto(testUrl, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const restDetails = await page.evaluate(() => {
      const name = document.querySelector('h1')?.innerText?.trim();
      const items = Array.from(document.querySelectorAll('[class*="itemRow"], [class*="Item_root"], [data-testid="normal-dish-item"]')).map(el => {
        const dish = el.querySelector('[class*="name"], h3')?.innerText?.trim();
        const price = el.querySelector('[class*="price"]')?.innerText?.trim();
        return { dish, price };
      }).filter(x => x.dish && x.price).slice(0, 5);

      return { name, items };
    });

    console.log('Scraped Restaurant:', JSON.stringify(restDetails, null, 2));
  }

  await browser.close();
})();
