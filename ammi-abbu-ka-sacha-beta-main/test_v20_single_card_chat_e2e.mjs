// ============================================================================
// v20 — One card per chat, links deleted after they are taken
// ----------------------------------------------------------------------------
// Ammi/Abbu were getting 3-4 bubbles per link. Required behaviour:
//   1. Customer pastes a cart/address link -> that message is deleted.
//   2. Stale "now paste the other link" prompts are deleted too.
//   3. ONE card stays in the chat: items + address + Send to Beta.
//   4. After Send to Beta the same card is edited (auto account + max offer).
//   5. The bill summary is rendered into that card, not a new bubble.
//   6. Confirm -> QR message, paid -> tracking message (only what is needed).
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

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
  renderUserCard,
  userChatCards,
  getUserScreen,
  updateOrderCards
} = await import('./index.js');
const { sendBillSummaryToCustomerOnce } = await import('./forwarded-order-flow.js');
const { getDb, saveDb, updateDraft, clearDraft, mutateDb } = await import('./store.js');

const log = [];
const fakeCallApi = async (method, payload = {}) => {
  log.push({ method, payload });
  if (method === 'editMessageText' || method === 'sendMessage') {
    return { message_id: payload.message_id || log.length, chat: { id: payload.chat_id }, text: payload.text || '' };
  }
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

mutateDb((d) => { d.config.accounts = {}; });

const CUSTOMER = 515151;
const makeCtx = (incomingMessageId = null) => ({
  from: { id: CUSTOMER, first_name: 'Ammi' },
  chat: { id: CUSTOMER },
  telegram: bot.telegram,
  message: incomingMessageId ? { message_id: incomingMessageId } : undefined,
  reply: async (text, extra = {}) => {
    const sent = await bot.telegram.sendMessage(CUSTOMER, text, extra);
    return sent;
  },
  answerCbQuery: async () => true
});

const calls = (method) => log.filter((c) => c.method === method);
const resetLog = () => { log.length = 0; };

clearDraft(CUSTOMER);
userChatCards.delete(String(CUSTOMER));

// ---------------------------------------------------------------------------
// 1. First link -> one card, no extra bubbles
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: first link creates exactly one card ---');
{
  updateDraft(CUSTOMER, {
    cart: 'https://swig.gy/gc/1467977/Umbashiya-642855918',
    cartDetails: {
      restaurantName: 'Mouj Mela',
      items: [{ name: 'Egg Roll', price: 109, qty: 2, lineTotal: 218 }],
      subtotal: 218,
      itemsTotal: 218
    }
  });
  resetLog();
  const cardId = await renderUserCard(makeCtx(9001), CUSTOMER, { deleteIncoming: true, notice: '✓ Cart link saved' });

  check('one card is posted', calls('sendMessage').length === 1);
  check('the card message id is remembered', userChatCards.get(String(CUSTOMER))?.messageId === cardId);
  check("the customer's link message is deleted", calls('deleteMessage').some((c) => c.payload.message_id === 9001));
  const cardText = calls('sendMessage')[0]?.payload.text || '';
  check('the card shows the cart is saved', /✓/.test(cardText) && /swig\.gy\/gc\//.test(cardText));
  check('the card asks for the address next', /Address link not received|address link/i.test(cardText));
  check('no duplicate "verified & saved" bubble', calls('sendMessage').length === 1);
}

// ---------------------------------------------------------------------------
// 2. Second link -> same card edited, nothing new posted
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: second link edits the same card ---');
{
  updateDraft(CUSTOMER, {
    address: 'https://swiggy.onelink.me/JgkQ/kubail4a',
    addressLink: 'https://swiggy.onelink.me/JgkQ/kubail4a',
    addressOriginalText: 'https://swiggy.onelink.me/JgkQ/kubail4a',
    addressDetails: null
  });
  // A stale prompt bubble from an older build.
  userChatCards.get(String(CUSTOMER)).promptIds.push(7777);

  resetLog();
  const cardId = await renderUserCard(makeCtx(9002), CUSTOMER, { deleteIncoming: true, notice: '✓ Address link saved' });
  const state = userChatCards.get(String(CUSTOMER));

  check('no new card is posted', calls('sendMessage').length === 0);
  check('the existing card is edited in place', calls('editMessageText')[0]?.payload.message_id === cardId);
  check('the card id never changes', state.messageId === cardId);
  check("the customer's address link message is deleted", calls('deleteMessage').some((c) => c.payload.message_id === 9002));
  check('the stale prompt bubble is deleted', calls('deleteMessage').some((c) => c.payload.message_id === 7777));
  check('prompt tracking is cleared', Array.isArray(state.promptIds) && state.promptIds.length === 0);

  const editedText = calls('editMessageText')[0]?.payload.text || '';
  check('the card shows both links ready', /Dono links verified|Send to Beta/i.test(editedText));
  check('the card shows the restaurant/items summary', /Mouj Mela/.test(editedText));
}

// ---------------------------------------------------------------------------
// 3. Card content: items + address + single Send to Beta action
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: the single card carries items + address ---');
{
  const screen = getUserScreen(CUSTOMER, { id: CUSTOMER, first_name: 'Ammi' });
  const buttons = screen.keyboard.reply_markup.inline_keyboard.flat();
  check('card shows the cart value', /swig\.gy\/gc\/1467977/.test(screen.text));
  check('card shows the address value', /onelink\.me\/JgkQ\/kubail4a/.test(screen.text));
  check('card offers exactly one Send to Beta action',
    buttons.filter((b) => b.callback_data === 'action_send_to_boss').length === 1);
  check('card shows the item summary', /Mouj Mela/.test(screen.text));
}

// ---------------------------------------------------------------------------
// 4. Bill summary is rendered into the card, not sent as a new bubble
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: bill summary reuses the live card ---');
{
  const db = getDb();
  db.orders = db.orders || {};
  db.orders.V20_CARD = {
    id: 'V20_CARD',
    userId: CUSTOMER,
    userName: 'Ammi',
    type: 'SWIGGY_ORDER',
    status: 'PENDING',
    cart: 'https://swig.gy/gc/1467977/Umbashiya-642855918',
    restaurantName: 'Mouj Mela',
    items: [{ name: 'Egg Roll', price: 109, qty: 2, lineTotal: 218 }],
    subtotal: 218,
    finalPayable: 73,
    couponCode: 'FEASTMODE70',
    discountAmount: 130,
    selectedAccount: 'acc_1',
    userChatId: CUSTOMER,
    userMessageId: userChatCards.get(String(CUSTOMER)).messageId,
    createdAt: new Date().toISOString()
  };
  saveDb(db);

  const order = getDb().orders.V20_CARD;
  resetLog();
  const sent = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
    deliver: async () => {
      const res = await updateOrderCards({ ...order, status: 'APPROVAL_PENDING' });
      return Boolean(res?.userCardUpdated);
    }
  });
  const after = getDb().orders.V20_CARD;

  check('summary is delivered', sent.sent === true && sent.viaCard === true);
  check('no extra bill-summary bubble is sent', calls('sendMessage').length === 0);
  check('the card was edited with the bill', calls('editMessageText').length === 1);
  check('the one-time marker is still set', Boolean(after.billSummarySentAt));
  check('delivery channel is recorded as the single card', after.billSummaryDelivery === 'SINGLE_CARD');
  check('order waits for customer approval', after.status === 'APPROVAL_PENDING');
  const billText = calls('editMessageText')[0]?.payload.text || '';
  check('the card shows items and the payable amount', /Egg Roll/.test(billText) && /73/.test(billText));

  // A deleted/old card must not lose the summary: fall back to a message.
  resetLog();
  const fallbackOrder = { ...getDb().orders.V20_CARD, id: 'V20_FALLBACK', billSummarySentAt: undefined, userMessageId: 424242 };
  saveDb((() => { const d = getDb(); d.orders.V20_FALLBACK = fallbackOrder; return d; })());
  const fallback = await sendBillSummaryToCustomerOnce(bot.telegram, getDb().orders.V20_FALLBACK, {
    deliver: async () => false
  });
  check('a failed card edit falls back to one message',
    fallback.sent === true && fallback.viaCard !== true && calls('sendMessage').length === 1);
}

