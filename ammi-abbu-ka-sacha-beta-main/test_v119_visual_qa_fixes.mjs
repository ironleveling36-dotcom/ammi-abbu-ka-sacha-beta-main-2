// Boss (01-11-2026, round 30): "high-fidelity replication + run it, screenshot it,
// compare it". Screenshot harness ne jo asli bug pakde, unke liye guard.
//
//   1) emoji (✨) ki jagah SVG — emoji font na ho to tofu box banta hai
//   2) wallet top-up Mini App me nahi — user ne bot me rakha hai
//   3) address heading me naam (Skk), "Delivery address" nahi
//   4) orders filter: This Account / Last 1 Hour — count sirf sach me pata ho
//   5) order detail: sirf wahi bill line jo Swiggy ne di (kuch guess nahi)
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const shotTool = fs.readFileSync(new URL('./tools/screenshot-miniapp.mjs', import.meta.url), 'utf8');

const base = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' },
  selectedAddress: { id: 'a1', name: 'Skk', mobile: '7978459775', address: 'Flat 412, Parivartan Society' },
  selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true,
  wallet: { balancePaise: 500, balance: '5', feePaise: 1500, fee: '15', ready: false, shortfall: '10', upiId: 'mius@ybl', presets: [], history: [] },
  ...over
});
const cartState = (over = {}) => base({
  cart: {
    restaurantId: '201', restaurantName: 'Arabecue Fried Chicken', restaurantArea: 'Aliganj', restaurantTime: '40-50 mins',
    items: [{ lineKey: 'l', name: 'Burger', price: 171, qty: 2, isVeg: false }],
    quote: { itemTotal: 342, deliveryFee: 28, deliverySaved: 28, taxes: 60.28, total: 402, coupon: '', discount: 0, totalSavings: 28, fetchedAt: new Date().toISOString() }
  },
  ...over
});

function boot(state) {
  const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''), {
    runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true
  });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.__STATE = state;
  window.fetch = async () => ({ ok: true, status: 200, json: async () => window.__STATE });
  window.eval(appSource);
  return dom;
}
const waitFor = async (fn, label, ms = 5000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const v = fn(); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout: ' + label);
};
const open = async (state, tab) => {
  const dom = boot(state);
  const { window } = dom;
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
  window.document.querySelector(`[data-action="nav"][data-tab="${tab}"]`).click();
  return dom;
};

test('savings banner me SVG spark hai, emoji nahi (emoji font na ho to tofu banta hai)', async () => {
  const dom = await open(cartState(), 'cart');
  const { window } = dom;
  try {
    const banner = await waitFor(() => window.document.querySelector('.savings-banner'), 'banner');
    assert.ok(banner.querySelector('svg.icon'), 'SVG icon');
    assert.equal(/[\u2728\u2b50\u2705]/.test(banner.textContent), false, 'koi emoji nahi');
  } finally { window.close(); }
});

test('wallet top-up controls stay out of the Mini App even when wallet data exists', async () => {
  const state = cartState({ wallet: { ...base().wallet, presets: [{ paise: 1500, rupees: '15' }, 5000, { paise: 10000, rupees: '100' }] } });
  const dom = await open(state, 'cart');
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('.pay-bar'), 'cart');
    assert.equal(window.document.querySelectorAll('[data-action="wallet-topup"]').length, 0);
    window.document.querySelector('[data-action="nav"][data-tab="tools"]').click();
    await waitFor(() => window.document.querySelector('#bottom-nav [data-tab="tools"][aria-current="page"]'), 'tools');
    assert.equal(window.document.querySelectorAll('[data-action="wallet-topup"]').length, 0);
  } finally { window.close(); }
});

test('address row me naam dikhta hai, generic "Delivery address" nahi', async () => {
  const dom = await open(cartState(), 'cart');
  const { window } = dom;
  try {
    const row = await waitFor(() => window.document.querySelector('.select-address'), 'address row');
    assert.match(row.textContent, /Skk/);
    assert.equal(/Delivery addressFlat|>Delivery address</.test(row.innerHTML), false);
  } finally { window.close(); }
});

