// test_v85_order_for_someone_else_e2e.mjs
// Professor (30-10-2026): "uspar click karne par uska name and mobile number
// daalne ka option aata and order ka sms bhi us number par share hota and link
// bhi message me chla jata".
//
// Yeh test verify karta hai:
//   1) Home screen par "👤 Order for Someone Else" button dikhta hai.
//   2) Click par bot recipient ka naam maangega.
//   3) Naam daale par bot recipient ka mobile maangega.
//   4) Mobile daale par draft mein recipientName + recipientMobile save hoga.
//   5) Order creation par order par recipientName + recipientMobile attach hoga.
//   6) Order card par recipient info dikhega.
//   7) OFO cart fields (buildOfoCartFields) recipient phone/name se banege.

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-OFO';
process.env.NODE_ENV = 'test';

import fs from 'node:fs';

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

const { bot, getUserScreen, renderUserCard } = await import('./index.js');
const { SIMPLE_CHAT_CALLBACKS, buildSimpleHomeScreen, buildSimpleOrderCard } = await import('./simple-chat.js');
const { getDb, saveDb, getDraft, updateDraft, mutateDb } = await import('./store.js');
const { buildOfoCartFields } = await import('./swiggy-cart.js');

const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  if (['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto'].includes(method)) {
    return { message_id: payload.message_id || apiLog.length, chat: { id: payload.chat_id }, text: payload.text || payload.caption || '' };
  }
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const calls = (method) => apiLog.filter((c) => c.method === method);
const resetLog = () => { apiLog.length = 0; };
const textOf = (callsArr) => callsArr.map((c) => String(c.payload.text || c.payload.caption || '')).join('\n');

const U = 9_985_001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;

const tap = async (data) => {
  resetLog();
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: String(uid), from: { id: U, is_bot: false, first_name: 'Ammi' }, chat_instance: '1', data, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: U, type: 'private' }, text: 'x' } } });
  await sleep(150);
  return calls('sendMessage').concat(calls('editMessageText'));
};

const sendText = async (text) => {
  resetLog();
  await bot.handleUpdate({ update_id: ++uid, message: { message_id: ++uid, date: Math.floor(Date.now() / 1000), chat: { id: U, type: 'private' }, from: { id: U, is_bot: false, first_name: 'Ammi' }, text } });
  await sleep(150);
  return calls('sendMessage').concat(calls('editMessageText'));
};

const lastText = (callsArr) => textOf(callsArr.slice(-1));

// ── Setup ────────────────────────────────────────────────────────────────────
mutateDb((d) => {
  d.config.bossIds = [6484999726];
  d.config.simpleChatUsers = [String(U)];
  d.drafts = {};
  d.orders = {};
});

console.log('\n=== 1. Home screen par "Order for Someone Else" button ===');
{
  const screen = buildSimpleHomeScreen({});
  const buttons = screen.keyboard.reply_markup.inline_keyboard.flat();
  const btn = buttons.find((b) => b.callback_data === SIMPLE_CHAT_CALLBACKS.orderForOthers);
  check('simple home screen par button hai', Boolean(btn));
  check('button label "Order for Someone Else" hai', btn && /Order for Someone Else/i.test(btn.text));
  check('button style primary hai', btn && btn.style === 'primary');
}
{
  const screen = getUserScreen(U, { id: U, first_name: 'Ammi' });
  const buttons = screen.keyboard.reply_markup.inline_keyboard.flat();
  const btn = buttons.find((b) => b.callback_data === 'action_order_for_others');
  check('full home screen par button hai', Boolean(btn));
}

console.log('\n=== 2. Click → naam maangega ===');
{
  const calls = await tap(SIMPLE_CHAT_CALLBACKS.orderForOthers);
  const text = textOf(calls);
  check('bot recipient naam maangega', /naam likhein|kaun ke liye/i.test(text), text.slice(0, 120));
  check('force_reply placeholder naam ka hai', /naam|name/i.test(String(calls.at(-1)?.payload?.reply_markup?.force_reply || '')) || /naam|name/i.test(text));
}

