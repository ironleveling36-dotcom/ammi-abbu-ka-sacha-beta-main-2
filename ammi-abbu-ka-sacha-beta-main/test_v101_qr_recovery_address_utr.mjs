// Boss (31-10-2026, round 12):
//  • "QR NAHI AYA PAYMENT KA AISA HO GAYA" — order ban gaya par QR nahi mila.
//  • Forwarded order par "Swiggy did not accept the verified delivery address".
//  • "UTR AUTO VERIFY NAHI HO RAHA".
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v101-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v101-offline-token', PRO_VAULT_KEY: 'v101-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '0',
  // Mock imports se pehle lagta hai, isliye `globalThis.fetch === bootFetch` —
  // ye flag offline sandbox guard ko kholta hai. Network phir bhi mock hi hai.
  ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.PRO_ENABLE_CHECKOUT;
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.UPI_REQUIRE_PROVIDER_VERIFY;

// Mock ko imports se PEHLE lagana zaroori hai: swiggy-cart.js import ke waqt
// `globalThis.fetch` yaad kar leta hai, warna test asli network par jata hai.
const realFetch = globalThis.fetch;
let cartMeta, placeJson, updateBodies, mcpCalls;
async function mockFetch(raw, options = {}) {
  const u = String(raw);
  if (u.includes('127.0.0.1')) return realFetch(raw, options);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('mcp.swiggy.com')) {
    const body = JSON.parse(options.body || '{}');
    mcpCalls.push(body?.params?.arguments || {});
    return json({ result: { structuredContent: { id: 'mcp-addr-1' } } });
  }
  if (u.includes('/api/v2/cart/client')) {
    if (options?.body) updateBodies.push(JSON.parse(options.body));
    return json({ statusCode: 0, tid: jwtMock, data: { cartMeta: { ...cartMeta, addresses: [receiverMock] } } });
  }
  if (u.includes('/api/v2/order/place')) return json(placeJson || { statusCode: 0, data: { order_id: '252421961135322' } });
  if (u.includes('/api/v1/user/profile')) return json({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [receiverMock] } });
  if (u.includes('/dapi/address')) return json({ statusCode: 1, statusMessage: 'rejected' });
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwtMock, data: { orders: [] } });
  return json({ statusCode: 0 });
}
const jwtMock = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const receiverMock = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, 1st house, Kajala, Maradpur, Odisha', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };
globalThis.fetch = mockFetch;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { proProvider } = await import('./swiggy-pro-provider.js');
const { addressTextHints, saveAddressToAccount } = await import('./swiggy-cart.js');
const { getDb, saveDb } = await import('./store.js');
const { walletBalancePaise } = await import('./user-wallet.js');
const { recordStatementPayment } = await import('./upi-statement.js');

const db = getDb();
db.config.accounts = {}; db.config.bossIds = ['9000'];
delete db.config.serviceFeePaise; delete db.config.walletUpiId;
saveDb(db);

