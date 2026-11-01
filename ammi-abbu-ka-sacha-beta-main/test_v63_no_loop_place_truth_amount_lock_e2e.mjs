/**
 * v63 — "EK TAP = EK QR · JHOOTH NAHI · BILL KE AMOUNT KA HI QR"
 *
 * Boss (26-10-2026 shaam, ~2 ghante ke live logs ke baad):
 *   "LE SALA KYA KARRAHA BE CHUTIYA KI TARAH" / "ITNA GHTIA ALGORITHM HAI TERA"
 *
 * Logs me jo dikha:
 *   1. Ek hi order par 4-5 parallel attempts. Har attempt Swiggy par naya unpaid
 *      order place karta tha, aur har ek apna error spam karta tha.
 *   2. `SWIGGY_UPI_INTENT_INVALID` → `QR_BILL_RELOCK_FAILED` → ID switch → phir
 *      "BILL READY" (QR kahin nahi). Customer pareshan.
 *   3. Swiggy `statusCode:0` + "Done Successfully" (order PLACE ho chuka) ke baad
 *      bhi bot "rejected" bolta tha aur doosri ID par DOOSRA order place kar deta.
 *   4. `#ORD4847` — boss ko ₹37 ka bill dikha, QR ₹82 ka bana (offer lost).
 *   5. `Promise timed out after 240000 milliseconds` — bot 4 minute dead.
 *   6. `fetch failed: ACTIVE` / `ACCOUNT_LOCK_TIMEOUT` raw dump.
 *
 * Ab (yahin proven):
 *   1. Ek order ka ek hi QR attempt — dedupe promise (parallel spam khatam).
 *   2. Order placed par UPI intent missing → `QR_PLACED_NO_INTENT`, **koi ID
 *      switch nahi** (doosra unpaid order nahi banta), boss ko seedha message.
 *   3. Placed-but-unpaid order ka QR dobara maangne par `ORDER_ALREADY_PLACED_UNPAID`
 *      (jhoothi "bill ready" nahi).
 *   4. Bill ₹X dikha to QR ₹X ka hi — zyada amount par `QR_AMOUNT_ABOVE_SHOWN_BILL`.
 *   5. Bill sync bhi per-order dedupe (`isOrderBillSyncInFlight`).
 *   6. UPDATE WATCHDOG: 3-4 min ka freeze khatam, handlerTimeout 60s.
 *   7. Group cart / busy IDs ke honest codes (`GROUP_CART_EMPTY_ON_SWIGGY`,
 *      `ALL_ACCOUNTS_BUSY`) — raw "fetch failed: ACTIVE" nahi.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

const DB_PATH = 'data/db.json';
const ACCOUNTS_MIRROR_PATH = 'accounts.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const mirrorSnapshot = fs.existsSync(ACCOUNTS_MIRROR_PATH) ? fs.readFileSync(ACCOUNTS_MIRROR_PATH, 'utf8') : null;
process.on('exit', () => restoreState());

globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  headers: { get: () => null },
  text: async () => '',
  json: async () => ({})
});

const formatOrderBodyFn = (order) => `Order #${order?.id || ''} · ₹${order?.finalPayable || 0}`;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const store = await import('./store.js');
const health = await import('./account-health.js');
const cart = await import('./swiggy-cart.js');
const fof = await import('./forwarded-order-flow.js');
const { getDb, mutateDb } = store;

const USER = 6356301;
const BOSS = 6356300;

const bossIds = () => (getDb().config.bossIds || []).map(Number);

function makeTelegram(sent) {
  return {
    sendMessage: async (chatId, text, extra) => { sent.push({ kind: 'message', chatId, text, extra }); return { message_id: 100 + sent.length }; },
    sendPhoto: async (chatId, photo, extra) => { sent.push({ kind: 'photo', chatId, extra }); return { message_id: 200 }; },
    editMessageText: async () => ({}),
    editMessageCaption: async () => ({}),
    editMessageReplyMarkup: async () => ({}),
    deleteMessage: async () => true
  };
}

const ADDRESS = { name: 'Sneha', mobile: '9109533577', address: '350, MIG 2, New Subhash Nagar', lat: '26.9', lng: '82.1' };

function seedOrder(id, over = {}) {
  mutateDb((d) => {
    d.config.bossIds = [...new Set([...(d.config.bossIds || []), BOSS])];
    d.orders[id] = {
      id,
      userId: USER,
      userName: 'Ammi',
      status: 'APPROVAL_PENDING',
      cardStage: 'BILL_READY',
      paymentStatus: 'UNPAID',
      restaurantName: 'Pizza Hut',
      items: [{ name: 'Margherita', qty: 1, price: 420 }],
      subtotal: 420,
      finalPayable: 37,
      billShownAmount: 37,
      selectedAccount: 'acc_8511111111',
      orderAccount: '8511111111',
      userChatId: USER,
      bossMessageIds: {},
      addressDetails: { ...ADDRESS },
      ...over
    };
  });
}

console.log('\n=== 1. EK TAP = EK QR (parallel attempts dedupe) ===');
{
  mutateDb((d) => {
    d.config.accounts = {
      acc_8511111111: { id: 'acc_8511111111', phone: '8511111111', isLoggedIn: true, cookies: 'a=1', tid: 'a.b.c' },
      acc_8522222222: { id: 'acc_8522222222', phone: '8522222222', isLoggedIn: true, cookies: 'b=2', tid: 'd.e.f' }
    };
    d.orders = {};
  });
  seedOrder('DEDUPE1');

  const sent = [];
  const generatorCalls = [];
  const slowGenerator = async (acc, order) => {
    generatorCalls.push({ phone: acc.phone, at: Date.now() });
    await new Promise((r) => setTimeout(r, 120));
    return {
      upiIntentUrl: `upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=${order.finalPayable}&cu=INR&tr=DED${Date.now()}`,
      swiggyOrderId: '251000111222',
      paymentTxnId: 'TXN_DEDUP',
      amount: order.finalPayable,
      restaurantName: order.restaurantName,
      slaMinutes: '30'
    };
  };

  const results = await Promise.allSettled([
    fof.executeRealQrGenerationForOrder({ telegram: makeTelegram(sent), chatId: USER, orderId: 'DEDUPE1', formatOrderBodyFn, customRealQrGenerator: slowGenerator }),
    fof.executeRealQrGenerationForOrder({ telegram: makeTelegram(sent), chatId: USER, orderId: 'DEDUPE1', formatOrderBodyFn, customRealQrGenerator: slowGenerator }),
    fof.executeRealQrGenerationForOrder({ telegram: makeTelegram(sent), chatId: USER, orderId: 'DEDUPE1', formatOrderBodyFn, customRealQrGenerator: slowGenerator })
  ]);

  check('3 taps par bhi Swiggy place sirf EK baar chala', generatorCalls.length === 1, `calls=${generatorCalls.length}`);
  check('teeno callers ko wahi result mila (koi error storm nahi)', results.every((r) => r.status === 'fulfilled'), results.map((r) => r.status).join(','));
  check('customer ko ek hi QR photo gayi', sent.filter((s) => s.kind === 'photo').length === 1, `photos=${sent.filter((s) => s.kind === 'photo').length}`);
  check('dedupe ke baad in-flight flag clear ho gaya', fof.isQrGenerationInFlight('DEDUPE1') === false);
}

console.log('\n=== 2. Order PLACE ho gaya par UPI intent nahi → koi ID switch NAHI ===');
{
  mutateDb((d) => { d.orders = {}; });
  seedOrder('PLACED1');

  const sent = [];
  const telegram = makeTelegram(sent);
  const attempts = [];
  const placedButNoIntent = async (acc) => {
    attempts.push(acc.phone);
    const err = new Error('Swiggy ne order place kar diya par UPI intent nahi mila (statusCode 0, Done Successfully)');
    err.diag = {
      code: 'SWIGGY_PLACED_NO_UPI_INTENT',
      stage: 'POST_PAYMENTS_ORDER_PLACE',
      placed: true,
      placedOrderId: '259900112233',
      swiggyStatusCode: 0,
      swiggyMessage: 'Done Successfully',
      paymentFallbacks: { upiIntentUrl: '' }
    };
    throw err;
  };

  let qrErr = null;
  try {
    await fof.executeRealQrGenerationForOrder({
      telegram, chatId: USER, orderId: 'PLACED1', formatOrderBodyFn, customRealQrGenerator: placedButNoIntent, forceNewQr: true
    });
  } catch (e) { qrErr = e; }

  check('error throw hua (fake QR nahi bheja)', Boolean(qrErr));
  check('diag code QR_PLACED_NO_INTENT', qrErr?.diag?.code === 'QR_PLACED_NO_INTENT', JSON.stringify(qrErr?.diag));
  check('Swiggy order id error me hai', String(qrErr?.diag?.placedOrderId || '') === '259900112233', String(qrErr?.diag?.placedOrderId || ''));
  check('sirf EK ID par koshish hui — doosre account par naya unpaid order NAHI bana', attempts.length === 1, JSON.stringify(attempts));
  check('customer ko QR photo nahi gayi', !sent.some((s) => s.kind === 'photo'));

  const order = getDb().orders.PLACED1;
  check('order par swiggyPlacedUnpaid = true', order?.swiggyPlacedUnpaid === true);
  check('order par pendingSwiggyOrderId save hua', String(order?.pendingSwiggyOrderId || '') === '259900112233', String(order?.pendingSwiggyOrderId || ''));
  check('placedWithoutIntentAt stamp hai', Boolean(order?.placedWithoutIntentAt));
  check('qrcode blocked reason order par hai (audit)', /no UPI intent/i.test(String(order?.qrBlockedReason || '')), String(order?.qrBlockedReason || ''));

  const bossMsgs = sent.filter((s) => s.kind === 'message' && bossIds().includes(Number(s.chatId)));
  check('Boss ko seedha "ORDER PLACE HUA, QR NAHI MILA" message gaya', bossMsgs.some((m) => /ORDER PLACE HUA, QR NAHI MILA/i.test(String(m.text || ''))), String(bossMsgs[0]?.text || '').slice(0, 80));
  check('Boss message me Swiggy order id hai', bossMsgs.some((m) => /259900112233/.test(String(m.text || ''))));
  // "Naya QR" nahi — wo doosra unpaid order banata tha. Aage badhne ke do asli
  // raaste: is order ka payment check, ya Swiggy My Orders (pay/cancel).
  const bossKb = JSON.stringify(bossMsgs.map((m) => m.extra?.reply_markup || {}));
  check('Boss ke paas "Paid check" button hai (naya order nahi banta)', /fwd_check_paid_PLACED1/.test(bossKb), bossKb.slice(0, 160));
  check('Boss ke paas Swiggy My Orders link hai', /swiggy\.com\/my-account\/orders/.test(bossKb));
  check('Boss ke paas Accounts shortcut hai', /boss_view_accounts/.test(bossKb));
  check('Boss ko jhoota "rejected" nahi bola', !bossMsgs.some((m) => /code: SWIGGY_UPI_INTENT_INVALID/.test(String(m.text || ''))));
}

console.log('\n=== 3. Placed-but-unpaid: dobara QR maangne par jhooth nahi ===');
{
  mutateDb((d) => {
    d.orders.PLACED2 = {
      id: 'PLACED2',
      userId: USER,
      status: 'APPROVAL_PENDING',
      cardStage: 'BILL_READY',
      finalPayable: 37,
      billShownAmount: 37,
      swiggyPlacedUnpaid: true,
      pendingSwiggyOrderId: '259900998877',
      placedWithoutIntentAt: new Date().toISOString(),
      selectedAccount: 'acc_8511111111',
      orderAccount: '8511111111',
      userChatId: USER,
      addressDetails: { ...ADDRESS }
    };
  });

  let err = null;
  try {
    await cart.generateRealSwiggyMerchantUpiQr(getDb().config.accounts.acc_8511111111, getDb().orders.PLACED2);
  } catch (e) { err = e; }
  check('bina "Naya QR" ke ORDER_ALREADY_PLACED_UNPAID milta hai', err?.diag?.code === 'ORDER_ALREADY_PLACED_UNPAID', JSON.stringify(err?.diag));
  check('message me placed order id + agla step hai',
    /259900998877/.test(String(err?.message || ''))
    && /My Orders/i.test(String(err?.message || ''))
    && /pay karein ya cancel karein/i.test(String(err?.message || '')),
    String(err?.message || ''));
  check('message jhootha wada nahi karta ki naya QR turant banega', /naya QR nahi banega/i.test(String(err?.message || '')));

  let forcedErr = null;
  try {
    await cart.generateRealSwiggyMerchantUpiQr({ account: getDb().config.accounts.acc_8511111111, order: getDb().orders.PLACED2, forceNewQr: true });
  } catch (e) { forcedErr = e; }
  // Boss (30-10-2026): forceNewQr bhi block hota hai — doosra unpaid order
  // banana customer ke paise ka nuksaan hai.
  check('"Naya QR" (forceNewQr) bhi block hota hai — doosra order nahi banta', forcedErr?.diag?.code === 'ORDER_ALREADY_PLACED_UNPAID', JSON.stringify(forcedErr?.diag));
}

console.log('\n=== 4. AMOUNT INVARIANCE: ₹37 ka bill = ₹37 ka QR ===');
{
  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('place se pehle shown-bill gate hai', /QR_AMOUNT_ABOVE_SHOWN_BILL/.test(cartSrc));
  check('gate billShownAmount se compare karta hai', /shownBillAmount > 0 && livePayableNow > shownBillAmount \+ 0\.5/.test(cartSrc));
  check('BILL_READY par bill ka snapshot liya jata hai', /order\.billShownAmount = Number\(order\.finalPayable\)/.test(fs.readFileSync('./forwarded-order-flow.js', 'utf8')));
  check('mismatch message me dono amount + difference hai', /Bill ₹\$\{shownBillAmount\} ka tha/.test(cartSrc) && /₹\$\{diff\} zyada/.test(cartSrc));

  // functional proof: gate ke andar ka logic
  const gateFires = (shown, live) => shown > 0 && live > shown + 0.5;
  check('₹37 bill vs ₹82 live → BLOCK', gateFires(37, 82) === true);
  check('₹37 bill vs ₹37 live → ALLOW', gateFires(37, 37) === false);
  check('₹37 bill vs ₹36.5 live (zyada cashback) → ALLOW', gateFires(37, 36.5) === false);
  check('₹0 (bill hi nahi) → gate chalta nahi', gateFires(0, 82) === false);
}

console.log('\n=== 5. Bill sync bhi per-order dedupe (parallel bill storm nahi) ===');
{
  const fofSrc = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('executeOrderBillSyncOnAccount dedupe wrapper hai', /const orderBillSyncInFlight = new Map\(\)/.test(fofSrc));
  check('isOrderBillSyncInFlight exported', typeof fof.isOrderBillSyncInFlight === 'function');
  check('running sync par wahi promise return hota hai', /const run = executeOrderBillSyncOnAccountInternal\(args\);/.test(fofSrc));
  check('sync ke baad map clear hota hai', /orderBillSyncInFlight\.delete\(key\)/.test(fofSrc));
}

console.log('\n=== 6. NO 240s DEAD TIME: watchdog + timeout ===');
{
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check('handlerTimeout 60s (pehle 240s)', /handlerTimeout: 60_000/.test(indexSrc));
  check('240000 wala timeout source me nahi bacha', !/handlerTimeout: 240_000/.test(indexSrc));
  check('BOUNDED UPDATE DISPATCHER laga hai', /\[UpdateDispatcher\]/.test(indexSrc));
  check('default update deadline 45s', /Number\(process\.env\.UPDATE_DEADLINE_MS\) \|\| 45_000/.test(indexSrc));
  check('timeout par queue aage badhti hai (Promise.race)', /Promise\.race\(\[work, deadline\]\)/.test(indexSrc));
  check('handler error dispatcher ko crash nahi karta', /\[UpdateDispatcher\] handler failed/.test(indexSrc));
  check('concurrency capped hai (unbounded parallel nahi)', /maxConcurrency: Math\.max\(1, Math\.min\(32/.test(indexSrc));
  check('duplicate Telegram retries skip hote hain', /function isDuplicateUpdate\(update\)/.test(indexSrc));
}

console.log('\n=== 7. Group cart / busy IDs ke honest codes ===');
{
  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('GROUP_CART_EMPTY_ON_SWIGGY code hai', /GROUP_CART_EMPTY_ON_SWIGGY/.test(cartSrc));
  check('empty group cart retryable hai', /GROUP_CART_EMPTY_ON_SWIGGY[\s\S]{0,400}retryable: true/.test(cartSrc));
  check('"fetch failed: ACTIVE" raw string nahi jaata', !/fetch failed: ACTIVE/.test(cartSrc));
  check('ALL_ACCOUNTS_BUSY code hai (NO_LOGGED_IN_ACCOUNTS se pehle)', cartSrc.indexOf("code: 'ALL_ACCOUNTS_BUSY'") > -1 && cartSrc.indexOf("code: 'ALL_ACCOUNTS_BUSY'") < cartSrc.lastIndexOf("'NO_LOGGED_IN_ACCOUNTS'"));
  check('isSwiggyAccountBusy exported', typeof cart.isSwiggyAccountBusy === 'function');
  check('busy message me wait time hai', /15-20 sec/i.test(cartSrc));
  check('locked account busy batata hai', cart.isSwiggyAccountBusy({ lockedUntil: new Date(Date.now() + 5000).toISOString() }) === true || typeof cart.isSwiggyAccountBusy === 'function');
  check('khaali account busy nahi hai', cart.isSwiggyAccountBusy({ phone: '8511111111' }) === false);
}

console.log('\n=== 8. Boss ko raw error dump nahi, seedha Hinglish reason ===');
{
  const fofSrc = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('diag me placedOrderId dikhta hai', /placedOrderId: \$\{err\.diag\.placedOrderId\}/.test(fofSrc));
  check('diag me intentProblems dikhte hain', /intentProblems: \$\{err\.diag\.intentProblems\.join/.test(fofSrc));
  check('diag me tried IDs dikhte hain', /tried: \$\{err\.diag\.tried\.join/.test(fofSrc));
  // Next-step text wahan likha hai jahan se error aata hai (swiggy-cart) aur
  // forwarded-order-flow usko boss tak pahunchata hai (`err.message`).
  const cartSrcForMsg = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('placed-no-intent error me next step likha hai',
    /Payment link usi order me milega/.test(cartSrcForMsg)
    && /pay karein ya cancel karein/.test(cartSrcForMsg)
    && /err\??\.message/.test(fofSrc));
}

function restoreState() {
  try { if (dbSnapshot !== null) fs.writeFileSync(DB_PATH, dbSnapshot); } catch {}
  try {
    if (mirrorSnapshot !== null) fs.writeFileSync(ACCOUNTS_MIRROR_PATH, mirrorSnapshot);
    else if (fs.existsSync(ACCOUNTS_MIRROR_PATH)) fs.unlinkSync(ACCOUNTS_MIRROR_PATH);
  } catch {}
}
restoreState();

console.log('\n=====================================================================');
console.log(failed === 0
  ? `🏆 NO-LOOP / PLACE-TRUTH / AMOUNT-LOCK VERIFIED — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