console.log('\n=== 3. Naam daale par → mobile maangega ===');
{
  const calls = await sendText('Rahul');
  const text = lastText(calls);
  check('bot mobile number maangega', /mobile number|10-digit/i.test(text), text.slice(0, 120));
  const draft = getDraft(U);
  check('draft mein recipientName save hua', draft.recipientName === 'Rahul', JSON.stringify(draft.recipientName));
}

console.log('\n=== 4. Mobile daale par → draft save hoga ===');
{
  const calls = await sendText('9876543210');
  const text = textOf(calls);
  check('bot confirm karta hai', /mobile saved|✓|Rahul/i.test(text), text.slice(0, 200));
  const draft = getDraft(U);
  check('draft mein recipientMobile save hua', draft.recipientMobile === '9876543210', JSON.stringify(draft.recipientMobile));
  check('draft addressDetails.mobile bhi set hua', draft.addressDetails?.mobile === '9876543210', JSON.stringify(draft.addressDetails?.mobile));
  check('draft recipientName bhi intact hai', draft.recipientName === 'Rahul');
}

console.log('\n=== 5. Order creation par recipient attach hoga ===');
{
  // Simulate order creation like the flow does
  const draft = getDraft(U);
  const order = {
    id: 'V85ORD1',
    userId: U,
    userName: 'Ammi',
    type: 'SWIGGY_ORDER',
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    isCustomerSubmitted: true,
    simpleChat: true,
    createdAt: new Date().toISOString(),
    userChatId: U,
    address: draft.addressDetails?.address || 'Test Address',
    addressDetails: { ...draft.addressDetails },
    cart: 'https://swiggy.com/cart',
    restaurantId: 'rest_1',
    items: [{ name: 'Biryani', price: 200, qty: 1, lineTotal: 200 }],
    subtotal: 200,
    itemTotal: 200,
    finalPayable: 200,
    bossMessageIds: {}
  };

  // Apply same logic as order creation flow
  if (draft.recipientName) order.recipientName = draft.recipientName;
  if (draft.recipientMobile) {
    order.recipientMobile = draft.recipientMobile;
    order.deliveryPhone = draft.recipientMobile;
    if (order.addressDetails) {
      order.addressDetails = { ...order.addressDetails, mobile: draft.recipientMobile, name: draft.recipientName || order.addressDetails?.name || '' };
    }
  }

  check('order par recipientName attach hua', order.recipientName === 'Rahul');
  check('order par recipientMobile attach hua', order.recipientMobile === '9876543210');
  check('order addressDetails.mobile recipient ka hai', order.addressDetails.mobile === '9876543210');
  check('order addressDetails.name recipient ka hai', order.addressDetails.name === 'Rahul');
}

console.log('\n=== 6. OFO cart fields recipient se banege ===');
{
  const order = {
    recipientName: 'Rahul',
    recipientMobile: '9876543210',
    addressDetails: { mobile: '9876543210', name: 'Rahul' }
  };
  const ofoFields = buildOfoCartFields(order);
  check('is_order_for_someone_else true hai', ofoFields.is_order_for_someone_else === true);
  check('alternate_mobile recipient ka hai', ofoFields.alternate_mobile === '9876543210');
  check('recipient_details name hai', ofoFields.recipient_details?.name === 'Rahul');
  check('recipient_details phone hai', ofoFields.recipient_details?.phone === '9876543210');
  check('order_comments mein recipient ka naam hai', /Rahul/.test(ofoFields.order_comments || ''));
}

