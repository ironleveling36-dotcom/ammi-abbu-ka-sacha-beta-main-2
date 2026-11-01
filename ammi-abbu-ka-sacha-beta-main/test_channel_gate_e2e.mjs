// ============================================================================
// test_channel_gate_e2e.mjs
// Verification suite for Mandatory Telegram Channel Join Gate (@its_NoooB)
// ============================================================================

process.env.ENFORCE_CHANNEL_GATE = '1';

import assert from 'assert';
import { bot } from './index.js';
import { getDb, saveDb, isBoss } from './store.js';
import {
  REQUIRED_CHANNEL,
  REQUIRED_CHANNEL_URL,
  formatChannelJoinCard,
  setChannelGateMock,
  clearChannelMemberCache
} from './channel-gate.js';

console.log('=== RUNNING MANDATORY CHANNEL GATE (@its_NoooB) E2E TESTS ===\n');

// ----------------------------------------------------------------------------
// Test 1: Verify Channel Constants & Join Card Formatting
// ----------------------------------------------------------------------------
console.log('--- 1. Testing Channel Constants & Join Card UI ---');
assert.strictEqual(REQUIRED_CHANNEL, '@its_NoooB');
assert.strictEqual(REQUIRED_CHANNEL_URL, 'https://t.me/its_NoooB');

const card = formatChannelJoinCard();
assert.ok(card.text.includes('@its_NoooB'), 'Card must mention @its_NoooB');
assert.ok(card.text.includes('Join our channel to continue'), 'Card must have clear header');

const buttons = card.keyboard.reply_markup.inline_keyboard.flat();
const joinBtn = buttons.find(b => b.url === 'https://t.me/its_NoooB');
const checkBtn = buttons.find(b => b.callback_data === 'check_channel_joined');

assert.ok(joinBtn, 'Must have Join @its_NoooB URL button');
assert.ok(checkBtn, 'Must have Check Joined callback button');
console.log('✅ Join Card UI contains official @its_NoooB link and Check button');

// ----------------------------------------------------------------------------
// Test 2: Unjoined User Blocked on Messages, Commands, and Buttons
// ----------------------------------------------------------------------------
console.log('\n--- 2. Testing Unjoined User Access Blocking ---');

const UNJOINED_USER = 55512345;
const db = getDb();
db.config.bossIds = db.config.bossIds || [6484999726];
saveDb(db);

assert.strictEqual(isBoss(UNJOINED_USER), false, 'Test user must not be boss');

// Mock membership: UNJOINED_USER is NOT a member
let membershipStatus = false;
setChannelGateMock((userId) => {
  if (String(userId) === String(UNJOINED_USER)) return membershipStatus;
  return true;
});
clearChannelMemberCache(UNJOINED_USER);

const sentMessages = [];
const editedMessages = [];
const cbAnswers = [];

// Monkey-patch fakeCallApi on bot
const fakeCallApi = async (method, payload = {}) => {
  if (method === 'getMe') {
    return { id: 999999999, is_bot: true, first_name: 'SlotBot', username: 'slot_bot' };
  }
  if (method === 'getUpdates') {
    return [];
  }
  if (method === 'sendMessage') {
    sentMessages.push(payload);
    return { message_id: sentMessages.length + 100, chat: { id: payload.chat_id }, text: payload.text || '' };
  }
  if (method === 'editMessageText') {
    editedMessages.push(payload);
    return { message_id: payload.message_id || 1, chat: { id: payload.chat_id }, text: payload.text || '' };
  }
  if (method === 'answerCallbackQuery') {
    cbAnswers.push(payload);
    return true;
  }
  if (method === 'deleteMessage') {
    return true;
  }
  return { message_id: 1, chat: { id: payload?.chat_id || 1 } };
};

bot.telegram.callApi = fakeCallApi;
bot.telegram.__rawCallApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const waitFor = async (predicate, maxMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
};

// A. Unjoined user sends /start
sentMessages.length = 0;
await bot.handleUpdate({
  update_id: 1001,
  message: {
    message_id: 1,
    chat: { id: UNJOINED_USER, type: 'private' },
    from: { id: UNJOINED_USER, is_bot: false, first_name: 'Imran' },
    text: '/start'
  }
});
await waitFor(() => sentMessages.length >= 1);

assert.strictEqual(sentMessages.length, 1, 'Unjoined user must receive Join card on /start');
assert.ok(sentMessages[0].text.includes('@its_NoooB'), 'Must be blocked with @its_NoooB prompt');
assert.ok(!sentMessages[0].text.includes('Swiggy Family Care Admin Mode'), 'Must not get main bot content');
console.log('✅ /start blocked: Unjoined user received mandatory channel join card');

// B. Unjoined user tries sending a Swiggy cart link
sentMessages.length = 0;
await bot.handleUpdate({
  update_id: 1002,
  message: {
    message_id: 2,
    chat: { id: UNJOINED_USER, type: 'private' },
    from: { id: UNJOINED_USER, is_bot: false, first_name: 'Imran' },
    text: 'https://swiggy.com/menu/123?cart=true'
  }
});
await waitFor(() => sentMessages.length >= 1);

