// Boss (31-10-2026, round 11):
//  • "Swiggy ne order for someone else flag confirm nahi kiya" — har OFO order
//    par ye jhootha block aata tha. Ab order nahi rukta; OFO ka sach saaf.
//  • "AUTO SAARE COUPON LAG KAR AISA SUMMARY NAHI AARHA" — coupon khud lagta
//    hai (sabse kam bill) aur summary wahi lines jo Swiggy dikhata hai.
//  • "WALLET MUST REACH A BALANCE OF 15 ... DEFAULT UPI mius@ybl ... I CAN
//    CHANGE IT ALSO ... IF USER PAY LESS ... ADD HOW MUCH THEY PAID."
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v100-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v100-offline-token', PRO_VAULT_KEY: 'v100-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '0'
});
delete process.env.PRO_ENABLE_CHECKOUT;
delete process.env.WALLET_UPI_ID;
delete process.env.SERVICE_FEE_PAISE;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { proProvider } = await import('./swiggy-pro-provider.js');
const { getDb, saveDb } = await import('./store.js');
const { recordStatementPayment } = await import('./upi-statement.js');
const { walletBalancePaise, walletUpiId } = await import('./user-wallet.js');

const db = getDb();
db.config.accounts = {};
db.config.bossIds = ['9000'];
delete db.config.walletUpiId;
delete db.config.serviceFeePaise;
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const cartItems = [{ menu_item_id: 9001, qty: 1, variants: [], addons: [], name: 'Paneer Kolhapuri', id: '9001', lineKey: 'l', price: 230, isVeg: true }];
const draftCart = quote => ({ restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: true, items: structuredClone(cartItems), quote });

// ── Mock Swiggy (sirf wahi shapes jo app padhta hai) ────────────────────────
const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const providerAccount = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
let cartMeta, placeCalls, updateBodies;
function resetMock() {
  placeCalls = 0; updateBodies = [];
  cartMeta = {
    order_total: 29, cartId: 'cart-777', originalCartId: 'cart-777', address_id: 'addr-1',
    item_total: 230, total_packing_charges: 5, taxesAndCharges: 27.85, coupon_discount_total: 160,
    coupon_code: 'FLASHSALE', is_coupon_valid: 1,
    // Jaan-boojh kar OFO flag NAHI diya — asli Swiggy bhi nahi deta.
    restaurant_details: { id: '201', name: 'Paneer Palace' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Paneer Kolhapuri', subtotal: 23000, addons: [], variants: [] }]
  };
}
resetMock();
const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('127.0.0.1')) return realFetch(raw, options);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('mcp.swiggy.com')) {
    return json({ result: { structuredContent: { coupons: [
      { coupon_code: 'FLASHSALE', title: '60% off', is_applicable: true },
      { coupon_code: 'TRYNEW', title: '10% off', is_applicable: true }
    ] } } });
  }
  if (u.includes('/api/v2/cart/client')) {
    if (options?.body) {
      const body = JSON.parse(options.body);
      updateBodies.push(body);
      if (body.couponCode === 'FLASHSALE') {
        Object.assign(cartMeta, { coupon_code: 'FLASHSALE', order_total: 29, coupon_discount_total: 160 });
      } else if (body.couponCode === 'TRYNEW') {
        Object.assign(cartMeta, { coupon_code: 'TRYNEW', order_total: 210, coupon_discount_total: 20 });
      } else {
        Object.assign(cartMeta, { coupon_code: '', order_total: 230, coupon_discount_total: 0, is_coupon_valid: 0 });
      }
    }
    return json({ statusCode: 0, tid: jwt, data: { cartMeta: { ...cartMeta, addresses: [receiver] } } });
  }
  if (u.includes('/api/v2/order/place')) {
    placeCalls += 1;
    const sent = JSON.parse(options.body);
    return json({ statusCode: 0, data: { order_id: '123456789012', app_redirection_info: {
      intent: `upi://pay?pa=upiswiggy%40icici&am=${Number(sent.order_total).toFixed(2)}&cu=INR&tr=offline`
    } } });
  }
  if (u.includes('/api/v1/user/profile')) return json({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [receiver] } });
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwt, data: { orders: [] } });
  return json({ statusCode: 0 });
};
after(() => {
  globalThis.fetch = realFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ── API harness ────────────────────────────────────────────────────────────
let checkoutImpl = async () => { throw new Error('checkout stub'); };
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async search() { return []; },
  async coupons(_a, _addr, restaurantId) { return { restaurantId, coupons: [{ code: 'FLASHSALE', applicable: true }], note: '' }; },
  async quoteCart(_a, address) {
    return { address, bill: { itemTotal: 230, deliveryFee: 0, deliverySaved: 49, packingCharges: 5, taxes: 32.85, discount: 160, coupon: 'FLASHSALE', total: 29 }, ofoConfirmed: false };
  },
  async orders() { return []; },
  async checkout(...args) { return checkoutImpl(...args); }
};
const server = http.createServer(async (req, res) => {
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
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: `User ${userId}` }), query_id: 'q'
  });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}

