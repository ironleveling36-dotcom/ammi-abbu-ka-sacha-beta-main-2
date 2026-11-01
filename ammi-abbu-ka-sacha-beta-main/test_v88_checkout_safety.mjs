// Fault-injection tests only. These DO NOT contact Swiggy or prove live ordering,
// payment, OFO, tracking, notification or UPI-app compatibility.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-checkout-test-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:checkout-offline-test-token', PRO_VAULT_KEY: 'only-an-offline-test-key-12345',
  PRO_ENABLE_CHECKOUT: '1', BOSS_ID: '8000', DB_ASYNC_WRITE: '0', NODE_ENV: 'test'
});
// Boss (31-10-2026, round 3): checkout default ON hai. Live-order hard block ka
// apna test neeche hai; baaki tests uske bina chalte hain warna sab 503 ho jaate.
delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
const { executeSingleSwiggyPlacement, readSwiggyPlacement } = await import('./swiggy-placement-journal.js');
const { exactPaise } = await import('./swiggy-cart-integrity.js');
const { validateUpiIntentForQr, shouldReusePendingQr } = await import('./payment-qr-guard.js');
const { readProWorkspace, writeProWorkspace } = await import('./swiggy-pro-store.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { detectOfoFromPlaceResponse, hasExplicitOfoCartFlag, withSwiggyAccountLock, releaseStaleAccountLocks } = await import('./swiggy-cart.js');
const { getDb, saveDb } = await import('./store.js');
const { creditWallet, debitWallet, walletBalancePaise } = await import('./user-wallet.js');
const { reserveChatOrderFee, refundChatOrderFeeBeforePlacement, assertChatOrderFeeStillReserved } = await import('./wallet-order-gate.js');
const { executeRealQrGenerationForOrder, executeOrderBillSyncOnAccount, applyBossOrderUpdate } = await import('./forwarded-order-flow.js');

const id = '123456789012';
const otherId = '123456789099';
const uri = 'upi://pay?pa=upiswiggy%40icici&pn=Swiggy&am=150.25&cu=INR&tr=offline-test';
const receiver = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567' };
let calls = 0, paymentMode = 'pending', checkoutMode = 'ok';
const paymentAccounts = [];
const fake = {
  async checkout(_account, _address, _cart, key) {
    if (checkoutMode === 'preflight') throw Object.assign(new Error('offline preflight failure'), { code: 'PREFLIGHT_FAILED' });
    const reply = await executeSingleSwiggyPlacement(key, async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 30));
      if (checkoutMode === 'timeout') throw new Error('simulated timeout after send');
      return { placeRes: { ok: true, status: 200 }, json: { statusCode: 0, data: { order_id: id } } };
    });
    assert.equal(reply.placeRes.ok, true);
    return { orderId: id, upiIntentUrl: checkoutMode === 'badamount' ? uri.replace('150.25', '150.24') : uri, paymentTxnId: 'ref-1', ofoConfirmed: false };
  },
  async checkPayment(account) {
    paymentAccounts.push(account.phone);
    if (paymentMode === 'wrong') return { paid: true, swiggyOrderId: otherId };
    if (paymentMode === 'reported') return { paid: false, paymentVerified: true };
    if (paymentMode === 'paid') return { paid: true, swiggyOrderId: id, orderStatus: 'Confirmed', trackingUrl: `https://www.swiggy.com/orders/${id}`, deliveryOtp: '1234' };
    return { paid: false, paymentVerified: false };
  },
  async verifySession(session) { return { valid: true, phone: session.phone || session.mobile, customerId: session.token === 'wrong-customer' ? 'customer-other' : `customer-${session.phone || session.mobile}` }; },
  async orders(account) { return account.phone === '9123456789' ? [{ id, restaurant: 'Mock' }] : [{ id: otherId, restaurant: 'Other' }]; },
  async tracking(_account, orderId) { return { orderId, status: 'Confirmed', trackingUrl: 'https://evil.invalid/not-swiggy', deliveryOtp: '1234' }; },
  async quoteCart(_a, address) { return { address, bill: { total: 150.25, coupon: '' }, ofoConfirmed: false }; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fake, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });
