// Offline HTTP/integration tests with a fake Swiggy provider. These do NOT prove
// that any live Swiggy login, address, bill, payment, SMS or order works.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-pro-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(tmp, 'accounts.json');
process.env.BOT_TOKEN = '123456:offline-test-bot-token';
process.env.PRO_VAULT_KEY = 'offline-random-test-key-only';
delete process.env.PRO_ENABLE_CHECKOUT;
// This suite injects a fake provider; it tests both checkout availability and
// preflight behavior even when the parent shell blocks real placement.
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
process.env.BOSS_ID = '7000';
process.env.DB_ASYNC_WRITE = '0';

const { handleSwiggyProHttp, verifyTelegramWebAppInitData } = await import('./swiggy-pro-api.js');
const { expandProShareLink, sameCartItems, sameDeliveryRecipient } = await import('./swiggy-pro-provider.js');
const { bootstrapSwiggyWebSessionFromAndroidTokens } = await import('./swiggy-cart.js');
const { getDb, saveDb } = await import('./store.js');
const db = getDb();
db.config.accounts.shared_test = { id: 'shared_test', isLoggedIn: true, name: 'Boss vault account', phone: '9876543210', token: 'boss-secret-sentinel' };
const sharedGrant = crypto.createHash('sha256').update('pro-account-access:phone:9876543210').digest('hex');
db.config.proAccountGrants = Object.fromEntries(['7001', '7002', '7003', '7011'].map(id => [id, { shared_test: sharedGrant }]));
saveDb(db);

const address = { id: 'address-1', name: 'Receiver', mobile: '9876543210', address: 'Test apartment, Test Road', area: 'Test', city: 'Test City', lat: '18.5204', lng: '73.8567', annotation: 'HOME' };
const menu = { restaurant: { id: '123', name: 'Example restaurant', isOpen: true }, categories: [{ title: 'Food', items: [
  { id: '456', name: 'Meal', price: 125, inStock: true, customizable: false, offer_ids: [] },
  { id: '457', name: 'Custom meal', price: 99, inStock: true, customizable: true, offer_ids: [] }
] }] };
const seen = { quote: [], otp: [] };
let quoteFails = false;
const provider = {
  async verifySession(s) { return s.token === 'unverified' ? { valid: false } : { valid: true, name: 'Test profile', phone: s.phone, customerId: 'profile-' + s.phone }; },
  async addresses() { return [address]; },
  async resolveAddress(_a, link) { assert.match(link, /^https:\/\/swiggy\.onelink\.me/); return { ...address, name: 'Name from link', mobile: '9123456789' }; },
  async search(_a, selected, q) { assert.equal(selected.address, address.address); return [{ id: '123', name: q, isOpen: null }]; },
  async menu() { return structuredClone(menu); },
  async groupCart() { return { restaurantId: '123', restaurantName: 'Example restaurant', items: [{ id: '456', menu_item_id: 456, name: 'Meal', qty: 1, price: 125, addons: [], variants: [] }] }; },
  async quoteCart(_a, selected, cart, coupon) {
    seen.quote.push({ selected, cart: structuredClone(cart), coupon });
    if (quoteFails) { const e = new Error('Simulated provider unavailable'); e.statusCode = 502; throw e; }
    return { address: selected, bill: { itemTotal: 125, deliveryFee: 20, packingCharges: 0, taxes: 5, discount: 0, total: 150, coupon: '' }, ofoConfirmed: false };
  },
  async orders() { return [{ id: '99999999999', status: 'Status unavailable', restaurant: 'Example restaurant', placedAt: '', items: [], amount: 0 }]; }
};
const otp = {
  async request(user, phone, target, name, options) { seen.otp.push({ user, phone, target, name, options }); return { success: true }; },
  async verify() { return { success: true, phone: '9234567890', name: 'OTP User', exportJson: { phone: '9234567890', token: 'otp-secret-sentinel', tid: 'test-tid', sid: 'test-sid' } }; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, otp, authorizeUser: async user => user.id === '7009' ? { allowed: false, message: 'Access is paused' } : { allowed: true } })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

