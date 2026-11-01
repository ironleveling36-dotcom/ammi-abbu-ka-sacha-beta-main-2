// Boss (31-10-2026, round 23):
//   "YE UTR SE PAYMENT DETAILES KE LIYE JO KRNA HAI WO KAR AND BAS USER KO BOL
//    SEND HOW MUCH MONEY YOU WANT THAT WILL BE FETCHED AND ADDED UPON
//    SUBMITTING UTR"
//
// Yani: user sirf batata hai kitna paisa bhejna hai + UTR. Server us UTR ki
// asli payment details fetch karta hai (amount/payee/status) aur **jitna aaya
// utna hi** credit karta hai — user ka likha amount credit nahi hota.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v112-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v112-offline-token', PRO_VAULT_KEY: 'v112-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.UPI_UTR_LOOKUP_URL;

const { parseUtrLookup, fetchUtrPaymentDetails, describeLookup } = await import('./utr-lookup.js');
const { getDb, saveDb } = await import('./store.js');
const { walletBalancePaise, listTopupRequests } = await import('./user-wallet.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace } = await import('./swiggy-pro-store.js');

const db0 = getDb();
db0.config.accounts = {}; db0.config.bossIds = ['9000'];
db0.config.wallets = {}; db0.config.usedUtrs = {}; db0.config.topupRequests = {}; db0.config.topupIntents = {};
db0.config.walletUpiId = 'mius@ybl'; db0.config.serviceFeePaise = 1500;
saveDb(db0);

// ── 1. Provider ka jawab parsinng (har shape) ─────────────────────────────
test('lookup: paise wala amount (amountPaise) sahi samjha jata hai', () => {
  const out = parseUtrLookup({ verified: true, utr: '123456789012', amountPaise: 1250, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS' }, { expectUtr: '123456789012' });
  assert.equal(out.found, true);
  assert.equal(out.payment.amountPaise, 1250);
  assert.equal(out.payment.payeeName, 'MISBAHUL ISLAM');
});

test('lookup: rupees wala amount (nested data.payment) sahi samjha jata hai', () => {
  const out = parseUtrLookup({
    data: { payment: { utr: '987654321012', amount: '20.00', payeeVpa: 'mius@ybl', txnStatus: 'SUCCESS' } }
  }, { expectUtr: '987654321012' });
  assert.equal(out.found, true);
  assert.equal(out.payment.amountPaise, 2000);
  assert.equal(out.payment.payeeVpa, 'mius@ybl');
});

test('lookup: doosre UTR ka jawab match nahi karta to found false', () => {
  const out = parseUtrLookup({ utr: '111111111111', amountPaise: 1500, status: 'SUCCESS' }, { expectUtr: '222222222222' });
  assert.equal(out.found, false);
});

test('lookup: failed payment ka status saaf aata hai', () => {
  const out = parseUtrLookup({ utr: '333333333333', amount: 15, status: 'FAILED' }, { expectUtr: '333333333333' });
  assert.equal(out.found, true);
  assert.equal(out.payment.status, 'FAILED');
});

test('lookup: amount hi nahi diya to found false (bina amount credit nahi)', () => {
  const out = parseUtrLookup({ utr: '444444444444', status: 'SUCCESS' }, { expectUtr: '444444444444' });
  assert.equal(out.found, false);
  assert.match(out.reason, /amount/i);
});

test('lookup: provider set nahi to saaf wajah, jhootha verified nahi', async () => {
  const out = await fetchUtrPaymentDetails('555555555555');
  assert.equal(out.configured, false);
  assert.equal(out.found, false);
  assert.match(out.reason, /UPI_UTR_LOOKUP_URL|UPI_UTR_VERIFY_URL/);
  assert.match(describeLookup(out, { utr: '555555555555' }), /set nahi/i);
});

// ── 2. Asli provider server (fake) ────────────────────────────────────────
const providerPayments = new Map();   // utr -> payment shape
let lookupCalls = 0;
const providerServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let utr = '';
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { utr = String(JSON.parse(body || '{}').utr || ''); } catch { utr = ''; }
  } else {
    utr = String(url.searchParams.get('utr') || '');
  }
  lookupCalls += 1;
  const payment = providerPayments.get(utr);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payment ? { ok: true, data: { payment } } : { ok: false, message: 'UTR not found' }));
});
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r));
process.env.UPI_UTR_LOOKUP_URL = `http://127.0.0.1:${providerServer.address().port}/lookup`;

const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true, phone: '9000011111' }; },
    async orders() { return []; },
    async tracking() { return {}; },
    async checkPayment() { return { paid: false, paymentVerified: false }; }
  };
  if (!await handleSwiggyProHttp(req, res, {
    provider, claim: async () => ({}),
    otp: { request: async () => ({}), verify: async () => ({}) },
    deleteOtp: { request: async () => ({}), verify: async () => ({}) },
    authorizeUser: async () => ({ allowed: true })
  })) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => providerServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

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
function seed(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: null, addressCandidates: [], cart: null
  });
}

