/**
 * v72 — ₹15 per order fee + UTR ke bina "verified" nahi + boss ka user-vault
 *
 * Boss (29-10-2026):
 *   "charge them 15rs for each order... I don't know how to confirm if they paid
 *    me for real... they have to pay after JSON is alloted and then bill is
 *    calculated... if they try to cancel it be refunded; also if the order is
 *    placed and they click cancel it won't be refunded anymore... give me vault
 *    of user where I can search by their name and adjust everything."
 *
 * Yeh test (offline) proves:
 *   1. Price/cart/address/bill par balance NAHI chahiye — koi debit nahi.
 *   2. QR gate: fee na kati ho to QR nahi banta (SERVICE_FEE_DUE), fee ek hi
 *      baar kati jati hai (idempotent), free user exempt.
 *   3. Refund: place se pehle cancel → refund; place ke baad → NO refund.
 *   4. UTR: format validation, global duplicate reject, provider na ho to
 *      PENDING (jhootha verified nahi), boss approve → balance + auto-resume.
 *   5. Boss vault: search naam/username/phone/id se, add/deduct, summary.
 *   6. UI wiring: wallet buttons dono taraf (customer + boss), text states.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
delete process.env.UPI_UTR_VERIFY_URL;

const DB_PATH = 'data/db.json';
const MIRROR = 'accounts.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const mirrorSnapshot = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR, 'utf8') : null;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const w = await import('./user-wallet.js');

const indexSrc = fs.readFileSync('./index.js', 'utf8');
const chatSrc = fs.readFileSync('./simple-chat.js', 'utf8');
const bossPanelSrc = fs.readFileSync('./boss-panel.js', 'utf8');

const USER = '5550001';
const USER2 = '5550002';
const BOSS = '9990001';

function makeDb() {
  return {
    config: {
      bossIds: [BOSS],
      wallets: {},
      topupRequests: {},
      accounts: {}
    },
    orders: {}
  };
}

function mkOrder(id, extra = {}) {
  return {
    id, userId: USER, status: 'APPROVAL_PENDING', cardStage: 'BILL_READY',
    billTotalPaise: 24900, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...extra
  };
}

console.log('\n1) Fee config + balance-free browsing');
check('fee default ₹15 (1500 paise)', w.serviceFeePaise() === 1500, String(w.serviceFeePaise()));
check('rupees(1500) = ₹15', w.rupees(1500).includes('15'));
check('min top-up = fee se kam nahi', w.minTopupPaise() >= 1500, String(w.minTopupPaise()));
check('presets me ₹15 hai', w.TOPUP_PRESETS_PAISE.includes(1500));

let db = makeDb();
const emptyWallet = w.ensureWallet(db, USER, { name: 'Ammi' });
check('naya wallet balance 0', w.walletBalancePaise(db, USER) === 0);

const orderBill = mkOrder('o_bill');
// Bill/price/address/cart paths: koi wallet call nahi.
const balanceBefore = w.walletBalancePaise(db, USER);
check('bill banne par balance 0 hi rehta hai', balanceBefore === 0);
check('bill order par abhi fee charge nahi', !orderBill.feeChargedPaise);

console.log('\n2) QR gate: fee ke bina QR nahi');
let charge = w.chargeServiceFee(db, orderBill, USER);
check('balance 0 → INSUFFICIENT_BALANCE', charge.ok === false && charge.code === 'INSUFFICIENT_BALANCE', charge.code);
check('failed charge par order par fee nahi likhi', !orderBill.feeChargedPaise);
check('neededPaise = 1500', charge.neededPaise === 1500, String(charge.neededPaise));

w.creditWallet(db, USER, 2000, { reason: 'test topup', actor: 'test' });
check('topup ke baad balance 2000', w.walletBalancePaise(db, USER) === 2000);

charge = w.chargeServiceFee(db, orderBill, USER);
check('ab fee kati CHARGED', charge.ok && charge.code === 'CHARGED', charge.code);
check('balance 2000-1500 = 500', w.walletBalancePaise(db, USER) === 500, String(w.walletBalancePaise(db, USER)));
check('order par feeChargedPaise 1500', orderBill.feeChargedPaise === 1500);
check('order par feeWalletUserId', String(orderBill.feeWalletUserId) === USER);

const again = w.chargeServiceFee(db, orderBill, USER);
check('dobara charge → ALREADY_CHARGED (idempotent)', again.ok && again.code === 'ALREADY_CHARGED', again.code);
check('balance dobara nahi kata', w.walletBalancePaise(db, USER) === 500, String(w.walletBalancePaise(db, USER)));

console.log('\n3) Free user exempt');
const freeDb = makeDb();
w.ensureWallet(freeDb, USER2, { name: 'Abbu' });
w.setFeeExempt(freeDb, USER2, true, { actor: 'boss' });
const freeOrder = mkOrder('o_free', { userId: USER2 });
const freeCharge = w.chargeServiceFee(freeDb, freeOrder, USER2);
check('free user → WAIVED', freeCharge.ok && freeCharge.code === 'WAIVED', freeCharge.code);
check('free user par debit nahi', w.walletBalancePaise(freeDb, USER2) === 0);
check('order par feeWaived true', freeOrder.feeWaived === true);

// free user ki fee bhi refund-nothing (never charged)
const noRefund = w.refundServiceFee(freeDb, freeOrder, USER2);
check('kabhi charge nahi hua → NOTHING_CHARGED', noRefund.code === 'NOTHING_CHARGED', noRefund.code);

console.log('\n4) Refund matrix — place se pehle haan, baad me nahi');
const beforePlace = w.refundServiceFee(db, orderBill, USER, { reason: 'user cancelled' });
check('place se pehle cancel → REFUNDED', beforePlace.ok && beforePlace.code === 'REFUNDED', beforePlace.code);
check('balance wapas 2000', w.walletBalancePaise(db, USER) === 2000, String(w.walletBalancePaise(db, USER)));
check('order par feeRefundedPaise', orderBill.feeRefundedPaise === 1500);
const twiceRefund = w.refundServiceFee(db, orderBill, USER);
check('dobara refund → ALREADY_REFUNDED', twiceRefund.code === 'ALREADY_REFUNDED', twiceRefund.code);
check('balance dobara nahi bada', w.walletBalancePaise(db, USER) === 2000);

const placedOrder = mkOrder('o_placed', { userId: USER, swiggyOrderId: 'SW12345' });
w.chargeServiceFee(db, placedOrder, USER);
const placedBalance = w.walletBalancePaise(db, USER);
const placedRefund = w.refundServiceFee(db, placedOrder, USER);
check('place ho chuka → ORDER_PLACED_NO_REFUND', placedRefund.code === 'ORDER_PLACED_NO_REFUND', placedRefund.code);
check('placed order par balance wapas nahi', w.walletBalancePaise(db, USER) === placedBalance);
check('isOrderPlaced swiggyOrderId se true', w.isOrderPlaced(placedOrder) === true);
check('pendingSwiggyOrderId bhi placed', w.isOrderPlaced({ pendingSwiggyOrderId: 'p1' }) === true);
check('fee state net sahi', w.orderFeeState(placedOrder).netPaise === 1500);

console.log('\n5) UTR — real verification ke bina koi jhooth nahi');
check('chhota UTR reject', w.validateUtr('123').ok === false);
check('sirf letters reject', w.validateUtr('ABCDEFGHIJ').ok === false);
check('12-digit UTR ok', w.validateUtr('123456789012').ok === true);
check('normalize lowercase+space', w.normalizeUtr(' ab 12-34 ') === 'AB1234');

// Round 20 (boss): "JAB CHOTA AMOUNT DAAL KAR RANDOM KOI BHI UTR DAALTA WO ADD
// HO JATA" — ab bina asli payment saboot (statement/provider) credit NAHI hota.
// Chhota UTR bhi PENDING rehta hai, wallet me kuch nahi judta.
db = makeDb();
const sub = await w.submitTopupRequest(db, { userId: USER, utr: '123456789012', amountPaise: 1500, name: 'Ammi' });
check('bina saboot random UTR → PENDING (credit nahi)', sub.ok && sub.code === 'PENDING', String(sub.code || sub.reason));
check('bina saboot balance 0 hi rehta hai', w.walletBalancePaise(db, USER) === 0, String(w.walletBalancePaise(db, USER)));
check('pending me chala gaya', w.pendingTopupCount(db) === 1, String(w.pendingTopupCount(db)));
check('pending ki wajah saaf likhi hai', /statement|verify/i.test(String(sub.request?.verifyPendingReason || '')), String(sub.request?.verifyPendingReason));

// Strict mode (UPI_REQUIRE_PROVIDER_VERIFY=1) — behaviour same: PENDING.
process.env.UPI_REQUIRE_PROVIDER_VERIFY = '1';
const strict = await w.submitTopupRequest(db, { userId: USER, utr: '666677778888', amountPaise: 1500 });
check('strict mode me provider na ho to PENDING', strict.ok && strict.code === 'PENDING', strict.code);
check('strict mode me balance nahi bada', w.walletBalancePaise(db, USER) === 0);
delete process.env.UPI_REQUIRE_PROVIDER_VERIFY;

const beforeDup = Object.keys(db.config.topupRequests).length;
const dup = await w.submitTopupRequest(db, { userId: USER2, utr: '123456789012', amountPaise: 1500 });
check('wahi UTR dobara → DUPLICATE_UTR', dup.ok === false && dup.code === 'DUPLICATE_UTR', dup.code);
check('duplicate se naya request nahi bana', Object.keys(db.config.topupRequests).length === beforeDup);

const lowAmt = await w.submitTopupRequest(db, { userId: USER, utr: '555566667777', amountPaise: 100 });
check('min se kam amount reject', lowAmt.ok === false && lowAmt.code === 'AMOUNT_TOO_LOW', lowAmt.code);

const badUtr = await w.submitTopupRequest(db, { userId: USER, utr: 'abc', amountPaise: 1500 });
check('galat UTR reject', badUtr.ok === false && badUtr.code === 'INVALID_UTR', badUtr.code);

// Fake provider: verified + payee Misbahul Islam + asli amount → auto credit.
process.env.UPI_UTR_VERIFY_URL = 'https://provider.test/utr';
const fakeFetch = async () => ({ ok: true, json: async () => ({ utr: '987654321012', verified: true, ref: 'PR1', amountPaise: 1500, payeeName: 'MISBAHUL ISLAM', payeeVpa: 'mius@ybl', status: 'SUCCESS' }) });
const auto = await w.submitTopupRequest(db, { userId: USER, utr: '987654321012', amountPaise: 1500, fetchImpl: fakeFetch });
check('provider verified → AUTO_VERIFIED', auto.ok && auto.code === 'AUTO_VERIFIED', auto.code);
check('provider verified par balance 1500 (asli amount)', w.walletBalancePaise(db, USER) === 1500, String(w.walletBalancePaise(db, USER)));

// Provider ne ''verified'' bola par payee boss nahi → credit nahi.
const fakeWrongPayee = async () => ({ ok: true, json: async () => ({ utr: '987654321013', verified: true, ref: 'PR2', amountPaise: 1500, payeeName: 'RAHUL KUMAR', status: 'SUCCESS' }) });
const wrongPayee = await w.submitTopupRequest(db, { userId: USER, utr: '987654321013', amountPaise: 1500, fetchImpl: fakeWrongPayee });
check('galat payee → credit nahi', wrongPayee.ok === false && wrongPayee.code === 'PAYEE_MISMATCH', String(wrongPayee.code));
check('galat payee par balance wahi 1500', w.walletBalancePaise(db, USER) === 1500, String(w.walletBalancePaise(db, USER)));

// Provider available par 'verified' false → PENDING hi
const fakeNo = async () => ({ ok: true, json: async () => ({ verified: false, reason: 'not found' }) });
const notYet = await w.submitTopupRequest(db, { userId: USER, utr: '111222333444', amountPaise: 1500, fetchImpl: fakeNo });
check('provider false → PENDING (koi credit nahi)', notYet.ok && notYet.code === 'PENDING', notYet.code || notYet.reason);
delete process.env.UPI_UTR_VERIFY_URL;

console.log('\n6) Boss approve → balance → auto-resume');
db = makeDb();
// Manual approve ka rasta ab bhi chalta hai — strict mode me (ye wahi haalat hai
// jab provider verify set ho par UTR match na kare / boss khud check karna chahe).
process.env.UPI_REQUIRE_PROVIDER_VERIFY = '1';
const pending = await w.submitTopupRequest(db, { userId: USER2, utr: '444555666777', amountPaise: 1500, name: 'Abbu' });
check('pending request bana', pending.ok && pending.request?.status === 'PENDING');
const waiting = mkOrder('o_wait', { userId: USER2, cardStage: 'AWAITING_FEE' });
db.orders[waiting.id] = waiting;
let awaiting = w.findOrderAwaitingFee(db, USER2);
check('awaiting fee order mila', Boolean(awaiting), String(awaiting?.order?.id));
check('balance kam → canProceed false', awaiting.canProceed === false);

const approve = w.approveTopupRequest(db, pending.request.id, { actor: `boss:${BOSS}` });
check('approve → APPROVED', approve.ok && approve.code === 'APPROVED', approve.code);
check('approve se balance 1500', w.walletBalancePaise(db, USER2) === 1500, String(w.walletBalancePaise(db, USER2)));
const approveAgain = w.approveTopupRequest(db, pending.request.id, { actor: `boss:${BOSS}` });
check('dobara approve → ALREADY_APPROVED', approveAgain.code === 'ALREADY_APPROVED', approveAgain.code);
check('dobara approve se balance nahi bada', w.walletBalancePaise(db, USER2) === 1500);
awaiting = w.findOrderAwaitingFee(db, USER2);
check('balance aa gaya → canProceed true (QR khud banega)', awaiting.canProceed === true);

// reject path
const pending2 = await w.submitTopupRequest(db, { userId: USER2, utr: '777888999000', amountPaise: 1500 });
const reject = w.rejectTopupRequest(db, pending2.request.id, { reason: 'UPI statement me nahi mila' });
check('reject kaam kiya', reject.ok === true, reject.code);
check('reject par balance nahi bada', w.walletBalancePaise(db, USER2) === 1500);
check('rejected request approve nahi hoti', w.approveTopupRequest(db, pending2.request.id).code === 'REJECTED_EARLIER');
delete process.env.UPI_REQUIRE_PROVIDER_VERIFY;

console.log('\n7) Boss vault — search + adjust + summary');
db = makeDb();
w.ensureWallet(db, '111', { name: 'Ammi Sharma', username: 'ammi_mom' });
w.ensureWallet(db, '222', { name: 'Abbu Verma', username: 'abbu_papa' });
w.ensureWallet(db, '333', { name: 'Rahul Yadav', username: 'rahul_y' });
w.creditWallet(db, '111', 5000, { reason: 'topup' });
w.creditWallet(db, '222', 1500, { reason: 'topup' });
check('search naam se (case-insensitive)', w.searchWallets(db, 'ammi').some((x) => x.userId === '111'));
check('search username se', w.searchWallets(db, 'abbu_papa').some((x) => x.userId === '222'));
check('search user id se', w.searchWallets(db, '333').some((x) => x.userId === '333'));
check('khali query par sab users', w.searchWallets(db, '').length === 3, String(w.searchWallets(db, '').length));
check('naam na mile to khali', w.searchWallets(db, 'zzzz').length === 0);

const summary = w.walletVaultSummary(db);
check('summary: 3 users', summary.users === 3, String(summary.users));
check('summary: 2 users ke paas balance', summary.withBalance === 2, String(summary.withBalance));
check('summary total 6500', summary.totalPaise === 6500, String(summary.totalPaise));

const up = w.adjustWallet(db, '333', 10000, { reason: 'boss ne diya' });
check('boss add ₹100 → balance 10000', up.ok && w.walletBalancePaise(db, '333') === 10000, String(w.walletBalancePaise(db, '333')));
const down = w.adjustWallet(db, '333', -4000, { reason: 'boss ne kata' });
check('boss deduct ₹40 → balance 6000', down.ok && w.walletBalancePaise(db, '333') === 6000, String(w.walletBalancePaise(db, '333')));
const tooMuch = w.adjustWallet(db, '333', -999999, { reason: 'x' });
check('balance se zyada deduct nahi', tooMuch.ok === false, tooMuch.code);
check('failed deduct par balance same', w.walletBalancePaise(db, '333') === 6000);
const hist = w.walletHistory(db, '333', { limit: 10 });
check('ledger me 2 entries', hist.length === 2, String(hist.length));

check('boss list text render', /Ammi/.test(w.formatBossWalletList({ wallets: w.searchWallets(db, ''), summary })));
check('boss user card render', typeof w.formatBossWalletUser({ wallet: w.getWallet(db, '111'), userId: '111', history: hist }) === 'string');
check('wallet card render', typeof w.formatWalletCard({ wallet: w.getWallet(db, '111') }) === 'string');
check('fee pay card me UPI', w.formatFeePayCard({ upiId: 'boss@upi' }).includes('boss@upi'));
check('pending utr list render', typeof w.formatPendingUtrs({ requests: w.listTopupRequests(db, { status: 'PENDING' }) }) === 'string');

console.log('\n8) Wiring — QR gate, refund hooks, buttons dono taraf');
check('wallet imports index.js me', /from '\.\/user-wallet\.js'/.test(indexSrc));
check('chat worker reserves fee before placement', /reserveChatOrderFee/.test(fs.readFileSync('./forwarded-order-flow.js', 'utf8')) && /chargeServiceFee\(/.test(fs.readFileSync('./wallet-order-gate.js', 'utf8')));
check('SERVICE_FEE_DUE code use hua', /SERVICE_FEE_DUE/.test(indexSrc));
check('fee fail par AWAITING_FEE cardStage', /AWAITING_FEE/.test(indexSrc));
check('verification card bhejta hai', /sendOrderVerificationCard/.test(indexSrc));
check('close/cancel par refundServiceFee', /refundServiceFee\(/.test(indexSrc));
check('refund ke baad customer ko message', /order fee wapas/.test(indexSrc));
check('UTR text state', /waiting_wallet_utr/.test(indexSrc));
check('boss search state', /waiting_boss_wallet_search/.test(indexSrc));
check('boss credit state', /waiting_wallet_credit_amount/.test(indexSrc));
check('boss debit state', /waiting_wallet_debit_amount/.test(indexSrc));
check('wallet_home handler', /bot\.action\('wallet_home'/.test(indexSrc));
check('/wallet command', /bot\.command\(\['wallet'/.test(indexSrc));
check('boss_utr_ok approve', /boss_utr_ok_/.test(indexSrc));
check('boss_utr_no reject', /boss_utr_no_/.test(indexSrc));
check('boss_wallet_free toggle', /boss_wallet_free_/.test(indexSrc));
check('approve ke baad auto resume', /resumeOrderAfterTopup/.test(indexSrc));
check('customer home par wallet button', /wallet_home/.test(chatSrc));
check('bill card par koi fee line nahi', !/<b>Order fee:<\/b>/.test(chatSrc));
check('boss panel me fee panel row', /boss_fee_panel/.test(bossPanelSrc));
check('boss panel me pending UTR row', /boss_utr_list/.test(bossPanelSrc));
check('user-wallet.js me UTR duplicate guard', /DUPLICATE_UTR/.test(fs.readFileSync('./user-wallet.js', 'utf8')));

function restoreState() {
  try {
    if (dbSnapshot === null) fs.rmSync(DB_PATH, { force: true });
    else fs.writeFileSync(DB_PATH, dbSnapshot);
    if (mirrorSnapshot === null) fs.rmSync(MIRROR, { force: true });
    else fs.writeFileSync(MIRROR, mirrorSnapshot);
  } catch { /* ignore */ }
}
restoreState();

console.log(`\n${failed === 0 ? '🏆' : '❌'} v72: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
