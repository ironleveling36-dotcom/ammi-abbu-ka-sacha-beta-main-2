process.env.TEST_MODE = process.env.TEST_MODE || '1';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST-TOKEN-FOR-OFFLINE-E2E';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getDb,
  saveDb,
  updateAccount,
  upsertOrder
} from './store.js';
import {
  lookupOrder
} from './forwarded-order-flow.js';
import {
  inspectAccountOrderHistoryAndOffers
} from './swiggy-cart.js';
import {
  ingestAndPersistRawAccountTexts
} from './account-vault-intake.js';
process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';
const {
  formatUserOrderCard,
  formatUserOrderCardText
} = await import('./index.js');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ ${msg}`);
}

try {
  console.log('--- 1. Polymorphic Account Inspection & Order Count ---');

  // Test 1: inspectAccountOrderHistoryAndOffers handles single object argument
  const freshAcc = {
    id: 'acc_9998881111',
    phone: '9998881111',
    name: 'Fresh Account',
    isLoggedIn: true,
    totalOrdersCount: 0,
    cachedTotalOrdersCount: 0,
    ordersVerifiedLive: true,
    cookies: '_session_tid=fake_session; token=fake_token;',
    token: 'fake_token'
  };

  const profileFromObj = await inspectAccountOrderHistoryAndOffers(freshAcc);
  ok(profileFromObj.valid === true, 'Polymorphic inspectAccountOrderHistoryAndOffers succeeds with single acc argument');
  ok(profileFromObj.totalOrdersCount === 0, 'Accurately detected 0 orders on fresh account');
  ok(profileFromObj.isZeroOrderAccount === true, 'isZeroOrderAccount is true for 0 orders');

  // Test 2: Used account
  const usedAcc = {
    id: 'acc_9998882222',
    phone: '9998882222',
    name: 'Used Account',
    isLoggedIn: true,
    totalOrdersCount: 5,
    cachedTotalOrdersCount: 5,
    ordersVerifiedLive: true,
    cookies: '_session_tid=fake_session; token=fake_token;',
    token: 'fake_token'
  };

  const usedProfile = await inspectAccountOrderHistoryAndOffers(usedAcc);
  ok(usedProfile.totalOrdersCount === 5, 'Accurately returns 5 orders for used account');
  ok(usedProfile.isZeroOrderAccount === false, 'isZeroOrderAccount is false for used account');

  // Test 3: Logged out / dead account provides proper diagnostic reason & error
  const deadAcc = {
    id: 'acc_9998883333',
    phone: '9998883333',
    isLoggedIn: false
  };

  const deadProfile = await inspectAccountOrderHistoryAndOffers(deadAcc);
  ok(deadProfile.valid === false, 'Dead account returns valid === false');
  ok(deadProfile.reason === 'NOT_LOGGED_IN', 'Dead account returns NOT_LOGGED_IN reason');
  ok(Boolean(deadProfile.error), 'Dead account includes descriptive diagnostic error');

  console.log('\n--- 2. Vault Intake Order History Check & Error Capture ---');

  let orderProfileCallArgs = null;
  const mockOrderProfileFn = async (accKey, accObj) => {
    orderProfileCallArgs = { accKey, accObj };
    if (accObj.phone === '9111111111') {
      return { valid: true, totalOrdersCount: 0, isZeroOrderAccount: true, ordersVerifiedLive: true };
    }
    if (accObj.phone === '9222222222') {
      return { valid: true, totalOrdersCount: 3, isZeroOrderAccount: false, ordersVerifiedLive: true };
    }
    return { valid: false, reason: 'SESSION_EXPIRED', error: 'Swiggy session expired' };
  };

  const sampleJson = JSON.stringify([
    {
      account: 'acc_9111111111',
      phone: '9111111111',
      name: 'Zero Order User',
      token: 'tok_live_1',
      _session_tid: 'tid_live_1',
      cookies: '_session_tid=tid_live_1; token=tok_live_1;'
    },
    {
      account: 'acc_9222222222',
      phone: '9222222222',
      name: 'Used 3-Orders User',
      token: 'tok_live_2',
      _session_tid: 'tid_live_2',
      cookies: '_session_tid=tid_live_2; token=tok_live_2;'
    }
  ]);

  const intakeRes = await ingestAndPersistRawAccountTexts({
    rawTexts: [sampleJson],
    verifyFn: async (payload) => ({ valid: true, phone: payload.phone }),
    orderProfileFn: mockOrderProfileFn,
    claimOffersFn: async () => ({ success: true }),
    syncVaultFn: async () => {}
  });

  ok(orderProfileCallArgs !== null, 'orderProfileFn was called during intake');
  ok(typeof orderProfileCallArgs.accKey === 'string', 'First argument to orderProfileFn is account key string');
  ok(typeof orderProfileCallArgs.accObj === 'object' && orderProfileCallArgs.accObj !== null, 'Second argument to orderProfileFn is account object');
  ok(intakeRes.savedAccounts.length === 2, '2 accounts saved in intake');
  ok(intakeRes.zeroOrderCount === 1, 'Correctly identified 1 Zero-Order account');
  ok(intakeRes.usedAccountCount === 1, 'Correctly identified 1 Used account');

  console.log('\n--- 3. ID Assignment & Account Selection ---');

  const testDb = getDb();
  testDb.orders = testDb.orders || {};
  testDb.drafts = testDb.drafts || {};

  const testOrderId = 'V37_ASSIGN_TEST';
  testDb.orders[testOrderId] = {
    id: testOrderId,
    userId: 888777666,
    userChatId: 888777666,
    status: 'PENDING',
    cart: 'https://swig.gy/gc/216642/Test-12345',
    address: 'Ground, 102, Hazratganj, Lucknow',
    selectedAccount: null,
    orderAccount: null
  };
  testDb.drafts[888777666] = {
    activeOrderId: testOrderId
  };
  saveDb(testDb);

  // Simulate active pending order linking when account is chosen
  const chosenKey = 'acc_9111111111';
  testDb.config.accounts[chosenKey] = {
    id: chosenKey,
    phone: '9111111111',
    name: 'Zero Order User',
    isLoggedIn: true,
    totalOrdersCount: 0,
    cookies: '_session_tid=tid_live_1; token=tok_live_1;'
  };

  const draft = testDb.drafts[888777666];
  const pendingId = draft?.activeOrderId;
  const ord = testDb.orders[pendingId];
  ord.selectedAccount = chosenKey;
  ord.orderAccount = testDb.config.accounts[chosenKey].phone;
  saveDb(testDb);

  const updatedOrder = lookupOrder(getDb(), testOrderId);
  ok(updatedOrder.selectedAccount === 'acc_9111111111', 'ID assigned to pending order');
  ok(updatedOrder.orderAccount === '9111111111', 'Order account phone assigned');

  console.log('\n--- 4. ID Issues & Diagnostic Messages ---');

  // Verify that when an account has an error, formatUserOrderCard renders diagnostic message
  updatedOrder.lastAccountError = 'Swiggy session expired — re-login needed';
  const cardWithErr = formatUserOrderCard(updatedOrder);
  ok(cardWithErr.text.includes('⚠️ <b>Dikkat:</b>'), 'Card exposes warning block when ID error exists');
  ok(cardWithErr.text.includes('Swiggy session expired'), 'Card displays exact diagnostic error text to user');

  // Verify boss view of formatUserOrderCardText
  const bossText = formatUserOrderCardText(updatedOrder, true);
  ok(bossText.includes('Order Account:'), 'Boss card shows Order Account');
  ok(bossText.includes('9111111111'), 'Boss card shows selected account phone');

  console.log('\n================================================================');
  console.log(`🏆 ALL ${passed} CHECKS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');

} finally {
  try {
    const curDb = JSON.parse(fs.readFileSync('./data/db.json', 'utf8'));
    for (const k of ['acc_9111111111', 'acc_9222222222']) {
      delete curDb.config?.accounts?.[k];
      delete curDb.sessionVault?.[k];
      delete curDb.config?.deletedAccounts?.[k];
    }
    delete curDb.config?.deletedAccounts?.['9111111111'];
    delete curDb.config?.deletedAccounts?.['9222222222'];
    delete curDb.orders?.['V37_ASSIGN_TEST'];
    delete curDb.drafts?.['888777666'];
    fs.writeFileSync('./data/db.json', JSON.stringify(curDb, null, 2), 'utf8');
  } catch {}
}
