// Boss (31-10-2026, round 19):
//   "TRACKING LINK BHI NAHI AARAHA AND ORDER PAYMENT KARNE KE BAAAD AUTO FETCH
//    BHI NAHI HORAHA KI AND SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR
//    SARA DATA RESET HOJATA HAI"
//
// Teen cheezein:
//   1. deploy par paisa/UTR na jaye — cloud snapshot + boot restore (merge me
//      paisa kabhi kam nahi, UTR dobara chalu nahi)
//   2. operator ke ID par bhi tracking LINK mile (OTP/address chhupe rahein)
//   3. payment ke baad app khud status fetch kare (button dabana na pade)
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v108-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v108-offline-token', PRO_VAULT_KEY: 'v108-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '1', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1',
  GITHUB_VAULT_TOKEN: 'ghp_test_token_v108', VAULT_ENCRYPTION_KEY: 'v108-vault-enc-key'
});
delete process.env.PRO_ENABLE_CHECKOUT;

// ── GitHub vault ka mock: PUT/GET seedha memory me ────────────────────────
const vaultFiles = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const url = String(raw);
  if (url.includes('127.0.0.1')) return realFetch(raw, options);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const m = url.match(/\/contents\/([^?]+)/);
  if (url.includes('api.github.com') && m) {
    const key = decodeURIComponent(m[1]);
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body || '{}');
      vaultFiles.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
      return json({ ok: true });
    }
    if (vaultFiles.has(key)) return json({ content: Buffer.from(vaultFiles.get(key), 'utf8').toString('base64') });
    return json({ message: 'Not Found' }, 404);
  }
  if (url.includes('api.github.com')) return json({ ok: true }); // branch create etc.
  return json({ statusCode: 0 });
};

