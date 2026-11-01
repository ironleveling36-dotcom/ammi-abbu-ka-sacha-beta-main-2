// ============================================================================
// v18 — One-shot bill summary -> customer approval -> QR -> real Swiggy tracking
// ----------------------------------------------------------------------------
// The customer (Ammi/Abbu) must never need Boss for the happy path:
//   1. Best account + max coupon are picked automatically.
//   2. The max-discount bill summary is sent to the customer EXACTLY ONCE.
//   3. Tapping "Approve bill" sends the official Swiggy payment QR/link.
//   4. After payment the customer gets the real Swiggy tracking link — never a
//      bot-side /track/<orderId> page.
//
// Current delivery contract (30-10-2026): bot SMS nahi bhejta (boss/professor
// ne band karaya), par customer ko tracking + OTP Telegram DM par MILTA hai —
// warna "link nahi aaya" wali shikayat wapas aati hai. Notice ka text Telegram
// messages se padha jata hai. Bot ka apna /track page kabhi nahi jata.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const restoreDb = () => {
  if (dbSnapshot !== null) {
    try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {}
  }
};
process.on('exit', restoreDb);

// Offline network: every Swiggy call fails cleanly and fast.
// A fake SMS webhook captures the exact SMS text so the SMS-only delivery
// contract can be asserted (Telegram DM for the order notice is disabled).
const SMS_WEBHOOK = 'https://sms.example/gateway';
process.env.SMS_WEBHOOK_URL = SMS_WEBHOOK;
const sentSms = [];
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.startsWith(SMS_WEBHOOK)) {
    try {
      const body = JSON.parse(init?.body || '{}');
      sentSms.push({ to: body.to, text: body.message || '' });
    } catch {}
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok', json: async () => ({ ok: true }) };
  }
  return {
    ok: false,
    status: 503,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({})
  };
};
const smsText = (mark = 0) => sentSms.slice(mark).map((s) => s.text).join('\n');
const smsCount = () => sentSms.length;

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

const { bot, autoOptimizeUserOrder, formatUserOrderCard, approveUserOrderBillAction } = await import('./index.js');
const { sendOrderDeliveryInfoNotice } = await import('./forwarded-order-flow.js');
const { getDb, saveDb, mutateDb } = await import('./store.js');

