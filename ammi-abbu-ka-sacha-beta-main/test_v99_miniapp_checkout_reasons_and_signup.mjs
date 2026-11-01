// Boss (31-10-2026, round 10): "PAY PAR CLICK KARTA HU TO — COULD NOT BE
// CONFIRMED" aur "NAYA ACCOUNT HAI TO LOGIN HI NAHI HOTA".
// Yahan test hota hai: har checkout failure ki ASLI wajah + naya bill refresh
// (order nahi), aur naye number par signup + OTP-verified identity.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v99-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v99-offline-token', PRO_VAULT_KEY: 'v99-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
delete process.env.PRO_ENABLE_CHECKOUT;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');
const db = getDb();
db.config.accounts = {};
db.config.bossIds = ['9000'];
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
// Fake Swiggy API — sirf wahi jawab jo app decode karta hai.
const liveCartState = { orderTotal: 33.85, couponCode: 'FLASHSALE', items: [{ menu_item_id: 9001, name: 'Paneer Kolhapuri', quantity: 1, subtotal: 23000, item_total: 23000, is_veg: 1 }] };
function liveCartPayload() {
  return {
    statusCode: 0,
    data: {
      cartId: 'cart-777', originalCartId: 'cart-777',
      cartMeta: {
        cartId: 'cart-777', originalCartId: 'cart-777', order_total: liveCartState.orderTotal,
        item_total: 230, total_packing_charges: 5, taxesAndCharges: 27.85, coupon_discount_total: 160,
        coupon_code: liveCartState.couponCode, is_coupon_valid: 1, address_id: 'addr-1',
        trade_discount_total: 0, delivery_charges: 0, positiveDeliveryChargesExclusive: 0
      },
      cart_menu_items: liveCartState.items,
      cart_address: { id: 'addr-1' },
      restaurant_id: '201', restaurant_name: 'Paneer Palace'
    }
  };
}

let placementCalls = 0;
const provider = {
  async verifySession(session) {
    if (session?.__noProfile) return { valid: false };
    return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' };
  },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search() { return []; },
  async coupons(_a, _addr, restaurantId) { return { restaurantId, coupons: [], discovery: false, note: 'APPLY dabaiye.' }; },
  async quoteCart(_a, address) {
    return { address, bill: { itemTotal: 230, deliveryFee: 0, deliverySaved: 49, packingCharges: 5, taxes: 32.85, discount: 160, coupon: 'FLASHSALE', total: 29 }, ofoConfirmed: false };
  },
  async orders() { return []; },
  async tracking() { return {}; },
  async checkout() { placementCalls += 1; throw new Error('placement should not be reached in this test'); }
};
const otpCalls = [];
const otp = {
  async request(_uid, phone, _acc, _name, options = {}) {
    otpCalls.push({ phone, allowSignup: options.allowSignup });
    if (phone === '9000000001' && options.allowSignup !== true) {
      return { success: false, code: 'SWIGGY_ACCOUNT_NOT_REGISTERED', message: 'This number is not registered on Swiggy. Create your account on Swiggy first.' };
    }
    return { success: true };
  },
  async verify() {
    const tid = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ user_id: '555111', exp: 1900000000 })).toString('base64url'), 'sig'].join('.');
    return { success: true, phone: '9000000001', exportJson: { mobile: '9000000001', tid, token: 'new-token' }, name: 'New User' };
  }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, otp, claim: async () => ({}), deleteOtp: { request: async () => ({}), verify: async () => ({}) }, authorizeUser: async () => ({ allowed: true }) })) {
    res.writeHead(404); res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: `User ${userId}` }), query_id: 'q' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
async function req(userId, route, payload) {
  const response = await fetch(base + '/pro/api/' + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': sign(userId), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}
function seed(userId, extra = {}) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false,
      items: [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Paneer Kolhapuri', qty: 1, price: 230, isVeg: true, variants: [], addons: [] }],
      quote: { ...{ itemTotal: 230, deliveryFee: 0, packingCharges: 5, taxes: 27.85, discount: 160, coupon: 'FLASHSALE', couponCode: 'FLASHSALE', total: 29, taxesAndCharges: 32.85, totalSavings: 279 }, fetchedAt: new Date().toISOString() }
    }, ...extra
  });
}
function confirm(ws) {
  const q = ws.cart.quote;
  return { confirmCheckout: true, expectedTotal: q.total, quoteFetchedAt: q.fetchedAt };
}

