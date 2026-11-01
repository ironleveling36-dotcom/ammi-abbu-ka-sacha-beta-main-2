// Boss (31-10-2026, round 6): "CART PARSE NAHI HO RAHA, BUTTON SIDHA ACTIVE
// KAR, AUR DATA ERASE HO JATA HAI."
// Ye OFFLINE test hai — fake provider, koi live Swiggy/Telegram call nahi.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v95-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v95-offline-token', PRO_VAULT_KEY: 'v95-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', BOSS_ID: '9500', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
delete process.env.PRO_ENABLE_CHECKOUT;
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;

const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { extractGroupCartRef, resolveGroupCartLink } = await import('./swiggy-pro-provider.js');
const {
  readProWorkspace, writeProWorkspace, ensureProWorkspaceHydrated, resetProWorkspaceHydrationCache,
  writeProWorkspaceMirror, proBackupStatus, getProVaultSource
} = await import('./swiggy-pro-store.js');
const { getDb, saveDb } = await import('./store.js');

const db = getDb();
db.config.accounts = { shared_a: { phone: '9876500011', name: 'Shared', token: 'tk', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0 } };
db.config.bossIds = ['9500'];
saveDb(db);

const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const provider = {
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: `customer-${session.phone || session.mobile}`, name: 'Test' }; },
  async addresses() { return [receiver]; },
  async resolveAddress() { return receiver; },
  async search() { return []; },
  async menu() { return { restaurant: { id: '123', name: 'R', isOpen: true }, categories: [{ title: 'All', items: [] }] }; },
  async quoteCart(_a, address) { return { address, bill: { itemTotal: 100, deliveryFee: 0, packingCharges: 0, taxes: 5, discount: 0, total: 105, coupon: '' }, ofoConfirmed: false }; },
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
const user = sign(9501), boss = sign(9500);
async function req(auth, route, payload, method = payload === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/pro/api/' + route, {
    method,
    headers: { 'X-Telegram-Init-Data': auth, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}

// ── 1. Link shapes: 5 tarah ke link, ek hi cart id ───────────────────────
test('group cart link ke 5 shapes parse hote hain', () => {
  const cases = [
    ['web share (purana)', 'https://www.swiggy.com/gc/374563/Pizza-Junction-Kothrud-201', '201'],
    ['chhota web link', 'https://www.swiggy.com/gc/987654321', '987654321'],
    ['query link', 'https://www.swiggy.com/restaurants/pizza-junction?sharedCartId=5551234&utm=x', '5551234'],
    ['groupCartId param', 'https://www.swiggy.com/gc?groupCartId=777888&restaurantId=201', '777888'],
    ['swiggy deep link', 'swiggy://gc?shared_cart_id=123456', '123456'],
    ['app share link (encoded url)', 'swiggy://share?text=' + encodeURIComponent('https://www.swiggy.com/gc/374563/Pizza-Junction-Kothrud-201'), '201'],
    ['url encoded http link', encodeURIComponent('https://www.swiggy.com/gc/374563/Pizza-Junction-201'), '201']
  ];
  for (const [label, link, expected] of cases) {
    const ref = extractGroupCartRef(link);
    assert.ok(ref, `${label} parse nahi hua`);
    assert.equal(ref.cartId, expected, `${label} ka cart id galat`);
  }
});

test('bekaar link par jhootha cart id nahi — asli wajah milti hai', async () => {
  assert.equal(extractGroupCartRef('hello duniya'), null);
  assert.equal(extractGroupCartRef('https://example.com/cart'), null);
  assert.equal(extractGroupCartRef(''), null);
  await assert.rejects(() => resolveGroupCartLink('https://example.com/nothing'), /group cart/i);
  // http link bhi chalta hai — id text se nikal lete hain, network call nahi.
  const httpRef = await resolveGroupCartLink('http://www.swiggy.com/gc/374563/x-201');
  assert.equal(httpRef.cartId, '201');
  // Galat host par saaf wajah.
  await assert.rejects(() => resolveGroupCartLink('https://swiggy.com.attacker.invalid/gc/1/x-2'), /Swiggy|link/i);
});

test('short link redirect ke baad bhi parse hota hai', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /onelink\.me/);
    return { ok: true, headers: new Map([['location', 'https://www.swiggy.com/gc/374563/Pizza-Junction-201']]) };
  };
  try {
    const ref = await resolveGroupCartLink('https://swiggy.onelink.me/abc123');
    assert.equal(ref.cartId, '201');
    assert.match(ref.expanded, /swiggy\.com\/gc\/374563/);
  } finally { globalThis.fetch = originalFetch; }
});