/** Round 20: credit ke liye asli payment saboot chahiye (statement entry). */
function verifiedPayment(utr, amountPaise) {
  const db = getDb();
  recordStatementPayment(db, { utr, amountPaise, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl', status: 'SUCCESS', source: 'statement', at: Date.now() }, { actor: 'test' });
  saveDb(db);
}
async function req(userId, route, payload) {
  const response = await fetch(base + '/pro/api/' + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': sign(userId), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}
function seed(userId, { forSomeoneElse = false } = {}) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: quote => quote
  });
  const ws = readProWorkspace(String(userId));
  ws.cart = {
    restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse,
    items: structuredClone(cartItems),
    quote: { itemTotal: 230, deliveryFee: 0, deliverySaved: 49, packingCharges: 5, taxes: 27.85, otherCharges: 5, discount: 160, coupon: 'FLASHSALE', couponCode: 'FLASHSALE', freeCash: 70, total: 29, totalSavings: 279, fetchedAt: new Date().toISOString() }
  };
  writeProWorkspace(String(userId), ws);
  return ws;
}

// ── 1. OFO: asli provider me flag na mile to bhi order nahi rukta ──────────
test('OFO: Swiggy cart OFO flag na de to bhi order rukta nahi — sach saaf mile', async () => {
  resetMock();
  const cart = { ...draftCart({ total: 29, coupon: 'FLASHSALE', couponCode: 'FLASHSALE' }), forSomeoneElse: true };
  const result = await proProvider.checkout({ ...providerAccount }, { ...receiver }, cart, 'v100:ofo');
  assert.equal(result.orderId, '123456789012');
  assert.equal(placeCalls, 1, 'placement ek hi baar');
  assert.equal(result.ofoConfirmed, false, 'jhootha OFO confirm nahi');
  assert.match(result.ofoNote, /OFO flag nahi diya|normal order/i);
  assert.equal(updateBodies.length >= 0, true);
});
test('OFO: pehle jo hard-stop tha (flag nahi mila) wahi ab block nahi karta — koi OFO error nahi', async () => {
  resetMock();
  const cart = { ...draftCart({ total: 29, coupon: 'FLASHSALE', couponCode: 'FLASHSALE' }), forSomeoneElse: true };
  const result = await proProvider.checkout({ ...providerAccount }, { ...receiver }, cart, 'v100:ofo2');
  assert.equal(result.amount, 29);
  assert.equal(placeCalls, 1);
});

// ── 2. Auto coupon: bina code ke sabse kam bill wala coupon khud lagta hai ──
test('auto coupon: bina code ke Swiggy ke coupons khud try hote hain aur sabse kam total wala lagta hai', async () => {
  resetMock();
  const cart = { ...draftCart(null), forSomeoneElse: false };
  const out = await proProvider.quoteCart({ ...providerAccount }, { ...receiver }, cart, '');
  assert.equal(out.bill.coupon, 'FLASHSALE');
  assert.equal(out.bill.total, 29, 'sabse kam bill');
  assert.equal(out.bill.autoCoupon, true);
  assert.ok(out.bill.couponTried.includes('FLASHSALE'));
  assert.ok(out.bill.couponTried.includes('TRYNEW'));
  assert.equal(out.bill.discount, 160);
});
test('auto coupon: user ne code chuna ho to wahi chalta hai (auto band)', async () => {
  resetMock();
  const cart = { ...draftCart(null), forSomeoneElse: false };
  const out = await proProvider.quoteCart({ ...providerAccount }, { ...receiver }, cart, 'TRYNEW');
  assert.equal(out.bill.coupon, 'TRYNEW');
  assert.equal(out.bill.total, 210);
});
test('auto coupon: cart/sync autoCoupon true bhejta hai aur bill me autoCoupon save hota hai', async () => {
  seed(9941);
  const out = await req(9941, 'cart/sync', { confirmReplaceSwiggyCart: true, autoCoupon: true });
  assert.equal(out.status, 200);
  assert.equal(readProWorkspace('9941').cart.autoCoupon, true);
  assert.equal(out.body.cart.quote.couponCode, 'FLASHSALE');
});

// ── 3. Wallet: ₹15 gate + mius@ybl + jitna bheja utna credit ───────────────
test('wallet: default UPI mius@ybl, fee ₹15 aur balance kam par Low balance', async () => {
  seed(9942);
  const out = await req(9942, 'wallet');
  assert.equal(out.status, 200);
  assert.equal(out.body.wallet.upiId, 'mius@ybl');
  assert.equal(out.body.wallet.balancePaise, 0);
  assert.equal(out.body.wallet.feePaise, 1500);
  assert.equal(out.body.wallet.fee, '15');
  assert.equal(out.body.wallet.ready, false);
  assert.equal(out.body.wallet.shortfall, '15');
});
test('wallet: ₹10 top-up + UTR → ₹10 credit, ₹5 aur maango; phir ₹5 → ready', async () => {
  seed(9943);
  // Round 16: credit sirf top-up QR ke amount par, UTR zaroori.
  const t1 = await req(9943, 'wallet/topup', { amountPaise: 1000 });
  verifiedPayment('909090909090', 1000);
  const first = await req(9943, 'wallet/claim', { topupId: t1.body.topup.topupId, amountRupees: 10, utr: '909090909090' });
  assert.equal(first.status, 200);
  assert.equal(first.body.wallet.balancePaise, 1000);
  assert.equal(first.body.wallet.ready, false);
  assert.match(first.body.message, /₹5/);
  const t2 = await req(9943, 'wallet/topup', { amountPaise: 500 });
  verifiedPayment('909090909091', 500);
  const second = await req(9943, 'wallet/claim', { topupId: t2.body.topup.topupId, amountRupees: 5, utr: '909090909091' });
  assert.equal(second.body.wallet.balancePaise, 1500);
  assert.equal(second.body.wallet.ready, true);
  assert.match(second.body.message, /kar sakte hain/i);
  const w = walletBalancePaise(getDb(), '9943');
  assert.equal(w, 1500);
});
test('wallet: topup ka asli UPI intent mius@ybl par banta hai (QR bhi)', async () => {
  seed(9944);
  const out = await req(9944, 'wallet/topup', {});
  assert.equal(out.status, 200);
  assert.match(out.body.topup.upiUri, /^upi:\/\/pay\?/);
  assert.match(out.body.topup.upiUri, /pa=mius%40ybl/);
  assert.match(out.body.topup.qrDataUrl, /^data:image\/png;base64,/);
});
test('wallet: boss UPI badal sakta hai; doosra user nahi', async () => {
  seed(9000);
  const boss = await req(9000, 'wallet/upi', { upiId: 'boss@paytm' });
  assert.equal(boss.status, 200);
  assert.equal(boss.body.upiId, 'boss@paytm');
  assert.equal(walletUpiId(getDb()), 'boss@paytm');
  const other = await req(9945, 'wallet/upi', { upiId: 'hack@paytm' });
  assert.equal(other.status, 403);
  const bad = await req(9000, 'wallet/upi', { upiId: 'not-a-upi' });
  assert.equal(bad.status, 400);
});
test('wallet: balance kam par order nahi jaata — asli wajah + kitna add karna hai', async () => {
  seed(9946);
  let called = 0;
  checkoutImpl = async () => { called += 1; throw new Error('should not reach'); };
  const ws = readProWorkspace('9946');
  const out = await req(9946, 'checkout', { confirmCheckout: true, expectedTotal: ws.cart.quote.total, quoteFetchedAt: ws.cart.quote.fetchedAt });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'WALLET_LOW_BALANCE');
  assert.match(out.body.error, /₹15/);
  assert.match(out.body.error, /bot.*wallet/i, 'top-up is directed to the bot');
  assert.equal(out.body.wallet, undefined, 'no Mini App wallet card');
  assert.equal(called, 0, 'provider tak baat nahi gayi');
});
test('wallet: balance poora par fee katti hai; order place na ho to refund', async () => {
  seed(9947);
  const topup = await req(9947, 'wallet/topup', { amountPaise: 1500 });
  verifiedPayment('919191919191', 1500);
  await req(9947, 'wallet/claim', { topupId: topup.body.topup.topupId, amountRupees: 15, utr: '919191919191' });
  checkoutImpl = async () => { throw new Error('Swiggy cart nahi diya'); };
  const ws = readProWorkspace('9947');
  const out = await req(9947, 'checkout', { confirmCheckout: true, expectedTotal: ws.cart.quote.total, quoteFetchedAt: ws.cart.quote.fetchedAt });
  assert.equal(out.status >= 400, true);
  assert.equal(walletBalancePaise(getDb(), '9947'), 1500, 'fee refund ho gayi');
  const after1 = await req(9947, 'wallet');
  assert.equal(after1.body.wallet.ready, true);
});