// ---------------------------------------------------------------------------
// 5. Stale card (customer deleted it) -> exactly one new card, never a pile
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: stale card is replaced once ---');
{
  resetLog();
  await bot.telegram.deleteMessage(CUSTOMER, userChatCards.get(String(CUSTOMER)).messageId).catch(() => {});
  // Simulate Telegram refusing to edit a deleted message.
  const originalCall = bot.telegram.callApi;
  bot.telegram.callApi = async (method, payload) => {
    if (method === 'editMessageText') throw new Error('message to edit not found');
    return originalCall(method, payload);
  };
  Object.getPrototypeOf(bot.telegram).callApi = bot.telegram.callApi;

  const newId = await renderUserCard(makeCtx(), CUSTOMER, {});
  check('a fresh card is posted exactly once', calls('sendMessage').length === 1);
  check('the tracked card id is updated', userChatCards.get(String(CUSTOMER)).messageId === newId);

  bot.telegram.callApi = originalCall;
  Object.getPrototypeOf(bot.telegram).callApi = originalCall;
}

// ---------------------------------------------------------------------------
// 6. Static guard: the noisy reply paths are gone
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 6: no leftover chat-spam replies ---');
{
  const src = fs.readFileSync('index.js', 'utf8');
  check('link intake deletes the pasted message', (src.match(/deleteIncoming: true/g) || []).length >= 3);
  check('cart/address prompts no longer use force_reply bubbles', !/input_field_placeholder: 'Paste (?:cart|Swiggy address)/.test(src));
  check('old "verified & saved" bubbles are gone', !/Cart Link verified & saved|Address Link verified & saved/.test(src));
  check('the bill summary can render into the card', src.includes('deliverBillSummaryIntoSingleCard'));
  check('updateOrderCards reports card edits', /result\.userCardUpdated = true/.test(src));
}

console.log('\n' + '='.repeat(64));
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('='.repeat(64));
