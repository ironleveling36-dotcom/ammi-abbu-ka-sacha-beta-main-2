// test_v79_address_typed_never_dropped_e2e.mjs
// Boss (29-10-2026): "ab address ko kya hua wo kyu nahi le raha".
//
// Asli bug: customer seedha address TYPE karta tha ("B-402 Eldeco Greens",
// "H.No 12, Near Shiv Mandir, Bakshi Ka Talab") — strict parser ko city/pincode/
// "flat|road|nagar" keyword nahi milta tha → null → bot address CHUP-CHAAP gira
// kar wapas "Cart + Address link chahiye" bolta tha. Customer ko lagta tha bot
// address le hi nahi raha.
//
// Ab: jab bot khud address maang raha ho (ya cart aa chuka hai aur address baaki
// hai) to address-jaisa typed text accept hota hai; chit-chat/URL/order-talk nahi.

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';
process.env.SIMPLE_CHAT_MODE = '1';

import fs from 'node:fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '', json: async () => ({}) });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const { parseLooseAddress } = await import('./swiggy-cart.js');
const { bot } = await import('./index.js');
const { setChannelGateMock } = await import('./channel-gate.js');
setChannelGateMock(true);
const { mutateDb, clearDraft, getDraft } = await import('./store.js');

const log = [];
const fakeCallApi = async (method, payload = {}) => {
  log.push({ method, payload });
  if (['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto'].includes(method)) {
    return { message_id: payload.message_id || log.length, chat: { id: payload.chat_id }, text: payload.text || payload.caption || '' };
  }
  if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'T', username: 't' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const U = 7_790_001;
mutateDb((d) => { d.config.accounts = {}; d.orders = {}; d.drafts = {}; });
clearDraft(U);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const texts = () => log.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.payload.text || '');
async function send(text) {
  log.length = 0;
  await bot.handleUpdate({ update_id: ++uid, message: { message_id: uid, date: Math.floor(Date.now() / 1000), chat: { id: U, type: 'private', first_name: 'Ammi' }, from: { id: U, is_bot: false, first_name: 'Ammi', language_code: 'en' }, text } });
  await sleep(800);
  return texts();
}
async function tap(data) {
  log.length = 0;
  await bot.handleUpdate({ update_id: ++uid, callback_query: { id: String(uid), from: { id: U, is_bot: false, first_name: 'Ammi' }, chat_instance: '1', data, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: U, type: 'private' }, text: 'x' } } });
  await sleep(800);
  return texts();
}

console.log('\n=== 1. Loose address parser: address haan, bakwaas nahi ===');
{
  const accept = [
    'B-402 Eldeco Greens',
    'H.No 12, Near Shiv Mandir, Bakshi Ka Talab',
    'Gomti Nagar',
    'Flat 3B, Hazratganj, Lucknow 226001',
    'Plot 9 Sector 4',
    'house no 22 gali no 3'
  ];
  for (const a of accept) check(`address maana: "${a}"`, Boolean(parseLooseAddress(a)));
  const reject = ['hi', 'hello bhai', 'ok', 'thanks', '2 burgers bhej do', 'address bhej do', 'https://swig.gy/gc/1/x', '/start', 'Lucknow'];
  for (const r of reject) check(`address nahi maana: "${r}"`, parseLooseAddress(r) === null);
  const one = parseLooseAddress('Flat 3B, Hazratganj, Lucknow 226001');
  check('city nikalti hai', one?.city === 'Lucknow', String(one?.city));
  check('pincode nikalti hai', one?.pincode === '226001', String(one?.pincode));
  check('mobile address text me se hat jata hai', !String(parseLooseAddress('B-402 Eldeco Greens, phone 9876543210')?.address || '').includes('9876543210'));
}

console.log('\n=== 2. Static: dono jagah loose parser laga hai ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('text handler me loose address accept', /const looseAddrDirect = \(!parsedAddrDirect && !validAddrLink && askingAddressNow\)/.test(src));
  check('order start me loose fallback', /parseLooseAddress\(addressSource\)/.test(src));
  check('typed address ko usable mana jata hai', /curDraft\.addressTyped && String\(curDraft\.addressDetails/.test(src));
}

console.log('\n=== 3. Cart ke baad chhota typed address -> aage badhta hai (login card) ===');
{
  await send('/start');
  await tap('simple_paste_links');
  await send('https://swig.gy/gc/1467977/Umbashiya-642855918');
  check('cart save hua', Boolean(getDraft(U).cart));

  const out = await send('B-402 Eldeco Greens');
  const draft = getDraft(U);
  check('typed address drop NAHI hua', draft.address === 'B-402 Eldeco Greens', String(draft.address));
  check('address typed mark hua', draft.addressTyped === true);
  check('addressDetails me address hai', draft.addressDetails?.address === 'B-402 Eldeco Greens');
  check('bot ne "Cart + Address link chahiye" nahi bola', !out.some((t) => /Cart \+ Address link chahiye/.test(t)));
  check('aage badha (cart + address card / bill)', out.some((t) => /Cart \+ Address mil gaya/i.test(t)) || out.some((t) => /Confirm your order/i.test(t)), out.join(' | ').slice(0, 200));
}

console.log('\n=== 4. Toota address link + typed address -> typed jeetta hai ===');
{
  clearDraft(U);
  mutateDb((d) => { d.config.accounts = {}; });
  await send('https://swig.gy/gc/1467977/Umbashiya-642855918');
  const linkOut = await send('https://swiggy.onelink.me/JgkQ/kubail4a');
  check('link khul nahi paya to saaf bola', linkOut.some((t) => /khul nahi paya/i.test(t)));

  const out = await send('Flat 7, Eldeco Greens');
  const draft = getDraft(U);
  check('typed address ne link ko replace kiya', draft.address === 'Flat 7, Eldeco Greens', String(draft.address));
  check('purana dead link draft me nahi', !draft.addressLink);
  check('flow aage badha', out.some((t) => /Cart \+ Address mil gaya/i.test(t)) || out.some((t) => /Confirm your order/i.test(t)));
}

console.log('\n=== 5. Chit-chat address nahi banti ===');
{
  clearDraft(U);
  await send('/start');
  await tap('simple_paste_links');
  await send('hi');
  check('"hi" address nahi bana', !getDraft(U).address, String(getDraft(U).address));
  await send('thanks bhai');
  check('"thanks bhai" address nahi bana', !getDraft(U).address, String(getDraft(U).address));
}

console.log(`\n${fail === 0 ? '🏆 TYPED ADDRESS NEVER DROPPED' : '❌ FAIL'} — ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exitCode = 1;
