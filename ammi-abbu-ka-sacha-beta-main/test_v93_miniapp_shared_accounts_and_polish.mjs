// Boss (31-10-2026, round 4): shared IDs, used-ID warning, address/bill fixes,
// order-history privacy, in-app only, aur UI polish. Ye OFFLINE test hai —
// fake provider, koi live Swiggy/Telegram/UPI call nahi hoti.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v93-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v93-offline-token', PRO_VAULT_KEY: 'v93-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', BOSS_ID: '9000', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace, ensureProWorkspaceHydrated } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');

const db = getDb();
db.config.accounts = {
  // Legacy grant hashes remain accepted; operator IDs are now shared by default.
  acc_operator_used: { phone: '9876500001', name: 'Operator used', token: 'op-token-1', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 4, freeCashBalance: 50 },
  acc_operator_fresh: { phone: '9876500002', name: 'Operator fresh', token: 'op-token-2', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0 },
  acc_operator_expired: { phone: '9876500003', name: 'Operator expired', isLoggedIn: true, isLoggedOut: true }
};
db.config.bossIds = ['9000'];
const grants = Object.fromEntries(Object.entries(db.config.accounts).map(([key, a]) => [key,
  crypto.createHash('sha256').update(`pro-account-access:phone:${a.phone}`).digest('hex')]));
db.config.proAccountGrants = { '9101': { ...grants }, '9102': { ...grants } };
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const billStates = { mode: 'exact' };
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search() { return []; },
  async menu() { return { restaurant: { id: '123', name: 'R', isOpen: true }, categories: [{ title: 'All', items: [] }] }; },
  async quoteCart(_a, address) {
    const base = { itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, discount: 0, total: 335, coupon: '' };
    if (billStates.mode === 'gap') return { address, bill: { ...base, total: 350 }, ofoConfirmed: false };
    if (billStates.mode === 'below') return { address, bill: { ...base, total: 200 }, ofoConfirmed: false };
    return { address, bill: base, ofoConfirmed: false };
  },
  async orders() {
    return [{ id: '111111111111', restaurant: 'Example restaurant', status: 'DELIVERED', placedAt: '31/10/26', amount: 335, items: [{ name: 'Meal', qty: 1 }], address: 'Secret address of operator' }];
  },
  async tracking() { return { orderId: '111111111111', status: 'Delivered', trackingUrl: 'https://www.swiggy.com/orders/111111111111', deliveryOtp: '1234' }; }
};