const { getDb, saveDb } = await import('./store.js');
const { buildMoneySnapshot, needsMoneyRestore, mergeMoneySnapshot, snapshotHasData } = await import('./money-snapshot.js');
const { backupMoneyNow, restoreMoneyOnBoot, durabilityStatus, _resetDurabilityState } = await import('./db-durability.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { walletBalancePaise, creditWallet, debitWallet } = await import('./user-wallet.js');

const db = getDb();
db.config.accounts = {}; db.config.bossIds = ['9000'];
delete db.config.serviceFeePaise; delete db.config.walletUpiId;
db.config.wallets = { '7001': { userId: '7001', balancePaise: 1500 } };
db.config.usedUtrs = { '123456789012': { utr: '123456789012', userId: '7001', amountPaise: 1500, status: 'AUTO_VERIFIED' } };
saveDb(db);

// ── 1. snapshot / merge ──────────────────────────────────────────────────
test('snapshot: paisa + UTR ka sach banta hai, khaali nahi', () => {
  const snap = buildMoneySnapshot(getDb());
  assert.equal(snapshotHasData(snap), true);
  assert.equal(snap.sections.wallets['7001'].balancePaise, 1500);
  assert.ok(snap.sections.usedUtrs['123456789012']);
  assert.equal(needsMoneyRestore({ config: {} }, snap), true);
});

test('merge: ledger order wins, not a larger balance; ambiguous histories block', () => {
  const db = { config: {} };
  creditWallet(db, '7001', 1500, { at: 1_700_000_000_000 });
  const older = buildMoneySnapshot(db);
  const oldCopy = structuredClone(db);
  debitWallet(db, '7001', 1500, { at: 1_700_000_001_000 });
  const newer = buildMoneySnapshot(db);
  const keep = mergeMoneySnapshot(db, older);
  assert.equal(keep.conflicts.length, 0);
  assert.equal(walletBalancePaise(db, '7001'), 0, 'old higher balance does not resurrect spent money');
  const restore = mergeMoneySnapshot(oldCopy, newer);
  assert.equal(restore.conflicts.length, 0);
  assert.equal(walletBalancePaise(oldCopy, '7001'), 0, 'newer debit is restored');
  const ambiguous = { config: { wallets: { '7001': { balancePaise: 100 } } } };
  const result = mergeMoneySnapshot(ambiguous, { sections: { wallets: { '7001': { balancePaise: 500 } } } });
  assert.equal(ambiguous.config.wallets['7001'].balancePaise, 100);
  assert.equal(result.conflicts.length, 1);
});

test('merge: UTR ledger union — deploy ke baad wahi UTR dobara nahi chalta', () => {
  const snap = { sections: { wallets: {}, usedUtrs: { '999888777666': { utr: '999888777666', userId: '7001' } } }, config: {} };
  const fresh = { config: {} };
  mergeMoneySnapshot(fresh, snap);
  assert.ok(fresh.config.usedUtrs['999888777666']);
});

// ── 2. deploy simulation: backup → data wipe → boot restore ──────────────
test('deploy: snapshot cloud me jata hai, data wipe ke baad boot par paisa + UTR wapas', async () => {
  _resetDurabilityState();
  const pushed = await backupMoneyNow({ force: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.ok([...vaultFiles.keys()].some((k) => k.includes('db-money-snapshot')), 'vault me snapshot gaya');

  // Cloud me plaintext nahi jaata.
  const raw = [...vaultFiles.entries()].find(([k]) => k.includes('db-money-snapshot'))[1];
  assert.ok(!/123456789012/.test(raw), 'UTR plaintext me nahi');
  assert.match(raw, /__vaultEnc/);
  assert.match(raw, /__moneySnapshot/);

  // ── deploy: naya khaali db (disk attach nahi tha) ──
  const fresh = getDb();
  fresh.config.wallets = {}; fresh.config.usedUtrs = {}; fresh.config.topupRequests = {};
  saveDb(fresh);
  try { fs.rmSync(path.join(tmp, 'db-money-snapshot.json'), { force: true }); } catch {}

  _resetDurabilityState();
  const out = await restoreMoneyOnBoot();
  assert.equal(out.restored, true, JSON.stringify(out));
  assert.equal(out.source, 'cloud');
  assert.equal(walletBalancePaise(getDb(), '7001'), 1500, 'wallet wapas');
  assert.ok(getDb().config.usedUtrs['123456789012'], 'UTR ledger wapas');
  const status = durabilityStatus();
  assert.equal(status.cloud, true);
  assert.ok(status.utrs >= 1);
});

test('restore: snapshot khaali ho to kuch nahi badalta', async () => {
  _resetDurabilityState();
  const before = walletBalancePaise(getDb(), '7001');
  const out = await restoreMoneyOnBoot();
  assert.equal(walletBalancePaise(getDb(), '7001'), before);
  assert.equal(out.restored, false);
});

// ── 3. tracking link operator ke ID par bhi ──────────────────────────────
const receiver = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, Kajala', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };
let trackingCalls = 0;
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true, phone: '9000011111', customerId: 'boss-cust' }; },
    async orders() { return [{ id: '252429282132542', restaurant: 'Arabecue Fried Chicken', status: 'processing', amount: 48 }]; },
    async tracking(_a, id) {
      trackingCalls += 1;
      return {
        status: 'processing', eta: '35 min',
        // Swiggy asli response me aksar share-URI bhejta hai — usme se https link nikalna hai.
        trackingUrl: `swiggy://share?text=${encodeURIComponent(`https://www.swiggy.com/ofo/track/${id}-token`)}`,
        deliveryOtp: '4321',
        deliveryPartner: { name: 'Rider', phone: '9000000001' }
      };
    },
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
function seedOperatorOrder() {
  // Operator (boss ka shared) ID user ke workspace me nahi hota — isliye
  // detail restricted rehti hai, par tracking LINK milna chahiye.
  const sharedDb = getDb();
  sharedDb.config.accounts = {
    ...(sharedDb.config.accounts || {}),
    acc_shared: { phone: '9000011111', customerId: 'boss-cust', token: 't', isLoggedIn: true, owner: 'boss', name: 'Operator', addedAt: new Date().toISOString() }
  };
  saveDb(sharedDb);
}

test('tracking: operator ke ID par LINK milta hai, OTP/address nahi', async () => {
  seedOperatorOrder();
  const selected = await req(7201, 'accounts/select', { key: 'acc_shared', confirmUsed: true });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const listed = await req(7201, 'orders');
  assert.equal(listed.body.detailAllowed, false, 'operator ID restricted hi hai');
  trackingCalls = 0;
  const out = await req(7201, 'orders/tracking?id=252429282132542');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.restricted, true);
  assert.match(out.body.tracking.trackingUrl, /^https:\/\/www\.swiggy\.com\/ofo\/track\//);
  assert.equal(out.body.tracking.deliveryOtp, '', 'OTP chhupa');
  assert.equal(out.body.tracking.deliveryPartner.name, '', 'rider chhupa');
  // Round 21: note ab "kis route se mila / kya try hua" batata hai — link ka
  // sach wahi rehta hai (Swiggy ka https link, OTP/rider chhupe).
  assert.match(out.body.tracking.note, /Tracking link mil gaya/i);
  assert.match(out.body.tracking.note, /operator ke paas/i);
  assert.ok(trackingCalls >= 1, 'provider se tracking maanga gaya');
});

test('paid checkout: operator ke ID par bhi tracking link milta hai, OTP nahi', async () => {
  const { writeProWorkspace } = await import('./swiggy-pro-store.js');
  seedOperatorOrder();
  writeProWorkspace('7202', {
    version: 1,
    accounts: {},
    activeAccountKey: 'acc_shared',
    cart: null,
    checkout: {
      status: 'PAID', orderId: '252429282132542', accountKey: 'acc_shared', accountPhone: '9000011111',
      amount: 48, createdAt: new Date().toISOString(), paymentVerified: true, ofoConfirmed: true,
      tracking: {
        orderId: '252429282132542', status: 'processing', eta: '35 min',
        trackingUrl: 'https://www.swiggy.com/ofo/track/tok-paid',
        deliveryOtp: '4321', deliveryPartner: { name: 'Rider', phone: '9000000001' }
      }
    }
  });
  const out = await req(7202, 'bootstrap');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const c = out.body.checkout;
  assert.equal(c.restricted, true, 'operator ID restricted hi hai');
  assert.equal(c.accountPhone, '90••••1111', 'poora number nahi');
  assert.match(c.tracking.trackingUrl, /^https:\/\/www\.swiggy\.com\/ofo\/track\//, 'link mila');
  assert.equal(c.tracking.deliveryOtp, '');
  assert.equal(c.tracking.deliveryPartner.phone, '');
});

// ── 4. App: payment ke baad auto fetch + restricted tracking card ────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

function boot(state, { onApi } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.fetch = async (raw, options = {}) => {
    const url = String(raw);
    if (onApi) {
      const handled = await onApi(url, options);
      if (handled) return handled;
    }
    return { ok: true, status: 200, json: async () => state };
  };
  window.eval(appSource);
  return { window, dom };
}
const waitFor = async (fn, label, ms = 5000) => {
  const started = Date.now();
  while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout: ' + label);
};

test('DOM: PAYMENT_PENDING par app khud checkout/status call karti hai (button dabaye bina)', async () => {
  const state = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver, selectedAddresses: [receiver],
    checkoutEnabled: true, ordersDetailAllowed: true,
    cart: { restaurantId: '201', restaurantName: 'Biryani', items: [{ lineKey: 'l', name: 'Biryani', price: 48, qty: 1 }], quote: { total: 48, fetchedAt: new Date().toISOString(), itemTotal: 48 } },
    checkout: { status: 'PAYMENT_PENDING', orderId: '252429282132542', amount: 48, paymentVerified: false, qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', upiIntentUrl: 'upi://pay?pa=upiswiggy@icici&am=48.00&cu=INR' },
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [], history: [] }
  };
  let statusCalls = 0;
  const { window } = boot(state, {
    onApi: async (url, options) => {
      if (url.includes('checkout/status')) {
        statusCalls += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, checkout: { ...state.checkout, status: 'PAID', paymentVerified: true } }) };
      }
      return null;
    }
  });
  try {
    await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => window.document.querySelector('.pay-screen'), 'pay screen');
    // Button dabaye bina, 8s ke andar khud call honi chahiye.
    await waitFor(() => statusCalls >= 1, 'auto checkout/status', 12000);
    assert.ok(statusCalls >= 1);
  } finally { window.close(); }
});

