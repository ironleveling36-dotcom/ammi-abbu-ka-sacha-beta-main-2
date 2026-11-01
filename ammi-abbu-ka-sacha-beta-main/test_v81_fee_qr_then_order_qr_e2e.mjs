// test_v81_fee_qr_then_order_qr_e2e.mjs
// Offline Telegram handlers: new orders require wallet funds before placement;
// preflight failure refunds, while pre-existing held QR data stays recoverable.
// Phone-injection claims remain absent. No real Swiggy order is sent.

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';

import fs from 'node:fs';

delete process.env.PAY_WEBHOOK_SECRET;
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.PAY_AUTO_VERIFY;

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '', json: async () => ({}) });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const w = await import('./user-wallet.js');
const { bot } = await import('./index.js');
const { setChannelGateMock } = await import('./channel-gate.js');
setChannelGateMock(true);
const { mutateDb, getDb } = await import('./store.js');
const indexSrc = fs.readFileSync('./index.js', 'utf8');

const log = [];
const fakeCallApi = async (method, payload = {}) => {
  log.push({ method, payload });
  if (['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto'].includes(method)) {
    return { message_id: payload.message_id || log.length, chat: { id: payload.chat_id }, text: payload.text || payload.caption || '' };
  }
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const U = 9_981_001;
const BOSS = 6484999726;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const tap = async (data) => {
  log.length = 0;
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: String(uid), from: { id: U, is_bot: false, first_name: 'Ammi' }, chat_instance: '1', data, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: U, type: 'private' }, text: 'x' } } });
  await sleep(1200);
  return log.filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto'].includes(c.method));
};
const textOf = (calls) => calls.map((c) => String(c.payload.text || c.payload.caption || '')).join('\n');
const photosOf = (calls) => calls.filter((c) => c.method === 'sendPhoto');

const mkOrder = (id, extra = {}) => ({
  id, userId: U, userChatId: U, userName: 'Ammi', simpleChat: true,
  status: 'APPROVAL_PENDING', cardStage: 'BILL_READY', restaurantName: 'Umbashiya',
  finalPayable: 249, subtotal: 300, items: [{ name: 'x', qty: 1, price: 249 }],
  address: 'B-402 Eldeco Greens', createdAt: new Date().toISOString(),
  billApprovedByUser: false, ...extra
});

console.log('\n=== 1. QR generate FAIL → "kuch galat ho gaya, shuru se dobara" ===');
{
  mutateDb((d) => {
    d.config.bossIds = [BOSS];
    d.config.bossUpiId = 'ammi.family@okaxis';
    d.config.accounts = {};
    w.creditWallet(d, U, 1500, { reason: 'offline test' });
    d.orders = { V81FAIL: mkOrder('V81FAIL') }; // Swiggy ka koi payment data nahi
    d.drafts = {};
  });
  const calls = await tap('simple_confirm_order_V81FAIL');
  const text = textOf(calls);
  const order = getDb().orders.V81FAIL;
  check('customer ko "KUCH GALAT HO GAYA" mila', /KUCH GALAT HO GAYA/i.test(text), text.slice(0, 120));
  check('"shuru se dobara" kaha gaya', /shuru se dobara/i.test(text));
  check('koi fee / ₹15 ka zikr nahi', !/₹15/.test(text) && !/verification/i.test(text));
  check('restart button mila', /simple_restart_order_V81FAIL/.test(JSON.stringify(calls.map((c) => c.payload))));
  check('koi QR photo customer ko nahi gayi', photosOf(calls).every((c) => String(c.payload.chat_id) !== String(U)));
  check('order QR_RETRY me hai', order.cardStage === 'QR_RETRY', String(order.cardStage));
  check('preflight fail par fee wapas', Number(order.feeChargedPaise || 0) === Number(order.feeRefundedPaise || 0) && w.walletBalancePaise(getDb(), U) === 1500);
}

console.log('\n=== 2. Restart button = shuru se (draft saaf, cancel, fresh card) ===');
{
  const calls = await tap('simple_restart_order_V81FAIL');
  const text = textOf(calls);
  check('purana order CANCEL hua', getDb().orders.V81FAIL.status === 'CANCELLED', String(getDb().orders.V81FAIL.status));
  check('cancel ki wajah QR_GENERATION_FAILED_RESTART', getDb().orders.V81FAIL.cancelledReason === 'QR_GENERATION_FAILED_RESTART');
  check('fresh screen aayi (naya order)', /Cart \+ Address|Swiggy order/i.test(text), text.slice(0, 120));
  check('draft saaf hua', !(getDb().drafts?.[String(U)]?.cart), JSON.stringify(getDb().drafts?.[String(U)] || {}).slice(0, 80));
}