// Claim/delete ke liye fake bridge — koi live Swiggy call nahi.
const claimCalls = [];
const claim = async (account) => {
  claimCalls.push(account.phone || account.name);
  // Doosri baar wahi offer: Swiggy "pehle se laga hua" hi kehta hai.
  const repeat = claimCalls.length > 1;
  return {
    summary: { total: 5, claimed: 2, alreadyActive: 2, preLocked: 0, failed: 1 },
    allActive: false,
    offers: {
      lateNight: repeat ? { status: 'ALREADY_ACTIVE', verified: true, message: 'pehle se laga hua tha' } : { status: 'CLAIMED', verified: true, message: 'claim ho gaya (read-back: option 1)' },
      breakfast: { status: 'CLAIMED', verified: true, message: 'claim ho gaya (read-back: option 1)' },
      extra50: { status: 'ALREADY_ACTIVE', verified: true, message: 'pehle se laga hua tha' },
      weekend: { status: 'ALREADY_ACTIVE', verified: true, message: 'pehle se laga hua tha' },
      karwaChauth: { status: 'FAILED', verified: false, message: 'window band hai' }
    }
  };
};
const deleteCalls = [];
const deleteOtp = {
  async request(userId, phone, key) { deleteCalls.push({ step: 'request', userId, phone, key }); return { success: true }; },
  async verify(userId, otp, key) { deleteCalls.push({ step: 'verify', userId, otp, key }); return otp === '123456' ? { success: true } : { success: false, message: 'Swiggy ne OTP reject kiya' }; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, claim, deleteOtp, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
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
const user = sign(9101), other = sign(9102), boss = sign(9000);
async function req(auth, route, payload, method = payload === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/pro/api/' + route, {
    method,
    headers: { 'X-Telegram-Init-Data': auth, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}

function seedCart(userId, accountKey) {
  const quoteAt = new Date().toISOString();
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { [accountKey]: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: accountKey, selectedAddress: receiver, addressCandidates: [],
    cart: { restaurantId: '123', restaurantName: 'R', forSomeoneElse: false, items: [{ lineKey: 'l', id: '1', menu_item_id: 1, name: 'Meal', qty: 1, price: 274, variants: [], addons: [] }], quote: { total: 335, fetchedAt: quoteAt } }
  });
}

test('authorized user sees operator IDs, but claim/remove and full number remain boss-only', async () => {
  const boot = await req(user, 'bootstrap');
  assert.equal(boot.status, 200);
  const keys = boot.body.accounts.map(a => a.key);
  assert.ok(keys.includes('acc_operator_used'));
  assert.ok(keys.includes('acc_operator_fresh'));
  assert.equal(keys.includes('acc_operator_expired'), false, 'logged-out ID list me nahi aani chahiye');
  const shared = boot.body.accounts.find(a => a.key === 'acc_operator_used');
  assert.equal(shared.owner, 'operator');
  assert.equal(shared.canClaim, false);
  assert.equal(shared.canRemove, false);
  assert.equal(shared.phone, '', 'shared ID ka poora number user ko nahi');
  assert.match(shared.phoneMasked, /^98/);
  assert.equal(JSON.stringify(boot.body).includes('op-token-1'), false, 'token kabhi client ko nahi');

  const bossBoot = await req(boss, 'bootstrap');
  const bossRow = bossBoot.body.accounts.find(a => a.key === 'acc_operator_used');
  assert.equal(bossRow.owner, 'operator');
  assert.equal(bossRow.phone, '9876500001', 'boss ko poora number dikhta hai');
  assert.equal(bossRow.canClaim, true);
  assert.equal(bossRow.canRemove, true);
});

test('user ka apna ID kisi doosre user ko nahi dikhta', async () => {
  await req(user, 'accounts/import', { session: { mobile: '9333344444', token: 'private-token-1', tid: 't1' } });
  const mine = (await req(user, 'bootstrap')).body.accounts.filter(a => a.owner === 'self');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].phone, '9333344444');
  const othersView = (await req(other, 'bootstrap')).body.accounts;
  assert.equal(othersView.some(a => a.phone === '9333344444'), false);
  assert.equal(JSON.stringify(othersView).includes('private-token-1'), false);
  assert.equal((await req(other, 'accounts/select', { key: mine[0].key })).status, 404);
});

test('operator ka ID user remove nahi kar sakta; apna kar sakta hai', async () => {
  const blocked = await req(user, 'accounts/remove', { key: 'acc_operator_fresh' });
  assert.equal(blocked.status, 403);
  assert.ok(Object.prototype.hasOwnProperty.call(getDb().config.accounts, 'acc_operator_fresh'));
  const mine = (await req(user, 'bootstrap')).body.accounts.find(a => a.owner === 'self');
  const removed = await req(user, 'accounts/remove', { key: mine.key });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.accounts.some(a => a.owner === 'self'), false);
});

test('used ID pehle warning deti hai, confirm ke baad select hoti hai; expired band rehti hai', async () => {
  const denied = await req(user, 'accounts/select', { key: 'acc_operator_used' });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'ACCOUNT_NEEDS_CONFIRM');
  assert.match(denied.body.error, /order ho chuke/i);
  const confirmed = await req(user, 'accounts/select', { key: 'acc_operator_used', confirmUsed: true });
  assert.equal(confirmed.status, 200);
  assert.equal(readProWorkspace('9101').activeAccountKey, 'acc_operator_used');
  // Busy/expired ID confirm ke baad bhi nahi.
  const expired = await req(user, 'accounts/select', { key: 'acc_operator_expired', confirmUsed: true });
  assert.equal(expired.status, 404);
});

test('shared ID par saved address list kisi user ko nahi dikhti — boss ko dikhti hai', async () => {
  await req(user, 'accounts/select', { key: 'acc_operator_fresh', confirmUsed: true });
  const userView = await req(user, 'addresses');
  assert.equal(userView.status, 200);
  assert.equal(userView.body.addresses.length, 0);
  assert.match(userView.body.note, /apna address link se add/i);
  await req(boss, 'accounts/select', { key: 'acc_operator_fresh' });
  const bossView = await req(boss, 'addresses');
  assert.equal(bossView.status, 200);
  assert.equal(bossView.body.addresses.length, 1);
  assert.equal(bossView.body.addresses[0].address, receiver.address);
});

