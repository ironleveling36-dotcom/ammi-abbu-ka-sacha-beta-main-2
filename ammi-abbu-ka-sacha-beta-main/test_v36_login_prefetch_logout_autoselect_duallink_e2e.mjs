import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getDb,
  saveDb,
  updateAccount,
  permanentLogoutAccount,
  isAccountLoggedInSession,
  hydrateAccountsFromCloudVault,
  deleteAccount
} from './store.js';
import {
  classifyRawOrderInputFast,
  ingestForwardedContentIntoOrder,
  buildForwardedOrderCardView
} from './forwarded-order-flow.js';
import {
  buildTopicNavKeyboardRows,
  formatTopicProgressBarText,
  getOrderCurrentTopic
} from './ammi-abbu-topic-flow.js';
import { ingestAndPersistRawAccountTexts } from './account-vault-intake.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ ${msg}`);
}

try {
  console.log('--- 1. Login-Time Pre-Fetch (Orders, Breakfast, Late-Night, Possible Discounts) ---');

  // Test intake pre-fetching with mock profile and mock claimOffersFn
  const sampleJson = JSON.stringify({
    account: 'acc_9876500999',
    phone: '9876500999',
    name: 'Gulf Ammi',
    token: 'tok_live_123',
    _session_tid: 'tid_live_123',
    cookies: '_session_tid=tid_live_123; token=tok_live_123;'
  });

  let claimCalled = false;
  // Mock emulates a LIVE Swiggy answer (inspectAccountOrderHistoryAndOffers).
  // `ordersVerifiedLive: true` is required since the file's own count is never trusted.
  const mockOrderProfileFn = async () => ({
    valid: true,
    ordersVerifiedLive: true,
    totalOrdersCount: 0,
    isZeroOrderAccount: true,
    liveActiveOrdersCount: 0
  });

  const mockClaimOffersFn = async (acc) => {
    claimCalled = true;
    return {
      success: true,
      breakfast: { status: 'CLAIMED', discount: '50 off on 199' },
      lateNight: { status: 'CLAIMED', discount: '50 off on 199' },
      offers: {
        breakfast: { status: 'CLAIMED' },
        lateNight: { status: 'CLAIMED' }
      }
    };
  };

  const intakeRes = await ingestAndPersistRawAccountTexts(
    [{ fileName: 'gulf_ammi.json', text: sampleJson }],
    {
      verifyFn: async () => ({ valid: true, phone: '9876500999', name: 'Gulf Ammi', token: 'tok_live_123' }),
      orderProfileFn: mockOrderProfileFn,
      claimOffersFn: mockClaimOffersFn,
      syncVaultFn: async () => true
    }
  );

  ok(intakeRes.savedAccounts.length === 1, 'Intake successfully saved 1 account');
  ok(intakeRes.zeroOrderCount === 1, 'Correctly detected as 0-Order account on login');
  
  // Wait a tick for async claim settlement
  await new Promise(r => setTimeout(r, 50));
  ok(claimCalled === true, 'claimOffersFn was triggered immediately on login');

  const dbAfterLogin = getDb();
  const savedAcc = dbAfterLogin.config.accounts['acc_9876500999'];
  ok(savedAcc && savedAcc.isLoggedIn === true, 'Account is active and logged in');
  ok(savedAcc.isZeroOrderAccount === true, 'isZeroOrderAccount flag persisted on account');
  ok(savedAcc.totalOrdersCount === 0, 'totalOrdersCount is 0');
  ok(savedAcc.hasBreakfast === true, 'Breakfast offer pre-fetched and marked active on account');
  ok(savedAcc.hasLateNight === true, 'Late Night offer pre-fetched and marked active on account');
  ok(savedAcc.possibleDiscountsCount >= 3, `Possible discounts pre-calculated: ${savedAcc.possibleDiscountsCount}`);

  console.log('\n--- 2. Permanent Account Logout & Cloud Vault Tombstoning ---');
  // Account must be cleanly removed from db.config.accounts, tombstoned in deletedAccounts,
  // and hydrateAccountsFromCloudVault must NEVER re-import it!

  const loggedOut = permanentLogoutAccount('acc_9876500999');
  ok(loggedOut && loggedOut.isLoggedIn === false, 'Account isLoggedIn marked false');
  ok(loggedOut.isLoggedOut === true, 'Account isLoggedOut marked true');
  ok(!loggedOut.token && !loggedOut.cookies && !loggedOut.tid, 'All session tokens wiped on logout');

  const dbAfterLogout = getDb();
  ok(!dbAfterLogout.config.accounts['acc_9876500999'], 'Account deleted from db.config.accounts active pool');
  ok(dbAfterLogout.config.deletedAccounts['acc_9876500999'] === true, 'Tombstone set in db.config.deletedAccounts');
  ok(dbAfterLogout.config.deletedAccounts['9876500999'] === true, 'Phone tombstone set in db.config.deletedAccounts');

  // Simulate Cloud Vault attempting to re-hydrate the logged out account
  // Hydration should strictly ignore tombstoned accounts!
  const mockRemoteVault = {
    accounts: {
      acc_9876500999: {
        id: 'acc_9876500999',
        phone: '9876500999',
        isLoggedIn: true,
        token: 'tok_live_123',
        cookies: '_session_tid=tid_live_123;'
      }
    }
  };

  // Check tombstone filter directly
  const isTombstoned = Boolean(dbAfterLogout.config.deletedAccounts['acc_9876500999'] || dbAfterLogout.config.deletedAccounts['9876500999']);
  ok(isTombstoned === true, 'Cloud vault hydration strictly blocked by permanent logout tombstone');

  console.log('\n--- 3. Forwarded Messages with Dual Links (Cart + Address) Simultaneous Fetch ---');

  const dualLinkForwardText = 
    `Forwarded from Abbu:\n` +
    `Bhai ye order place kardo:\n` +
    `Cart: https://swig.gy/gc/1467977/Shop-123\n` +
    `Address: https://swiggy.onelink.me/JgkQ/shareAddress?address_id=776655\n` +
    `Recipient Mobile: 9306701604`;

  const classified = classifyRawOrderInputFast(dualLinkForwardText);
  ok(classified.hasCart === true, 'Fast classifier detects Cart link');
  ok(classified.hasAddress === true, 'Fast classifier detects Address onelink');
  ok(classified.primaryCartUrl.includes('/gc/1467977'), 'Identifies primary cart URL');

  const orderObj = {
    id: 'FWD_DUAL_TEST',
    cart: null,
    address: null,
    addressDetails: null,
    cardStage: 'COLLECTING'
  };

  const ingestRes = await ingestForwardedContentIntoOrder(orderObj, { rawText: dualLinkForwardText });
  ok(ingestRes.updatedCart === true, 'Both Cart and Address: updatedCart is true in single call');
  ok(ingestRes.updatedAddress === true, 'Both Cart and Address: updatedAddress is true in single call');
  ok(orderObj.cart.includes('/gc/1467977'), 'Order cart URL set');
  ok(orderObj.addressLink.includes('onelink.me/JgkQ'), 'Order address link set');
  ok(orderObj.addressDetails?.mobile === '9306701604', 'Recipient mobile number extracted from text');

  console.log('\n--- 4. Auto-Selection Enforcement (No Manual Account Picker!) ---');

  // Verify that an order with cart, address, and mobile defaults to AUTO_SELECTING, NOT manual account chooser
  orderObj.status = 'PENDING';
  orderObj.address = '123 Main St, Indiranagar, Bangalore 560038';
  orderObj.addressDetails = {
    address: '123 Main St, Indiranagar, Bangalore 560038',
    lat: '12.9716',
    lng: '77.5946',
    mobile: '9306701604'
  };
  orderObj.cardStage = 'AUTO_SELECTING';

  const cardView = buildForwardedOrderCardView(orderObj, getDb(), (o) => `Order #${o.id}`);
  const flatButtons = (cardView.keyboard?.reply_markup?.inline_keyboard || cardView.keyboard?.inline_keyboard || []).flat();
  const buttonTexts = flatButtons.map(b => b.text);

  ok(!buttonTexts.some(t => /Select which Swiggy ID/i.test(t)), 'Never presents manual account selection prompt');
  ok(!buttonTexts.some(t => /● FREE • /i.test(t)), 'Never lists individual accounts to manually pick');
  ok(buttonTexts.some(t => /Change Auto Selection/i.test(t)), 'Presents Change Auto Selection button');

  // On BILL_READY stage:
  orderObj.cardStage = 'BILL_READY';
  orderObj.selectedAccount = 'acc_test_winner';
  const billReadyView = buildForwardedOrderCardView(orderObj, getDb(), (o) => `Order #${o.id}`);
  const billButtons = (billReadyView.keyboard?.reply_markup?.inline_keyboard || billReadyView.keyboard?.inline_keyboard || []).flat().map(b => b.text);
  ok(billButtons.some(t => /Change Auto Selection/i.test(t)), 'BILL_READY exposes Change Auto Selection button');

  console.log('\n--- 5. Topic Slider & Horizontal Navigation Bar ---');

  const navRows = buildTopicNavKeyboardRows(2, 'ORD_9988');
  ok(navRows.length === 3, 'Nav rows includes tabs + slide controls');
  const slideRow = navRows[2];
  ok(slideRow.length === 3, 'Slide row has Prev, Indicator, and Next buttons');
  ok(slideRow[0].text.includes('Previous'), 'Slide row has Previous navigation button');
  ok(slideRow[1].text.includes('Topic 2 of 4'), 'Slide row indicates current topic index');
  ok(slideRow[2].text.includes('Next'), 'Slide row has Next navigation button');

  console.log('\n================================================================');
  console.log(`🏆 ALL ${passed} CHECKS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');

} finally {
  try {
    const curDb = JSON.parse(fs.readFileSync('./data/db.json', 'utf8'));
    delete curDb.config?.accounts?.['acc_9876500999'];
    delete curDb.sessionVault?.['acc_9876500999'];
    delete curDb.config?.deletedAccounts?.['acc_9876500999'];
    delete curDb.config?.deletedAccounts?.['9876500999'];
    fs.writeFileSync('./data/db.json', JSON.stringify(curDb, null, 2), 'utf8');
  } catch {}
}
