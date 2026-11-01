/**
 * v73 — QR pehle, fee baad me (customer ko "order par fee" jaisa kuch na lage)
 *
 * Boss (30-10-2026):
 *   "user ko feel na ho ki wo order par fees de raha — jab user QR button dabaye
 *    aur wo successfully generate ho tabhi usko fees ka ek QR jayega; agar QR
 *    making fail ho to user ko jayega 'QR making is failed try again'; jab QR
 *    ban jaye wo store rahega aur jab fee payment success for that specific
 *    order then wo QR release hoga. Simple rakhna hai. Usko option dena hai
 *    'you can contact the admin in any issue'. Mujhe order par kitna lena hai
 *    uska bhi panel — ek button 'wallet and fee' jisme sab dikhe."
 *
 * Yeh test (offline) proves:
 *   1. QR banane se pehle customer ko kuch nahi jata (koi fee card nahi).
 *   2. QR fail → sirf "try again" card, koi charge nahi.
 *   3. QR ready → QR HOLD hota hai (customer ko nahi jata) + verification card.
 *   4. Fee settle → wahi held QR release hota hai (dobara Swiggy call nahi).
 *   5. Boss "Wallet & Fee" panel: fee change (db), summary, per-user hisaab,
 *      user ko message.
 *   6. Customer ke paas Wallet aur Admin buttons hain.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
delete process.env.SERVICE_FEE_PAISE;

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

function makeDb() {
  return { config: { bossIds: ['9990001'], wallets: {}, topupRequests: {}, accounts: {} }, orders: {} };
}
const U = '7007001';

console.log('\n1) Fee boss ke panel se aati hai (db override)');
let db = makeDb();
check('default ₹15', w.serviceFeePaiseFor(db) === 1500, String(w.serviceFeePaiseFor(db)));
check('boss ₹20 set kare', w.setServiceFeePaise(db, 2000, { actor: 'boss:1' }).ok === true);
check('ab fee ₹20', w.serviceFeePaiseFor(db) === 2000, String(w.serviceFeePaiseFor(db)));
check('₹0 = free', w.setServiceFeePaise(db, 0).ok === true && w.serviceFeePaiseFor(db) === 0);
check('negative reject', w.setServiceFeePaise(db, -5).ok === false);
check('₹1000 se zyada reject', w.setServiceFeePaise(db, 200000).ok === false);
w.setServiceFeePaise(db, 1500);

console.log('\n2) QR HOLD — customer ko tab tak kuch nahi');
w.ensureWallet(db, U, { name: 'Ammi' });
const order = { id: 'o_hold', userId: U, status: 'PAYMENT_PENDING', finalPayable: 249, billApprovedByUser: true };
const hold = w.holdOrderQr(order, { upiUri: 'upi://pay?pa=upiswiggy@icici&am=249&cu=INR' });
check('QR hold hua', hold.ok && hold.code === 'HELD', hold.code);
check('order par qrHeld true', order.qrHeld === true && Boolean(order.qrHeldAt));
check('QR ka data order me safe hai', order.qrHeldUri.includes('upiswiggy@icici'));
check('cardStage QR_HELD', order.cardStage === 'QR_HELD', order.cardStage);
check('isOrderQrHeld true', w.isOrderQrHeld(order) === true);
check('customer ko abhi QR nahi mila', !order.paymentSentToUser && !order.customerPaymentMessageId);

const noData = w.holdOrderQr({ id: 'x' }, {});
check('payment data na ho to hold nahi', noData.ok === false && noData.code === 'NO_PAYMENT_DATA', noData.code);
const fbHold = w.holdOrderQr({ id: 'y' }, { fallbackReady: true });
check('fallback UPI par bhi hold', fbHold.ok === true);

console.log('\n3) Fee baaki → QR held, awaiting list me');
db.orders[order.id] = order;
const awaiting = w.findOrderAwaitingFee(db, U, { feePaise: 1500 });
check('held order awaiting me mila', awaiting?.order?.id === order.id);
check('balance 0 → canProceed false', awaiting.canProceed === false);
check('awaiting.qrHeld true', awaiting.qrHeld === true);

console.log('\n4) Fee settle → wahi QR release');
w.creditWallet(db, U, 1500, { reason: 'UTR approve', actor: 'boss' });
const charge = w.chargeServiceFee(db, order, U, { feePaise: 1500 });
check('fee kati', charge.ok && charge.code === 'CHARGED', charge.code);
const rel = w.releaseOrderQr(order, {});
check('QR release hua', rel.ok && rel.code === 'RELEASED', rel.code);
check('release par wahi purana URI', rel.upiUri.includes('upiswiggy@icici'));
check('qrHeld false, qrReleasedAt set', order.qrHeld === false && Boolean(order.qrReleasedAt));
check('dobara release → NOT_HELD', w.releaseOrderQr(order, {}).code === 'NOT_HELD');
check('charged order ab awaiting me nahi', w.findOrderAwaitingFee(db, U, { feePaise: 1500 }) === null);

console.log('\n5) QR fail card — koi fee nahi, sirf try again');
const failCard = w.formatQrFailedCard({ orderId: 'o1', reason: 'swiggy timeout' });
// v81 (boss 30-10-2026): fail par "kuch galat ho gaya — shuru se dobara try".
check('fail card me restart ka message hai', /shuru se dobara/i.test(failCard) && /kuch galat ho gaya/i.test(failCard));
check('fail card me fee/balance ka zikr nahi', !/fee|balance|₹15/i.test(failCard));
check('fail card me admin option', /Admin se baat/i.test(failCard));
const verifyCard = w.formatOrderVerificationCard({ orderId: 'o1', restaurant: 'Pizza', feePaise: 1500, upiId: 'boss@upi' });
check('verification card refundable bolta hai', /refundable|cancel/i.test(verifyCard));
check('verification card me UPI', verifyCard.includes('boss@upi'));
check('verification card "wallet" word nahi', !/wallet/i.test(verifyCard));

console.log('\n6) Boss fee panel — sab kuch ek jagah');
db = makeDb();
w.setServiceFeePaise(db, 1500);
w.ensureWallet(db, 'u1', { name: 'Ammi' });
w.ensureWallet(db, 'u2', { name: 'Abbu' });
w.creditWallet(db, 'u1', 4500, { reason: 'topup' });
const paidOrder = { id: 'p1', userId: 'u1', feeChargedPaise: 1500, feeChargedAt: new Date().toISOString(), cardStage: 'QR_GENERATED' };
const refundedOrder = { id: 'p2', userId: 'u2', feeChargedPaise: 1500, feeRefundedPaise: 1500, cardStage: 'CANCELLED', status: 'CANCELLED' };
const heldOrder = { id: 'p3', userId: 'u2', cardStage: 'QR_HELD', qrHeld: true, qrHeldUri: 'upi://x' };
db.orders = { p1: paidOrder, p2: refundedOrder, p3: heldOrder };
const summary = w.feeControlSummary(db);
check('panel: fee ₹15', summary.feePaise === 1500);
check('panel: users 2', summary.users === 2, String(summary.users));
check('panel: gross ₹30 (2 orders)', summary.grossFeePaise === 3000, String(summary.grossFeePaise));
check('panel: refund ₹15', summary.refundedPaise === 1500, String(summary.refundedPaise));
check('panel: net ₹15 (ek refund ke baad)', summary.netFeePaise === 1500, String(summary.netFeePaise));
check('panel: awaiting fee order 1', summary.awaitingFee === 1, String(summary.awaitingFee));
const panelText = w.formatFeeControlPanel({ summary });
check('panel text me fee', /₹15/.test(panelText));
check('panel text me users', /Users: <b>2<\/b>/.test(panelText), panelText.split('\n').find((l) => l.includes('Users')));
check('panel text me collected', /collected/i.test(panelText));

const u1 = w.userFeeSummary(db, 'u1');
check('user card: 1 fee order', u1.feeOrders === 1 && u1.chargedPaise === 1500);
const u2 = w.userFeeSummary(db, 'u2');
check('user card: refund dikhta hai', u2.refundedPaise === 1500 && u2.netPaise === 0);
check('user card: awaiting 1', u2.awaiting === 1, String(u2.awaiting));

console.log('\n7) Wiring — silent QR, hold/release, admin option, boss panel');
check('wallet gate runs in chat worker before placement', /reserveChatOrderFee/.test(fs.readFileSync('./forwarded-order-flow.js', 'utf8')) && /assertChatOrderFeeStillReserved/.test(fs.readFileSync('./swiggy-cart.js', 'utf8')));
check('QR fail par QR_GENERATION_FAILED', /QR_GENERATION_FAILED/.test(indexSrc));
check('QR fail card bhejta hai', /sendQrGenerationFailedCard/.test(indexSrc));
check('cardStage QR_RETRY', /QR_RETRY/.test(indexSrc));
check('QR hold hota hai', /holdOrderQr\(/.test(indexSrc));
check('fee ke baad release', /releaseOrderQr\(/.test(indexSrc));
check('verification card customer ko', /sendOrderVerificationCard/.test(indexSrc));
check('retry button handler', /user_retry_qr_/.test(indexSrc));
check('admin se baat handler', /support_contact_admin/.test(indexSrc));
check('admin message text state', /waiting_support_message/.test(indexSrc));
check('boss fee panel', /boss_fee_panel/.test(indexSrc) && /boss_fee_set_/.test(indexSrc));
check('boss fee custom', /waiting_boss_fee_amount/.test(indexSrc));
check('boss user ko message', /boss_wallet_msg_/.test(indexSrc) && /waiting_boss_user_message/.test(indexSrc));
check('boss fee history', /boss_wallet_feehistory_/.test(indexSrc));
check('simple chat VERIFY stage', /QR_HELD/.test(chatSrc) && /AWAITING_FEE/.test(chatSrc));
check('simple chat retry stage', /QR_RETRY/.test(chatSrc));
check('simple chat me wallet button hai', /wallet_home/.test(chatSrc));
check('simple chat me admin button', /support_contact_admin/.test(chatSrc));
check('boss panel me fee button', /boss_fee_panel/.test(bossPanelSrc));
check('user-wallet me hold/release', /export function holdOrderQr/.test(fs.readFileSync('./user-wallet.js', 'utf8')) && /export function releaseOrderQr/.test(fs.readFileSync('./user-wallet.js', 'utf8')));

function restoreState() {
  try {
    if (dbSnapshot === null) fs.rmSync(DB_PATH, { force: true });
    else fs.writeFileSync(DB_PATH, dbSnapshot);
    if (mirrorSnapshot === null) fs.rmSync(MIRROR, { force: true });
    else fs.writeFileSync(MIRROR, mirrorSnapshot);
  } catch { /* ignore */ }
}
restoreState();

console.log(`\n${failed === 0 ? '🏆' : '❌'} v73: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
