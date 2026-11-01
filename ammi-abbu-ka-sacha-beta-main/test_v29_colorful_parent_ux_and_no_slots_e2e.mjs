// ============================================================================
// V29 E2E — Colorful / Orange Buttons for Ammi & Abbu, Slot System Removed,
//           and Direct Minimal-Word User Input
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) {
    try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {}
  }
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
  const ok = Boolean(condition);
  results.push({ label, ok });
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) process.exitCode = 1;
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return Boolean(predicate());
}

const {
  bot,
  getUserScreen,
  formatUserOrderCard,
  approveUserOrderBillAction,
  userChatCards
} = await import('./index.js');
const { sendBillSummaryToCustomerOnce } = await import('./forwarded-order-flow.js');
const { getDb, saveDb, getDraft, clearDraft, mutateDb } = await import('./store.js');
const { creditWallet } = await import('./user-wallet.js');

const VALID_TELEGRAM_STYLES = new Set(['primary', 'success', 'danger']);
const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  if (method === 'sendMessage' || method === 'editMessageText') {
    return {
      message_id: payload.message_id || apiLog.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: 'private' },
      text: payload.text || ''
    };
  }
  if (method === 'getMe') {
    return { id: 123456, is_bot: true, first_name: 'Family Food Bot', username: 'family_food_bot' };
  }
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const calls = (method) => apiLog.filter((c) => c.method === method);
const resetLog = () => { apiLog.length = 0; };

const AMMI_ID = 7070701;
const BOSS_ID = Number(process.env.BOSS_ID || getDb().config?.bossIds?.[0] || 6484999726);

mutateDb((d) => {
  d.config.accounts = {};
  // Force slotsLeft & totalSlots to 0 to prove the slot system NEVER blocks orders or leaks UI!
  d.config.slotsLeft = 0;
  d.config.totalSlots = 0;
});

clearDraft(AMMI_ID);
userChatCards.delete(String(AMMI_ID));

// ---------------------------------------------------------------------------
// 1. Fresh /start & User Screen: Colorful Orange Buttons + Zero Slots + Short Copy
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: /start & getUserScreen colorful orange buttons & minimal copy ---');
{
  resetLog();
  await bot.handleUpdate({
    update_id: 1001,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private', first_name: 'Ammi' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }
  });
  await waitUntil(() => calls('sendMessage').length >= 2);

  const sent = calls('sendMessage').map((c) => c.payload);
  check('/start sends clean welcome + live order card', sent.length === 2);

  const allSentText = sent.map((m) => m.text || '').join('\n');
  check('zero slot text in /start or order screen ("Slots", "Swiggy Slot Bot" gone)',
    !/slot/i.test(allSentText));

  // Verify reply keyboard colorful orange buttons
  const rkMsg = sent.find((m) => Array.isArray(m.reply_markup?.keyboard));
  const rkButtons = rkMsg ? rkMsg.reply_markup.keyboard.flat() : [];
  const rkCart = rkButtons.find((b) => /Cart/i.test(b.text));
  const rkAddr = rkButtons.find((b) => /Address/i.test(b.text));
  const rkSend = rkButtons.find((b) => /Send to Beta/i.test(b.text));
  check('reply keyboard Cart button is orange-badged & styled',
    Boolean(rkCart && rkCart.text.includes('🟠') && rkCart.style === 'danger'));
  check('reply keyboard Address button is orange-badged & styled',
    Boolean(rkAddr && rkAddr.text.includes('🟠') && rkAddr.style === 'danger'));
  check('reply keyboard Send to Beta button is styled',
    Boolean(rkSend && VALID_TELEGRAM_STYLES.has(rkSend.style)));
  check('every reply keyboard button uses valid Telegram Bot API style',
    rkButtons.every((b) => !b.style || VALID_TELEGRAM_STYLES.has(b.style)));

  // Verify inline card colorful orange buttons + short copy
  const screen = getUserScreen(AMMI_ID, { id: AMMI_ID, first_name: 'Ammi' });
  const plainWords = screen.text.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
  check('order card copy is concise (< 25 words when empty)', plainWords.length <= 25);

  const ikButtons = screen.keyboard.reply_markup.inline_keyboard.flat();
  const ikCart = ikButtons.find((b) => b.callback_data === 'action_add_cart');
  const ikAddr = ikButtons.find((b) => b.callback_data === 'action_add_address');
  const ikSend = ikButtons.find((b) => b.callback_data === 'action_send_to_boss');

  check('inline Cart button is orange & colored when empty',
    Boolean(ikCart && ikCart.text.includes('🟠') && ikCart.style === 'danger'));
  check('inline Address button is orange & colored when empty',
    Boolean(ikAddr && ikAddr.text.includes('🟠') && ikAddr.style === 'danger'));
  check('inline Send to Beta starts primary blue before both links arrive',
    Boolean(ikSend && ikSend.style === 'primary'));
  check('every inline button uses valid Telegram Bot API style',
    ikButtons.every((b) => !b.style || VALID_TELEGRAM_STYLES.has(b.style)));
}

