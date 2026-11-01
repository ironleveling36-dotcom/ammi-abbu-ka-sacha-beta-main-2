// ============================================================================
// v21 — Personalised QR, no leaked HTML tags, interactive link prompts,
//       bill-summary routing (boss-only for forwards, both for Send to Beta)
// ----------------------------------------------------------------------------
//   1. After the customer approves, a PERSONALISED QR photo is delivered
//      (name + amount baked into the image) — even when Swiggy has no UPI intent.
//   2. No chat message can print raw <b>/<i>/<code> tags.
//   3. "Paste cart/address" buttons open a real force_reply prompt, and that
//      prompt is deleted as soon as the link arrives (one card stays).
//   4. Send to Beta with missing data deletes the old card and asks for exactly
//      what is missing.
//   5. Boss-forwarded orders keep the bill summary in the bot; a customer's
//      Send to Beta order goes to BOTH the customer and the boss.
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
  ok: false, status: 503, headers: { get: () => null }, text: async () => '', json: async () => ({})
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
  promptForLink,
  resetCardAndAskForMissing,
  sendApprovedOrderPaymentToUser
} = await import('./index.js');
const {
  sendBillSummaryToCustomerOnce,
  resolveBillSummaryAudience,
  shouldSendSummaryToCustomer
} = await import('./forwarded-order-flow.js');
const { getDb, saveDb, updateDraft, clearDraft, mutateDb } = await import('./store.js');