console.log('\n=== 3. Low balance blocks new QR before placement ===');
{
  mutateDb((d) => {
    d.config.bossIds = [BOSS];
    d.config.bossUpiId = 'ammi.family@okaxis';
    w.debitWallet(d, U, w.walletBalancePaise(d, U), { reason: 'offline low-balance test' });
    d.orders = { V81OK: mkOrder('V81OK') };
    d.drafts = {};
  });
  const calls = await tap('simple_confirm_order_V81OK');
  const text = textOf(calls);
  const order = getDb().orders.V81OK;
  check('low balance bataya', /wallet|balance/i.test(text), text.slice(0, 150));
  check('wallet button mila', /wallet_home/.test(JSON.stringify(calls.map(c => c.payload))));
  check('order QR nahi bheja', photosOf(calls).every(c => String(c.payload.chat_id) !== String(U)));
  check('order awaiting wallet', order.cardStage === 'AWAITING_WALLET', order.cardStage);
  check('fee debit nahi hui', !Number(order.feeChargedPaise || 0));

  // Existing pre-change held QRs remain recoverable after the new policy.
  mutateDb((d) => {
    const legacy = d.orders.V81OK;
    legacy.pendingSwiggyUpiUri = 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=249&cu=INR&tr=V81TXN';
    w.holdOrderQr(legacy, { upiUri: legacy.pendingSwiggyUpiUri });
    legacy.cardStage = 'AWAITING_FEE';
    legacy.feeDuePaise = 1500;
  });
}

console.log('\n=== 4. Fee verify hone par ORDER QR release + send ===');
{
  // Webhook jaisa: fee charged (auto-verify) → release path.
  const before = getDb().orders.V81OK;
  check('release se pehle QR held', before.qrHeld === true);
  const calls = await tap('wallet_fee_paid_V81OK');
  const text = textOf(calls);
  const order = getDb().orders.V81OK;
  check('auto-verify OFF par QR turant release (customer atka nahi)', order.qrHeld === false, String(order.qrHeld));
  check('customer ko asli ORDER QR mil gaya', /Pay ₹249/.test(text), text.slice(0, 140));
  check('QR Swiggy ka hi hai', order.paymentQrKind === 'SWIGGY_PERSONALISED', String(order.paymentQrKind));
  check('fee "baad me" me chali gayi', Number(order.feeDeferredPaise) === 1500, String(order.feeDeferredPaise));
}

console.log('\n=== 5. Held QR ko webhook/auto-verify release karta hai (source) ===');
{
  check('webhook fee settle + release', /releaseHeldQrToCustomer\(orderId, \{ reason: 'webhook auto-verify' \}\)/.test(indexSrc));
  check('release helper maujood', /async function releaseHeldQrToCustomer\(/.test(indexSrc));
  check('fee QR helper maujood', /async function sendFeeQrForHeldOrder\(/.test(indexSrc));
  check('approve flow defer-auto-release nahi karta (naya plan)', !/recordDeferredFee\(liveOrder, feeDue, \{ reason: 'auto-verify set nahi — fee baad me' \}\)/.test(indexSrc));
  check('new wallet gate is before placement', /reserveChatOrderFee/.test(fs.readFileSync('./forwarded-order-flow.js', 'utf8')));
  check('auto-verify off par 3 min safety release', /scheduleDeferredQrRelease\(/.test(indexSrc) && /3 \* 60 \* 1000/.test(indexSrc));
}

console.log('\n=== 6. Injection hata diya ===');
{
  check('sendDeviceLoginShortNotice hata diya', !/sendDeviceLoginShortNotice/.test(indexSrc));
  check('lock par handover injection nahi', /const handover = null;/.test(indexSrc));
  const chatSrc = fs.readFileSync('./simple-chat.js', 'utf8');
  check('home card par phone-login injection button nahi', !/simple_phone_login/.test(chatSrc) && !/simple_phone_login/.test(indexSrc));
  const home = (await import('./simple-chat.js')).buildSimpleHomeScreen({
    cart: 'https://www.swiggy.com/cart/abc',
    address: 'https://www.swiggy.com/ofo/address/x/y',
    cartDetails: { restaurantName: 'Pizza Hut', subtotal: 249 },
    addressDetails: { address: '12, Gomti Nagar, Lucknow' }
  });
  check('home card me phone-login ka jhootha dawa nahi', !/phone me login/i.test(home.text), home.text.slice(0, 100));
}

console.log(`\n${fail === 0 ? '🏆 NAYA QR PLAN LOCKED — fee pehle, phir order QR' : '❌ FAIL'} — ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exitCode = 1;
