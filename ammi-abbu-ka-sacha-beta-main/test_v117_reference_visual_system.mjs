// Boss (31-10-2026, round 28):
//   "PURA SPACING AND FONT SIZE ANIMATED ICON AND EVERYTHING COPY KARNA HAI"
//
// Yani reference jaisa rhythm: 4/8/12/16/20 ka spacing grid, 11–27px type
// scale, soft 16px cards, tinted rows, animated icons, toggle switch, payment
// tiles, delivered hero. Functionality aur sach wahi rehta hai.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

// ── 1. Design system ─────────────────────────────────────────────────────
test('css: spacing grid + type scale tokens (4/8/12/16/20, 11–27px)', () => {
  for (const token of ['--s-1: 4px', '--s-2: 8px', '--s-3: 12px', '--s-4: 16px', '--s-5: 20px', '--s-6: 24px']) {
    assert.ok(css.includes(token), token);
  }
  for (const token of ['--t-11: 11px', '--t-12: 12px', '--t-13: 13px', '--t-14: 14px', '--t-15: 15px', '--t-17: 17px', '--t-27: 27px']) {
    assert.ok(css.includes(token), token);
  }
});

test('css: cards 16px padding, 18px radius, soft shadow', () => {
  assert.match(css, /\.card \{\s*padding: var\(--s-4\) var\(--s-4\)/);
  assert.match(css, /border-radius: var\(--r-lg\)/);
  assert.match(css, /--shadow-card: 0 4px 16px/);
});

test('css: animated icons — draw-in, pop, spin, blink, chevron nudge', () => {
  for (const key of ['icon-draw', 'icon-pop', 'icon-spin-slow', 'dot-blink', 'chevron-nudge', 'check-pop']) {
    assert.match(css, new RegExp(`@keyframes ${key}\\b`), key);
  }
  assert.match(css, /\.icon \{[^}]*animation: icon-draw/);
  assert.match(css, /\.icon-tile \.icon \{[^}]*icon-draw[^}]*icon-pop/);
  assert.match(css, /\.live-dot \{[^}]*dot-blink/);
});

test('css: reference components — switch, select-address, pay tiles, pay bar, delivered hero', () => {
  assert.match(css, /\.switch \{/);
  assert.match(css, /\.switch\[aria-checked="true"\]:after \{ transform: translateX\(19px\); \}/);
  assert.match(css, /\.select-address \{/);
  assert.match(css, /\.pay-option\.selected \{/);
  assert.match(css, /\.pay-option\.selected \.pay-radio:after/);
  assert.match(css, /\.updating-pill \{/);
  assert.match(css, /\.pay-bar \.pay-left strong \{ font-size: var\(--t-20\)/);
  assert.match(css, /\.delivered-check \{/);
  assert.match(css, /\.coupon-sheet-head \{/);
});

test('css: chhote phone (≤380px) par padding kam, kuch nahi tootta', () => {
  assert.match(css, /@media \(max-width: 380px\)/);
});

// ── 2. UI structure ──────────────────────────────────────────────────────
const baseState = {
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' },
  selectedAddress: { id: 'a1', name: 'Skk', mobile: '7978459775', address: 'Flat 412, Parivartan Society' },
  selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true,
  wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [], history: [] }
};
const cartState = (over = {}) => ({
  ...baseState,
  cart: {
    restaurantId: '201', restaurantName: 'Arabecue Fried Chicken', restaurantArea: 'Aliganj', restaurantTime: '40-50 mins',
    items: [{ lineKey: 'l', name: 'Arabian Chicken Longer Burger', price: 171, qty: 2, isVeg: false }],
    quote: { total: 402, itemTotal: 342, deliveryFee: 28, deliverySaved: 28, taxes: 60.28, coupon: '', discount: 0, fetchedAt: new Date().toISOString() }
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

test('cart: group cart card me toggle switch + button phir bhi hamesha saamne', async () => {
  const dom = boot(cartState());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    const sw = await waitFor(() => window.document.querySelector('.group-cart-card .switch'), 'switch');
    assert.equal(sw.getAttribute('role'), 'switch');
    assert.equal(sw.getAttribute('aria-checked'), 'true');
    assert.ok(window.document.querySelector('form[data-form="group-cart"] button[type="submit"]').textContent.includes('Cart parse karein'), 'import button saamne hi hai');
    sw.click();
    await waitFor(() => window.document.querySelector('.group-cart-card.off'), 'off state');
  } finally { window.close(); }
});

test('cart: address row reference jaisa (pin + DELIVERING TO + chevron)', async () => {
  const dom = boot(cartState());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    const row = await waitFor(() => window.document.querySelector('.select-address'), 'address row');
    assert.match(row.textContent, /DELIVERING TO/);
    assert.match(row.textContent, /Skk|Flat 412/);
    assert.ok(row.querySelector('.pin') && row.querySelector('.chev'));
  } finally { window.close(); }
});

test('cart: payment and updating cards are omitted while real checkout stays available', async () => {
  const pending = cartState();
  pending.cart.quote = null;
  const dom = boot(pending);
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => window.document.querySelector('.pay-bar .pay-now'), 'pay bar');
    assert.equal(window.document.querySelector('.pay-method-card'), null);
    assert.equal(window.document.querySelector('.pay-bar .updating-pill'), null);
    assert.equal(window.document.querySelector('.pay-now').disabled, false);
  } finally { window.close(); }
});

test('orders: delivered status par bada green check + Back to Orders pill', async () => {
  const dom = boot({
    ...baseState,
    orders: [{ id: '252355785108792', status: 'Delivered', restaurant: 'Relax Corner Pure Veg', amount: 37, placedAt: '31/10/26 12:19 AM', items: [] }],
    order: { id: '252355785108792', status: 'Delivered', restaurant: 'Relax Corner Pure Veg', amount: 37, placedAt: '31/10/26 12:19 AM', items: [{ name: 'Kaju cream Milkshake', qty: 1 }] }
  });
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="orders"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="orders"]').click();
    await waitFor(() => window.document.querySelector('[data-action="order-detail"]'), 'order row');
    window.document.querySelector('[data-action="order-detail"]').click();
    const hero = await waitFor(() => window.document.querySelector('.delivered-hero'), 'delivered hero');
    assert.match(hero.textContent, /Order Delivered/);
    assert.ok(hero.querySelector('.delivered-check .icon'), 'green check');
    assert.match(window.document.querySelector('.back-pill').textContent, /Back to Orders/);
  } finally { window.close(); }
});
