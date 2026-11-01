// Boss (31-10-2026, round 20):
//   "JAB CHOTA AMOUNT DAAL KAR RANDOM KOI BHI UTR DAALTA WO ADD HO JATA ...
//    AISA KARNA CHAHIE KI UTR PAR JITNA AMOUNT JAYE AGAR WO MISBAHUL ISLAM HO
//    UTNA ADD HOJAYE"
//
// Yani: wallet me credit sirf tab jab paisa SACH ME Misbahul Islam ke account me
// aaya ho — aur jitna aaya utna hi. Random UTR, galat payee, chhota amount,
// duplicate UTR — sab band, har case par asli wajah.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v109-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v109-offline-token', PRO_VAULT_KEY: 'v109-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.WALLET_AUTO_CREDIT_MAX_PAISE;

const { getDb, saveDb } = await import('./store.js');
const { walletBalancePaise, listTopupRequests } = await import('./user-wallet.js');
const { evaluateUtrCredit, parseStatementText, isBossPayee, normalizePersonName } = await import('./upi-credit-policy.js');
const { recordStatementPayment, findStatementPayment, statementStatus, importStatementText } = await import('./upi-statement.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');

// ── setup: boss + ek normal user ─────────────────────────────────────────
const db = getDb();
db.config.accounts = {};
db.config.bossIds = ['9000'];
db.config.wallets = {};
db.config.usedUtrs = {};
db.config.topupRequests = {};
db.config.topupIntents = {};
db.config.topupClaims = {};
db.config.walletUpiId = 'mius@ybl';
db.config.serviceFeePaise = 1500;
saveDb(db);

// ── 1. pure policy: payee ────────────────────────────────────────────────
test('payee: Misbahul Islam ke spelling variants chalte hain, doosre nahi', () => {
  assert.equal(isBossPayee({ name: 'MISBAHUL ISLAM' }).ok, true);
  assert.equal(isBossPayee({ name: 'Md Misbahul Islam' }).ok, true);
  assert.equal(isBossPayee({ name: 'MISBAHUL  ISLAM ' }).ok, true);
  assert.equal(isBossPayee({ vpa: 'MIUS@YBL' }).ok, true);
  assert.equal(isBossPayee({ name: 'RAHUL KUMAR' }).ok, false);
  assert.equal(isBossPayee({ name: '' }).ok, false);
  assert.equal(normalizePersonName('  md.  misbahul-islam '), 'MD MISBAHUL ISLAM');
});

test('policy: bina payment sabooot ke credit NAHI (random UTR yahin rukta hai)', () => {
  const out = evaluateUtrCredit({ claim: { utr: '111122223333', claimedPaise: 1500 }, payment: null });
  assert.equal(out.action, 'PENDING');
  assert.equal(out.creditedPaise, 0);
  assert.match(out.reason, /statement me nahi mila/i);
});