test('claim: user ₹20 bhejta hai, UTR fetch hui ₹12.50 — sirf ₹12.50 judta hai', async () => {
  seed(7401);
  providerPayments.set('600600600601', { utr: '600600600601', amount: 12.5, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl', status: 'SUCCESS' });
  const out = await req(7401, 'wallet/claim', { amountRupees: 20, utr: '600600600601' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.creditedPaise, 1250);
  assert.equal(out.body.pending, false);
  assert.equal(walletBalancePaise(getDb(), '7401'), 1250);
  assert.match(out.body.message, /fetch/i);
});

test('claim: UTR ki payment nahi mili — kuch nahi judta, wajah saaf', async () => {
  seed(7402);
  const out = await req(7402, 'wallet/claim', { amountRupees: 15, utr: '600600600602' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.creditedPaise, 0);
  assert.equal(out.body.pending, true);
  assert.match(out.body.message, /nahi mili|not found|verify/i);
  assert.equal(walletBalancePaise(getDb(), '7402'), 0);
});

test('claim: provider me payee boss ka nahi — credit nahi, wajah naam ke saath', async () => {
  seed(7403);
  providerPayments.set('600600600603', { utr: '600600600603', amount: 15, payeeName: 'RAHUL KUMAR', status: 'SUCCESS' });
  const out = await req(7403, 'wallet/claim', { amountRupees: 15, utr: '600600600603' });
  assert.equal(out.status >= 400, true, JSON.stringify(out.body));
  assert.match(String(out.body.error || ''), /RAHUL KUMAR|boss/i);
  assert.equal(walletBalancePaise(getDb(), '7403'), 0);
});

test('claim: wahi UTR dobara — 409, double credit nahi', async () => {
  seed(7404);
  providerPayments.set('600600600604', { utr: '600600600604', amount: 15, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS' });
  const first = await req(7404, 'wallet/claim', { amountRupees: 15, utr: '600600600604' });
  assert.equal(first.body.creditedPaise, 1500);
  const again = await req(7404, 'wallet/claim', { amountRupees: 15, utr: '600600600604' });
  assert.equal(again.status, 409);
  assert.equal(walletBalancePaise(getDb(), '7404'), 1500);
});

test('claim: pehle pending tha, ab provider me paisa aa gaya — khud set ho jata hai', async () => {
  seed(7405);
  const first = await req(7405, 'wallet/claim', { amountRupees: 15, utr: '600600600605' });
  assert.equal(first.body.pending, true);
  assert.equal(walletBalancePaise(getDb(), '7405'), 0);
  // Provider me paisa aa gaya (jaise bank ne baad me confirm kiya).
  providerPayments.set('600600600605', { utr: '600600600605', amount: 15, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS' });
  // Agli claim (kisi bhi user ki) par pending claims dobara fetch hote hain.
  seed(7406);
  const pending = listTopupRequests(getDb(), { status: 'PENDING', limit: 5 });
  assert.ok(pending.some((r) => r.utr === '600600600605'));
  await req(7406, 'wallet/claim', { amountRupees: 15, utr: '600600600606' });
  // retry background me chalta hai — thoda intezaar.
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000 && walletBalancePaise(getDb(), '7405') === 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(walletBalancePaise(getDb(), '7405'), 1500, 'pending claim baad me khud settle hua');
  assert.ok(lookupCalls >= 3);
});

// ── 3. DOM: form me "kitna paisa bhejna hai" + UTR ────────────────────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

test('DOM: cart me wallet recharge form nahi, Swiggy checkout retained', async () => {
  const receiver = { id: 'addr-1', name: 'T', mobile: '7978459775', address: 'Kajala', lat: '20.2', lng: '84.7' };
  const state = {
    ok: true, user: { name: 'T', isBoss: false }, orderFee: { paise: 1500, exempt: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver, selectedAddresses: [receiver],
    checkoutEnabled: true, ordersDetailAllowed: true,
    cart: { restaurantId: '201', restaurantName: 'Biryani', items: [{ lineKey: 'l', name: 'Biryani', price: 68, qty: 1 }], quote: { total: 68, fetchedAt: new Date().toISOString(), itemTotal: 68 } }
  };
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  const calls = [];
  window.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => state }; };
  window.eval(appSource);
  try {
    const started = Date.now();
    while (!window.document.querySelector('[data-tab="cart"]:not([disabled])') && Date.now() - started < 5000) await new Promise(r => setTimeout(r, 20));
    const tab = window.document.querySelector('[data-tab="cart"]:not([disabled])');
    assert.ok(tab, 'navigation ready');
    tab.click();
    assert.equal(window.document.querySelector('form[data-form="wallet-claim"]'), null);
    assert.equal(window.document.querySelector('input[name="utr"]'), null);
    assert.ok(window.document.querySelector('[data-action="checkout-start"]'), 'Swiggy checkout retained');
    assert.ok(!calls.some(url => /wallet\//.test(url)), 'Mini App does not load wallet API');
  } finally { window.close(); }
});
