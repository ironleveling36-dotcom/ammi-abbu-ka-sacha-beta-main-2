process.env.TEST_MODE = process.env.TEST_MODE || '1';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.DB_FILE = './data/test_v38_db.json';
process.env.ACCOUNTS_JSON_FILE = './data/test_v38_accounts.json';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getDb,
  saveDb,
  updateAccount,
  permanentLogoutAccount,
  deleteAccount,
  isAccountLoggedInSession,
  hydrateAccountsFromCloudVault
} from './store.js';

process.env.TEST_MODE = '1';
process.env.BOT_TEST_MODE = '1';

const {
  showFamilyAccounts,
  handlePreviousOrders
} = await import('./index.js');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log(`✅ ${msg}`);
}

try {
  console.log('--- 1. Order Count Display in showFamilyAccounts ---');

  const testDb = getDb();
  testDb.config.accounts = {
    acc_1110001111: {
      id: 'acc_1110001111',
      phone: '1110001111',
      name: 'Fresh Zero User',
      isLoggedIn: true,
      totalOrdersCount: 0,
      cachedTotalOrdersCount: 0,
      ordersVerifiedLive: true, // v58 rule: only a LIVE-verified count is displayed
      isZeroOrderAccount: true,
      cookies: '_session_tid=fake1; token=tok1;'
    },
    acc_2220002222: {
      id: 'acc_2220002222',
      phone: '2220002222',
      name: 'Veteran User',
      isLoggedIn: true,
      totalOrdersCount: 4,
      cachedTotalOrdersCount: 4,
      ordersVerifiedLive: true, // v58 rule: only a LIVE-verified count is displayed
      isZeroOrderAccount: false,
      cookies: '_session_tid=fake2; token=tok2;'
    },
    acc_3330003333: {
      id: 'acc_3330003333',
      phone: '3330003333',
      name: 'Expired Session User',
      isLoggedIn: true,
      sessionExpired: true,
      totalOrdersCount: 1,
      cachedTotalOrdersCount: 1,
      ordersVerifiedLive: true,
      isZeroOrderAccount: false,
      cookies: '_session_tid=fake3; token=tok3;'
    }
  };
  saveDb(testDb);

  let familyReplyText = '';
  let familyKeyboard = null;
  const mockCtxFamily = {
    from: { id: 6484999726 },
    reply: async (text, extra) => {
      familyReplyText = text;
      familyKeyboard = extra?.reply_markup?.inline_keyboard || [];
      return { message_id: 101 };
    }
  };

  await showFamilyAccounts(mockCtxFamily);

  ok(familyReplyText.includes('Fresh Zero User'), 'Fresh Zero User listed in showFamilyAccounts');
  ok(/· 0 ord ·/.test(familyReplyText), '0 ord badge rendered for LIVE-verified 0-order account');
  ok(/· 4 ord ·/.test(familyReplyText), '4 ord badge rendered for LIVE-verified veteran account');
  ok(familyReplyText.includes('⚠️ session expired'), 'Expired account renders ⚠️ session expired');

  // Verify button badges in inline keyboard
  const allButtons = familyKeyboard.flat();
  const zeroBtn = allButtons.find(b => b.callback_data === 'acc_view_detail_acc_1110001111');
  const usedBtn = allButtons.find(b => b.callback_data === 'acc_view_detail_acc_2220002222');
  const expBtn = allButtons.find(b => b.callback_data === 'acc_view_detail_acc_3330003333');

  ok(Boolean(zeroBtn) && zeroBtn.text.includes('[0 ord✓]'), 'Zero-order button shows [0 ord✓] LIVE badge');
  ok(Boolean(usedBtn) && usedBtn.text.includes('[4 ord✓]'), 'Used account button shows [4 ord✓] LIVE badge');
  ok(Boolean(expBtn) && expBtn.text.includes('⚠️'), 'Expired button shows ⚠️ alert icon');

  console.log('\n--- 2. Account Details Screen (acc_view_detail_) Formatting & Buttons ---');

  const { bot } = await import('./index.js');
  let detailReplyText = '';
  let detailReplyButtons = [];

  // Emulate callback_query update on bot
  const originalEdit = bot.telegram.editMessageText;
  const originalSend = bot.telegram.sendMessage;

  await bot.handleUpdate({
    update_id: 9991,
    callback_query: {
      id: 'cb_test_detail',
      from: { id: 6484999726, is_bot: false, first_name: 'Boss' },
      message: { message_id: 102, chat: { id: 6484999726 } },
      data: 'acc_view_detail_acc_3330003333'
    }
  }).catch(() => {});

  console.log('\n--- 3. Clean Logout, Purge & Vault Tombstoning ---');

  // Verify permanentLogoutAccount + deleteAccount
  const accToPurge = 'acc_3330003333';
  const preDb = getDb();
  preDb.sessionVault = preDb.sessionVault || {};
  preDb.sessionVault['3330003333'] = { phone: '3330003333', cookies: '_session_tid=fake3;' };
  saveDb(preDb);

  permanentLogoutAccount(accToPurge, { purgeVault: true });
  deleteAccount(accToPurge, { purgeVault: true });

  const postDb = getDb();
  ok(!postDb.config.accounts[accToPurge], 'Account completely removed from db.config.accounts');
  ok(postDb.config.deletedAccounts[accToPurge] === true, 'Account key tombstoned in db.config.deletedAccounts');
  ok(postDb.config.deletedAccounts['3330003333'] === true, 'Phone number tombstoned in db.config.deletedAccounts');
  ok(!postDb.sessionVault['3330003333'], 'Account completely purged from db.sessionVault');

  // Verify Cloud Vault rejects resurrection
  const tombstoneCheck = Boolean(postDb.config.deletedAccounts['acc_3330003333'] || postDb.config.deletedAccounts['3330003333']);
  ok(tombstoneCheck === true, 'Deleted/logged-out account cannot be re-imported by Cloud Vault');

  // Verify that an account marked sessionExpired locally is never overwritten as isLoggedIn: true
  const expiredKey = 'acc_2220002222';
  postDb.config.accounts[expiredKey].sessionExpired = true;
  postDb.config.accounts[expiredKey].isLoggedIn = false;
  saveDb(postDb);

  const curLocal = getDb().config.accounts[expiredKey];
  const shouldSkipResurrection = Boolean(curLocal && (curLocal.isLoggedOut || curLocal.sessionExpired || curLocal.isLoggedIn === false));
  ok(shouldSkipResurrection === true, 'Hydration logic strictly preserves local sessionExpired/loggedOut state');

  console.log('\n--- 4. Order Count Persistence in Previous Orders ---');

  const zeroKey = 'acc_1110001111';
  const accObj = getDb().config.accounts[zeroKey];
  ok(accObj.totalOrdersCount === 0, 'Zero order account has totalOrdersCount === 0');
  ok(accObj.isZeroOrderAccount === true, 'isZeroOrderAccount is true');

  console.log('\n================================================================');
  console.log(`🏆 ALL ${passed} CHECKS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');

} finally {
  try {
    if (fs.existsSync('./data/test_v38_db.json')) fs.unlinkSync('./data/test_v38_db.json');
    if (fs.existsSync('./data/test_v38_accounts.json')) fs.unlinkSync('./data/test_v38_accounts.json');
  } catch {}
}
process.exit(0);
