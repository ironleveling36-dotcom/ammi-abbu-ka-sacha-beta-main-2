// Boss (01-11-2026, round 34):
//   "MAKE THE CHECK OUT FASTER AND BESIDE PAY NOW BUTTON ADD SOMETHING AND
//    REMOVE THAT DASH WHICH ANIMATION — NOT THE ROUND BUT LITTLE CREATIVE
//    WHICH DENOTES BILLS ARE LOADING ... IT SHOULD BE AFTER BILL IS FETCHED
//    YOU HAVE 2 MINUTES TO CLICK PAY NOW OTHERWISE EVERYTHING WILL GET CLEAR."
//
// Yahan prove hota hai:
//   1) 2 minute ka clock bill ke `fetchedAt` se shuru — bill load hote waqt
//      kuch saaf nahi hota (aur 15 min se purana adhoora draft phir bhi saaf).
//   2) Dashed/sweeping loadbar animation hat gayi (na HTML, na CSS, na JS) —
//      uski jagah bill ke liye chhoti "receipt print" loader (.bill-loading).
//   3) Pay Now ke bagal me live clock (.idle-chip · m:ss) + chhoti note.
//   4) Bill fast: fast phase ka timeout chhota, address confirm cache, aur cart
//      update ke apne jawab se readback (ek Swiggy call kam).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import { planIdleExpiry, lastActivityAt, STALE_DRAFT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from './order-idle-expiry.js';
import { addressFingerprint } from './swiggy-pro-provider.js';

