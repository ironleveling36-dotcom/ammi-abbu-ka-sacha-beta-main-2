/**
 * Screenshot harness — Mini App ke asli screens ka PNG (Rule 8: visual QA).
 *
 * Chalane ka tareeqa:
 *   1) npm run preview:miniapp      (port 4173, demo data)
 *   2) node tools/screenshot-miniapp.mjs
 *
 * Browser: puppeteer-core + @sparticuz/chromium. Is sandbox me chromium ko
 * libnss3 chahiye jo image me nahi hoti, isliye `tools/chromedeps/setup.sh`
 * ek screenshot-only NSS stub banata hai (HTTP preview me TLS use nahi hota).
 * Bina browser ke bhi script saaf message de kar band ho jati hai — CI nahi
 * tootti.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 };

const depsPath = path.join(ROOT, 'tools', 'chromedeps', 'libnss-stub');
let puppeteer;
let chromium;
try {
  ({ default: puppeteer } = await import('puppeteer-core'));
  ({ default: chromium } = await import('@sparticuz/chromium'));
} catch (e) {
  console.log('[shots] puppeteer-core / @sparticuz/chromium nahi mile:', e.message);
  process.exit(0);
}

const executablePath = process.env.CHROME_PATH || (await chromium.executablePath());
const env = { ...process.env };
if (fs.existsSync(depsPath)) env.LD_LIBRARY_PATH = depsPath;

const browser = await puppeteer.launch({
  args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  executablePath,
  headless: 'shell',
  env
});

const page = await browser.newPage();
await page.setViewport(VIEWPORT);
await page.goto(BASE, { waitUntil: 'networkidle0' });
fs.mkdirSync(OUT, { recursive: true });

const shot = async (name) => {
  await new Promise((r) => setTimeout(r, 350));
  // Headless-shell kabhi screenshot par atak jata hai; 20s par chhod kar
  // agla screen lete hain, warna poora harness hang ho jata hai.
  await Promise.race([
    page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 20000))
  ]).then(() => console.log('  ✓', name)).catch((e) => console.log('  ✗', name, e.message));
};
const click = async (selector, wait = 350) => {
  await page.waitForSelector(selector, { timeout: 8000 });
  await page.click(selector);
  await new Promise((r) => setTimeout(r, wait));
};
const tab = (name) => click(`[data-action="nav"][data-tab="${name}"]`);

console.log('[shots] accounts');
await shot('01-accounts');

console.log('[shots] address');
await tab('address');
await shot('02-address');

console.log('[shots] search');
await tab('search');
await shot('03-search');

console.log('[shots] cart');
await tab('cart');
await new Promise((r) => setTimeout(r, 700));
await shot('04-cart');

console.log('[shots] cart scrolled to bill/payment');
await page.evaluate(() => window.scrollBy(0, 900));
await shot('05-cart-bill-payment');

console.log('[shots] coupon sheet');
await page.evaluate(() => window.scrollTo(0, 0));
await click('[data-action="coupon-open"]', 700);
await shot('06-coupons');
// Sheet band karke aage badho — warna fixed overlay headless-shell ka
// compositor atka deta hai (aur asli user bhi band hi karta hai).
await click('[data-action="coupon-back"]', 500);

console.log('[shots] orders');
await tab('orders');
await shot('07-orders');

console.log('[shots] order detail');
try {
  await click('[data-action="order-detail"]', 600);
  await shot('08-order-detail');
} catch {
  console.log('  (order list khaali hai — detail skip)');
}

console.log('[shots] tools');
await tab('tools');
await shot('09-tools');
await page.evaluate(() => window.scrollBy(0, 620));
await shot('10-tools-wallet-topup');

await browser.close();
console.log('[shots] done →', OUT);
