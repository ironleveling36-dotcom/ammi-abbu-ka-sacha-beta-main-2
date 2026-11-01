// Boss (31-10-2026, round 15):
//   "qr nahi aata direct ye ajata aur kitna ganda dikh raha hai ye text
//    bilkul bhi style nahi kia tune"
//
// Do cheezein yahan test hoti hain:
//   1. Swiggy ka intent gandi encoding me aaye (escaped `&`, `amount`, duplicate
//      param, space) to bhi QR **dikhe** — aur galat amount/pa ho to na dikhe,
//      par wajah **asli** ho ("QR ₹68, bill ₹68" jaisa jhooth nahi).
//   2. QR na mile to card structured + styled ho (heading block, wajah list,
//      order chip, steps) — koi patlee column me toota hua text nahi.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v104-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v104-offline-token', PRO_VAULT_KEY: 'v104-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '0',
  ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});

const realFetch = globalThis.fetch;
let placeJson, cartMeta, paymentPageHtml;
const jwtMock = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const receiverMock = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, 1st house, Kajala, Maradpur, Odisha', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('127.0.0.1')) return realFetch(raw, options);
  if (u.includes('mcp.swiggy.com')) return json({ result: { structuredContent: {} } });
  if (u.includes('/api/v2/cart/client')) return json({ statusCode: 0, tid: jwtMock, data: { cartMeta: { ...cartMeta } } });
  if (u.includes('/api/v2/order/place')) return json(placeJson || { statusCode: 0, data: {} });
  if (u.includes('/api/v1/user/profile')) return json({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [receiverMock] } });
  // Swiggy ka apna payment page — intent yahan chhupa ho sakta hai.
  if (u.includes('www.swiggy.com/payments')) return new Response(paymentPageHtml || '', { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwtMock, data: {} });
  return json({ statusCode: 0 });
};
after(() => { globalThis.fetch = realFetch; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const { proProvider } = await import('./swiggy-pro-provider.js');
const { validateUpiIntentForQr, normalizeUpiIntentForQr } = await import('./payment-qr-guard.js');
const { getDb, saveDb } = await import('./store.js');
const db = getDb(); db.config.accounts = {}; db.config.bossIds = ['9000']; delete db.config.serviceFeePaise; saveDb(db);

const account = { phone: '9234567890', token: 'mock-token', tid: jwtMock, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const cart = () => ({
  restaurantId: '201', restaurantName: 'Biryani', forSomeoneElse: true,
  items: [{ menu_item_id: 9001, qty: 1, variants: [], addons: [] }],
  quote: { total: 68, coupon: '', couponCode: '' }
});
function reset() {
  placeJson = null; paymentPageHtml = '';
  cartMeta = {
    order_total: 68, cartId: 'cart-9', originalCartId: 'cart-9', address_id: 'addr-1',
    item_total: 68, total_packing_charges: 0, taxesAndCharges: 0,
    restaurant_details: { id: '201', name: 'Biryani' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Biryani', subtotal: 6800, addons: [], variants: [] }]
  };
}
reset();

// ── 1. Guard: gandi encoding QR ko nahi rokni chahiye ─────────────────────
test('guard: escaped & (HTML/JSON) wala intent saaf hota hai, QR rukta nahi', () => {
  const check = validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&amp;am=68.00&amp;cu=INR&amp;tn=Order%20252', { amount: 68 });
  assert.equal(check.valid, true, check.problems.join(' | '));
  assert.match(check.info.uri, /^upi:\/\/pay\?pa=upiswiggy@icici&am=68\.00&cu=INR&tn=Order%20252$/);
  assert.ok(check.warnings.some(w => /auto-fix/.test(w)), 'auto-fix bata bhi raha hai');
});

test('guard: `amount` aur `am` (same value) / same-value duplicate param auto-fix', () => {
  const alias = normalizeUpiIntentForQr('upi://pay?pa=upiswiggy@icici&amount=68&cu=INR');
  assert.match(alias.uri, /[?&]am=68(&|$)/);
  assert.equal(validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&am=68&am=68&cu=INR', { amount: 68 }).valid, true);
});

test('guard: naya Swiggy bank handle block nahi hota, purana fake handle block hota hai', () => {
  assert.equal(validateUpiIntentForQr('upi://pay?pa=swiggy@axisbank&am=68&cu=INR', { amount: 68 }).valid, true);
  const fake = validateUpiIntentForQr('upi://pay?pa=swiggy@icici&am=68&cu=INR', { amount: 68 });
  assert.equal(fake.valid, false);
  assert.match(fake.problems.join(' '), /placeholder|fake/i);
});

test('guard: amount sach me galat ho to block + asli wajah (₹68 vs ₹68 wala jhooth nahi)', () => {
  const check = validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&am=58&cu=INR', { amount: 68 });
  assert.equal(check.valid, false);
  assert.match(check.problems.join(' '), /₹58.*₹68/);
  assert.equal(check.info.amount, 58);
});

test('guard: Swiggy ke asli shape par (`am` + alag `amount`) QR block nahi hota', () => {
  // Live card me yahi aaya tha: "multiple amount params (value alag)".
  const check = validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&am=48.00&amount=68.00&cu=INR&tr=2525267', { amount: 48 });
  assert.equal(check.valid, true, check.problems.join(' | '));
  assert.ok(!/amount=/.test(check.info.uri), 'QR me stray `amount` nahi jaata');
  assert.match(check.warnings.join(' '), /amount/);
});

// ── 2. Provider: ye intent ab QR bana kar deta hai ────────────────────────
test('provider: escaped/duplicate intent ho to bhi checkout QR deta hai (order + saaf URI)', async () => {
  reset();
  placeJson = { statusCode: 0, data: { order_id: '252425287129113', app_redirection_info: { upiRedirect: { upiIntentRedirect: {
    upiIntentUrl: 'upi://pay?pa=upiswiggy@icici&amp;am=68.00&amp;am=68.00&amp;cu=INR&amp;tn=Swiggy Order'
  } } } } };
  const out = await proProvider.checkout({ ...account }, { ...receiverMock }, cart(), 'v104:escaped');
  assert.equal(out.orderId, '252425287129113');
  assert.match(out.upiIntentUrl, /^upi:\/\/pay\?/);
  assert.ok(!/&amp;/.test(out.upiIntentUrl), 'escaped & saaf');
  assert.ok(!/ /.test(out.upiIntentUrl), 'space encode hua');
  assert.equal(validateUpiIntentForQr(out.upiIntentUrl, { amount: 68 }).valid, true);
});

test('provider: intent place-response me na ho to Swiggy ke apne payment page se nikalta hai', async () => {
  reset();
  placeJson = { statusCode: 0, data: {
    order_id: '252425287129113',
    payment_fallbacks: { page: 'https://www.swiggy.com/payments/checkout?order=252425287129113' }
  } };
  paymentPageHtml = '<html><script>window.__PAY={uri:"upi:\\/\\/pay?pa=upiswiggy@icici\\u0026am=68.00\\u0026cu=INR"}</script></html>';
  const out = await proProvider.checkout({ ...account }, { ...receiverMock }, cart(), 'v104:page-recovery');
  assert.match(out.upiIntentUrl, /^upi:\/\/pay\?/);
  assert.equal(validateUpiIntentForQr(out.upiIntentUrl, { amount: 68 }).valid, true);
});

test('provider: QR sach me galat ho to message me asli wajah (amount + dono numbers)', async () => {
  reset();
  placeJson = { statusCode: 0, data: { order_id: '252425287129113', app_redirection_info: { upiRedirect: { upiIntentRedirect: {
    upiIntentUrl: 'upi://pay?pa=upiswiggy@icici&am=58.00&cu=INR'
  } } } } };
  let caught = null;
  try { await proProvider.checkout({ ...account }, { ...receiverMock }, cart(), 'v104:bad-amount'); } catch (e) { caught = e; }
  assert.equal(caught?.code, 'SWIGGY_PLACED_NO_UPI_INTENT');
  assert.match(caught.diag.intentProblem, /₹58/);
  assert.match(caught.diag.intentProblem, /₹68/);
  assert.equal(caught.diag.billAmount, 68);
  assert.ok(Array.isArray(caught.diag.intentProblems) && caught.diag.intentProblems.length > 0);
});

// ── 3. App: card styled + structured ──────────────────────────────────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
async function render(checkout) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  const state = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiverMock, selectedAddresses: [receiverMock],
    checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
    cart: { restaurantId: '201', restaurantName: 'Biryani', items: [{ lineKey: 'l', name: 'Biryani', price: 68, qty: 1 }], quote: { total: 68, fetchedAt: new Date().toISOString(), itemTotal: 68 } },
    checkout,
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [] }
  };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => state });
  window.eval(fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8'));
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 20)); }
    throw new Error('timeout: ' + label);
  };
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
  window.document.querySelector('[data-tab="cart"]').click();
  return { window, card: await waitFor(() => window.document.querySelector('.pay-screen'), 'pay screen') };
}