function sign(userId, timestamp = Math.floor(Date.now() / 1000), launchFields = { query_id: 'query' }) {
  const params = new URLSearchParams({ auth_date: String(timestamp), user: JSON.stringify({ id: userId, first_name: `User ${userId}` }), ...launchFields });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
const alice = sign(7001), bob = sign(7002), boss = sign(7000), otpUser = sign(7003);
async function request(route, auth, payload, method = payload === undefined ? 'GET' : 'POST', extraHeaders = {}) {
  const response = await fetch(base + route, { method, headers: { ...(auth ? { 'X-Telegram-Init-Data': auth } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json() };
}

test('only fresh authentic Telegram init data grants access; anonymous boss/client headers do not', async () => {
  assert.equal((await request('/pro/api/bootstrap')).status, 401);
  assert.equal((await request('/pro/api/bootstrap', '', undefined, 'GET', { 'X-Boss-Secret': 'anything', 'X-Pro-Client-Id': '7001' })).status, 401);
  assert.equal((await request('/pro/api/bootstrap', sign(7001, Math.floor(Date.now()/1000) - 90000))).status, 401);
  assert.equal((await request('/pro/api/bootstrap', sign(7001, Math.floor(Date.now()/1000) + 120))).status, 401);
  assert.equal((await request('/pro/api/bootstrap', alice + '&user=%7B%22id%22%3A7000%7D')).status, 401);
  assert.equal((await request('/pro/api/bootstrap', alice.replace('User+7001', 'User+7000'))).status, 401);
  assert.equal((await request('/pro/api/bootstrap', sign(7009))).status, 403);
  assert.equal(verifyTelegramWebAppInitData(alice)?.id, '7001');
});

test('a Main Mini App launch authenticates without query_id and rejects altered launch data', async () => {
  const mainLaunch = sign(7001, Math.floor(Date.now() / 1000), {
    chat_instance: '123456789', chat_type: 'private', start_param: 'demo', signature: 'offline-mock-signature'
  });
  assert.equal(new URLSearchParams(mainLaunch).has('query_id'), false);
  assert.equal(verifyTelegramWebAppInitData(mainLaunch)?.id, '7001');
  const bootstrap = await request('/pro/api/bootstrap', mainLaunch);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.user.name, 'User 7001');
  assert.equal(bootstrap.body.user.isBoss, false);
  assert.equal((await request('/pro/api/bootstrap', mainLaunch.replace('start_param=demo', 'start_param=other'))).status, 401);
});

// 31-10-2026: pehle `PRO_VAULT_KEY` na hone par app DEAD-END tha ("Server setup
// needed", 503). Boss: "ISKO THEEK KAR". Ab key server khud manage karta hai,
// par data ki safety waisi hi hai: purana data galat key se NAHI khulta aur OTP
// tab provider tak nahi jata.
test('vault key khud banti hai (dead-end nahi), par purana data galat key se nahi khulta', async () => {
  const savedPro = process.env.PRO_VAULT_KEY;
  const savedFallback = process.env.VAULT_ENCRYPTION_KEY;
  try {
    delete process.env.PRO_VAULT_KEY;
    delete process.env.VAULT_ENCRYPTION_KEY;

    // (a) NAYA user, koi explicit key nahi → app khulta hai (setup dead-end khatam).
    const fresh = sign(7011);
    const bootstrap = await request('/pro/api/bootstrap', fresh);
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.ok, true);
    // This fixture explicitly grants the operator ID to this user.
    assert.equal(bootstrap.body.accounts.length, 1);
    assert.equal(bootstrap.body.accounts[0].owner, 'operator');
    assert.equal(JSON.stringify(bootstrap.body).includes('boss-secret-sentinel'), false);

    // (b) Us user ka data ban jaye (import) — ab encrypted workspace maujood hai.
    const imported = await request('/pro/api/accounts/import', fresh, { session: { mobile: '9123456789', token: 'vault-sentinel-token', tid: 'vault-tid' } });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.accounts.filter(a => a.owner === 'self').length, 1);

    // (c) Galat key → chupchaap "khaali" nahi, saaf 503 PRO_VAULT_DECRYPT_FAILED.
    process.env.PRO_VAULT_KEY = 'galat-key-jo-purana-data-nahi-kholti';
    const broken = await request('/pro/api/bootstrap', fresh);
    assert.equal(broken.status, 503);
    assert.equal(broken.body.code, 'PRO_VAULT_DECRYPT_FAILED');
    const otpCount = seen.otp.length;
    const send = await request('/pro/api/accounts/send-otp', fresh, { phone: '9234567890' });
    assert.notEqual(send.status, 200);
    assert.equal(seen.otp.length, otpCount);

    // (d) Key hata do → data waisa hi khulta hai (kuch delete nahi hua).
    delete process.env.PRO_VAULT_KEY;
    const back = await request('/pro/api/bootstrap', fresh);
    assert.equal(back.status, 200);
    assert.ok(back.body.accounts.length >= 1);
  } finally {
    if (savedPro === undefined) delete process.env.PRO_VAULT_KEY; else process.env.PRO_VAULT_KEY = savedPro;
    if (savedFallback === undefined) delete process.env.VAULT_ENCRYPTION_KEY; else process.env.VAULT_ENCRYPTION_KEY = savedFallback;
  }
});

test('static app is served without exposing API data; private and boss views stay separate', async () => {
  const page = await fetch(base + '/pro');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /ORDER PLACER/);
  assert.doesNotMatch(html, /Sacha Beta/i);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  // Shared operator row sabko dikhti hai, par uska token kabhi nahi.
  const bobView = (await request('/pro/api/bootstrap', bob)).body;
  assert.equal(bobView.accounts.length, 1);
  assert.equal(bobView.accounts[0].key, 'shared_test');
  assert.equal(bobView.accounts[0].owner, 'operator');
  assert.equal(bobView.accounts[0].canClaim, false);
  assert.equal(bobView.accounts[0].canRemove, false);
  assert.equal(JSON.stringify(bobView).includes('boss-secret-sentinel'), false);
  const b = await request('/pro/api/bootstrap', boss);
  assert.equal(b.body.user.isBoss, true);
  assert.equal(b.body.accounts[0].key, 'shared_test');
  assert.equal(JSON.stringify(b.body).includes('boss-secret-sentinel'), false);
  assert.equal((await request('/pro/api/bootstrap', alice)).body.user.isBoss, false);
});