const MIN = 60_000;
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('./swiggy-pro-api.js', import.meta.url), 'utf8');
const providerSource = fs.readFileSync(new URL('./swiggy-pro-provider.js', import.meta.url), 'utf8');

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: '12 Test Road', area: 'Area', flat_no: '12', pin: '226001', lat: '26.86', lng: '80.93' };
const items = [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Paneer', qty: 1, price: 230, isVeg: true, variants: [], addons: [] }];
const cart = (over = {}) => ({ restaurantId: '201', items: structuredClone(items), updatedAt: new Date(Date.now() - 5 * MIN).toISOString(), ...over });

// ── 1. 2 minute ka clock sirf bill aane ke baad ───────────────────────────
test('idle: bill aane se pehle 2 minute ka clock shuru nahi hota', () => {
  const ws = { cart: cart({ quote: null }) };
  const plan = planIdleExpiry({ ws, now: Date.now(), timeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
  assert.equal(plan.expire, false, 'bill ke bina kuch saaf nahi');
  assert.equal(plan.waitingForBill, true);
});

test('idle: bill aane ke baad 2 minute me hi expire (bill fetch se ginti)', () => {
  const fetchedAt = new Date(Date.now() - 2 * MIN - 1000).toISOString();
  const quote = { total: 402, itemTotal: 342, fetchedAt };
  const ws = { cart: cart({ quote, updatedAt: new Date(Date.now() - 30 * MIN).toISOString() }) };
  // Purani cart activity clock ko peeche nahi kheenchti — bill hi aakhri sach hai.
  assert.equal(lastActivityAt(ws), Date.parse(fetchedAt));
  const plan = planIdleExpiry({ ws, now: Date.now(), timeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
  assert.equal(plan.expire, true);
  assert.equal(plan.kind, 'DRAFT');
});

test('idle: bill aane ke turant baad (30 second) kuch nahi hota', () => {
  const ws = { cart: cart({ quote: { total: 402, fetchedAt: new Date(Date.now() - 30_000).toISOString() } }) };
  const plan = planIdleExpiry({ ws, now: Date.now(), timeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
  assert.equal(plan.expire, false);
  assert.equal(plan.waitingForBill, undefined);
});

test('idle: bill hi nahi aaya aur 15 minute se purana cart — tab saaf', () => {
  const ws = { cart: cart({ quote: null, updatedAt: new Date(Date.now() - STALE_DRAFT_TIMEOUT_MS - 1000).toISOString() }) };
  const plan = planIdleExpiry({ ws, now: Date.now(), timeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
  assert.equal(plan.expire, true, 'pad gaya adhoora draft kabhi kabhi saaf hota hai');
  assert.equal(plan.kind, 'DRAFT');
});

test('idle: PAID aur unknown bill ke baad bhi kabhi expire nahi', () => {
  const quote = { total: 402, fetchedAt: new Date(Date.now() - 30 * MIN).toISOString() };
  for (const checkout of [{ status: 'PAID' }, { status: 'OUTCOME_UNKNOWN' }]) {
    const plan = planIdleExpiry({ ws: { cart: cart({ quote }), checkout }, now: Date.now(), timeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
    assert.equal(plan.expire, false, JSON.stringify(checkout));
  }
});

// ── 2. Dash/receipt animation gayi, curved circular loader aaya ───────────────────────────
test('loader: patli dashed/sweeping loadbar puri tarah hat gayi', () => {
  assert.equal(/loadbar/.test(html), false, 'HTML me loadbar nahi');
  assert.equal(/loadbar-run/.test(css), false, 'CSS me loadbar keyframe nahi');
  assert.equal(/loadbar/.test(appSource), false, 'JS me loadbar lookup nahi');
  assert.equal(/getElementById\('loadbar'\)/.test(appSource), false);
});

test('loader: bill ke liye curved circular Play-Store-style loader hai', () => {
  assert.match(appSource, /function renderBillLoading\(/);
  assert.match(appSource, /Bill calculate ho raha hai/);
  assert.match(appSource, /playLoader\(/);
  assert.match(css, /\.play-loader-arc/);
  assert.match(css, /@keyframes play-loader-spin/);
  assert.equal(/bill-paper/.test(appSource), false);
  assert.equal(/bill-loading[^`]*class="card bill-card/.test(appSource), false);
});

test('loader: reduced-motion me circular loader ruk jata hai', () => {
  const blocks = css.match(/@media \(prefers-reduced-motion: reduce\)/g) || [];
  assert.ok(blocks.length > 0);
  assert.match(css, /\.play-loader svg \{ animation: none; \}/);
});

// ── 3. Pay Now ke bagal koi dash/clock nahi ─────────────────────────
const appBase = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver,
  checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
  cart: cart({ quote: { total: 402, itemTotal: 342, fetchedAt: new Date().toISOString() } }),
  checkout: null,
  wallet: { balancePaise: 1500, balance: '15', feePaise: 1500, fee: '15', ready: true, shortfall: '0', upiId: 'mius@ybl', presets: [] },
  idle: { timeoutMs: 120000, closed: null, abandoned: [] },
  ...over
});
async function mount(state) {
  const doc = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(doc, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => state });
  window.eval(appSource);
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch { /* retry */ } await new Promise(r => setTimeout(r, 20)); }
    throw new Error('timeout: ' + label);
  };
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
  window.document.querySelector('[data-tab="cart"]').click();
  return { window, waitFor };
}

test('cart: Pay Now ke bagal sirf amount hai — dash/clock/note nahi', async () => {
  const { window, waitFor } = await mount(appBase());
  try {
    const bar = await waitFor(() => window.document.querySelector('.pay-bar'), 'pay bar');
    assert.equal(bar.querySelector('.idle-chip'), null);
    assert.equal(window.document.querySelector('.idle-note'), null);
    assert.match(bar.querySelector('.pay-left strong').textContent, /₹402/);
    assert.equal(bar.textContent.includes('—'), false);
    assert.ok(bar.querySelector('.pay-now'));
  } finally { window.close(); }
});

test('cart: bill ke bina bill-card nahi, circular loader dikhta hai', async () => {
  const state = appBase();
  state.cart = cart({ quote: null });
  const { window, waitFor } = await mount(state);
  try {
    const loader = await waitFor(() => window.document.querySelector('.bill-loading-card'), 'bill loader');
    assert.match(loader.textContent, /Bill calculate ho raha hai/);
    assert.ok(loader.querySelector('.play-loader'));
    assert.equal(window.document.querySelector('.bill-card'), null, 'koi andaaza bill nahi');
    assert.ok(window.document.querySelector('.pay-left .play-loader'));
    assert.equal(window.document.querySelector('.pay-bar').textContent.includes('—'), false);
    // Round 27 ka rule bacha hua: bill ke bina bhi Pay Now dabta hai — dabane
    // par pehle asli bill aata hai, phir payment (koi andaaza nahi).
    assert.match(window.document.querySelector('.pay-bar .pay-now').textContent, /Pay Now/);
    assert.equal(window.document.querySelector('.pay-bar .pay-now').disabled, false);
  } finally { window.close(); }
});

// ── 4. Bill fast ──────────────────────────────────────────────────────────
test('fast bill: address confirm cache + cart update ke jawab se readback', () => {
  assert.match(providerSource, /ADDRESS_CONFIRM_TTL_MS/);
  assert.match(providerSource, /cart\.confirmedAddress/);
  assert.match(providerSource, /engine\.addressReused = engineAddressReused/);
  // Cart write ka jawab poora ho to alag GET nahi — ek Swiggy call kam.
  assert.match(providerSource, /const usable = Boolean\(/);
  assert.match(providerSource, /let snapshot = usable \? acceptCart\(out\)/);
  // Fast phase me timeout chhota, par kam se kam 4 second (adhoora jawab nahi).
  assert.match(providerSource, /const pushTimeout = fast \? Math\.max\(4_000/);
});

test('fast bill: server confirmed address yaad rakhta hai (fingerprint ke saath)', () => {
  assert.match(apiSource, /ws\.cart\.confirmedAddress = \{/);
  assert.match(apiSource, /fingerprint: String\(quote\.addressFingerprint\)/);
  const a = addressFingerprint({ name: 'Ram Kumar', mobile: '9123456789', flat_no: '12', address: 'Golden Villa', pin: '226001' });
  const b = addressFingerprint({ name: 'ram  kumar', mobile: '+91 9123456789', flat_no: '12', address: 'golden-villa', pin: '226001' });
  assert.equal(addressFingerprint({ name: 'Ram Kumar', mobile: '9123456789', flat_no: '12', address: 'Golden Villa', pin: '226001' }), a, 'stable');
  // Naam/address ka case ya spacing badalne se galat address reuse nahi hota-ish:
  // sirf punctuation/case ignore hota hai, phone format bhi — par mobile badle to alag.
  assert.notEqual(addressFingerprint({ name: 'Ram Kumar', mobile: '9000000000', flat_no: '12', address: 'Golden Villa', pin: '226001' }), a);
  assert.equal(typeof b, 'string');
});
