// test_v80_phone_login_truth_e2e.mjs
// Boss (29-10-2026): "bro aisa lag raha ki json user ke phone me nahi login ho
// raha, mere phone me login ho raha bas udhar show ho raha".
//
// Sach: JSON/cookie = BOT ke server ka session. Wo kisi phone me login nahi karta.
// Customer ke phone me login tabhi hota hai jab usi phone par OTP daala jaye.
//
// Pehle bot ulta jhooth bolta tha ("ID aapke phone me active/ready hai") aur login
// button dabate hi order ko CUSTOMER_PHONE mode me daal deta tha — jisse payment
// stage "order aapke phone se karo" bolta tha (jabki phone me login hi nahi tha).
//
// Ye test teen cheezein lock karta hai:
//   1) Koi jhootha "aapke phone me login/active hai" dawa nahi (source + runtime).
//   2) login button placementMode BOT hi rakhta hai (order kahin nahi atakta).
//   3) Phone login ka ASLI raasta: steps + "cart dikh raha hai?" verification,
//      aur pakka proof sirf us ID par naye order se.

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import fs from 'node:fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const device = await import('./customer-device-login.js');
const chat = await import('./simple-chat.js');
const indexSrc = fs.readFileSync('./index.js', 'utf8');
const chatSrc = fs.readFileSync('./simple-chat.js', 'utf8');
const deviceSrc = fs.readFileSync('./customer-device-login.js', 'utf8');

console.log('\n=== 1. Phone me login ka jhootha dawa nahi ===');
{
  const allSrc = indexSrc + chatSrc + deviceSrc;
  check('"phone me active/login hai" ka dawa kahin nahi', !/aapke phone me (?:active|login) hai/i.test(allSrc));
  // v81 (boss 30-10-2026): "unable to inject — remove it" — notice hi hata diya.
  check('phone-injection notice hata diya gaya', !/sendDeviceLoginShortNotice/.test(indexSrc));
  check('lock par customer ko koi handover message nahi', /const handover = null;/.test(indexSrc));
  check('SESSION_LIVE label sach bolta hai', /SERVER_SESSION_ONLY/.test(deviceSrc));
  check('help card me saaf likha: JSON = server session',
    /JSON\/cookie = bot ke server ka session/.test(chatSrc));
  check('status text app me "cart dikhega" ka wada nahi karta',
    !/Ab app me cart \+ ₹50 offer dono dikhega/.test(deviceSrc));
  check('boss ko lock par sach bataya jata hai',
    /JSON\/cookie = bot ke server ka session/.test(indexSrc));
}

console.log('\n=== 2. login button placementMode BOT hi rakhta hai ===');
{
  check('loginReady me customerChoseOwnPhone nahi', !/simple_login_ready[\s\S]{0,2500}customerChoseOwnPhone/.test(indexSrc));
  check('loginReady sirf handover note karta hai', /attachDeviceLogin\(active, acc, \{ key: accKey \}\);\s*\n\s*markHandoverSent\(active\);/.test(indexSrc));

  const order = { id: 'V80A', userId: 'u1', placementMode: undefined, deviceLogin: null };
  order.deviceLogin = device.attachDeviceLogin(order, { mobile: '9876543210' }, { key: 'acc_9876543210' });
  device.markHandoverSent(order);
  check('markHandoverSent placementMode CUSTOMER_PHONE nahi karta',
    device.isCustomerPhonePlacement(order) === false, String(order.placementMode));
  // Sirf explicit button hi phone-mode karta hai.
  device.customerChoseOwnPhone(order);
  check('explicit "main apne phone se" hi phone-mode karta hai', device.isCustomerPhonePlacement(order) === true);
}

console.log('\n=== 3. Probe = server session, phone proof NAHI ===');
{
  const acc = { cookies: 'tid=ABC', mobile: '9876543210' };
  const okRes = { status: 200, ok: true, json: async () => ({ statusCode: 0, data: { orders: [] } }) };
  const probe = await device.verifyAccountSessionLive(acc, { fetchImpl: async () => okRes });
  check('probe live nikla', probe.live === true, String(probe.reason));
  check('probe khud batata hai: scope = SERVER_SESSION', probe.scope === 'SERVER_SESSION');
  check('probe khud batata hai: phoneProven = false', probe.phoneProven === false);
  check('probe reason me "server" likha', /server/i.test(String(probe.reason)));

  const order = { id: 'V80B', placementMode: 'BOT' };
  order.deviceLogin = device.attachDeviceLogin(order, { mobile: '9876543210' }, { key: 'acc_9876543210' });
  device.applySessionProbe(order, probe);
  const truth = device.deviceLoginTruth(order);
  check('server session live hone par bhi verified=false', truth.verified === false);
  check('truth.proof = SERVER_SESSION_ONLY', truth.proof === 'SERVER_SESSION_ONLY', String(truth.proof));
  check('label me saaf: phone ka saboot nahi', /aapke phone me login ka saboot nahi/i.test(truth.label), truth.label);
}

