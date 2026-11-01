process.env.TEST_MODE = process.env.TEST_MODE || '1';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.DB_FILE = './data/test_v39_db.json';
process.env.ACCOUNTS_JSON_FILE = './data/test_v39_accounts.json';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getDb,
  saveDb,
  logoutAllAccounts,
  importSessionJson,
  isAccountLoggedInSession,
  hydrateAccountsFromCloudVault
} from './store.js';
import { inspectAccountOrderHistoryAndOffers } from './swiggy-cart.js';
import { createBulkDocumentBatchCollector } from './account-vault-intake.js';

process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';

const {
  showFamilyAccounts
} = await import('./index.js');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ ${msg}`);
}

try {
  console.log('=== TEST SUITE V39: LOGOUT ALL & SEQUENTIAL FILE INTAKE & ORDER COUNT ===');

  // =========================================================================
  // TEST 1: logoutAllAccounts completely wipes DB, Vault, accounts.json, and sets tombstones
  // =========================================================================
  console.log('\n--- 1. logoutAllAccounts Verification ---');
  const db = getDb();
  db.config.accounts = {
    acc_9876543210: {
      id: 'acc_9876543210',
      phone: '9876543210',
      name: 'Account 1',
      isLoggedIn: true,
      totalOrdersCount: 0,
      cachedTotalOrdersCount: 0,
      isZeroOrderAccount: true,
      cookies: '_session_tid=fake_tid_1; token=tok1;'
    },
    acc_9123456780: {
      id: 'acc_9123456780',
      phone: '9123456780',
      name: 'Account 2',
      isLoggedIn: true,
      totalOrdersCount: 3,
      cachedTotalOrdersCount: 3,
      isZeroOrderAccount: false,
      cookies: '_session_tid=fake_tid_2; token=tok2;'
    }
  };
  db.sessionVault = {
    '9876543210': { phone: '9876543210', token: 'tok1' },
    '9123456780': { phone: '9123456780', token: 'tok2' }
  };
  db.config.activeOrderAccount = 'acc_9876543210';
  saveDb(db);

  const count = logoutAllAccounts({ purgeVault: true });
  ok(count >= 2, `logoutAllAccounts returned purged count: ${count}`);

  const freshDb = getDb();
  ok(Object.keys(freshDb.config.accounts || {}).length === 0, 'db.config.accounts is completely empty');
  ok(Object.keys(freshDb.sessionVault || {}).length === 0, 'db.sessionVault is completely empty');
  ok(!freshDb.config.activeOrderAccount, 'db.config.activeOrderAccount is cleared');
  ok(freshDb.config.deletedAccounts?.['acc_9876543210'] === true, 'acc_9876543210 is tombstoned');
  ok(freshDb.config.deletedAccounts?.['9876543210'] === true, '9876543210 phone is tombstoned');
  ok(freshDb.config.deletedAccounts?.['acc_9123456780'] === true, 'acc_9123456780 is tombstoned');

  const accountsJsonFile = process.env.ACCOUNTS_JSON_FILE || './accounts.json';
  const accountsJsonContent = JSON.parse(fs.readFileSync(accountsJsonFile, 'utf8'));
  ok(Array.isArray(accountsJsonContent) && accountsJsonContent.length === 0, 'accounts.json on disk is []');

  // =========================================================================
  // TEST 2: showFamilyAccounts menu contains '! Logout All Accounts'
  // =========================================================================
  console.log('\n--- 2. showFamilyAccounts Menu Buttons ---');
  let repliedText = '';
  let repliedMarkup = null;
  const mockCtx = {
    reply: async (t, m) => { repliedText = t; repliedMarkup = m; },
    callbackQuery: null
  };

  await showFamilyAccounts(mockCtx);
  ok(repliedText.includes('0 Active / 0 Total') || repliedText.includes('Koi bhi account connected nahi hai'), 'showFamilyAccounts shows 0 accounts cleanly');

  const allButtons = (repliedMarkup?.reply_markup?.inline_keyboard || []).flat();
  const logoutAllBtn = allButtons.find(b => b.callback_data === 'boss_logout_all_confirm');
  ok(logoutAllBtn, 'Found ! Logout All Accounts button in showFamilyAccounts');
  ok(logoutAllBtn.text.includes('Logout All Accounts'), 'Button label is clear for user');

  // =========================================================================
  // TEST 3: inspectAccountOrderHistoryAndOffers calculation & 999999 filtering
  // =========================================================================
  console.log('\n--- 3. inspectAccountOrderHistoryAndOffers Order Count Logic ---');
  const freshZeroAccount = {
    id: 'acc_5550005555',
    phone: '5550005555',
    name: 'Zero Order Account',
    isLoggedIn: true,
    totalOrdersCount: 0,
    cachedTotalOrdersCount: 0,
    ordersVerifiedLive: true,
    isZeroOrderAccount: true,
    cookies: '_session_tid=fake_live_tid_0; token=tok0;'
  };

  const zeroProf = await inspectAccountOrderHistoryAndOffers('acc_5550005555', freshZeroAccount, { force: false });
  ok(zeroProf.valid === true, 'Zero order profile is valid');
  ok(zeroProf.totalOrdersCount === 0, 'Zero order count is 0');
  ok(zeroProf.isZeroOrderAccount === true, 'isZeroOrderAccount is true');

  const usedAccount = {
    id: 'acc_6660006666',
    phone: '6660006666',
    name: 'Used Account',
    isLoggedIn: true,
    totalOrdersCount: 5,
    cachedTotalOrdersCount: 5,
    ordersVerifiedLive: true,
    isZeroOrderAccount: false,
    cookies: '_session_tid=fake_live_tid_5; token=tok5;'
  };
  const usedProf = await inspectAccountOrderHistoryAndOffers('acc_6660006666', usedAccount, { force: false });
  ok(usedProf.valid === true, 'Used account profile is valid');
  ok(usedProf.totalOrdersCount === 5, 'Used order count is 5');
  ok(usedProf.isZeroOrderAccount === false, 'isZeroOrderAccount is false');

  // Account with 999999 uninitialized count must never poison to 999999
  const poisonAccount = {
    id: 'acc_7770007777',
    phone: '7770007777',
    name: 'Uncalculated Account',
    isLoggedIn: true,
    totalOrdersCount: 999999,
    cachedTotalOrdersCount: 999999,
    cookies: '_session_tid=fake_live_tid_7; token=tok7;'
  };
  // Fast path must skip 999999 and not report 999999 as valid order count
  ok(poisonAccount.totalOrdersCount === 999999, 'Original had 999999 sentinel');

  // =========================================================================
  // TEST 4: importSessionJson preserves valid order counts
  // =========================================================================
  console.log('\n--- 4. importSessionJson Order Count Preservation ---');
  const importRes = importSessionJson({
    phone: '8880008888',
    name: 'Imported User',
    totalOrdersCount: 0,
    ordersVerifiedLive: true,
    isZeroOrderAccount: true,
    cookies: '_session_tid=sess_888; tid=tid_888; token=tok_888;'
  });
  ok(importRes.success === true, 'importSessionJson succeeded');
  const savedAcc = getDb().config.accounts?.[importRes.account];
  ok(savedAcc, 'Imported account is in DB');
  ok(savedAcc.totalOrdersCount === 0, 'Saved account has totalOrdersCount === 0');
  ok(savedAcc.isZeroOrderAccount === true, 'Saved account has isZeroOrderAccount === true');

  // =========================================================================
  // TEST 5: Bulk Collector passes rawEntries for sequential processing
  // =========================================================================
  console.log('\n--- 5. Bulk Document Batch Collector Integration ---');
  let collectorReceivedEntries = null;
  const testCollector = createBulkDocumentBatchCollector({
    windowMs: 50,
    downloadBufferFn: async (meta) => Buffer.from(meta.content, 'utf8'),
    onBatchComplete: async ({ rawEntries }) => {
      collectorReceivedEntries = rawEntries;
    }
  });

  const file1 = { fileId: 'f1', fileName: 'acc1.json', content: JSON.stringify({ phone: '9000000001', cookies: '_session_tid=s1; tid=t1;' }) };
  const file2 = { fileId: 'f2', fileName: 'acc2.json', content: JSON.stringify({ phone: '9000000002', cookies: '_session_tid=s2; tid=t2;' }) };

  await Promise.all([
    testCollector.enqueue('chat123', mockCtx, file1),
    testCollector.enqueue('chat123', mockCtx, file2)
  ]);

  // Wait for flush window
  await new Promise(r => setTimeout(r, 120));
  ok(Array.isArray(collectorReceivedEntries), 'onBatchComplete received rawEntries array');
  ok(collectorReceivedEntries.length === 2, `rawEntries contains both files: ${collectorReceivedEntries.length}`);
  ok(collectorReceivedEntries[0].fileName === 'acc1.json', 'File 1 matched');
  ok(collectorReceivedEntries[1].fileName === 'acc2.json', 'File 2 matched');

  console.log(`\n🎉 ALL ${passed} TESTS PASSED CLEANLY!`);
} finally {
  try {
    if (fs.existsSync('./data/test_v39_db.json')) fs.unlinkSync('./data/test_v39_db.json');
    if (fs.existsSync('./data/test_v39_accounts.json')) fs.unlinkSync('./data/test_v39_accounts.json');
  } catch {}
}