test('shared ID ke order user ko chhote card me, boss ko poore detail me; tracking user ko band', async () => {
  await req(user, 'accounts/select', { key: 'acc_operator_fresh', confirmUsed: true });
  const compact = await req(user, 'orders');
  assert.equal(compact.status, 200);
  assert.equal(compact.body.detailAllowed, false);
  assert.equal(compact.body.orders[0].id, '111111111111');
  assert.deepEqual(compact.body.orders[0].items, []);
  assert.equal(compact.body.orders[0].address, '');
  assert.equal(compact.body.orders[0].restricted, true);
  // Round 19 (boss): "TRACKING LINK BHI NAHI AARAHA" — shared ID par bhi
  // Swiggy ka tracking LINK milta hai; OTP/address/rider private rehta hai.
  const tracking = await req(user, 'orders/tracking?id=111111111111');
  assert.equal(tracking.status, 200);
  assert.equal(tracking.body.restricted, true);
  assert.equal(tracking.body.tracking.deliveryOtp, '');
  assert.equal(tracking.body.tracking.deliveryPartner.name, '');

  await req(boss, 'accounts/select', { key: 'acc_operator_fresh' });
  const full = await req(boss, 'orders');
  assert.equal(full.body.detailAllowed, true);
  assert.equal(full.body.orders[0].items.length, 1);
  assert.equal(full.body.orders[0].address, 'Secret address of operator');
});