// ---------------------------------------------------------------------------
// 2. Direct Input & Cross-Button Tolerance (Ammi taps Cart, pastes Address first!)
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: direct & cross-order link pasting without scolding ---');
{
  clearDraft(AMMI_ID);
  userChatCards.delete(String(AMMI_ID));
  resetLog();

  // Ammi taps "🟠 🛒 Cart Link" on reply keyboard
  await bot.handleUpdate({
    update_id: 1002,
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private', first_name: 'Ammi' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Ammi' },
      text: '🟠 🛒 Cart Link'
    }
  });
  await waitUntil(() => calls('sendMessage').some((c) => c.payload?.reply_markup?.force_reply));

  const promptMsg = calls('sendMessage').find((c) => c.payload?.reply_markup?.force_reply);
  const promptWords = (promptMsg?.payload?.text || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
  check('cart prompt is ultra-short (<= 8 words)', promptWords.length > 0 && promptWords.length <= 8);

  // Now Ammi accidentally pastes her ADDRESS link first while waiting_cart is active!
  resetLog();
  await bot.handleUpdate({
    update_id: 1003,
    message: {
      message_id: 11,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private', first_name: 'Ammi' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Ammi' },
      text: 'https://swiggy.onelink.me/JgkQ/ammiaddr1'
    }
  });
  await waitUntil(() => Boolean(getDraft(AMMI_ID).addressLink) && calls('sendMessage').some((c) => c.payload?.reply_markup?.force_reply));

  const draftAfterAddr = getDraft(AMMI_ID);
  check('valid Address link is accepted immediately even during waiting_cart',
    draftAfterAddr.addressLink === 'https://swiggy.onelink.me/JgkQ/ammiaddr1');
  check('no "Fake / Invalid" error was sent',
    !calls('sendMessage').some((c) => /Fake|Invalid/i.test(c.payload?.text || '')));

  // Address button turns green; Cart button stays orange!
  const midScreen = getUserScreen(AMMI_ID, { id: AMMI_ID, first_name: 'Ammi' });
  const midButtons = midScreen.keyboard.reply_markup.inline_keyboard.flat();
  const midCart = midButtons.find((b) => b.callback_data === 'action_add_cart');
  const midAddr = midButtons.find((b) => b.callback_data === 'action_add_address');
  check('Address button turns green (success) once saved',
    Boolean(midAddr && midAddr.text.includes('🟢') && midAddr.style === 'success'));
  check('Cart button stays orange (danger) so Ammi sees what is left',
    Boolean(midCart && midCart.text.includes('🟠') && midCart.style === 'danger'));

  // Now Abbu/Ammi pastes Cart link directly
  resetLog();
  await bot.handleUpdate({
    update_id: 1004,
    message: {
      message_id: 12,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private', first_name: 'Ammi' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Ammi' },
      text: 'https://swig.gy/gc/998877/Biryani-House-112233'
    }
  });
  await waitUntil(() => Boolean(getDraft(AMMI_ID).cart) && calls('editMessageText').length >= 1);

  const readyScreen = getUserScreen(AMMI_ID, { id: AMMI_ID, first_name: 'Ammi' });
  const readyButtons = readyScreen.keyboard.reply_markup.inline_keyboard.flat();
  const readyCart = readyButtons.find((b) => b.callback_data === 'action_add_cart');
  const readyAddr = readyButtons.find((b) => b.callback_data === 'action_add_address');
  const readySend = readyButtons.find((b) => b.callback_data === 'action_send_to_boss');

  check('both Cart and Address buttons are green when ready',
    readyCart?.style === 'success' && readyAddr?.style === 'success');
  check('Send to Beta button turns solid green (success) when both links ready',
    readySend?.style === 'success');
}

