// Boss (01-11-2026, round 32):
//   "JAISE QR AYE TO WO QR 5 MINUTE TAK PAYMENT VERIFY KARTE RAHE AND JAISE
//    VERIFY HO MY ORDERS PAR JAYE ... THREE DOT ... SHARE ... LINK DEDE"
//
// Yahan test hota hai:
//   1) QR aane par poore 5 minute tak auto-check (5s interval), live countdown
//   2) 5 minute poore hone par jhooth nahi — "auto-check band, khud check karein"
//   3) verify hote hi seedha My Orders → wahi order detail
//   4) order detail me Swiggy ka asli share link + copy + Telegram share
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

const SHARE = 'https://www.swiggy.com/ofo/track/abc123token';
const baseState = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine', phone: '9234567890' },
  selectedAddress: { id: 'a1', name: 'Skk', mobile: '7978459775', address: 'Flat 412' },
  selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true,
  orders: [], ordersLoading: false,
  ...over
});
const pendingCheckout = (over = {}) => baseState({
  checkout: {
    status: 'PAYMENT_PENDING', orderId: '252355785108792', amount: 402,
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', upiIntentUrl: 'upi://pay?pa=x@ybl&am=402',
    paymentVerified: false, message: 'QR Swiggy se aaya hai.', tracking: null, sms: null
  },
  ...over
});

function boot(state, responder) {
  const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''), {
    runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true
  });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.__STATE = state;
  window.__CALLS = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    window.__CALLS.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    const out = responder ? responder(u, opts) : window.__STATE;
    return { ok: true, status: 200, json: async () => out };
  };
  window.eval(appSource);
  return dom;
}
const waitFor = async (fn, label, ms = 9000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const v = fn(); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout: ' + label);
};

const paidState = () => baseState({
  orders: [{ id: '252355785108792', status: 'PAID', restaurant: 'Arabecue Fried Chicken', amount: 402, placedAt: '01/11/26, 7:20 pm', items: [] }],
  checkout: { status: 'PAID', orderId: '252355785108792', amount: 402, paymentVerified: true, message: 'paid', sms: null,
    tracking: { orderId: '252355785108792', status: 'Order placed', trackingUrl: SHARE, via: 'FYI_CTA', tried: [], sms: null } }
});

test('QR screen par 5:00 ka live verify strip aur har 5s ka auto check', async () => {
  const dom = boot(pendingCheckout(), () => pendingCheckout());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    const strip = await waitFor(() => window.document.querySelector('.verify-strip'), 'verify strip');
    assert.match(strip.textContent, /Payment verify ho rahi hai/);
    const clock = strip.querySelector('[data-pay-clock]');
    assert.match(clock.textContent, /^[45]:\d{2}$/, 'shuru me ~5:00');
    assert.match(strip.textContent, /poore 5 minute tak/);
    // pehla auto-check ~5s baad
    await waitFor(() => window.__CALLS.some(c => c.url.endsWith('/checkout/status')), 'auto status call', 9000);
    assert.ok(window.document.querySelector('[data-pay-clock]'), 'clock wahi rehta hai');
  } finally { window.close(); }
});

test('verify hote hi seedha My Orders ka wahi order khulta hai (share link ke saath)', async () => {
  let paid = false;
  const dom = boot(pendingCheckout(), (url) => {
    if (url.endsWith('/checkout/status')) { paid = true; return paidState(); }
    if (url.includes('/orders/tracking')) return { ok: true, tracking: paidState().checkout.tracking, sms: null };
    if (url.endsWith('/orders')) return { ok: true, orders: paidState().orders, detailAllowed: true };
    if (url.endsWith('/bootstrap')) return paid ? paidState() : pendingCheckout();
    return pendingCheckout();
  });
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    // auto-check chalega → PAID → orders tab + order detail
    const card = await waitFor(() => window.document.querySelector('.share-card'), 'share card', 15000);
    assert.equal(window.document.querySelector('.bottom-nav button.selected').dataset.tab, 'orders', 'My Orders khula');
    assert.ok(window.document.querySelector('[data-action="orders-back"]'), 'order detail khula');
    assert.match(window.document.body.textContent, /Relax|Arabecue|Arabecue Fried Chicken/);
    const input = card.querySelector('[data-share-input]');
    assert.equal(input.value, SHARE, 'Swiggy ka asli link');
    assert.match(card.textContent, /Share link/);
    assert.ok(card.querySelector('[data-action="share-copy"]'), 'copy button');
    assert.ok(card.querySelector('[data-action="share-send"]'), 'Telegram share button');
  } finally { window.close(); }
});