test('bill breakdown Swiggy screenshot jaisa: lines ka jod To Pay ke barabar, bada farak saving me', async () => {
  seedCart(9101, 'mine');
  let out = await req(user, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  assert.equal(out.status, 200);
  let quote = out.body.cart.quote;
  assert.equal(quote.total, 335);
  assert.equal(quote.itemTotal, 274);
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.taxesAndCharges, 61.08);
  assert.equal(quote.otherCharges, 0);
  assert.equal(quote.mismatch, false);
  // 274 + 0 + 61.08 = 335.08 vs total 335 -> 0.08 ka rounding farak chhupa nahi.
  assert.equal(Math.abs((quote.itemTotal + quote.deliveryFee + quote.taxesAndCharges) - quote.total) < 0.5, true);

  billStates.mode = 'gap';
  out = await req(user, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  quote = out.body.cart.quote;
  assert.equal(quote.otherCharges, 14.92);
  assert.equal(Number((quote.taxesAndCharges + quote.itemTotal + quote.deliveryFee).toFixed(2)), quote.total);

  // Boss (31-10-2026): Swiggy ka total lines se kam ho to darawni warning
  // nahi — wahi asli saving hai, isliye unlistedDiscount me dikhti hai.
  billStates.mode = 'below';
  out = await req(user, 'cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  quote = out.body.cart.quote;
  assert.equal(quote.mismatch, false);
  assert.equal(quote.otherCharges, 0);
  assert.equal(quote.unlistedDiscount, 135.08);
  assert.equal(quote.total, 200);
  billStates.mode = 'exact';
});

test('apne ID par offer claim hota hai (naam badal ke do baar nahi), operator ke ID par band', async () => {
  await req(user, 'accounts/import', { session: { mobile: '9333344444', token: 'private-token-claim', tid: 't1' } });
  const mine = (await req(user, 'bootstrap')).body.accounts.find(a => a.owner === 'self');
  const claimed = await req(user, 'offers/claim', { key: mine.key });
  assert.equal(claimed.status, 200);
  const tracks = claimed.body.claim.tracks;
  assert.equal(tracks.length, 5);
  const byKey = Object.fromEntries(tracks.map(t => [t.key, t]));
  assert.equal(byKey.lateNight.status, 'CLAIMED');
  assert.equal(byKey.lateNight.verified, true);
  assert.equal(byKey.weekend.status, 'ALREADY_ACTIVE');
  assert.equal(claimCalls.length, 1);

  // Doosri baar wahi claim — "pehle se laga hua" hi kehta hai, naya claim nahi.
  const again = await req(user, 'offers/claim', { key: mine.key });
  assert.equal(again.status, 200);
  assert.equal(claimCalls.length, 2, 'dobara claim ki koshish provider tak gayi (read-back sach batata hai)');
  assert.equal(again.body.claim.tracks.find(t => t.key === 'lateNight').status, 'ALREADY_ACTIVE');

  const blocked = await req(user, 'offers/claim', { key: 'acc_operator_used' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'SHARED_ACCOUNT_RESTRICTED');
});

test('delete ke do raaste: database se (Swiggy ko haath nahi) aur Swiggy se (delete OTP)', async () => {
  await req(user, 'accounts/import', { session: { mobile: '9333355555', token: 'private-token-del', tid: 't2' } });
  const mine = (await req(user, 'bootstrap')).body.accounts.find(a => a.phone === '9333355555');
  const otpFlow = await req(user, 'accounts/remove', { key: mine.key, mode: 'swiggy' });
  assert.equal(otpFlow.status, 200);
  assert.equal(otpFlow.body.otpRequired, true);
  assert.equal(deleteCalls[0].step, 'request');
  assert.equal((await req(user, 'accounts/remove/confirm', { key: mine.key, otp: '000000' })).status, 400);
  const done = await req(user, 'accounts/remove/confirm', { key: mine.key, otp: '123456' });
  assert.equal(done.status, 200);
  assert.equal((await req(user, 'bootstrap')).body.accounts.some(a => a.phone === '9333355555'), false);

  await req(user, 'accounts/import', { session: { mobile: '9333366666', token: 'private-token-del2', tid: 't3' } });
  const second = (await req(user, 'bootstrap')).body.accounts.find(a => a.phone === '9333366666');
  const localOnly = await req(user, 'accounts/remove', { key: second.key });
  assert.equal(localOnly.status, 200);
  assert.equal(deleteCalls.filter(c => c.step === 'request').length, 1, 'local delete par Swiggy ko koi call nahi');
});

test('vault backup hooks maujood hain aur local file ko overwrite nahi karte', async () => {
  const store = fs.readFileSync(new URL('./swiggy-pro-store.js', import.meta.url), 'utf8');
  assert.match(store, /PRO_VAULT_CLOUD_BACKUP/);
  assert.match(store, /ensureProWorkspaceHydrated/);
  // Hydrate local file hone par chup-chaap skip karta hai.
  seedCart(9101, 'mine');
  assert.equal(await ensureProWorkspaceHydrated('9101'), false);
  assert.equal(readProWorkspace('9101').accounts.mine.phone, '9123456789');
});

// ── Client/CSS: boss ke visual + "bahar mat jao" + lazy load points ────────
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');

test('Mini App se koi bahar navigation nahi (koi browser link nahi)', () => {
  assert.equal(/openExternal/.test(appSource), false);
  assert.equal(/window\.open\(/.test(appSource), false);
  // Round 19 (boss): tracking LINK chahiye — par sirf Swiggy ka tracking page.
  // Baaki koi bahar link nahi (cart/account/Swiggy app nahi khulta).
  const externalLinks = [...appSource.matchAll(/href="\$\{esc\(([^)]*)\)\}"[^>]*target="_blank"/g)].map(m => m[1]);
  for (const expr of externalLinks) assert.match(expr, /swiggyLink/, `sirf tracking link bahar ja sakta hai, mila: ${expr}`);
  assert.equal(/href=\\?"https?:/.test(appSource), false, 'server se aaya link hi kholta hai, hardcoded nahi');
  assert.equal(/swiggy\.com\/cart/.test(appSource), false);
  assert.equal(/swiggy\.com\/my-account/.test(appSource), false);
  // Sirf UPI app kholna allowed hai — wo payment ka hissa hai.
  assert.equal(/upi:\/\//.test(appSource), false, 'UPI intent sirf server ke QR se aata hai');
});

test('used ID par in-app warning aur confirm ke baad select', () => {
  assert.match(appSource, /ACCOUNT_NEEDS_CONFIRM/);
  assert.match(appSource, /Ye ID pehle use ho chuki hai/);
  assert.match(appSource, /confirmUsed: true/);
});

test('lazy load + skeleton + phone par data bacha rehne wala cache', () => {
  assert.match(appSource, /loading="lazy" decoding="async"/);
  assert.match(appSource, /skeletonRows/);
  assert.match(appSource, /pro-state-v2/);
  assert.match(appSource, /cachedAccounts/);
  assert.match(cssSource, /skeleton-sweep/);
  assert.match(cssSource, /prefers-reduced-motion/);
});

test('text box ka mota outline gaya, saaf focus ring aaya', () => {
  assert.match(cssSource, /input:focus,\s*input:focus-visible[^}]*outline:\s*0/);
  assert.match(cssSource, /\.input-wrap:focus-within\s*\{[^}]*box-shadow/);
});

// ── DOM: bill + used warning sach me dikhte hain ─────────────────────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function waitFor(fn, label) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
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

const sharedAccount = { key: 'acc_operator_used', name: 'Operator used', phone: '', phoneMasked: '98••••0001', owner: 'operator', canClaim: false, canRemove: false, status: 'USED', selectable: false, needsConfirm: true, reason: 'Is ID par 4 order ho chuke hain', active: false, icons: '✔', freeCash: 0, offers: [] };
const ownAccount = { key: 'private_1', name: 'Mera', phone: '9123456789', phoneMasked: '', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, needsConfirm: false, active: true, icons: '★', freeCash: 50, offers: [] };
const billQuote = { total: 335, itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, taxesAndCharges: 61.08, discount: 0, otherCharges: 0, fetchedAt: '2026-10-31T00:00:00Z' };
function state(extra = {}) {
  return { ok: true, user: { name: 'Test', isBoss: false }, accounts: [ownAccount, sharedAccount], activeAccount: sharedAccount,
    selectedAddress: null, cart: { restaurantId: '1', restaurantName: 'R', forSomeoneElse: false, quote: billQuote, items: [{ lineKey: 'l', name: 'Meal', price: 274, qty: 1 }] },
    checkout: null, checkoutEnabled: true, ordersDetailAllowed: false, ...extra };
}

test('DOM: bill card me FREE delivery, GST & other charges aur To Pay dikhta hai', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? state() : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.body.textContent.includes('To Pay'), 'bill');
    const text = app.document.body.textContent;
    assert.match(text, /Bill Details/i);
    assert.match(text, /FREE/);
    assert.match(text, /GST & Other Charges/i);
    assert.match(text, /₹335/);
    assert.equal(/farak hai/.test(text), false, 'purana mismatch box wapas na aaye');
  } finally { app.close(); }
});

test('DOM: used ID par warning dialog, phir confirmUsed ke saath select', async () => {
  let selected = false;
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return state();
    if (call.url.endsWith('/accounts/select')) {
      if (call.body?.confirmUsed === true) { selected = true; return state({ accounts: [ownAccount, { ...sharedAccount, active: true }], activeAccount: sharedAccount }); }
      return { ok: false, code: 'ACCOUNT_NEEDS_CONFIRM', error: 'Is ID par 4 order ho chuke hain' };
    }
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-action="account-select"][data-key="acc_operator_used"]'), 'used row');
    app.document.querySelector('[data-action="account-select"][data-key="acc_operator_used"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'warning dialog');
    const text = app.document.querySelector('.confirm-dialog').textContent;
    assert.match(text, /Ye ID pehle use ho chuki hai/);
    assert.match(text, /4 order ho chuke/);
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => selected, 'confirmed select');
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).length, 2);
  } finally { app.close(); }
});

