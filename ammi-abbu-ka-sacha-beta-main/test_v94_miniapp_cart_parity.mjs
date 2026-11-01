// Boss (31-10-2026, round 3): "DIFFERENCE DEKHO" — hamara cart asli Swiggy cart
// se match kare, franchise/outlet chun sake, bill me darawne warning na aaye,
// aur payment ka happy path khula ho. Ye OFFLINE test hai: fake provider, koi
// live Swiggy/Telegram/UPI call nahi.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v94-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v94-offline-token', PRO_VAULT_KEY: 'v94-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', BOSS_ID: '9000', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
delete process.env.PRO_ENABLE_CHECKOUT;
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');

const db = getDb();
db.config.accounts = {};
db.config.bossIds = ['9000'];
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
// Ek hi naam ke do franchise — Swiggy search isi tarah alag rows deta hai.
const chainRows = [
  { id: '201', name: 'Pizza Junction', area: 'Kothrud', distance: '2.1 km', time: '25 min', isOpen: true, cuisines: 'Pizza', rating: '4.2', ratings: '1k' },
  { id: '202', name: 'Pizza Junction', area: 'Baner', distance: '5.4 km', time: '38 min', isOpen: false, opens: '11 am', cuisines: 'Pizza', rating: '4.0', ratings: '800' },
  { id: '203', name: 'Pizza Junction', area: 'Hadapsar', distance: '9.0 km', time: '45 min', isOpen: true, cuisines: 'Pizza', rating: '3.9', ratings: '300' },
  { id: '301', name: 'Some Other Cafe', area: 'Baner', distance: '3.0 km', time: '30 min', isOpen: true, cuisines: 'Cafe', rating: '4.1', ratings: '90' }
];
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search(_account, _address, query) {
    const q = String(query || '').toLowerCase();
    return chainRows.filter(r => r.name.toLowerCase().includes(q));
  },
  async menu(_account, _address, id) {
    const row = chainRows.find(r => r.id === String(id)) || chainRows[0];
    return {
      restaurant: { id: row.id, name: row.name, area: row.area, time: row.time, rating: row.rating, ratings: row.ratings, isOpen: row.isOpen, image: '', opens: row.opens || '' },
      categories: [{ title: 'Pizza', items: [{ id: '9001', name: 'Margherita', price: 274, isVeg: true, image: '', description: 'Cheese', inStock: true, customizable: false }] }]
    };
  },
  async quoteCart(_a, address) {
    // Swiggy screenshot wala asli case: lines ka jod total se zyada (chhupa offer).
    return { address, bill: { itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, discount: 0, total: 335, coupon: '', deliveryDistance: '2.1 km' }, ofoConfirmed: false };
  },
  async orders() { return []; },
  async tracking() { return {}; }
};

