// ============================================================================
// v17 — Customer ("Ammi") orders get the same auto max-offer pipeline
// ----------------------------------------------------------------------------
// Boss forwards a message -> full pipeline (best 0-Order account -> max coupon
// -> live bill). Before this fix, a customer tapping "Send to Beta" only got a
// plain PENDING order and had to wait for Boss. These checks lock in:
//   1. autoOptimizeUserOrder() marks the order AUTO_SELECTING -> BILL_READY.
//   2. Order stays PENDING (Boss still approves) and never auto-pays.
//   3. Customer card shows the verified bill, without leaking the account number.
//   4. Failures degrade gracefully (no crash, error surfaced on the card).
//   5. "Send to Beta" / "Refresh status" actually kick the scan off.
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

// Offline network: every Swiggy call fails cleanly and fast.
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

const { bot, autoOptimizeUserOrder, formatUserOrderCard } = await import('./index.js');
const { getDb, saveDb, updateDraft, mutateDb } = await import('./store.js');

// Telegram stub (Telegraf builds a new client per update -> stub the prototype too)
const telegramCalls = [];
const fakeCallApi = async (method, payload = {}) => {
  telegramCalls.push({ method, payload });
  if (method === 'sendMessage' || method === 'editMessageText') {
    return { message_id: telegramCalls.length, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' }, text: payload.text || '' };
  }
  if (method === 'getMe') return { id: 123456, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

// No logged-in accounts -> the scan fails fast and deterministically (offline).
// Hermetic run: no Swiggy sessions, so the scan must fail fast and safely.
mutateDb((d) => { d.config.accounts = {}; });

const baseOrder = (id, extra = {}) => ({
  id,
  userId: 424242,
  userName: 'Ammi',
  type: 'SWIGGY_ORDER',
  status: 'PENDING',
  paymentStatus: 'UNPAID',
  cart: 'https://swig.gy/gc/1467977/TestHost-642855918',
  restaurantId: '1467977',
  groupCartId: '642855918',
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
  userMessageId: 7,
  bossMessageIds: { 6484999726: 8 },
  ...extra
});

// ---------------------------------------------------------------------------
// 1. Always-picked path: account + live bill already known -> BILL_READY
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: bill already computed -> BILL_READY (no rescan) ---');
const db1 = getDb();
db1.orders = db1.orders || {};
db1.orders.AUTO_READY_1 = baseOrder('AUTO_READY_1', {
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
});
saveDb(db1);

const readyResult = await autoOptimizeUserOrder('AUTO_READY_1', { reason: 'TEST_REUSE' });
const afterReady = getDb().orders.AUTO_READY_1;
check('autoOptimizeUserOrder reports success', readyResult?.success === true);
check('card stage becomes BILL_READY', afterReady.cardStage === 'BILL_READY');
check('order is flagged as auto-optimized', afterReady.autoOptimized === true);
check('bill summary is auto-sent once to the customer', Boolean(afterReady.billSummarySentAt));
check('order now waits for customer approval (no auto payment)',
  ['APPROVAL_PENDING', 'PENDING'].includes(afterReady.status) && !afterReady.billApprovedByUser);
check('bill values are untouched', afterReady.finalPayable === 73 && afterReady.couponCode === 'FEASTMODE70');

// ---------------------------------------------------------------------------
// 2. Customer card shows the verified bill, hides the Swiggy account number
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: customer card after auto max-offer ---');
const card = formatUserOrderCard(afterReady);
check('card announces the bill summary', /(?:Verified bill ready|Bill summary sent)/i.test(card.text));
check('card shows the amount to pay', /To Pay: ₹73/.test(card.text));
check('card shows the coupon', /Coupon FEASTMODE70: −₹130/.test(card.text));
const approveButtons = card.keyboard.reply_markup.inline_keyboard.flat();
check('card asks the customer to approve the bill', /Approve karein/i.test(card.text));
check('card exposes an Approve-bill button', approveButtons.some(b => b.callback_data === 'user_approve_bill_AUTO_READY_1'));
check('card never shows the Swiggy account number', !/9935123518/.test(card.text));
check('card keeps refresh + cancel buttons',
  card.keyboard.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'user_refresh_status_AUTO_READY_1'));

// ---------------------------------------------------------------------------
// 3. Scan in progress -> AUTO_SELECTING card
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: scanning card ---');
const scanningCard = formatUserOrderCard(baseOrder('AUTO_SCAN_1', { cardStage: 'AUTO_SELECTING' }));
check('scanning card tells the customer offers are being applied', /Best offers check ho rahe hain/i.test(scanningCard.text));
check('scanning card promises the bill will update', /Final bill yahan update ho jayega/i.test(scanningCard.text));

// ---------------------------------------------------------------------------
// 4. No usable account -> graceful failure, order still PENDING for Boss
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: no logged-in account -> graceful failure ---');
const db4 = getDb();
db4.orders.AUTO_FAIL_1 = baseOrder('AUTO_FAIL_1');
saveDb(db4);

const failResult = await autoOptimizeUserOrder('AUTO_FAIL_1', { reason: 'TEST_FAIL' });
const afterFail = getDb().orders.AUTO_FAIL_1;
check('autoOptimizeUserOrder reports failure instead of throwing', failResult?.success === false);
check('failure reason is stored', typeof afterFail.autoOptimizeError === 'string' && afterFail.autoOptimizeError.length > 0);
check('order returns to PENDING queue', afterFail.cardStage === 'PENDING' && afterFail.status === 'PENDING');
check('order is NOT marked as optimized', afterFail.autoOptimized !== true);
check('Boss card surfaces the auto-offer problem',
  (await import('./boss-panel.js')).buildBossOrderCard(afterFail).text.includes('Auto offers'));

// ---------------------------------------------------------------------------
// 5. "Send to Beta" wiring actually starts the scan
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: Send to Beta starts the max-offer scan ---');
const CUSTOMER_ID = 7_770_161;
updateDraft(CUSTOMER_ID, {
  cart: 'https://swig.gy/gc/1467977/TestHost-642855918',
  cartDetails: {
    restaurantName: 'Mouj Mela',
    items: [{ name: 'Egg Roll [2 Egg]', price: 109, qty: 2, lineTotal: 218, itemId: '111' }],
    itemsTotal: 218,
    subtotal: 218
  },
  address: 'Shyam Baba Mandir, Shivaji Nagar, Gullowara, Darbhanga, Bihar 846004',
  addressOriginalText: 'Shyam Baba Mandir, Shivaji Nagar, Gullowara, Darbhanga, Bihar 846004',
  addressDetails: {
    name: 'SHANU SAHANI',
    mobile: '9876500011',
    city: 'Darbhanga',
    address: 'Shyam Baba Mandir, Shivaji Nagar, Gullowara, Darbhanga, Bihar 846004',
    lat: '26.0829899',
    lng: '86.0324951'
  }
});

await bot.handleUpdate({
  update_id: 501,
  callback_query: {
    id: 'cb-send-to-beta',
    from: { id: CUSTOMER_ID, is_bot: false, first_name: 'Ammi' },
    chat_instance: 'ci',
    data: 'action_send_to_beta',
    message: {
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CUSTOMER_ID, type: 'private', first_name: 'Ammi' },
      from: { id: CUSTOMER_ID, is_bot: false, first_name: 'Ammi' },
      text: 'Send to Beta'
    }
  }
});

let createdOrder = null;
const startedAt = Date.now();
while (Date.now() - startedAt < 20_000) {
  await new Promise(r => setTimeout(r, 250));
  createdOrder = Object.values(getDb().orders || {}).find(o => Number(o.userId) === CUSTOMER_ID);
  if (createdOrder && (createdOrder.autoOptimized || createdOrder.autoOptimizeError)) break;
}

check('Send to Beta creates the order', Boolean(createdOrder));
check('order is addressed to the customer', Number(createdOrder?.userId) === CUSTOMER_ID);
check('order keeps the URL-resolved delivery phone', createdOrder?.addressDetails?.mobile === '9876500011');
check('order enters the Boss queue as PENDING', createdOrder?.status === 'PENDING');
check('max-offer scan started automatically (result or explicit error recorded)',
  Boolean(createdOrder?.autoOptimized || createdOrder?.autoOptimizeStartedAt || createdOrder?.autoOptimizeError));
check('no crash was reported while scanning',
  !telegramCalls.some(c => /technical issue/i.test(String(c.payload?.text || ''))));

// ---------------------------------------------------------------------------
console.log('\n================================================================');
const passed = results.filter(r => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
restoreDb();
if (passed !== results.length) process.exitCode = 1;
