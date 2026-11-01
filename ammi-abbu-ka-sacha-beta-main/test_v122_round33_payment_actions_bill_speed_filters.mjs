// Boss (01-11-2026, round 33):
//   "PAYMENT PAGE SE OPEN UPI APP HATAYE AND CANCEL ORDER AND I HAVE PAID KA
//    OPTION DE ... BILL CALCULATE HONE ME BAHUT TIME LAG RAHA HAI SAHI SE BILL
//    CALCULATE NAHI HO RAHA ISKO SAHI KARDO ... SAVED ACCOUNT KE NICHE EK FILTER
//    DEDO USED FRESH NIGHT BREKFAST ... MULTIPLE FILTER LAGA SAKTA USER"
//
// Yahan test hota hai:
//   1) Payment page par sirf do button: "I have paid" + "Cancel order"
//      (Open UPI app / track / original-account orders / lecture hata diye)
//   2) Cancel order → confirm → checkout band, cart wapas
//   3) Payment ke baad: My Orders → wahi order → share link + Copy + Go back
//      → Go back se normal cart page
//   4) Accounts filter chips USED/FRESH/NIGHT/BREAKFAST, multi-select
//   5) Bill do kadam me: pehla bill fast, phir best-coupon (optimize)
//   6) Bill ka hisaab sach par: available Swiggy Money discount nahi hai,
//      aur campaign free cash alag line se double nahi hoti
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { reconcileBill } from './bill-reconcile.js';
import { parseDapiCartPayload } from './swiggy-cart.js';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('./swiggy-pro-api.js', import.meta.url), 'utf8');

const SHARE = 'https://www.swiggy.com/ofo/track/round33token';

const account = (over = {}) => ({
  key: 'acc1', name: 'Skk', phone: '9031204105', active: true, isLoggedIn: true,
  selectable: true, needsConfirm: false, canClaim: true, canRemove: true,
  status: 'READY', used: false, fresh: true, night: true, breakfast: false, offerTracks: [], ...over
});

const baseState = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [
    account({ key: 'acc1', name: 'Skk', used: false, fresh: true, night: true, breakfast: false }),
    account({ key: 'acc2', name: 'Ammi', phone: '9876543210', active: false, status: 'USED', used: true, fresh: false, night: false, breakfast: true }),
    account({ key: 'acc3', name: 'Abbu', phone: '9812345678', active: false, status: 'READY', used: false, fresh: true, night: false, breakfast: false })
  ],
  activeAccount: { key: 'acc1', name: 'Skk' },
  selectedAddress: { id: 'a1', name: 'Skk', mobile: '7978459775', address: 'Flat 412' },
  selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true,
  orders: [], cart: null, ...over
});

const pendingCheckout = (over = {}) => baseState({
  checkout: {
    status: 'PAYMENT_PENDING', orderId: '252355785108792', amount: 402,
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', upiIntentUrl: 'upi://pay?pa=x@ybl&am=402',
    paymentVerified: false, message: 'QR Swiggy se aaya hai.', tracking: null, sms: null
  },
  ...over
});

function boot(state, responder) {
  const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''), {
    runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true
  });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.__STATE = state;
  window.__CALLS = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    window.__CALLS.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    const out = responder ? responder(u, opts) : window.__STATE;
    return { ok: true, status: 200, json: async () => out };
  };
  window.eval(appSource);
  return dom;
}
const waitFor = async (fn, label, ms = 9000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const v = fn(); if (v) return v; } catch { /* abhi nahi */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout: ' + label);
};
const openCart = async (window) => {
  await waitFor(() => window.document.querySelector('[data-action="nav"][data-tab="cart"]:not([disabled])'), 'nav');
  window.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
};

// ── 1. Payment page: sirf do button ──────────────────────────────────────
test('payment page par sirf "I have paid" aur "Cancel order" — UPI app/track/lecture gaye', async () => {
  const dom = boot(pendingCheckout(), () => pendingCheckout());
  const { window } = dom;
  try {
    await openCart(window);
    const screen = await waitFor(() => window.document.querySelector('.pay-screen'), 'pay screen');
    const text = screen.textContent;
    const paid = screen.querySelector('[data-action="checkout-status"]');
    const cancel = screen.querySelector('[data-action="checkout-cancel"]');
    assert.ok(paid, 'I have paid button');
    assert.match(paid.textContent, /I have paid/);
    assert.ok(cancel, 'Cancel order button');
    assert.match(cancel.textContent, /Cancel order/);
    // Faltu cheezein hata di — boss ka order.
    assert.equal(/Open UPI app/i.test(text), false, 'Open UPI app hata');
    assert.equal(screen.querySelector('a[href^="upi:"]'), null, 'UPI intent link nahi');
    assert.equal(screen.querySelector('[data-action="track-open"]'), null, 'track button nahi');
    assert.equal(screen.querySelector('[data-action="checkout-orders"]'), null, 'original account orders button nahi');
    assert.equal(/Original account/i.test(text), false, 'blah blah nahi');
    assert.ok(screen.querySelector('.payment-qr'), 'QR wahi rehta hai');
    assert.equal(window.document.body.innerHTML.includes('upi://pay'), false, 'upi:// koi link nahi');
  } finally { window.close(); }
});

