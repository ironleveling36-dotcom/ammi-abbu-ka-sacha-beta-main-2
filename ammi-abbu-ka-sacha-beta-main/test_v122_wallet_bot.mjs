// Offline Telegram/UPI simulations only. No payment provider or Swiggy order is contacted.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-bot-test-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-test-token', BOSS_ID: '9001', TEST_MODE: '1', NODE_ENV: 'test',
  SIMPLE_CHAT_MODE: '1', DB_ASYNC_WRITE: '0', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '1'
});
delete process.env.UPI_UTR_LOOKUP_URL;
delete process.env.UPI_UTR_VERIFY_URL;
delete process.env.GITHUB_VAULT_TOKEN;

const { bot } = await import('./index.js');
const { setChannelGateMock } = await import('./channel-gate.js');
const { getDb, saveDb } = await import('./store.js');
const { creditWallet, walletBalancePaise } = await import('./user-wallet.js');
const { submitBotWalletTopup, retryPendingTopupNotifications } = await import('./wallet-topup-service.js');
const { parseUtrLookup } = await import('./utr-lookup.js');
const { evaluateUtrCredit } = await import('./upi-credit-policy.js');
setChannelGateMock(true);
const initial = getDb(); initial.config.bossIds = ['9001', '9002']; initial.config.bossUpiId = 'legacy@okbank'; delete initial.config.walletUpiId; saveDb(initial);
const calls = [];
let failBoss = true, updateId = 0;
const fakeCallApi = async (method, payload = {}) => {
  if (method === 'sendMessage' && String(payload.chat_id) === '9002' && failBoss) throw new Error('offline Telegram error');
  calls.push({ method, payload });
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  if (['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto'].includes(method)) {
    return { message_id: payload.message_id || calls.length, chat: { id: payload.chat_id }, text: payload.text || payload.caption || '' };
  }
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;
const pause = () => new Promise((resolve) => setTimeout(resolve, 90));
async function tap(userId, data) {
  const from = { id: userId, is_bot: false, first_name: 'Demo', language_code: 'en' };
  await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), from, chat_instance: '1', data,
    message: { message_id: 1, date: Math.floor(Date.now()/1000), chat: { id: userId, type: 'private' }, text: 'x' } } });
  await pause();
}
async function send(userId, text) {
  const from = { id: userId, is_bot: false, first_name: 'Demo', language_code: 'en' };
  await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now()/1000),
    chat: { id: userId, type: 'private', first_name: 'Demo' }, from, text } });
  await pause();
}
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('bot wallet, no-provider recharge, pending admin delivery/retry and actual-amount approval', async () => {
  const user = 8301;
  await send(user, '/start');
  assert.ok(calls.some(c => JSON.stringify(c.payload.reply_markup || {}).includes('wallet_home')), 'home contains Wallet button');
  await tap(user, 'wallet_home');
  await tap(user, 'wallet_topup');
  await tap(user, 'wallet_topup_amt_1500');
  assert.ok(calls.some(c => String(c.payload.text || '').includes('mius@ybl')));
  await tap(user, 'wallet_utr_1500');
  await send(user, '654321987001');
  const pending = Object.values(getDb().config.topupRequests).find(r => r.utr === '654321987001');
  assert.equal(pending?.status, 'PENDING');
  assert.equal(walletBalancePaise(getDb(), user), 0, 'unverified UTR never credits');
  assert.equal(calls.filter(c => String(c.payload.chat_id) === '9001' && String(c.payload.text).includes(pending.utr)).length, 1);
  assert.ok(calls.some(c => String(c.payload.text || '').includes('pending')));
  failBoss = false;
  await retryPendingTopupNotifications(bot.telegram);
  await retryPendingTopupNotifications(bot.telegram);
  assert.equal(calls.filter(c => String(c.payload.chat_id) === '9001' && String(c.payload.text).includes(pending.utr)).length, 1, 'already notified admin is not spammed');
  assert.equal(calls.filter(c => String(c.payload.chat_id) === '9002' && String(c.payload.text).includes(pending.utr)).length, 1, 'failed notice retried');
  await tap(9001, `boss_utr_amount_${pending.id}`);
  await send(9001, '12.50');
  assert.equal(walletBalancePaise(getDb(), user), 1250, 'only actual amount approved by admin is credited');
  assert.equal(getDb().config.usedUtrs[pending.utr].status, 'CREDITED');
  await tap(9001, `boss_utr_ok_${pending.id}`);
  assert.equal(walletBalancePaise(getDb(), user), 1250, 'approval cannot be repeated');
});

