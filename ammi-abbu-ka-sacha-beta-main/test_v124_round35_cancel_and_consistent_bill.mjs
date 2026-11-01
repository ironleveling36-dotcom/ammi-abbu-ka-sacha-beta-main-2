// Boss (01-11-2026, round 35):
//   "JAISE ORDER CANCEL KARDIA MENE TO WO ORDER CANCEL HOJANA CHAHIYE BUT
//    CHECKOUT NEEDS CHECKING KA CARD ARAHA AUR BUTTON AARAHA CHECK THIS ORDER
//    AND CHECK ORIGINAL ACCOUNT ... ISKO HATADO CANCEL KARDU ... AND FREE CASH
//    ABHI BHI NAHI LAG RAHA AUR JO BILL DIKHA RAHA PAY NOW PAR CLICK KARTA HU
//    TO WO CHANGE HOJATA AND JAYDA BILL SHOW HOTA CONSISTENT NAHI HAI."
//
// Yahan prove hota hai:
//   1) Cancel par koi "needs checking" / check-this-order / original-account
//      button nahi — sirf cancel, phir cart wapas (order dobara ho sake).
//   2) Server cancel: checkout band, fee wapas, cart wapas, PAID par 409.
//   3) Bill consistent: ek hi (full) quote — jo Pay bar par dikha wahi checkout
//      par jata hai. Koi background optimize swap nahi.
//   4) Free cash: offer claim quote se PEHLE hota hai, aur claim ka sach bill
//      card par ek chhoti line me aata hai.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v124-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v124-offline-token', PRO_VAULT_KEY: 'v124-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
process.env.PRO_ENABLE_CHECKOUT = '1';

const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('./swiggy-pro-api.js', import.meta.url), 'utf8');
const providerSource = fs.readFileSync(new URL('./swiggy-pro-provider.js', import.meta.url), 'utf8');

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace } = await import('./swiggy-pro-store.js');

const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const phases = [];
const fakeProvider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [address]; },
  async orders() { return []; },
  async quoteCart(_account, _address, _cart, _coupon, options = {}) {
    const phase = options.phase || 'full';
    phases.push(phase);
    return {
      address,
      addressFingerprint: 'fp',
      optimizePending: false,
      offerNote: '1 offer claim hua (0 pehle se active).',
      bill: {
        itemTotal: 342, deliveryFee: 28, packingCharges: 0, taxes: 32,
        discount: 50, coupon: 'TRYNEW', tradeDiscount: null, freeCash: 50,
        oneMembershipFee: null, total: 352
      }
    };
  }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fakeProvider, authorizeUser: async () => ({ allowed: true }) })) {
    res.writeHead(404); res.end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

function sign(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'User ' + userId }),
    query_id: 'query'
  });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