// ── 2. Backup: mirror sach me restore karta hai (token ke bina) ───────────
test('workspace ka encrypted mirror db.json me jata hai aur file udne par wapas aata hai', async () => {
  writeProWorkspace('9601', { version: 1, accounts: { mine: { phone: '9333344444', token: 'secret-1', isLoggedIn: true } }, activeAccountKey: 'mine', selectedAddress: receiver, cart: null });
  // write ke baad mirror turant nahi hota (debounce) — test me seedha likhte hain.
  const file = path.join(tmp, 'pro-workspaces', crypto.createHash('sha256').update('9601').digest('hex') + '.json');
  assert.equal(fs.existsSync(file), true);
  writeProWorkspaceMirror('9601', fs.readFileSync(file, 'utf8'));
  assert.ok(getDb().config.proWorkspaceMirror, 'mirror db me hai');
  assert.equal(JSON.stringify(getDb()).includes('secret-1'), false, 'mirror me plaintext secret nahi');

  // Redeploy simulate: local file gayab.
  fs.unlinkSync(file);
  resetProWorkspaceHydrationCache();
  assert.equal(await ensureProWorkspaceHydrated('9601'), true);
  const restored = readProWorkspace('9601');
  assert.equal(restored.accounts.mine.phone, '9333344444');
  assert.equal(proBackupStatus().restored.lastFrom, 'db-mirror');
});

test('backup ka sach bootstrap me aata hai; boss hi backup chala sakta hai', async () => {
  const bossBoot = await req(boss, 'bootstrap');
  assert.equal(bossBoot.status, 200);
  assert.equal(bossBoot.body.backup.dbMirror.enabled, true);
  assert.equal(typeof bossBoot.body.backup.cloud.enabled, 'boolean');
  assert.ok(['ENV', 'KEY_FILE', 'DERIVED', 'GENERATED'].includes(bossBoot.body.backup.vaultSource));

  const userBoot = await req(user, 'bootstrap');
  assert.equal(userBoot.body.backup.dbMirror.enabled, true);
  assert.equal(userBoot.body.backup.cloud.lastError, undefined, 'cloud ki andar ki baat user ko nahi');

  assert.equal((await req(user, 'backup', {})).status, 403, 'user backup nahi chala sakta');
  const done = await req(boss, 'backup', {});
  assert.equal(done.status, 200);
  assert.equal(done.body.result.mirrored, true, 'mirror me save hua');
  assert.equal(done.body.backup.dbMirror.rows >= 1, true);
});

test('cloud backup off hone par bhi mirror chalta rehta hai', () => {
  const status = proBackupStatus();
  assert.equal(status.cloud.enabled, false, 'PRO_VAULT_CLOUD_BACKUP=0');
  assert.equal(status.dbMirror.enabled, true);
  assert.ok(getProVaultSource());
});

// ── 3. UI: button hamesha saamne, dropdown nahi ──────────────────────────
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function waitFor(fn, label) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
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
const account = { key: 'mine', name: 'Mine', phone: '9123456789', owner: 'self', canClaim: true, canRemove: true, status: 'READY', selectable: true, active: true, offerTracks: [] };
function state(extra = {}) {
  return {
    ok: true, user: { name: 'Test', isBoss: false }, accounts: [account], activeAccount: account, selectedAddress: receiver,
    cart: null, checkout: null, checkoutEnabled: true, backup: null, ...extra
  };
}

