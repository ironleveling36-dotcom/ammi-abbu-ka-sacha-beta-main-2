// Boss (31-10-2026, round 9): "BILL SUMMARY ME ITNA AYEGA NA YAAR."
// Yani wahi lines jo Swiggy dikhata hai — Items Total, Coupon, Extra Discount
// (Free Cash), Swiggy One Lite Membership, Free Delivery (kitna saved),
// Packing, GST & Other, Total Savings, To Pay. OFFLINE test: fake provider.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v98-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v98-offline-token', PRO_VAULT_KEY: 'v98-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');
const db = getDb();
db.config.accounts = {};
db.config.bossIds = ['9000'];
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
// Boss ka asli example: ₹230 ka item, FLASHSALE −₹160, Free Cash −₹70,
// One Lite +₹1, FREE delivery (₹49 saved), packing ₹5, GST ₹27.85 → To Pay ₹29.
const swiggyBill = {
  itemTotal: 230, deliveryFee: 0, deliverySaved: 49, packingCharges: 5, taxes: 27.85,
  discount: 160, coupon: 'FLASHSALE', freeCash: 70, tradeDiscount: 0, oneMembershipFee: 1,
  totalSavings: 279, total: 29
};
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search() { return []; },
  async coupons(_a, _addr, restaurantId) { return { restaurantId, coupons: [], discovery: false, note: 'APPLY dabaiye.' }; },
  async quoteCart(_a, address) { return { address, bill: { ...swiggyBill }, ofoConfirmed: false }; },
  async orders() { return []; },
  async tracking() { return {}; }
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
const user = sign(9801);
async function req(route, payload) {
  const response = await fetch(base + '/pro/api/' + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': user, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}
writeProWorkspace('9801', {
  version: 1,
  accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
  activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
  cart: {
    restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false,
    items: [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Paneer Kolhapuri', qty: 1, price: 230, isVeg: true, variants: [], addons: [] }],
    quote: null
  }
});

test('API: bill summary ke saare Swiggy fields save hote hain aur jod To Pay se milta hai', async () => {
  const out = await req('cart/sync', { confirmReplaceSwiggyCart: true });
  assert.equal(out.status, 200);
  const q = out.body.cart.quote;
  assert.equal(q.itemTotal, 230);
  assert.equal(q.coupon, 'FLASHSALE');
  assert.equal(q.discount, 160);
  assert.equal(q.freeCash, 70, 'Extra Discount (Free Cash)');
  assert.equal(q.oneMembershipFee, 1, 'Swiggy One Lite Membership');
  assert.equal(q.deliverySaved, 49, 'FREE delivery ka saving');
  assert.equal(q.deliveryFee, 0);
  assert.equal(q.packingCharges, 5);
  assert.equal(q.taxes, 27.85);
  assert.equal(q.total, 29);
  assert.equal(q.totalSavings, 279);
  // 230 − 160 − 70 + 1 + 0 + 5 + 27.85 = 33.85 → Swiggy ne ₹29 liya, yani ₹4.85
  // ka bacha hua discount bhi hai. Wo "Extra saving" line me sach ke saath aata
  // hai — jod barabar.
  assert.equal(q.unlistedDiscount, 4.85, 'chhupa discount chhupta nahi');
  const sum = 230 - 160 - 70 + 1 + 0 + 5 + 27.85 - 4.85;
  assert.equal(Math.round(sum * 100) / 100, 29, 'lines ka jod To Pay ke barabar');
});

// ── Client ───────────────────────────────────────────────────────────────
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
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
const quote = {
  itemTotal: 230, deliveryFee: 0, deliveryDistance: '2.1 km', deliverySaved: 49, packingCharges: 5, taxes: 27.85,
  taxesAndCharges: 32.85, discount: 160, coupon: 'FLASHSALE', freeCash: 70, tradeDiscount: 0, oneMembershipFee: 1,
  otherCharges: 0, unlistedDiscount: 4.85, totalSavings: 279, total: 29, mismatch: false,
  fetchedAt: '2026-10-31T00:00:00Z'
};
function state() {
  return {
    ok: true, user: { name: 'Test', isBoss: false }, accounts: [accountRow], activeAccount: accountRow,
    selectedAddress: receiver,
    cart: { restaurantId: '201', restaurantName: 'Paneer Palace', restaurantArea: 'Kothrud', restaurantTime: '25 min', restaurantImage: '', forSomeoneElse: false, quote,
      items: [{ lineKey: 'l', id: '9001', name: 'Paneer Kolhapuri', price: 230, qty: 1, isVeg: true }] },
    checkout: null, checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true
  };
}
const menuStub = { ok: true, restaurant: { id: '201', name: 'Paneer Palace', area: 'Kothrud', isOpen: true }, categories: [{ title: 'Main', items: [] }] };

test('DOM: bill summary bilkul Swiggy jaisa — har line, Total Savings aur To Pay', async () => {
  const app = harness({ responder: call => (call.url.includes('/menu?id=') ? menuStub : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.bill-card'), 'bill card');
    const bill = app.document.querySelector('.bill-card').textContent;
    assert.match(bill, /Items Total\s*₹230/);
    assert.match(bill, /Coupon FLASHSALE\s*−₹160/);
    assert.match(bill, /Extra Discount \(Free Cash\)\s*−₹70/);
    assert.match(bill, /Swiggy One Lite Membership\s*\+₹1/);
    assert.match(bill, /Free Delivery/);
    assert.match(bill, /₹49 saved/);
    assert.match(bill, /Delivery Fee[\s\S]*FREE \(₹49 saved\)/);
    assert.match(bill, /Packing Charges\s*₹5/);
    assert.match(bill, /GST & Other Charges\s*₹27\.85/);
    assert.match(bill, /Extra saving \(bill me\)\s*−₹4\.85/);
    assert.match(bill, /Total Savings\s*₹279/);
    assert.match(bill, /To Pay\s*₹29/);
    // Koi darawne "farak hai" box nahi — sirf sach.
    assert.equal(/farak hai/i.test(bill), false);
    // Banner + Savings Corner bhi asli savings dikhate hain.
    assert.match(app.document.body.textContent, /₹279 saved!/);
    const corner = app.document.querySelector('.savings-corner').textContent;
    assert.match(corner, /₹160 saved with FLASHSALE/);
    assert.match(corner, /₹70 Free Cash/);
    assert.match(corner, /₹49 saved on delivery/);
    assert.match(corner, /Swiggy One Lite/);
    // Bill breakdown is displayed directly, and the item remains visible.
    assert.equal(app.document.querySelector('[data-action="bill-open"]'), null);
    assert.match(app.document.querySelector('.cart-item').textContent, /Paneer Kolhapuri/);
    await new Promise(r => setTimeout(r, 20));
  } finally { app.close(); }
});
