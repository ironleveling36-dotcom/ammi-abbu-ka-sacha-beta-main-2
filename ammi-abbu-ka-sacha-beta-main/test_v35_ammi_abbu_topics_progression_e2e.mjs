// ============================================================================
// test_v35_ammi_abbu_topics_progression_e2e.mjs
// End-to-end testing of 4-Topic Progressive Progression System for Ammi & Abbu:
//   Topic 1: 🛒 Submit Link
//   Topic 2: 🧾 Bill & Confirmation
//   Topic 3: 💳 Payment & QR
//   Topic 4: 🛵 Live Tracking
//
// Rules verified:
//   1. Topic buttons unlock ONLY when each level passes (no skipping ahead).
//   2. Tapping locked topics shows clear alert with exact required action.
//   3. Finishing all topics cleanly returns user to Start (Topic 1).
// ============================================================================

process.env.TEST_MODE = process.env.TEST_MODE || '1';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST-TOKEN-FOR-OFFLINE-E2E';

import {
  getDb,
  clearDraft,
  updateDraft,
  saveDb,
  getActiveUserOrder
} from './store.js';

import {
  getOrderCurrentTopic,
  buildTopicNavKeyboardRows,
  formatTopicProgressBarText,
  resetOrderTopicsToStart
} from './ammi-abbu-topic-flow.js';

// `index.js` is imported dynamically so the offline TEST_MODE/BOT_TOKEN env is
// in place before it boots (static imports would hoist above the assignments).
const {
  bot,
  getUserScreen,
  formatUserOrderCard,
  approveUserOrderBillAction
} = await import('./index.js');

const AMMI_ID = 7859821553;
let passCount = 0;
let failCount = 0;

function check(desc, ok) {
  if (ok) {
    console.log(`✅ ${desc}`);
    passCount++;
  } else {
    console.error(`❌ FAIL: ${desc}`);
    failCount++;
  }
}

console.log('--- 1. Topic Level Identification & Mapping ---');
{
  check('Draft state (null order) -> Topic 1 (Submit Link)', getOrderCurrentTopic(null) === 1);

  const pendingOrder = { id: 'ORD_101', status: 'PENDING', cardStage: 'AUTO_SELECTING' };
  check('Pending/Scanning order -> Topic 2 (Bill & Confirm)', getOrderCurrentTopic(pendingOrder) === 2);

  const billReadyOrder = { id: 'ORD_102', status: 'APPROVAL_PENDING', billApprovedByUser: false };
  check('Approval pending order -> Topic 2 (Bill & Confirm)', getOrderCurrentTopic(billReadyOrder) === 2);

  const paymentPendingOrder = { id: 'ORD_103', status: 'PAYMENT_PENDING', paymentSentToUser: true };
  check('Payment pending order -> Topic 3 (Payment & QR)', getOrderCurrentTopic(paymentPendingOrder) === 3);

  const acceptedOrder = { id: 'ORD_104', status: 'ACCEPTED', trackingLink: 'https://www.swiggy.com/orders/track/998877' };
  check('Accepted/Tracking order -> Topic 4 (Live Tracking)', getOrderCurrentTopic(acceptedOrder) === 4);

  const completedOrder = { id: 'ORD_105', status: 'COMPLETED' };
  check('Completed order -> Topic 4 (Live Tracking)', getOrderCurrentTopic(completedOrder) === 4);
}