const receiver = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, 1st house, Kajala, Maradpur, Odisha', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };
const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const account = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
function resetMock() {
  placeJson = null; updateBodies = []; mcpCalls = [];
  cartMeta = {
    order_total: 70, cartId: 'cart-9', originalCartId: 'cart-9', address_id: 'addr-1',
    item_total: 183, total_packing_charges: 10, taxesAndCharges: 38.79, coupon_discount_total: 128.1,
    coupon_code: 'SNACKIT', is_coupon_valid: 1, restaurant_details: { id: '201', name: 'Biryani' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Special Hyderabadi Mutton Biryani', subtotal: 18300, addons: [], variants: [] }]
  };
}
resetMock();
const cart = () => ({
  restaurantId: '201', restaurantName: 'Biryani', forSomeoneElse: true,
  items: [{ menu_item_id: 9001, qty: 1, variants: [], addons: [] }],
  quote: { total: 70, coupon: 'SNACKIT', couponCode: 'SNACKIT' }
});

// ── 1. QR: intent text ke andar chhupa ho to bhi milta hai ────────────────
test('QR: intent JSON text/escaped form me ho to bhi nikalta hai (order + QR)', async () => {
  resetMock();
  placeJson = { statusCode: 0, data: { order_id: '252421961135322', payment_fallbacks: {
    note: 'use this', payload: '{"deep_link":"upi:\\/\\/pay?pa=upiswiggy%40icici&am=70.00&cu=INR&tr=x"}' } } };
  const out = await proProvider.checkout({ ...account }, { ...receiver }, cart(), 'v101:qr-text');
  assert.equal(out.orderId, '252421961135322');
  assert.match(out.upiIntentUrl, /^upi:\/\/pay\?/);
});

test('QR: order bana par intent nahi → asli wajah (QR_PLACED_NO_INTENT), order ID ke saath', async () => {
  resetMock();
  placeJson = { statusCode: 0, data: { order_id: '252421961135322' } };
  let caught = null;
  try { await proProvider.checkout({ ...account }, { ...receiver }, cart(), 'v101:no-intent'); } catch (e) { caught = e; }
  assert.ok(caught, 'error aaya');
  assert.equal(caught.code, 'SWIGGY_PLACED_NO_UPI_INTENT');
  assert.equal(caught.diag.qrMissing, true);
  assert.equal(caught.diag.placedOrderId, '252421961135322');
  assert.match(caught.message, /QR|intent/i);
});

test('QR: QR ka amount bill se match na kare to wo QR kabhi nahi dikhaya jaata', async () => {
  resetMock();
  placeJson = { statusCode: 0, data: { order_id: '252421961135322', app_redirection_info: { upiRedirect: { upiIntentRedirect: { upiIntentUrl: 'upi://pay?pa=upiswiggy%40icici&am=99.00&cu=INR&tr=x' } } } } };
  let caught = null;
  try { await proProvider.checkout({ ...account }, { ...receiver }, cart(), 'v101:bad-amount'); } catch (e) { caught = e; }
  assert.equal(caught?.code, 'SWIGGY_PLACED_NO_UPI_INTENT');
  // Round 15: wajah asli hoti hai — "amount match nahi karta" fixed line nahi.
  assert.match(caught.diag.intentProblem, /amount/i);
  assert.ok(caught.diag.intentProblems.some(t => /amount/i.test(t)), 'asli problem list me amount hai');
  assert.equal(caught.diag.intentAmount, 99);
  assert.equal(caught.diag.billAmount, 70);
});

// ── 2. API: qrMissing checkout OUTCOME_UNKNOWN nahi banta ─────────────────
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession(s) { return { valid: true, phone: s.phone, customerId: 'c1' }; },
    async checkout() {
      const e = new Error('Swiggy ne order accept kiya par UPI payment QR/intent nahi diya. Order #252421961135322 Swiggy par bana hua hai — dobara order na karein.');
      e.code = 'SWIGGY_PLACED_NO_UPI_INTENT';
      e.diag = { code: 'SWIGGY_PLACED_NO_UPI_INTENT', placementAttempted: true, placedOrderId: '252421961135322', qrMissing: true, intentProblem: 'Swiggy ne order accept kiya par UPI payment QR/intent nahi diya.', paymentPageUrl: 'https://www.swiggy.com/payments?order=252421961135322', paymentTxnId: 'paas-1' };
      throw e;
    },
    async checkPayment() { return { paid: false, paymentVerified: false }; }
  };
  if (!await handleSwiggyProHttp(req, res, {
    provider, claim: async () => ({}),
    otp: { request: async () => ({ success: true }), verify: async () => ({ success: true }) },
    deleteOtp: { request: async () => ({}), verify: async () => ({}) },
    authorizeUser: async () => ({ allowed: true })
  })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); });

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

/** Round 20: credit sirf asli payment saboot (statement) par. */
function verifiedPayment(utr, amountPaise) {
  const db = getDb();
  recordStatementPayment(db, { utr, amountPaise, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl', status: 'SUCCESS', source: 'statement', at: Date.now() }, { actor: 'test' });
  saveDb(db);
}
function seed(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Biryani', forSomeoneElse: true,
      items: [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Biryani', qty: 1, price: 183, isVeg: false, variants: [], addons: [] }],
      quote: { itemTotal: 183, deliveryFee: 26, packingCharges: 10, taxes: 38.79, discount: 128.1, coupon: 'SNACKIT', couponCode: 'SNACKIT', total: 70, fetchedAt: new Date().toISOString() }
    }
  });
  const ws = readProWorkspace(String(userId));
  return ws;
}