test('unverified JSON is rejected; verified private sessions stay encrypted and isolated', async () => {
  const invalid = await request('/pro/api/accounts/import', alice, { session: { mobile: '9123456789', token: 'unverified' } });
  assert.equal(invalid.status, 502);
  assert.equal((await request('/pro/api/bootstrap', alice)).body.accounts.filter(a => a.owner === 'self').length, 0);
  const a = await request('/pro/api/accounts/import', alice, { session: { mobile: '9123456789', token: 'alice-secret-sentinel', tid: 'alice-tid' } });
  assert.equal(a.status, 200);
  assert.equal(a.body.accounts.filter(x => x.owner === 'self').length, 1);
  assert.equal(JSON.stringify(a.body).includes('alice-secret-sentinel'), false);
  const privateKey = a.body.activeAccount.key;
  // Alice ka private ID Bob ko kabhi nahi — na row me, na select par.
  assert.equal((await request('/pro/api/accounts/select', bob, { key: privateKey })).status, 404);
  assert.equal((await request('/pro/api/bootstrap', bob)).body.accounts.some(x => x.key === privateKey), false);
  // Operator ka shared ID user select kar sakta hai, par uska number poora nahi.
  const sharedSelect = await request('/pro/api/accounts/select', alice, { key: 'shared_test' });
  assert.equal(sharedSelect.status, 200);
  const sharedRow = sharedSelect.body.accounts.find(x => x.key === 'shared_test');
  assert.equal(sharedRow.phone, '');
  assert.ok(sharedRow.phoneMasked.startsWith('98'));
  assert.equal(sharedRow.phoneMasked.includes('76543'), false);
  const workspaceFile = path.join(tmp, 'pro-workspaces', crypto.createHash('sha256').update('7001').digest('hex') + '.json');
  const encrypted = fs.readFileSync(workspaceFile, 'utf8');
  assert.equal(encrypted.includes('alice-secret-sentinel'), false);
  assert.equal(encrypted.includes('9123456789'), false);
  process.env.PRO_VAULT_KEY = 'offline-test-wrong-key-value';
  const wrongKey = await request('/pro/api/bootstrap', alice);
  assert.equal(wrongKey.status, 503);
  assert.equal(wrongKey.body.code, 'PRO_VAULT_DECRYPT_FAILED');
  assert.equal(fs.readFileSync(workspaceFile, 'utf8'), encrypted);
  process.env.PRO_VAULT_KEY = 'offline-random-test-key-only';
  assert.equal((await request('/pro/api/bootstrap', alice)).status, 200);
});