// ── Real provider guard (mock Swiggy shapes, jaise test_v89 karta hai) ────
const { proProvider } = await import('./swiggy-pro-provider.js');
const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const providerAccount = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const providerCart = {
  restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: true,
  items: [{ menu_item_id: 9001, qty: 1, variants: [], addons: [] }],
  quote: { total: 29, coupon: 'FLASHSALE', couponCode: 'FLASHSALE' }
};
let placeCalls = 0;
let cartMeta = null;
function resetProviderMeta() {
  placeCalls = 0;
  cartMeta = {
    order_total: 29, cartId: 'cart-777', originalCartId: 'cart-777', address_id: 'addr-1',
    item_total: 230, total_packing_charges: 5, taxesAndCharges: 27.85, coupon_discount_total: 160,
    coupon_code: 'FLASHSALE', is_coupon_valid: 1, is_order_for_someone_else: true,
    restaurant_details: { id: '201', name: 'Paneer Palace' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Paneer Kolhapuri', subtotal: 23000, addons: [], variants: [] }]
  };
}
const realFetch99 = globalThis.fetch;
globalThis.fetch = async (raw, options) => {
  const u = String(raw);
  // Hamare apne test server ki calls asli fetch se — warna mock unhe bhi kha
  // jaata hai (aur signup/verify tests jhoothe pass/fail dete hain).
  if (u.includes('127.0.0.1')) return realFetch99(raw, options);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/api/v2/order/place')) { placeCalls += 1; return json({ statusCode: 0, data: { order_id: '123456789012' } }); }
  if (u.includes('/api/v2/cart/client')) return json({ statusCode: 0, tid: jwt, data: { cartMeta: { ...cartMeta, addresses: [receiver] } } });
  if (u.includes('/api/v1/user/profile')) return json({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [receiver] } });
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwt, data: { orders: [] } });
  return json({ statusCode: 0 });
};
after(() => { globalThis.fetch = realFetch99; });

test('pay: amount badla ho to order nahi jaata — asli dono amount + naya bill', async () => {
  resetProviderMeta();
  cartMeta.order_total = 33.85;            // Swiggy ab ₹33.85 keh raha hai
  await assert.rejects(
    () => proProvider.checkout({ ...providerAccount }, { ...receiver }, structuredClone(providerCart), 'v99:amount'),
    err => {
      assert.equal(err.code, 'BILL_CHANGED');
      assert.match(err.message, /₹29/);
      assert.match(err.message, /₹33\.85/);
      assert.equal(err.diag.placementAttempted, false);
      assert.equal(err.diag.freshBill.total, 33.85);
      assert.equal(err.diag.freshBill.coupon, 'FLASHSALE');
      return true;
    }
  );
  assert.equal(placeCalls, 0, 'koi order place nahi hua');
});

test('pay: coupon gira de to message me dono coupon — order nahi', async () => {
  resetProviderMeta();
  cartMeta.coupon_code = '';
  cartMeta.is_coupon_valid = 0;
  cartMeta.coupon_discount_total = 0;
  await assert.rejects(
    () => proProvider.checkout({ ...providerAccount }, { ...receiver }, structuredClone(providerCart), 'v99:coupon'),
    err => {
      assert.equal(err.code, 'BILL_CHANGED');
      assert.match(err.message, /Coupon badal gaya/i);
      assert.match(err.message, /FLASHSALE/);
      return true;
    }
  );
  assert.equal(placeCalls, 0);
});

test('pay: items badal gaye to hard stop — saaf wajah, koi order nahi', async () => {
  resetProviderMeta();
  cartMeta.cart_menu_items = [{ menu_item_id: 9001, quantity: 2, name: 'Paneer Kolhapuri', subtotal: 46000, addons: [], variants: [] }];
  await assert.rejects(
    () => proProvider.checkout({ ...providerAccount }, { ...receiver }, structuredClone(providerCart), 'v99:items'),
    err => {
      assert.equal(err.code, 'CART_ITEMS');
      assert.match(err.message, /items badal gaye/i);
      assert.equal(err.diag.freshBill, undefined, 'items badle to naya bill nahi banate');
      return true;
    }
  );
  assert.equal(placeCalls, 0);
});