test('orders: This Account / Last 1 Hour segmented, count sirf jab time pata ho', async () => {
  const orders = [{ id: '1', status: 'Delivered', restaurant: 'A', amount: 37, placedAt: '31/10/26, 12:19 am', items: [] }];
  const dom = await open(base({ orders }), 'orders');
  const { window } = dom;
  try {
    const seg = await waitFor(() => window.document.querySelector('.segmented'), 'segmented');
    const [all, hour] = seg.querySelectorAll('button');
    assert.match(all.textContent, /This Account/);
    assert.match(hour.textContent, /Last 1 Hour/);
    assert.equal(all.getAttribute('aria-selected'), 'true');
    // "31/10/26, 12:19 am" parse nahi hota → count nahi, button band, wajah bhi di.
    assert.equal(hour.disabled, true, 'time na ho to band');
    assert.match(hour.getAttribute('title'), /nahi diya/i);
    assert.equal(/Last 1 Hour ·/.test(hour.textContent), false, 'jhoota count nahi');
  } finally { window.close(); }
});

test('orders: ISO time ho to Last 1 Hour ka asli count + filter chalta hai', async () => {
  const nowIso = new Date().toISOString();
  const orders = [
    { id: '1', status: 'Delivered', restaurant: 'Fresh', amount: 37, placedAtIso: nowIso, items: [] },
    { id: '2', status: 'Delivered', restaurant: 'Pुराना', amount: 40, placedAtIso: '2026-01-01T10:00:00Z', items: [] }
  ];
  const dom = await open(base({ orders }), 'orders');
  const { window } = dom;
  try {
    const seg = await waitFor(() => window.document.querySelector('.segmented'), 'segmented');
    const hour = seg.querySelectorAll('button')[1];
    await waitFor(() => window.document.querySelectorAll('[data-action="order-detail"]').length === 2, 'orders load');
    const hour2 = window.document.querySelectorAll('.segmented button')[1];
    assert.equal(hour2.disabled, false);
    assert.match(hour2.textContent, /Last 1 Hour · 1/);
    hour2.click();
    await waitFor(() => window.document.querySelectorAll('[data-action="order-detail"]').length === 1, 'filter lagu');
    assert.match(window.document.body.textContent, /Fresh/);
    assert.equal(/पुराना|पुराना/.test(window.document.body.textContent), false);
  } finally { window.close(); }
});

test('order detail: bill lines sirf jo Swiggy ne di, warna total-only sach', async () => {
  const bareOrder = { id: '9', status: 'Delivered', restaurant: 'R', amount: 37, placedAt: '31/10/26', items: [{ name: 'Shake', qty: 1 }] };
  let dom = await open(base({ orders: [bareOrder] }), 'orders');
  try {
    const row = await waitFor(() => dom.window.document.querySelector('[data-action="order-detail"]'), 'order row');
    row.click();
    const card = await waitFor(() => [...dom.window.document.querySelectorAll('.card')].find(c => /Payment & bill/.test(c.textContent)), 'bill card');
    assert.match(card.textContent, /Total/);
    assert.doesNotMatch(card.textContent, /Total paid|line-by-line bill nahi diya/);
  } finally { dom.window.close(); }

  const richOrder = {
    id: '9', status: 'Delivered', restaurant: 'R', amount: 37, placedAt: '31/10/26',
    items: [{ name: 'Shake', qty: 1, price: 29 }], paymentMethod: 'UPI',
    platformFee: 5, taxes: 3, couponDiscount: 10, itemTotal: 29
  };
  dom = await open(base({ orders: [richOrder] }), 'orders');
  try {
    const richRow = await waitFor(() => dom.window.document.querySelector('[data-action="order-detail"]'), 'order row');
    richRow.click();
    const card = await waitFor(() => [...dom.window.document.querySelectorAll('.card')].find(c => /Payment & bill/.test(c.textContent)), 'bill card');
    assert.match(card.textContent, /UPI/);
    assert.match(card.textContent, /Platform fee/);
    assert.match(card.textContent, /Coupon discount/);
    assert.match(card.textContent, /−₹10/);
    assert.match(card.textContent, /Total/);
  } finally { dom.window.close(); }
});

test('screenshot harness maujood hai (Rule 8 — asli browser se PNG)', () => {
  assert.match(shotTool, /puppeteer-core/);
  assert.match(shotTool, /const VIEWPORT = \{ width: 390, height: 844/);
  assert.match(shotTool, /screenshots/);
});

test('css: order card ka details arrow + segmented spacing', () => {
  assert.match(css, /\.order-row \.row-link \{/);
  assert.match(css, /main \.segmented \{ margin: 0 0 var\(--s-3\); \}/);
});