test('OTP login requests a private session without shared-vault persistence or automatic signup/offers', async () => {
  assert.equal((await request('/pro/api/accounts/send-otp', otpUser, { phone: '9234567890' })).status, 200);
  assert.deepEqual(seen.otp[0].options, { persistAccount: false, allowSignup: false, claimOffers: false });
  assert.equal((await request('/pro/api/accounts/verify-otp', otpUser, { otp: '123456' })).status, 200);
  assert.equal((await request('/pro/api/bootstrap', otpUser)).body.accounts.filter(a => a.owner === 'self').length, 1);
  assert.equal(Object.values(getDb().config.accounts).some(a => a.token === 'otp-secret-sentinel'), false);
});

test('link auto-fill, menu and draft cart keep the receiver and server-provided prices', async () => {
  let out = await request('/pro/api/addresses/resolve', alice, { url: 'https://swiggy.onelink.me/abc/xyz' });
  assert.equal(out.body.address.name, 'Name from link');
  assert.equal(out.body.address.mobile, '9123456789');
  out = await request('/pro/api/addresses/confirm', alice, { name: out.body.address.name, mobile: out.body.address.mobile, address: 'Injected different address' });
  assert.equal(out.body.selectedAddress.address, address.address);
  assert.equal((await request('/pro/api/search?q=Bir', alice)).body.restaurants[0].isOpen, null);
  assert.equal((await request('/pro/api/menu?id=123', alice)).status, 200);
  assert.equal((await request('/pro/api/cart/add', alice, { itemId: '457' })).status, 400);
  out = await request('/pro/api/cart/add', alice, { itemId: '456', price: 1 });
  assert.equal(out.body.cart.items[0].price, 125);
  assert.equal(out.body.cart.quote, null);
  assert.equal((await request('/pro/api/cart/sync', alice, { forSomeoneElse: true })).status, 400);
  assert.equal(seen.quote.length, 0);
  out = await request('/pro/api/cart/sync', alice, { confirmReplaceSwiggyCart: true, forSomeoneElse: true, address: 'attacker' });
  assert.equal(out.status, 200);
  assert.equal(out.body.cart.quote.total, 150);
  assert.equal(out.body.cart.quote.ofoConfirmed, false);
  assert.equal(seen.quote[0].selected.mobile, '9123456789');
  assert.equal(seen.quote[0].selected.address, address.address);
});