test('API: QR na mile to checkout PAYMENT_PENDING rehta hai (OUTCOME_UNKNOWN nahi) aur QR ka sach dikhta hai', async () => {
  seed(9951);
  const walletDb = getDb();
  const { creditWallet } = await import('./user-wallet.js');
  creditWallet(walletDb, '9951', 1500, { reason: 'test', actor: 'test' });
  saveDb(walletDb);
  const ws = readProWorkspace('9951');
  const out = await req(9951, 'checkout', { confirmCheckout: true, expectedTotal: ws.cart.quote.total, quoteFetchedAt: ws.cart.quote.fetchedAt });
  assert.equal(out.status, 200);
  assert.equal(out.body.checkout.status, 'PAYMENT_PENDING');
  assert.equal(out.body.checkout.qrMissing, true);
  assert.equal(out.body.checkout.orderId, '252421961135322');
  assert.match(out.body.checkout.qrMissingReason, /QR|intent/i);
  assert.match(out.body.checkout.paymentPageUrl, /^https:\/\//);
  assert.equal(out.body.checkout.upiIntentUrl, undefined, 'QR nahi to QR field nahi');
  const saved = readProWorkspace('9951');
  assert.equal(saved.checkout.status, 'PAYMENT_PENDING', 'barrier bana (duplicate order nahi)');
  assert.equal(saved.checkout.qrMissing, true);
});

// ── 3. Address: text hints + MCP variant + same phone/location reuse ──────
test('address: PIN/city text se nikalte hain (invent nahi)', () => {
  const hints = addressTextHints('Golden villa, 1st house, Kajala, Maradpur, Odisha, India');
  assert.equal(hints.city, 'Maradpur');
  assert.equal(hints.state, 'Odisha');
  assert.equal(hints.pin, '');
  assert.equal(addressTextHints('Flat 3, Green Park, Pune 411045, India').pin, '411045');
});

test('address: pehla POST reject ho to MCP variants se address ban jaata hai', async () => {
  resetMock();
  const out = await saveAddressToAccount({ ...account }, { ...receiver }, []);
  assert.equal(out.addressId, "mcp-addr-1");
  assert.ok(mcpCalls.length >= 1, 'MCP create_address try hua');
  assert.ok(mcpCalls[0].fullAddress.includes('Golden villa'));
  assert.equal(mcpCalls[0].receiverPhone, '7978459775');
});

test('address: usi receiver ka saved address 40m ke andar ho to wahi use hota hai (naya duplicate nahi)', async () => {
  resetMock();
  const saved = [{ id: 'saved-77', name: 'Chiranjib', mobile: '7978459775', address: 'Golden Villa, Kajala', lat: '20.25850', lng: '84.79260' }];
  const out = await saveAddressToAccount({ ...account }, { ...receiver }, saved);
  assert.equal(out.addressId, 'saved-77');
  assert.equal(out.reusedSaved, true);
  assert.equal(mcpCalls.length, 0, 'koi naya address nahi bana');
});

// ── 4. UTR auto verify (mini app claim) ───────────────────────────────────
test('utr: top-up QR + UTR se auto credit (statement me paisa aaya hua)', async () => {
  seed(9952);
  const topup = await req(9952, 'wallet/topup', { amountPaise: 1500 });
  assert.equal(topup.status, 200);
  assert.ok(topup.body.topup.topupId, 'top-up intent bana');
  verifiedPayment('123456789012', 1500);
  const out = await req(9952, 'wallet/claim', { topupId: topup.body.topup.topupId, amountPaise: 1500, utr: '123456789012' });
  assert.equal(out.status, 200);
  assert.equal(out.body.verified, true);
  assert.equal(walletBalancePaise(getDb(), '9952'), 1500);
  assert.equal(out.body.wallet.ready, true);
  const claim = Object.values(getDb().config.topupClaims || {}).find(c => c.userId === '9952');
  assert.equal(claim?.status, 'AUTO_VERIFIED');
  assert.equal(claim?.verifiedBy, 'statement');
});
test('utr: wahi UTR dobara nahi chalta (dusre user ke liye bhi)', async () => {
  seed(9953);
  const topup = await req(9953, 'wallet/topup', { amountPaise: 1500 });
  const out = await req(9953, 'wallet/claim', { topupId: topup.body.topup.topupId, amountPaise: 1500, utr: '123456789012' });
  assert.equal(out.status, 409);
  assert.equal(out.body.error.code || out.body.code, 'DUPLICATE_UTR');
  assert.equal(walletBalancePaise(getDb(), '9953'), 0);
});

// ── 5. App: qrMissing card ────────────────────────────────────────────────
test('DOM: QR na mila ho to card order ID + asli wajah + "dobara order mat karein" dikhata hai', async () => {
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  const state = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver, selectedAddresses: [receiver],
    checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
    cart: { restaurantId: '201', restaurantName: 'Biryani', items: [{ lineKey: 'l', name: 'Biryani', price: 183, qty: 1 }], quote: { total: 70, fetchedAt: new Date().toISOString(), itemTotal: 183 } },
    checkout: { status: 'PAYMENT_PENDING', orderId: '252421961135322', amount: 70, qrMissing: true, qrMissingReason: 'Swiggy ne order accept kiya par UPI payment QR/intent nahi diya.', paymentPageUrl: 'https://www.swiggy.com/payments?order=252421961135322', message: 'Swiggy ne order accept kar liya par payment QR nahi diya.', paymentVerified: false },
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [] }
  };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => state });
  window.eval(fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8'));
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 20)); }
    throw new Error('timeout: ' + label);
  };
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    const card = await waitFor(() => window.document.querySelector('.pay-screen'), 'pay screen');
    const text = card.textContent;
    assert.match(text, /252421961135322/);
    assert.match(text, /QR nahi diya/i);
    assert.match(text, /dobara order mat karein/i);
    assert.ok(card.querySelector('[data-action="checkout-status"]'), 'payment check button');
    assert.ok(card.querySelector('a[href^="https://www.swiggy.com/payments"]'), 'Swiggy ka payment page');
    assert.equal(window.document.querySelector('.payment-qr'), null, 'QR nahi to QR image nahi');
  } finally { window.close(); }
});
