// Isolated offline simulations only. No real Telegram, Swiggy order, payment,
// recipient SMS or provider contract is verified by these tests.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-miniapp-offline-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-handoff-token', PRO_VAULT_KEY: 'offline-handoff-key-123456789',
  PRO_MINIAPP_URL: 'https://example.test/pro', PRO_ENABLE_CHECKOUT: '1', BOSS_ID: '9001',
  TEST_MODE: '1', NODE_ENV: 'test', SIMPLE_CHAT_MODE: '1', DB_ASYNC_WRITE: '0'
});
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
delete process.env.GITHUB_VAULT_TOKEN;
const { bot } = await import('./index.js');
const { setChannelGateMock } = await import('./channel-gate.js');
const { getDb, saveDb, clearDraft } = await import('./store.js');
const { readChatHandoff, saveChatHandoffLinks, parseChatShareLinks, safeSwiggyShareUrl } = await import('./chat-miniapp-handoff.js');
const { readProWorkspace, writeProWorkspace, openProHandoff, workspaceHasContent, resetProWorkspaceHydrationCache } = await import('./swiggy-pro-store.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { creditWallet, walletBalancePaise } = await import('./user-wallet.js');
const { executeSingleSwiggyPlacement, readSwiggyPlacement } = await import('./swiggy-placement-journal.js');
setChannelGateMock(true);

const telegramCalls = [];
const fakeCallApi = async (method, payload = {}) => {
  telegramCalls.push({ method, payload });
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'Offline', username: 'offline_bot' };
  if (['sendMessage', 'editMessageText', 'editMessageCaption'].includes(method)) {
    return { message_id: payload.message_id || telegramCalls.length, chat: { id: payload.chat_id }, text: payload.text || '' };
  }
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;
let updateId = 0;
async function send(userId, text) {
  const from = { id: userId, is_bot: false, first_name: 'Demo' };
  await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now()/1000),
    chat: { id: userId, type: 'private' }, from, text } });
  await new Promise(r => setTimeout(r, 25));
}
async function tap(userId, data) {
  const from = { id: userId, is_bot: false, first_name: 'Demo' };
  await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), from, chat_instance: '1', data,
    message: { message_id: 1, date: Math.floor(Date.now()/1000), chat: { id: userId, type: 'private' }, text: 'x' } } });
  await new Promise(r => setTimeout(r, 25));
}