test('provider failures clear old quotes; checkout never starts without a fresh quote', async () => {
  quoteFails = true;
  assert.equal((await request('/pro/api/cart/sync', alice, { confirmReplaceSwiggyCart: true, forSomeoneElse: true })).status, 502);
  assert.equal((await request('/pro/api/bootstrap', alice)).body.cart.quote, null);
  // Boss (31-10-2026, round 3): in-app checkout default ON hai, par bina
  // taaza bill ke ek bhi order request nahi jaati.
  const checkout = await request('/pro/api/checkout', alice, {});
  assert.equal([400, 409].includes(checkout.status), true, `unexpected ${checkout.status}`);
  assert.match(checkout.body.error, /quote|bill|receiver|reconnect/i);
  assert.equal((await request('/pro/api/orders', alice)).body.orders[0].status, 'Status unavailable');
});

test('share links reject internal and non-Swiggy hosts before any network request', async () => {
  await assert.rejects(() => expandProShareLink('https://127.0.0.1/private'), /Only HTTPS Swiggy/);
  await assert.rejects(() => expandProShareLink('https://swiggy.com.attacker.invalid/'), /Only HTTPS Swiggy/);
  await assert.rejects(() => expandProShareLink('http://swiggy.com/ofo/address/x/token'), /Only HTTPS Swiggy/);
  assert.match(await expandProShareLink('https://www.swiggy.com/ofo/address/Name/token'), /ofo\/address/);
});

test('quote verification rejects changed add-ons, variants, quantities and unknown IDs', () => {
  const base = [{ menu_item_id: 456, qty: 1, variants: [{ group_id: '5', variation_id: '7' }], addons: [{ group_id: '1', choice_id: '2' }] }];
  assert.equal(sameCartItems(base, structuredClone(base)), true);
  const differentAddon = structuredClone(base); differentAddon[0].addons[0].choice_id = '3';
  assert.equal(sameCartItems(base, differentAddon), false);
  const differentVariant = structuredClone(base); differentVariant[0].variants[0].variation_id = '8';
  assert.equal(sameCartItems(base, differentVariant), false);
  const missing = structuredClone(base); missing[0].addons = [];
  assert.equal(sameCartItems(base, missing), false);
  const changedQty = structuredClone(base); changedQty[0].qty = 2;
  assert.equal(sameCartItems(base, changedQty), false);
  const invalid = structuredClone(base); invalid[0].variants = [{ group_id: '5' }];
  assert.equal(sameCartItems(invalid, invalid), false);
});

test('private session bootstrap cannot overwrite a boss account with the same phone', async () => {
  const before = getDb().config.accounts.shared_test;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    text: async () => '',
    headers: { getSetCookie: () => ['_session_tid=isolated-cookie; Path=/; Secure'] }
  });
  try {
    const privateAccount = { phone: before.phone, token: 'private-token', tid: 'dummy.jwt.value', customerId: 'different-id', __proPrivate: true };
    const cookies = await bootstrapSwiggyWebSessionFromAndroidTokens(privateAccount);
    assert.match(cookies, /isolated-cookie/);
    const after = getDb().config.accounts.shared_test;
    assert.equal(after.token, before.token);
    assert.equal(after.cookies || '', before.cookies || '');
    assert.equal(after.customerId || '', before.customerId || '');
  } finally { globalThis.fetch = savedFetch; }
});

