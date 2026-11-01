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
  })).catch(() => {});

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('phonepe') || u.includes('payment') || u.includes('initiate') || u.includes('place-order')) {
      console.log(`[RESP] ${res.status()} ${u.slice(0, 100)}`);
      try {
        const text = await res.text();
        console.log(`Data snippet: ${text.slice(0, 300)}`);
      } catch (e) {}
    }
  });

  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'load' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 600));
  }
  await new Promise(r => setTimeout(r, 2000));

  // Click DELIVER HERE
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 3000));

  // Click PROCEED TO PAY
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 6000));

  // Click Wallets to expand
  console.log('Clicking Wallets...');
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const wallets = els.find(e => e.innerText?.includes('Wallets') && e.innerText?.includes('PhonePe'));
    if (wallets) wallets.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  // Find and click PhonePe Pay button
  console.log('Looking for PhonePe button...');
  const clickedPhonePe = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const pp = els.find(e => e.innerText?.trim() === 'PhonePe' || e.innerText?.includes('PhonePe (Wallet/UPI/Cards)'));
    if (pp) {
      pp.click();
      return true;
    }
    return false;
  });
  console.log('PhonePe clicked:', clickedPhonePe);

  await new Promise(r => setTimeout(r, 3000));

  // Check if there is a PAY button or CONTINUE button
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, div[role="button"]'));
    const payBtn = els.find(e => e.innerText?.toUpperCase().includes('PAY'));
    if (payBtn) {
      console.log('Found pay button:', payBtn.innerText);
      payBtn.click();
    }
  });

  await new Promise(r => setTimeout(r, 6000));

  console.log('Current URL after PhonePe:', page.url());
  await page.screenshot({ path: 'phonepe_screen.png' });
  console.log('Saved screenshot to phonepe_screen.png');

  // Check if QR code is visible in DOM or in iframe or image
  const qrDetails = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).map(i => ({ src: i.src, alt: i.alt }));
    const svgs = document.querySelectorAll('svg').length;
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src);
    return {
      title: document.title,
      url: window.location.href,
      text: document.body.innerText.slice(0, 1000),
      imgs: imgs.slice(0, 10),
      svgs,
      iframes
    };
  });
  console.log('QR/Page details:', JSON.stringify(qrDetails, null, 2));

  await browser.close();
})();
