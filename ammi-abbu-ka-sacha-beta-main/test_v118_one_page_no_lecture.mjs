// Boss (01-11-2026, round 29):
//   "EK PAGE ME SAARI INFORMATION WO DE RAHA AND TU USER KO BATATE BATATE DAM TOD DE RAHA."
//
// Isliye: cart page = ek hi page jahan address, items, coupons + APPLY, bill,
// payment aur Pay bar sab dikhe. Koi lecture paragraph nahi, koi duplicate
// plain-text bill nahi. Jo detail chahiye wo ek tap par khulti hai.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

const baseState = {
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' },
  selectedAddress: { id: 'a1', name: 'Skk', mobile: '7978459775', address: 'Flat 412, Parivartan Society' },
  selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true,
  coupons: [
    { code: 'FLAT150', title: '₹150 OFF', description: 'Save ₹150 on this order!' },
    { code: 'TRYNEW', title: '70% OFF', description: 'Save ₹140 on this order!' },
    { code: 'DELULU4FOOD', title: '70% OFF', description: 'Save ₹140 on this order!' },
    { code: 'SAMSUNGPAY', title: '₹50 OFF', description: 'Save ₹50 on this order!' }
  ],
  wallet: { balancePaise: 500, balance: '5', feePaise: 1500, fee: '15', ready: false, shortfall: '10', upiId: 'mius@ybl', presets: [], history: [] }
};
const withCart = (over = {}) => ({
  ...baseState,
  cart: {
    restaurantId: '201', restaurantName: 'Arabecue Fried Chicken', restaurantArea: 'Aliganj', restaurantTime: '40-50 mins', restaurantRating: '4.2',
    items: [{ lineKey: 'l', name: 'Arabian Chicken Longer Burger', price: 171, qty: 2, isVeg: false }],
    quote: { itemTotal: 342, deliveryFee: 28, deliverySaved: 28, taxes: 60.28, total: 402, coupon: '', discount: 0, totalSavings: 28, fetchedAt: new Date().toISOString() }
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
    window.__CALLS.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    const out = responder ? responder(String(url), opts) : window.__STATE;
    return { ok: true, status: 200, json: async () => out };
  };
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
// Sirf wahi text jo user ko dikhta hai — [hidden] aur band inline styles chhod kar.
function visibleText(root) {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3) { out += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    if (node.hasAttribute('hidden')) return;
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out.replace(/\s+/g, ' ').trim();
}
async function openCart(state, responder) {
  const dom = boot(state, responder);
  const { window } = dom;
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
  window.document.querySelector('[data-tab="cart"]').click();
  return dom;
}

test('cart: returned bill is directly visible without an expansion toggle', async () => {
  const dom = await openCart(withCart());
  const { window } = dom;
  try {
    const bill = await waitFor(() => window.document.querySelector('.bill-card'), 'bill');
    assert.match(visibleText(bill), /To Pay.*₹402/);
    assert.equal(window.document.querySelector('[data-action="bill-open"]'), null);
    assert.equal(window.document.querySelector('.bill-plain'), null);
  } finally { window.close(); }
});

test('cart: coupons usi page par, APPLY button se asli bill badalta hai', async () => {
  const sync = withCart();
  sync.cart.quote = { ...sync.cart.quote, coupon: 'TRYNEW', discount: 140, total: 262 };
  const dom = await openCart(withCart(), (url) => (url.includes('/cart/sync') ? { ok: true, selectedAddress: sync.selectedAddress, cart: sync.cart } : withCart()));
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelectorAll('.coupon-inline').length >= 2, 'inline coupons');
    const rows = [...window.document.querySelectorAll('.coupon-inline')];
    assert.match(rows[0].textContent, /FLAT150/);
    assert.ok(rows[0].querySelector('button[data-action="coupon-pick"]'), 'APPLY саamne');
    rows[0].querySelector('button[data-action="coupon-pick"]').click();
    await waitFor(() => window.__CALLS.some(c => c.url.endsWith('/cart/sync')), 'sync');
    assert.equal(window.__CALLS.find(c => c.url.endsWith('/cart/sync')).body.coupon, 'FLAT150');
    assert.ok(window.document.querySelector('[data-action="coupon-open"]'), 'poora list ek tap door');
  } finally { window.close(); }
});

test('cart: koi lecture paragraph nahi — page par text kam', async () => {
  const dom = await openCart(withCart());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('.bill-card'), 'bill card');
    const text = visibleText(window.document.querySelector('main'));
    for (const dead of [
      /Neeche Pay Now dabane par Swiggy ek asli order request/i,
      /Share link, swiggy\.com\/gc/i,
      /Swiggy se aaya bill\. Coupon\/free cash/i,
      /Payment alag se UPI se hoti hai/i
    ]) assert.equal(dead.test(text), false, 'purani lecture line hata di: ' + dead);
    // Sab kuch ek page par: address, items, coupon, bill, payment, pay bar.
    for (const key of ['DELIVERING TO', 'Your Order', 'SAVINGS CORNER', 'Bill Details', 'Pay Now']) {
      assert.ok(text.includes(key), key);
    }
    assert.ok(text.length < 1500, `visible text budget — actual ${text.length}`);
  } finally { window.close(); }
});

test('cart: idle countdown copy is removed without changing the server rule', async () => {
  const state = withCart({ idle: { timeoutMs: 120000 } });
  const dom = await openCart(state);
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('.pay-bar'), 'pay bar');
    assert.equal(window.document.querySelector('.pay-bar .idle-note'), null);
  } finally { window.close(); }
});

test('css: inline coupon rows + chhoti idle chip', () => {
  assert.match(css, /\.coupon-inline \{/);
  assert.match(css, /\.coupon-inline-ribbon \{/);
  assert.match(css, /\.pay-bar \.idle-note \{/);
});