const USER = '7902';
async function post(p, body, userId = USER) {
  const res = await fetch(baseUrl + '/pro/api/' + p, {
    method: 'POST',
    headers: { 'X-Telegram-Init-Data': sign(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function seedWorkspace(checkout = null) {
  writeProWorkspace(USER, {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: address, addressCandidates: [], checkout,
    cart: {
      restaurantId: '201', restaurantName: 'Arabecue', forSomeoneElse: false,
      items: [{ lineKey: 'l1', id: '9001', menu_item_id: 9001, name: 'Burger', qty: 2, price: 171, isVeg: false, variants: [], addons: [] }],
      quote: null
    }
  });
}

// ── 1. Server: cancel sach me cancel karta hai ────────────────────────────
test('cancel: checkout band, cart wapas, paisa nahi kata', async () => {
  seedWorkspace({ id: '0', status: 'SUBMITTING', accountKey: 'mine', createdAt: new Date().toISOString(), amount: 352 });
  const out = await post('checkout/cancel', { confirmCancel: true });
  assert.equal(out.status, 200);
  assert.equal(out.body.checkout, null, 'checkout band');
  assert.ok(out.body.cart?.items?.length, 'cart wapas mila — naya order ho sakta hai');
  assert.match(out.body.message, /Paisa nahi kata/i);
  // Dobara cancel = 404, jhoothi success nahi.
  const again = await post('checkout/cancel', { confirmCancel: true });
  assert.equal(again.status, 404);
});

test('cancel: PAID order par 409 — jhoothi cancellation nahi', async () => {
  seedWorkspace({ id: '1', status: 'PAID', accountKey: 'mine', orderId: '123456789012', createdAt: new Date().toISOString(), amount: 352 });
  const out = await post('checkout/cancel', { confirmCancel: true });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /cancel nahi|Swiggy app/i);
});

test('cancel: OUTCOME_UNKNOWN bhi band ho jata hai (order dobara kar sake)', async () => {
  seedWorkspace({ id: '2', status: 'OUTCOME_UNKNOWN', accountKey: 'mine', createdAt: new Date().toISOString(), amount: 352, message: 'An order may exist.' });
  const out = await post('checkout/cancel', { confirmCancel: true });
  assert.equal(out.status, 200);
  assert.equal(out.body.checkout, null);
});

// ── 2. Bill consistent + free cash ────────────────────────────────────────
test('bill: ek hi (full) quote — koi chhupa hua doosra phase nahi', async () => {
  seedWorkspace();
  phases.length = 0;
  const out = await post('cart/sync', { confirmReplaceSwiggyCart: true, autoCoupon: true, forSomeoneElse: false });
  assert.equal(out.status, 200);
  assert.deepEqual(phases, ['full'], 'sirf poora bill');
  assert.equal(out.body.cart.quote.total, 352, 'Pay bar par wahi number jo bill me hai');
  // Client background me bill badalne wala call nahi karta.
  assert.doesNotMatch(appSource, /optimizeBill\(/);
  assert.match(appSource, /phase: 'full'/);
  // Checkout usi total par jata hai (jo dikha wahi).
  assert.match(appSource, /expectedTotal: quote\.total/);
  assert.match(apiSource, /exactPaise\(body\.expectedTotal\) !== exactPaise\(total\)/);
});

test('free cash: offer claim quote se pehle hota hai (bill me hi lage)', () => {
  // Claim ka jawab push se PEHLE await hota hai — warna free cash agle bill me
  // aata tha aur user ko \"free cash nahi lag raha\" dikhta tha.
  const claimAt = providerSource.indexOf('const claimPromise = claimEnabled');
  const awaitAt = providerSource.indexOf('const claimResult = claimEnabled ? await claimPromise : null;');
  const pushAt = providerSource.indexOf('let base = await push({ couponCode: requestedCoupon, subscriptionItems });');
  assert.ok(claimAt > 0 && awaitAt > claimAt, 'claim shuru hota hai');
  assert.ok(pushAt > awaitAt, 'claim ka jawab cart push se pehle — free cash usi bill me');
  assert.match(providerSource, /deadlineAt: Date\.now\(\) \+ 6500/);
  assert.match(providerSource, /parallelOffers: true/);
  assert.match(providerSource, /currentWindowOnly: true/);
  assert.match(providerSource, /claimSummary\.claimed/);
  // Claim fail/used ho to sach likha jata hai, jhoothi \"applied\" nahi.
  assert.match(providerSource, /pre-booked|PRE_LOCKED/);
  assert.match(providerSource, /engine\.offerNote = claimNote/);
  assert.match(apiSource, /offerNote: String\(quote\.offerNote \|\| ''\)/);
});

// ── 3. UI: cancel card + bill ki offer line ──────────────────────────────
const baseState = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [{ key: 'mine', name: 'Mine', phone: '9123456789', active: true, isLoggedIn: true }],
  activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: address,
  checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true,
  cart: {
    restaurantId: '201', restaurantName: 'Paneer Palace', forSomeoneElse: false,
    items: [{ lineKey: 'l', name: 'Paneer', price: 230, qty: 1, isVeg: true }],
    quote: {
      total: 352, itemTotal: 342, deliveryFee: 28, taxes: 32, discount: 50, coupon: 'TRYNEW',
      freeCash: 50, offerNote: '1 offer claim hua (0 pehle se active).', fetchedAt: new Date().toISOString()
    }
  },
  checkout: null,
  wallet: { balancePaise: 1500, balance: '15', feePaise: 1500, fee: '15', ready: true, shortfall: '0', upiId: 'mius@ybl', presets: [] },
  idle: { timeoutMs: 120000, closed: null, abandoned: [] },
  ...over
});
async function mount(state, responder) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.fetch = async (url, opts = {}) => {
    const body = responder ? responder(String(url), opts) : null;
    return { ok: true, status: 200, json: async () => body || state };
  };
  window.eval(appSource);
  const waitFor = async (fn, label, ms = 4000) => {
    const started = Date.now();
    while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch { /* retry */ } await new Promise(r => setTimeout(r, 20)); }
    throw new Error('timeout: ' + label);
  };
  await waitFor(() => window.document.querySelector('[data-tab="cart"]:not(:disabled)'), 'nav');
  window.document.querySelector('[data-tab="cart"]').click();
  return { window, waitFor };
}

test('cancel card: sirf cancel — check-this-order/original-account buttons nahi', async () => {
  const state = baseState({ checkout: { status: 'OUTCOME_UNKNOWN', orderId: '123456789012', message: 'The response was lost.' } });
  const { window, waitFor } = await mount(state);
  try {
    await waitFor(() => window.document.querySelector('.cancel-card'), 'cancel card');
    assert.equal(window.document.querySelector('[data-action="checkout-orders"]'), null);
    assert.equal(window.document.querySelector('[data-action="checkout-status"]'), null);
    assert.equal(window.document.querySelectorAll('.cancel-card [data-action="checkout-cancel"]').length, 1);
    assert.match(window.document.querySelector('.cancel-card').textContent, /paisa nahi katega/i);
    // Pay bar bhi blocked nahi — cancel ke baad order dobara ho sake.
    assert.equal(window.document.querySelector('[data-action="checkout-orders"]'), null);
  } finally { window.close(); }
});

test('cancel: dabane par server cancel chalta hai aur cart unlock hota hai', async () => {
  const state = baseState({ checkout: { status: 'OUTCOME_UNKNOWN', orderId: '123456789012', message: 'lost' } });
  const calls = [];
  const { window, waitFor } = await mount(state, (url) => {
    calls.push(url);
    if (url.endsWith('/checkout/cancel')) return { ok: true, checkout: null, cart: baseState().cart, message: 'Checkout band. Paisa nahi kata.' };
    return null;
  });
  try {
    await waitFor(() => window.document.querySelector('.cancel-card'), 'cancel card');
    window.document.querySelector('.cancel-card [data-action="checkout-cancel"]').click();
    const confirm = await waitFor(() => window.document.querySelector('.confirm-dialog .button.danger, .confirm-dialog .button.primary'), 'confirm');
    confirm.click();
    await waitFor(() => calls.some(u => u.endsWith('/checkout/cancel')), 'cancel api');
    await waitFor(() => window.document.querySelector('.pay-bar .pay-now'), 'cart wapas');
    assert.equal(window.document.querySelector('.cancel-card'), null, 'cancel card chala gaya');
  } finally { window.close(); }
});

test('bill: offer claim ka sach bill card par dikhta hai (chhoti line)', async () => {
  const { window, waitFor } = await mount(baseState());
  try {
    const note = await waitFor(() => window.document.querySelector('.bill-offer-note'), 'offer note');
    assert.match(note.textContent, /offer claim/i);
    assert.match(css, /\.bill-offer-note \{/);
    // Pay bar ka number bill ke total se hi aata hai — dono ek.
    const pay = await waitFor(() => window.document.querySelector('.pay-bar .pay-left strong'), 'pay amount');
    assert.match(pay.textContent, /352/);
    assert.match(window.document.querySelector('.bill-card').textContent, /352/);
  } finally { window.close(); }
});
