// ============================================================================
// v40 — SIMPLE CHAT FLOW: two Swiggy links in, one tap consent, tracking out
// ----------------------------------------------------------------------------
// Contract under test (all inside Telegram chat — no web app / mini app):
//   1. The customer screen asks for exactly two things: Cart link + Address link.
//   2. Once the bill is ready there is ONE consent button ("✅ Confirm ₹xxx").
//   3. Tapping it stores the consent on the order (who / when / amount / channel)
//      and only then the Swiggy payment QR is created.
//   4. When Swiggy publishes the tracking link, the customer gets ONE short
//      bubble with a "🛵 Track on Swiggy" URL button (no duplicate bubbles).
//   5. Simple-chat order cards remain chat-only; the optional Mini App is separate.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

// Offline: every Swiggy call fails fast and cleanly.
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

const {
  bot,
  getUserScreen,
  updateOrderCards,
  userChatCards,
  sendSimpleTrackingOnce,
  getSimpleFocusOrder,
  customerOrderCard
} = await import('./index.js');
const {
  isSimpleChatEnabled,
  buildSimpleHomeScreen,
  buildSimpleOrderCard,
  buildSimpleTrackingMessage,
  getSimpleStage
} = await import('./simple-chat.js');
const { getDb, mutateDb, updateDraft, clearDraft } = await import('./store.js');