test('Cancel order: confirm ke baad checkout band, cart wapas, sach wala message', async () => {
  const afterCancel = baseState({
    checkout: null,
    cart: { restaurantId: '201', restaurantName: 'Arabecue', items: [{ lineKey: 'l1', name: 'Burger', price: 171, qty: 2 }], quote: null }
  });
  const dom = boot(pendingCheckout(), (url) => {
    if (url.endsWith('/checkout/cancel')) return { ok: true, checkout: null, cart: afterCancel.cart, message: 'Checkout band. Paisa nahi kata. Swiggy par unpaid order reh gaya hai.' };
    return pendingCheckout();
  });
  const { window } = dom;
  try {
    await openCart(window);
    (await waitFor(() => window.document.querySelector('[data-action="checkout-cancel"]'), 'cancel btn')).click();
    // in-app confirm dialog
    const dialog = await waitFor(() => window.document.querySelector('.confirm-dialog'), 'confirm dialog');
    const confirm = [...dialog.querySelectorAll('button')].find(b => /Haan, cancel/.test(b.textContent));
    assert.ok(confirm, 'confirm button');
    confirm.click();
    await waitFor(() => window.__CALLS.some(c => c.url.endsWith('/checkout/cancel')), 'cancel call');
    const call = window.__CALLS.find(c => c.url.endsWith('/checkout/cancel'));
    assert.equal(call.body.confirmCancel, true, 'confirm bheja');
    await waitFor(() => window.document.querySelector('.pay-screen') === null, 'pay screen band');
    assert.equal(window.document.querySelector('.bottom-nav button.selected').dataset.tab, 'cart');
    assert.match(window.document.querySelector('#toast').textContent, /Paisa nahi kata/);
  } finally { window.close(); }
});

// ── 2. Payment ke baad share link + Copy + Go back ───────────────────────
const paidState = () => baseState({
  checkout: { status: 'PAID', orderId: '252355785108792', amount: 402, paymentVerified: true, message: 'paid', sms: null, tracking: { orderId: '252355785108792', status: 'Order placed', trackingUrl: SHARE, via: 'FYI_CTA', tried: [], sms: null } },
  orders: [{ id: '252355785108792', status: 'PAID', restaurant: 'Arabecue', amount: 402, placedAt: '01/11/26, 9:10 pm', items: [] }]
});

test('"I have paid" par My Orders → order → share link + Copy + Go back', async () => {
  const dom = boot(pendingCheckout(), (url) => {
    if (url.endsWith('/checkout/status')) return paidState();
    if (url.includes('/orders/tracking')) return { ok: true, tracking: paidState().checkout.tracking, sms: null };
    if (url.endsWith('/orders')) return { ok: true, orders: paidState().orders, detailAllowed: true };
    if (url.endsWith('/bootstrap')) return pendingCheckout();
    return paidState();
  });
  const { window } = dom;
  try {
    await openCart(window);
    const btn = await waitFor(() => window.document.querySelector('[data-action="checkout-status"]'), 'paid btn');
    btn.click();
    const card = await waitFor(() => window.document.querySelector('.share-card'), 'share card', 12000);
    assert.equal(window.document.querySelector('.bottom-nav button.selected').dataset.tab, 'orders', 'My Orders khula');
    const input = card.querySelector('[data-share-input]');
    assert.equal(input.value, SHARE, 'Swiggy ka asli link');
    assert.ok(card.querySelector('[data-action="share-copy"]'), 'Copy button');
    assert.match(card.textContent, /Copy/);
    const back = card.querySelector('[data-action="back-to-cart"]');
    assert.ok(back, 'Go back button');
    assert.match(back.textContent, /Go back/);
    back.click();
    await waitFor(() => window.document.querySelector('.share-card') === null, 'cart page');
    assert.equal(window.document.querySelector('.bottom-nav button.selected').dataset.tab, 'cart', 'normal cart page khula');
  } finally { window.close(); }
});

