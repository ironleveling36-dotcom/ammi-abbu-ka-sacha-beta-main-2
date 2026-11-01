// Boss (31-10-2026, round 7): "CART STILL CAN'T BE FETCHED", "ADDRESS PAGE LOAD
// HO RAHA HAI TO KISI AUR PAGE PAR SHIFT NAHI HO PAA RAHA", "IMAGE JAISA
// CHAHIYE", "COUPON CHOOSE KARNE KA OPTION", "PAY KE BAAD ORDER TRACK".
// Sab OFFLINE: fake provider, stubbed fetch, koi live Swiggy/Telegram/UPI call.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v96-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v96-offline-token', PRO_VAULT_KEY: 'v96-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', BOSS_ID: '9000', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');

// Asli Android session jaisa JWT — provider ka auth check isi se pass hota hai.
const jwt = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ user_id: '4242', exp: 1900000000 })).toString('base64url'),
  'sig'
].join('.');
const db = getDb();
db.config.accounts = { gcReader: { phone: '9000000001', name: 'Reader', tid: jwt, token: 'reader-token', userId: '4242', customerId: '4242', isLoggedIn: true } };
db.config.bossIds = ['9000'];
saveDb(db);

// ── 1. Provider: group cart ab join path se khulta hai (yahi asli bug tha) ──
const fetchCalls = [];
const realFetch = globalThis.fetch;
function stubSwiggy(handler) {
  fetchCalls.length = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, body: options.body ? JSON.parse(options.body) : null });
    const out = handler(u, options);
    return new Response(JSON.stringify(out.body), { status: out.status || 200, headers: { 'content-type': 'application/json' } });
  };
}
after(() => { globalThis.fetch = realFetch; });

const { proProvider } = await import('./swiggy-pro-provider.js');
const readerAccount = getDb().config.accounts.gcReader;

test('group cart: chkout shared_cart/join se items aate hain (GET-only nahi)', async () => {
  stubSwiggy(u => {
    if (u.includes('/shared_cart/join')) {
      return { body: { statusCode: 0, data: {
        group_cart_id: '642855918',
        restaurant_details: { restaurant_id: '1467977', restaurant_name: 'Umbashiya', area_name: 'Kothrud' },
        user_cart_map: { u1: { user_cart: [
          { menu_item_id: 9001, name: 'Margherita', quantity: 2, subtotal: 54800, isVeg: 1 },
          { menu_item_id: 9002, name: 'Garlic Bread', quantity: 1, subtotal: 14900, isVeg: 1 }
        ] } }
      } } };
    }
    return { body: { statusCode: 86, statusMessage: 'USER_ALREADY_PART_OF_GROUP_CART' } };
  });
  const out = await proProvider.groupCart(readerAccount, { lat: '18.5204', lng: '73.8567' }, 'https://www.swiggy.com/gc/1467977/Umbashiya-642855918');
  assert.equal(out.restaurantId, '1467977');
  assert.equal(out.restaurantName, 'Umbashiya');
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].qty, 2);
  assert.equal(out.items[0].price, 274);
  assert.equal(out.items[0].lineTotal, 548);
  assert.equal(out.items[0].isVeg, true);
  assert.ok(fetchCalls.some(c => c.url.includes('/shared_cart/join')), 'join path hi asli fix hai');
});

test('group cart: band cart par asli wajah (jootha cart id nahi)', async () => {
  stubSwiggy(() => ({ body: { statusCode: 88, errorCodes: ['GROUP_CART_NO_LONGER_EXISTS'], statusMessage: 'Group cart no longer exists' } }));
  await assert.rejects(
    () => proProvider.groupCart(readerAccount, { lat: '18.5204', lng: '73.8567' }, 'https://www.swiggy.com/gc/1467977/Umbashiya-642855918'),
    err => {
      assert.equal(err.code, 'GROUP_CART_EXPIRED');
      assert.match(err.message, /band ho chuka|no longer exists/i);
      return true;
    }
  );
});