test('DOM: checkout page Swiggy jaisa — group cart, delivering to, coupon, bill, payment, Pay Now', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? state() : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.body.textContent.includes('Pay Now'), 'cart');
    const text = app.document.body.textContent;
    assert.match(text, /Add Items from Group Cart/);
    assert.match(text, /DELIVERING TO/i);
    assert.match(text, /Your Order/);
    assert.match(text, /Apply coupon/);
    assert.match(text, /Bill Details/i);
    assert.doesNotMatch(text, /Payment: UPI \/ QR|PAY USING UPI|Cash on Delivery/, 'redundant payment card stays hidden');
    assert.match(text, /Pay Now/);
    // Coupon page khulta hai — koi code type karne ka box nahi, sirf APPLY.
    assert.equal(app.document.querySelector('input[name="coupon"]'), null);
    app.document.querySelector('[data-action="toggle-coupon"]').click();
    await waitFor(() => app.document.querySelector('.coupon-tile, .coupon-input-card, .skeleton-list'), 'coupon page');
  } finally { app.close(); }
});

test('DOM: delete par do option — database ya Swiggy OTP', async () => {
  const removals = [];
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return state();
    if (call.url.endsWith('/accounts/remove')) {
      removals.push(call.body);
      if (call.body?.mode === 'swiggy') return { ok: true, otpRequired: true, key: call.body.key, phoneMasked: '91••••6789' };
      return state();
    }
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-action="account-remove"]'), 'remove button');
    app.document.querySelector('[data-action="account-remove"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'delete dialog');
    const labels = [...app.document.querySelectorAll('.confirm-dialog .confirm-actions button')].map(b => b.textContent);
    assert.ok(labels.includes('Database se hatao'), labels.join(','));
    assert.ok(labels.includes('Swiggy se delete'), labels.join(','));
    [...app.document.querySelectorAll('.confirm-dialog .confirm-actions button')].find(b => b.textContent === 'Swiggy se delete').click();
    await waitFor(() => app.document.querySelector('form[data-form="delete-otp"]'), 'delete otp form');
    assert.equal(removals.at(-1).mode, 'swiggy');
    assert.match(app.document.body.textContent, /Swiggy ne 91••••6789/);
  } finally { app.close(); }
});