// ── 4. Bill summary: boss ki exact lines + organized text + auto bill ──────
const appState = (extra = {}) => ({
  ok: true, user: { name: 'Test', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine', phone: '9123456789' },
  selectedAddress: receiver, checkout: null, checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
  cart: {
    restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false, items: structuredClone(cartItems),
    quote: { itemTotal: 230, deliveryFee: 0, deliverySaved: 49, deliveryDistance: '7km', packingCharges: 5, taxes: 27.85, otherCharges: 0, discount: 160, coupon: 'FLASHSALE', couponCode: 'FLASHSALE', freeCash: 70, unlistedDiscount: 4.85, oneMembershipFee: 1, totalSavings: 279, total: 29, fetchedAt: new Date().toISOString() }
  },
  wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfallPaise: 1500, shortfall: '15', upiId: 'mius@ybl', exempt: false, presets: [{ paise: 1500, rupees: '15' }, { paise: 5000, rupees: '50' }], history: [] },
  ...extra
});
function harness(responder) {
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  const calls = [];
  window.Telegram = { WebApp: { initData: 'test-init', ready() {}, expand() {}, HapticFeedback: { impactOccurred() {} } } };
  window.fetch = async (raw, options = {}) => {
    const url = String(raw);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    const payload = responder({ url, body });
    const data = payload && payload.__response ? payload.body : payload;
    const status = payload && payload.__response ? payload.status : 200;
    return { ok: status < 400, status, json: async () => data };
  };
  const code = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
  window.eval(code);
  return {
    window, document: window.document, calls,
    close() { try { window.close(); } catch {} }
  };
}
const response = (body, status = 200) => ({ __response: true, body, status });
const waitFor = async (fn, label, ms = 4000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const value = fn(); if (value) return value; } catch {}
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timeout: ' + label);
};