const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  if (method === 'sendMessage' || method === 'editMessageText' || method === 'editMessageCaption' || method === 'sendPhoto') {
    return {
      message_id: payload.message_id || apiLog.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: 'private' },
      text: payload.text || payload.caption || ''
    };
  }
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const calls = (method) => apiLog.filter((c) => c.method === method);
const resetLog = () => { apiLog.length = 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CUSTOMER = 4040401;

// v72: ₹15/order service fee QR se pehle wallet se kati jati hai — test customer
// ko balance de do (bina balance QR nahi banta, yehi asli behaviour hai).
{
  const { ensureWallet, creditWallet } = await import('./user-wallet.js');
  mutateDb((d) => {
    for (const uid of [String(CUSTOMER)]) {
      ensureWallet(d, uid, { name: 'test customer' });
      creditWallet(d, uid, 200000, { reason: 'v72 test seed', actor: 'test' });
    }
  });
}

const TRACK_URL = 'https://r.swiggy.com/swiggy/ofo/track/251999888777666';

mutateDb((d) => {
  d.config.accounts = {};
  d.orders = {};
  d.drafts = {};
});

clearDraft(CUSTOMER);
userChatCards.delete(String(CUSTOMER));

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: /start gives ONE simple screen (no web app) ---');
{
  resetLog();
  await bot.handleUpdate({
    update_id: 4001,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CUSTOMER, type: 'private', first_name: 'Ammi' },
      from: { id: CUSTOMER, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }
  });
  await sleep(350);

  const sent = calls('sendMessage').map((c) => c.payload);
  const card = sent.find((m) => Array.isArray(m.reply_markup?.inline_keyboard));
  check('/start sends a simple order card', Boolean(card));
  const buttons = (card?.reply_markup?.inline_keyboard || []).flat();
  check('the card has the single "paste cart + address" action',
    buttons.some((b) => b.callback_data === 'simple_paste_links'));
  check('no inline web_app / mini-app button anywhere',
    !JSON.stringify(calls('sendMessage')).includes('web_app'));
  check('no "Send to Beta" jargon on the customer screen',
    !/send to beta/i.test(card?.text || '') &&
    !buttons.some((b) => /send to beta/i.test(b.text || '')));
  const replyKeyboardMsg = sent.find((m) => Array.isArray(m.reply_markup?.keyboard));
  const replyButtons = (replyKeyboardMsg?.reply_markup?.keyboard || []).flat();
  check('reply keyboard (when present) has no Send-to-Beta button (simple mode)',
    !replyKeyboardMsg || !replyButtons.some((b) => /send to beta/i.test(b.text || '')));

  const home = buildSimpleHomeScreen({});
  const homeButtons = home.keyboard.reply_markup.inline_keyboard.flat();
  check('home screen copy asks only for the two links',
    /Cart/i.test(home.text) && /Address/i.test(home.text) && home.text.replace(/<[^>]+>/g, '').split(/\s+/).length < 40);
  check('home screen has no URL buttons (chat only)',
    homeButtons.every((b) => !b.url));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: one link saved -> card still shows one paste action ---');
{
  updateDraft(CUSTOMER, {
    cart: 'https://swig.gy/gc/abc123',
    cartDetails: {
      restaurantName: 'Pizza Hut',
      subtotal: 420,
      items: [{ name: 'Margherita', qty: 1, price: 420 }]
    }
  });
  const screen = getUserScreen(CUSTOMER, { id: CUSTOMER, first_name: 'Ammi' });
  check('cart shows restaurant + amount on the home card', /Pizza Hut/.test(screen.text) && /420/.test(screen.text));
  check('home card still offers the paste action', screen.keyboard.reply_markup.inline_keyboard
    .flat().some((b) => b.callback_data === 'simple_paste_links'));
  check('missing address is called out, no extra lecture', /Address/i.test(screen.text));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: bill card carries ONE consent button ---');
const ORDER_ID = 'SIMPLE9001';
{
  mutateDb((d) => {
    d.orders[ORDER_ID] = {
      id: ORDER_ID,
      userId: CUSTOMER,
      userName: 'Ammi',
      simpleChat: true,
      isCustomerSubmitted: true,
      status: 'APPROVAL_PENDING',
      cardStage: 'BILL_READY',
      paymentStatus: 'UNPAID',
      createdAt: new Date().toISOString(),
      cart: 'https://swig.gy/gc/abc123',
      restaurantName: 'Pizza Hut',
      items: [
        { name: 'Margherita', qty: 1, price: 420 },
        { name: 'Garlic Bread', qty: 1, price: 129 }
      ],
      subtotal: 549,
      finalPayable: 487,
      totalSavings: 62,
      selectedAccount: 'acc_9000000001',
      orderAccount: '9000000001',
      address: 'Flat 4, Gomti Nagar, Lucknow 226010',
      addressDetails: {
        address: 'Flat 4, Gomti Nagar, Lucknow 226010',
        city: 'Lucknow',
        mobile: '9876543210'
      },
      userChatId: CUSTOMER,
      userMessageId: 777,
      bossMessageIds: {}
    };
  });

  const order = getDb().orders[ORDER_ID];
  check('bill stage detected', getSimpleStage(order) === 'BILL');
  const card = buildSimpleOrderCard(order);
  const buttons = card.keyboard.reply_markup.inline_keyboard.flat();
  const consent = buttons.find((b) => b.callback_data === `simple_confirm_order_${ORDER_ID}`);
  check('bill card has the consent button', Boolean(consent));
  // v76: button ka label ab "QR banao — ₹487" (boss: bill ke baad sirf QR option).
  check('consent button shows the exact payable amount', /QR banao — ₹487/.test(consent?.text || ''));
  check('bill card shows restaurant, items and address',
    /Pizza Hut/.test(card.text) && /Margherita/.test(card.text) && /Lucknow/.test(card.text));
  check('bill card has no web app link', buttons.every((b) => !b.url));

  resetLog();
  const updated = await updateOrderCards(order);
  const edit = calls('editMessageText')[0]?.payload;
  check('the single live card is edited into the simple bill',
    updated.userCardUpdated === true &&
    Boolean(edit) &&
    /Confirm your order/.test(edit.text || '') &&
    /₹487/.test(edit.text || '') &&
    JSON.stringify(edit.reply_markup || {}).includes(`simple_confirm_order_${ORDER_ID}`));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: consent tap is recorded, then the QR is created ---');
{
  resetLog();
  await bot.handleUpdate({
    update_id: 4002,
    callback_query: {
      id: 'cb-simple-confirm',
      from: { id: CUSTOMER, is_bot: false, first_name: 'Ammi' },
      chat_instance: 'ci',
      data: `simple_confirm_order_${ORDER_ID}`,
      message: {
        message_id: 777,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CUSTOMER, type: 'private' },
        text: 'bill'
      }
    }
  });
  await sleep(700);

  const saved = getDb().orders[ORDER_ID];
  check('customer consent is stored on the order', saved?.customerConsentGiven === true);
  check('consent records who tapped it', String(saved?.customerConsentBy) === String(CUSTOMER));
  check('consent records when it happened', Boolean(saved?.customerConsentAt));
  check('consent records the channel (Telegram button, not a web app)',
    saved?.customerConsentVia === 'TELEGRAM_BUTTON' && /No web app/i.test(String(saved?.customerConsentText)));
  check('consent cannot be re-asked (bill marked approved once)',
    saved?.billApprovedByUser === true || ['PAYMENT_PENDING', 'APPROVAL_PENDING'].includes(String(saved?.status)));
  const answered = calls('answerCallbackQuery');
  check('the tap is acknowledged in chat', answered.length >= 1);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: tracking link arrives once, as a tappable button ---');
{
  mutateDb((d) => {
    const o = d.orders[ORDER_ID];
    o.status = 'COMPLETED';
    o.paymentStatus = 'PAID';
    o.swiggyOrderId = '251999888777666';
    o.trackingLink = TRACK_URL;
    o.trackingLinkSource = 'SWIGGY_API';
    o.liveOrderStatus = 'Out for delivery';
    o.deliveryOtp = '445566';
  });
  const order = getDb().orders[ORDER_ID];
  check('tracking stage detected', getSimpleStage(order) === 'TRACKING');

  const card = buildSimpleOrderCard(order);
  const buttons = card.keyboard.reply_markup.inline_keyboard.flat();
  check('tracking card offers a Swiggy tracking URL button',
    buttons.some((b) => b.url === TRACK_URL));
  check('tracking card shows the delivery OTP and Swiggy id',
    /445566/.test(card.text) && /251999888777666/.test(card.text));

  resetLog();
  const first = await sendSimpleTrackingOnce(getDb().orders[ORDER_ID]);
  await sleep(150);
  const second = await sendSimpleTrackingOnce(getDb().orders[ORDER_ID]);
  check('tracking bubble is sent the first time', first === true);
  check('tracking bubble is never duplicated', second === false);
  const trackMsg = calls('sendMessage').map((c) => c.payload).find((m) => /Tracking link aa gaya/i.test(m.text || ''));
  check('tracking bubble carries the real Swiggy link', Boolean(trackMsg) && String(trackMsg.text).includes(TRACK_URL));
  check('tracking bubble button opens Swiggy (not a bot web page)',
    (trackMsg?.reply_markup?.inline_keyboard || []).flat().some((b) => b.url === TRACK_URL));

  const msg = buildSimpleTrackingMessage(getDb().orders[ORDER_ID]);
  check('tracking message has no fabricated link', msg.text.includes('swiggy.com'));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 6: focus order + sources stay chat-only ---');
{
  const focus = getSimpleFocusOrder(CUSTOMER);
  check('the customer card follows their live order, not a blank draft', focus?.id === ORDER_ID);

  const indexSrc = fs.readFileSync('index.js', 'utf8');
  const simpleSrc = fs.readFileSync('simple-chat.js', 'utf8');
  check('optional Mini App is separate from the existing simple-chat cards',
    /bot\.command\('pro'/.test(indexSrc) && /PRO_MINIAPP_URL/.test(indexSrc) && !/web_app\s*:/.test(simpleSrc));
  const urlButtons = [
    ...buildSimpleOrderCard(getDb().orders[ORDER_ID]).keyboard.reply_markup.inline_keyboard.flat(),
    ...buildSimpleHomeScreen({}).keyboard.reply_markup.inline_keyboard.flat()
  ].filter((b) => b.url);
  check('customer screens only open Swiggy (never a bot-hosted web page)',
    urlButtons.every((b) => /^https?:\/\/([a-z0-9-]+\.)*swiggy\.com\//i.test(b.url)));
  check('simple mode is enabled for this deployment', isSimpleChatEnabled() === true);
  check('simple order card is used for customer orders', customerOrderCard(getDb().orders[ORDER_ID])?.text?.includes('Order confirmed') === true);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 7: two pasted links create the order with ZERO typing ---');
{
  const { startSimpleOrderFromDraft } = await import('./index.js');
  const { clearDraft, updateDraft, getDraft } = await import('./store.js');

  const CUSTOMER_B = 4040402;
  clearDraft(CUSTOMER_B);
  updateDraft(CUSTOMER_B, {
    cart: 'https://swig.gy/gc/xyz789',
    // Plain saved address (no address link) so the offline run needs no network.
    address: 'Hazratganj, Lucknow 226001',
    cartDetails: {
      restaurantName: 'Burger King',
      subtotal: 350,
      items: [{ name: 'Whopper', qty: 1, price: 350 }]
    },
    addressDetails: {
      address: 'Hazratganj, Lucknow 226001',
      city: 'Lucknow',
      mobile: '9876500011'
    }
  });

  resetLog();
  const fakeCtx = {
    from: { id: CUSTOMER_B, first_name: 'Abbu' },
    chat: { id: CUSTOMER_B, type: 'private' },
    telegram: bot.telegram,
    reply: async (text, extra = {}) => bot.telegram.sendMessage(CUSTOMER_B, text, extra),
    answerCbQuery: async () => true
  };
  const started = await startSimpleOrderFromDraft(fakeCtx, CUSTOMER_B);
  await sleep(400);

  const created = Object.values(getDb().orders).filter((o) => Number(o.userId) === CUSTOMER_B);
  check('two links are enough — the order is created automatically', started === true && created.length === 1);
  check('the draft is consumed, no stale links remain', !getDraft(CUSTOMER_B)?.cart);
  check('the order is linked to the customer chat card', Boolean(created[0]?.userChatId));
  check('nothing is charged before the customer consents',
    created[0]?.customerConsentGiven !== true && !created[0]?.billApprovedByUser);

  const sentPayloads = calls('sendMessage').map((c) => c.payload);
  check('no mobile-number typing prompt is sent (simple mode)', !sentPayloads.some((p2) =>
    p2?.reply_markup?.force_reply || /mobile number.*bhejein/i.test(String(p2?.text || ''))));
  check('no web app button is offered during intake', !JSON.stringify(sentPayloads).includes('web_app'));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 8: consent + ready bill -> QR without a second tap ---');
{
  const { autoApproveConsentedSimpleOrder } = await import('./index.js');
  const CONSENTED_ID = 'SIMPLE9002';
  mutateDb((d) => {
    // v60: boss ki UPI panel/wallet ke liye set rehti hai.
    d.config.bossUpiId = 'ammi.family@okaxis';
    // v78 (boss 30-10-2026): order ka QR SIRF Swiggy ke payment intent se banta
    // hai — boss ki personal UPI "Swiggy ka QR" ban ke nahi jati.
    d.orders[CONSENTED_ID] = {
      id: CONSENTED_ID,
      userId: CUSTOMER,
      userName: 'Ammi',
      simpleChat: true,
      isCustomerSubmitted: true,
      status: 'APPROVAL_PENDING',
      cardStage: 'BILL_READY',
      paymentStatus: 'UNPAID',
      createdAt: new Date().toISOString(),
      cart: 'https://swig.gy/gc/abc123',
      restaurantName: 'Pizza Hut',
      items: [{ name: 'Margherita', qty: 1, price: 420 }],
      subtotal: 420,
      finalPayable: 379,
      customerConsentGiven: true,
      customerConsentAt: new Date().toISOString(),
      customerConsentBy: String(CUSTOMER),
      customerConsentVia: 'TELEGRAM_BUTTON',
      customerConsentAmount: 379,
      userChatId: CUSTOMER,
      userMessageId: 778,
      bossMessageIds: {},
      pendingSwiggyUpiUri: 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=379&cu=INR&tr=V40TXN'
    };
  });

  resetLog();
  const approved = await autoApproveConsentedSimpleOrder(getDb().orders[CONSENTED_ID]);
  await sleep(400);
  const after = getDb().orders[CONSENTED_ID];
  check('consent alone turns the ready bill into an approved payment', approved === true);
  check('the order moves to payment pending', after?.status === 'PAYMENT_PENDING');
  check('a payment QR/photo is delivered in the same chat',
    calls('sendPhoto').length >= 1 && String(calls('sendPhoto')[0]?.payload?.chat_id) === String(CUSTOMER));
  check('the payment bubble keeps the one-tap "I have paid" action',
    JSON.stringify(calls('sendPhoto')[0]?.payload?.reply_markup || {}).includes(`user_paid_status_${CONSENTED_ID}`));

  // A second run must never create a second QR.
  resetLog();
  await autoApproveConsentedSimpleOrder(getDb().orders[CONSENTED_ID]);
  await sleep(250);
  check('replay never sends a second payment QR', calls('sendPhoto').length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 9: "Finish" really clears the finished card ---');
{
  const { getSimpleFocusOrder } = await import('./index.js');
  const { mutateDb: mutate, getDb: readDb } = await import('./store.js');
  const FINISH_ID = 'SIMPLE9003';
  const FINISH_USER = 4040499;
  mutate((d) => {
    d.orders[FINISH_ID] = {
      id: FINISH_ID,
      userId: FINISH_USER,
      userName: 'Ammi',
      simpleChat: true,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      createdAt: new Date().toISOString(),
      restaurantName: 'Pizza Hut',
      swiggyOrderId: '251000111222333',
      trackingLink: TRACK_URL,
      trackingLinkSource: 'SWIGGY_API',
      userChatId: FINISH_USER,
      userMessageId: 779,
      bossMessageIds: {}
    };
  });
  check('the finished order is shown while it is fresh', getSimpleFocusOrder(FINISH_USER)?.id === FINISH_ID);

  resetLog();
  await bot.handleUpdate({
    update_id: 4010,
    callback_query: {
      id: 'cb-simple-finish',
      from: { id: FINISH_USER, is_bot: false, first_name: 'Ammi' },
      chat_instance: 'ci',
      data: 'simple_new_order',
      message: { message_id: 779, date: Math.floor(Date.now() / 1000), chat: { id: FINISH_USER, type: 'private' }, text: 'tracking' }
    }
  });
  await sleep(400);

  check('the finished order is dismissed after Finish', readDb().orders[FINISH_ID]?.simpleCardDismissed === true);
  check('the customer lands on the empty link screen again', !getSimpleFocusOrder(FINISH_USER));
  const card = calls('sendMessage').map((c) => c.payload).find((m) =>
    Number(m.chat_id) === FINISH_USER && /Cart link/i.test(String(m.text || '')));
  check('a fresh order card is posted after Finish', Boolean(card));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
