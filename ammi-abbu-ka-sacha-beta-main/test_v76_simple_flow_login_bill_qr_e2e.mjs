/**
 * v76 — "bas login button → bill → QR → sab ho gaya" (boss 30-10-2026)
 *
 * Boss:
 *   "address and cart paste karne ke baad bas itna bolna hai ki ID apne phone me
 *    login karne ke liye ye button dabaye; jab wo daba de to usko phir bill dikha
 *    do aur QR ka option; aur fee ke baad QR; and then hogaya sab — no other
 *    option. Nahi to user confuse ho jayega."
 *
 * Yeh test (offline) proves:
 *   1. Links paste → SIRF login message + ek hi button (koi Continue/clear/price nahi).
 *   2. Login button dabane par order shuru + bill card + SIRF "QR banao".
 *   3. QR banane ke baad: fail → try again; ready → sirf verification;
 *      release → "SAB HO GAYA" + tracking.
 *   4. Customer ke kisi happy-path screen par ek se zyada "faisla" button nahi.
 *   5. Wiring: paste par auto-start band, loginReady handler, login help card.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

const DB_PATH = 'data/db.json';
const MIRROR = 'accounts.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const mirrorSnapshot = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR, 'utf8') : null;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const chat = await import('./simple-chat.js');
const indexSrc = fs.readFileSync('./index.js', 'utf8');
const chatSrc = fs.readFileSync('./simple-chat.js', 'utf8');

const flat = (screen) => screen.keyboard.reply_markup.inline_keyboard.flat();
const callbacks = (screen) => flat(screen).map((b) => b.callback_data).filter(Boolean);

console.log('\n1) Links paste → sirf login button');
const both = chat.buildSimpleHomeScreen({
  cart: 'https://www.swiggy.com/cart/abc',
  address: 'https://www.swiggy.com/ofo/address/x/y',
  cartDetails: { restaurantName: 'Pizza Hut', items: [{ name: 'Margherita', qty: 1 }], subtotal: 249 },
  addressDetails: { address: '12, Gomti Nagar, Lucknow' }
});
// v80 (boss 29-10-2026): "JSON user ke phone me login nahi ho raha" — koi
// button kisi phone me login nahi karta, isliye jhootha label hata. Main button
// wahi raasta hai (bill), aur phone-login ka asli raasta optional button hai.
check('aage badhne ki line dikhti hai', /Cart \+ Address mil gaya/i.test(both.text), both.text.slice(0, 80));
check('"phone me login ho gaya" ka jhootha dawa nahi', !/apne phone me login karne ke liye/i.test(both.text));
// v81 (boss 30-10-2026): injection hata — bas ek seedha button.
check('sirf ek seedha button (bill)', flat(both).length === 1, String(flat(both).length));
check('main button bill ka hai', callbacks(both)[0] === chat.SIMPLE_CHAT_CALLBACKS.loginReady, callbacks(both)[0]);
check('phone-login injection button nahi', !callbacks(both).includes('simple_phone_login'));
check('koi Continue button nahi', !callbacks(both).includes(chat.SIMPLE_CHAT_CALLBACKS.continueDraft));
check('koi clear/admin option nahi', !callbacks(both).includes(chat.SIMPLE_CHAT_CALLBACKS.clearDraft) && !callbacks(both).includes('support_contact_admin'));
check('cart + address dikh rahe hain', /Pizza Hut/.test(both.text) && /Gomti/.test(both.text));

console.log('\n2) Login ke baad → bill + sirf "QR banao"');
const billOrder = {
  id: 'ORD1', userId: '555', status: 'APPROVAL_PENDING', cardStage: 'BILL_READY',
  restaurantName: 'Pizza Hut', finalPayable: 249, subtotal: 300,
  items: [{ name: 'Margherita', qty: 1, price: 249 }],
  address: '12, Gomti Nagar, Lucknow', selectedAccount: 'acc_1'
};
const bill = chat.buildSimpleOrderCard(billOrder);
check('bill dikhta hai', /Confirm your order/.test(bill.text));
check('amount dikhta hai', /₹249/.test(bill.text));
check('exactly ek button', flat(bill).length === 1, String(flat(bill).length));
check('wahi button QR ka hai', callbacks(bill)[0] === `simple_confirm_order_ORD1`, callbacks(bill)[0]);
check('QR button par amount', /QR banao — ₹249/.test(flat(bill)[0].text));
check('bill par koi login/OTP button nahi', !callbacks(bill).some((c) => /devlogin_/.test(c)));

console.log('\n3) QR ready → sirf verification; fail → try again');
const held = chat.buildSimpleOrderCard({ ...billOrder, status: 'PAYMENT_PENDING', cardStage: 'AWAITING_FEE', qrHeld: true, qrHeldUri: 'upi://x' });
check('verification card', /QR ready/i.test(held.text));
check('sirf verification button', callbacks(held).includes('wallet_verify_pay') && flat(held).length <= 2, JSON.stringify(callbacks(held)));
const retry = chat.buildSimpleOrderCard({ ...billOrder, status: 'PAYMENT_PENDING', cardStage: 'QR_RETRY' });
check('fail par try again', /QR ban nahi paya/i.test(retry.text) && callbacks(retry).includes('user_retry_qr_ORD1'));

console.log('\n4) QR release ke baad → "SAB HO GAYA" + tracking');
const done = chat.buildSimpleOrderCard({
  ...billOrder, status: 'COMPLETED', paymentStatus: 'PAID',
  liveOrderStatus: 'Order Confirmed',
  trackingLink: 'https://www.swiggy.com/ofo/track/GfF1tVG8iSUk', trackingLinkSource: 'SWIGGY_API'
});
check('"SAB HO GAYA" likha hai', /SAB HO GAYA/.test(done.text), done.text.slice(0, 40));
check('track button hai', flat(done).some((b) => /Track on Swiggy/.test(b.text) && b.url));
const doneCbs = callbacks(done);
check('koi extra menu nahi', doneCbs.length <= 2, JSON.stringify(doneCbs));
check('"Ho gaya" button', flat(done).some((b) => /Ho gaya/.test(b.text)));

const trackingMsg = chat.buildSimpleTrackingMessage({
  id: 'ORD1', restaurantName: 'Pizza Hut', userId: '555', swiggyOrderId: '251838950110925',
  trackingLink: 'https://www.swiggy.com/ofo/track/GfF1tVG8iSUk', trackingLinkSource: 'SWIGGY_API'
});
check('tracking message "SAB HO GAYA"', /SAB HO GAYA/.test(trackingMsg.text), trackingMsg.text.slice(0, 40));

console.log('\n5) Login help card (sirf dikkat par)');
const help = chat.buildSimpleLoginHelpCard({ id: 'ORD1', deviceLogin: { status: 'AWAITING_LOGIN' } });
check('madad card hai', /PHONE ME LOGIN/i.test(help.text));
check('cart-verify buttons hain',
  flat(help).some((b) => /devlogin_cart_yes_ORD1/.test(String(b.callback_data))) &&
  flat(help).some((b) => /devlogin_cart_no_ORD1/.test(String(b.callback_data))));
check('bot kare button', flat(help).some((b) => /devlogin_bot_ORD1/.test(String(b.callback_data))));

console.log('\n6) Wiring');
check('loginReady callback add hua', /loginReady: 'simple_login_ready'/.test(chatSrc));
check('loginReady handler index me', /bot\.action\(SIMPLE_CHAT_CALLBACKS\.loginReady/.test(indexSrc));
check('login help handler', /simple_login_help_/.test(indexSrc));
check('paste par simple auto-start band', !/simpleChatForUser\(userId\) && curDraft\.cart && curDraft\.address && !getActiveUserOrder\(userId\)\) \{\s*\n\s*await cleanupUserChat[\s\S]{0,600}startSimpleOrderFromDraft/.test(indexSrc));
check('paste ke baad sirf card render', /paste hone ke baad SIRF ek message[\s\S]{0,200}renderUserCard/.test(indexSrc));
check('confirm par koi login card nahi jata', !/bot\.action\(\/\^simple_confirm_order_\/[\s\S]{0,2500}sendDeviceLoginHandover\(/.test(indexSrc));
check('login par koi injection notice nahi', !/sendDeviceLoginShortNotice/.test(indexSrc));
check('bill card par QR banao', /QR banao/.test(chatSrc));
check('tracking card "SAB HO GAYA"', /SAB HO GAYA/.test(chatSrc));
check('koi Balance/wallet button customer card par nahi', !/wallet_home/.test(chatSrc));

function restoreState() {
  try {
    if (dbSnapshot === null) fs.rmSync(DB_PATH, { force: true });
    else fs.writeFileSync(DB_PATH, dbSnapshot);
    if (mirrorSnapshot === null) fs.rmSync(MIRROR, { force: true });
    else fs.writeFileSync(MIRROR, mirrorSnapshot);
  } catch { /* ignore */ }
}
restoreState();

console.log(`\n${failed === 0 ? '🏆' : '❌'} v76: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