const cartLink = 'https://www.swiggy.com/gc/offline-cart';
const addressLink = 'https://www.swiggy.com/ofo/address/Receiver/offline-address';
const receiver = { name: 'Ammi', mobile: '9123456789', address: 'Offline Test Road 1', area: 'Area', city: 'Pune', lat: '18.5204', lng: '73.8567' };
const calls = [];
let failAddress = false, failCart = false, failQuote = false, placeCalls = 0;
const fake = {
  async verifySession(a) {
    calls.push({ kind: 'verify', token: a.token });
    if (a.token === 'unavailable') return { valid: false };
    return { valid: true, customerId: `customer-${a.token}`, phone: a.phone };
  },
  async resolveAddress(a, link) {
    calls.push({ kind: 'address', token: a.token, link });
    if (failAddress) { failAddress = false; throw Object.assign(new Error('Address offline failure'), { statusCode: 502 }); }
    return { ...receiver };
  },
  async groupCart(a, address, link) {
    calls.push({ kind: 'cart', token: a.token, link, address });
    if (failCart) { failCart = false; throw Object.assign(new Error('Cart offline failure'), { statusCode: 502 }); }
    return { restaurantId: '123', restaurantName: 'Offline restaurant', items: [
      { menu_item_id: 456, id: '456', name: 'Meal', qty: 1, price: 125, variants: [], addons: [], inStock: true }
    ] };
  },
  async quoteCart(a, address, cart, coupon) {
    calls.push({ kind: 'quote', token: a.token, quick: cart.quickBill, autoOneLite: cart.autoOneLite, coupon });
    if (failQuote) { failQuote = false; throw Object.assign(new Error('Bill offline failure'), { statusCode: 502 }); }
    return { address: { ...address, id: 'saved-address' }, bill: {
      itemTotal: 125, deliveryFee: 20, packingCharges: 0, taxes: 5.25, discount: 0,
      total: 150.25, coupon: '', subscriptionItems: []
    }, ofoConfirmed: false };
  },
  async checkout(a, address, cart, key) {
    const out = await executeSingleSwiggyPlacement(key, async () => {
      placeCalls++;
      calls.push({ kind: 'checkout', token: a.token, address, cart });
      return { placeRes: { ok: true, status: 200 }, json: { statusCode: 0, data: { order_id: '123456789012' } } };
    });
    assert.equal(out.placeRes.ok, true);
    return { orderId: '123456789012', paymentTxnId: 'offline',
      upiIntentUrl: 'upi://pay?pa=upiswiggy%40icici&am=150.25&cu=INR&tr=offline', ofoConfirmed: false };
  },
  async checkPayment(a) { calls.push({ kind: 'status', customerId: a.customerId, token: a.token }); return { paid: false, paymentVerified: false }; },
  async orders() { return []; },
  async tracking() { return null; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fake, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function sign(user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id: Number(user), first_name: 'Demo' }), query_id: 'offline' });
  const text = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(text).digest('hex'));
  return params.toString();
}
async function req(user, route, body) {
  const r = await fetch(`${base}/pro/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': sign(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
}
function seed(user, accounts = { privateA: { phone: '9234567890', token: 'session-a', name: 'Private ID', isLoggedIn: true } }, extra = {}) {
  writeProWorkspace(String(user), { version: 1, accounts, activeAccountKey: '', selectedAddress: null, addressCandidates: [], cart: null, ...extra });
}
function fund(user) { const db = getDb(); creditWallet(db, String(user), 1500, { reason: 'offline test', actor: 'test' }); saveDb(db); }
after(async () => { await new Promise(resolve => server.close(resolve)); resetProWorkspaceHydrationCache(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('chat accepts separate/together links, encrypts them, preserves drafts and never starts a bill', async () => {
  const beforeOrders = Object.keys(getDb().orders).length;
  const db = getDb(); db.drafts['5101'] = { legacy: 'keep', cart: 'old-chat-draft' }; saveDb(db);
  await send(5101, cartLink);
  assert.equal(readChatHandoff(5101).cartUrl, cartLink);
  assert.equal(readChatHandoff(5101).addressUrl, '');
  await send(5101, addressLink);
  const one = readChatHandoff(5101);
  assert.equal(one.addressUrl, addressLink);
  assert.equal(getDb().drafts['5101'].legacy, 'keep');
  assert.equal(getDb().drafts['5101'].cart, 'old-chat-draft');
  assert.doesNotMatch(JSON.stringify(getDb().drafts['5101'].miniAppLinks), /offline-cart|offline-address/);
  assert.throws(() => openProHandoff(5102, getDb().drafts['5101'].miniAppLinks.encrypted));
  await send(5102, `${addressLink}\n${cartLink}`);
  assert.equal(readChatHandoff(5102).cartUrl, cartLink);
  assert.notEqual(readChatHandoff(5101).id, readChatHandoff(5102).id);
  assert.equal(Object.keys(getDb().orders).length, beforeOrders);
  assert.equal(calls.length, 0, 'chat never asks provider for address, cart or bill');
  assert(telegramCalls.some(c => String(c.payload.chat_id) === '5101' && JSON.stringify(c.payload.reply_markup || {}).includes('https://example.test/pro')));
  assert(telegramCalls.some(c => String(c.payload.chat_id) === '5102' && String(c.payload.text || '').includes('Mini App')));
});

test('legacy draft cleanup does not erase newer links unless the user explicitly cancels', () => {
  saveChatHandoffLinks(5190, { cart: cartLink, address: addressLink });
  clearDraft(5190);
  assert.equal(readChatHandoff(5190).cartUrl, cartLink);
  clearDraft(5190, { clearMiniAppLinks: true });
  assert.equal(readChatHandoff(5190), null);
});

test('production link handoff still works when legacy screen mode is selected', async () => {
  const oldTest = process.env.TEST_MODE, oldSimple = process.env.SIMPLE_CHAT_MODE;
  process.env.TEST_MODE = '0'; process.env.SIMPLE_CHAT_MODE = '0';
  try {
    await send(5191, `${cartLink}\n${addressLink}`);
    assert.equal(readChatHandoff(5191).cartUrl, cartLink);
    assert.equal(readChatHandoff(5191).addressUrl, addressLink);
  } finally { process.env.TEST_MODE = oldTest; process.env.SIMPLE_CHAT_MODE = oldSimple; }
});

test('opaque links are explicitly classified; unsafe hosts are not handed to provider', async () => {
  const a = 'https://swiggy.onelink.me/opaque/aaa111';
  const b = 'https://swiggy.onelink.me/opaque/bbb222';
  assert.equal(parseChatShareLinks(`${a} ${b}`).ambiguous.length, 2);
  assert.equal(parseChatShareLinks('https://swig.gy/opaque-short').ambiguous.length, 1, 'opaque short URLs are not guessed as carts');
  await send(5103, `${a} ${b}`);
  assert.equal(readChatHandoff(5103), null);
  const buttons = () => telegramCalls.filter(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '5103' && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('mini_link_')).at(-1).payload.reply_markup.inline_keyboard[0];
  const first = buttons();
  await tap(5103, first[1].callback_data);
  const second = buttons();
  assert.notEqual(first[0].callback_data, second[0].callback_data);
  await tap(5103, first[0].callback_data); // stale button cannot classify b
  assert.equal(readChatHandoff(5103), null);
  await tap(5103, second[0].callback_data);
  assert.equal(readChatHandoff(5103).addressUrl, a);
  assert.equal(readChatHandoff(5103).cartUrl, b);
  assert.equal(safeSwiggyShareUrl('https://swiggy.com.evil.test/gc/x'), '');
  assert.equal(safeSwiggyShareUrl('http://www.swiggy.com/gc/x'), '');
  await send(5104, 'https://swiggy.com.evil.test/gc/x');
  assert.equal(readChatHandoff(5104), null);
  assert.equal(calls.length, 0);
});

test('authenticated handoff supports auto choice, failures, resume, recipient autofill and explicit cart consent', async () => {
  seed(5101, {
    unknown: { phone: '9234567890', token: 'session-unknown', name: 'Unknown', isLoggedIn: true },
    ready: { phone: '9345678901', token: 'session-ready', name: 'Ready', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0 },
    unavailable: { phone: '9456789012', token: 'unavailable', name: 'Offline', isLoggedIn: true }
  });
  const id = readChatHandoff(5101).id;
  let r = await req(5102, 'chat-handoff/start', { handoffId: id });
  assert.equal(r.status, 409, 'another user cannot consume this handoff');
  r = await req(5101, 'bootstrap');
  assert.equal(r.body.chatHandoff.pendingId, id);
  assert.equal(r.body.activeAccount, null, 'no silent ID selection for new handoff');
  assert.doesNotMatch(JSON.stringify(r.body), /offline-cart|offline-address|session-ready/);
  r = await req(5101, 'chat-handoff/start', { handoffId: id });
  assert.equal(r.status, 200); assert.equal(r.body.chatHandoff.stage, 'ACCOUNT');
  r = await req(5101, 'chat-handoff/select', { handoffId: id, key: 'not-my-id' });
  assert.equal(r.status, 404);
  r = await req(5101, 'chat-handoff/select', { handoffId: id, key: 'unavailable' });
  assert.equal(r.status, 409); assert.equal(readProWorkspace('5101').chatFlow.stage, 'ACCOUNT');
  r = await req(5101, 'chat-handoff/select', { handoffId: id, auto: true });
  assert.equal(r.status, 200); assert.equal(r.body.activeAccount.key, 'ready');
  assert.equal(r.body.chatHandoff.stage, 'ADDRESS');
  failAddress = true;
  r = await req(5101, 'chat-handoff/address', { handoffId: id });
  assert.equal(r.status, 502); assert.equal(readProWorkspace('5101').chatFlow.stage, 'ADDRESS');
  r = await req(5101, 'chat-handoff/address', { handoffId: id });
  assert.equal(r.status, 200); assert.equal(r.body.chatHandoff.address.name, receiver.name);
  assert.equal(r.body.chatHandoff.address.mobile, receiver.mobile);
  const addressCount = calls.filter(c => c.kind === 'address').length;
  await req(5101, 'chat-handoff/address', { handoffId: id });
  assert.equal(calls.filter(c => c.kind === 'address').length, addressCount, 'retry does not consume link twice');
  r = await req(5101, 'bootstrap'); assert.equal(r.body.chatHandoff.address.address, receiver.address);
  r = await req(5101, 'chat-handoff/confirm-address', { handoffId: id, name: receiver.name, mobile: receiver.mobile });
  assert.equal(r.status, 400);
  r = await req(5101, 'chat-handoff/confirm-address', { handoffId: id, confirmAddress: true, name: receiver.name, mobile: receiver.mobile });
  assert.equal(r.status, 200); assert.equal(r.body.chatHandoff.stage, 'CART');
  failCart = true;
  r = await req(5101, 'chat-handoff/cart', { handoffId: id }); assert.equal(r.status, 502);
  r = await req(5101, 'chat-handoff/cart', { handoffId: id }); assert.equal(r.status, 200);
  assert.equal(r.body.cart.items[0].name, 'Meal');
  assert.equal(r.body.cart.quote, null);
  const quotedBefore = calls.filter(c => c.kind === 'quote').length;
  r = await req(5101, 'chat-handoff/bill', { handoffId: id });
  assert.equal(r.status, 400); assert.equal(calls.filter(c => c.kind === 'quote').length, quotedBefore);
  failQuote = true;
  r = await req(5101, 'chat-handoff/bill', { handoffId: id, confirmReplaceSwiggyCart: true }); assert.equal(r.status, 502);
  assert.equal(readProWorkspace('5101').cart.quote, null);
  r = await req(5101, 'chat-handoff/bill', { handoffId: id, confirmReplaceSwiggyCart: true });
  assert.equal(r.status, 200); assert.equal(r.body.chatHandoff.stage, 'BILL');
  assert.equal(r.body.cart.quote.total, 150.25);
  assert.equal(r.body.cart.quote.quickBill, true);
  const quoteCall = calls.filter(c => c.kind === 'quote').at(-1);
  assert.equal(quoteCall.quick, true); assert.equal(quoteCall.autoOneLite, false);
  assert.equal(r.body.selectedAddress.name, receiver.name);
  assert.equal(placeCalls, 0);
});

test('handoff checkout preserves consent, wallet gate, exact quote and single-placement barrier', async () => {
  const quote = readProWorkspace('5101').cart.quote;
  const confirm = { confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt };
  let r = await req(5101, 'checkout', { expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt });
  assert.equal(r.status, 400); assert.equal(placeCalls, 0);
  r = await req(5101, 'checkout', { ...confirm, expectedTotal: 150.26 });
  assert.equal(r.status, 400); assert.equal(placeCalls, 0);
  r = await req(5101, 'checkout', confirm);
  assert.equal(r.body.code, 'WALLET_LOW_BALANCE'); assert.equal(placeCalls, 0);
  fund(5101);
  const both = await Promise.all([req(5101, 'checkout', confirm), req(5101, 'checkout', confirm)]);
  assert.equal(both.filter(x => x.status === 200).length, 1);
  assert.equal(placeCalls, 1);
  assert.equal(walletBalancePaise(getDb(), '5101'), 0);
  assert.equal(readSwiggyPlacement('pro:5101:0').state, 'PROVIDER_ACCEPTED');
  const workspace = readProWorkspace('5101');
  assert.equal(workspace.checkout.status, 'PAYMENT_PENDING');
  assert.equal(workspace.checkout.receiverPhone, receiver.mobile);
  assert.equal(calls.find(c => c.kind === 'checkout').cart.forSomeoneElse, true);
  r = await req(5101, 'checkout/status', {});
  assert.equal(r.status, 200);
  assert.equal(calls.filter(c => c.kind === 'status').at(-1).customerId, 'customer-session-ready');
});

test('existing Mini App/chat orders and drafts are never silently replaced', async () => {
  seed(5102, undefined, { checkout: { status: 'OUTCOME_UNKNOWN', accountKey: 'privateA', message: 'Maybe placed' } });
  const id2 = readChatHandoff(5102).id;
  let r = await req(5102, 'chat-handoff/start', { handoffId: id2 });
  assert.equal(r.status, 409); assert.equal(readProWorkspace('5102').checkout.status, 'OUTCOME_UNKNOWN');

  const uid = 5105;
  saveChatHandoffLinks(uid, { cart: cartLink, address: addressLink });
  const db = getDb(); db.orders['offline-active'] = { id: 'offline-active', userId: String(uid), status: 'PENDING' }; saveDb(db);
  seed(uid);
  const id5 = readChatHandoff(uid).id;
  r = await req(uid, 'chat-handoff/start', { handoffId: id5 });
  assert.equal(r.status, 409); assert.equal(getDb().orders['offline-active'].status, 'PENDING');

  const other = 5106;
  const oldCart = { restaurantId: 'old', items: [{ name: 'Old meal', qty: 1 }] };
  seed(other, undefined, { selectedAddress: { ...receiver }, cart: oldCart });
  saveChatHandoffLinks(other, { cart: cartLink, address: addressLink });
  const id6 = readChatHandoff(other).id;
  r = await req(other, 'chat-handoff/start', { handoffId: id6 });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'DRAFT_EXISTS');
  assert.equal(readProWorkspace(String(other)).cart.restaurantId, 'old');
  r = await req(other, 'chat-handoff/start', { handoffId: id6, confirmReplaceDraft: true });
  assert.equal(r.status, 200); assert.equal(r.body.chatHandoff.stage, 'ACCOUNT');
  assert.equal(readProWorkspace(String(other)).handoffDraftBackups[0].cart.restaurantId, 'old');
  assert.equal(workspaceHasContent({ chatFlow: { id: 'only-handoff' } }), true);
  saveChatHandoffLinks(other, { cart: 'https://www.swiggy.com/gc/new-cart' });
  assert.equal(readChatHandoff(other).addressUrl, '', 'new order does not inherit previous address link');
  assert.equal(readProWorkspace(String(other)).chatFlow.id, id6, 'in-progress workspace remains resumable');
});

test('manual used-ID selection requires consent; shared session identity remains bound for recovery', async () => {
  const uid = 5107;
  const db = getDb(); db.config.accounts.shared = { phone: '9567890123', token: 'shared-session', name: 'Operator ID', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 2 };
  db.knownUsers[String(uid)] = { id: String(uid), firstName: 'Family', lastSeen: Date.now() }; saveDb(db);
  seed(uid, {});
  saveChatHandoffLinks(uid, { cart: cartLink, address: addressLink });
  const id = readChatHandoff(uid).id;
  let r = await req(uid, 'bootstrap'); assert.equal(r.body.accounts[0].key, 'shared', 'operator ID is shared by default');
  r = await req(uid, 'accounts/select', { key: 'shared' }); assert.equal(r.body.code, 'ACCOUNT_NEEDS_CONFIRM');
  r = await req(uid, 'accounts/session?key=shared'); assert.equal(r.status, 403, 'shared sessions are never exported');
  r = await req(uid, 'boss/account-access', { userId: String(uid), accountKey: 'shared', allow: true, confirm: true }); assert.equal(r.status, 403);
  r = await req(9001, 'boss/account-access', { userId: String(uid), accountKey: 'shared', allow: true }); assert.equal(r.status, 400);
  r = await req(9001, 'boss/account-access', { userId: '5999', accountKey: 'shared', allow: true, confirm: true }); assert.equal(r.status, 400);
  const staleBeforeGrant = getDb();
  r = await req(9001, 'boss/account-access', { userId: String(uid), accountKey: 'shared', allow: true, confirm: true });
  assert.equal(r.status, 200); assert(r.body.access.users.find(u => u.id === String(uid)).allowed.includes('shared'));
  saveDb(staleBeforeGrant);
  r = await req(uid, 'bootstrap'); assert.equal(r.body.accounts[0].key, 'shared', 'stale save does not erase an unrelated grant');
  assert((await req(5108, 'bootstrap')).body.accounts.some(a => a.key === 'shared'), 'other users also receive default shared access');
  const changed = getDb(); changed.config.accounts.shared.phone = '9678901234'; saveDb(changed);
  assert((await req(uid, 'bootstrap')).body.accounts.some(a => a.key === 'shared'), 'default sharing also covers replacement identities');
  const restored = getDb(); restored.config.accounts.shared.phone = '9567890123'; saveDb(restored);
  r = await req(uid, 'chat-handoff/start', { handoffId: id }); assert.equal(r.status, 200);
  r = await req(uid, 'chat-handoff/select', { handoffId: id, auto: true }); assert.equal(r.status, 404);
  r = await req(uid, 'chat-handoff/select', { handoffId: id, key: 'shared' }); assert.equal(r.body.code, 'ACCOUNT_NEEDS_CONFIRM');
  r = await req(uid, 'chat-handoff/select', { handoffId: id, key: 'shared', confirmUsed: true });
  assert.equal(r.status, 200); assert.doesNotMatch(JSON.stringify(r.body), /shared-session/);
  await req(uid, 'chat-handoff/address', { handoffId: id });
  await req(uid, 'chat-handoff/confirm-address', { handoffId: id, confirmAddress: true, name: receiver.name, mobile: receiver.mobile });
  await req(uid, 'chat-handoff/cart', { handoffId: id });
  r = await req(uid, 'chat-handoff/bill', { handoffId: id, confirmReplaceSwiggyCart: true }); assert.equal(r.status, 200);
  fund(uid);
  r = await req(uid, 'checkout', { confirmCheckout: true, expectedTotal: r.body.cart.quote.total, quoteFetchedAt: r.body.cart.quote.fetchedAt });
  assert.equal(r.status, 200); assert.equal(r.body.checkout.status, 'PAYMENT_PENDING');
  r = await req(uid, 'checkout/status', {}); assert.equal(r.status, 200);
  assert.equal(calls.filter(c => c.kind === 'status').at(-1).customerId, 'customer-shared-session');
  assert.equal(getDb().config.accounts.shared.customerId, undefined, 'no private binding written into boss vault');
  const staleBeforeRevoke = getDb();
  r = await req(9001, 'boss/account-access', { userId: String(uid), accountKey: 'shared', allow: false, confirm: true }); assert.equal(r.status, 200);
  saveDb(staleBeforeRevoke);
  r = await req(uid, 'bootstrap'); assert.equal(r.body.accounts.length, 0, 'stale writer cannot undo a revoke');
  r = await req(uid, 'addresses'); assert.deepEqual(r.body.addresses, [], 'revoked shared ID never exposes saved addresses');
  r = await req(uid, 'search?q=test'); assert.notEqual(r.status, 200, 'revoked ID cannot be used for new provider requests');
  r = await req(uid, 'checkout/status', {}); assert.equal(r.status, 200, 'existing order remains recoverable');
  r = await req(uid, 'orders/tracking?scope=checkout&id=999999999999'); assert.equal(r.status, 403, 'recovery does not enable arbitrary tracking');
});

async function waitFor(fn, label) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail(`Timed out: ${label}`);
}
test('Mini App UI walks from links to ID, fetched address, cart, consent and provider bill', async () => {
  const uid = 5108;
  seed(uid, { self: { phone: '9234567890', token: 'ui-session', name: 'UI ID', isLoggedIn: true, ordersVerifiedLive: true, totalOrdersCount: 0 } });
  saveChatHandoffLinks(uid, { cart: cartLink, address: addressLink });
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.Telegram = { WebApp: { initData: sign(uid), ready() {}, expand() {} } };
  w.scrollTo = () => {};
  w.fetch = (url, options) => fetch(base + String(url), options);
  w.eval(script);
  try {
    await waitFor(() => d.querySelector('[data-action="handoff-start"]'), 'chat links');
    d.querySelector('[data-action="handoff-start"]').click();
    await waitFor(() => d.querySelector('[data-action="handoff-auto"]:not([disabled])'), 'ID picker');
    d.querySelector('[data-action="handoff-auto"]').click();
    await waitFor(() => d.querySelector('form[data-form="handoff-address"]'), 'fetched address form');
    assert.equal(d.querySelector('[name="receiver_name"]').value, receiver.name);
    assert.equal(d.querySelector('[name="receiver_mobile"]').value, receiver.mobile);
    d.querySelector('form[data-form="handoff-address"]').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => d.querySelector('[data-action="handoff-bill"]'), 'fetched cart');
    const before = calls.filter(c => c.kind === 'quote').length;
    d.querySelector('[data-action="handoff-bill"]').click();
    await waitFor(() => d.querySelector('.confirm-dialog'), 'cart replace dialog');
    d.querySelector('.confirm-dialog .button.soft').click();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(calls.filter(c => c.kind === 'quote').length, before, 'cancel does not sync');
    d.querySelector('[data-action="handoff-bill"]').click();
    await waitFor(() => d.querySelector('.confirm-dialog .button.primary'), 'confirm cart replacement');
    d.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => d.querySelector('[data-action="checkout-start"]'), 'real-provider-shaped bill');
    assert.match(d.body.textContent, /150\.25/);
    assert.match(d.body.textContent, /offers abhi check nahi/i);
    assert.equal(calls.filter(c => c.kind === 'quote').length, before + 1);
    assert(d.querySelector('[data-action="handoff-offers"]'));
    assert.equal(placeCalls, 2, 'opening bill is not an order');
  } finally { w.close(); }
});

test('Boss can allow and revoke one user ID from the Mini App Tools screen', async () => {
  const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.Telegram = { WebApp: { initData: sign(9001), ready() {}, expand() {} } };
  w.scrollTo = () => {};
  w.fetch = (url, options) => fetch(base + String(url), options);
  w.eval(script);
  try {
    await waitFor(() => d.querySelector('[data-action="nav"][data-tab="tools"]:not([disabled])'), 'Boss app');
    d.querySelector('[data-action="nav"][data-tab="tools"]').click();
    await waitFor(() => d.querySelector('[data-input="access-user"]'), 'access user list');
    const picker = d.querySelector('[data-input="access-user"]');
    picker.value = '5107'; picker.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitFor(() => d.querySelector('[data-action="access-toggle"][data-key="shared"][data-allow="1"]'), 'allow button');
    d.querySelector('[data-action="access-toggle"][data-key="shared"]').click();
    await waitFor(() => d.querySelector('.confirm-dialog .button.primary'), 'allow confirmation');
    d.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => d.querySelector('[data-action="access-toggle"][data-key="shared"][data-allow="0"]'), 'allowed');
    assert.equal((await req(5107, 'bootstrap')).body.accounts[0]?.key, 'shared');
    d.querySelector('[data-action="access-toggle"][data-key="shared"]').click();
    await waitFor(() => d.querySelector('.confirm-dialog .button.primary'), 'revoke confirmation');
    d.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => d.querySelector('[data-action="access-toggle"][data-key="shared"][data-allow="1"]'), 'revoked');
    assert.equal((await req(5107, 'bootstrap')).body.accounts.length, 0);
  } finally { w.close(); }
});
