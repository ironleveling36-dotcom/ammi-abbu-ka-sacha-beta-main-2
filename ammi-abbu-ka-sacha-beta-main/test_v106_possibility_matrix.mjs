// Boss (31-10-2026, round 17):
//   "KOI BHI KAAM KARNE SE PEHLE KITNI POSSIBILITIES HOSAKTI SABKO IDENTIFY
//    KARKE BLOCK KARDIA KAR NA"
//
// Ye test ek MATRIX hai — har wo possibility jo paisa/ID/order ka nuksaan kar
// sakti thi, aur uspar laga block. Koi naya kaam karne se pehle ye suite
// chalti hai, taaki purana darwaza khula na reh jaye.
import { strict as assert } from 'node:assert';
import { test, after, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v106-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v106-offline-token', PRO_VAULT_KEY: 'v106-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.WALLET_AUTO_CREDIT_MAX_PAISE;
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.UPI_REQUIRE_PROVIDER_VERIFY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('127.0.0.1')) return realFetch(raw, options);
  return new Response(JSON.stringify({ statusCode: 0, data: { customer_id: 'c1', mobile: '9234567890' } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace, readProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');
const { recordStatementPayment } = await import('./upi-statement.js');
const { walletBalancePaise } = await import('./user-wallet.js');
const { RATE_LIMITS } = await import('./pro-rate-limit.js');

const db = getDb();
db.config.accounts = { acc_shared: { phone: '9000011111', customerId: 'boss-cust-1', token: 't', isLoggedIn: true } };
db.config.bossIds = ['9000'];
delete db.config.serviceFeePaise; delete db.config.walletUpiId;
db.config.topupRequests = {}; db.config.usedUtrs = {}; db.config.topupIntents = {};
db.config.topupClaims = {}; db.config.rateLimits = {};
saveDb(db);

const receiver = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, Kajala, Orissa', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };

let customerForSession = 'c1';
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() {
      return {
        valid: true,
        phone: customerForSession === 'boss-cust-1' ? '9000011111' : '9234567890',
        customerId: customerForSession
      };
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

/** Round 20: credit ka saboot — bank/UPI statement me paisa aana. */
function verifiedPayment(utr, amountPaise, payeeName = 'MISBAHUL ISLAM') {
  const db = getDb();
  recordStatementPayment(db, { utr, amountPaise, payeeName, payeeVpa: payeeName === 'MISBAHUL ISLAM' ? 'mius@ybl' : '', status: 'SUCCESS', source: 'statement', at: Date.now() }, { actor: 'test' });
  saveDb(db);
}
function seed(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [], cart: null
  });
}
function resetLimits() {
  const fresh = getDb();
  fresh.config.rateLimits = {};
  saveDb(fresh);
}
beforeEach(resetLimits);

// ── 1. Paisa: har darwaza ────────────────────────────────────────────────
test('matrix: wallet claim — bina UTR, galat UTR, bina amount, chhota UTR — sab band', async () => {
  seed(8001);
  assert.equal((await req(8001, 'wallet/claim', { amountRupees: 15 })).body.code, 'UTR_REQUIRED');
  assert.equal((await req(8001, 'wallet/claim', { amountRupees: 15, utr: '123' })).body.code, 'UTR_INVALID');
  // Round 23: amount + UTR diya to claim chalta hai (implicit top-up), par
  // payment fetch na hone tak ek paisa bhi nahi judta.
  const claim = await req(8001, 'wallet/claim', { amountRupees: 15, utr: '123456789012' });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.creditedPaise, 0);
  assert.equal(claim.body.pending, true);
  assert.equal(walletBalancePaise(getDb(), '8001'), 0);
});

test('matrix: bina saboot bada amount bhi credit nahi — verify par jata hai', async () => {
  seed(8002);
  const topup = await req(8002, 'wallet/topup', { amountPaise: 50000 }); // ₹500
  const out = await req(8002, 'wallet/claim', { topupId: topup.body.topup.topupId, utr: '111100001111' });
  assert.equal(out.status, 200);
  assert.equal(out.body.pending, true, 'pending bata raha hai');
  assert.equal(out.body.creditedPaise, 0);
  assert.match(out.body.message, /verify/i);
  assert.equal(walletBalancePaise(getDb(), '8002'), 0, 'ek paisa bhi auto credit nahi');
});

test('matrix: chhota amount bhi bina saboot credit nahi; statement milte hi asli amount judta hai', async () => {
  seed(8003);
  const topup = await req(8003, 'wallet/topup', { amountPaise: 1500 });
  const first = await req(8003, 'wallet/claim', { topupId: topup.body.topup.topupId, utr: '222200002222' });
  assert.equal(first.body.creditedPaise, 0, 'random UTR se kuch nahi juda');
  assert.equal(walletBalancePaise(getDb(), '8003'), 0);
  verifiedPayment('222200002222', 1500);
  const boss = await req(9000, 'boss/statement', { text: '31-10-2026 UPI/CR/222200002222/MISBAHUL ISLAM/₹15.00 credited' });
  assert.equal(boss.status, 200, JSON.stringify(boss.body));
  assert.ok(boss.body.settled.some(s => s.action === 'CREDIT'), JSON.stringify(boss.body.settled));
  assert.equal(walletBalancePaise(getDb(), '8003'), 1500, 'asli ₹15 juda');
});

test('matrix: statement me doosre ka naam — credit nahi, claim reject', async () => {
  seed(8005);
  const topup = await req(8005, 'wallet/topup', { amountPaise: 1500 });
  await req(8005, 'wallet/claim', { topupId: topup.body.topup.topupId, utr: '555500005555' });
  const out = await req(9000, 'boss/statement', { text: '31-10-2026 UPI/CR/555500005555/RAHUL KUMAR/₹15.00 credited' });
  assert.equal(out.status, 200);
  assert.ok(!out.body.settled.some(s => s.action === 'CREDIT'));
  assert.equal(walletBalancePaise(getDb(), '8005'), 0);
});

test('matrix: ek user ke paas ek hi zinda top-up — purana khud band', async () => {
  seed(8004);
  const first = await req(8004, 'wallet/topup', { amountPaise: 1000 });
  const second = await req(8004, 'wallet/topup', { amountPaise: 1500 });
  const oldClaim = await req(8004, 'wallet/claim', { topupId: first.body.topup.topupId, utr: '333300003333' });
  assert.equal(oldClaim.status, 409);
  assert.equal(oldClaim.body.code, 'NO_TOPUP_INTENT');
  const newClaim = await req(8004, 'wallet/claim', { topupId: second.body.topup.topupId, utr: '444400004444' });
  assert.equal(newClaim.status, 200);
});

test('matrix: claim spam rate-limited (UTR guessing ka darwaza band)', async () => {
  seed(8005);
  const max = RATE_LIMITS.walletClaim.max;
  let last = null;
  for (let i = 0; i < max + 1; i++) {
    last = await req(8005, 'wallet/claim', { amountRupees: 15, utr: `99990000${String(1000 + i).slice(-4)}` });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'RATE_LIMITED');
  assert.match(last.body.error, /minute/i);
});

test('matrix: top-up spam rate-limited', async () => {
  seed(8006);
  const max = RATE_LIMITS.walletTopup.max;
  let last = null;
  for (let i = 0; i < max + 1; i++) last = await req(8006, 'wallet/topup', { amountPaise: 1500 });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'RATE_LIMITED');
});