test('API: BILL_CHANGED par naya bill save hota hai aur 409 ke saath asli wajah aati hai', async () => {
  const { writeProWorkspace } = await import('./swiggy-pro-store.js');
  // Round 11: order place karne se pehle wallet me ₹15 fee ka balance chahiye.
  const { creditWallet } = await import('./user-wallet.js');
  const walletDb = getDb();
  creditWallet(walletDb, '9931', 1500, { reason: 'test top-up', actor: 'test' });
  saveDb(walletDb);
  writeProWorkspace('9931', {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false,
      items: [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Paneer Kolhapuri', qty: 1, price: 230, isVeg: true, variants: [], addons: [] }],
      quote: { itemTotal: 230, deliveryFee: 0, packingCharges: 5, taxes: 27.85, discount: 160, coupon: 'FLASHSALE', couponCode: 'FLASHSALE', total: 29, taxesAndCharges: 32.85, totalSavings: 279, fetchedAt: new Date().toISOString() }
    }
  });
  const server3 = http.createServer(async (req3, res3) => {
    const changing = { ...provider, async checkout() {
      const e = new Error('1. Bill ka amount badal gaya — aapne ₹29 dekh kar Pay dabaya, Swiggy ab ₹33.85 keh raha hai. Order place nahi hua.');
      e.code = 'BILL_CHANGED';
      e.diag = { code: 'AMOUNT', placementAttempted: false, freshBill: { itemTotal: 230, deliveryFee: 0, deliverySaved: 49, packingCharges: 5, taxes: 32.85, discount: 160, coupon: 'FLASHSALE', freeCash: 70, totalSavings: 279, total: 33.85 } };
      throw e;
    } };
    if (!await handleSwiggyProHttp(req3, res3, { provider: changing, otp, claim: async () => ({}), deleteOtp: { request: async () => ({}), verify: async () => ({}) }, authorizeUser: async () => ({ allowed: true }) })) { res3.writeHead(404); res3.end(); }
  });
  await new Promise(resolve => server3.listen(0, '127.0.0.1', resolve));
  const altBase = `http://127.0.0.1:${server3.address().port}`;
  try {
    const ws = readProWorkspace('9931');
    const res = await fetch(altBase + '/pro/api/checkout', {
      method: 'POST', headers: { 'X-Telegram-Init-Data': sign(9931), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmCheckout: true, expectedTotal: ws.cart.quote.total, quoteFetchedAt: ws.cart.quote.fetchedAt })
    });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.code, 'BILL_CHANGED');
    assert.match(body.error, /₹33\.85|33\.85/);
    const saved = readProWorkspace('9931');
    assert.equal(saved.cart.quote.total, 33.85, 'naya bill save');
    assert.equal(saved.checkout ?? null, null, 'checkout barrier nahi bana');
  } finally { await new Promise(resolve => server3.close(resolve)); }
});

test('login: naya number — pehle saaf message, signup consent ke baad OTP chalta hai', async () => {
  otpCalls.length = 0;
  const first = await req(9921, 'accounts/send-otp', { phone: '9000000001' });
  assert.equal(first.status, 409);
  assert.equal(first.body.code, 'SWIGGY_ACCOUNT_NOT_REGISTERED');
  assert.equal(first.body.error.includes('naya'), true);
  assert.equal(otpCalls[0].allowSignup, false, 'bina consent signup nahi');
  const second = await req(9921, 'accounts/send-otp', { phone: '9000000001', signup: true });
  assert.equal(second.status, 200);
  assert.equal(otpCalls[1].allowSignup, true, 'consent ke baad signup allowed');
  assert.equal(readProWorkspace('9921').otpPhone, '9000000001');
});