const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, claim: async () => ({}), deleteOtp: { request: async () => ({}), verify: async () => ({}) }, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
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
const user = sign(9401);
async function req(route, payload, method = payload === undefined ? 'GET' : 'POST', auth = user) {
  const response = await fetch(base + '/pro/api/' + route, {
    method,
    headers: { 'X-Telegram-Init-Data': auth, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}

function seed(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9123456789', name: 'Mine', token: 'mine-token', isLoggedIn: true, customerId: 'customer-9123456789' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [],
    cart: {
      restaurantId: '201', restaurantName: 'Pizza Junction', forSomeoneElse: false,
      items: [{ lineKey: 'l', id: '9001', menu_item_id: 9001, name: 'Margherita', qty: 2, price: 137, isVeg: true, variants: [], addons: [] }],
      quote: null
    }
  });
}

// ── Server: payment khula hai, outlets milte hain, cart clear confirm se ──
test('in-app payment default ON hai (band karne ke liye PRO_ENABLE_CHECKOUT=0)', async () => {
  const boot = await req('bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.body.checkoutEnabled, true);
  assert.equal(boot.body.checkoutBlockReason, '');
  process.env.PRO_ENABLE_CHECKOUT = '0';
  const off = await req('bootstrap');
  assert.equal(off.body.checkoutEnabled, false);
  assert.match(off.body.checkoutBlockReason, /PRO_ENABLE_CHECKOUT=0/);
  assert.equal((await req('checkout', { confirmCheckout: true, expectedTotal: 335 })).status, 503);
  delete process.env.PRO_ENABLE_CHECKOUT;
  process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE = '1';
  const blocked = await req('bootstrap');
  assert.equal(blocked.body.checkoutEnabled, false, 'live order block sabse upar hai');
  assert.match(blocked.body.checkoutBlockReason, /blocked/i);
  delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
  assert.equal((await req('bootstrap')).body.checkoutEnabled, true);
});

test('franchise/outlets list: har branch ka area, distance aur open/closed sach', async () => {
  seed(9401);
  const out = await req('restaurants/outlets?q=' + encodeURIComponent('Pizza Junction'));
  assert.equal(out.status, 200);
  assert.equal(out.body.outlets.length, 3);
  const kothrud = out.body.outlets.find(o => o.id === '201');
  assert.equal(kothrud.area, 'Kothrud');
  assert.equal(kothrud.distance, '2.1 km');
  assert.equal(kothrud.time, '25 min');
  assert.equal(kothrud.isOpen, true);
  assert.equal(out.body.outlets.find(o => o.id === '202').isOpen, false, 'band outlet band hi batao');
  assert.equal(out.body.outlets.some(o => o.id === '301'), false, 'doosra restaurant is list me nahi');

  const short = await req('restaurants/outlets?q=P');
  assert.equal(short.status, 400);
  const none = await req('restaurants/outlets?q=' + encodeURIComponent('No Such Place'));
  assert.equal(none.body.outlets.length, 0);
  assert.match(none.body.note, /nahi mila/);
});

test('outlet chunne/clear karne ke liye cart meta aur confirm — bina confirm kuch nahi badalta', async () => {
  seed(9401);
  const menu = await req('menu?id=202');
  assert.equal(menu.status, 200);
  assert.equal(menu.body.restaurant.area, 'Baner');
  assert.equal(readProWorkspace('9401').cart.restaurantId, '201', 'menu dekhne se cart nahi badalta');

  const noConfirm = await req('cart/clear', {});
  assert.equal(noConfirm.status, 400);
  assert.equal(readProWorkspace('9401').cart.items.length, 1);
  const cleared = await req('cart/clear', { confirmClear: true });
  assert.equal(cleared.status, 200);
  assert.equal(readProWorkspace('9401').cart, null);
});

test('cart header ke liye area/time/image quote ke saath save hote hain', async () => {
  seed(9401);
  // Asli flow: user pehle menu kholta hai (outlet ka sach wahin se aata hai).
  assert.equal((await req('menu?id=201')).status, 200);
  const out = await req('cart/sync', { confirmReplaceSwiggyCart: true, forSomeoneElse: false });
  assert.equal(out.status, 200);
  const cart = readProWorkspace('9401').cart;
  assert.equal(cart.restaurantArea, 'Kothrud');
  assert.equal(cart.restaurantTime, '25 min');
  assert.equal(cart.quote.deliveryDistance, '2.1 km');
  assert.equal(cart.items[0].isVeg, true, 'veg mark ke liye sach save hota hai');
  // Bill ke lines + saving total ke barabar — koi mismatch flag nahi.
  const q = cart.quote;
  assert.equal(q.mismatch, false);
  assert.equal(q.unlistedDiscount, 0, '0.08 rounding ko savings nahi bulate');
  assert.equal(q.taxesAndCharges, 61.08);
  assert.equal(q.total, 335);
});

// ── Client: Swiggy cart jaisa DOM ────────────────────────────────────────
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
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
const account = { key: 'mine', name: 'Mine', phone: '9123456789', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, needsConfirm: false, active: true, offerTracks: [] };
const quote = { total: 335, itemTotal: 274, deliveryFee: 0, packingCharges: 0, taxes: 61.08, taxesAndCharges: 61.08, discount: 0, otherCharges: 0, unlistedDiscount: 0.08, mismatch: false, deliveryDistance: '2.1 km', fetchedAt: '2026-10-31T00:00:00Z' };
function state(extra = {}) {
  return {
    ok: true, user: { name: 'Test', isBoss: false }, accounts: [account], activeAccount: account,
    selectedAddress: receiver,
    cart: { restaurantId: '201', restaurantName: 'Pizza Junction', restaurantArea: 'Kothrud', restaurantTime: '25 min', restaurantImage: '', forSomeoneElse: false, quote, items: [{ lineKey: 'l', name: 'Margherita', price: 137, qty: 2, isVeg: true }] },
    checkout: null, checkoutEnabled: true, checkoutBlockReason: '', ordersDetailAllowed: true, ...extra
  };
}

test('DOM: cart Swiggy jaisa — restaurant head, outlet dropdown, FREE delivery, Pay Now', async () => {
  const app = harness({ responder: call => (call.url.includes('/restaurants/outlets') ? { ok: true, outlets: [
    { id: '201', name: 'Pizza Junction', area: 'Kothrud', distance: '2.1 km', time: '25 min', isOpen: true },
    { id: '202', name: 'Pizza Junction', area: 'Baner', distance: '5.4 km', time: '38 min', isOpen: false }
  ] } : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.body.textContent.includes('Pay Now'), 'cart');
    const text = app.document.body.textContent;
    // Restaurant head: naam, area + ETA, aur trash se cart clear.
    assert.match(text, /Pizza Junction/);
    assert.match(text, /Kothrud · 25 min/);
    assert.ok(app.document.querySelector('[data-action="cart-clear"]'), 'cart clear button');
    // Boss (31-10-2026): group cart ka input + button HAMESHA saamne — koi
    // dropdown nahi jo pehle kholna pade.
    assert.ok(app.document.querySelector('form[data-form="group-cart"]'), 'group cart form khula hai');
    assert.equal(app.document.querySelector('[data-action="toggle-group-cart"]'), null, 'dropdown gaya');
    assert.match(app.document.querySelector('form[data-form="group-cart"] button[type="submit"]').textContent, /Cart parse karein/);
    // Item row: veg mark + line total.
    assert.ok(app.document.querySelector('.veg-mark'));
    assert.match(text, /₹274/);
    // Bill: FREE delivery + distance, koi darawne mismatch box nahi.
    assert.match(text, /FREE/);
    assert.match(text, /2\.1 km/);
    assert.equal(/farak hai/.test(text), false, 'mismatch warning box kabhi nahi');
    // The redundant payment card/copy is removed, but Pay Now remains.
    assert.doesNotMatch(text, /PAY USING UPI|Payment: UPI \/ QR|Bill updating/i);
    // Pay band ab band nahi — asli Pay Now.
    assert.match(text, /Pay Now/);
    assert.equal(/payment band/i.test(text), false);
  } finally { app.close(); }
});

test('DOM: outlet dropdown dabane par aas-paas ke branch dikhte hain, band branch disabled', async () => {
  const calls = [];
  const app = harness({ responder: call => {
    if (call.url.includes('/restaurants/outlets')) {
      calls.push(call.url);
      return { ok: true, outlets: [
        { id: '201', name: 'Pizza Junction', area: 'Kothrud', distance: '2.1 km', time: '25 min', isOpen: true },
        { id: '202', name: 'Pizza Junction', area: 'Baner', distance: '5.4 km', time: '38 min', isOpen: false },
        { id: '203', name: 'Pizza Junction', area: 'Hadapsar', distance: '9.0 km', time: '45 min', isOpen: true }
      ] };
    }
    if (call.url.includes('/menu?id=')) return { ok: true, restaurant: { id: '203', name: 'Pizza Junction', area: 'Hadapsar', isOpen: true }, categories: [{ title: 'Pizza', items: [] }] };
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="outlets-toggle"]'), 'outlet row');
    assert.match(app.document.querySelector('[data-action="outlets-toggle"]').textContent, /Kothrud/);
    app.document.querySelector('[data-action="outlets-toggle"]').click();
    await waitFor(() => app.document.querySelectorAll('[data-action="outlet-pick"]').length >= 2, 'outlet options');
    assert.equal(calls.length, 1);
    assert.match(decodeURIComponent(calls[0]), /q=Pizza Junction/);
    const options = [...app.document.querySelectorAll('[data-action="outlet-pick"]')];
    assert.equal(options.length, 3);
    assert.ok(options.some(b => b.textContent.includes('Baner') && b.disabled), 'band branch disabled');
    assert.ok(options.some(b => b.textContent.includes('Yahi')), 'current outlet marked');
    // Doosra outlet chunna = confirm ke baad menu.
    options.find(b => b.textContent.includes('Hadapsar')).click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'confirm');
    [...app.document.querySelectorAll('.confirm-dialog .confirm-actions button')].at(-1).click();
    await waitFor(() => app.calls.some(c => c.url.includes('/menu?id=203')), 'menu opened');
  } finally { app.close(); }
});

test('DOM: cart clear pehle poochta hai, phir hi clear karta hai', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/cart/clear') ? { ok: true, cart: null } : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="cart-clear"]'), 'clear');
    app.document.querySelector('[data-action="cart-clear"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'confirm');
    app.document.querySelector('.confirm-dialog .button.soft').click(); // Cancel
    await new Promise(r => setTimeout(r, 30));
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/clear')), false, 'cancel par koi call nahi');
    app.document.querySelector('[data-action="cart-clear"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'confirm 2');
    app.document.querySelector('.confirm-dialog .button.danger').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/clear')), 'clear call');
    assert.equal(app.calls.find(c => c.url.endsWith('/cart/clear')).body.confirmClear, true);
  } finally { app.close(); }
});

test('DOM: payment band hone par bhi dead-end nahi — asli reason dikhta hai', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap')
    ? state({ checkoutEnabled: false, checkoutBlockReason: 'In-app checkout is turned off by PRO_ENABLE_CHECKOUT=0.' })
    : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.pay-bar'), 'pay bar');
    const button = app.document.querySelector('.pay-bar button');
    assert.equal(button.disabled, true);
    assert.match(button.getAttribute('title'), /PRO_ENABLE_CHECKOUT=0/);
  } finally { app.close(); }
});

