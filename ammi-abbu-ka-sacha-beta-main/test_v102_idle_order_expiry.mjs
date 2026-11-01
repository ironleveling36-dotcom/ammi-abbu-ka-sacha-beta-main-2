// Boss (31-10-2026, round 13): "koi ID active karke order kar raha aur order
// chhod kar chala gaya — 2 minute of activity ke baad uska pura order band ho
// jayega." Yahan test: draft/bill/checkout 2 min idle par band, paid aur
// outcome-unknown kabhi nahi, fee ka sahi refund, ID free.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v102-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v102-offline-token', PRO_VAULT_KEY: 'v102-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
delete process.env.PRO_ENABLE_CHECKOUT;
delete process.env.ORDER_IDLE_TIMEOUT_MS;

const {
  DEFAULT_IDLE_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, idleTimeoutMs,
  lastActivityAt, planIdleExpiry, classifyCheckout, describeIdleClosure
} = await import('./order-idle-expiry.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');
const { walletBalancePaise } = await import('./user-wallet.js');

const db = getDb();
db.config.accounts = {}; db.config.bossIds = ['9000'];
delete db.config.orderIdleTimeoutMs;
saveDb(db);

const MIN = 60_000;
const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const items = [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Paneer', qty: 1, price: 230, isVeg: true, variants: [], addons: [] }];
const quote = () => ({ itemTotal: 230, deliveryFee: 0, packingCharges: 5, taxes: 27.85, discount: 160, coupon: 'FLASHSALE', couponCode: 'FLASHSALE', total: 29, totalSavings: 279, fetchedAt: new Date(Date.now() - 5 * MIN).toISOString() });

// ── 1. Pure module ────────────────────────────────────────────────────────
test('idle: default timeout 2 minute hai aur sensible range me clamp hota hai', () => {
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 2 * MIN);
  assert.equal(idleTimeoutMs(null), 2 * MIN);
  process.env.ORDER_IDLE_TIMEOUT_MS = '90000';
  assert.equal(idleTimeoutMs(null), 90000);
  assert.equal(idleTimeoutMs({ config: { orderIdleTimeoutMs: 5000 } }), MIN_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutMs({ config: { orderIdleTimeoutMs: 99999999 } }), MAX_IDLE_TIMEOUT_MS);
  delete process.env.ORDER_IDLE_TIMEOUT_MS;
});
test('idle: classify — paid aur unknown kabhi expire nahi, placed-unpaid alag', () => {
  assert.equal(classifyCheckout(null), 'DRAFT');
  assert.equal(classifyCheckout({ status: 'PAID' }), 'PAID');
  assert.equal(classifyCheckout({ status: 'OUTCOME_UNKNOWN' }), 'UNKNOWN');
  assert.equal(classifyCheckout({ status: 'SUBMITTING' }), 'SUBMITTING');
  assert.equal(classifyCheckout({ status: 'PAYMENT_PENDING', orderId: '123' }), 'PLACED_UNPAID');
  assert.equal(classifyCheckout({ status: 'PAYMENT_PENDING' }), 'DRAFT');
});
test('idle: plan — 3 minute purana draft band, 30 second purana nahi', () => {
  const old = { cart: { items, quote: quote() }, lastActivityAt: new Date(Date.now() - 3 * MIN).toISOString() };
  const fresh = { cart: { items, quote: quote() }, lastActivityAt: new Date(Date.now() - 30_000).toISOString() };
  assert.equal(planIdleExpiry({ ws: old }).expire, true);
  assert.equal(planIdleExpiry({ ws: fresh }).expire, false);
  assert.equal(planIdleExpiry({ ws: old }).kind, 'DRAFT');
});
test('idle: plan — paid / unknown / in-flight placement kabhi band nahi', () => {
  const base = { cart: { items }, lastActivityAt: new Date(Date.now() - 10 * MIN).toISOString() };
  for (const status of ['PAID', 'OUTCOME_UNKNOWN']) {
    const plan = planIdleExpiry({ ws: { ...base, checkout: { status } } });
    assert.equal(plan.expire, false, status);
  }
  const submitting = { ...base, checkout: { status: 'SUBMITTING' } };
  assert.equal(planIdleExpiry({ ws: submitting, placementInFlight: true }).expire, false);
  assert.equal(planIdleExpiry({ ws: submitting, placementInFlight: false }).expire, false, 'restart cannot prove that a submission was never sent');
});
test('idle: placed-unpaid order is kept for payment/status checks and cannot be retried', () => {
  const ws = { cart: { items }, checkout: { status: 'PAYMENT_PENDING', orderId: '252421961135322', createdAt: new Date(Date.now() - 10 * MIN).toISOString() } };
  const plan = planIdleExpiry({ ws });
  assert.equal(plan.expire, false);
  assert.equal(classifyCheckout(ws.checkout), 'PLACED_UNPAID');
});
test('idle: last activity cart/bill/checkout me se sabse nayi hoti hai', () => {
  const now = Date.now();
  const ws = {
    lastActivityAt: new Date(now - 9 * MIN).toISOString(),
    cart: { quote: { fetchedAt: new Date(now - 4 * MIN).toISOString() } }
  };
  const last = lastActivityAt(ws);
  assert.ok(now - last < 5 * MIN && now - last > 3 * MIN, `last=${last}`);
});