test('DOM: account row par offer icons select/cut, Tools me claim button', async () => {
  const withOffers = state({
    accounts: [{ ...ownAccount, offerTracks: [
      { key: 'lateNight', label: 'Late night', emoji: '🌙', status: 'CLAIMED', verified: true, message: '' },
      { key: 'breakfast', label: 'Breakfast', emoji: '☀️', status: 'NOT_CLAIMED', verified: false, message: '' }
    ] }],
    activeAccount: ownAccount
  });
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? withOffers : withOffers) });
  try {
    await waitFor(() => app.document.querySelector('.offer-chip'), 'offer chips');
    assert.ok(app.document.querySelector('.offer-chip.on'), 'claimed icon selected');
    assert.ok(app.document.querySelector('.offer-chip.off'), 'unclaimed icon cut');
    app.document.querySelector('[data-action="nav"][data-tab="tools"]').click();
    await waitFor(() => app.document.querySelector('[data-action="claim-offers"]'), 'claim button');
  } finally { app.close(); }
});

test('DOM: menu ke andar dish search filter karta hai aur doosre outlet dikhte hain', async () => {
  const menu = { restaurant: { id: '1', name: 'R', area: 'Kothrud', isOpen: true }, categories: [{ title: 'All', items: [
    { id: '11', name: 'Paneer Pizza', price: 199, isVeg: true, description: '', image: '', inStock: true, customizable: false },
    { id: '12', name: 'Chicken Pizza', price: 249, isVeg: false, description: '', image: '', inStock: true, customizable: false }
  ] }] };
  const app = harness({ responder: call => {
    if (call.url.includes('/search?q=')) return { ok: true, restaurants: [
      { id: '1', name: 'R', area: 'Kothrud', distance: '1 km', time: '20 min', isOpen: true },
      { id: '2', name: 'R', area: 'Baner', distance: '4 km', time: '30 min', isOpen: true }
    ] };
    if (call.url.includes('/menu?id=')) return { ok: true, ...menu };
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="search"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="search"]'), 'search');
    const form = app.document.querySelector('form[data-form="search"]');
    form.querySelector('input[name="q"]').value = 'R';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('.restaurant-row'), 'results');
    assert.match(app.document.querySelector('.restaurant-row').textContent, /2 locations/);
    app.document.querySelector('.restaurant-row').click();
    await waitFor(() => app.document.querySelector('.sheet-overlay'), 'outlet sheet');
    app.document.querySelector('[data-sheet-outlet="2"]').click();
    await waitFor(() => app.document.querySelector('[data-input="menu-search"]'), 'menu');
    const search = app.document.querySelector('[data-input="menu-search"]');
    search.value = 'paneer';
    search.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    const visible = [...app.document.querySelectorAll('[data-menu-item]')].filter(row => !row.hidden);
    assert.equal(visible.length, 1);
    assert.match(visible[0].textContent, /Paneer Pizza/);
  } finally { app.close(); }
});
