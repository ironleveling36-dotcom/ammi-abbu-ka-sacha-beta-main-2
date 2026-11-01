// Boss (31-10-2026, round 25):
//   "UPI PAYMENT AGAR ME TRACK KARNA CHAHTA LIKE USER NE KITNA PAY KIA ... BAS
//    USSE UTR LUNGA AND UTR SE SAB DETAILES NIKAALUNGA KI ISNE PAY KIA ABHI YA
//    OLD YA KISI AUR KO AND KITNA"
//
// Isliye: sirf UTR. Us UTR se poora sach — kitna aaya, kab aaya (abhi/purana),
// kisko aaya (humein ya kisi aur ko), kaun bheja, status, pehle use hua ya nahi,
// credit hoga ya nahi — aur jo cheez provider ne nahi di, wo "chahiye" list me.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v114-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v114-offline-token', PRO_VAULT_KEY: 'v114-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.UPI_UTR_LOOKUP_URL;

const { describeUtrPayment, describeWhen, moneyText, FRESHNESS } = await import('./utr-truth.js');
const { getDb, saveDb } = await import('./store.js');
const { walletBalancePaise } = await import('./user-wallet.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace } = await import('./swiggy-pro-store.js');

const seedDb = () => {
  const db = getDb();
  db.config.accounts = {}; db.config.bossIds = ['9000'];
  db.config.wallets = {}; db.config.usedUtrs = {}; db.config.topupRequests = {}; db.config.topupIntents = {};
  db.config.utrLookups = {}; db.config.upiStatement = {};
  db.config.walletUpiId = 'mius@ybl'; db.config.serviceFeePaise = 1500;
  saveDb(db);
};
seedDb();

const payment = (over = {}) => ({
  utr: '123456789012', amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl',
  payerName: '', payerVpa: '', status: 'SUCCESS', at: Date.now() - 60_000, source: 'provider', ...over
});

// ── 1. Pure: UTR se poori kahani ─────────────────────────────────────────
test('truth: kitna aaya + user ne kitna bola + kisko aaya, sab ek jagah', () => {
  const truth = describeUtrPayment({
    utr: '123456789012', payment: payment(), lookup: { configured: true, found: true },
    claimedPaise: 2000
  });
  assert.equal(truth.found, true);
  assert.equal(truth.amountPaise, 1500);
  assert.equal(truth.amountLine, '₹15 aaya');
  assert.equal(truth.askedPaise, 2000);
  assert.match(truth.askedLine, /₹20/);
  assert.equal(truth.payee.isOurs, true);
  assert.match(truth.payee.line, /humein aaya/);
  assert.equal(truth.verdict.action, 'CREDIT');
  assert.equal(truth.verdict.creditedPaise, 1500);
  assert.match(truth.summaryLine, /₹15/);
  assert.match(truth.bossLine, /MISBAHUL ISLAM|humein aaya/);
});

test('truth: "abhi ya old" — payment ke time se saaf jawab', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const fresh = describeWhen(now - 40_000, { now });
  assert.equal(fresh.freshness, FRESHNESS.JUST_NOW);
  assert.match(fresh.line, /abhi abhi/);

  const hourAgo = describeWhen(now - 90 * 60_000, { now });
  assert.equal(hourAgo.freshness, FRESHNESS.TODAY);
  assert.match(hourAgo.line, /ghante pehle/);

  const threeDays = describeUtrPayment({ utr: '123456789012', payment: payment({ at: now - 3 * 24 * 60 * 60_000 }), now });
  assert.equal(threeDays.freshness, FRESHNESS.DAYS);
  assert.match(threeDays.whenLine, /din pehle/);

  const old = describeUtrPayment({ utr: '123456789012', payment: payment({ at: now - 30 * 24 * 60 * 60_000 }), now });
  assert.equal(old.freshness, FRESHNESS.OLD);
});

test('truth: kisi AUR ko paisa gaya to saaf — credit nahi', () => {
  const truth = describeUtrPayment({
    utr: '123456789012',
    payment: payment({ payeeName: 'RAHUL KUMAR', payeeVpa: 'rahul@okaxis' })
  });
  assert.equal(truth.payee.isOurs, false);
  assert.match(truth.payee.line, /kisi AUR ko|kisi aur ko/i);
  assert.match(truth.payee.line, /RAHUL KUMAR/);
  assert.equal(truth.verdict.action, 'REJECT');
  assert.equal(truth.verdict.code, 'PAYEE_MISMATCH');
});