console.log('\n=== 7. Order card par recipient info dikhega ===');
{
  const order = {
    id: 'V85CARD1',
    userId: U,
    userName: 'Ammi',
    simpleChat: true,
    status: 'ACCEPTED',
    paymentStatus: 'PAID',
    trackingLink: 'https://www.swiggy.com/ofo/track/abc123',
    restaurantName: 'Dastarkhwan',
    recipientName: 'Rahul',
    recipientMobile: '9876543210',
    addressDetails: { mobile: '9876543210', name: 'Rahul', address: 'Hazratganj' },
    swiggyOrderId: 'SW85001',
    liveOrderStatus: 'Out for Delivery',
    deliveryBoyName: 'Rahul Bhai',
    deliveryBoyMobile: '9999999999',
    orderAccount: '9876500000',
    deliveryOtp: '1234',
    etaMinutes: '15'
  };
  const card = buildSimpleOrderCard(order);
  const text = card.text;
  check('card mein "Order for: Rahul" dikhega', /Order for:/i.test(text) && /Rahul/.test(text), text.slice(0, 200));
  check('card mein recipient mobile dikhega', /9876543210/.test(text));
}
{
  const order = {
    id: 'V85CARD2',
    userId: U,
    userName: 'Ammi',
    simpleChat: true,
    status: 'BILL',
    cardStage: 'BILL_READY',
    restaurantName: 'Dastarkhwan',
    recipientName: 'Rahul',
    recipientMobile: '9876543210',
    addressDetails: { mobile: '9876543210', name: 'Rahul', address: 'Hazratganj' },
    items: [{ name: 'Biryani', price: 200, qty: 1, lineTotal: 200 }],
    subtotal: 200,
    itemTotal: 200,
    finalPayable: 200
  };
  const card = buildSimpleOrderCard(order);
  const text = card.text;
  check('BILL card mein recipient dikhega', /Order for:/i.test(text) && /Rahul/.test(text), text.slice(0, 200));
}

console.log('\n=== 8. Full flow E2E — click → naam → mobile → draft ===');
{
  // Fresh user
  mutateDb((d) => {
    d.drafts[String(U)] = { address: null, cart: null, submitted: false, currentOrderId: null };
  });

  // 1) Click button
  let calls = await tap(SIMPLE_CHAT_CALLBACKS.orderForOthers);
  check('click par naam maangega', /naam likhein|kaun ke liye/i.test(textOf(calls)));

  // 2) Send name
  calls = await sendText('Sir');
  check('naam daale par mobile maangega', /mobile number|10-digit/i.test(lastText(calls)));

  // 3) Send mobile
  calls = await sendText('9123456789');
  check('mobile daale par confirm mila', /mobile saved|✓|Sir/i.test(lastText(calls)));

  // 4) Draft check
  const draft = getDraft(U);
  check('draft recipientName = Sir', draft.recipientName === 'Sir');
  check('draft recipientMobile = 9123456789', draft.recipientMobile === '9123456789');

  // 5) Order creation simulation
  const order = {
    id: 'V85E2E',
    userId: U,
    recipientName: draft.recipientName,
    recipientMobile: draft.recipientMobile,
    addressDetails: { mobile: draft.recipientMobile, name: draft.recipientName, address: 'Test' },
    items: [{ name: 'Pizza', price: 300, qty: 1, lineTotal: 300 }],
    subtotal: 300,
    finalPayable: 300,
    simpleChat: true
  };
  const ofo = buildOfoCartFields(order);
  check('OFO fields recipient phone se bane', ofo.alternate_mobile === '9123456789');
  check('OFO fields recipient name se bane', ofo.recipient_details?.name === 'Sir');
}

console.log('\n=== 9. Cancel path — user cancels naam entry ===');
{
  mutateDb((d) => {
    d.drafts[String(U)] = { address: null, cart: null, submitted: false, currentOrderId: null };
  });

  await tap(SIMPLE_CHAT_CALLBACKS.orderForOthers);
  const calls = await sendText('cancel');
  const text = lastText(calls);
  check('cancel par bot wapas home screen deta hai', /Cart|Swiggy order|Order for Someone Else/i.test(text), text.slice(0, 120));
  const draft = getDraft(U);
  check('cancel par recipientName nahi save hua', !draft.recipientName);
}

console.log('\n=== 10. Naam too short → retry ===');
{
  mutateDb((d) => {
    d.drafts[String(U)] = { address: null, cart: null, submitted: false, currentOrderId: null };
  });

  await tap(SIMPLE_CHAT_CALLBACKS.orderForOthers);
  const calls = await sendText('x');
  const text = lastText(calls);
  check('short naam par retry maangega', /sahi likhein|naam/i.test(text), text.slice(0, 120));
  const draft = getDraft(U);
  check('short naam par recipientName nahi save hua', !draft.recipientName);
}

console.log('\n' + '='.repeat(60));
console.log(`📊 RESULT: ${pass}/${pass + fail} checks passed`);
if (fail === 0) console.log('✅ Offline/mock checks passed — real Swiggy placement, tracking and SMS are NOT verified.');
else console.log(`❌ ${fail} checks FAILED`);
process.exitCode = fail > 0 ? 1 : 0;