test('CSS: naye cart blocks ke styles maujood hain', () => {
  for (const selector of ['.cart-restaurant-head', '.outlet-row', '.outlet-option', '.cart-item-right', '.line-total', '.group-cart-toggle']) {
    assert.ok(cssSource.includes(selector), selector);
  }
});

// ── Round 4: Swiggy jaisa checkout + restaurant kholne par outlet chunna ──
test('DOM: restaurant kholne par pehle outlet/location sheet (Swiggy jaisa)', async () => {
  const base = state();
  const results = [
    { id: '201', name: 'Pizza Junction', area: 'Kothrud', distance: '2.1 km', time: '25 min', isOpen: true, cuisines: 'Pizza' },
    { id: '202', name: 'Pizza Junction', area: 'Baner', distance: '5.4 km', time: '38 min', isOpen: false, opens: '11 am', cuisines: 'Pizza' },
    { id: '203', name: 'Pizza Junction', area: 'Hadapsar', distance: '9.0 km', time: '45 min', isOpen: true, cuisines: 'Pizza' }
  ];
  const app = harness({ responder: call => {
    if (call.url.includes('/search?q=')) return { ok: true, restaurants: results };
    if (call.url.includes('/restaurants/outlets?')) return { ok: true, outlets: results };
    if (call.url.includes('/menu?id=')) return { ok: true, restaurant: { id: '203', name: 'Pizza Junction', area: 'Hadapsar', isOpen: true }, categories: [{ title: 'Pizza', items: [] }] };
    return base;
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="search"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="search"]'), 'search form');
    const form = app.document.querySelector('form[data-form="search"]');
    form.querySelector('input[name="q"]').value = 'Pizza';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelectorAll('.restaurant-row').length === 3, 'results');
    // Pehle row dabane par seedha menu nahi — location sheet.
    app.document.querySelector('.restaurant-row').click();
    await waitFor(() => app.document.querySelector('.sheet-overlay'), 'outlet sheet');
    assert.equal(app.calls.some(c => c.url.includes('/menu?id=')), false, 'sheet se pehle menu nahi khulta');
    const options = [...app.document.querySelectorAll('[data-sheet-outlet]')];
    assert.equal(options.length, 3);
    assert.ok(options.some(b => b.textContent.includes('Baner') && b.disabled), 'band outlet disabled');
    const hadapsar = options.find(b => b.textContent.includes('Hadapsar'));
    hadapsar.click();
    await waitFor(() => app.calls.some(c => c.url.includes('/menu?id=203')), 'menu khula');
    await waitFor(() => app.document.querySelector('.sheet-overlay') === null, 'sheet band');
    await waitFor(() => app.document.querySelector('.menu-outlet-row'), 'menu outlet row');
    assert.match(app.document.querySelector('.menu-outlet-row').textContent, /Hadapsar/);
  } finally { app.close(); }
});