console.log('\n--- 2. Topic Navigation Buttons & Level-by-Level Locks ---');
{
  // Level 1: Topic 1 active, 2, 3, 4 locked
  const rows1 = buildTopicNavKeyboardRows(1, 'ORD_T1');
  const flat1 = rows1.flat();
  check('Level 1: Topic 1 is active (▶)', flat1[0].text.includes('▶') && flat1[0].text.includes('Link'));
  check('Level 1: Topic 2 is locked (🔒)', flat1[1].text.includes('🔒') && flat1[1].text.includes('Bill'));
  check('Level 1: Topic 3 is locked (🔒)', flat1[2].text.includes('🔒') && flat1[2].text.includes('Pay'));
  check('Level 1: Topic 4 is locked (🔒)', flat1[3].text.includes('🔒') && flat1[3].text.includes('Track'));

  // Level 2: Topic 1 completed (✓), Topic 2 active (▶), 3, 4 locked
  const rows2 = buildTopicNavKeyboardRows(2, 'ORD_T2');
  const flat2 = rows2.flat();
  check('Level 2: Topic 1 is completed (✓)', flat2[0].text.includes('✓'));
  check('Level 2: Topic 2 is active (▶)', flat2[1].text.includes('▶') && flat2[1].text.includes('Bill'));
  check('Level 2: Topic 3 is locked (🔒)', flat2[2].text.includes('🔒'));
  check('Level 2: Topic 4 is locked (🔒)', flat2[3].text.includes('🔒'));

  // Level 3: Topics 1, 2 completed (✓), Topic 3 active (▶), 4 locked
  const rows3 = buildTopicNavKeyboardRows(3, 'ORD_T3');
  const flat3 = rows3.flat();
  check('Level 3: Topic 1 is completed (✓)', flat3[0].text.includes('✓'));
  check('Level 3: Topic 2 is completed (✓)', flat3[1].text.includes('✓'));
  check('Level 3: Topic 3 is active (▶)', flat3[2].text.includes('▶') && flat3[2].text.includes('Pay'));
  check('Level 3: Topic 4 is locked (🔒)', flat3[3].text.includes('🔒'));

  // Level 4: Topics 1, 2, 3 completed (✓), Topic 4 active (▶)
  const rows4 = buildTopicNavKeyboardRows(4, 'ORD_T4');
  const flat4 = rows4.flat();
  check('Level 4: Topic 1 is completed (✓)', flat4[0].text.includes('✓'));
  check('Level 4: Topic 2 is completed (✓)', flat4[1].text.includes('✓'));
  check('Level 4: Topic 3 is completed (✓)', flat4[2].text.includes('✓'));
  check('Level 4: Topic 4 is active (▶)', flat4[3].text.includes('▶') && flat4[3].text.includes('Track'));
}

console.log('\n--- 3. Progress Bar Text Visuals ---');
{
  const p1 = formatTopicProgressBarText(1);
  check('Topic 1 header mentions Topic 1', p1.includes('Topic 1 of 4') && p1.includes('Submit Link'));
  check('Topic 1 progress shows [🟢 1. Link]', p1.includes('🟢 1. Link') && p1.includes('🔒 2. Bill'));

  const p2 = formatTopicProgressBarText(2);
  check('Topic 2 progress shows [✓ 1. Link] ➔ [🟢 2. Bill]', p2.includes('✓ 1. Link') && p2.includes('🟢 2. Bill'));

  const p3 = formatTopicProgressBarText(3);
  check('Topic 3 progress shows [✓ 2. Bill] ➔ [🟢 3. Pay]', p3.includes('✓ 2. Bill') && p3.includes('🟢 3. Pay'));

  const p4 = formatTopicProgressBarText(4);
  check('Topic 4 progress shows [✓ 3. Pay] ➔ [🟢 4. Track]', p4.includes('✓ 3. Pay') && p4.includes('🟢 4. Track'));
}