console.log('\n=== 4. Cart dikhna = phone login (self-report), order = pakka proof ===');
{
  const order = { id: 'V80C', placementMode: 'BOT' };
  order.deviceLogin = device.attachDeviceLogin(order, { mobile: '9876543210' }, { key: 'acc_9876543210' });
  device.notePhoneCartSeen(order);
  const seen = device.deviceLoginTruth(order);
  check('cart dikhne par status SELF_REPORTED', seen.status === 'SELF_REPORTED', seen.status);
  check('par verified nahi (jhooth nahi)', seen.verified === false);
  check('proof = SELF_REPORTED', seen.proof === 'SELF_REPORTED');

  const changed = device.noteCustomerPlacedOrder(order, '999888777');
  const proven = device.deviceLoginTruth(order);
  check('us ID par order aaya -> VERIFIED_BY_ORDER', changed === true && proven.verified === true, proven.status);
  check('proof = CUSTOMER_PHONE_PROVEN', proven.proof === 'CUSTOMER_PHONE_PROVEN');

  const miss = { id: 'V80D', placementMode: 'BOT' };
  miss.deviceLogin = device.attachDeviceLogin(miss, { mobile: '9876543210' }, { key: 'acc_9876543210' });
  device.notePhoneCartMissing(miss);
  check('cart nahi dikha -> FAILED', device.deviceLoginTruth(miss).status === 'FAILED');
  check('cart-nahi wajah likhi jati hai', /login nahi hua/i.test(device.deviceLoginTruth(miss).label));
}

console.log('\n=== 5. Phone-login card: asli steps + asli buttons ===');
{
  const order = { id: 'V80E', selectedAccount: 'acc_9876543210', placementMode: 'BOT' };
  order.deviceLogin = device.attachDeviceLogin(order, { mobile: '9876543210' }, { key: 'acc_9876543210' });
  const card = device.buildPhoneLoginCard({ order, account: { mobile: '9876543210' }, key: 'acc_9876543210' });
  check('number dikhta hai', /9876543210/.test(card.text));
  check('sach likha: bot kisi phone me login nahi kar sakta', /Bot kisi phone me login nahi kar sakta/.test(card.text));
  check('OTP wale phone ki baat', /OTP us number wale phone par aayega/.test(card.text));
  check('cart = proof ka tareeqa', /cart dikh raha hai<\/b> = us phone me ID login hai/.test(card.text));
  const cbs = card.buttons.flat().map((b) => b.callback_data).filter(Boolean);
  check('cart dikh raha hai button', cbs.includes('devlogin_cart_yes_V80E'), cbs.join(','));
  check('cart nahi dikha button', cbs.includes('devlogin_cart_no_V80E'));
  check('OTP nahi (bot kare) button', cbs.includes('devlogin_bot_V80E'));
  check('Swiggy app khulne ka link', card.buttons.flat().some((b) => /swiggy\.com/.test(String(b.url || ''))));

  check('index.js in buttons ko handle karta hai',
    /bot\.action\(\/\^devlogin_cart_yes_/.test(indexSrc) && /bot\.action\(\/\^devlogin_cart_no_/.test(indexSrc));
  check('boss ko cart-yes/cart-no mirror jata hai', /mirrorPhoneLoginToBoss/.test(indexSrc));
}

console.log('\n=== 6. Home card jhooth nahi bolta, par login ka raasta maujood ===');
{
  const home = chat.buildSimpleHomeScreen({
    cart: 'https://www.swiggy.com/cart/abc',
    address: 'https://www.swiggy.com/ofo/address/x/y',
    cartDetails: { restaurantName: 'Pizza Hut', subtotal: 249 },
    addressDetails: { address: '12, Gomti Nagar, Lucknow' }
  });
  const buttons = home.keyboard.reply_markup.inline_keyboard.flat();
  check('home card "phone me active hai" jaisa dawa nahi', !/phone me active/i.test(home.text));
  check('"login karne ke liye ye button" jaisa jhootha label nahi', !/login karne ke liye ye button/i.test(home.text + JSON.stringify(buttons)));
  check('bill ka main button maujood', buttons.some((b) => b.callback_data === chat.SIMPLE_CHAT_CALLBACKS.loginReady));
  check('phone-login injection button hata diya', !buttons.some((b) => b.callback_data === 'simple_phone_login'));
  check('index.js me simple_phone_login handler nahi', !/SIMPLE_CHAT_CALLBACKS\.phoneLogin/.test(indexSrc));

  const help = chat.buildSimpleLoginHelpCard({ id: 'V80F', deviceLogin: { phone: '9876543210', status: 'FAILED' } });
  const helpCbs = help.keyboard.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  check('help card me cart-verify buttons hain', helpCbs.includes('devlogin_cart_yes_V80F') && helpCbs.includes('devlogin_cart_no_V80F'));
}

console.log(`\n${fail === 0 ? '🏆 PHONE LOGIN KA SACH LOCKED' : '❌ FAIL'} — ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exitCode = 1;