// ── 2. API ────────────────────────────────────────────────────────────────
const provider = {
  async verifySession() { return { valid: true, phone: '9123456789', customerId: 'c-1' }; },
  async checkout() { throw new Error('stub'); },
  async checkPayment() { return { paid: false }; }
};
const server = http.createServer(async (req, res) => {
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
function seed(userId, extra = {}) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c-1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: { restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false, items: structuredClone(items), quote: quote() },
    checkoutGeneration: 0,
    ...extra
  });
}

test('API: stale SUBMITTING checkout remains blocked and is not refunded as a draft', async () => {
  seed(9961, {
    lastActivityAt: new Date(Date.now() - 3 * MIN).toISOString(),
    checkout: { id: '0', accountKey: 'mine', status: 'SUBMITTING', amount: 29, createdAt: new Date(Date.now() - 3 * MIN).toISOString(), feeChargedPaise: 1500, feeChargedAt: new Date().toISOString() }
  });
  const first = await req(9961, 'bootstrap');
  assert.equal(first.status, 200);
  assert.ok(first.body.cart);
  assert.ok(first.body.checkout, 'uncertain checkout kept');
  assert.equal(first.body.idle?.closed, null);
  assert.equal(walletBalancePaise(getDb(), '9961'), 0, 'uncertain submission is not automatically refunded');
  assert.equal(readProWorkspace('9961').checkoutGeneration, 0, 'duplicate-order barrier remains');
});

test('API: a stale draft with no checkout still expires normally', async () => {
  seed(9967, { lastActivityAt: new Date(Date.now() - 3 * MIN).toISOString() });
  const out = await req(9967, 'bootstrap');
  assert.equal(out.body.cart, null);
  assert.equal(out.body.checkout, null);
  assert.equal(out.body.idle?.closed?.kind, 'DRAFT');
});

test('API: 30 second pehle activity hui ho to draft band nahi hota', async () => {
  seed(9962, { lastActivityAt: new Date(Date.now() - 30_000).toISOString() });
  const out = await req(9962, 'bootstrap');
  assert.ok(out.body.cart, 'cart zinda hai');
  assert.equal(out.body.idle?.closed, null);
  assert.equal(readProWorkspace('9962').abandoned ?? null, null);
});

test('API: placed-unpaid order remains visible after idle without refund or retry', async () => {
  seed(9963, {
    lastActivityAt: new Date(Date.now() - 4 * MIN).toISOString(),
    checkout: { id: '0', accountKey: 'mine', status: 'PAYMENT_PENDING', orderId: '252421961135322', amount: 70, createdAt: new Date(Date.now() - 4 * MIN).toISOString(), feeChargedPaise: 1500 }
  });
  const out = await req(9963, 'bootstrap');
  assert.equal(out.body.checkout?.orderId, '252421961135322');
  assert.equal(out.body.checkout?.status, 'PAYMENT_PENDING');
  assert.ok(out.body.cart);
  assert.equal(out.body.idle?.closed, null);
  assert.equal(walletBalancePaise(getDb(), '9963'), 0, 'placed order ki fee wapas nahi');
  assert.equal(readProWorkspace('9963').checkoutGeneration, 0, 'no automatic retry of an existing order');
});

