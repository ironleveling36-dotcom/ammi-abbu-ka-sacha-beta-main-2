// ============================================================================
// v42 — ADDRESS LINK RECOVERY
// ----------------------------------------------------------------------------
// Real-world complaint: "address link bhej raha hoon to baar baar expire bata
// raha hai". Two bugs made that a dead end:
//
//   1. A Swiggy share link that we could not EXPAND (AppsFlyer short id) was sent
//      to Swiggy's OFO endpoint as if it were a token. Swiggy answered "invalid",
//      and that answer was shown as "aapka link expire ho gaya" — a lie, and the
//      customer re-pasted the same perfectly good link forever.
//   2. The failed link stayed in the draft. Even after typing a real address, the
//      bot kept re-resolving the stale link and kept saying "expired".
//
// Contract under test:
//   - "expired" is only claimed when Swiggy really rejected the token;
//   - an un-expanded link says so and never hits social/getAddress;
//   - a typed address replaces the stale link and the order can proceed;
//   - the customer always has a Retry / "type address" way out.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

// Switchable fake Swiggy network.
const net = { mode: 'unknowable' };
const hits = [];
const json = (status, body, u) => ({
  ok: status >= 200 && status < 300, status, url: u,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(body),
  json: async () => body
});
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  hits.push(u);
  if (u.includes('onelink.me') || u.includes('swig.gy')) {
    // AppsFlyer refuses unknown/bot traffic -> expansion yields nothing.
    return {
      ok: false, status: 403, url: u,
      headers: { get: (k) => (String(k).toLowerCase() === 'location' ? null : 'text/html') },
      text: async () => 'blocked',
      json: async () => ({})
    };
  }
  if (u.includes('social/getAddress')) {
    if (net.mode === 'expired') return json(200, { statusCode: 1, statusMessage: 'Invalid or expired link' }, u);
    return json(200, { statusCode: 1 }, u);
  }
  return json(503, {}, u);
};

const { bot } = await import('./index.js');
const { getDb, mutateDb, clearDraft, getDraft, updateDraft } = await import('./store.js');
const { resolveSwiggyLink, getOfoResolutionFailureReason } = await import('./swiggy-cart.js');

const apiLog = [];
const fakeCallApi = async (method, payload = {}) => {
  apiLog.push({ method, payload });
  return { message_id: apiLog.length, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' }, text: payload.text || payload.caption || '' };
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sentMessages = () => apiLog.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.payload);
const lastMessage = () => sentMessages().pop() || {};
const lastButtons = () => (lastMessage().reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);

const USER = 4242421;
mutateDb((d) => {
  d.orders = {}; d.drafts = {};
  d.config.deletedAccounts = {};
  d.config.accounts = {
    acc_9000000999: {
      account: 'acc_9000000999', name: 'Ammi', phone: '9000000999', isLoggedIn: true,
      cookies: '_session_tid=fake.tid.value', tid: 'fake.tid.value'
    }
  };
});
clearDraft(USER);

const say = async (text, mid) => {
  const countBefore = apiLog.filter(c => c.method === 'sendMessage').length;
  await bot.handleUpdate({
    update_id: 6100 + mid,
    message: {
      message_id: mid, date: Math.floor(Date.now() / 1000),
      chat: { id: USER, type: 'private', first_name: 'Ammi' },
      from: { id: USER, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text
    }
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && apiLog.filter(c => c.method === 'sendMessage').length === countBefore) {
    await sleep(50);
  }
};

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: an un-expandable share link is never called "expired" ---');
const SHORT_LINK = 'https://swiggy.onelink.me/JgkQ/abc123xy';
{
  net.mode = 'unknowable';
  hits.length = 0;
  const meta = await resolveSwiggyLink(SHORT_LINK);
  check('the resolver flags the link as unresolved', meta?.addressDetails?.unresolvableShortLink === true);
  check('the reason is UNEXPANDED, not EXPIRED', meta?.addressDetails?.unresolvedReason === 'UNEXPANDED');
  check('the failure reason is readable from the raw URL too',
    getOfoResolutionFailureReason(SHORT_LINK) === 'UNEXPANDED');
  check('an un-expanded short id can never be reported as EXPIRED',
    getOfoResolutionFailureReason('abc123xy') === 'UNEXPANDED' &&
    getOfoResolutionFailureReason(SHORT_LINK) === 'UNEXPANDED');
  check('the short id is still attempted once (some shares carry a usable id)',
    hits.some((u) => u.includes('social/getAddress')));
}

console.log('\n--- Scenario 2: the customer is offered a way forward ---');
{
  clearDraft(USER);
  net.mode = 'unknowable';
  apiLog.length = 0;
  await say(`https://swig.gy/gc/RealCart123\n${SHORT_LINK}`, 1);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !sentMessages().some(m => /khul nahi paya|nahi mil paya/i.test(m.text))) {
    await sleep(50);
  }
  const textMsg = sentMessages().find(m => /khul nahi paya|nahi mil paya/i.test(m.text)) || lastMessage();
  const text = String(textMsg.text || '');
  const buttons = (textMsg.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);
  check('the bot does not say "expire" for an unopened link', !/expire/i.test(text));
  check('the bot says the Swiggy link could not be opened', /khul nahi paya|nahi mil paya/i.test(text));
  check('a Retry action is offered', buttons.includes('simple_retry_address'));
  check('a "type the address" action is offered', buttons.includes('simple_type_address'));
}

console.log('\n--- Scenario 3: a typed address replaces the stale broken link ---');
{
  apiLog.length = 0;
  await say('Flat 4, Gomti Nagar, Lucknow 226010', 2);
  const d = getDraft(USER);
  check('the stale address link is cleared', !d.addressLink);
  check('the draft is marked as a typed address', d.addressTyped === true);
  check('the typed address is stored', /Gomti Nagar/i.test(String(d.address || '')));
}

console.log('\n--- Scenario 4: Continue works from a typed address ---');
{
  apiLog.length = 0;
  await bot.handleUpdate({
    update_id: 6199,
    callback_query: {
      id: 'cb-continue', from: { id: USER, is_bot: false, first_name: 'Ammi' }, chat_instance: 'ci',
      data: 'simple_continue',
      message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: USER, type: 'private' }, text: 'card' }
    }
  });
  await sleep(1200);
  const all = sentMessages().map((m) => String(m.text || '')).join('\n');
  check('no "expired" loop after typing the address', !/expire ho gaya/i.test(all));
  check('the draft link stays cleared after Continue', !getDraft(USER).addressLink);
}