function sign(user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id: user, first_name: 'Test' }), query_id: 'offline' });
  const text = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(text).digest('hex'));
  return params.toString();
}
async function req(user, route, body) {
  const r = await fetch(base + '/pro/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': sign(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: r.status, body: await r.json() };
}
function seed(user) {
  // Round 11: order place karne se pehle wallet me ₹15 fee ka balance chahiye.
  const wdb = getDb();
  creditWallet(wdb, String(user), 1500, { reason: 'test top-up', actor: 'test' });
  saveDb(wdb);
  const quote = { total: 150.25, coupon: '', fetchedAt: new Date().toISOString() };
  writeProWorkspace(String(user), {
    version: 1,
    accounts: {
      a: { phone: '9123456789', customerId: 'customer-9123456789', name: 'Original', token: 'test-a', isLoggedIn: true },
      b: { phone: '9234567890', customerId: 'customer-9234567890', name: 'Other', token: 'test-b', isLoggedIn: true }
    }, activeAccountKey: 'a', selectedAddress: receiver, addressCandidates: [],
    cart: { restaurantId: '123', restaurantName: 'Mock restaurant', forSomeoneElse: true,
      items: [{ lineKey: 'line', id: '456', menu_item_id: 456, name: 'Meal', qty: 1, variants: [], addons: [] }], quote }
  });
  return quote;
}
const confirmation = quote => ({ confirmCheckout: true, expectedTotal: quote.total, quoteFetchedAt: quote.fetchedAt });

test('durable barrier makes one POST under concurrency and blocks replay', async () => {
  let sent = 0;
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => executeSingleSwiggyPlacement('chat:race', async () => { sent++; await new Promise(r => setTimeout(r, 25)); return { placeRes: { ok: true, status: 200 }, json: { statusCode: 0, data: { order_id: id } } }; })));
  assert.equal(sent, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(readSwiggyPlacement('chat:race').state, 'PROVIDER_ACCEPTED');
  await assert.rejects(executeSingleSwiggyPlacement('chat:race', async () => { sent++; }), e => e.diag?.placementAttempted === true);
  assert.equal(sent, 1);
});

test('timeout after send is UNKNOWN, survives a process restart and never resends', async () => {
  let sent = 0;
  await assert.rejects(executeSingleSwiggyPlacement('chat:uncertain', async () => { sent++; throw new Error('timeout'); }), e => e.diag?.placementAttempted === true);
  assert.equal(readSwiggyPlacement('chat:uncertain').state, 'UNKNOWN');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const j = await import('./swiggy-placement-journal.js');
    let sent = false; try { await j.executeSingleSwiggyPlacement('chat:uncertain', async()=>{sent=true}); } catch(e) { if (!e.diag?.placementAttempted || sent) process.exit(2); }
    if (j.readSwiggyPlacement('chat:uncertain')?.state !== 'UNKNOWN') process.exit(3);
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(sent, 1);
});

test('journal storage errors fail before send; unreadable records remain blocked', async () => {
  const before = process.env.DATA_DIR;
  const blocked = path.join(tmp, 'not-a-directory'); fs.writeFileSync(blocked, 'x');
  process.env.DATA_DIR = blocked;
  let sent = 0;
  await assert.rejects(executeSingleSwiggyPlacement('chat:disk', async () => { sent++; }), e => e.diag?.placementAttempted === false);
  assert.equal(sent, 0);
  process.env.DATA_DIR = before;
  const key = 'chat:corrupt';
  const filename = crypto.createHash('sha256').update(key).digest('hex') + '.json';
  fs.writeFileSync(path.join(tmp, 'swiggy-placement-journal', filename), 'not json');
  assert.equal(readSwiggyPlacement(key).state, 'UNKNOWN');
  assert.equal(readSwiggyPlacement(key).unreadable, true);
  await assert.rejects(executeSingleSwiggyPlacement(key, async () => { sent++; }), e => e.diag?.placementAttempted === true);
  assert.equal(sent, 0);
});