test('DOM: ek hi outlet ho to seedha menu, sheet nahi', async () => {
  const single = [{ id: '501', name: 'Only Cafe', area: 'Baner', distance: '1 km', time: '20 min', isOpen: true }];
  const app = harness({ responder: call => {
    if (call.url.includes('/search?q=')) return { ok: true, restaurants: single };
    if (call.url.includes('/menu?id=')) return { ok: true, restaurant: { id: '501', name: 'Only Cafe', area: 'Baner', isOpen: true }, categories: [{ title: 'All', items: [] }] };
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="search"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="search"]'), 'search form');
    const form = app.document.querySelector('form[data-form="search"]');
    form.querySelector('input[name="q"]').value = 'Only';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('.restaurant-row'), 'result');
    app.document.querySelector('.restaurant-row').click();
    await waitFor(() => app.calls.some(c => c.url.includes('/menu?id=501')), 'menu');
    assert.equal(app.document.querySelector('.sheet-overlay'), null);
    await new Promise(r => setTimeout(r, 20));
  } finally { app.close(); }
});

test('DOM: checkout page Swiggy jaisa — ETA, address, Your Order, bill, payment, Pay Now', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? state() : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.eta-strip'), 'checkout page');
    const text = app.document.body.textContent;
    assert.match(text, /Checkout/);
    assert.match(text, /Delivery in 25 min/);
    assert.match(text, /DELIVERING TO/i);
    assert.match(text, /Your Order/);
    assert.match(text, /Bill Details/);
    assert.doesNotMatch(text, /Payment Method|PAY USING UPI/);
    // Section order Swiggy jaisa: address pehle, order uske baad, payment sabse neeche.
    const html = app.document.querySelector('#content').innerHTML;
    const at = needle => html.indexOf(needle);
    assert.ok(at('eta-strip') < at('DELIVERING TO'), 'ETA pehle, address baad me');
    assert.ok(at('DELIVERING TO') < at('Your Order'), 'address pehle, order baad me');
    assert.ok(at('Bill Details') < at('Pay Now'), 'bill visible above pay bar');
    const pay = app.document.querySelector('.pay-bar button');
    assert.equal(pay.disabled, false, 'Pay Now active hai');
    assert.match(pay.textContent, /Pay Now/);
  } finally { app.close(); }
});

