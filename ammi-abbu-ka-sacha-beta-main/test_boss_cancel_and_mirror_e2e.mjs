// ============================================================================
// test_boss_cancel_and_mirror_e2e.mjs
// Verification suite for:
// 1. One-click Boss Order Cancellation from notification/card anytime.
// 2. Real-time Customer Message & QR Mirroring to Boss.
// ============================================================================

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { getDb, saveDb } from './store.js';
import { buildBossOrderCard } from './boss-panel.js';
import { installBossMirror } from './boss-mirror.js';

console.log('=== RUNNING BOSS CANCEL & MIRROR E2E TESTS ===\n');

// ----------------------------------------------------------------------------
// Test 1: Verify Cancel Order Button on Boss Order Cards across states
// ----------------------------------------------------------------------------
console.log('--- 1. Testing Cancel Button on Boss Order Cards ---');

const mockPendingOrder = {
  id: 'TEST_CANCEL_001',
  userId: '111222333',
  userName: 'Test Customer',
  status: 'PENDING',
  restaurantName: 'Biryani Palace',
  subtotal: 350,
  finalPayable: 250,
  cart: 'https://swiggy.com/cart',
  address: '123 Test St, Bangalore'
};

const pendingCard = buildBossOrderCard(mockPendingOrder);
const pendingButtons = pendingCard.keyboard.reply_markup.inline_keyboard.flat();
const cancelBtnPending = pendingButtons.find(b => b.callback_data === `boss_action_cancel_${mockPendingOrder.id}`);
const qrBtnPending = pendingButtons.find(b => b.callback_data === `boss_get_qr_${mockPendingOrder.id}`);

assert.ok(cancelBtnPending, 'Cancel Order button must be present in PENDING state');
assert.strictEqual(cancelBtnPending.text, '❌ Cancel Order');
assert.ok(qrBtnPending, 'View User QR Code button must be present');
console.log('✅ PENDING card contains ❌ Cancel Order and ▣ View User QR Code');

const mockAcceptedOrder = { ...mockPendingOrder, id: 'TEST_CANCEL_002', status: 'ACCEPTED' };
const acceptedCard = buildBossOrderCard(mockAcceptedOrder);
const acceptedButtons = acceptedCard.keyboard.reply_markup.inline_keyboard.flat();
const cancelBtnAccepted = acceptedButtons.find(b => b.callback_data === `boss_action_cancel_${mockAcceptedOrder.id}`);
assert.ok(cancelBtnAccepted, 'Cancel Order button must be present in ACCEPTED state');
console.log('✅ ACCEPTED card contains ❌ Cancel Order');

const mockCompletedOrder = { ...mockPendingOrder, id: 'TEST_CANCEL_003', status: 'COMPLETED' };
const completedCard = buildBossOrderCard(mockCompletedOrder);
const completedButtons = completedCard.keyboard.reply_markup.inline_keyboard.flat();
const cancelBtnCompleted = completedButtons.find(b => b.callback_data === `boss_action_cancel_${mockCompletedOrder.id}`);
assert.ok(cancelBtnCompleted, 'Cancel Order button must be present anytime (even COMPLETED)');
console.log('✅ COMPLETED card contains ❌ Cancel Order anytime button');

// ----------------------------------------------------------------------------
// Test 2: Real-Time Customer Message & QR Mirroring to Boss
// ----------------------------------------------------------------------------
console.log('\n--- 2. Testing Customer Message & QR Mirror to Boss ---');

const db = getDb();
const originalBossIds = [...(db.config.bossIds || [])];
const TEST_BOSS_ID = 88888888;
const TEST_CUSTOMER_ID = 77777777;

db.config.bossIds = [TEST_BOSS_ID];
db.orders = db.orders || {};
db.orders['TEST_MIRROR_ORDER'] = {
  id: 'TEST_MIRROR_ORDER',
  userId: String(TEST_CUSTOMER_ID),
  userName: 'Rahul Sharma',
  status: 'PENDING',
  finalPayable: 299
};
saveDb(db);

const sentApiCalls = [];

const mockBot = {
  telegram: {
    callApi: async (method, payload, callOpts = {}) => {
      sentApiCalls.push({ method, payload, callOpts });
      if (method === 'sendPhoto') {
        return {
          message_id: 1001,
          chat: { id: payload.chat_id },
          photo: [{ file_id: 'photo_file_id_hd' }]
        };
      }
      return {
        message_id: 1002,
        chat: { id: payload.chat_id }
      };
    }
  }
};

installBossMirror(mockBot);

// A. Send photo/QR to customer
await mockBot.telegram.callApi('sendPhoto', {
  chat_id: TEST_CUSTOMER_ID,
  photo: { source: Buffer.from('test_qr_png') },
  caption: 'Swiggy Genuine Payment QR (Order #TEST_MIRROR_ORDER)'
});

// Wait briefly for setImmediate mirror tasks
await new Promise(r => setTimeout(r, 60));

const photoMirrors = sentApiCalls.filter(c => c.callOpts?.__isBossMirror && c.method === 'sendPhoto');
assert.strictEqual(photoMirrors.length, 1, 'Exactly one mirrored photo call must be dispatched to Boss');
assert.strictEqual(String(photoMirrors[0].payload.chat_id), String(TEST_BOSS_ID));
assert.strictEqual(photoMirrors[0].payload.photo, 'photo_file_id_hd');
assert.ok(photoMirrors[0].payload.caption.includes('[BOT ➔ USER QR / PHOTO]'), 'Caption must have clear mirror header');
assert.ok(photoMirrors[0].payload.caption.includes(String(TEST_CUSTOMER_ID)), 'Caption must include customer ID');
console.log('✅ Photo/QR sent to customer was cleanly mirrored to Boss with context');