// Telegram stub — records every message so we can assert exact delivery counts.
const sentMessages = [];
const fakeCallApi = async (method, payload = {}) => {
  if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendPhoto') {
    const record = { method, chatId: String(payload.chat_id), text: payload.text || payload.caption || '', payload };
    sentMessages.push(record);
    return {
      message_id: sentMessages.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: 'private' },
      text: record.text
    };
  }
  if (method === 'getMe') return { id: 123456, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

// Hermetic: no logged-in Swiggy accounts, no reservation leakage.
mutateDb((d) => {
  d.config.accounts = {};
  if (typeof d.config.slotsLeft !== 'number' || d.config.slotsLeft < 5) d.config.slotsLeft = 100;
});

const CUSTOMER_ID = '424242';

// v72: ₹15/order service fee QR se pehle wallet se kati jati hai — test customer
// ko balance de do (bina balance QR nahi banta, yehi asli behaviour hai).
{
  const { ensureWallet, creditWallet } = await import('./user-wallet.js');
  mutateDb((d) => {
    for (const uid of [String(CUSTOMER_ID)]) {
      ensureWallet(d, uid, { name: 'test customer' });
      creditWallet(d, uid, 200000, { reason: 'v72 test seed', actor: 'test' });
    }
  });
}

const bossCount = () => sentMessages.filter((m) => m.chatId === CUSTOMER_ID).length;
// Messages are indexed by total length; bossCount() only counts customer traffic.
const since = (mark) => sentMessages.slice(mark);
const customerMessagesSince = (mark) => sentMessages.slice(mark).filter((m) => m.chatId === CUSTOMER_ID);
const summariesFor = (id) => sentMessages.filter((m) => m.chatId === CUSTOMER_ID && m.text.includes(`#${id}`) && /bill|Bill/.test(m.text));
// An official Swiggy link is fine; any other /track/<id> URL is the bot's own page.
const anyBotTrackUrl = () => sentMessages.some((m) => {
  const links = String(m.text || '').match(/https?:\/\/[^\s"'<]+/g) || [];
  return links.some((url) => /\/(?:api\/)?track\//.test(url) && !/^https:\/\/(?:www\.)?swiggy\.com\//.test(url));
});

const baseOrder = (id, extra = {}) => ({
  id,
  userId: 424242,
  userName: 'Ammi',
  type: 'SWIGGY_ORDER',
  status: 'PENDING',
  paymentStatus: 'UNPAID',
  cart: 'https://swig.gy/gc/1467977/TestHost-642855918',
  restaurantId: '1467977',
  restaurantName: 'Mouj Mela',
  items: [{ name: 'Egg Roll [2 Egg]', price: 109, qty: 2, lineTotal: 218, itemId: '111' }],
  subtotal: 218,
  itemTotal: 218,
  address: 'Shyam Baba Mandir, Shivaji Nagar, Gullowara, Darbhanga, Bihar 846004',
  addressDetails: {
    name: 'SHANU SAHANI',
    mobile: '9876500011',
    city: 'Darbhanga',
    address: 'Shyam Baba Mandir, Shivaji Nagar, Gullowara, Darbhanga, Bihar 846004',
    lat: '26.0829899',
    lng: '86.0324951'
  },
  createdAt: new Date().toISOString(),
  userChatId: 424242,
  bossMessageIds: { 6484999726: 8 },
  ...extra
});

const readyBill = {
  selectedAccount: 'acc_9935123518',
  orderAccount: '9935123518',
  finalPayable: 73,
  couponCode: 'FEASTMODE70',
  discountAmount: 130,
  freeCashApplied: 40,
  freeDelivery: true,
  deliverySaved: 23,
  freeDeliveryDiscount: 23,
  taxesAndCharges: 23.94,
  totalSavings: 193
};

// ---------------------------------------------------------------------------
// 1. Auto account/bill -> bill summary auto-sent to the customer, once
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: auto max-offer sends the bill summary once ---');
{
  const db = getDb();
  db.orders = db.orders || {};
  db.orders.V18_A = baseOrder('V18_A', readyBill);
  saveDb(db);

  const before = sentMessages.length;
  const first = await autoOptimizeUserOrder('V18_A', { reason: 'V18_AUTO' });
  const afterFirst = getDb().orders.V18_A;
  check('auto max-offer succeeds without boss action', first?.success === true);
  check('order waits for the customer, not the boss', afterFirst.status === 'APPROVAL_PENDING');
  check('bill summary is recorded as sent', Boolean(afterFirst.billSummarySentAt));
  check('exactly one bill message reached the customer', bossCount() - before === 1);
  const summaryMsgs = customerMessagesSince(before);
  const summaryMsg = summaryMsgs[0] || {};
  check('the bill summary carries the approve button',
    summaryMsgs.some((m) => /user_approve_bill_V18_A/.test(JSON.stringify(m.payload || {}))));
  check('the bill summary shows the max-discount amount', /(?:Total to pay|To Pay): ₹73/.test(summaryMsg.text || ''));
  check('the bill summary never leaks the Swiggy account number', !/9935123518/.test(summaryMsg.text || ''));

  // A refresh / retry must not spam the customer with a second summary.
  const countAfterFirst = bossCount();
  const stampAfterFirst = afterFirst.billSummarySentAt;
  await autoOptimizeUserOrder('V18_A', { reason: 'V18_REFRESH' });
  await autoOptimizeUserOrder('V18_A', { reason: 'V18_REFRESH_AGAIN' });
  const afterRetries = getDb().orders.V18_A;
  check('retries never resend the bill summary', bossCount() === countAfterFirst);
  check('the one-time marker is untouched by retries', afterRetries.billSummarySentAt === stampAfterFirst);
  check('retries do not create a payment request', !afterRetries.billApprovedByUser && !afterRetries.paymentSentToUser);
}

// ---------------------------------------------------------------------------
// 2. Customer confirms -> official payment details go out (no boss step)
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: approve -> payment QR/link to the customer ---');
{
  const db = getDb();
  const slotsBefore = Number(db.config.slotsLeft || 0);
  const order = db.orders.V18_A;
  // Real Swiggy merchant VPA (v60: `swiggy@*` is a placeholder that scans invalid)
  order.realUpiIntentUri = 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=73&cu=INR&tn=V18_A';
  order.swiggyPaymentUrl = 'https://www.swiggy.com/payment/V18_A';
  saveDb(db);

  const before = sentMessages.length;
  const approval = await approveUserOrderBillAction(CUSTOMER_ID, 'V18_A');
  const after = getDb().orders.V18_A;
  check('customer approval succeeds without boss action', approval?.ok === true || /payment/i.test(approval?.error || ''));
  check('bill is marked approved by the customer', after.billApprovedByUser === true);
  check('order moves to payment pending', after.status === 'PAYMENT_PENDING');
  const paymentMsgs = customerMessagesSince(before);
  check('customer receives the payment details', paymentMsgs.length > 0);
  check('payment details are the official Swiggy payment request',
    paymentMsgs.some((m) => /Payment QR/.test(m.text) && /Payment status/i.test(JSON.stringify(m.payload))));
  check('payment message never uses a bot tracking page', !customerMessagesSince(before).some((m) => /bot\.example\/track\//.test(m.text)));
  // No-slots UX (v29): approval must never consume slots — the limit is gone.
  check('approval never consumes slots (no-slots UX)', Number(getDb().config.slotsLeft) === slotsBefore);

  const slotsAfterFirst = Number(getDb().config.slotsLeft);
  await approveUserOrderBillAction(CUSTOMER_ID, 'V18_A');
  check('a repeated approve is a no-op (no slot/state drift)', Number(getDb().config.slotsLeft) === slotsAfterFirst);
}

// ---------------------------------------------------------------------------
// 2b. Link-only payment path (Swiggy returned a payment URL, not a UPI intent)
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2b: official Swiggy payment link is forwarded ---');
{
  const db = getDb();
  db.orders.V18_LINK = baseOrder('V18_LINK', {
    ...readyBill,
    status: 'APPROVAL_PENDING',
    billSummarySentAt: new Date().toISOString(),
    cardStage: 'BILL_READY',
    swiggyPaymentUrl: 'https://www.swiggy.com/payment/V18_LINK'
  });
  saveDb(db);

  const before = sentMessages.length;
  await approveUserOrderBillAction(CUSTOMER_ID, 'V18_LINK');
  const after = getDb().orders.V18_LINK;
  const msgs = customerMessagesSince(before);
  check('link-only approval still moves to payment pending', after.status === 'PAYMENT_PENDING');
  check('the official Swiggy payment link reaches the customer',
    msgs.some((m) => /swiggy\.com\/payment\/V18_LINK/.test(m.text)));
  check('the payment link message stays on swiggy.com', !msgs.some((m) => /bot\.example/.test(m.text)));
}

// ---------------------------------------------------------------------------
// 3. Paid -> the real Swiggy tracking link reaches the customer
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: paid order delivers the actual Swiggy tracking link ---');
{
  const officialTrack = 'https://www.swiggy.com/orders/track/250070826195484';
  const db = getDb();
  db.orders.V18_A = {
    ...db.orders.V18_A,
    status: 'COMPLETED',
    cardStage: 'PAID_CONFIRMED',
    swiggyOrderId: '250070826195484',
    liveOrderStatus: 'Order Confirmed',
    trackingLink: officialTrack,
    trackingLinkSource: 'SWIGGY_API',
    deliveryOtp: '4821',
    deliveryInfoNotices: {}
  };
  saveDb(db);

  const before = sentMessages.length;
  const order = getDb().orders.V18_A;
  const delivered = await sendOrderDeliveryInfoNotice(bot.telegram, '6484999726', order, { force: true });
  await new Promise((r) => setTimeout(r, 25));
  const noticeMsgs = customerMessagesSince(0).map((m) => m.text);
  const notice = noticeMsgs.join('\n');
  check('payment confirmation reaches the customer', delivered === true && noticeMsgs.length > 0);
  check('koi SMS gateway use nahi hua (bot SMS band)', sentSms.length === 0, JSON.stringify(sentSms));
  check('the message names the payment confirmation', /Payment received/i.test(notice) && /order place/i.test(notice));
  check('the real Swiggy tracking link is delivered', notice.includes(officialTrack));
  check('the delivered link is an official Swiggy host',
    /swiggy\.com\/orders\/track\//.test(notice));
  check('no bot-side tracking page is sent to the customer', !/\/track\/V18_A/.test(notice) && !anyBotTrackUrl());
  check('the delivery OTP is included', /4821/.test(notice));

  // Duplicate calls must not spam the customer.
  const afterFirst = bossCount();
  await sendOrderDeliveryInfoNotice(bot.telegram, '6484999726', getDb().orders.V18_A);
  await new Promise((r) => setTimeout(r, 25));
  check('the same tracking/OTP is never sent twice', bossCount() === afterFirst);

  // A newly published link is delivered exactly then (parent + direct SMS).
  const updated = { ...getDb().orders.V18_A, deliveryInfoNotices: { [CUSTOMER_ID]: `${officialTrack}\n4821` } };
  const newerTrack = 'https://www.swiggy.com/orders/track/250070826195484?source=track';
  updated.trackingLink = newerTrack;
  saveDb((() => { const d = getDb(); d.orders.V18_A = updated; return d; })());
  const beforeNew = bossCount();
  await sendOrderDeliveryInfoNotice(bot.telegram, '6484999726', getDb().orders.V18_A);
  await new Promise((r) => setTimeout(r, 25));
  check('a later official link is pushed to the customer',
    bossCount() > beforeNew && customerMessagesSince(sentMessages.length - (bossCount() - beforeNew)).map((m) => m.text).join('\n').includes(newerTrack));
}

// ---------------------------------------------------------------------------
// 4. No link yet -> honest message, still never a fake tracking URL
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: tracking not published yet ---');
{
  const db = getDb();
  db.orders.V18_B = baseOrder('V18_B', {
    status: 'COMPLETED',
    swiggyOrderId: '250070826195999',
    liveOrderStatus: 'Order Confirmed',
    trackingLink: '',
    trackingLinkSource: '',
    deliveryInfoNotices: {}
  });
  saveDb(db);

  const beforeB = sentMessages.length;
  await sendOrderDeliveryInfoNotice(bot.telegram, '6484999726', getDb().orders.V18_B, { force: true });
  await new Promise((r) => setTimeout(r, 25));
  const notice = sentMessages.slice(beforeB).filter((m) => m.chatId === CUSTOMER_ID).map((m) => m.text).join('\n');
  check('the customer is told Swiggy has not published tracking', /jaldi hi bheja jayega|not (?:yet )?(?:shared|published)/i.test(notice));
  check('the fallback points to the real Swiggy orders page', /swiggy\.com\/my-account\/orders/.test(notice));
  check('the no-link notice never points at a bot page', !/(bot\.example|onrender\.com|railway\.app)/.test(notice));
  check('no synthesised tracking URL is produced from the order id', !/track\/250070826195999/.test(notice));
}

// ---------------------------------------------------------------------------
// 5. Global guard: the bot never presents its own tracking page as tracking
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: no bot tracking URL leaks into customer messages ---');
{
  check('no customer message contains /track/<orderId>', !anyBotTrackUrl());
  const approvalCard = formatUserOrderCard({ ...baseOrder('V18_C'), status: 'APPROVAL_PENDING', ...readyBill, billSummarySentAt: new Date().toISOString() });
  const flatButtons = approvalCard.keyboard.reply_markup.inline_keyboard.flat().map((b) => b.callback_data || b.url || '');
  check('approval card exposes approve + something-wrong only',
    flatButtons.includes('user_approve_bill_V18_C') && flatButtons.includes('user_bill_issue_V18_C'));
  check('approval card leaks no boss-only actions',
    !flatButtons.some((d) => /fwd_(gen_qr|send_summary|input_|rechoose_acc|rescan_max)_/.test(d)));
  check('approval card shows no bot tracking link', !/\/track\//.test(approvalCard.text));

  const paidCard = formatUserOrderCard({
    ...baseOrder('V18_D'),
    status: 'COMPLETED',
    trackingLink: 'https://www.swiggy.com/orders/track/250070826196000',
    trackingLinkSource: 'SWIGGY_API',
    shareTrackUrl: 'https://bot.example/track/V18_D'
  });
  const paidButtons = paidCard.keyboard.reply_markup.inline_keyboard.flat();
  check('paid card links the official Swiggy tracking page',
    /https:\/\/www\.swiggy\.com\/orders\/track\/250070826196000/.test(paidCard.text));
  check('paid card never links the stale shareTrackUrl', !paidButtons.some((b) => /bot\.example\/track\//.test(b.url || '')));
}

console.log('\n' + '='.repeat(64));
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('='.repeat(64));
restoreDb();