test('truth: pending payment par credit nahi, wajah saaf', () => {
  const truth = describeUtrPayment({ utr: '123456789012', payment: payment({ status: 'PENDING' }) });
  assert.match(truth.statusLine, /PENDING|pahuncha nahi/);
  assert.notEqual(truth.verdict.action, 'CREDIT');
});

test('truth: payment nahi mili to "kya kya chahiye" list aati hai', () => {
  const truth = describeUtrPayment({ utr: '999999999999', payment: null, lookup: { configured: false, found: false, reason: 'provider set nahi' } });
  assert.equal(truth.found, false);
  const keys = truth.missing.map((m) => m.key);
  assert.ok(keys.includes('payment'));
  assert.ok(keys.includes('provider'));
  assert.equal(truth.checklist.find((c) => c.key === 'found').ok, false);
});

test('truth: provider ne time/payer nahi diya to wahi "chahiye" me', () => {
  const truth = describeUtrPayment({ utr: '123456789012', payment: payment({ at: 0, payerName: '' }), lookup: { configured: true, found: true } });
  const keys = truth.missing.map((m) => m.key);
  assert.ok(keys.includes('time'));
  assert.ok(keys.includes('payer'));
  assert.equal(truth.freshness, FRESHNESS.UNKNOWN);
});

test('truth: pehle use ho chuka UTR — kis user ke hisaab me, kab', () => {
  const truth = describeUtrPayment({
    utr: '123456789012', payment: payment(),
    usedUtr: { userId: '5555', at: '2026-10-30T10:00:00.000Z', status: 'CREDITED' }
  });
  assert.equal(truth.duplicate.used, true);
  assert.match(truth.duplicate.line, /5555/);
  assert.equal(truth.verdict.code, 'UTR_ALREADY_USED');
});

test('truth: paisa wala text — paisa chhupta nahi', () => {
  assert.equal(moneyText(1250), '₹12.50');
  assert.equal(moneyText(1500), '₹15');
  assert.equal(moneyText(0), '₹0');
});

// ── 2. Asli provider + API ───────────────────────────────────────────────
const providerPayments = new Map();
const providerServer = http.createServer(async (req, res) => {
  let utr = '';
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { utr = String(JSON.parse(body || '{}').utr || ''); } catch { utr = ''; }
  } else {
    utr = String(new URL(req.url, 'http://x').searchParams.get('utr') || '');
  }
  const record = providerPayments.get(utr);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(record ? { ok: true, data: { payment: record } } : { ok: false, message: 'UTR not found' }));
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
function seedUser(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: null, addressCandidates: [], cart: null
  });
}

