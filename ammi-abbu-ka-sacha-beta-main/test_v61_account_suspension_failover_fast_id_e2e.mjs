/**
 * v61 — "ACCOUNT SUSPEND HO GAYA TO USER KA ORDER KAISE MILEGA?"  +  "ID SELECTION FAST"
 *
 * Boss (26-10-2026): "pichla problem jo aaya tha wo is wajah se shayad ki account
 * suspend hogaya tha ... agar ho to tu kya step lega ki user ka order usko miljaye
 * and id selection thora fast ho"
 *
 * Pehle kya hota tha:
 *   - Swiggy ek ID ko block karta hai (session theek, par order place par
 *     "account blocked/suspended") → bot ise aam error samajh kar wahi ID
 *     dobara try karta rehta tha → customer ka order atak jata tha.
 *   - QR failover par poora multi-account NETWORK scan hota tha → ID selection
 *     minute bhar leta tha.
 *
 * Ab (proven here):
 *   1. Har failure classify hoti hai — SUSPENDED vs SESSION_EXPIRED vs WAF vs
 *      RATE_LIMIT vs TRANSIENT. Sirf asli suspension ID ko quarantine karti hai.
 *   2. Suspended ID rotation/ladder/BEST-scan me kabhi pick nahi hoti (⛔),
 *      quarantine 6 ghante (config), phir ek retry — jhoothi flag permanent nahi.
 *   3. Order rukta nahi — bill aur QR dono stage par INSTANT local failover
 *      healthy ID par, customer ko QR wahin milta hai, Boss ko alert.
 *   4. Sab ID suspended → honest error + Boss ko ⛔ Retry button (fake QR nahi).
 *   5. Speed: 12s ID budget, 8s fast-switch lock, parallel auth, pre-warm,
 *      failover me network scan ki jagah local pick.
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
const { planAccountFallbacks } = await import('./lazy-order-pilot.js');
const fof = await import('./forwarded-order-flow.js');
const { getDb, mutateDb, upsertOrder } = store;

const USER = 6161601;
const BOSS = 6161600;

console.log('\n=== 1. Failure classification (suspension vs baaki sab) ===');
{
  const cases = [
    ['Your account has been blocked', 'SUSPENDED', true],
    ['Account suspended due to suspicious activity', 'SUSPENDED', true],
    ['You are not allowed to place order', 'SUSPENDED', true],
    ['This account is temporarily blocked, try later', 'SUSPENDED', true],
    ['Ordering has been disabled for your account', 'SUSPENDED', true],
    ['Session expired, please login again', 'SESSION_EXPIRED', false],
    ['Request blocked by AWS WAF challenge', 'WAF', false],
    ['Too many requests, slow down', 'RATE_LIMIT', false],
    ['Something went wrong', 'UNKNOWN', false]
  ];
  for (const [msg, kind, suspended] of cases) {
    const f = health.classifySwiggyAccountFailure({ message: msg });
    check(`"${msg.slice(0, 34)}" → ${kind}`, f.kind === kind && f.suspended === suspended, `got ${f.kind}/${f.suspended}`);
  }
  const s999 = health.classifySwiggyAccountFailure({ message: '', statusCode: 999 });
  check('statusCode 999 → session expired (not suspended)', s999.kind === 'SESSION_EXPIRED' && s999.sessionDead === true);
  const waf403 = health.classifySwiggyAccountFailure({ message: 'Access Denied', httpStatus: 403 });
  check('403 + Access Denied → WAF, ID quarantine nahi', waf403.suspended === false && waf403.kind === 'WAF');
  const blocked403 = health.classifySwiggyAccountFailure({ message: 'Your account is blocked', httpStatus: 403 });
  check('403 + "account is blocked" → SUSPENDED', blocked403.suspended === true);
  const empty = health.classifySwiggyAccountFailure({});
  check('empty failure is retryable UNKNOWN', empty.kind === 'UNKNOWN' && empty.retryable === true);
  check('suspension reason carries the real Swiggy text', /blocked/i.test(health.classifySwiggyAccountFailure({ message: 'Your account has been blocked' }).reason));
}

console.log('\n=== 2. Quarantine: suspend → clear → expiry ===');
{
  mutateDb((d) => {
    d.config.accounts = {
      acc_9000000001: { id: 'acc_9000000001', phone: '9000000001', name: 'Suspended ID', isLoggedIn: true, cookies: 'x=1', tid: 'a.b.c' },
      acc_9000000002: { id: 'acc_9000000002', phone: '9000000002', name: 'Healthy ID', isLoggedIn: true, cookies: 'y=2', tid: 'd.e.f' }
    };
    d.config.bossUpiId = 'ammi.family@okaxis';
    d.orders = {};
  });

  check('fresh account is not suspended', health.isAccountSuspended(getDb().config.accounts.acc_9000000001) === false);
  const marked = health.markAccountSuspended('acc_9000000001', { reason: 'account blocked by Swiggy', code: 'account-blocked', stage: 'test', orderId: 'TEST1' });
  check('markAccountSuspended sets healthStatus', marked?.healthStatus === 'SUSPENDED');
  check('isAccountSuspended true after marking', health.isAccountSuspended(getDb().config.accounts.acc_9000000001) === true);
  check('suspendedUntil ~6h ahead', Date.parse(getDb().config.accounts.acc_9000000001.suspendedUntil) > Date.now() + 5 * 3600 * 1000);
  check('session is NOT destroyed (login bilkul theek hai)', getDb().config.accounts.acc_9000000001.isLoggedIn === true);
  check('reason stored for the card', /blocked by Swiggy/.test(getDb().config.accounts.acc_9000000001.suspendReason));
  check('describeSuspendedAccount mentions the reason', /blocked by Swiggy/.test(health.describeSuspendedAccount(getDb().config.accounts.acc_9000000001)));
  check('health event logged for audit', (getDb().config.accountHealthEvents || []).some((e) => e.type === 'SUSPENDED' && e.key === 'acc_9000000001'));

  health.markAccountSuspended('acc_9000000001', { reason: 'again', ttlMs: 60_000 });
  check('re-mark increments suspendCount (honest history)', getDb().config.accounts.acc_9000000001.suspendCount === 2);

  // quarantine expiry → ID dobara ek mauka
  mutateDb((d) => { d.config.accounts.acc_9000000001.suspendedUntil = new Date(Date.now() - 1000).toISOString(); });
  check('quarantine khatam → ID phir try hogi (permanent block nahi)', health.isAccountSuspended(getDb().config.accounts.acc_9000000001) === false);

  health.markAccountSuspended('acc_9000000001', { reason: 'third time' });
  health.markAccountHealthy('acc_9000000001', { note: 'manual retry' });
  const healed = getDb().config.accounts.acc_9000000001;
  check('markAccountHealthy clears suspension', health.isAccountSuspended(healed) === false && healed.healthStatus === 'HEALTHY');
  check('markAccountHealthy logs HEALTHY event', (getDb().config.accountHealthEvents || []).some((e) => e.type === 'HEALTHY'));
  check('suspendedAccountsSummary counts 0 now', health.suspendedAccountsSummary().count === 0);
}

console.log('\n=== 3. Rotation: suspended ID kabhi pick nahi hoti ===');
{
  health.markAccountSuspended('acc_9000000001', { reason: 'blocked for promo abuse' });
  const order = { id: 'ROT1', userId: USER, status: 'ACCEPTED', cardStage: 'BILL_READY', finalPayable: 43, selectedAccount: '' };
  const rows = cart.describeAccountRotation(order);
  const suspendedRow = rows.find((r) => r.key === 'acc_9000000001');
  check('rotation row marks SUSPENDED', suspendedRow?.status === 'SUSPENDED', suspendedRow?.status);
  check('row carries the suspension reason', /promo abuse/.test(String(suspendedRow?.suspendedReason || '')));
  check('suspended row ranks LAST', rows[rows.length - 1]?.key === 'acc_9000000001');
  const pick1 = cart.pickNextRotationAccount(order);
  check('picker skips the suspended ID', pick1?.success === true && pick1.key === 'acc_9000000002', JSON.stringify(pick1));

  const ladder = planAccountFallbacks(getDb().config.accounts, order);
  check('fallback ladder also skips suspended ID', ladder.every((r) => r.key !== 'acc_9000000001'), JSON.stringify(ladder.map((r) => r.key)));

  health.markAccountSuspended('acc_9000000002', { reason: 'second ID also blocked' });
  const allSusp = cart.pickNextRotationAccount(order);
  check('all suspended → ALL_ACCOUNTS_SUSPENDED (no silent reuse)', allSusp?.success === false && allSusp.code === 'ALL_ACCOUNTS_SUSPENDED', JSON.stringify(allSusp));
  check('message is honest and actionable', /suspended/i.test(allSusp.error) && /Naya ID login/i.test(allSusp.error));

  const summary = health.suspendedAccountsSummary();
  check('summary lists both IDs', summary.count === 2 && summary.text.includes('2 ID suspended'));

  // reset for the next section
  health.markAccountHealthy('acc_9000000001'); health.markAccountHealthy('acc_9000000002');
  check('after retry both IDs are usable again', cart.pickNextRotationAccount(order)?.success === true);
}

console.log('\n=== 4. Bill sync par suspended ID → turant honest error (network waste nahi) ===');
{
  upsertOrder('BILL1', {
    id: 'BILL1', userId: USER, status: 'ACCEPTED', cardStage: 'BILL_READY',
    finalPayable: 43, restaurantName: 'Pizza Hut', items: [{ name: 'X', qty: 1, price: 43 }],
    selectedAccount: 'acc_9000000001', orderAccount: '9000000001', userChatId: USER, bossMessageIds: {},
    addressDetails: { name: 'Sneha', mobile: '9109533577', address: 'Test', lat: '26.9', lng: '82.1' }
  });
  health.markAccountSuspended('acc_9000000001', { reason: 'blocked', stage: 'seed' });
  let threw = null;
  try {
    await fof.executeOrderBillSyncOnAccount({
      telegram: { sendMessage: async () => ({ message_id: 1 }) },
      chatId: BOSS,
      orderId: 'BILL1',
      accKey: 'acc_9000000001',
      formatOrderBodyFn
    });
  } catch (e) { threw = e; }
  check('suspended ID par bill sync throw karta hai', Boolean(threw), String(threw?.message || 'no throw'));
  check('diag code ACCOUNT_SUSPENDED', threw?.diag?.code === 'ACCOUNT_SUSPENDED', JSON.stringify(threw?.diag));
  check('message says order dusri ID par shift hoga', /dusri ID par shift/i.test(String(threw?.message || '')));
  health.markAccountHealthy('acc_9000000001');
}

console.log('\n=== 5. QR stage: ID suspend → order NAHI rukta, healthy ID se QR ===');
{
  const sent = [];
  const telegram = {
    sendMessage: async (chatId, text, extra) => { sent.push({ kind: 'message', chatId, text, extra }); return { message_id: 500 + sent.length }; },
    sendPhoto: async (chatId, photo, extra) => { sent.push({ kind: 'photo', chatId, photo, extra }); return { message_id: 700 + sent.length }; },
    editMessageText: async (chatId, messageId, inline, extra) => { sent.push({ kind: 'editText', chatId, messageId, text: extra?.text }); return { message_id: messageId }; },
    editMessageCaption: async (chatId, messageId, inline, extra) => ({ message_id: messageId }),
    editMessageReplyMarkup: async () => ({}),
    deleteMessage: async (chatId, messageId) => { sent.push({ kind: 'delete', chatId, messageId }); return true; }
  };

  mutateDb((d) => {
    d.config.bossIds = [...new Set([...(d.config.bossIds || []), BOSS])];
    d.config.accounts = {
      acc_9111111111: { id: 'acc_9111111111', phone: '9111111111', name: 'Blocked ID', isLoggedIn: true, cookies: 'a=1', tid: 'x.y.z' },
      acc_9222222222: { id: 'acc_9222222222', phone: '9222222222', name: 'Healthy ID', isLoggedIn: true, cookies: 'b=2', tid: 'p.q.r' }
    };
    d.orders = {
      SUSP1: {
        id: 'SUSP1',
        userId: USER,
        userName: 'Ammi',
        status: 'APPROVAL_PENDING',
        cardStage: 'BILL_READY',
        paymentStatus: 'UNPAID',
        restaurantName: 'Pizza Hut',
        items: [{ name: 'Margherita', qty: 1, price: 420 }],
        subtotal: 420,
        finalPayable: 43,
        selectedAccount: 'acc_9111111111',
        orderAccount: '9111111111',
        userChatId: USER,
        bossMessageIds: {},
        addressDetails: { name: 'Sneha', mobile: '9109533577', address: '350, MIG 2, New Subhash Nagar', lat: '26.9', lng: '82.1' }
      }
    };
  });

  const qrCalls = [];
  const customRealQrGenerator = async (acc, order) => {
    qrCalls.push(acc.phone);
    if (String(acc.phone) === '9111111111') {
      const err = new Error('Swiggy payment gateway rejected QR creation: HTTP 200, statusCode=1, msg="Your account has been blocked"');
      err.diag = {
        code: 'SWIGGY_PLACE_ORDER_QR_FAILED',
        stage: 'POST_PAYMENTS_ORDER_PLACE',
        httpStatus: 200,
        swiggyStatusCode: 1,
        swiggyMessage: 'Your account has been blocked',
        rawSnippet: '{"statusCode":1,"statusMessage":"Your account has been blocked"}'
      };
      throw err;
    }
    return {
      upiIntentUrl: `upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=${order.finalPayable}&cu=INR&tr=SUSP${Date.now()}`,
      swiggyOrderId: '251888777666',
      paymentTxnId: 'TXN_SUSP1',
      amount: order.finalPayable,
      restaurantName: order.restaurantName,
      slaMinutes: '30'
    };
  };

  let qrErr = null;
  try {
    await fof.executeRealQrGenerationForOrder({
      telegram,
      chatId: USER,
      orderId: 'SUSP1',
      formatOrderBodyFn,
      customRealQrGenerator,
      forceNewQr: true
    });
  } catch (e) { qrErr = e; }

  const photo = sent.find((s) => s.kind === 'photo');
  check('QR generate fail nahi hua — healthy ID par ban gaya', !qrErr, String(qrErr?.message || ''));
  check('generator pehle blocked ID, phir healthy ID par chala', qrCalls[0] === '9111111111' && qrCalls[1] === '9222222222', JSON.stringify(qrCalls));
  check('customer ko QR bhej diya (order ruka nahi)', Boolean(photo) && String(photo.chatId) === String(USER));
  check('QR caption me healthy ID dikhti hai', /9222222222/.test(String(photo?.extra?.caption || '')), String(photo?.extra?.caption || '').slice(0, 120));
  check('QR caption me "Paid" button hai', /fwd_check_paid_SUSP1/.test(JSON.stringify(photo?.extra?.reply_markup || {})));

  const afterOrder = getDb().orders.SUSP1;
  check('order ab healthy ID par hai', afterOrder.selectedAccount === 'acc_9222222222', afterOrder.selectedAccount);
  check('order QR_GENERATED stage par pahuncha', afterOrder.cardStage === 'QR_GENERATED', afterOrder.cardStage);
  check('purana account failover note order par hai', afterOrder.accountFailoverFrom === '9111111111');
  check('valid UPI intent hi store hua', /^upi:\/\/pay\?pa=upiswiggy@icici/.test(String(afterOrder.pendingSwiggyUpiUri || '')));
  check('blocked ID vault me suspended mark ho gayi', health.isAccountSuspended(getDb().config.accounts.acc_9111111111) === true);
  check('suspended ID ka session delete nahi hua', getDb().config.accounts.acc_9111111111.isLoggedIn === true);

  const bossIds = (getDb().config.bossIds || []).map(Number);
  const bossMsg = sent.find((s) => s.kind === 'message' && bossIds.includes(Number(s.chatId)));
  check('Boss ko suspension alert gaya', Boolean(bossMsg), JSON.stringify(sent.filter((s) => s.kind === 'message').map((s) => s.chatId)));
  check('Boss alert me ID + reason hai', /9111111111/.test(String(bossMsg?.text || '')) && /blocked/i.test(String(bossMsg?.text || '')));
  check('Boss alert me "order shift ho gaya" hai', /shift ho gaya/i.test(String(bossMsg?.text || '')));
  check('Boss ke paas ⛔ Retry button hai', /boss_retry_acc_acc_9111111111/.test(JSON.stringify(bossMsg?.extra?.reply_markup || {})));

  // second account QR ke baad healthy mark hua
  check('healthy ID healthy mark hui', health.isAccountSuspended(getDb().config.accounts.acc_9222222222) === false);
}

console.log('\n=== 6. Sab ID suspended → fake QR nahi, honest error ===');
{
  const sent = [];
  const telegram = {
    sendMessage: async (chatId, text, extra) => { sent.push({ kind: 'message', chatId, text, extra }); return { message_id: 900 + sent.length }; },
    sendPhoto: async (chatId, photo, extra) => { sent.push({ kind: 'photo', chatId, extra }); return { message_id: 950 }; },
    editMessageText: async () => ({}),
    editMessageCaption: async () => ({}),
    editMessageReplyMarkup: async () => ({}),
    deleteMessage: async () => true
  };
  mutateDb((d) => {
    d.config.bossIds = [...new Set([...(d.config.bossIds || []), BOSS])];
    d.config.accounts = {
      acc_9333333333: { id: 'acc_9333333333', phone: '9333333333', isLoggedIn: true, cookies: 'c=3', tid: 'm.n.o' },
      acc_9444444444: { id: 'acc_9444444444', phone: '9444444444', isLoggedIn: true, cookies: 'd=4', tid: 's.t.u' }
    };
    d.orders.ALLSUSP = {
      id: 'ALLSUSP', userId: USER, status: 'APPROVAL_PENDING', cardStage: 'BILL_READY',
      finalPayable: 43, selectedAccount: 'acc_9333333333', orderAccount: '9333333333',
      restaurantName: 'Pizza Hut', items: [{ name: 'X', qty: 1, price: 43 }], userChatId: USER, bossMessageIds: {},
      addressDetails: { name: 'Sneha', mobile: '9109533577', address: 'Test address', lat: '26.9', lng: '82.1' }
    };
    d.config.accounts.acc_9444444444.healthStatus = 'HEALTHY';
  });

  const alwaysBlocked = async () => {
    const err = new Error('Swiggy rejected: account suspended');
    err.diag = { code: 'SWIGGY_PLACE_ORDER_QR_FAILED', swiggyMessage: 'Account suspended due to suspicious activity', httpStatus: 200, swiggyStatusCode: 1 };
    throw err;
  };

  let err = null;
  try {
    await fof.executeRealQrGenerationForOrder({
      telegram, chatId: USER, orderId: 'ALLSUSP', formatOrderBodyFn, customRealQrGenerator: alwaysBlocked
    });
  } catch (e) { err = e; }

  check('QR throw hua (fake QR nahi bheja)', Boolean(err), 'no throw');
  check('no QR photo was sent', !sent.some((s) => s.kind === 'photo'));
  check('diag code ALL_ACCOUNTS_SUSPENDED', err?.diag?.code === 'ALL_ACCOUNTS_SUSPENDED', JSON.stringify(err?.diag));
  check('error lists which IDs were tried', Array.isArray(err?.diag?.tried) && err.diag.tried.length >= 2, JSON.stringify(err?.diag?.tried));
  check('error is honest Hinglish with next step', /Naya ID login/i.test(String(err?.message || '')));
  check('dono ID suspended mark hui', health.isAccountSuspended(getDb().config.accounts.acc_9333333333) && health.isAccountSuspended(getDb().config.accounts.acc_9444444444));
  const bossIds2 = (getDb().config.bossIds || []).map(Number);
  const bossMsgs = sent.filter((s) => s.kind === 'message' && bossIds2.includes(Number(s.chatId)));
  check('Boss ko "koi healthy ID nahi mili" alert gaya', bossMsgs.some((m) => /Koi healthy ID nahi mili/i.test(String(m.text || ''))), String(bossMsgs[0]?.text || '').slice(0, 90));
}

console.log('\n=== 7. SPEED: ID selection fast ===');
{
  const fofSrc = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');

  check('BEST scan budget default 12s (pehle 22s)', /Number\(process\.env\.ID_SELECT_BUDGET_MS\) \|\| 12_000/.test(fofSrc));
  check('timeout backstop 4s (pehle 6s)', /scanBudgetMs \+ 4_000/.test(fofSrc));
  check('instant switch lock wait 8s (pehle 25s)', /maxWaitMs: skipAutoOffers \? 8_000 : 25_000/.test(fofSrc));
  check('baseline auth sync ke saath parallel chalti hai', /const baselineAuthPromise = baselineAcc/.test(fofSrc) && /await baselineAuthPromise/.test(fofSrc));
  check('QR failover local pick karta hai (network scan nahi)', /pickNextRotationAccount\(order, \{ excludeKeys: failedKeys \}\)/.test(fofSrc));
  check('QR failover me findBestMaxCouponAccountForOrder nahi bacha', !/catch \(qrErr\)[\s\S]{0,2500}findBestMaxCouponAccountForOrder/.test(fofSrc));
  check('next ID pre-warm hota hai (session auth cache)', /void warmAccountSessionAuth\(nextPick\.key\)/.test(fofSrc));
  check('warmAccountSessionAuth exported', typeof cart.warmAccountSessionAuth === 'function');

  // functional: warm call never hangs and never touches a suspended ID
  health.markAccountSuspended('acc_9333333333', { reason: 'warm skip test' });
  const t0 = Date.now();
  const warmed = await cart.warmAccountSessionAuth('acc_9333333333');
  const ms = Date.now() - t0;
  check('suspended ID ke liye warm call turant false (no network)', warmed === false && ms < 200, `${ms}ms`);

  // rotation decision is pure-local (no network): 200 picks in < 200ms
  const order = { id: 'FAST1', status: 'ACCEPTED', selectedAccount: 'acc_9333333333' };
  const t1 = Date.now();
  for (let i = 0; i < 200; i++) cart.describeAccountRotation(order);
  const rotMs = Date.now() - t1;
  check(`rotation decision local & instant (200 picks in ${rotMs}ms)`, rotMs < 400);
}

console.log('\n=== 8. Wiring: Boss/customer buttons + UI truth ===');
{
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  const viewsSrc = fs.readFileSync('./account-views.js', 'utf8');
  const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
  const pilotSrc = fs.readFileSync('./lazy-order-pilot.js', 'utf8');

  check('boss_use_acc refuses a suspended ID', /isAccountSuspended\(db\.config\.accounts\[accKey\]\)/.test(indexSrc));
  check('Boss has boss_retry_acc_ action (quarantine clear)', /bot\.action\(\/\^boss_retry_acc_/.test(indexSrc));
  check('order picker has fwd_retry_susp_ (suspended retry)', /bot\.action\(\/\^fwd_retry_susp_/.test(fs.readFileSync('./forwarded-order-flow.js', 'utf8')));
  check('rotation icon shows ⛔ for suspended', /SUSPENDED: '⛔'/.test(fs.readFileSync('./forwarded-order-flow.js', 'utf8')));
  check('account list line shows ⛔ suspended', /⛔ suspended/.test(viewsSrc));
  check('account detail shows suspension reason', /⛔ Suspended —/.test(viewsSrc));
  check('BEST scan skips suspended IDs', /!isAccountSuspended\(a\)/.test(cartSrc));
  check('fallback ladder skips suspended IDs', /isAccountSuspended\(acc\)\) return false/.test(pilotSrc));
  check('cart sync marks suspension from Swiggy message', /suspendedFailureResult\(\{/.test(cartSrc));
  check('QR place failure classifies suspension', /suspendFailure\.suspended\s*\n?\s*\? 'ACCOUNT_SUSPENDED'/.test(cartSrc) && /SWIGGY_PLACE_ORDER_QR_FAILED/.test(cartSrc));
  check('successful sync clears quarantine (honest, not permanent)', /markAccountHealthy\(healthyKey, \{ note: 'cart sync ok' \}\)/.test(cartSrc));
  check('bossbot vendor has account-health.js', fs.existsSync('./bossbot/vendor/account-health.js'));
  check('bossbot vendor swiggy-cart rotates suspended IDs too', fs.readFileSync('./bossbot/vendor/swiggy-cart.js', 'utf8').includes('ROTATION_SUSPENDED'));
}

// restore db + session mirror (tests must never leave fake IDs in the vault)
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
  ? `🏆 ACCOUNT SUSPENSION FAILOVER + FAST ID SELECTION VERIFIED — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