// B. Send text message to customer
await mockBot.telegram.callApi('sendMessage', {
  chat_id: TEST_CUSTOMER_ID,
  text: 'Aapka Swiggy order confirm ho gaya hai! Live tracking link: https://swiggy.com/track'
});

await new Promise(r => setTimeout(r, 60));

const textMirrors = sentApiCalls.filter(c => c.callOpts?.__isBossMirror && c.method === 'sendMessage');
assert.strictEqual(textMirrors.length, 1, 'Exactly one mirrored text call must be dispatched to Boss');
assert.strictEqual(String(textMirrors[0].payload.chat_id), String(TEST_BOSS_ID));
assert.ok(textMirrors[0].payload.text.includes('[BOT ➔ USER MESSAGE]'), 'Text mirror must have header');
assert.ok(textMirrors[0].payload.text.includes('Aapka Swiggy order confirm ho gaya hai!'), 'Text mirror must contain full body');
console.log('✅ Text message sent to customer was cleanly mirrored to Boss');

// C. Verify recursion guard: message to Boss directly is NEVER mirrored
sentApiCalls.length = 0;
await mockBot.telegram.callApi('sendMessage', {
  chat_id: TEST_BOSS_ID,
  text: 'Direct message to Boss'
});

await new Promise(r => setTimeout(r, 60));
const bossDirectMirrors = sentApiCalls.filter(c => c.callOpts?.__isBossMirror);
assert.strictEqual(bossDirectMirrors.length, 0, 'Messages sent to Boss must NEVER be mirrored (no infinite loops)');
console.log('✅ Recursion guard passed: Direct Boss messages are never looped');

// Restore original bossIds
db.config.bossIds = originalBossIds;
delete db.orders['TEST_MIRROR_ORDER'];
saveDb(db);

// ----------------------------------------------------------------------------
// Test 3: Cancellation Lifecycle & Account Release Verification
// ----------------------------------------------------------------------------
console.log('\n--- 3. Testing Cancellation Lifecycle & Account Release ---');

import {
  reserveSwiggyAccountAtomically,
  releaseSwiggyAccountReservation
} from './swiggy-cart.js';
import { stopOrderTrackingAuto } from './order-tracking.js';

const TEST_ACC_KEY = 'acc_test_cancel_999';
const LIFECYCLE_ORDER_ID = 'TEST_CANCEL_LIFECYCLE_01';

// Step 1: Bind and reserve account
const reserved = reserveSwiggyAccountAtomically(TEST_ACC_KEY, LIFECYCLE_ORDER_ID);
assert.strictEqual(reserved, true, 'Account must be reserved');
// Another order should be blocked from reserving it
assert.strictEqual(reserveSwiggyAccountAtomically(TEST_ACC_KEY, 'OTHER_ORDER_ID'), false, 'Account should be busy');

db.orders = db.orders || {};
db.orders[LIFECYCLE_ORDER_ID] = {
  id: LIFECYCLE_ORDER_ID,
  userId: String(TEST_CUSTOMER_ID),
  userName: 'Pooja Verma',
  selectedAccount: TEST_ACC_KEY,
  status: 'ACCEPTED',
  finalPayable: 450
};
saveDb(db);

// Step 2: Perform Boss Cancellation
const cancelTarget = db.orders[LIFECYCLE_ORDER_ID];
assert.strictEqual(cancelTarget.status, 'ACCEPTED');

cancelTarget.status = 'CANCELLED';
cancelTarget.cardStage = 'CANCELLED';
cancelTarget.cancelledAt = new Date().toISOString();
cancelTarget.cancelledBy = 'BOSS';
cancelTarget.cancelledReason = 'Cancelled by Boss';

releaseSwiggyAccountReservation(cancelTarget.selectedAccount, cancelTarget.id);
stopOrderTrackingAuto(cancelTarget.id);
saveDb(db);

// Step 3: Verify assertions
const updatedFromDb = getDb().orders[LIFECYCLE_ORDER_ID];
assert.strictEqual(updatedFromDb.status, 'CANCELLED');
assert.strictEqual(updatedFromDb.cancelledBy, 'BOSS');
assert.ok(updatedFromDb.cancelledAt, 'cancelledAt must be recorded');
assert.strictEqual(reserveSwiggyAccountAtomically(TEST_ACC_KEY, 'NEW_ORDER_99'), true, 'Account must be freed immediately upon Boss cancellation');
releaseSwiggyAccountReservation(TEST_ACC_KEY, 'NEW_ORDER_99');

// Step 4: Verify Card view for CANCELLED order
const cancelledCard = buildBossOrderCard(updatedFromDb);
assert.ok(cancelledCard.text.includes('Cancelled'), 'Card must show Cancelled status');
const cancelledButtons = cancelledCard.keyboard.reply_markup.inline_keyboard.flat();
const cancelBtnOnCancelledCard = cancelledButtons.find(b => b.callback_data === `boss_action_cancel_${LIFECYCLE_ORDER_ID}`);
assert.strictEqual(cancelBtnOnCancelledCard, undefined, 'Cancel button must not appear if order is already CANCELLED');
console.log('✅ Account reservation freed, state updated, and card shows Cancelled');

// Clean up
delete db.orders[LIFECYCLE_ORDER_ID];
saveDb(db);

console.log('\n================================================================');
console.log('🏆 ALL BOSS CANCEL & MIRROR TESTS PASSED SUCCESSFULLY!');
console.log('================================================================');