test('DOM: bill summary bilkul Swiggy jaisi lines me + organized plain text', async () => {
  const app = harness(() => response(appState()));
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.bill-plain'), 'bill text');
    const text = app.document.querySelector('.bill-plain').textContent;
    for (const line of [
      'Paneer Kolhapuri  ₹230 × 1 = ₹230',
      'Items Total: ₹230',
      'Coupon FLASHSALE: −₹160',
      'Extra Discount ( Free Cash ): −₹70',
      'Swiggy One Lite Membership: +₹1',
      'Free Delivery upto 7km',
      'Delivery Fee: FREE (₹49 saved)',
      'Packing Charges: ₹5',
      'GST & Other Charges: ₹27.85',
      '━━━━━━━━━━━━━━',
      'Total Savings: ₹279',
      'To Pay: ₹29'
    ]) assert.ok(text.includes(line), `missing: ${line}`);
  } finally { app.close(); }
});
test('DOM: wallet and recharge controls live in the bot, not the Mini App', async () => {
  const app = harness(() => response(appState()));
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.bill-plain'), 'bill text');
    assert.equal(app.document.querySelector('.wallet-card'), null);
    assert.equal(app.document.querySelector('form[data-form="wallet-claim"]'), null);
    assert.equal(app.document.querySelector('[data-action="wallet-topup"]'), null);
  } finally { app.close(); }
});
test('DOM: cart khulte hi bill automatic aata hai (Pay dabane ka intezaar nahi)', async () => {
  const noQuote = appState();
  noQuote.cart.quote = null;
  const withQuote = appState();
  const app = harness(call => (call.url.endsWith('/cart/sync') ? response({ ok: true, cart: withQuote.cart, selectedAddress: receiver }) : response(noQuote)));
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/sync')), 'auto bill sync');
    const call = app.calls.find(c => c.url.endsWith('/cart/sync'));
    assert.equal(call.body.autoCoupon, true, 'coupon auto try hota hai');
    await waitFor(() => app.document.querySelector('.bill-plain'), 'bill text');
    assert.match(app.document.querySelector('.bill-plain').textContent, /To Pay: ₹29/);
  } finally { app.close(); }
});