const log = [];
const fakeCallApi = async (method, payload = {}) => {
  log.push({ method, payload });
  if (method === 'editMessageText') return { message_id: payload.message_id, chat: { id: payload.chat_id }, text: payload.text || '' };
  if (method === 'sendMessage') return { message_id: log.length, chat: { id: payload.chat_id }, text: payload.text || '' };
  if (method === 'sendPhoto') return { message_id: log.length, chat: { id: payload.chat_id }, photo: payload.photo };
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const CUSTOMER = 616161;
const BOSS = 6484999726;
mutateDb((d) => {
  d.config.accounts = {};
  d.config.bossIds = [BOSS];
  d.config.bossUpiId = '6296591407@ybl';
});

const calls = (method) => log.filter((c) => c.method === method);
const reset = () => { log.length = 0; };
const ctxFor = (incomingId = null) => ({
  from: { id: CUSTOMER, first_name: 'Ammi' },
  chat: { id: CUSTOMER },
  telegram: bot.telegram,
  message: incomingId ? { message_id: incomingId } : undefined,
  reply: (text, extra = {}) => bot.telegram.sendMessage(CUSTOMER, text, extra),
  answerCbQuery: async () => true
});

clearDraft(CUSTOMER);
userChatCards.delete(String(CUSTOMER));

// ---------------------------------------------------------------------------
// 1. Personalised payment QR (photo) after approval
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: personalised payment QR is delivered ---');
{
  const db = getDb();
  db.orders = db.orders || {};
  db.orders.V21_QR = {
    id: 'V21_QR',
    userId: CUSTOMER,
    userName: 'Ammi',
    fwdSenderName: 'Ammi',
    type: 'SWIGGY_ORDER',
    status: 'PAYMENT_PENDING',
    restaurantName: 'Mouj Mela',
    finalPayable: 73,
    billApprovedByUser: true,
    userChatId: CUSTOMER,
    createdAt: new Date().toISOString(),
    // v78 (boss 30-10-2026): order ka QR SIRF Swiggy ke payment intent se banta
    // hai — boss ki personal UPI se nahi (paisa Swiggy tak nahi pahunchta).
    pendingSwiggyUpiUri: 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=73&cu=INR&tr=V21TXN'
  };
  saveDb(db);

  reset();
  const sentQr = await sendApprovedOrderPaymentToUser(String(CUSTOMER), getDb().orders.V21_QR, { force: true });
  const photo = calls('sendPhoto')[0];
  const after = getDb().orders.V21_QR;

  check('a QR photo is delivered to the customer', sentQr === true && Boolean(photo));
  check('the QR image is a PNG buffer (not a text QR payload)', Boolean(photo?.payload?.photo?.source?.length > 1000));
  check('the caption carries the amount', /₹73/.test(photo?.payload?.caption || ''));
  check('the caption names the customer', /Ammi/.test(photo?.payload?.caption || ''));
  check('a payment status button is attached',
    /user_paid_status_V21_QR/.test(JSON.stringify(photo?.payload?.reply_markup || {})));
  check('the channel is recorded as personalised', /PERSONALISED/.test(String(after.paymentQrKind || '')));
  check('the QR is not a bot tracking page', !/\/track\//.test(JSON.stringify(photo?.payload || {})));

  // Same service with an explicit Swiggy UPI intent.
  const db2 = getDb();
  db2.orders.V21_QR2 = { ...db2.orders.V21_QR, id: 'V21_QR2', // v60/v61: real Swiggy merchant VPA (a `swiggy@*` placeholder scans invalid)
    pendingSwiggyUpiUri: 'upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=73&cu=INR&tr=V21TXN', customerPaymentMessageId: null };
  saveDb(db2);
  reset();
  await sendApprovedOrderPaymentToUser(String(CUSTOMER), getDb().orders.V21_QR2, { force: true });
  check('official Swiggy UPI intent is used when available',
    getDb().orders.V21_QR2.paymentQrKind === 'SWIGGY_PERSONALISED');
  check('exactly one QR photo is sent (no duplicates)', calls('sendPhoto').length === 1);

  // v78: boss ki personal UPI kabhi "Swiggy ka QR" ban ke nahi jata.
  const db3 = getDb();
  db3.config.bossUpiId = '6296591407@ybl';
  db3.orders.V21_NOSWIGGY = {
    id: 'V21_NOSWIGGY', userId: CUSTOMER, userName: 'Ammi', type: 'SWIGGY_ORDER',
    status: 'PAYMENT_PENDING', restaurantName: 'Mouj Mela', finalPayable: 73,
    billApprovedByUser: true, userChatId: CUSTOMER, createdAt: new Date().toISOString()
  };
  saveDb(db3);
  reset();
  const noQr = await sendApprovedOrderPaymentToUser(String(CUSTOMER), getDb().orders.V21_NOSWIGGY, { force: true });
  check('Swiggy data na ho to QR nahi jata (boss UPI se nahi)', noQr === false && calls('sendPhoto').length === 0);
  const honest = JSON.stringify(calls('sendMessage').map((c) => c.payload?.text || ''));
  check('customer ko sach bataya jata hai', /Swiggy.*payment QR|QR abhi nahi bheja gaya/i.test(honest));
  check('customer ke chat me boss ki UPI kabhi nahi', !honest.includes('6296591407@ybl'));
}

// ---------------------------------------------------------------------------
// 2. No raw HTML tags can reach a chat
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: no leaked HTML tags ---');
{
  const files = ['index.js', 'simple-chat.js', 'forwarded-order-flow.js', 'boss-panel.js', 'swiggy-cart.js', 'ammi-abbu-topic-flow.js', 'order-tracking.js', 'rich-text.js'];
  const offenders = [];
  const callRe = /(ctx\.reply|ctx\.telegram\.sendMessage|bot\.telegram\.sendMessage|telegram\.sendMessage|editMessageText|ctx\.editMessageText)\s*\(/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = callRe.exec(src)) !== null) {
      let depth = 1;
      let j = m.index + m[0].length;
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === '(' && src[j - 1] !== '\\') depth++;
        else if (ch === ')' && src[j - 1] !== '\\') depth--;
        j++;
      }
      const seg = src.slice(m.index, j);
      if (/<(b|i|code|blockquote|a href|u|s|pre)>/.test(seg) && !seg.includes('parse_mode')) {
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  check('every message with HTML tags sets parse_mode', offenders.length === 0);
  if (offenders.length) console.log('   offenders:', offenders.join(', '));

  // Cards must not double-escape a generated tag.
  const { getUserScreen } = await import('./index.js');
  updateDraft(CUSTOMER, { cart: 'https://swig.gy/gc/1/Shop-1' });
  const screen = getUserScreen(CUSTOMER, { id: CUSTOMER });
  check('rendered card has real tags, not escaped ones', /<b>/.test(screen.text) && !/&lt;b&gt;/.test(screen.text));
  check('rendered card has no dangling markup', !/<\/?(?:b|i|code)>\s*$/.test(screen.text.trim()));
}

// ---------------------------------------------------------------------------
// 3. Paste buttons open a real prompt; the prompt disappears with the link
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: paste button asks, then cleans up ---');
{
  clearDraft(CUSTOMER);
  userChatCards.delete(String(CUSTOMER));
  updateDraft(CUSTOMER, { cart: 'https://swig.gy/gc/1467977/Umbashiya-642855918' });
  reset();

  const ctx = ctxFor();
  await renderUserCard(ctx, CUSTOMER, {});
  const prompt = await promptForLink(ctx, CUSTOMER, 'address');
  const promptCall = calls('sendMessage').at(-1);

  check('a prompt message is sent', Boolean(prompt?.message_id));
  check('the prompt requests a force reply', promptCall?.payload?.reply_markup?.force_reply === true);
  check('the prompt has an input placeholder', Boolean(promptCall?.payload?.reply_markup?.input_field_placeholder));
  check('the prompt asks for the address link', /address link/i.test(promptCall?.payload?.text || ''));
  check('exactly one card + one prompt exist', calls('sendMessage').length === 2);

  // A second tap replaces the prompt instead of stacking another one.
  reset();
  await promptForLink(ctx, CUSTOMER, 'address');
  check('a repeated tap deletes the old prompt',
    calls('deleteMessage').some((c) => c.payload.message_id === prompt.message_id));
  check('only one new prompt is created', calls('sendMessage').length === 1);

  // Link arrives -> prompt + pasted message are both deleted.
  reset();
  await renderUserCard(ctxFor(9500), CUSTOMER, { deleteIncoming: true, notice: '✓ saved' });
  const deleted = calls('deleteMessage').map((c) => c.payload.message_id);
  check('the pasted link message is deleted', deleted.includes(9500));
  check('the pending prompt is deleted with it', deleted.length >= 2);
  check('the card is only edited, never duplicated', calls('sendMessage').length === 0);
}

// ---------------------------------------------------------------------------
// 4. Send to Beta with missing data: old card removed, asks for the gap
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: Send to Beta clears the old card and asks ---');
{
  clearDraft(CUSTOMER);
  userChatCards.delete(String(CUSTOMER));
  reset();
  const ctx = ctxFor();
  const cardId = await renderUserCard(ctx, CUSTOMER, {});
  const state = userChatCards.get(String(CUSTOMER));
  state.promptIds.push(4242);

  reset();
  await resetCardAndAskForMissing(ctx, CUSTOMER, 'cart');

  const deleted = calls('deleteMessage').map((c) => c.payload.message_id);
  check('the old card is deleted', deleted.includes(cardId));
  check('the tracked card is forgotten', userChatCards.get(String(CUSTOMER))?.messageId === null);
  check('the stale prompt is deleted', deleted.includes(4242));
  const asks = calls('sendMessage').map((c) => c.payload.text || '');
  check('it names the missing cart link', asks.some((t) => /Cart link missing/i.test(t)));
  check('it opens a cart force_reply prompt',
    calls('sendMessage').some((c) => c.payload?.reply_markup?.force_reply === true && /cart/i.test(c.payload.text || '')));

  reset();
  await resetCardAndAskForMissing(ctx, CUSTOMER, 'address');
  check('it names the missing address link',
    calls('sendMessage').some((c) => /address missing|Delivery address missing/i.test(c.payload.text || '')));
  check('it opens an address force_reply prompt',
    calls('sendMessage').some((c) => c.payload?.reply_markup?.force_reply === true && /address/i.test(c.payload.text || '')));
}

// ---------------------------------------------------------------------------
// 5. Bill-summary routing
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: who gets the bill summary ---');
{
  const forwarded = {
    id: 'V21_FWD',
    isForwardedOrder: true,
    userId: BOSS,
    fwdSenderUserId: CUSTOMER,
    userIdCustomer: CUSTOMER,
    status: 'BILL_READY',
    cardStage: 'BILL_READY',
    selectedAccount: 'acc_1',
    finalPayable: 73,
    userChatId: CUSTOMER
  };
  check('a forwarded order is boss-only', resolveBillSummaryAudience(forwarded, getDb()) === 'BOSS_ONLY');
  check('a forwarded order never messages the customer', shouldSendSummaryToCustomer(forwarded, getDb()) === false);

  reset();
  const fwdSend = await sendBillSummaryToCustomerOnce(bot.telegram, { ...forwarded, isForwardedOrder: true }, { force: true });
  check('the guard blocks the customer message', fwdSend.sent === false && fwdSend.reason === 'boss-only');
  check('no chat message was produced for the forward', calls('sendMessage').length === 0);

  const own = {
    id: 'V21_OWN',
    userId: CUSTOMER,
    userName: 'Ammi',
    status: 'PENDING',
    cardStage: 'BILL_READY',
    selectedAccount: 'acc_1',
    finalPayable: 73,
    couponCode: 'FEASTMODE70',
    userChatId: CUSTOMER
  };
  check('a customer order goes to customer + boss', resolveBillSummaryAudience(own, getDb()) === 'CUSTOMER_AND_BOSS');

  const db = getDb();
  db.orders.V21_OWN = own;
  saveDb(db);
  reset();
  const ownSend = await sendBillSummaryToCustomerOnce(bot.telegram, getDb().orders.V21_OWN, { force: true });
  check('the customer receives the auto summary', ownSend.sent === true);
  check('the audience is recorded on the order',
    getDb().orders.V21_OWN.billSummaryAudience === 'CUSTOMER_AND_BOSS');
  check('exactly one summary message reaches the customer',
    calls('sendMessage').filter((c) => String(c.payload.chat_id) === String(CUSTOMER)).length === 1);
}

console.log('\n' + '='.repeat(64));
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('='.repeat(64));
