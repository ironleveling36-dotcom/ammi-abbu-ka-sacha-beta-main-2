import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  console.log('Loading swiggy.com...');
  await page.goto('https://www.swiggy.com/', { waitUntil: 'load', timeout: 30000 });

  // Wait for AWS WAF token to solve
  let wafSolved = false;
  for (let i = 0; i < 15; i++) {
    const cookies = await page.cookies();
    const waf = cookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) {
      wafSolved = true;
      console.log('AWS WAF Solved! Token length:', waf.value.length);
      break;
    }
    await new Promise(r => setTimeout(r, 800));
  }

  if (wafSolved) {
    const menuResult = await page.evaluate(async (restId) => {
      try {
        const url = `https://www.swiggy.com/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=26.83730&lng=80.91650&restaurantId=${restId}`;
        const res = await fetch(url);
        const json = await res.json();
        return { status: res.status, json };
      } catch (e) {
        return { error: e.message };
      }
    }, '803172');

    console.log('Menu API status:', menuResult.status);
    if (menuResult.json?.data?.cards) {
      console.log('Success! Cards count:', menuResult.json.data.cards.length);
      const restInfo = menuResult.json.data.cards.find(c => c.card?.card?.info)?.card?.card?.info;
      console.log('Restaurant Name:', restInfo?.name);
      console.log('City:', restInfo?.city);
      console.log('Cost For Two:', restInfo?.costForTwoMessage);
      
      // Extract dishes/items from menu:
      const regularGroup = menuResult.json.data.cards.find(c => c.groupedCard)?.groupedCard?.cardGroupMap?.REGULAR;
      if (regularGroup?.cards) {
        const allItems = [];
        for (const c of regularGroup.cards) {
          const itemCards = c.card?.card?.itemCards || [];
          for (const ic of itemCards) {
            const info = ic.card?.info;
            if (info) {
              allItems.push({
                name: info.name,
                price: (info.price || info.finalPrice || info.defaultPrice || 0) / 100,
                desc: info.description
              });
            }
          }
        }
        console.log(`Extracted ${allItems.length} items from Swiggy! Sample items:`);
        console.log(JSON.stringify(allItems.slice(0, 5), null, 2));
      }
    } else {
      console.log('Menu json preview:', JSON.stringify(menuResult.json).slice(0, 500));
    }
  }

  await browser.close();
})();