test('API: paid order aur outcome-unknown kabhi idle se band nahi hote', async () => {
  seed(9964, { lastActivityAt: new Date(Date.now() - 20 * MIN).toISOString(), checkout: { status: 'PAID', orderId: '111', amount: 70, feeChargedPaise: 1500 } });
  let out = await req(9964, 'bootstrap');
  assert.equal(out.body.checkout?.status, 'PAID');
  seed(9965, { lastActivityAt: new Date(Date.now() - 20 * MIN).toISOString(), checkout: { status: 'OUTCOME_UNKNOWN', orderId: '', amount: 70, feeChargedPaise: 1500 } });
  out = await req(9965, 'bootstrap');
  assert.equal(out.body.checkout?.status, 'OUTCOME_UNKNOWN');
});

test('API: asli activity (cart sync) timer reset karti hai', async () => {
  seed(9966, { lastActivityAt: new Date(Date.now() - 3 * MIN).toISOString() });
  // bootstrap khud activity nahi hai — par yahan pehle band ho jayega.
  const closed = await req(9966, 'bootstrap');
  assert.equal(closed.body.cart, null);
  seed(9966, { lastActivityAt: new Date(Date.now() - 3 * MIN).toISOString() });
  const synced = await req(9966, 'cart/sync', { confirmReplaceSwiggyCart: true }).catch(() => null);
  // cart/sync provider stub se fail bhi ho jaye, tab bhi activity touch honi chahiye.
  const ws = readProWorkspace('9966');
  assert.ok(Date.now() - Date.parse(ws.lastActivityAt) < 10_000, 'activity touch hui');
  assert.ok(synced !== null);
});

// ── 3. App ────────────────────────────────────────────────────────────────
const appBase = () => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver,
  checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
  cart: { restaurantId: '201', restaurantName: 'Paneer Palace', items: structuredClone(items), quote: { total: 29, itemTotal: 230, fetchedAt: new Date().toISOString() } },
  checkout: null,
  wallet: { balancePaise: 1500, balance: '15', feePaise: 1500, fee: '15', ready: true, shortfall: '0', upiId: 'mius@ybl', presets: [] },
  idle: { timeoutMs: 120000, closed: null, abandoned: [] }
});
async function mount(state) {
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => state });
  window.eval(fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8'));
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 20)); }
    throw new Error('timeout: ' + label);
  };
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not([disabled])'), 'nav');
  return { window, waitFor };
}

test('DOM: cart par 2 minute ka rule saaf likha hota hai', async () => {
  const { window, waitFor } = await mount(appBase());
  try {
    window.document.querySelector('[data-tab="cart"]').click();
    const note = await waitFor(() => window.document.querySelector('.idle-note'), 'idle note');
    assert.match(note.textContent, /2 minute tak koi activity nahi/i);
    assert.match(note.textContent, /band ho jayega/i);
  } finally { window.close(); }
});

test('DOM: band hone ke baad app khud toast dikhata hai (server message)', async () => {
  const state = appBase();
  state.cart = null;
  state.idle = { timeoutMs: 120000, closed: { kind: 'DRAFT', message: '3 minute tak koi activity nahi thi — draft order band kar diya aur ID agle order ke liye free hai; fee wapas kar di gayi.' }, abandoned: [] };
  const { window, waitFor } = await mount(state);
  try {
    const toast = await waitFor(() => { const t = window.document.querySelector('#toast'); return t && !t.hidden && t.textContent.includes('band kar diya') ? t : null; }, 'toast');
    assert.match(toast.textContent, /ID agle order ke liye free/i);
  } finally { window.close(); }
});
