// ============================================================================
// v41 — INTEGRITY HARDENING
// ----------------------------------------------------------------------------
// Regressions for the state/robustness bugs found in the 2026-10 audit:
//   1. every source module loads (no missing export / dead import left behind)
//   2. a stale db snapshot can never resurrect a cleared draft or drop a new one
//   3. an order counts as "active" until it is really finished (no double order),
//      but a stuck order older than 12h never blocks the customer forever
//   4. a double tap on "Approve bill" creates exactly ONE payment QR
//   5. no duplicate telegraf handler silently shadows another one
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  headers: { get: () => null },
  text: async () => '',
  json: async () => ({})
});

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: every bot module loads ---');
{
  const modules = [
    'store.js', 'link-utils.js', 'rich-text.js', 'phone-utils.js', 'scan-diagnostics.js',
    'waf-pool.js', 'tracking-validation.js', 'order-tracking.js', 'sms-notify.js', 'vault-sync.js',
    'ammi-abbu-topic-flow.js', 'simple-chat.js', 'boss-panel.js', 'account-vault-intake.js',
    'forwarded-order-flow.js', 'swiggy.js', 'login-helper.js', 'network-shield.js'
  ];
  const broken = [];
  for (const m of modules) {
    try { await import(`./${m}`); } catch (e) { broken.push(`${m}: ${e?.message}`); }
  }
  check(`all ${modules.length} modules import cleanly${broken.length ? ` (broken: ${broken.join(' | ')})` : ''}`, broken.length === 0);
}

const { getDb, saveDb, getDraft, updateDraft, clearDraft, getActiveUserOrder, mutateDb } = await import('./store.js');
const { bot, approveUserOrderBillAction } = await import('./index.js');

const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  if (['sendMessage', 'editMessageText', 'sendPhoto', 'editMessageCaption'].includes(method)) {
    return { message_id: payload.message_id || apiLog.length, chat: { id: payload.chat_id }, text: payload.text || payload.caption || '' };
  }
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER = 6060601;

// v72: ₹15/order service fee QR se pehle wallet se kati jati hai — test customer
// ko balance de do (bina balance QR nahi banta, yehi asli behaviour hai).
{
  const { ensureWallet, creditWallet } = await import('./user-wallet.js');
  mutateDb((d) => {
    for (const uid of [String(USER)]) {
      ensureWallet(d, uid, { name: 'test customer' });
      creditWallet(d, uid, 200000, { reason: 'v72 test seed', actor: 'test' });
    }
  });
}

mutateDb((d) => { d.orders = {}; d.drafts = {}; });

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: stale snapshots cannot resurrect a cleared draft ---');
{
  updateDraft(USER, { cart: 'https://swig.gy/gc/old', address: 'Old address' });
  const staleSnapshot = getDb();            // read BEFORE the customer submits
  clearDraft(USER);                          // customer submits -> draft cleared
  saveDb(staleSnapshot);                     // an old async fiber writes its snapshot
  check('a cleared draft stays cleared after a stale save', !getDraft(USER).cart && !getDraft(USER).address);
}