test('custom recharge above ₹500 can still submit a pending UTR', async () => {
  const user = 8305;
  await tap(user, 'wallet_topup_custom');
  await send(user, '1000');
  assert.ok(calls.some(c => JSON.stringify(c.payload.reply_markup || {}).includes('wallet_utr_100000')));
  await tap(user, 'wallet_utr_100000');
  await send(user, '654321987005');
  assert.equal(Object.values(getDb().config.topupRequests).find(r => r.utr === '654321987005')?.status, 'PENDING');
  assert.equal(walletBalancePaise(getDb(), user), 0);
});

test('provider evidence must contain matching UTR, real success and positive amount', () => {
  const utr = '123456789012';
  assert.equal(parseUtrLookup({ amount: 15, status: 'SUCCESS', payeeName: 'MISBAHUL ISLAM' }, { expectUtr: utr }).found, false);
  assert.equal(parseUtrLookup({ utr, amount: '-15', status: 'SUCCESS' }, { expectUtr: utr }).found, false);
  assert.equal(parseUtrLookup({ utr, amountPaise: 1500.5, status: 'SUCCESS' }, { expectUtr: utr }).found, false);
  const failed = parseUtrLookup({ utr, amount: 15, verified: true, status: 'FAILED', payeeName: 'MISBAHUL ISLAM' }, { expectUtr: utr });
  assert.equal(failed.payment.status, 'FAILED');
  const absent = parseUtrLookup({ utr, amount: 15, verified: true, payeeName: 'MISBAHUL ISLAM' }, { expectUtr: utr });
  assert.equal(evaluateUtrCredit({ claim: { utr }, payment: absent.payment }).action, 'PENDING');
  assert.equal(evaluateUtrCredit({ claim: { utr }, payment: { ...absent.payment, status: 'UNSUCCESSFUL' } }).action, 'PENDING');
});

test('configured wallet VPA is recognised and a contradictory VPA cannot hide behind a matching name', async () => {
  const db = getDb(); db.config.walletUpiId = 'family@okbank'; saveDb(db);
  await tap(8303, 'wallet_topup_amt_1500');
  assert.ok(calls.some(c => String(c.payload.text || '').includes('family@okbank')), 'bot shows configured wallet VPA');
  process.env.UPI_UTR_LOOKUP_URL = 'https://offline-provider.invalid/lookup';
  const good = '654321987003';
  const fetchImpl = async (_url, options) => {
    const requested = JSON.parse(options.body).utr;
    return { ok: true, status: 200, json: async () => ({
      utr: requested, amount: 15,
      payeeVpa: requested === good ? 'family@okbank' : 'someoneelse@okbank',
      payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS'
    }) };
  };
  const accepted = await submitBotWalletTopup({ userId: 8303, utr: good, amountPaise: 1500, minPaise: 100, fetchImpl });
  assert.equal(accepted.code, 'AUTO_VERIFIED');
  assert.equal(walletBalancePaise(getDb(), '8303'), 1500);
  const rejected = await submitBotWalletTopup({ userId: 8304, utr: '654321987004', amountPaise: 1500, minPaise: 100, fetchImpl });
  assert.notEqual(rejected.code, 'AUTO_VERIFIED');
  assert.equal(walletBalancePaise(getDb(), '8304'), 0);
  delete process.env.UPI_UTR_LOOKUP_URL;
});

test('slow UTR lookup applies against a fresh wallet rather than losing another credit', async () => {
  const utr = '654321987002', user = 8302;
  process.env.UPI_UTR_LOOKUP_URL = 'https://offline-provider.invalid/lookup';
  let resolveLookup;
  const fetchImpl = () => new Promise(resolve => { resolveLookup = resolve; });
  const claim = submitBotWalletTopup({ userId: user, utr, amountPaise: 1500, minPaise: 100, fetchImpl });
  const db = getDb(); creditWallet(db, user, 1000, { actor: 'test' }); saveDb(db);
  resolveLookup({ ok: true, status: 200, json: async () => ({ utr, amount: 15, payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS' }) });
  const out = await claim;
  assert.equal(out.code, 'AUTO_VERIFIED');
  assert.equal(walletBalancePaise(getDb(), user), 2500);
  delete process.env.UPI_UTR_LOOKUP_URL;
});