test('DOM: QR na mile to card me heading block, asli wajah list, order chip aur steps hon', async () => {
  const { window, card } = await render({
    status: 'PAYMENT_PENDING', orderId: '252425287129113', amount: 68, qrMissing: true,
    qrMissingReason: 'Swiggy ka QR bhejne layak nahi tha: QR ka amount ₹58 hai par bill ₹68.',
    qrMissingReasons: ['QR ka amount ₹58 hai par bill ₹68 — scan par galat amount aayega'],
    paymentVerified: false
  });
  try {
    const title = card.querySelector('.card-title');
    assert.ok(title.querySelector('.title-copy strong'), 'heading strong');
    assert.ok(title.querySelector('.title-copy small'), 'heading sub');
    assert.ok(card.querySelector('.pay-hold'), 'hold block');
    const reasons = [...card.querySelectorAll('.pay-reasons li')].map(li => li.textContent.trim());
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /₹58/);
    assert.ok(card.querySelector('.pay-order-chip b'), 'order chip');
    // Round 33: 3-step lecture hataya (boss: blah blah na rakhe), sach rahe.
    assert.equal(card.querySelectorAll('.pay-steps li').length, 0, 'lecture steps nahi');
    assert.match(card.textContent, /Dobara order mat karein/);
  } finally { window.close(); }
});