console.log('\n--- Scenario 3: stale snapshots cannot drop a newer draft ---');
{
  const USER2 = 6060602;
  clearDraft(USER2);
  const staleSnapshot = getDb();
  updateDraft(USER2, { cart: 'https://swig.gy/gc/new', address: 'New address' });
  saveDb(staleSnapshot);
  check('a concurrently written draft survives a stale save',
    getDraft(USER2).cart === 'https://swig.gy/gc/new' && getDraft(USER2).address === 'New address');
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: active-order detection ---');
{
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  mutateDb((d) => {
    d.orders = {
      ACTIVE_APPROVAL: { id: 'ACTIVE_APPROVAL', userId: 6060603, status: 'APPROVAL_PENDING', createdAt: fresh },
      ACTIVE_PAYMENT: { id: 'ACTIVE_PAYMENT', userId: 6060604, status: 'PAYMENT_PENDING', createdAt: fresh },
      DONE_ORDER: { id: 'DONE_ORDER', userId: 6060605, status: 'COMPLETED', createdAt: fresh },
      STALE_ORDER: { id: 'STALE_ORDER', userId: 6060606, status: 'PENDING', createdAt: old }
    };
  });
  check('a bill awaiting confirmation still blocks a second order',
    getActiveUserOrder(6060603)?.id === 'ACTIVE_APPROVAL');
  check('an order awaiting payment still blocks a second order',
    getActiveUserOrder(6060604)?.id === 'ACTIVE_PAYMENT');
  check('a completed order does not block a new order', !getActiveUserOrder(6060605));
  check('a stuck order older than 12h does not block the customer', !getActiveUserOrder(6060606));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: double tap on approve creates ONE payment QR ---');
{
  const ORDER_ID = 'V41_DOUBLE_TAP';
  mutateDb((d) => {
    d.config.accounts = {};
    // v60: a QR needs a real (non-placeholder) collection UPI.
    d.config.bossUpiId = 'ammi.family@okaxis';
    d.orders = {
      [ORDER_ID]: {
        id: ORDER_ID,
        userId: USER,
        userName: 'Ammi',
        status: 'APPROVAL_PENDING',
        cardStage: 'BILL_READY',
        paymentStatus: 'UNPAID',
        createdAt: new Date().toISOString(),
        restaurantName: 'Pizza Hut',
        items: [{ name: 'Margherita', qty: 1, price: 420 }],
        subtotal: 420,
        finalPayable: 379,
        selectedAccount: 'acc_9000000123',
        userChatId: USER,
        userMessageId: 900,
        bossMessageIds: {},
        // v78 (boss 30-10-2026): QR sirf Swiggy ke payment intent se — boss ki
        // personal UPI se nahi.
        pendingSwiggyUpiUri: 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=379&cu=INR&tr=V41TXN'
      }
    };
  });
  apiLog.length = 0;
  const [first, second] = await Promise.all([
    approveUserOrderBillAction(String(USER), ORDER_ID),
    approveUserOrderBillAction(String(USER), ORDER_ID)
  ]);
  await sleep(300);
  check('both taps answer the customer', Boolean(first?.ok) && Boolean(second?.ok));
  check('the second tap is detected as a duplicate',
    first?.duplicateTap === true || second?.duplicateTap === true);
  const photos = apiLog.filter((c) => c.method === 'sendPhoto');
  check(`exactly one payment QR is delivered (got ${photos.length})`, photos.length === 1);
  check('the order is marked approved once',
    getDb().orders[ORDER_ID]?.billApprovedByUser === true);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 6: no duplicate telegraf handlers ---');
{
  const src = fs.readFileSync('index.js', 'utf8');
  const actions = new Map();
  const hears = new Map();
  src.split('\n').forEach((line, i) => {
    const a = line.match(/^bot\.action\((.*)$/);
    const h = line.match(/^bot\.hears\((.*)$/);
    const target = a ? actions : (h ? hears : null);
    if (!target) return;
    for (const m of (a || h)[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
      const s = m[1] ?? m[2];
      if (!s) continue;
      if (target === hears && /^\//.test(s)) continue;
      if (!target.has(s)) target.set(s, []);
      target.get(s).push(i + 1);
    }
  });
  const dupActions = [...actions].filter(([, v]) => v.length > 1);
  const dupHears = [...hears].filter(([, v]) => v.length > 1);
  check(`no callback is registered twice${dupActions.length ? ` (${dupActions.map(([k, v]) => `${k}@${v.join(',')}`).join(' ')})` : ''}`,
    dupActions.length === 0);
  check(`no text button is registered twice${dupHears.length ? ` (${dupHears.map(([k, v]) => `${k}@${v.join(',')}`).join(' ')})` : ''}`,
    dupHears.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 7: a dead bot never exits 0 (host must restart it) ---');
{
  const { isFatalTelegramAuthError } = await import('./index.js');
  check('a revoked token is treated as fatal (no pointless retries)',
    isFatalTelegramAuthError({ response: { error_code: 401 }, description: 'Unauthorized' }));
  check('an unknown bot id is treated as fatal',
    isFatalTelegramAuthError({ response: { error_code: 404 }, description: 'Not Found' }));
  check('a network blip is retryable, not fatal',
    !isFatalTelegramAuthError({ code: 'ECONNRESET', message: 'socket disconnected' }));

  const src = fs.readFileSync('index.js', 'utf8');
  check('boot retries getMe before giving up',
    /isFatalTelegramAuthError\(err\)/.test(src) &&
    /retry \$\{attempt \+ 1\}/.test(src) &&
    /await new Promise\(r => setTimeout\(r, wait\)\)/.test(src));
  check('boot exits non-zero when polling never started',
    /if \(!launched\) \{[\s\S]{0,200}?process\.exit\(1\);/.test(src));
  check('a successful launch marks the bot as launched', /launched = true;/.test(src));
  check('the health payload reports the real bot state instead of a hardcoded "online"',
    /botRuntimeState\.launched \? 'online' : 'not-running'/.test(src) &&
    /launched: botRuntimeState\.launched/.test(src) &&
    /status: botRuntimeState\.launched \? 'ok' : 'starting'/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 8: link classification + no pointless re-paste ---');
{
  const { isValidSwiggyCartUrl, isValidDeliveryAddressUrl } = await import('./index.js');
  const { getOfoResolutionFailureReason } = await import('./swiggy-cart.js');
  const carts = [
    'https://swig.gy/gc/AbC123xyZ',
    'https://www.swiggy.com/gc/Pl8Kk',
    'https://www.swiggy.com/restaurants/pizza-hut-12345?group_cart_id=98765'
  ];
  const adds = [
    'https://swiggy.onelink.me/JgkQ/9k2h4',
    'https://www.swiggy.com/address/abc123',
    'https://www.swiggy.com/ofo/address/1a2b3c',
    'https://maps.app.goo.gl/Xk29aBcD7'
  ];
  check('every real cart link shape is accepted', carts.every((u) => isValidSwiggyCartUrl(u)));
  check('every real address link shape is accepted', adds.every((u) => isValidDeliveryAddressUrl(u)));
  check('a tracking link is never mistaken for a cart',
    !isValidSwiggyCartUrl('https://r.swiggy.com/swiggy/ofo/track/251999888777666'));
  check('an address link is never mistaken for a cart',
    adds.every((u) => !isValidSwiggyCartUrl(u)));
  check('a bare restaurant page is not sold as a cart (it has no cart to read)',
    !isValidSwiggyCartUrl('https://www.swiggy.com/restaurants/pizza-hut-12345'));

  check('an unvisited token reports no failure reason', getOfoResolutionFailureReason('https://swiggy.onelink.me/JgkQ/never-seen') === '');

  const src = fs.readFileSync('index.js', 'utf8');
  check('a dead address link is the ONLY case that asks for a new link',
    /REASON|reason === 'EXPIRED'/.test(src) && /Address link expire ho gaya/.test(src));
  check('a transient failure keeps the saved link and offers retry',
    /dobara paste karne ki zaroorat nahi/.test(src) && /callback_data: 'simple_retry_address'/.test(src));
  check('the retry button has a handler (no dead callback)',
    /bot\.action\('simple_retry_address'/.test(src));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