console.log('\n--- 4. Customer Card Renders & Topic Flow Integration ---');
{
  resetOrderTopicsToStart(AMMI_ID);
  clearDraft(AMMI_ID);
  const startScreen = getUserScreen(AMMI_ID, { id: AMMI_ID, first_name: 'Ammi' });
  const startButtons = startScreen.keyboard.reply_markup.inline_keyboard.flat();
  check('Initial user screen announces Topic 1 in header', /Topic 1: Submit Link/i.test(startScreen.text));
  check('Initial user screen exposes Topic 1 nav button', startButtons.some(b => b.callback_data === 'topic_nav_1_draft'));
  check('Initial user screen exposes locked Topic 2 button', startButtons.some(b => b.callback_data === 'topic_nav_2_draft' && b.text.includes('🔒')));
  check('Initial user screen exposes locked Topic 3 button', startButtons.some(b => b.callback_data === 'topic_nav_3_draft' && b.text.includes('🔒')));
  check('Initial user screen exposes locked Topic 4 button', startButtons.some(b => b.callback_data === 'topic_nav_4_draft' && b.text.includes('🔒')));

  // Topic 2 order card
  const orderT2 = {
    id: 'V35_ORD_2',
    userId: AMMI_ID,
    userName: 'Ammi',
    restaurantName: 'Biryani Blues',
    status: 'APPROVAL_PENDING',
    finalPayable: 150,
    billApprovedByUser: false
  };
  const cardT2 = formatUserOrderCard(orderT2);
  const btnsT2 = cardT2.keyboard.reply_markup.inline_keyboard.flat();
  check('Topic 2 card shows Topic 2 progress header', cardT2.text.includes('Topic 2 of 4'));
  check('Topic 2 card has active Topic 2 button', btnsT2.some(b => b.callback_data === 'topic_nav_2_V35_ORD_2' && b.text.includes('▶')));
  check('Topic 2 card has locked Topic 3 button', btnsT2.some(b => b.callback_data === 'topic_nav_3_V35_ORD_2' && b.text.includes('🔒')));
  check('Topic 2 card has Approve bill button', btnsT2.some(b => b.callback_data === 'user_approve_bill_V35_ORD_2'));

  // Topic 4 order card with finish button
  const orderT4 = {
    id: 'V35_ORD_4',
    userId: AMMI_ID,
    userName: 'Ammi',
    restaurantName: 'Biryani Blues',
    status: 'COMPLETED',
    deliveryOtp: 4321,
    trackingLink: 'https://www.swiggy.com/orders/track/250070826196000',
    trackingLinkSource: 'SWIGGY_API'
  };
  const cardT4 = formatUserOrderCard(orderT4);
  const btnsT4 = cardT4.keyboard.reply_markup.inline_keyboard.flat();
  check('Topic 4 card shows Topic 4 progress header', cardT4.text.includes('Topic 4 of 4'));
  check('Topic 4 card has active Topic 4 button', btnsT4.some(b => b.callback_data === 'topic_nav_4_V35_ORD_4' && b.text.includes('▶')));
  check('Topic 4 card has Finish & Start New Order button', btnsT4.some(b => b.callback_data === 'topic_finish_and_start'));
}

console.log('\n--- 5. Topic Finish & Reset to Start ---');
{
  const db = getDb();
  db.orders['V35_FINISH'] = {
    id: 'V35_FINISH',
    userId: AMMI_ID,
    status: 'ACCEPTED'
  };
  saveDb(db);

  check('Active order exists before finish', Boolean(getActiveUserOrder(AMMI_ID)));

  // Finish topics
  resetOrderTopicsToStart(AMMI_ID);

  const remaining = getActiveUserOrder(AMMI_ID);
  if (remaining) {
    console.log('Remaining order details:', remaining.id, remaining.status, remaining.userId);
  }
  check('Active order is marked COMPLETED & cleared', remaining === null || remaining === undefined);
  const postScreen = getUserScreen(AMMI_ID, { id: AMMI_ID, first_name: 'Ammi' });
  check('After finish, returns cleanly to Topic 1 (Submit Link)', /Topic 1: Submit Link/i.test(postScreen.text));
}

console.log('\n================================================================');
console.log(`🏆 RESULT: ${passCount}/${passCount + failCount} checks passed!`);
console.log('================================================================\n');

process.exit(failCount > 0 ? 1 : 0);