test('share link na mile to sach + dobara check (jhoothi link nahi)', () => {
  assert.match(appSource, /Swiggy ne is order ka share link nahi diya\. Hum apna link nahi banate\./);
  assert.equal(/swiggy\.com\/ofo\/track\/\$\{/.test(appSource), false, 'apna link nahi banate');
});

// ── 3. Accounts filter chips ─────────────────────────────────────────────
test('Saved Accounts ke neeche USED / FRESH / NIGHT / BREAKFAST filter chips', async () => {
  const dom = boot(baseState(), () => baseState());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('[data-action="nav"][data-tab="accounts"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-action="nav"][data-tab="accounts"]').click();
    const bar = await waitFor(() => window.document.querySelector('.ac-filters'), 'filter bar');
    const labels = [...bar.querySelectorAll('[data-action="account-filter"]')].map(b => b.textContent.trim());
    for (const want of ['USED', 'FRESH', 'NIGHT', 'BREAKFAST']) {
      assert.ok(labels.some(t => t.startsWith(want)), `${want} chip`);
    }
    // Saved Accounts heading ke baad hi aata hai
    const head = window.document.querySelector('.ac-saved-head');
    assert.ok(head && head.nextElementSibling, 'saved accounts head');
    assert.equal(bar.compareDocumentPosition(head) & window.Node.DOCUMENT_POSITION_PRECEDING, window.Node.DOCUMENT_POSITION_PRECEDING, 'chips neeche');
    const rows = () => [...window.document.querySelectorAll('[data-account-row]')].map(r => r.textContent);
    assert.equal(rows().length, 3, 'shuru me teeno');

    // FRESH → acc1 + acc3
    window.document.querySelector('[data-filter="fresh"]').click();
    await waitFor(() => window.document.querySelectorAll('[data-account-row]').length === 2, 'fresh filter');
    assert.match(rows().join(' '), /Skk[\s\S]*Abbu|Abbu[\s\S]*Skk/);
    assert.equal(rows().join(' ').includes('Ammi'), false, 'used ID chhup gayi');

    // multiple filter: FRESH + NIGHT → sirf acc1
    window.document.querySelector('[data-filter="night"]').click();
    await waitFor(() => window.document.querySelectorAll('[data-account-row]').length === 1, 'fresh+night');
    assert.match(rows()[0], /Skk/);
    assert.ok(window.document.querySelector('[data-filter="fresh"]').classList.contains('on'));
    assert.ok(window.document.querySelector('[data-filter="night"]').classList.contains('on'));

    // Clear → teeno wapas
    window.document.querySelector('[data-filter=""]').click();
    await waitFor(() => window.document.querySelectorAll('[data-account-row]').length === 3, 'clear');
  } finally { window.close(); }
});