test('DOM: QR aaye to sirf QR + do button (Open UPI app hataya — boss round 33)', async () => {
  const { window, card } = await render({
    status: 'PAYMENT_PENDING', orderId: '252425287129113', amount: 68, paymentVerified: false,
    upiIntentUrl: 'upi://pay?pa=upiswiggy@icici&am=68.00&cu=INR',
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo='
  });
  try {
    assert.ok(card.querySelector('.payment-qr'), 'QR image');
    // Boss: "PAYMENT PAGE SE OPEN UPI APP HATAYE" — bahar jane wala koi link nahi.
    assert.equal(card.querySelector('a[href^="upi://pay"]'), null, 'Open UPI app hataya');
    assert.ok(card.querySelector('[data-action="checkout-status"]'), 'I have paid');
    assert.ok(card.querySelector('[data-action="checkout-cancel"]'), 'Cancel order');
    assert.equal(card.querySelector('.pay-hold'), null, 'hold card nahi');
    assert.match(card.textContent, /UPI se pay karein/);
  } finally { window.close(); }
});

test('CSS: pay-hold/reasons/steps ki styling maujood hai (plain text nahi)', () => {
  for (const sel of ['.pay-hold', '.pay-hold-head', '.pay-reasons', '.pay-order-chip', '.pay-steps']) {
    assert.ok(css.includes(sel), `${sel} styled`);
  }
  assert.ok(/\.pay-screen \.card-title \.title-copy strong/.test(css), 'title-copy strong styled');
});
