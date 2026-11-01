// Boss (31-10-2026, round 16):
//   "DUSRE KA UTR BHI AGAR KOI DAAL RAHA TO USSE PAYMENT LE LE RHA"
//   "JITNA BOL RAHA"  ·  "SAME UTR BAAR BAAR USE KAR PAA RAHA"
//   "ORDER KA QR TO AAAHI NAHI RAHA"
//
// Yahan teeno ka sach test hota hai:
//   • UTR ke bina credit nahi, ek UTR globally ek hi baar (prune ke baad bhi)
//   • credit sirf utne ka jitne ka top-up QR bana tha (user jo likhe us par nahi)
//   • Swiggy ke `am` + `amount` wale intent par QR block nahi hota
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v105-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v105-offline-token', PRO_VAULT_KEY: 'v105-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.PRO_ENABLE_CHECKOUT;
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.UPI_REQUIRE_PROVIDER_VERIFY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('127.0.0.1')) return realFetch(raw, options);
  return new Response(JSON.stringify({ statusCode: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');
const { walletBalancePaise } = await import('./user-wallet.js');
const { recordStatementPayment } = await import('./upi-statement.js');
const { validateUpiIntentForQr } = await import('./payment-qr-guard.js');

const db = getDb();
db.config.accounts = {}; db.config.bossIds = ['9000'];
delete db.config.serviceFeePaise; delete db.config.walletUpiId;
db.config.topupRequests = {}; db.config.usedUtrs = {}; db.config.topupIntents = {}; db.config.topupClaims = {};
saveDb(db);

const receiver = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, Kajala, Maradpur, Odisha', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };

const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true, phone: '9234567890', customerId: 'c1' }; },
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
after(async () => { await new Promise(resolve => server.close(resolve)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

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
/**
 * Round 20 (boss): bina asli payment sabooot ke credit nahi hota. Purane tests
 * ka matlab wahi hai (amount rules), isliye pehle bank/UPI statement me wahi
 * payment likh dete hain — jaise asli zindagi me paisa pehle aata hai.
 */
function verifiedPayment(utr, amountPaise) {
  const db = getDb();
  recordStatementPayment(db, { utr, amountPaise, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl', status: 'SUCCESS', source: 'statement', at: Date.now() }, { actor: 'test' });
  saveDb(db);
}
function seed(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [], cart: null
  });
}

// ── 1. UTR ke bina credit bilkul nahi ─────────────────────────────────────
test('wallet: UTR ke bina claim credit nahi karta (asli wajah ke saath)', async () => {
  seed(7101);
  const out = await req(7101, 'wallet/claim', { amountRupees: 15 });
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'UTR_REQUIRED');
  assert.match(out.body.error, /UTR/i);
  assert.equal(walletBalancePaise(getDb(), '7101'), 0, 'ek paisa bhi credit nahi');
});

test('wallet: galat format ka UTR reject', async () => {
  seed(7102);
  const out = await req(7102, 'wallet/claim', { amountRupees: 15, utr: '12345' });
  assert.equal(out.status, 400);
  assert.equal(walletBalancePaise(getDb(), '7102'), 0);
});

// ── 2. Credit sirf asli (fetched) payment par ─────────────────────────────
test('wallet: bina amount aur bina top-up ke claim nahi hota', async () => {
  seed(7103);
  const out = await req(7103, 'wallet/claim', { utr: '111122223333' });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'NO_TOPUP_INTENT');
  assert.equal(walletBalancePaise(getDb(), '7103'), 0);
});

// Round 23 (boss): user khud batata hai kitna paisa bhejna hai — bina QR ke
// bhi claim chalta hai, par paisa sirf tab judta hai jab UTR se payment mile.
test('wallet: "kitna paisa bhejna hai" + UTR — bina payment proof credit nahi', async () => {
  seed(7111);
  const out = await req(7111, 'wallet/claim', { amountRupees: 20, utr: '111122229999' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.pending, true);
  assert.equal(out.body.creditedPaise, 0);
  assert.equal(walletBalancePaise(getDb(), '7111'), 0);
  assert.match(out.body.message, /jitna paisa sach me aayega/i);
});

test('wallet: top-up ₹15 ka tha, user ₹15 likhe → ₹15 hi judta hai', async () => {
  seed(7104);
  const topup = await req(7104, 'wallet/topup', { amountPaise: 1500 });
  assert.equal(topup.status, 200);
  assert.ok(topup.body.topup.topupId, 'topupId mila');
  assert.equal(String(topup.body.topup.amount), '15');
  verifiedPayment('222233334444', 1500);
  const out = await req(7104, 'wallet/claim', { topupId: topup.body.topup.topupId, amountRupees: 15, utr: '222233334444' });
  assert.equal(out.status, 200);
  assert.equal(walletBalancePaise(getDb(), '7104'), 1500);
});

test('wallet: "jitna bol raha" band — ₹15 ka top-up par ₹500 ka dawa reject', async () => {
  seed(7105);
  const topup = await req(7105, 'wallet/topup', { amountPaise: 1500 });
  const out = await req(7105, 'wallet/claim', { topupId: topup.body.topup.topupId, amountRupees: 500, utr: '333344445555' });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'TOPUP_AMOUNT_MISMATCH');
  assert.match(out.body.error, /₹15/);
  assert.match(out.body.error, /₹500/);
  assert.equal(walletBalancePaise(getDb(), '7105'), 0, 'kuch credit nahi');
});

test('wallet: amount body me na ho to bhi sirf top-up ka amount judta hai', async () => {
  seed(7106);
  const topup = await req(7106, 'wallet/topup', { amountPaise: 1000 });
  verifiedPayment('444455556666', 1000);
  const out = await req(7106, 'wallet/claim', { topupId: topup.body.topup.topupId, utr: '444455556666' });
  assert.equal(out.status, 200);
  assert.equal(walletBalancePaise(getDb(), '7106'), 1000, 'top-up ka amount, body ka nahi');
});

// ── 3. Same UTR dobara — prune ke baad bhi ────────────────────────────────
test('wallet: same UTR dobara nahi (records prune hone ke baad bhi)', async () => {
  seed(7107);
  const first = await req(7107, 'wallet/topup', { amountPaise: 1500 });
  verifiedPayment('555566667777', 1500);
  const ok = await req(7107, 'wallet/claim', { topupId: first.body.topup.topupId, amountPaise: 1500, utr: '555566667777' });
  assert.equal(ok.status, 200);
  // Purane top-up records saaf kar do (pipeline ka prune) — UTR ki yaad nahi mitni chahiye.
  const prune = getDb(); prune.config.topupRequests = {}; saveDb(prune);
  const second = await req(7107, 'wallet/topup', { amountPaise: 1500 });
  const again = await req(7107, 'wallet/claim', { topupId: second.body.topup.topupId, amountPaise: 1500, utr: '555566667777' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'DUPLICATE_UTR');
  assert.equal(walletBalancePaise(getDb(), '7107'), 1500, 'dobara credit nahi');
});

test('wallet: kisi aur ka UTR daalne par credit nahi (aur wajah saaf)', async () => {
  seed(7108);
  seed(7109);
  const a = await req(7108, 'wallet/topup', { amountPaise: 1500 });
  verifiedPayment('666677778888', 1500);
  assert.equal((await req(7108, 'wallet/claim', { topupId: a.body.topup.topupId, amountPaise: 1500, utr: '666677778888' })).status, 200);
  const b = await req(7109, 'wallet/topup', { amountPaise: 1500 });
  const steal = await req(7109, 'wallet/claim', { topupId: b.body.topup.topupId, amountPaise: 1500, utr: '666677778888' });
  assert.equal(steal.status, 409);
  assert.equal(steal.body.code, 'DUPLICATE_UTR');
  assert.match(steal.body.error, /kisi aur/i);
  assert.equal(walletBalancePaise(getDb(), '7109'), 0);
});

test('wallet: top-up intent ek hi baar chalta hai', async () => {
  seed(7110);
  const topup = await req(7110, 'wallet/topup', { amountPaise: 1500 });
  verifiedPayment('777788889999', 1500);
  assert.equal((await req(7110, 'wallet/claim', { topupId: topup.body.topup.topupId, amountPaise: 1500, utr: '777788889999' })).status, 200);
  const reuse = await req(7110, 'wallet/claim', { topupId: topup.body.topup.topupId, amountPaise: 1500, utr: '888899990000' });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.code, 'NO_TOPUP_INTENT');
  assert.equal(walletBalancePaise(getDb(), '7110'), 1500);
});

// ── 4. QR: `am` + alag `amount` wala asli Swiggy shape ────────────────────
test('qr: Swiggy ke `am` + `amount` (value alag) par QR block nahi hota', () => {
  const check = validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&am=48.00&amount=68.00&cu=INR&tr=2525267', { amount: 48 });
  assert.equal(check.valid, true, check.problems.join(' | '));
  assert.ok(!/amount=/.test(check.info.uri), 'QR me stray `amount` nahi');
});

test('qr: `am` galat par `amount` bill se match kare to bill wala amount chunte hain', () => {
  const check = validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&am=68.00&amount=48.00&cu=INR', { amount: 48 });
  assert.equal(check.valid, true, check.problems.join(' | '));
  assert.match(check.info.uri, /am=48\.00/);
  assert.ok(!/amount=/.test(check.info.uri));
  assert.equal(check.info.amount, 48);
});

test('qr: dono amount bill se alag → block, par asli wajah', () => {
  const check = validateUpiIntentForQr('upi://pay?pa=upiswiggy@icici&am=68.00&amount=58.00&cu=INR', { amount: 48 });
  assert.equal(check.valid, false);
  assert.match(check.problems.join(' '), /₹68.*₹48|₹58.*₹48/);
});

// ── 5. App: claim form me amount box nahi, UTR zaroori ────────────────────
// Round 23 (boss): "SEND HOW MUCH MONEY YOU WANT ... FETCHED AND ADDED UPON
// SUBMITTING UTR" — form me ab amount box hai (purana "amount input nahi" rule
// boss ne khud badal diya), aur button bina top-up QR ke bhi chalta hai.
test('DOM: wallet claim form me amount + UTR dono, button pehle se chalu', async () => {
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  const state = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver, selectedAddresses: [receiver],
    checkoutEnabled: true, ordersDetailAllowed: true,
    cart: { restaurantId: '201', restaurantName: 'Biryani', items: [{ lineKey: 'l', name: 'Biryani', price: 68, qty: 1 }], quote: { total: 68, fetchedAt: new Date().toISOString(), itemTotal: 68 } },
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [{ paise: 1500, rupees: '15' }], history: [] }
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
    // Khaali wallet par sheet apne aap khulti hai — warna button se kholo.
    const form = await waitFor(() => window.document.querySelector('form[data-form="wallet-claim"]'), 'claim form');
    const amount = form.querySelector('input[name="amount"]');
    assert.ok(amount, 'amount input hai (kitna paisa bhejna hai)');
    assert.ok(form.querySelector('input[name="utr"]'), 'UTR input hai');
    assert.match(form.textContent, /12-digit UTR/i);
    assert.match(form.textContent, /jitna paisa sach me aaya utna hi/i);
    assert.equal(form.textContent.includes('Pehle upar se top-up khol'), false, 'ab top-up QR zaroori nahi');
    assert.equal(form.querySelector('button[type="submit"]').disabled, false, 'button chalu hai');
  } finally { window.close(); }
});