test('a timed-out waiter and maintenance do not unlock an active account job', async () => {
  let releaseFirst, enteredThird = false;
  const hold = new Promise(resolve => { releaseFirst = resolve; });
  const first = withSwiggyAccountLock('lock-fault-test', () => hold);
  // Let the first holder enter before queueing the timeout.
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(withSwiggyAccountLock('lock-fault-test', async () => {}, { maxWaitMs: 1000 }), e => e.code === 'ACCOUNT_LOCK_TIMEOUT');
  const maintenance = await releaseStaleAccountLocks({ olderThanMs: 1000 });
  assert.equal(maintenance.released.length, 0);
  const third = withSwiggyAccountLock('lock-fault-test', async () => { enteredThird = true; }, { maxWaitMs: 3000 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(enteredThird, false);
  releaseFirst(); await first; await third;
  assert.equal(enteredThird, true);
});

test('chat QR callers coalesce and never fail over after an ambiguous placement', async () => {
  const db = getDb();
  db.config.accounts = {
    a: { isLoggedIn: true, phone: '9123456789', token: 'mock-a' },
    b: { isLoggedIn: true, phone: '9234567890', token: 'mock-b' }
  };
  db.orders['chat-race'] = { id: 'chat-race', userId: '8118', status: 'ACCEPTED', selectedAccount: 'a', orderAccount: '9123456789' };
  creditWallet(db, '8118', 1500, { reason: 'offline test', actor: 'test' });
  saveDb(db);
  let generated = 0;
  const generator = async () => {
    generated++; await new Promise(resolve => setTimeout(resolve, 30));
    const e = new Error('session expired after sending');
    e.diag = { code: 'SESSION_EXPIRED', placementAttempted: true };
    throw e;
  };
  const args = { orderId: 'chat-race', telegram: {}, chatId: 1, customRealQrGenerator: generator };
  const first = executeRealQrGenerationForOrder(args), second = executeRealQrGenerationForOrder(args);
  assert.equal(first, second);
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every(x => x.status === 'rejected' && x.reason.diag.placementAttempted));
  assert.equal(generated, 1); assert.equal(getDb().orders['chat-race'].selectedAccount, 'a');
});

test('chat cart changes and account sync remain blocked after an uncertain send', async () => {
  const db = getDb();
  db.orders['chat-unknown'] = { id: 'chat-unknown', status: 'ACCEPTED', selectedAccount: 'a', cart: 'original' };
  saveDb(db);
  await assert.rejects(executeSingleSwiggyPlacement('chat:chat-unknown', async () => { throw new Error('timeout'); }));
  await assert.rejects(executeOrderBillSyncOnAccount({ orderId: 'chat-unknown', accKey: 'b' }), e => e.diag?.placementAttempted === true);
  const update = await applyBossOrderUpdate({ orderId: 'chat-unknown', cart: 'different cart' });
  assert.equal(update.ok, false); assert.equal(getDb().orders['chat-unknown'].cart, 'original');
});

test('money, UPI and OFO guards reject fractional paise, wrong amount and mere OFO mentions', () => {
  assert.equal(exactPaise('150.25'), 15025);
  assert.equal(exactPaise('150.251'), null);
  assert.equal(exactPaise(''), null);
  assert.equal(validateUpiIntentForQr(uri, { amount: 150.25 }).valid, true);
  assert.equal(validateUpiIntentForQr(uri, { amount: 150.26 }).valid, false);
  assert.equal(validateUpiIntentForQr(uri.replace('150.25', '150.250'), { amount: 150.25 }).valid, false);
  // Round 15: `amount` alias jiski value same hai benign hai — auto-fix hota
  // hai (QR nazar aana chahiye), par value alag ho to block.
  assert.equal(validateUpiIntentForQr(uri + '&amount=150.25', { amount: 150.25 }).valid, true);
  // Round 16: `amount` non-standard kachra hai — QR me sirf `am` jaata hai aur
  // wahi bill se match hota hai. Isliye `amount` ka jhagda QR nahi rokta
  // (pehle isi par QR hi nahi aata tha).
  assert.equal(validateUpiIntentForQr(uri + '&amount=150.26', { amount: 150.25 }).valid, true);
  assert.equal(validateUpiIntentForQr(uri.replace('150.25', '150.26'), { amount: 150.25 }).valid, false);
  assert.equal(shouldReusePendingQr({ pendingSwiggyUpiUri: uri, pendingQrCreatedAt: Date.now(), pendingQrAmount: 150.25, finalPayable: 150.26 }).reuse, false);
  assert.equal(detectOfoFromPlaceResponse({ data: { ofo: false, recipient_phone: '9123456789' } }).ofo, false);
  assert.equal(hasExplicitOfoCartFlag({ message: 'ofo', config: { ofo: true } }), false);
  assert.equal(hasExplicitOfoCartFlag({ is_order_for_someone_else: true }), true);
});

test('checkout can be turned off with PRO_ENABLE_CHECKOUT=0 and SWIGGY_BLOCK_LIVE_ORDER_PLACE=1', async () => {
  const quote = seed(8099);
  process.env.PRO_ENABLE_CHECKOUT = '0';
  const off = await req(8099, 'checkout', confirmation(quote));
  assert.equal(off.status, 503);
  assert.match(off.body.error, /PRO_ENABLE_CHECKOUT=0/);
  process.env.PRO_ENABLE_CHECKOUT = '1';
  process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE = '1';
  const blocked = await req(8099, 'checkout', confirmation(quote));
  assert.equal(blocked.status, 503);
  assert.match(blocked.body.error, /blocked/i);
  assert.equal(readProWorkspace('8099').checkout, undefined);
  delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
});

test('checkout requires opt-in, explicit consent, fresh quote and exact approved amount', async () => {
  const quote = seed(8101);
  process.env.PRO_ENABLE_CHECKOUT = '0';
  assert.equal((await req(8101, 'checkout', confirmation(quote))).status, 503);
  process.env.PRO_ENABLE_CHECKOUT = '1';
  const missingIdentity = readProWorkspace('8101'); missingIdentity.accounts.a.customerId = ''; writeProWorkspace('8101', missingIdentity);
  assert.equal((await req(8101, 'checkout', confirmation(quote))).status, 409);
  assert.equal(readProWorkspace('8101').checkout, undefined);
  missingIdentity.accounts.a.customerId = 'customer-9123456789'; writeProWorkspace('8101', missingIdentity);
  assert.equal((await req(8101, 'checkout', { ...confirmation(quote), confirmCheckout: false })).status, 400);
  assert.equal((await req(8101, 'checkout', { ...confirmation(quote), expectedTotal: 150.24 })).status, 400);
  assert.equal((await req(8101, 'checkout', { ...confirmation(quote), expectedTotal: 150.251 })).status, 400);
  assert.equal((await req(8101, 'checkout', { ...confirmation(quote), quoteFetchedAt: 'old' })).status, 400);
  const ws = readProWorkspace('8101'); ws.cart.quote.fetchedAt = new Date(Date.now() - 6 * 60_000).toISOString(); writeProWorkspace('8101', ws);
  assert.equal((await req(8101, 'checkout', confirmation(ws.cart.quote))).status, 400);
  assert.equal(calls, 0);
});

test('two taps create one provider attempt and display the exact provider URI as the QR', async () => {
  const quote = seed(8102);
  const results = await Promise.all([req(8102, 'checkout', confirmation(quote)), req(8102, 'checkout', confirmation(quote))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(calls, 1);
  const output = results.find(r => r.status === 200).body.checkout;
  assert.equal(output.status, 'PAYMENT_PENDING'); assert.equal(output.upiIntentUrl, uri); assert.equal(output.orderId, id);
  assert.equal(output.accountCustomerId, undefined);
  const png = PNG.sync.read(Buffer.from(output.qrDataUrl.split(',')[1], 'base64'));
  assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data, uri);
  assert.equal((await req(8102, 'accounts/remove', { key: 'a' })).status, 409);
  assert.equal((await req(8102, 'accounts/select', { key: 'b' })).status, 409);
  assert.equal((await req(8102, 'accounts/send-otp', { phone: '9234567890' })).status, 409);
  assert.equal((await req(8102, 'accounts/import', { session: { phone: '9234567890', token: 'other-session' } })).status, 409);
  assert.equal((await req(8102, 'accounts/import', { session: { phone: '9123456789', token: 'wrong-customer' } })).status, 409);
  assert.equal((await req(8102, 'cart/sync', { confirmReplaceSwiggyCart: true })).status, 409);
  const cartBefore = structuredClone(readProWorkspace('8102').cart);
  assert.equal((await req(8102, 'cart/quantity', { lineKey: 'line', qty: 2 })).status, 409);
  assert.equal((await req(8102, 'cart/add', { itemId: '456', replace: true })).status, 409);
  assert.equal((await req(8102, 'cart/import-group', { url: 'https://swig.gy/gc/test', replace: true })).status, 409);
  assert.equal((await req(8102, 'addresses/update-contact', { name: 'Other', mobile: '9345678901' })).status, 409);
  assert.equal((await req(8102, 'addresses/select', { ref: 'other' })).status, 409);
  assert.equal((await req(8102, 'addresses/resolve', { url: 'https://swiggy.onelink.me/abc' })).status, 409);
  assert.deepEqual(readProWorkspace('8102').cart, cartBefore);
  assert.deepEqual(readProWorkspace('8102').selectedAddress, receiver);
  assert.equal((await req(8102, 'accounts/import', { session: { phone: '9123456789', token: 'refreshed-original-session' } })).status, 200);
  assert.equal(readProWorkspace('8102').activeAccountKey, 'a');
  assert.deepEqual(readProWorkspace('8102').cart, cartBefore);
  assert.deepEqual(readProWorkspace('8102').selectedAddress, receiver);
  const bob = (await req(8103, 'bootstrap')).body;
  assert.equal(bob.checkout, null); assert.equal(JSON.stringify(bob).includes(uri), false);
});

test('status uses original account, does not accept a different order and hides QR after payment report', async () => {
  // A changed customer ID must not silently replace the original account.
  const stale = readProWorkspace('8102');
  stale.accounts.a.customerId = 'different-customer'; writeProWorkspace('8102', stale);
  assert.equal((await req(8102, 'checkout/status', {})).status, 409);
  assert.equal((await req(8102, 'orders?scope=checkout')).status, 409);
  // Simulate an older/stale workspace which had selected another account before
  // the new switching guard; recovery must still use the original account.
  stale.accounts.a.customerId = 'customer-9123456789'; stale.activeAccountKey = 'b'; writeProWorkspace('8102', stale);
  assert.equal((await req(8102, 'orders')).body.orders[0].id, otherId);
  assert.equal((await req(8102, 'orders?scope=checkout')).body.orders[0].id, id);
  assert.equal((await req(8102, `orders/tracking?id=${id}`)).status, 404);
  assert.equal((await req(8102, `orders/tracking?id=${id}&scope=checkout`)).status, 200);
  assert.equal((await req(8102, 'orders?scope=arbitrary')).status, 400);
  assert.equal((await req(8103, 'orders?scope=checkout')).status, 404);
  paymentMode = 'wrong';
  let result = await req(8102, 'checkout/status', {});
  assert.equal(result.body.checkout.status, 'PAYMENT_PENDING'); assert.equal(result.body.checkout.paymentVerified, false);
  assert.equal(paymentAccounts.at(-1), '9123456789');
  paymentMode = 'reported'; result = await req(8102, 'checkout/status', {});
  assert.equal(result.body.checkout.paymentVerified, true); assert.equal(result.body.checkout.qrDataUrl, undefined);
  paymentMode = 'pending'; result = await req(8102, 'checkout/status', {});
  assert.equal(result.body.checkout.paymentVerified, true); assert.equal(result.body.checkout.qrDataUrl, undefined);
  paymentMode = 'paid'; result = await req(8102, 'checkout/status', {});
  assert.equal(result.body.checkout.status, 'PAID'); assert.equal(result.body.checkout.orderId, id); assert.equal(result.body.checkout.upiIntentUrl, undefined);
  assert.equal((await req(8102, 'checkout/finish', {})).status, 409);
  result = await req(8102, 'checkout/finish', { confirmNewDraft: true });
  assert.equal(result.body.checkout, null); assert.equal(readProWorkspace('8102').checkoutGeneration, 1);
});

test('tracking requires ownership in current account; foreign tracking links are stripped', async () => {
  seed(8104);
  assert.equal((await req(8104, `orders/tracking?id=${otherId}`)).status, 404);
  const result = await req(8104, `orders/tracking?id=${id}`);
  assert.equal(result.status, 200); assert.equal(result.body.tracking.orderId, id);
  assert.equal(result.body.tracking.trackingUrl, ''); assert.equal(result.body.tracking.deliveryOtp, '1234');
});

test('timeout after POST and invalid provider QR both leave persistent, non-retryable state', async () => {
  checkoutMode = 'timeout'; const q = seed(8105); let result = await req(8105, 'checkout', confirmation(q));
  assert.equal(result.body.checkout.status, 'OUTCOME_UNKNOWN');
  const count = calls;
  assert.equal((await req(8105, 'checkout', confirmation(q))).status, 409);
  assert.equal((await req(8105, 'checkout/finish', { confirmNewDraft: true })).status, 409);
  assert.equal((await req(8105, 'accounts/select', { key: 'b' })).status, 409);
  assert.equal((await req(8105, 'cart/sync', { confirmReplaceSwiggyCart: true })).status, 409);
  assert.equal((await req(8105, 'bootstrap')).body.checkout.status, 'OUTCOME_UNKNOWN'); assert.equal(calls, count);
  checkoutMode = 'badamount'; const q2 = seed(8106); result = await req(8106, 'checkout', confirmation(q2));
  assert.equal(result.body.checkout.status, 'OUTCOME_UNKNOWN'); assert.equal(result.body.checkout.qrDataUrl, undefined);
  assert.equal((await req(8106, 'checkout', confirmation(q2))).status, 409);
});

test('a stale workspace or account failover cannot bypass the generation barrier', async () => {
  checkoutMode = 'ok'; const q = seed(8107);
  const key = 'pro:8107:0';
  await assert.rejects(executeSingleSwiggyPlacement(key, async () => { throw new Error('lost after send'); }));
  // Simulate a stale replica that has no checkout record and a refreshed quote.
  const ws = readProWorkspace('8107'); ws.activeAccountKey = 'b'; ws.cart.quote.fetchedAt = new Date().toISOString(); writeProWorkspace('8107', ws);
  const before = calls;
  const out = await req(8107, 'checkout', confirmation(ws.cart.quote));
  assert.equal(out.body.checkout.status, 'OUTCOME_UNKNOWN'); assert.equal(calls, before);
});

test('Mini App blocks low balance before provider; boss checkout needs no wallet', async () => {
  checkoutMode = 'ok';
  const lowQuote = seed(8201);
  let db = getDb();
  debitWallet(db, '8201', 1500, { actor: 'test' });
  saveDb(db);
  const before = calls;
  const low = await req(8201, 'checkout', confirmation(lowQuote));
  assert.equal(low.status, 409);
  assert.equal(low.body.code, 'WALLET_LOW_BALANCE');
  assert.equal(calls, before, 'no provider attempt without the fee');
  assert.equal(readProWorkspace('8201').checkout, undefined);
  const bossQuote = seed(8000);
  db = getDb(); delete db.config.wallets['8000'];
  db.config.accounts.a.customerId = 'customer-9123456789'; saveDb(db);
  const boss = await req(8000, 'checkout', confirmation(bossQuote));
  assert.equal(boss.status, 200, JSON.stringify(boss.body));
  assert.equal(calls, before + 1);
  assert.equal(walletBalancePaise(getDb(), '8000'), 0);
});

test('Mini App refunds a preflight failure, but not an uncertain POST', async () => {
  checkoutMode = 'preflight';
  const q = seed(8202);
  const before = calls;
  const fail = await req(8202, 'checkout', confirmation(q));
  assert.equal(fail.status, 502);
  assert.equal(calls, before);
  assert.equal(walletBalancePaise(getDb(), '8202'), 1500);
  assert.equal(readProWorkspace('8202').checkout, null);
  checkoutMode = 'timeout';
  const q2 = seed(8203);
  const uncertain = await req(8203, 'checkout', confirmation(q2));
  assert.equal(uncertain.body.checkout.status, 'OUTCOME_UNKNOWN');
  assert.equal(walletBalancePaise(getDb(), '8203'), 0);
  assert.equal((await req(8203, 'checkout', confirmation(q2))).status, 409);
  assert.equal(calls, before + 1);
  checkoutMode = 'ok';
});

test('chat gate charges the customer, not an acting boss; preflight refund is idempotent', async () => {
  let db = getDb();
  db.orders['chat-owner'] = { id: 'chat-owner', userId: '8000', fwdSenderUserId: '8204', isForwardedOrder: true, status: 'APPROVAL_PENDING', selectedAccount: 'a' };
  saveDb(db);
  let generated = 0;
  const args = { orderId: 'chat-owner', chatId: 8000, telegram: {}, customRealQrGenerator: async () => { generated++; throw new Error('preflight'); } };
  await assert.rejects(executeRealQrGenerationForOrder(args), e => e.code === 'WALLET_LOW_BALANCE');
  assert.equal(generated, 0, 'boss pressing a customer order cannot waive the fee');
  db = getDb(); creditWallet(db, '8204', 1500, { actor: 'test' }); saveDb(db);
  await assert.rejects(executeRealQrGenerationForOrder(args), /preflight/);
  assert.equal(generated, 1);
  assert.equal(walletBalancePaise(getDb(), '8204'), 1500, 'preflight failure refunds');
  const again = reserveChatOrderFee('chat-owner');
  assert.equal(walletBalancePaise(getDb(), '8204'), 0);
  assertChatOrderFeeStillReserved('chat-owner');
  refundChatOrderFeeBeforePlacement('chat-owner', again, new Error('no POST'));
  refundChatOrderFeeBeforePlacement('chat-owner', again, new Error('no POST'));
  assert.equal(walletBalancePaise(getDb(), '8204'), 1500, 'refund cannot be duplicated');
});

test('chat admin exemption, unknown owner, and final cancellation barrier', () => {
  const db = getDb();
  db.orders['chat-boss'] = { id: 'chat-boss', userId: '8000', isDirectBossOrder: true, status: 'APPROVAL_PENDING' };
  db.orders['chat-hidden'] = { id: 'chat-hidden', userId: '8000', isForwardedOrder: true, status: 'APPROVAL_PENDING' };
  db.orders['chat-closed'] = { id: 'chat-closed', userId: '8205', status: 'APPROVAL_PENDING' };
  creditWallet(db, '8205', 1500, { actor: 'test' }); saveDb(db);
  assert.equal(reserveChatOrderFee('chat-boss').admin, true);
  assertChatOrderFeeStillReserved('chat-boss');
  assert.throws(() => reserveChatOrderFee('chat-hidden'), e => e.code === 'FEE_OWNER_UNKNOWN');
  const reserved = reserveChatOrderFee('chat-closed');
  const fresh = getDb(); fresh.orders['chat-closed'].status = 'CANCELLED'; saveDb(fresh);
  assert.throws(() => assertChatOrderFeeStillReserved('chat-closed'), e => e.code === 'ORDER_CLOSED');
  refundChatOrderFeeBeforePlacement('chat-closed', reserved, new Error('before POST'));
  assert.equal(walletBalancePaise(getDb(), '8205'), 1500);
});

test('production bot entrypoints do not call an SMS gateway for recipients', () => {
  for (const file of ['index.js', 'forwarded-order-flow.js', 'swiggy-pro-api.js', 'swiggy-pro-provider.js']) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\b(?:sendDirectOrderSms|sendPaymentLinkSms|sendSmsViaGateway)\s*\(/);
  }
});