test('filter sirf sach par — jahan live check nahi hua wo FRESH/USED dono nahi', () => {
  assert.match(apiSource, /fresh: truth\.status === 'READY'/);
  assert.match(apiSource, /used: truth\.status === 'USED'/);
  assert.match(apiSource, /night: hasOfferTrack\(a, 'lateNight'\)/);
  assert.match(apiSource, /breakfast: hasOfferTrack\(a, 'breakfast'\)/);
  assert.match(css, /\.ac-filter\.on \{ background: #0f7ea8/);
});

// ── 4. Server: fast bill + optimize ──────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-r33-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(tmp, 'accounts.json');
process.env.BOT_TOKEN = '123456:offline-test-bot-token';
process.env.PRO_VAULT_KEY = 'offline-random-test-key-only';
process.env.BOSS_ID = '7900';
process.env.DB_ASYNC_WRITE = '0';
process.env.PRO_ENABLE_CHECKOUT = '1';
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace, readProWorkspace } = await import('./swiggy-pro-store.js');

const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const quotePhases = [];
const fakeProvider = {
  async verifySession() { return { valid: true, customerId: 'c-9123456789' }; },
  async addresses() { return [address]; },
  async orders() { return []; },
  async quoteCart(_account, _address, _cart, _coupon, options = {}) {
    const phase = options.phase || 'fast';
    quotePhases.push(phase);
    const total = phase === 'full' ? 352 : 402;
    return {
      address,
      optimizePending: phase === 'fast',
      bill: {
        itemTotal: 342, deliveryFee: 28, packingCharges: 0, taxes: 32,
        discount: phase === 'full' ? 50 : null, coupon: phase === 'full' ? 'TRYNEW' : '',
        oneMembershipFee: null, tradeDiscount: null, freeCash: null, total
      }
    };
  }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fakeProvider, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
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
const USER = '7901';
async function post(p, body, userId = USER) {
  const res = await fetch(baseUrl + '/pro/api/' + p, {
    method: 'POST',
    headers: { 'X-Telegram-Init-Data': sign(userId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function seedWorkspace() {
  writeProWorkspace(USER, {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'c-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: address, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Arabecue', forSomeoneElse: false,
      items: [{ lineKey: 'l1', id: '9001', menu_item_id: 9001, name: 'Burger', qty: 2, price: 171, isVeg: false, variants: [], addons: [] }],
      quote: null
    }
  });
}

// Round 35 (boss): "BILL CHANGE HOJATA ... CONSISTENT NAHI HAI" — do kadam
// (fast phir optimize) hata diya. Ab ek hi bill: jo dikha wahi Pay Now par.
test('bill ek hi kadam me: poora quote (jo dikha wahi Pay par jata hai)', async () => {
  seedWorkspace();
  quotePhases.length = 0;
  const first = await post('cart/sync', { confirmReplaceSwiggyCart: true, autoCoupon: true, forSomeoneElse: false });
  assert.equal(first.status, 200);
  assert.deepEqual(quotePhases, ['full'], 'ek hi poora bill — koi chhupa hua doosra phase nahi');
  assert.equal(first.body.cart.quote.total, 352, 'best coupon pehle bill me hi');
  assert.equal(first.body.cart.quote.optimizePending, false);
  // Client sirf poora bill maangta hai; koi background swap nahi.
  assert.doesNotMatch(appSource, /optimizeBill\(/);
  assert.match(appSource, /phase: 'full'/);
  // Fast phase sirf jaan-boojh kar maanga ja sakta hai (chat handoff), default nahi.
  assert.match(apiSource, /body\.phase === 'fast' \? 'fast' : 'full'/);
});

// ── 5. Bill ka hisaab ────────────────────────────────────────────────────
test('bill: campaign free cash alag line se double nahi hoti (lines milti hain)', () => {
  // Swiggy: item 342 + delivery 28 + taxes 32 = 402; coupon 0; trade 50 (campaign).
  const swiggyRaw = 342 + 28 + 32 - 50;
  const fixed = reconcileBill({
    itemTotal: 342, deliveryFee: 28, packingCharges: 0, taxes: 32,
    discount: null, coupon: '', freeCash: null, tradeDiscount: 50, oneMembershipFee: 0, total: swiggyRaw
  });
  assert.equal(fixed.problems.some(p => p.code === 'BILL_DOES_NOT_ADD_UP'), false, 'round-33 mapping milti hai');
  assert.equal(fixed.bill.linesAddUp, true);
  assert.equal(fixed.bill.total, 352);

  // Purana galat mapping: campaign trade discount me bhi aur free cash me bhi —
  // ek hi ₹50 do baar minus, isliye lines total se kam pad jati hain.
  const old = reconcileBill({
    itemTotal: 342, deliveryFee: 28, packingCharges: 0, taxes: 32,
    discount: null, coupon: '', freeCash: 50, tradeDiscount: 50, oneMembershipFee: 0, total: swiggyRaw
  });
  // Farq dikhta hai: galat mapping me wahi ₹50 "other charges" ban jata hai
  // (user ko bina wajah ka extra charge dikhta hai), sahi mapping me nahi.
  assert.equal(fixed.bill.otherCharges, 0, 'sahi mapping me koi banawati charge nahi');
  assert.equal(old.bill.otherCharges, 50, 'galat mapping ₹50 banawati charge banati hai');
});

test('bill: sirf jo Swiggy Money SACH ME kata wo discount — balance nahi', () => {
  const raw = parseDapiCartPayload({
    cartMeta: {
      item_total: 342, order_total: 402, positiveDeliveryChargesExclusive: 28, taxesAndCharges: 32,
      total_packing_charges: 0, user_swiggy_money: 60, swiggy_money: 0,
      cart_menu_items: [{ menu_item_id: 9001, name: 'Burger', quantity: 1, subtotal: 34200, final_price: 34200 }]
    },
    cartItems: {},
    subscriptionItems: []
  });
  assert.equal(raw.swiggyMoneyApplied, 0, 'balance kaata nahi gaya');
  assert.equal(raw.freeCashBalance, 60, 'balance alag bataya jata hai');
  // Sirf sach: jo kata, wahi applied maana jata hai.
  assert.match(fs.readFileSync(new URL('./swiggy-pro-provider.js', import.meta.url), 'utf8'), /swiggyMoneyApplied/);
});