test('share link copy hota hai aur Telegram share sheet khulta hai', async () => {
  let copied = '';
  let opened = '';
  const state = baseState({
    orders: [{ id: '252355785108792', status: 'PAID', restaurant: 'Arabecue', amount: 402, placedAt: 'x', items: [] }],
    orderTracking: { orderId: '252355785108792', status: 'Placed', trackingUrl: SHARE, tried: [] }
  });
  const dom = boot(state, (url) => {
    if (url.endsWith('/orders')) return { ok: true, orders: state.orders, detailAllowed: true };
    if (url.includes('/orders/tracking')) return { ok: true, tracking: state.orderTracking, sms: null };
    return state;
  });
  const { window } = dom;
  try {
    window.Telegram.WebApp.openTelegramLink = (u) => { opened = u; };
    window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    await waitFor(() => window.document.querySelector('[data-tab="orders"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-action="nav"][data-tab="orders"]').click();
    const row = await waitFor(() => window.document.querySelector('[data-action="order-detail"]'), 'order row');
    row.click();
    const card = await waitFor(() => window.document.querySelector('.share-card [data-action="share-send"]'), 'share buttons');
    card.click();
    await waitFor(() => opened.length > 0, 'telegram share');
    assert.match(opened, /^https:\/\/t\.me\/share\/url\?url=/);
    assert.ok(decodeURIComponent(opened).includes(SHARE), 'share me wahi link');
    assert.equal(copied, SHARE, 'link copy bhi hua');

    // Copy button alag se
    copied = '';
    window.document.querySelector('[data-action="share-copy"]').click();
    await waitFor(() => copied === SHARE, 'copy action');
    const toast = await waitFor(() => /copy ho gaya/.test(window.document.querySelector('#toast').textContent) && window.document.querySelector('#toast'), 'copy toast');
    assert.equal(toast.className, 'toast-ok');
  } finally { window.close(); }
});

test('share link na mile to concise unavailable state, no fabricated link or refresh control', async () => {
  const state = baseState({
    orders: [{ id: '111', status: 'PAID', restaurant: 'R', amount: 200, placedAt: 'x', items: [] }],
    orderTracking: { orderId: '111', status: 'Placed', trackingUrl: '', tried: ['FYI_CTA', 'ORDER_DETAILS'] }
  });
  const dom = boot(state, (url) => {
    if (url.endsWith('/orders')) return { ok: true, orders: state.orders, detailAllowed: true };
    if (url.includes('/orders/tracking')) return { ok: true, tracking: state.orderTracking, sms: null };
    return state;
  });
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="orders"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-action="nav"][data-tab="orders"]').click();
    const row = await waitFor(() => window.document.querySelector('[data-action="order-detail"]'), 'row');
    row.click();
    const card = await waitFor(() => window.document.querySelector('.share-card')?.textContent.includes('Link unavailable') && window.document.querySelector('.share-card'), 'share unavailable');
    assert.match(card.textContent, /Link unavailable/i);
    assert.equal(card.querySelector('[data-action="order-tracking"]'), null);
    assert.equal(/^https:\/\//.test(card.querySelector('[data-share-input]')?.value || ''), false);
  } finally { window.close(); }
});

test('5 minute poore hone par auto-check band + sach wala message (infinite spinner nahi)', async () => {
  // 5 minute ka intezaar nahi — window ko past me set karke wahi halat banate hain.
  const dom = boot(pendingCheckout(), () => pendingCheckout());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => window.document.querySelector('.verify-strip'), 'strip');
    // window ko expire karo aur dobara render karao (jaisa 5 min baad hota hai)
    window.eval('__expirePayWindow()');
    const expired = await waitFor(() => window.document.querySelector('.verify-strip.expired'), 'expired strip');
    assert.match(expired.textContent, /5 minute poore ho gaye/);
    assert.match(expired.textContent, /Payment check karein/);
    assert.equal(expired.querySelector('.spinner'), null, 'spinner band');
  } finally { window.close(); }
});

test('css: verify strip + share card ke naap', () => {
  assert.match(css, /\.verify-strip \{/);
  assert.match(css, /\.verify-strip \.verify-icon\.spinner \{/);
  assert.match(css, /\.verify-strip\.expired \{/);
  assert.match(css, /\.share-link-input \{/);
  assert.match(css, /\.share-card \.share-actions \.button/);
});

test('js: 5 minute / 5 second constants aur reduced-motion', () => {
  assert.match(appSource, /const PAY_WINDOW_MS = 5 \* 60 \* 1000;/);
  assert.match(appSource, /const PAY_POLL_MS = 5000;/);
  assert.match(appSource, /openOrdersForOrder\(out\.checkout\.orderId, \{ share: true \}\)/);
  assert.match(css, /prefers-reduced-motion[\s\S]*verify-strip/);
});