test('DOM: group cart ka input aur button bina kisi click ke saamne hain', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? state() : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="group-cart"]'), 'group cart form');
    const form = app.document.querySelector('form[data-form="group-cart"]');
    const input = form.querySelector('input[name="url"]');
    assert.ok(input, 'input saamne hai');
    assert.equal(input.getAttribute('type'), 'text', 'swiggy:// deep link bhi paste ho sake');
    assert.equal(input.getAttribute('inputmode'), 'url');
    const submit = form.querySelector('button[type="submit"]');
    assert.equal(submit.disabled, false, 'button active hai');
    assert.match(submit.textContent, /Cart parse karein/);
    // Koi dropdown/toggle nahi.
    assert.equal(app.document.querySelector('[data-action="toggle-group-cart"]'), null);
    assert.equal(/state\.groupCartOpen/.test(appSource), false);
  } finally { app.close(); }
});

test('DOM: link paste karke parse karne par request jaati hai aur cart khulta hai', async () => {
  const cart = { restaurantId: '201', restaurantName: 'Pizza Junction', restaurantArea: 'Kothrud', restaurantTime: '25 min', forSomeoneElse: true, quote: null, items: [{ lineKey: 'l', name: 'Margherita', price: 137, qty: 2, isVeg: true }] };
  const app = harness({ responder: call => {
    if (call.url.endsWith('/cart/import-group')) return { ok: true, cart };
    // Round 11: cart khulte hi bill automatic aata hai — wahi jawab do.
    if (call.url.endsWith('/cart/sync')) return { ok: true, cart, selectedAddress: state().selectedAddress };
    return state();
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="group-cart"]'), 'group cart form');
    const form = app.document.querySelector('form[data-form="group-cart"]');
    form.querySelector('input[name="url"]').value = 'swiggy://gc?shared_cart_id=123456';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/import-group')), 'import call');
    const call = app.calls.find(c => c.url.endsWith('/cart/import-group'));
    assert.equal(call.body.url, 'swiggy://gc?shared_cart_id=123456');
    assert.equal(call.body.replace, false);
    await waitFor(() => app.document.body.textContent.includes('Pizza Junction'), 'cart render');
  } finally { app.close(); }
});

test('DOM: khaali link par seedha message, koi request nahi', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? state() : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="group-cart"]'), 'group cart form');
    app.document.querySelector('form[data-form="group-cart"]').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('#toast')?.textContent.includes('paste'), 'toast');
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/import-group')), false);
  } finally { app.close(); }
});

test('DOM: boss Tools removes backup card without invoking backup or deleting data', async () => {
  const backup = { cloud: { enabled: true, lastOkAt: '', lastError: '' }, dbMirror: { enabled: true, rows: 7, lastAt: '2026-10-31T10:00:00.000Z' }, restored: { count: 2, lastAt: '', lastFrom: 'db-mirror' }, vaultSource: 'DERIVED' };
  const bossState = state({ user: { name: 'Boss', isBoss: true }, backup });
  const app = harness({ responder: call => {
    if (call.url.endsWith('/backup')) return { ok: true, result: { mirrored: true, cloud: { ok: true } }, backup };
    return bossState;
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="tools"]').click();
    await waitFor(() => app.document.querySelector('#content')?.textContent.includes('ID access'), 'tools');
    assert.equal(app.document.querySelector('.backup-card'), null);
    assert.equal(app.document.querySelector('[data-action="backup-now"]'), null);
    assert.equal(app.calls.some(c => c.url.endsWith('/backup')), false);
  } finally { app.close(); }
});

test('user ko backup card nahi dikhta (sirf boss ka)', async () => {
  const app = harness({ responder: call => (call.url.endsWith('/bootstrap') ? state({ backup: { cloud: { enabled: true }, dbMirror: { enabled: true, rows: 3 }, restored: { count: 0 } } }) : state()) });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'accounts');
    app.document.querySelector('[data-action="nav"][data-tab="tools"]').click();
    await waitFor(() => app.document.querySelector('#content'), 'tools');
    assert.equal(app.document.querySelector('.backup-card'), null);
  } finally { app.close(); }
});
