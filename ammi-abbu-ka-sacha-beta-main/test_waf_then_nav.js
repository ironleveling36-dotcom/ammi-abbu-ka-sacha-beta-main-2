import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-position=-32000,-32000',
      '--no-sandbox'
    ]
  });

  const page = await browser.newPage();
  console.log('1. Loading swiggy.com root to solve WAF...');
  await page.goto('https://www.swiggy.com/', { waitUntil: 'load', timeout: 30000 });

  // Wait for WAF
  for (let i = 0; i < 15; i++) {
    const cookies = await page.cookies();
    const waf = cookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) {
      console.log('2. WAF Solved! Token length:', waf.value.length);
      break;
    }
    await new Promise(r => setTimeout(r, 800));
  }

  // Now navigate to the group cart link:
  const testLink = 'https://swig.gy/gc/803172/Umbashiya-442849410';
  console.log('3. Navigating to:', testLink);
  await page.goto(testLink, { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));

  const pageState = await page.evaluate(() => {
    return {
      url: window.location.href,
      title: document.title,
      textSample: document.body.innerText.slice(0, 1000)
    };
  });

  console.log('Page State:', JSON.stringify(pageState, null, 2));

  await browser.close();
})();
