// Boss (31-10-2026, round 27):
//   "SEE ALL THESE ANIMATION AND FONT AND STRATEGY ITS LOOKS AMAZING — MY
//    PROFESSOR SON IS GOING TO BEAT ME EASILY"
//
// Yani: dikhne me utna hi premium chahiye — font, motion, toast, skeleton,
// sheet, nav. Par jhooth nahi: sirf wahi animation jo sach dikhata hai (kaam
// hua = hara, nahi hua = laal), aur reduced-motion wale phone par sab shaant.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

// ── 1. CSS system ────────────────────────────────────────────────────────
test('css: readable system font without a remote font dependency', () => {
  const currentFontToken = css.slice(css.lastIndexOf('--font-ui:'), css.indexOf(';', css.lastIndexOf('--font-ui:')));
  assert.match(currentFontToken, /system-ui/);
  assert.match(css, /body, button, input, textarea, select \{ font-family: var\(--font-ui\)/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
});

test('css: motion tokens + keyframes jo UI me sach me lagi hain', () => {
  for (const token of ['--ease-soft', '--ease-spring', '--dur-1', '--dur-2', '--dur-3']) {
    assert.match(css, new RegExp(`${token}:`), `${token} defined`);
  }
  for (const key of ['card-in', 'pop-in', 'toast-drop', 'sheet-rise', 'backdrop-in', 'pulse-ring', 'icon-bump', 'brand-breathe']) {
    assert.match(css, new RegExp(`@keyframes ${key}\\b`), `${key} keyframes`);
  }
  assert.match(css, /\.card \{ animation: card-in/);
  assert.match(css, /\.bottom-nav button\.selected \.icon \{ animation: icon-bump/);
  assert.match(css, /\.sheet \{ animation: sheet-rise/);
});

test('css: money/numbers tabular — bill me digits hilte nahi', () => {
  assert.match(css, /font-variant-numeric: tabular-nums/);
  assert.match(css, /\.bill-row strong, \.line-total, \.money/);
});

test('css: reduced-motion par sab shaant (accessibility)', () => {
  const idx = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(idx > 0, 'reduced-motion block hai');
  const block = css.slice(idx);
  assert.match(block, /animation: none !important/);
  assert.match(block, /#toast/);
});

test('css: buttons/sheets/skeleton ka press + shimmer', () => {
  assert.match(css, /\.button:active:not\(:disabled\)[^{]*\{ transform: scale\(\.96/);
  assert.match(css, /\.skeleton-pill/);
  assert.match(css, /\.finding-coupon/);
  assert.match(css, /#toast\[hidden\] \{ display: none; \}/);
});

// ── 2. Toast: rang sach ke hisaab se ─────────────────────────────────────
const baseState = {
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' },
  selectedAddress: { id: 'a1', name: 'T', mobile: '7978459775', address: 'Kajala' },
  selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true, cart: null,
  wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [], history: [] }
};

function boot(state = baseState) {
  const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''), {
    runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true
  });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.fetch = async () => ({ ok: true, status: 200, json: async () => window.__STATE__ || state });
  window.__STATE__ = state;
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

test('toast: kaam hua to hara tick, fail hua to laal "!" — jhooth nahi', async () => {
  const cart = {
    restaurantId: '201', restaurantName: 'Biryani', restaurantArea: 'Aliganj',
    items: [{ lineKey: 'l', name: 'Biryani', price: 68, qty: 1 }],
    quote: { total: 68, itemTotal: 68, fetchedAt: new Date().toISOString() }
  };
  const dom = boot({ ...baseState, cart });
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    // Coupon apply ke bina "cart clear" jaise action se toast — pehle bad case.
    const okToast = await waitFor(() => {
      window.__appToast('Bill taiyar — hisaab neeche hai.', 'ok');
      const el = window.document.querySelector('#toast');
      return el && !el.hidden && el.classList.contains('toast-ok') ? el : null;
    }, 'ok toast');
    assert.match(okToast.textContent, /Bill taiyar/);
    assert.equal(okToast.querySelector('.toast-icon').textContent.trim(), '\u2713');
    const infoToast = await waitFor(() => {
      window.__appToast('Payment check ho rahi hai.');
      const el = window.document.querySelector('#toast');
      return el && !el.hidden && el.classList.contains('toast-info') ? el : null;
    }, 'info toast');
    assert.equal(infoToast.querySelector('.toast-icon').textContent.trim(), 'i');
    const badToast = await waitFor(() => {
      window.__appToast('Swiggy ne bill nahi diya.', 'bad');
      const el = window.document.querySelector('#toast');
      return el && el.classList.contains('toast-bad') ? el : null;
    }, 'bad toast');
    assert.equal(badToast.querySelector('.toast-icon').textContent.trim(), '!');
  } finally { window.close(); }
});

test('cart: pending bill has no fake bill or coupon shimmer card', async () => {
  const cart = {
    restaurantId: '201', restaurantName: 'Biryani', restaurantArea: 'Aliganj',
    items: [{ lineKey: 'l', name: 'Biryani', price: 68, qty: 1 }], quote: null
  };
  const dom = boot({ ...baseState, cart });
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => window.document.querySelector('.pay-bar'), 'cart');
    assert.equal(window.document.querySelector('.finding-coupon-card'), null);
    assert.equal(window.document.querySelector('.bill-card'), null, 'no provider bill was returned');
  } finally { window.close(); }
});

test('coupon page: "AVAILABLE COUPONS <count>" header (screenshot jaisa)', async () => {
  const cart = {
    restaurantId: '201', restaurantName: 'Biryani', restaurantArea: 'Aliganj',
    items: [{ lineKey: 'l', name: 'Biryani', price: 342, qty: 2 }],
    quote: { total: 402, itemTotal: 342, fetchedAt: new Date().toISOString() }
  };
  const dom = boot({
    ...baseState, cart,
    coupons: [
      { code: 'FLAT150', title: '₹150 OFF', description: 'Save ₹150 on this order!' },
      { code: 'TRYNEW', title: '70% OFF', description: 'Save ₹140 on this order!' }
    ],
    couponsLoading: false
  });
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    const btn = await waitFor(() => window.document.querySelector('[data-action="coupon-open"]'), 'coupon open');
    btn.click();
    await waitFor(() => window.document.querySelectorAll('.coupon-tile').length >= 2, 'coupon tiles');
    const header = await waitFor(() => window.document.querySelector('.coupon-count'), 'coupon count');
    assert.match(header.textContent, /AVAILABLE COUPONS/);
    assert.match(header.textContent, /2/, `header: ${header.textContent}`);
    assert.ok(window.document.querySelectorAll('.coupon-tile').length >= 2, 'coupon tiles bhi hain');
  } finally { window.close(); }
});

test('app: toast ka koi bhi purana text-based call toota nahi (backward compatible)', () => {
  // Purane call sites sirf message dete hain — unhe type ki zaroorat nahi.
  assert.match(appSource, /const toast = \(message, type = ''\) =>/);
  assert.match(appSource, /el\.className = `toast-\$\{kind\}`/);
  assert.match(appSource, /const kind = type === 'ok' \|\| type === 'bad' \? type : 'info'/);
  assert.ok((appSource.match(/toast\(/g) || []).length > 20, 'purane call sites hain');
});
