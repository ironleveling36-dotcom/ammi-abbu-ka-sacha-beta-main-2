/**
 * Browser UI regression checks against preview-miniapp.mjs ONLY. The preview
 * uses demo data and blocks checkout/UPI. No live order/payment is tested.
 * Start `npm run preview:miniapp`, then set CHROME_PATH or install the optional
 * local-only @sparticuz/chromium package (see tools/chromedeps/README.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:4173/');
let executablePath = process.env.CHROME_PATH;
let args = ['--no-sandbox', '--disable-dev-shm-usage'];
let headless = true;
if (!executablePath) {
  try {
    const { default: chromium } = await import('@sparticuz/chromium');
    executablePath = await chromium.executablePath();
    args = [...chromium.args, ...args];
    headless = 'shell';
  } catch {
    console.error('A local Chromium is required: set CHROME_PATH or see tools/chromedeps/README.md.');
    process.exit(1);
  }
}
const env = { ...process.env };
const localLibs = path.join(ROOT, 'tools/chromedeps/libnss-stub');
if (fs.existsSync(localLibs)) env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const browser = await puppeteer.launch({ executablePath, args, headless, env });
const page = await browser.newPage();
const failures = [];
let currentLabel = '';
const ensure = (condition, message) => { if (!condition) failures.push(message); };
const pause = (ms = 270) => new Promise(resolve => setTimeout(resolve, ms));
await page.setRequestInterception(true);
page.on('request', request => {
  const url = request.url();
  if (url.startsWith('data:') || url.startsWith('blob:')) { request.continue(); return; }
  const target = new URL(url);
  // The local preview handles all API calls in memory. A network API request
  // indicates a misconfigured preview, so block it instead of touching data.
  if (target.pathname.startsWith('/pro/api/')) {
    failures.push(`${currentLabel}: blocked unexpected API network request ${target.pathname}`);
    request.abort();
  } else if (target.origin === base.origin) request.continue();
  else request.abort();
});
page.on('pageerror', error => failures.push(`${currentLabel} page error: ${error.message}`));

async function open(scene = '') {
  const url = new URL(base);
  if (scene) url.searchParams.set('scene', scene); else url.searchParams.delete('scene');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  // Refuse to interact with a production or misconfigured server.
  const notice = await page.$eval('.preview-notice', el => el.textContent).catch(() => '');
  if (!/DEMO PREVIEW.*No real orders or payments/i.test(notice)) throw new Error('Not the demo preview; refusing to interact.');
  await page.waitForSelector('#bottom-nav [data-tab="accounts"]:not([disabled])');
}
async function tab(name) {
  await page.click(`#bottom-nav [data-tab="${name}"]`);
  await page.waitForSelector(`#bottom-nav [data-tab="${name}"][aria-current="page"]`);
  await pause(100);
}
// Mobile focus can pan the visual viewport independently of the layout
// viewport. Tap the visible point rather than assuming their origins match.
async function tapVisible(selector) {
  await page.$eval(selector, el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  await pause(150);
  const point = await page.$eval(selector, el => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - (visualViewport?.offsetLeft || 0), y: r.top + r.height / 2 - (visualViewport?.offsetTop || 0) };
  });
  await page.touchscreen.tap(point.x, point.y);
}
async function check(view) {
  await pause();
  const info = await page.evaluate(() => {
    const width = innerWidth;
    const nav = document.querySelector('#bottom-nav').getBoundingClientRect();
    const dock = document.querySelector('#cart-dock .cart-dock')?.getBoundingClientRect();
    const pay = document.querySelector('.pay-bar')?.getBoundingClientRect();
    const overflow = [...document.querySelectorAll('body *')].filter(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
        !el.closest('.meal-track') && (rect.left < -1 || rect.right > width + 1);
    }).slice(0, 5).map(el => `${el.tagName}.${typeof el.className === 'string' ? el.className : ''}`);
    const small = [...document.querySelectorAll('main button, .topbar button, #bottom-nav button, #cart-dock button')].filter(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return !el.disabled && !el.closest('[hidden], [inert]') && style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && (rect.width < 43 || rect.height < 43);
    }).slice(0, 5).map(el => `${el.dataset.action || el.className}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
    // Overflowing text can bleed outside its box even if the box itself fits.
    const textOverflow = [...document.querySelectorAll('.coupon-inline-copy strong, .coupon-head strong, .coupon-line, .coupon-desc')]
      .filter(el => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .map(el => el.textContent.slice(0, 32));
    return { width, scrollWidth: document.documentElement.scrollWidth, overflow, small, textOverflow, navTop: nav.top, dockBottom: dock?.bottom, payBottom: pay?.bottom };
  });
  ensure(info.scrollWidth <= info.width + 1 && !info.overflow.length && !info.textOverflow.length, `${currentLabel} ${view}: horizontal overflow ${JSON.stringify(info)}`);
  ensure(!info.small.length, `${currentLabel} ${view}: small targets ${info.small.join(', ')}`);
  if (info.dockBottom !== undefined) ensure(info.dockBottom <= info.navTop, `${currentLabel} ${view}: dock overlaps navigation`);
  if (info.payBottom !== undefined) ensure(info.payBottom <= info.navTop + 1, `${currentLabel} ${view}: pay bar overlaps navigation`);
}

try {
  for (const width of [320, 360, 390, 430]) for (const dark of [false, true]) {
    currentLabel = `${width}px ${dark ? 'dark' : 'light'}`;
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await open(); await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bottom-nav [data-tab="accounts"]:not([disabled])');
    if (dark) await page.click('[data-action="theme"]');
    await check('accounts');
    const accountLayout = await page.evaluate(() => {
      const row = document.querySelector('.ac-row.active');
      const tags = [...row.querySelectorAll('.offer-chip')].map(el => { const r = el.getBoundingClientRect(); return { top: r.top, right: r.right }; });
      const primary = row.querySelector('.ac-main').getBoundingClientRect();
      return { tags, primaryRight: primary.right, height: row.getBoundingClientRect().height };
    });
    ensure(accountLayout.tags.length === 5 && accountLayout.tags.every(t => Math.abs(t.top - accountLayout.tags[0].top) < 1 && t.right <= accountLayout.primaryRight + 1) && accountLayout.height <= 100, `${currentLabel}: compact single-line offers ${JSON.stringify(accountLayout)}`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await pause();
    const clearance = await page.evaluate(() => ({ last: document.querySelector('.ac-cta')?.getBoundingClientRect().bottom, dock: document.querySelector('.cart-dock')?.getBoundingClientRect().top }));
    ensure(clearance.last <= clearance.dock, `${currentLabel}: account form hidden by dock`);
    await tab('address'); await page.waitForSelector('.address-row'); await check('address');
    await tab('search'); await check('search');
    await page.type('form[data-form="search"] input', 'Curry'); await page.click('form[data-form="search"] button');
    await page.waitForSelector('[data-action="restaurant"]'); await check('search results');
    await page.click('[data-action="restaurant"]'); await page.waitForSelector('.sheet-overlay'); await check('outlet sheet');
    ensure(await page.evaluate(() => document.querySelector('.app-shell').hasAttribute('inert') && document.activeElement?.hasAttribute('data-sheet-close')), `${currentLabel}: outlet focus/background`);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sheet-overlay'));
    ensure(await page.evaluate(() => !document.querySelector('.app-shell').hasAttribute('inert') && document.activeElement?.dataset.action === 'restaurant'), `${currentLabel}: outlet focus not restored`);
    await page.click('[data-action="restaurant"]'); await page.waitForSelector('.sheet-overlay'); await page.click('[data-sheet-outlet="demo-1"]');
    await page.waitForSelector('.menu-hero'); await check('menu');
    await page.waitForSelector('.menu-stepper [data-qty="3"]');
    await page.type('[data-input="menu-search"]', 'Paneer');
    await page.evaluate(() => { window.__qaMenuInput = document.querySelector('[data-input="menu-search"]'); });
    await tapVisible('.menu-stepper [data-qty="3"]');
    await page.waitForFunction(() => document.querySelector('.menu-stepper span')?.textContent === '3');
    ensure(await page.evaluate(() => document.querySelector('[data-input="menu-search"]') === window.__qaMenuInput && window.__qaMenuInput.value === 'Paneer' && [...document.querySelectorAll('[data-menu-item]')].filter(row => row.hidden).length >= 1), `${currentLabel}: menu quantity reset the filtered screen`);
    await tab('cart'); await page.waitForSelector('.pay-bar'); await check('checkout');
    const bill = await page.evaluate(() => ({
      visible: !!document.querySelector('#bill-details .bill-row.total'),
      text: document.querySelector('#content').textContent,
      toggles: !!document.querySelector('[data-action="bill-toggle"], [data-action="toggle-bill"]')
    }));
    ensure(bill.visible && /Bill Details/.test(bill.text) && /To Pay/.test(bill.text) && /Pay Now/.test(bill.text) && !bill.toggles && !/View Detailed Bill|Payment: UPI \/ QR|PAY USING UPI|Bill Updating/.test(bill.text), `${currentLabel}: direct bill/payment controls ${JSON.stringify(bill)}`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await check('checkout bottom');
    await tapVisible('[data-action="coupon-open"]'); await page.waitForSelector('.coupon-sheet'); await check('coupon sheet');
    const coupon = await page.evaluate(() => ({ underlay: !!document.querySelector('.coupon-underlay[inert] .restaurant-cart'), focus: !!document.activeElement?.closest('.coupon-sheet'), navInert: document.querySelector('.bottom-nav').hasAttribute('inert') }));
    ensure(coupon.underlay && coupon.focus && coupon.navInert, `${currentLabel}: coupon focus/inert ${JSON.stringify(coupon)}`);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.coupon-sheet'));
    const restored = await page.evaluate(() => ({ action: document.activeElement?.dataset.action, inert: document.querySelector('.bottom-nav').hasAttribute('inert') }));
    ensure(['coupon-open', 'toggle-coupon'].includes(restored.action) && !restored.inert, `${currentLabel}: coupon focus not restored`);
    await tab('orders'); await page.waitForSelector('[data-action="order-detail"]'); await check('orders');
    await page.click('[data-action="order-detail"]'); await page.waitForSelector('.order-top-actions'); await check('order detail');
    await page.waitForFunction(() => /Link unavailable/.test(document.querySelector('.share-card')?.textContent || ''));
    const order = await page.evaluate(() => ({ text: document.querySelector('#content').textContent, share: !!document.querySelector('.share-card') }));
    ensure(order.share && !/Refresh tracking|Open tracking on Swiggy|SMS explanation/i.test(order.text), `${currentLabel}: order details ${JSON.stringify(order)}`);
    await tab('tools'); await page.waitForSelector('[data-action="claim-offers"]'); await check('tools');
    const tools = await page.evaluate(() => ({ text: document.querySelector('#content').textContent, buttons: [...document.querySelectorAll('[data-action="claim-offers"]')].map(el => el.textContent.trim()) }));
    ensure(/ID access/.test(tools.text) && /Claimed/.test(tools.text) && /Already claimed/.test(tools.text) && /Failed/.test(tools.text) && tools.buttons.every(label => label === 'Claim') && !/Live Order \+ SMS|Data Backup|Backup ka asli sach|Login ID ka data|campaign ID/i.test(tools.text), `${currentLabel}: tools ${JSON.stringify(tools)}`);
    await open('paypending'); if (!await page.$('.pay-screen')) await tab('cart');
    await page.waitForSelector('.pay-screen'); await check('payment');
    ensure(!await page.$('#cart-dock .cart-dock'), `${currentLabel}: cart dock visible during payment`);
    ensure(await page.evaluate(() => !document.querySelector('a[href^="upi:"]') && (!document.querySelector('.payment-qr') || /demo/i.test(document.querySelector('.payment-qr').alt)) && /no live verification/i.test(document.querySelector('.pay-screen').textContent)), `${currentLabel}: demo payment link, QR or status was not labelled/blocked`);
    await open('handoff-bill'); await page.waitForSelector('.handoff-steps'); await check('chat handoff');
    ensure((await page.$$('[aria-current="step"]')).length === 1, `${currentLabel}: handoff step missing`);
    console.log(`✓ ${currentLabel}`);
  }

  currentLabel = 'safe area / keyboard / cart updates';
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await open(); await tab('accounts'); await page.waitForSelector('.cart-dock');
  await page.evaluate(() => { document.documentElement.style.setProperty('--tg-content-safe-area-inset-top', '26px'); document.documentElement.style.setProperty('--tg-safe-area-inset-bottom', '18px'); });
  const insets = await page.evaluate(() => ({ top: document.querySelector('.topbar').getBoundingClientRect().height, nav: document.querySelector('.bottom-nav').getBoundingClientRect().height, dock: document.querySelector('.cart-dock').getBoundingClientRect().bottom, navTop: document.querySelector('.bottom-nav').getBoundingClientRect().top }));
  ensure(insets.top >= 90 && insets.nav >= 86 && insets.dock < insets.navTop, `safe-area layout: ${JSON.stringify(insets)}`);
  await tab('search'); await page.focus('input[name="q"]');
  await page.setViewport({ width: 390, height: 500, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await pause();
  ensure(await page.evaluate(() => document.body.classList.contains('keyboard-open') && getComputedStyle(document.querySelector('.bottom-nav')).visibility === 'hidden'), 'keyboard open did not hide bottom controls');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await pause();
  ensure(await page.evaluate(() => !document.body.classList.contains('keyboard-open') && getComputedStyle(document.querySelector('.bottom-nav')).visibility === 'visible'), 'keyboard close did not restore bottom controls');
  await page.evaluate(() => document.activeElement.blur()); await pause();
  await tab('cart'); await page.waitForSelector('[data-action="qty"][data-qty="3"]'); await page.click('[data-action="qty"][data-qty="3"]');
  await page.waitForFunction(() => document.querySelector('.stepper span')?.textContent === '3');
  await tab('search'); await page.waitForFunction(() => document.querySelector('.cart-dock')?.textContent.includes('3 items'));
  ensure((await page.$eval('.cart-dock', el => el.textContent)).includes('₹637'), 'updated quantity/bill not reflected in dock');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const motion = await page.$eval('.cart-dock', el => ({ duration: getComputedStyle(el).animationDuration, iterations: getComputedStyle(el).animationIterationCount }));
  ensure(parseFloat(motion.duration) <= .001 && motion.iterations !== 'infinite', `reduced motion: ${JSON.stringify(motion)}`);
  await page.emulateMediaFeatures([]);
  console.log('✓ safe area, keyboard, cart updates and reduced motion');

  currentLabel = 'long content / confirmation';
  await page.setViewport({ width: 320, height: 700, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await open('stress'); await tab('accounts'); await check('long account');
  await tab('address'); await page.waitForSelector('.address-row'); await check('long address');
  await tab('cart'); await page.waitForSelector('.pay-bar'); await check('long cart');
  await tapVisible('[data-action="cart-clear"]'); await page.waitForSelector('.confirm-dialog'); await check('confirmation');
  const dialog = await page.$eval('.confirm-dialog', el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight, focus: document.activeElement?.textContent, inert: document.querySelector('.app-shell').hasAttribute('inert') }; });
  ensure(dialog.top >= 0 && dialog.bottom <= dialog.height && dialog.focus === 'Cancel' && dialog.inert, `confirmation bounds/focus: ${JSON.stringify(dialog)}`);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.confirm-dialog'));
  await page.waitForFunction(() => document.activeElement?.dataset.action === 'cart-clear');
  ensure(await page.evaluate(() => Boolean(document.querySelector('.restaurant-cart')) && !document.querySelector('.app-shell').hasAttribute('inert')), 'cancelling confirmation changed the cart or left the background inert');
  await tapVisible('[data-action="coupon-open"]'); await page.waitForSelector('.coupon-sheet'); await check('long coupon');
  console.log('✓ long content and confirmation');

  currentLabel = 'empty cart / disabled checkout';
  await open('empty'); await tab('cart'); await page.waitForSelector('.empty'); await check('empty cart');
  ensure(!await page.$('#cart-dock .cart-dock'), 'empty cart displayed a dock');
  await open('blocked'); await tab('cart'); await page.waitForSelector('.pay-blocked');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await check('blocked checkout');
  const blocked = await page.evaluate(() => {
    const warning = document.querySelector('.pay-blocked').getBoundingClientRect();
    const pay = document.querySelector('.pay-bar').getBoundingClientRect();
    const nav = document.querySelector('#bottom-nav').getBoundingClientRect();
    const notice = document.querySelector('.preview-notice').getBoundingClientRect();
    return { warningTop: warning.top, warningBottom: warning.bottom, payBottom: pay.bottom, navTop: nav.top, noticeTop: notice.top, noticeBottom: notice.bottom, disabled: document.querySelector('[data-action="checkout-start"]').disabled };
  });
  ensure(blocked.disabled && blocked.warningTop >= blocked.payBottom && blocked.warningBottom <= blocked.navTop, `blocked checkout warning obscured: ${JSON.stringify(blocked)}`);
  ensure(blocked.noticeTop >= 0 && blocked.noticeBottom < blocked.navTop, `demo notice not visible after scrolling: ${JSON.stringify(blocked)}`);
  console.log('✓ empty and blocked checkout states');

  currentLabel = 'demo handoff progression';
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await open('handoff-account'); await page.waitForSelector('[data-action="handoff-choose"][data-key="demo-account-2"]'); await check('choose ID');
  await tapVisible('[data-action="handoff-choose"][data-key="demo-account-2"]');
  await page.waitForSelector('form[data-form="handoff-address"]'); await check('confirm address');
  const recipient = await page.evaluate(() => ({ name: document.querySelector('[name="receiver_name"]').value, mobile: document.querySelector('[name="receiver_mobile"]').value }));
  ensure(recipient.name === 'Ammi' && recipient.mobile === '9000000003', `demo recipient not prefilled: ${JSON.stringify(recipient)}`);
  await tapVisible('form[data-form="handoff-address"] button[type="submit"]');
  await page.waitForSelector('[data-action="handoff-bill"]'); await check('review cart');
  await tapVisible('[data-action="handoff-bill"]'); await page.waitForSelector('.confirm-dialog');
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await page.waitForSelector('[data-action="checkout-start"]'); await check('review bill');
  ensure((await page.$eval('[aria-current="step"]', el => el.textContent)).includes('Bill'), 'demo handoff did not reach bill');
  console.log('✓ demo ID → address → cart → bill (no checkout)');
} catch (error) {
  failures.push(`${currentLabel}: ${error.stack || error.message}`);
} finally {
  await browser.close();
}
if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log('All browser layout checks passed against demo data only.');
}