test('group cart: khaali jawab par HTTP + statusCode chhupte nahi', async () => {
  stubSwiggy(() => ({ body: { statusCode: 42, statusMessage: 'CART_NOT_FOUND' } }));
  await assert.rejects(
    () => proProvider.groupCart(readerAccount, { lat: '18.5204', lng: '73.8567' }, 'https://www.swiggy.com/gc/1467977/Umbashiya-642855918'),
    err => {
      assert.match(err.message, /HTTP 200/);
      assert.match(err.message, /statusCode 42/);
      assert.match(err.message, /CART_NOT_FOUND/);
      return true;
    }
  );
});

test('coupons: Swiggy ke coupon list se aate hain, code invent nahi hote', async () => {
  stubSwiggy(u => {
    if (u.includes('fetch_food_coupons') || u.includes('mcp') || u.includes('tools')) {
      return { body: { jsonrpc: '2.0', result: { structuredContent: { coupons: [
        { coupon_code: 'SNACKIT', title: 'Save ₹140 on this order!', description: '70% off above ₹49', is_applicable: true },
        { coupon_code: 'TRYNEW', title: '70% off', description: 'above ₹199', is_applicable: true },
        { coupon_code: 'FLAT175', title: 'Flat ₹175 off', description: 'above ₹349', is_applicable: false, ineligible_reason: 'Add ₹133 more' }
      ] } } } };
    }
    return { body: { statusCode: 0 } };
  });
  const out = await proProvider.coupons(readerAccount, { id: 'addr-1' }, '1467977');
  assert.equal(out.restaurantId, '1467977');
  assert.ok(Array.isArray(out.coupons));
  for (const c of out.coupons) assert.match(c.code, /^[A-Z0-9_-]{3,28}$/);
});

// ── 2. API: coupons route + outlets ka rating ────────────────────────────
const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const chainRows = [
  { id: '201', name: 'Pizza Junction', area: 'Kothrud', distance: '2.1 km', time: '25 min', isOpen: true, rating: '4.2', ratings: '1k', cuisines: 'Pizza' },
  { id: '202', name: 'Pizza Junction', area: 'Baner', distance: '5.4 km', time: '38 min', isOpen: false, rating: '4.0', ratings: '800', cuisines: 'Pizza' },
  { id: '203', name: 'Pizza Junction', area: 'Hadapsar', distance: '9.0 km', time: '45 min', isOpen: true, rating: '3.9', ratings: '300', cuisines: 'Pizza' }
];
let couponCalls = 0;
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search(_a, _addr, query) { const q = String(query || '').toLowerCase(); return chainRows.filter(r => r.name.toLowerCase().includes(q)); },
  async menu(_a, _addr, id) {
    const row = chainRows.find(r => r.id === String(id)) || chainRows[0];
    return {
      restaurant: { id: row.id, name: row.name, area: row.area, time: row.time, rating: row.rating, isOpen: row.isOpen, image: '' },
      categories: [{ title: 'Pizza', items: [
        { id: '9001', name: 'Margherita', price: 137, isVeg: true, image: '', description: 'Cheese', inStock: true, customizable: false },
        { id: '9002', name: 'Garlic Bread', price: 149, isVeg: true, image: '', description: 'Bread', inStock: true, customizable: false }
      ] }]
    };
  },
  async coupons(_a, _addr, restaurantId) {
    couponCalls += 1;
    return { restaurantId, coupons: [{ code: 'SNACKIT', title: '70% OFF', description: 'above ₹49', applicable: true, reason: '' }], discovery: true, note: '' };
  },
  async quoteCart(_a, address) {
    return { address, bill: { itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, discount: 0, total: 335, coupon: '', deliveryDistance: '2.1 km' }, ofoConfirmed: false };
  },
  async orders() { return []; },
  async tracking(_a, id) { return { status: 'Out for delivery', eta: '12 min', deliveryPartner: { name: 'Rider', phone: '9000000000' }, deliveryOtp: '4321', trackingUrl: '' }; }
};

