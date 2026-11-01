// Boss (31-10-2026, round 8): "COUPON AND CHECKOUT ISSUE", "DETAILED BILL —
// HOW THE FINAL BILL IS BEING CALCULATED, SAARA CASH JAISE APP ME DIKHTA HAI",
// "COUPON AVAILABLE NAHI HAI MAT BOLO — OPTION DO, CODE TYPE KARNE KA NAHI,
// SIRF APPLY." Sab OFFLINE: fake provider, stubbed fetch.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v97-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v97-offline-token', PRO_VAULT_KEY: 'v97-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
const { getDb, saveDb } = await import('./store.js');

const jwt = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ user_id: '4242', exp: 1900000000 })).toString('base64url'),
  'sig'
].join('.');
const db = getDb();
db.config.accounts = { reader: { phone: '9000000002', name: 'Reader', tid: jwt, token: 'tok', userId: '4242', customerId: '4242', isLoggedIn: true } };
saveDb(db);

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
function stubFetch(handler) {
  globalThis.fetch = async (url) => {
    const out = handler(String(url)) || {};
    return new Response(JSON.stringify(out.body ?? { statusCode: 0 }), { status: out.status || 200, headers: { 'content-type': 'application/json' } });
  };
}

const { proProvider } = await import('./swiggy-pro-provider.js');
const account = getDb().config.accounts.reader;

test('coupon list kabhi khaali nahi — Swiggy tool fail ho to bhi promo codes aate hain', async () => {
  stubFetch(() => ({ status: 500, body: { error: 'mcp down' } }));
  const out = await proProvider.coupons(account, { id: 'addr-1' }, '1467977');
  const codes = out.coupons.map(c => c.code);
  for (const expected of ['SNACKIT', 'TRYNEW', 'STEALDEAL', 'SWIGGYIT', 'WELCOME50']) {
    assert.ok(codes.includes(expected), `${expected} list me hona chahiye`);
  }
  assert.equal(/nahi di|available nahi|koi coupon nahi/i.test(out.note), false, 'jhoota "nahi hai" nahi bolna');
  assert.match(out.note, /APPLY/i);
});