test('DOM: bill na ho to bhi Pay Now chalta hai — pehle bill, phir order', async () => {
  const noQuote = state({ cart: { restaurantId: '201', restaurantName: 'Pizza Junction', restaurantArea: 'Kothrud', restaurantTime: '25 min', forSomeoneElse: false, quote: null, items: [{ lineKey: 'l', name: 'Margherita', price: 137, qty: 2, isVeg: true }] } });
  const withQuote = state();
  const app = harness({ responder: call => {
    if (call.url.endsWith('/cart/sync')) return { ok: true, cart: withQuote.cart, selectedAddress: receiver };
    if (call.url.endsWith('/checkout')) return { ok: true, checkout: { status: 'PAYMENT_PENDING', orderId: '999', amount: 335 }, cart: null };
    return noQuote;
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts ready');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('.pay-bar button'), 'pay bar');
    const pay = app.document.querySelector('.pay-bar button');
    assert.equal(pay.disabled, false, 'bill ke bina bhi Pay Now dab sakta hai');
    assert.match(pay.textContent, /Pay Now/);
    // Sync may replace the account's existing Swiggy cart, so consent first.
    await waitFor(() => app.document.querySelector('.confirm-dialog .button.primary'), 'cart sync consent');
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/sync')), false);
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/sync')), 'bill sync');
    await waitFor(() => app.document.querySelector('.bill-card') && !app.document.querySelector('.confirm-dialog'), 'returned bill');
    app.document.querySelector('.pay-bar .pay-now').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'payment consent');
    assert.match(app.document.querySelector('.confirm-dialog').textContent, /Pay ₹335/);
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/checkout')), 'checkout call');
    const call = app.calls.find(c => c.url.endsWith('/checkout'));
    assert.equal(call.body.confirmCheckout, true);
    assert.equal(call.body.expectedTotal, 335);
    assert.equal(call.body.quoteFetchedAt, quote.fetchedAt);
  } finally { app.close(); }
});