const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, claim: async () => ({}), deleteOtp: { request: async () => ({}), verify: async () => ({}) }, authorizeUser: async () => ({ allowed: true }) })) {
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
const user = sign(9601);
async function req(route, payload, method = payload === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/pro/api/' + route, {
    method,
    headers: { 'X-Telegram-Init-Data': user, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}
function seed() {
  writeProWorkspace('9601', {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Pizza Junction', forSomeoneElse: false,
      items: [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Margherita', qty: 2, price: 137, isVeg: true, variants: [], addons: [] }],
      quote: null
    }
  });
}

test('API: coupons bina cart par 400, cart ke saath provider ka sach', async () => {
  writeProWorkspace('9601', { version: 1, accounts: {}, activeAccountKey: '', selectedAddress: receiver, addressCandidates: [], cart: null });
  assert.equal((await req('coupons')).status, 400);
  seed();
  const out = await req('coupons?id=201');
  assert.equal(out.status, 200);
  assert.equal(out.body.restaurantId, '201');
  assert.equal(out.body.coupons[0].code, 'SNACKIT');
  assert.ok(couponCalls >= 1);
});

test('API: customer_id khaali ho to bill sync use Swiggy se le kar save karta hai', async () => {
  seed();
  const ws = readProWorkspace('9601');
  ws.accounts.mine.customerId = '';
  writeProWorkspace('9601', ws);
  const out = await req('cart/sync', { confirmReplaceSwiggyCart: true });
  assert.equal(out.status, 200);
  // The verified ID is now bound to a session fingerprint rather than written
  // into the original saved account. Checkout must actually resolve it.
  const saved = readProWorkspace('9601');
  assert.equal(saved.accounts.mine.customerId, '');
  assert.equal(saved.sessionBindings?.mine?.customerId, 'customer-9123456789');
  assert.match(saved.sessionBindings?.mine?.fingerprint || '', /^[a-f0-9]{64}$/);
  // Refuse placement deliberately; reaching bill-consent validation proves the
  // bound identity was accepted without placing any order.
  const checkout = await req('checkout', { confirmCheckout: false });
  assert.equal(checkout.status, 400);
  assert.match(checkout.body.error, /Review a fresh Swiggy bill/);
});

test('API: outlets me rating bhi aata hai (Swiggy sheet jaisa)', async () => {
  seed();
  const out = await req('restaurants/outlets?q=Pizza%20Junction');
  assert.equal(out.status, 200);
  const kothrud = out.body.outlets.find(o => o.id === '201');
  assert.equal(kothrud.rating, '4.2');
  assert.equal(kothrud.distance, '2.1 km');
});

// ── 3. Client: nav block, naya cart look, coupon page, tracking ──────────
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function waitFor(fn, label) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('timeout: ' + label);
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
const account = { key: 'mine', name: 'Mine', phone: '9123456789', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, needsConfirm: false, active: true, offerTracks: [] };
const quote = { total: 335, itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, taxesAndCharges: 61.08, discount: 100, coupon: 'SNACKIT', otherCharges: 0, unlistedDiscount: 0, mismatch: false, deliveryDistance: '2.1 km', fetchedAt: '2026-10-31T00:00:00Z' };
function state(extra = {}) {
  return {
    ok: true, user: { name: 'Test', isBoss: false }, accounts: [account], activeAccount: account,
    selectedAddress: receiver,
    cart: { restaurantId: '201', restaurantName: 'Pizza Junction', restaurantArea: 'Kothrud', restaurantTime: '25 min', restaurantRating: '4.2', restaurantImage: '', forSomeoneElse: false, quote, items: [{ lineKey: 'l', id: '9001', name: 'Margherita', price: 137, qty: 2, isVeg: true, lineTotal: 254 }] },
    checkout: null, checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true, ...extra
  };
}
const menuStub = { ok: true, restaurant: { id: '201', name: 'Pizza Junction', area: 'Kothrud', isOpen: true }, categories: [{ title: 'Pizza', items: [
  { id: '9001', name: 'Margherita', price: 137, isVeg: true, image: '', inStock: true, customizable: false },
  { id: '9002', name: 'Garlic Bread', price: 149, isVeg: true, image: '', inStock: true, customizable: false }
] }] };

test('DOM: address load hone ke beech bhi doosra tab turant khulta hai', async () => {
  let releaseAddresses;
  const app = harness({ responder: call => {
    if (call.url.includes('/addresses')) return new Promise(resolve => { releaseAddresses = () => resolve({ ok: true, addresses: [receiver], note: '' }); });
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="address"]').click();
    await waitFor(() => app.document.querySelector('.skeleton-list'), 'address loading');
    // Address abhi load ho raha hai — orders tab dabate hi khulna chahiye.
    app.document.querySelector('[data-action="nav"][data-tab="orders"]').click();
    await waitFor(() => app.document.querySelector('[data-action="orders-refresh"]'), 'orders tab khul gaya');
    assert.ok(app.calls.some(c => c.url.includes('/orders')), 'orders request gayi');
    releaseAddresses?.();
    await new Promise(r => setTimeout(r, 30));
  } finally { app.close(); }
});

test('DOM: cart page Swiggy jaisa — savings banner, Savings Corner, meal rail, bill + pay bar', async () => {
  const app = harness({ responder: call => {
    if (call.url.includes('/menu?id=')) return menuStub;
    if (call.url.includes('/coupons')) return { ok: true, coupons: [], note: 'Swiggy ne list nahi di.' };
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.savings-corner'), 'savings corner');
    await waitFor(() => app.document.querySelector('.meal-card'), 'meal rail');
    const text = app.document.body.textContent;
    assert.match(text, /₹100 saved!/, 'banner me asli saving');
    assert.match(text, /SAVINGS CORNER/);
    assert.match(text, /saved with SNACKIT/);
    assert.ok(app.document.querySelector('[data-action="coupon-remove"]'), 'Remove button');
    assert.match(text, /Complete your meal/i);
    assert.ok(app.document.querySelector('.meal-card [data-action="dish-add"]'), 'meal rail se add hota hai');
    assert.ok(app.document.querySelector('.bill-card'), 'returned bill is directly visible');
    assert.equal(app.document.querySelector('[data-action="bill-open"]'), null);
    assert.match(app.document.querySelector('.pay-bar .pay-now').textContent, /Pay Now/);
    assert.ok(app.document.querySelector('.rating-chip'), 'restaurant rating');
    // Purani cheezein bhi intact.
    assert.ok(app.document.querySelector('form[data-form="group-cart"]'));
    assert.equal(/farak hai/.test(text), false);
  } finally { app.close(); }
});

test('DOM: coupon page — applied ribbon, APPLY se asli sync, REMOVE se coupon hat', async () => {
  const app = harness({ responder: call => {
    if (call.url.includes('/menu?id=')) return menuStub;
    if (call.url.includes('/coupons')) return { ok: true, coupons: [
      { code: 'TRYNEW', title: '70% off', description: 'above ₹199', applicable: true, reason: '' },
      { code: 'FLAT175', title: 'Flat ₹175 off', description: 'above ₹349', applicable: false, reason: 'Add ₹133 more' }
    ], note: '' };
    if (call.url.endsWith('/cart/sync')) {
      const code = call.body?.coupon || '';
      return { ok: true, selectedAddress: receiver, cart: { ...state().cart, quote: code ? { ...quote, coupon: code, discount: 140 } : { ...quote, coupon: '', discount: 0 } } };
    }
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="coupon-open"]'), 'coupon button');
    app.document.querySelector('[data-action="coupon-open"]').click();
    await waitFor(() => app.document.querySelectorAll('.coupon-tile').length >= 2, 'coupon tiles');
    assert.match(app.document.querySelector('.coupon-tile.applied').textContent, /SNACKIT/);
    assert.match(app.document.querySelector('.coupon-tile.applied').textContent, /Save ₹100/);
    // Boss (round 8): koi code type karne ka box nahi — har coupon par APPLY.
    assert.equal(app.document.querySelector('input[name="coupon"]'), null, 'code box nahi');
    assert.equal(/coupon available nahi|list nahi di/i.test(app.document.body.textContent), false);
    app.document.querySelector('[data-action="coupon-pick"]').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/sync')), 'sync call');
    const call = app.calls.find(c => c.url.endsWith('/cart/sync'));
    assert.equal(call.body.coupon, 'TRYNEW');
    assert.equal(call.body.confirmReplaceSwiggyCart, true);
    await waitFor(() => { const b = app.document.querySelector('.coupon-sheet [data-action="coupon-remove"]'); return b && !b.disabled; }, 'remove button enabled');
    app.document.querySelector('.coupon-sheet [data-action="coupon-remove"]').click();
    await waitFor(() => app.calls.filter(c => c.url.endsWith('/cart/sync')).length >= 2, 'remove call');
    assert.equal(app.calls.filter(c => c.url.endsWith('/cart/sync')).at(-1).body.coupon, '');
    await new Promise(r => setTimeout(r, 30));
  } finally { app.close(); }
});

test('DOM: pay ke baad order track hota hai (swiggy status, guess nahi)', async () => {
  const app = harness({ responder: call => {
    if (call.url.includes('/menu?id=')) return menuStub;
    if (call.url.includes('/orders/tracking')) return { ok: true, tracking: { orderId: '777', status: 'Out for delivery', eta: '12 min', deliveryOtp: '4321', deliveryPartner: { name: 'Rider', phone: '9000000000' } } };
    if (call.url.endsWith('/checkout/status')) return { ok: true, checkout: { status: 'PAID', orderId: '777', amount: 335, tracking: { status: 'Out for delivery' } } };
    // Round 33: payment ke baad My Orders khulta hai, isliye wahi order list me chahiye.
    if (call.url.endsWith('/orders')) return { ok: true, orders: [{ id: '777', status: 'Out for delivery', restaurant: 'Pizza Junction', amount: 335, placedAt: '01/11/26, 9:40 pm', items: [] }], detailAllowed: true };
    if (call.url.endsWith('/checkout')) return { ok: true, checkout: { status: 'PAYMENT_PENDING', orderId: '777', amount: 335, qrDataUrl: 'data:image/png;base64,AAA', upiIntentUrl: 'upi://pay?pa=x@y&am=335', message: 'Swiggy order ban gaya' }, cart: null };
    return state({ checkout: { status: 'PAYMENT_PENDING', orderId: '777', amount: 335, qrDataUrl: '', upiIntentUrl: '', message: 'Swiggy order ban gaya' } });
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.pay-screen'), 'payment screen');
    assert.match(app.document.body.textContent, /Pay ₹335/);
    assert.ok(app.document.querySelector('[data-action="checkout-status"]'));
    // Round 33 (boss): "FALTU KE ORDER TRACK KARE ... NA RAKHE" — payment page
    // par track button jaan-boojh kar hata diya; tracking paid hone par khud aati hai.
    assert.equal(app.document.querySelector('[data-action="track-open"]'), null, 'payment page par faltu track button nahi');
    app.document.querySelector('[data-action="checkout-status"]').click();
    // Round 33: "I have paid" → My Orders → wahi order khulta hai (share link ke saath).
    await waitFor(() => app.document.querySelector('.share-card'), 'order detail + share card');
    await waitFor(() => app.calls.some(c => c.url.includes('/orders/tracking?id=777')), 'tracking call');
    assert.equal(app.document.querySelector('.bottom-nav button.selected').dataset.tab, 'orders', 'My Orders');
    const text = app.document.body.textContent;
    assert.match(text, /Out for delivery/, 'Swiggy ka asli status');
    await new Promise(r => setTimeout(r, 30));
  } finally { app.close(); }
});

test('CSS: naye blocks ke styles maujood hain', () => {
  for (const selector of ['.savings-banner', '.savings-corner', '.meal-rail', '.coupon-tile', '.coupon-ribbon', '.pay-bar .pay-now', '.track-card', '.outlet-option.current']) {
    assert.ok(cssSource.includes(selector), selector);
  }
});