test('DOM: operator ke ID ke order par tracking card + Swiggy link dikhta hai', async () => {
  const state = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'op', name: 'Operator', phone: '9000011111', active: true, isLoggedIn: true, owner: 'boss' }],
    activeAccount: { key: 'op', name: 'Operator' }, selectedAddress: receiver, selectedAddresses: [receiver],
    checkoutEnabled: true, ordersDetailAllowed: false, cart: null,
    orders: [{ id: '252429282132542', restaurant: 'Arabecue Fried Chicken', status: 'processing', amount: 48, placedAt: '2026-10-31 20:44:42', items: [] }],
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [], history: [] }
  };
  const { window } = boot(state, {
    onApi: async (url) => {
      if (url.includes('orders/tracking')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, restricted: true, tracking: {
          orderId: '252429282132542', status: 'processing', eta: '35 min',
          trackingUrl: 'https://www.swiggy.com/ofo/track/tok-1', deliveryOtp: '', deliveryPartner: { name: '', phone: '' },
          restricted: true, note: 'Tracking link Swiggy ka hai — status aur rider wahan dikhega.'
        } }) };
      }
      return null;
    }
  });
  try {
    await waitFor(() => window.document.querySelector('[data-tab="orders"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="orders"]').click();
    const row = await waitFor(() => window.document.querySelector('[data-action="order-detail"]'), 'order row');
    row.click();
    const trackingBtn = await waitFor(() => window.document.querySelector('[data-action="order-tracking"]'), 'tracking refresh');
    trackingBtn.click();
    const link = await waitFor(() => window.document.querySelector('a[href^="https://www.swiggy.com/ofo/track"]'), 'Swiggy tracking link');
    assert.ok(link);
    assert.ok(!/Delivery OTP/.test(window.document.querySelector('#content').textContent), 'OTP nahi dikhta');
  } finally { window.close(); }
});