test('Telegram /pro entry uses only the configured HTTPS URL and leaves chat available', async () => {
  process.env.TEST_MODE = '1';
  process.env.PRO_MINIAPP_URL = 'https://example.test/pro';
  const { bot } = await import('./index.js');
  const calls = [];
  const fakeCall = async (method, payload = {}) => {
    calls.push({ method, payload });
    if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
    return { message_id: 1, date: Math.floor(Date.now()/1000), chat: { id: 7001, type: 'private' } };
  };
  bot.telegram.callApi = fakeCall;
  Object.getPrototypeOf(bot.telegram).callApi = fakeCall;
  const update = (id) => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now()/1000), chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false, first_name: 'Test' }, text: '/pro', entities: [{ offset: 0, length: 4, type: 'bot_command' }] } });
  await bot.handleUpdate(update(100));
  // The bot dispatcher accepts updates asynchronously.
  await new Promise(resolve => setTimeout(resolve, 100));
  const sent = calls.find(c => c.method === 'sendMessage');
  assert.equal(sent?.payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url, 'https://example.test/pro');
  assert.equal(sent?.payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.text, '🍽 Open App');
  assert.match(sent.payload.text, /UPI QR aur order status/);
  calls.length = 0;
  process.env.PRO_MINIAPP_URL = 'http://localhost:4173/pro';
  await bot.handleUpdate(update(101));
  await new Promise(resolve => setTimeout(resolve, 100));
  const noUrl = calls.find(c => c.method === 'sendMessage');
  assert.match(noUrl?.payload?.text || '', /configure nahi/);
  assert.equal(noUrl?.payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app, undefined);
  delete process.env.PRO_MINIAPP_URL;
});

test('chat menu uses the configured HTTPS app and preserves a manually configured menu when absent or invalid', async () => {
  process.env.TEST_MODE = '1';
  const { bot, configureTelegramBotMenu } = await import('./index.js');
  const calls = [];
  const telegram = {
    async setMyCommands(commands) { calls.push({ method: 'commands', commands }); },
    async setChatMenuButton(payload) { calls.push({ method: 'menu', payload }); }
  };

  assert.equal(await configureTelegramBotMenu(telegram, 'https://example.test/pro'), true);
  assert.deepEqual(calls.find(c => c.method === 'menu')?.payload, {
    menuButton: { type: 'web_app', text: 'Open', web_app: { url: 'https://example.test/pro' } }
  });
  assert(calls.find(c => c.method === 'commands').commands.some(c => c.command === 'pro'));

  for (const url of ['', 'http://example.test/pro', 'https://127.0.0.1/pro', 'https://user:password@example.test/pro', 'https://example.test/pro?x=1']) {
    calls.length = 0;
    assert.equal(await configureTelegramBotMenu(telegram, url), true);
    assert.equal(calls.some(c => c.method === 'menu'), false);
    assert.equal(calls.find(c => c.method === 'commands').commands.some(c => c.command === 'pro'), false);
  }

  // Verify Telegraf's actual API serialization, with no network call.
  const apiCalls = [];
  const originalCallApi = bot.telegram.callApi;
  bot.telegram.callApi = async (method, payload) => { apiCalls.push({ method, payload }); return true; };
  try {
    await configureTelegramBotMenu(bot.telegram, 'https://example.test/pro');
    assert.deepEqual(apiCalls.find(c => c.method === 'setChatMenuButton')?.payload.menu_button, {
      type: 'web_app', text: 'Open', web_app: { url: 'https://example.test/pro' }
    });
  } finally { bot.telegram.callApi = originalCallApi; }

  // In long-polling mode bot.launch() stays pending while the bot runs.
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function startBotWithRetry()');
  const setup = source.indexOf('setupBotMenu().catch(', start);
  const polling = source.indexOf('await bot.launch(', start);
  assert(start >= 0 && setup > start && polling > setup, 'menu setup must start before the long-lived polling promise');
});

test('address verification rejects another receiver, missing phone and shifted pin', () => {
  assert.equal(sameDeliveryRecipient(address, { ...address }), true);
  assert.equal(sameDeliveryRecipient(address, { ...address, mobile: '9234567890' }), false);
  assert.equal(sameDeliveryRecipient(address, { ...address, mobile: '' }), false);
  assert.equal(sameDeliveryRecipient(address, { ...address, name: 'Other' }), false);
  assert.equal(sameDeliveryRecipient(address, { ...address, address: 'Other street' }), false);
  assert.equal(sameDeliveryRecipient(address, { ...address, lat: '18.5304' }), false);
});