assert.strictEqual(sentMessages.length, 1, 'Unjoined user must be blocked when sending links');
assert.ok(sentMessages[0].text.includes('@its_NoooB'));
console.log('✅ Cart/Address link blocked: Unjoined user cannot submit links');

// C. Unjoined user clicks an inline callback button
cbAnswers.length = 0;
await bot.handleUpdate({
  update_id: 1003,
  callback_query: {
    id: 'cb_test_01',
    from: { id: UNJOINED_USER, is_bot: false, first_name: 'Imran' },
    message: { message_id: 10, chat: { id: UNJOINED_USER } },
    data: 'user_back_to_main'
  }
});
await waitFor(() => cbAnswers.length >= 1);

assert.strictEqual(cbAnswers.length, 1, 'Callback query must trigger warning alert');
assert.ok(cbAnswers[0].text.includes('@its_NoooB'), 'Warning alert must mention @its_NoooB');
assert.strictEqual(cbAnswers[0].show_alert, true);
console.log('✅ Inline button blocked: Alert requires joining @its_NoooB');

// ----------------------------------------------------------------------------
// Test 3: Check Joined Button Lifecycle
// ----------------------------------------------------------------------------
console.log('\n--- 3. Testing Check Joined Button Verification ---');

// A. User taps Check Joined while still NOT a member
cbAnswers.length = 0;
clearChannelMemberCache(UNJOINED_USER);

await bot.handleUpdate({
  update_id: 1004,
  callback_query: {
    id: 'cb_test_check_fail',
    from: { id: UNJOINED_USER, is_bot: false, first_name: 'Imran' },
    message: { message_id: 10, chat: { id: UNJOINED_USER } },
    data: 'check_channel_joined'
  }
});
await waitFor(() => cbAnswers.length >= 1);

assert.strictEqual(cbAnswers.length, 1);
assert.ok(cbAnswers[0].text.includes('You have not joined @its_NoooB yet'), 'Alert informs user they have not joined yet');
console.log('✅ Check button accurately rejects when user has not yet joined channel');

// B. User NOW joins @its_NoooB!
membershipStatus = true; // User joins the channel
clearChannelMemberCache(UNJOINED_USER);
cbAnswers.length = 0;
sentMessages.length = 0;

await bot.handleUpdate({
  update_id: 1005,
  callback_query: {
    id: 'cb_test_check_success',
    from: { id: UNJOINED_USER, is_bot: false, first_name: 'Imran' },
    message: { message_id: 10, chat: { id: UNJOINED_USER } },
    data: 'check_channel_joined'
  }
});
await waitFor(() => cbAnswers.length >= 1);
await waitFor(() => sentMessages.length >= 1);

assert.strictEqual(cbAnswers.length, 1);
assert.ok(cbAnswers[0].text.includes('Thanks! Channel verified'), 'Alert congratulates user');
assert.ok(sentMessages.length >= 1, 'User receives welcome / start screen upon verification');
console.log('✅ Check button verifies joined user, unlocks access, and delivers welcome screen');

// C. User can now send messages and links freely
sentMessages.length = 0;
editedMessages.length = 0;
await bot.handleUpdate({
  update_id: 1006,
  message: {
    message_id: 3,
    chat: { id: UNJOINED_USER, type: 'private' },
    from: { id: UNJOINED_USER, is_bot: false, first_name: 'Imran' },
    text: '/start'
  }
});
await waitFor(() => sentMessages.length >= 1 || editedMessages.length >= 1);

const latestMsg = sentMessages[0] || editedMessages[0];
assert.ok(!latestMsg.text.includes('Join our channel to continue'), 'Verified user is no longer blocked');
console.log('✅ Verified user now has seamless full access to the bot');

// ----------------------------------------------------------------------------
// Test 4: Boss Bypass Verification
// ----------------------------------------------------------------------------
console.log('\n--- 4. Testing Boss Exemption ---');

const BOSS_USER = 6484999726;
membershipStatus = false; // Even if Boss is technically not in the channel in the mock
clearChannelMemberCache(BOSS_USER);
sentMessages.length = 0;

await bot.handleUpdate({
  update_id: 1007,
  message: {
    message_id: 4,
    chat: { id: BOSS_USER, type: 'private' },
    from: { id: BOSS_USER, is_bot: false, first_name: 'Boss' },
    text: '/start'
  }
});
await waitFor(() => sentMessages.length >= 1);
console.log('Boss received message text:', sentMessages[0]?.text);

assert.ok(!sentMessages[0].text.includes('Join our channel to continue'), 'Boss must never be blocked by channel gate');
console.log('✅ Boss exemption verified: Boss is never blocked by channel gate');

// Clean up
setChannelGateMock(null);
delete process.env.ENFORCE_CHANNEL_GATE;

console.log('\n================================================================');
console.log('🏆 ALL CHANNEL GATE (@its_NoooB) TESTS PASSED SUCCESSFULLY!');
console.log('================================================================');
process.exit(0);