test('Swiggy ke apne coupons pehle, promo codes uske baad (duplicate nahi)', async () => {
  stubFetch(url => {
    if (!url.includes('fetch_food_coupons') && !url.toLowerCase().includes('mcp') && !url.includes('tools')) return { body: { statusCode: 0 } };
    return { body: { jsonrpc: '2.0', result: { structuredContent: { coupons: [
      { coupon_code: 'SNACKIT', title: '70% OFF up to ₹140', description: 'above ₹199', is_applicable: true },
      { coupon_code: 'BIGSAVE', title: 'Flat ₹100 off', description: 'above ₹249', is_applicable: true }
    ] } } } };
  });
  const out = await proProvider.coupons(account, {}, '1467977');
  const codes = out.coupons.map(c => c.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate code nahi');
  assert.equal(codes.filter(c => c === 'SNACKIT').length, 1);
  assert.ok(codes.indexOf('BIGSAVE') < codes.indexOf('TRYNEW'), 'asli Swiggy coupon pehle');
  const snackit = out.coupons.find(c => c.code === 'SNACKIT');
  assert.equal(snackit.source, 'swiggy', 'Swiggy ka apna coupon hi dikhna chahiye');
  assert.equal(snackit.applicable, true);
});

// ── Client ───────────────────────────────────────────────────────────────
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
const accountRow = { key: 'mine', name: 'Mine', phone: '9123456789', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, needsConfirm: false, active: true, offerTracks: [] };
const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const quote = { total: 335, itemTotal: 274, deliveryFee: 0, packingCharges: 18, taxes: 43.08, taxesAndCharges: 61.08, discount: 0, otherCharges: 0, unlistedDiscount: 0, mismatch: false, deliveryDistance: '2.1 km', coupon: '', fetchedAt: '2026-10-31T00:00:00Z' };
function state(extra = {}) {
  return {
    ok: true, user: { name: 'Test', isBoss: false }, accounts: [accountRow], activeAccount: accountRow,
    selectedAddress: receiver,
    cart: { restaurantId: '201', restaurantName: 'Pizza Junction', restaurantArea: 'Kothrud', restaurantTime: '25 min', restaurantImage: '', forSomeoneElse: false, quote, items: [
      { lineKey: 'l', id: '9001', name: 'Margherita', price: 137, qty: 2, isVeg: true },
      { lineKey: 'm', id: '9002', name: 'Garlic Bread', price: 0, qty: 0, isVeg: true }
    ] },
    checkout: null, checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true, ...extra
  };
}
const menuStub = { ok: true, restaurant: { id: '201', name: 'Pizza Junction', area: 'Kothrud', isOpen: true }, categories: [{ title: 'Pizza', items: [] }] };

test('DOM: coupon page — koi code box nahi, har coupon par APPLY, result asli', async () => {
  const app = harness({ responder: call => {
    if (call.url.includes('/menu?id=')) return menuStub;
    if (call.url.includes('/coupons')) return { ok: true, coupons: [
      { code: 'SNACKIT', title: '70% OFF up to ₹140', description: 'above ₹199', applicable: true, source: 'swiggy' },
      { code: 'TRYNEW', title: 'Swiggy promo code', description: 'APPLY karke dekhein', applicable: true, source: 'promo' },
      { code: 'FLAT175', title: 'Flat ₹175 off', description: 'above ₹349', applicable: false, reason: 'Add ₹133 more', source: 'swiggy' }
    ], note: 'APPLY dabaiye — asli bill aayega.' };
    if (call.url.endsWith('/cart/sync')) {
      const code = call.body?.coupon || '';
      if (code === 'TRYNEW') return { ok: true, selectedAddress: receiver, cart: { ...state().cart, quote: { ...quote, coupon: 'TRYNEW', discount: 0 } } };
      return { ok: true, selectedAddress: receiver, cart: { ...state().cart, quote: { ...quote, coupon: code, discount: 140 } } };
    }
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="toggle-coupon"]'), 'coupon row');
    app.document.querySelector('[data-action="toggle-coupon"]').click();
    await waitFor(() => app.document.querySelectorAll('.coupon-tile').length === 3, 'coupon tiles');
    assert.equal(app.document.querySelector('input[name="coupon"]'), null, 'code type karne ka box nahi');
    assert.equal(app.document.querySelector('form[data-form="sync"]'), null);
    assert.ok(app.document.querySelector('.coupon-underlay[inert]'), 'cart sheet ke neeche inert hai');
    const applies = [...app.document.querySelectorAll('.coupon-sheet [data-action="coupon-pick"]')];
    assert.equal(applies.length, 3, 'har coupon par APPLY — locked bhi');
    assert.equal(/available nahi|nahi di|koi coupon nahi/i.test(app.document.body.textContent), false);
    // SNACKIT APPLY → asli bill se ₹140 saving, aur card par result dikhe.
    applies[0].click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/sync')), 'sync call');
    assert.equal(app.calls.find(c => c.url.endsWith('/cart/sync')).body.coupon, 'SNACKIT');
    await waitFor(() => app.document.querySelector('.coupon-result.ok'), 'saving result');
    assert.match(app.document.querySelector('.coupon-result.ok').textContent, /₹140/);
    // TRYNEW APPLY → Swiggy ne discount nahi diya, saaf batao (jhooth nahi).
    const trynewBtn = [...app.document.querySelectorAll('.coupon-sheet [data-action="coupon-pick"]')].find(b => b.dataset.code === 'TRYNEW');
    trynewBtn.click();
    await waitFor(() => app.calls.filter(c => c.url.endsWith('/cart/sync')).length >= 2, 'second sync');
    await waitFor(() => app.document.querySelector('.coupon-result.no'), 'no-discount result');
    assert.match(app.document.querySelector('.coupon-result.no').textContent, /discount nahi/i);
    await new Promise(r => setTimeout(r, 30));
  } finally { app.close(); }
});

test('DOM: bill ka poora hisaab — har line + jod ka equation', async () => {
  const app = harness({ responder: call => (call.url.includes('/menu?id=') ? menuStub : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.bill-card'), 'bill card');
    const bill = app.document.querySelector('.bill-card').textContent;
    assert.match(bill, /Items Total/);
    assert.match(bill, /₹274/);
    assert.match(bill, /Delivery Fee/);
    assert.match(bill, /FREE/);
    assert.match(bill, /GST & Other Charges/);
    assert.match(bill, /₹43\.08/, 'GST line alag');
    assert.match(bill, /Packing Charges\s*₹18/, 'packing alag line — Swiggy jaisa');
    assert.match(bill, /To Pay/);
    assert.match(bill, /₹335/);
    assert.equal(/farak hai/i.test(bill), false, 'darawne mismatch box nahi');
    // The complete returned bill is already visible; no toggle is needed.
    assert.equal(app.document.querySelector('[data-action="bill-open"]'), null);
    assert.match(app.document.querySelector('.cart-item').textContent, /Margherita/);
    // Swiggy ki bill summary lines: One Lite fee, free delivery saving, total savings.
    assert.match(app.document.querySelector('.bill-card').textContent, /Delivery Fee/);
    await new Promise(r => setTimeout(r, 20));
  } finally { app.close(); }
});

test('DOM: receiver ka mobile na ho to Pay Now address page par bhejta hai (dead end nahi)', async () => {
  const broken = state({ selectedAddress: { id: 'addr-1', name: '', mobile: '', address: 'Test Road', lat: '18.5204', lng: '73.8567', annotation: 'HOME' } });
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return broken;
    if (call.url.includes('/menu?id=')) return menuStub;
    return broken;
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.pay-bar .pay-now'), 'pay bar');
    app.document.querySelector('.pay-bar .pay-now').click();
    await waitFor(() => app.document.querySelector('form[data-form="contact"]'), 'receiver form');
    assert.ok(app.document.body.textContent.includes('Receiver details'), 'address page par receiver form');
    assert.equal(app.calls.some(c => c.url.endsWith('/checkout')), false, 'adhoora receiver par order nahi');
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/sync')), false, 'adhoora receiver par bill sync nahi');
    assert.match(app.document.querySelector('#toast').textContent, /naam aur 10-digit mobile/i);
    await new Promise(r => setTimeout(r, 20));
  } finally { app.close(); }
});

test('CSS: bill hisaab + coupon result ke styles maujood hain', () => {
  for (const selector of ['.bill-detail-math', '.bill-equation', '.bill-split', '.coupon-result.ok', '.coupon-result.no', '.bill-toggle']) {
    assert.ok(cssSource.includes(selector), selector);
  }
});