test('login: naye account par profile khaali ho to OTP session ki asli identity se account save hota hai', async () => {
  const userId = 9922;
  // verifySession fail (brand-new account, profile nahi mila) — token me user_id hai.
  const server2 = http.createServer(async (req2, res2) => {
    const failing = { ...provider, async verifySession() { return { valid: false }; } };
    if (!await handleSwiggyProHttp(req2, res2, { provider: failing, otp, claim: async () => ({}), deleteOtp: { request: async () => ({}), verify: async () => ({}) }, authorizeUser: async () => ({ allowed: true }) })) {
      res2.writeHead(404); res2.end();
    }
  });
  await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));
  const altBase = `http://127.0.0.1:${server2.address().port}`;
  try {
    const call = async (route, payload) => {
      const response = await fetch(altBase + '/pro/api/' + route, {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': sign(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await call('accounts/send-otp', { phone: '9000000001', signup: true })).status, 200);
    const out = await call('accounts/verify-otp', { otp: '123456' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const ws = readProWorkspace(String(userId));
    const saved = Object.values(ws.accounts)[0] || {};
    assert.equal(saved.customerId, '555111', 'token ki asli identity save hui');
    assert.equal(ws.activeAccountKey, Object.keys(ws.accounts)[0], 'account active hai');
    assert.equal(saved.isLoggedIn, true);
  } finally { await new Promise(resolve => server2.close(resolve)); }
});

// ── Client: BILL_CHANGED par naya bill dikhta hai, OUTCOME_UNKNOWN nahi ──
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function waitFor(fn, label) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('timeout: ' + label);
}
const accountRow = { key: 'mine', name: 'Mine', phone: '9123456789', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, needsConfirm: false, active: true, offerTracks: [] };
function clientState(total = 29) {
  return {
    ok: true, user: { name: 'Test', isBoss: false }, accounts: [accountRow], activeAccount: accountRow, selectedAddress: receiver,
    cart: { restaurantId: '201', restaurantName: 'Paneer Palace', restaurantArea: 'Kothrud', restaurantTime: '25 min', forSomeoneElse: false,
      quote: { itemTotal: 230, deliveryFee: 0, packingCharges: 5, taxes: 27.85, taxesAndCharges: 32.85, discount: 160, coupon: 'FLASHSALE', freeCash: 70, totalSavings: 279, total, fetchedAt: '2026-10-31T00:00:00Z' },
      items: [{ lineKey: 'l', id: '9001', name: 'Paneer Kolhapuri', price: 230, qty: 1, isVeg: true }] },
    checkout: null, checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true
  };
}
function harness({ responder }) {
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.scrollTo = () => {};
  window.Telegram = { WebApp: { initData: 'signed', ready() {}, expand() {} } };
  window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return response(responder(call));
  };
  window.eval(appSource);
  return { window, document: window.document, calls, close: () => window.close() };
}
const menuStub = { ok: true, restaurant: { id: '201', name: 'Paneer Palace', area: 'Kothrud', isOpen: true }, categories: [{ title: 'Main', items: [] }] };

test('DOM: Pay par bill badal jaye to naya total dikhta hai aur OUTCOME_UNKNOWN nahi banta', async () => {
  let attempt = 0;
  const app = harness({ responder: call => {
    if (call.url.includes('/menu?id=')) return menuStub;
    if (call.url.endsWith('/checkout')) {
      attempt += 1;
      return { ok: false, code: 'BILL_CHANGED', error: '1. Bill ka amount badal gaya — aapne ₹29 dekh kar Pay dabaya, Swiggy ab ₹33.85 keh raha hai. Order place nahi hua — naya bill dekh kar dobara Pay dabaiye.' };
    }
    if (call.url.endsWith('/bootstrap')) return clientState(attempt ? 33.85 : 29);
    return clientState(29);
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.pay-bar .pay-now'), 'pay bar');
    app.document.querySelector('.pay-bar .pay-now').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'consent');
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/checkout')), 'checkout call');
    await waitFor(() => app.document.body.textContent.includes('₹33.85'), 'naya bill');
    assert.equal(app.document.body.textContent.includes('The response was lost'), false, 'OUTCOME_UNKNOWN nahi');
    assert.ok(app.document.body.textContent.includes('Order place nahi hua'), 'asli wajah toast me');
    assert.match(app.document.querySelector('.pay-bar').textContent, /₹33\.85/);
    await new Promise(r => setTimeout(r, 30));
  } finally { app.close(); }
});