test('policy: credit = asli aaya amount, claim ka nahi', () => {
  const out = evaluateUtrCredit({
    claim: { utr: '222233334444', claimedPaise: 5000 },
    payment: { utr: '222233334444', amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS', source: 'statement', at: Date.now() }
  });
  assert.equal(out.action, 'CREDIT');
  assert.equal(out.creditedPaise, 1500);
});

test('policy: galat payee / failed / kam amount / duplicate — sab block', () => {
  const base = { amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS', at: Date.now() };
  assert.equal(evaluateUtrCredit({ claim: { utr: '333344445555', claimedPaise: 1500 }, payment: { ...base, utr: '333344445555', payeeName: 'RAHUL KUMAR' } }).code, 'PAYEE_MISMATCH');
  assert.equal(evaluateUtrCredit({ claim: { utr: '333344445556', claimedPaise: 1500 }, payment: { ...base, utr: '333344445556', status: 'FAILED' } }).code, 'PAYMENT_NOT_SUCCESSFUL');
  assert.equal(evaluateUtrCredit({ claim: { utr: '333344445557', claimedPaise: 1500 }, payment: { ...base, utr: '333344445557', amountPaise: 50 } }).code, 'AMOUNT_TOO_LOW');
  assert.equal(evaluateUtrCredit({ claim: { utr: '333344445558', claimedPaise: 1500 }, payment: { ...base, utr: '333344445558' }, usedUtrs: { '333344445558': { userId: '1' } } }).code, 'UTR_ALREADY_USED');
  assert.equal(evaluateUtrCredit({ claim: { utr: '333344445559', claimedPaise: 1500 }, payment: { ...base, utr: '999999999999' } }).code, 'UTR_MISMATCH');
});

test('policy: top-up QR se purana payment is top-up ka nahi', () => {
  const now = Date.now();
  const out = evaluateUtrCredit({
    claim: { utr: '444455556666', claimedPaise: 1500 },
    intent: { amountPaise: 1500, createdAt: now },
    payment: { utr: '444455556666', amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS', at: now - 60 * 60_000 }
  });
  assert.equal(out.action, 'PENDING');
  assert.equal(out.code, 'PAYMENT_BEFORE_INTENT');
});

test('statement parser: credit line milti hai, debit/failed nahi', () => {
  const text = [
    '31-10-2026 UPI/CR/123456789012/MISBAHUL ISLAM/₹15.00 credited to your account',
    '31-10-2026 UPI/DR/999888777666/RAHUL/₹500.00 debited from account',
    '30-10-2026 UPI/CR/555666777888 FAILED ₹20.00',
    'random line without any utr'
  ].join('\n');
  const parsed = parseStatementText(text);
  assert.equal(parsed.length, 1, JSON.stringify(parsed));
  assert.equal(parsed[0].utr, '123456789012');
  assert.equal(parsed[0].amountPaise, 1500);
  assert.match(parsed[0].payeeName || '', /MISBAHUL/i);
});

// ── 2. API: asli flow ────────────────────────────────────────────────────
let trackingCalls = 0;
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true, phone: '9000011111' }; },
    async orders() { return []; },
    async tracking() { trackingCalls += 1; return {}; },
    async checkPayment() { return { paid: false, paymentVerified: false }; }
  };
  if (!await handleSwiggyProHttp(req, res, {
    provider, claim: async () => ({}),
    otp: { request: async () => ({}), verify: async () => ({}) },
    deleteOtp: { request: async () => ({}), verify: async () => ({}) },
    authorizeUser: async () => ({ allowed: true })
  })) { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise((resolve) => server.close(resolve)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

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
async function topup(userId, amountPaise) {
  const out = await req(userId, 'wallet/topup', { amountPaise });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.topup;
}

test('API: random UTR + ₹15 daalne par balance me KUCH NAHI judta', async () => {
  const t = await topup(7101, 1500);
  const claim = await req(7101, 'wallet/claim', { topupId: t.topupId, utr: '777788889999', amountPaise: 1500 });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.pending, true, 'credit nahi hua, verify ke liye pada');
  assert.equal(claim.body.creditedPaise, 0);
  assert.equal(walletBalancePaise(getDb(), '7101'), 0, 'wallet khaali hi hai');
  assert.match(claim.body.message, /verify/i);
});

test('API: statement me UTR aate hi SIRF asli amount judta hai', async () => {
  const db2 = getDb();
  const pending = listTopupRequests(db2, { status: 'PENDING', userId: '7101', limit: 5 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].utr, '777788889999');
  const imported = importStatementText(db2, '31-10-2026 UPI/CR/777788889999/MISBAHUL ISLAM/₹12.50 credited', { actor: 'boss' });
  assert.equal(imported.accepted.length, 1);
  saveDb(db2);
  const claim = listTopupRequests(getDb(), { userId: '7101', limit: 5 })[0];
  assert.equal(claim.status, 'AUTO_VERIFIED');
  assert.equal(walletBalancePaise(getDb(), '7101'), 1250, 'statement ka ₹12.50 juda, ₹15 ka claim nahi');
});

test('API: boss statement import route — parse + pending claim auto-settle', async () => {
  const t = await topup(7102, 2000);
  const claim = await req(7102, 'wallet/claim', { topupId: t.topupId, utr: '888899990000', amountPaise: 2000 });
  assert.equal(claim.body.pending, true);
  const notBoss = await req(7102, 'boss/statement', { text: '31-10-2026 UPI/CR/888899990000/MISBAHUL ISLAM/₹20.00' });
  assert.equal(notBoss.status, 403, 'statement sirf boss');
  const imp = await req(9000, 'boss/statement', { text: '31-10-2026 UPI/CR/888899990000/MISBAHUL ISLAM/₹20.00 credited' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.imported.accepted, 1);
  const settled = imp.body.settled.find(s => s.action === 'CREDIT');
  assert.ok(settled, JSON.stringify(imp.body.settled));
  assert.equal(settled.creditedPaise, 2000);
  assert.equal(walletBalancePaise(getDb(), '7102'), 2000);
});

test('API: statement me doosre ka naam ho to credit nahi, wajah saaf', async () => {
  const t = await topup(7103, 1500);
  await req(7103, 'wallet/claim', { topupId: t.topupId, utr: '101112131415', amountPaise: 1500 });
  const imp = await req(9000, 'boss/statement', { text: '31-10-2026 UPI/CR/101112131415/RAHUL KUMAR/₹15.00 credited' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const settled = imp.body.settled.find(s => s.utr === '101112131415' || s.action === 'CREDIT');
  assert.equal(settled, undefined, 'galat payee par credit nahi');
  assert.equal(walletBalancePaise(getDb(), '7103'), 0);
  const claim = listTopupRequests(getDb(), { userId: '7103', limit: 3 })[0];
  // Payment dikh gaya par boss ka nahi — claim saaf reject, wajah naam ke saath.
  assert.equal(claim.status, 'REJECTED');
  assert.match(claim.reason, /RAHUL KUMAR|boss .*nahi/i);
});

test('API: wahi UTR dobara — 409, koi double credit nahi', async () => {
  const t = await topup(7104, 1500);
  await req(7104, 'wallet/claim', { topupId: t.topupId, utr: '888899990000', amountPaise: 1500 });
  const again = await req(7104, 'wallet/claim', { topupId: t.topupId, utr: '888899990000', amountPaise: 1500 });
  assert.equal(again.status, 409, JSON.stringify(again.body));
});

test('API: statement status boss ko sach dikhata hai, user ko nahi', async () => {
  const boss = await req(9000, 'bootstrap');
  assert.ok(boss.body.statement, 'boss ko statement summary');
  assert.ok(boss.body.statement.count >= 1);
  const user = await req(7101, 'bootstrap');
  assert.equal(user.body.statement, undefined, 'user ko statement nahi');
});

test('statement ledger: entry dobara likhne par paisa double nahi hota', () => {
  const db3 = getDb();
  recordStatementPayment(db3, { utr: '202122232425', amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', source: 'statement' });
  recordStatementPayment(db3, { utr: '202122232425', amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', source: 'statement' });
  saveDb(db3);
  const entry = findStatementPayment(getDb(), '202122232425');
  assert.equal(entry.amountPaise, 1500);
  assert.equal(statementStatus(getDb()).count, Object.keys(getDb().config.upiStatement).length);
});