// ---------------------------------------------------------------------------
// 3. Direct Both-Links-In-One-Message + Plain Text Single-Card Cleanliness
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: both links pasted together + plain text single card ---');
{
  clearDraft(AMMI_ID);
  userChatCards.delete(String(AMMI_ID));
  resetLog();

  // Plain text like "salam" creates/updates only 1 card, never 2 bubbles
  await bot.handleUpdate({
    update_id: 1005,
    message: {
      message_id: 20,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private', first_name: 'Abbu' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Abbu' },
      text: 'salam beta khana mangwana hai'
    }
  });
  await waitUntil(() => calls('sendMessage').length >= 1);
  await new Promise((r) => setTimeout(r, 80));
  check('plain text sends only the single clean order card (no duplicate lecture bubble)',
    calls('sendMessage').length === 1);

  // Paste both links in one single message without tapping any button
  resetLog();
  await bot.handleUpdate({
    update_id: 1006,
    message: {
      message_id: 21,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private', first_name: 'Abbu' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Abbu' },
      text: 'https://swig.gy/gc/554433/AlBaik-998811\nhttps://swiggy.onelink.me/JgkQ/abbuaddr2'
    }
  });
  await waitUntil(() => Boolean(getDraft(AMMI_ID).cart && getDraft(AMMI_ID).address) && calls('editMessageText').length >= 1);

  const bothDraft = getDraft(AMMI_ID);
  check('both Cart & Address links captured from a single message',
    Boolean(bothDraft.cart && bothDraft.address));
  check('existing single card edited in place (0 new bubbles)',
    calls('sendMessage').length === 0 && calls('editMessageText').length === 1);
}