test('claim: user ko bhi poori detail milti hai (kitna, kab, kisko)', async () => {
  seedUser(7501);
  providerPayments.set('700700700701', {
    utr: '700700700701', amount: 12.5, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl',
    payerName: 'RAJU', status: 'SUCCESS', at: new Date(Date.now() - 120_000).toISOString()
  });
  const out = await req(7501, 'wallet/claim', { amountRupees: 20, utr: '700700700701' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.creditedPaise, 1250);
  const truth = out.body.utrTruth;
  assert.ok(truth, 'claim response me utrTruth aaya');
  assert.equal(truth.amountPaise, 1250);
  assert.equal(truth.askedPaise, 2000);
  assert.match(truth.whenLine, /min pehle|abhi abhi/);
  assert.match(truth.payeeLine, /humein aaya/);
  assert.match(truth.payerLine, /RAJU/);
  assert.equal(truth.verdictAction, 'CREDIT');
  assert.ok(Array.isArray(truth.rows) && truth.rows.length >= 5, 'rows bhi aayi');
});

test('boss: koi bhi UTR daalo — poori detail + faisla (naya paisa)', async () => {
  providerPayments.set('700700700702', {
    utr: '700700700702', amount: 45, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl',
    payerName: 'SANA', payerVpa: 'sana@okhdfc', status: 'SUCCESS', at: new Date(Date.now() - 10 * 60_000).toISOString()
  });
  const out = await req(9000, 'boss/utr', { utr: '700700700702' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const truth = out.body.truth;
  assert.equal(truth.found, true);
  assert.equal(truth.amountPaise, 4500);
  assert.equal(truth.payee.isOurs, true);
  assert.match(truth.whenLine, /min pehle/);
  assert.match(truth.payerLine, /SANA/);
  assert.equal(truth.verdict.action, 'CREDIT');
  assert.match(out.body.bossLine, /₹45/);
  assert.ok(Array.isArray(truth.rows) && truth.rows.some((r) => r.key === 'payee' && r.ok === true));
});

test('boss: purana payment bhi pehchana jata hai ("OLD")', async () => {
  providerPayments.set('700700700703', {
    utr: '700700700703', amount: 100, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl',
    status: 'SUCCESS', at: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
  });
  const out = await req(9000, 'boss/utr', { utr: '700700700703' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.truth.freshness, 'OLD');
  assert.match(out.body.truth.whenLine, /din pehle/);
});

test('boss: kisi aur ko gaya paisa — saaf "humein nahi mila"', async () => {
  providerPayments.set('700700700704', {
    utr: '700700700704', amount: 15, payeeName: 'RAHUL KUMAR', payeeVpa: 'rahul@okaxis',
    status: 'SUCCESS', at: new Date().toISOString()
  });
  const out = await req(9000, 'boss/utr', { utr: '700700700704' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.truth.payee.isOurs, false);
  assert.equal(out.body.truth.verdict.code, 'PAYEE_MISMATCH');
  assert.match(out.body.truth.payeeLine, /kisi AUR ko/);
});

test('boss: UTR nahi mila to "kya chahiye" bhi batata hai', async () => {
  const out = await req(9000, 'boss/utr', { utr: '700700700799' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.truth.found, false);
  assert.ok(out.body.truth.missing.some((m) => m.key === 'payment'));
});

test('boss: galat UTR / khaali UTR par saaf error', async () => {
  const bad = await req(9000, 'boss/utr', { utr: '12' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'UTR_INVALID');
  const empty = await req(9000, 'boss/utr', {});
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'UTR_REQUIRED');
});

test('api: UTR track sirf boss ke liye — user ko 403', async () => {
  const out = await req(7501, 'boss/utr', { utr: '700700700702' });
  assert.equal(out.status, 403);
});

test('boss: jo UTR track hua wo yaad rehta hai (ledger + history)', async () => {
  const out = await req(9000, 'boss/utr', { utr: '700700700701' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.body.ledger, 'ledger entry mili (ye UTR credit ho chuka)');
  assert.equal(out.body.ledger.userId, '7501');
  assert.equal(out.body.ledger.amountPaise, 1250);
  assert.equal(out.body.truth.verdict.code, 'UTR_ALREADY_USED');
  assert.ok(Array.isArray(out.body.history) && out.body.history.length >= 1);
  const db = getDb();
  assert.ok(db.config.utrLookups['700700700701'], 'lookup db me yaad hai');
});

// ── 3. DOM: boss ka UTR track card ───────────────────────────────────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');

function bootDom(state, routes = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.fetch = async (raw) => {
    const url = String(raw);
    for (const [needle, payload] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          ok: payload.__status ? payload.__status < 400 : true,
          status: payload.__status || 200,
          json: async () => payload
        };
      }
    }
    return { ok: true, status: 200, json: async () => state };
  };
  window.eval(fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8'));
  return dom;
}
const waitFor = async (fn, label, ms = 5000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const found = fn();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout: ${label}`);
};

test('DOM: Boss Mini App se UTR form hata, other tools remain', async () => {
  const state = {
    ok: true, user: { name: 'Boss', isBoss: true },
    accounts: [{ key: 'op', name: 'Operator', phone: '9000011111', active: true, isLoggedIn: true, owner: 'operator', offerTracks: [] }],
    activeAccount: { key: 'op', name: 'Operator' }, selectedAddress: null, selectedAddresses: [],
    checkoutEnabled: true, ordersDetailAllowed: true, cart: null
  };
  const dom = bootDom(state);
  try {
    const { window } = dom;
    await waitFor(() => window.document.querySelector('[data-tab="tools"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="tools"]').click();
    assert.equal(window.document.querySelector('form[data-form="utr-track"]'), null);
    assert.equal(window.document.querySelector('form[data-form="wallet-claim"]'), null);
    assert.ok(window.document.querySelector('[data-action="claim-offers"]'), 'other tools retained');
  } finally { dom.window.close(); }
});