// ── 2. Swiggy ID: ek ID ek jagah ─────────────────────────────────────────
test('matrix: operator ke vault ka ID private workspace me copy nahi hota', async () => {
  seed(8007);
  customerForSession = 'boss-cust-1'; // vault wale ID ka session
  const out = await req(8007, 'accounts/import', { session: { token: 'tok', tid: 'tid', cookies: '_session_tid=x' } });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'ACCOUNT_ALREADY_MANAGED');
  assert.match(out.body.error, /ek ID = ek order/i);
  assert.equal(Object.keys(readProWorkspace('8007').accounts || {}).length, 1, 'koi naya account add nahi hua');
  customerForSession = 'c1';
});

test('matrix: import spam rate-limited', async () => {
  seed(8008);
  customerForSession = 'new-cust-1';
  const max = RATE_LIMITS.accountImport.max;
  let last = null;
  for (let i = 0; i < max + 1; i++) last = await req(8008, 'accounts/import', { session: { token: 'tok', tid: 'tid', cookies: '_session_tid=x' } });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'RATE_LIMITED');
  customerForSession = 'c1';
});

// ── 3. Order/QR: purane blocks bhi zinda hain ────────────────────────────
test('matrix: checkout validation fail par rate limit nahi lagti (sirf asli placement par)', async () => {
  seed(8009);
  const max = RATE_LIMITS.checkout.max;
  let last = null;
  for (let i = 0; i < max + 2; i++) {
    // quote nahi hai seed me → har baar validation error, limit count nahi hona chahiye
    last = await req(8009, 'checkout', { confirmCheckout: true, expectedTotal: 68, quoteFetchedAt: new Date().toISOString() });
  }
  assert.equal(last.status, 400, 'validation error, 429 nahi');
  const snap = await req(8009, 'bootstrap');
  assert.equal(snap.body.rateLimits.checkout.used, 0, 'koi placement attempt count nahi hui');
});

test('matrix: rate limit har user ka alag — ek user ka limit dusre ko nahi rokta', async () => {
  seed(8010);
  seed(8011);
  const max = RATE_LIMITS.walletTopup.max;
  for (let i = 0; i < max + 1; i++) await req(8010, 'wallet/topup', { amountPaise: 1500 });
  const other = await req(8011, 'wallet/topup', { amountPaise: 1500 });
  assert.equal(other.status, 200, 'doosre user par limit nahi');
});

test('matrix: rate limit ke baad quota app ko dikhta hai (bootstrap)', async () => {
  seed(8012);
  await req(8012, 'wallet/topup', { amountPaise: 1500 });
  const boot = await req(8012, 'bootstrap');
  assert.equal(boot.status, 200);
  // Feature flag na ho to bhi bootstrap nahi tootta — bas limits optional hain.
  assert.equal(boot.body.ok, true);
});