// ---------------------------------------------------------------------------
// 4. Slot System Completely Gone: slotsLeft = 0 NEVER blocks Boss Accept or Bill Approval
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: zero slot blocking even when slotsLeft === 0 ---');
{
  const db = getDb();
  db.config.slotsLeft = 0;
  db.config.totalSlots = 0;

  // 4a. Customer order card has zero "Slots left" text in every status
  const orderPending = {
    id: 'V29_ORD_1',
    userId: AMMI_ID,
    userName: 'Ammi',
    restaurantName: 'Dastarkhwan',
    address: 'Hazratganj, Lucknow',
    items: [{ name: 'Chicken Biryani', price: 280, qty: 1, lineTotal: 280 }],
    subtotal: 280,
    itemTotal: 280,
    finalPayable: 165,
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString(),
    bossMessageIds: {}
  };
  db.orders.V29_ORD_1 = orderPending;
  saveDb(db);

  const pendingCard = formatUserOrderCard(orderPending);
  check('formatUserOrderCard (PENDING) has zero Slots text', !/slot/i.test(pendingCard.text));

  // 4b. Boss taps Accept while slotsLeft === 0 -> ACCEPTED (NOT rejected with "Sorry, slot has ended.")
  resetLog();
  await bot.handleUpdate({
    update_id: 1007,
    callback_query: {
      id: 'cb_accept_v29',
      from: { id: BOSS_ID, is_bot: false, first_name: 'Boss' },
      message: {
        message_id: 500,
        date: Math.floor(Date.now() / 1000),
        chat: { id: BOSS_ID, type: 'private' },
        text: 'Order #V29_ORD_1'
      },
      chat_instance: 'ci_1',
      data: 'boss_action_accept_V29_ORD_1'
    }
  });
  await waitUntil(() => getDb().orders.V29_ORD_1?.status === 'ACCEPTED');

  const afterAccept = getDb().orders.V29_ORD_1;
  check('Boss Accept succeeds even with slotsLeft === 0', afterAccept.status === 'ACCEPTED');
  check('Boss Accept never sets "Sorry, slot has ended."', !afterAccept.rejectReason);
  const confirmedCard = formatUserOrderCard(afterAccept);
  check('formatUserOrderCard (ACCEPTED) has zero Slots text', !/slot/i.test(confirmedCard.text));

  // 4c. Customer approves bill while slotsLeft === 0 -> PAYMENT_PENDING (NOT rejected!)
  userChatCards.delete(String(AMMI_ID));
  const db2 = getDb();
  db2.config.slotsLeft = 0;
  db2.config.totalSlots = 0;
  db2.orders.V29_ORD_2 = {
    id: 'V29_ORD_2',
    userId: AMMI_ID,
    userChatId: AMMI_ID,
    userName: 'Abbu',
    restaurantName: 'Tunday Kababi',
    address: 'Aminabad, Lucknow',
    items: [{ name: 'Galouti Kebab', price: 180, qty: 2, lineTotal: 360 }],
    subtotal: 360,
    itemTotal: 360,
    finalPayable: 210,
    selectedAccount: 'acc_test',
    status: 'APPROVAL_PENDING',
    cardStage: 'BILL_READY',
    paymentStatus: 'UNPAID',
    pendingSwiggyUpiUri: 'upi://pay?pa=upiswiggy@icici&pn=Swiggy&am=210.00&cu=INR&tr=V29TR',
    createdAt: new Date().toISOString(),
    bossMessageIds: {}
  };
  saveDb(db2);

  resetLog();
  await sendBillSummaryToCustomerOnce(bot.telegram, db2.orders.V29_ORD_2, { force: true });
  const billSend = calls('sendMessage').at(-1);
  const billBtns = billSend?.payload?.reply_markup?.inline_keyboard?.flat() || [];
  check('customer bill summary Approve button is green (success) & issue button is danger',
    billBtns.find((b) => b.callback_data === 'user_approve_bill_V29_ORD_2')?.style === 'success' &&
    billBtns.find((b) => b.callback_data === 'user_bill_issue_V29_ORD_2')?.style === 'danger');

  // Wallet fund karo — fee charge succeed ho sake (slots se nahi, wallet se blocked hota tha)
  creditWallet(db2, AMMI_ID, 10000);
  saveDb(db2);

  const approvalRes = await approveUserOrderBillAction(String(AMMI_ID), 'V29_ORD_2');
  const afterApprove = getDb().orders.V29_ORD_2;
  check('approveUserOrderBillAction succeeds even with slotsLeft === 0',
    approvalRes.ok === true && afterApprove.status === 'PAYMENT_PENDING');
  check('bill approval never rejects with "Sorry, slot has ended."',
    afterApprove.status !== 'REJECTED' && !/slot/i.test(String(approvalRes.error || '')));
}

console.log('\n' + '='.repeat(68));
const passed = results.filter((r) => r.ok).length;
console.log(`🏆 RESULT: ${passed}/${results.length} V29 colorful-UX & no-slot checks passed!`);
console.log('='.repeat(68));