console.log('\n--- Scenario 5: a genuinely dead Swiggy token still says "expired" ---');
{
  net.mode = 'expired';
  const DIRECT = 'https://www.swiggy.com/ofo/address/9amuser/9amtoken123456';
  const meta = await resolveSwiggyLink(DIRECT);
  check('a direct OFO link is probed against social/getAddress',
    hits.some((u) => u.includes('social/getAddress')));
  check('Swiggy rejecting the token is reported as EXPIRED',
    meta?.addressDetails?.unresolvedReason === 'EXPIRED' ||
    getOfoResolutionFailureReason(DIRECT) === 'EXPIRED');

  const USER2 = 4242422;
  clearDraft(USER2);
  apiLog.length = 0;
  await bot.handleUpdate({
    update_id: 6200,
    message: {
      message_id: 1, date: Math.floor(Date.now() / 1000),
      chat: { id: USER2, type: 'private', first_name: 'Ammi' },
      from: { id: USER2, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text: `https://swig.gy/gc/RealCart999\n${DIRECT}`
    }
  });
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline && !sentMessages().some(m => /expire ho gaya/i.test(m.text))) {
    await sleep(50);
  }
  const expMsg = sentMessages().find(m => /expire ho gaya/i.test(m.text)) || lastMessage();
  const text = String(expMsg.text || '');
  const user2Buttons = (expMsg.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);
  check('a truly dead link is reported as expired', /expire ho gaya/i.test(text));
  check('even then the customer can type the address', user2Buttons.includes('simple_type_address'));
}

console.log('\n--- Scenario 5b: the "type address" tap clears the unusable link ---');
{
  const USER3 = 4242423;
  clearDraft(USER3);
  net.mode = 'unknowable';
  await bot.handleUpdate({
    update_id: 6250,
    message: {
      message_id: 1, date: Math.floor(Date.now() / 1000),
      chat: { id: USER3, type: 'private', first_name: 'Ammi' },
      from: { id: USER3, is_bot: false, first_name: 'Ammi', language_code: 'en' },
      text: `https://swig.gy/gc/RealCart777\n${SHORT_LINK}`
    }
  });
  await sleep(1000);
  apiLog.length = 0;
  await bot.handleUpdate({
    update_id: 6251,
    callback_query: {
      id: 'cb-type', from: { id: USER3, is_bot: false, first_name: 'Ammi' }, chat_instance: 'ci',
      data: 'simple_type_address',
      message: { message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: USER3, type: 'private' }, text: 'card' }
    }
  });
  await sleep(600);
  const d = getDraft(USER3);
  check('the broken link is cleared', !d.addressLink);
  check('the text that carried the link is cleared too', !d.addressOriginalText);
  check('the unusable address details are dropped', !d.addressDetails?.unresolvableShortLink);
  const prompt = String(lastMessage().text || '');
  check('the customer is asked to type the address', /Address type karein/i.test(prompt));
}

console.log('\n--- Scenario 6: the "type address" button is wired ---');
{
  const src = fs.readFileSync('index.js', 'utf8');
  check('simple_type_address has a handler', /bot\.action\('simple_type_address'/.test(src));
  check('the handler clears the broken link', /bot\.action\('simple_type_address'[\s\S]{0,400}?addressLink: null/.test(src));
  check('a typed address wins over a stored link', /const typedAddress = draft\.addressTyped \?/.test(src));
  check('the failure reason is logged for diagnosis', /\[AddressResolve\]/.test(src));
  check('an un-expanded short id failure is reclassified as UNEXPANDED',
    /tokenIsUnexpandedShortId[\s\S]{0,200}?noteOfoFailure\(ofoToken, 'UNEXPANDED'\)/.test(fs.readFileSync('swiggy-cart.js', 'utf8')));
}

console.log('\n================================================================');
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
if (passed !== results.length) process.exitCode = 1;
