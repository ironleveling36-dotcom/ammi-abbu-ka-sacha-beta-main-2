/**
 * v75 — "UPI ID add karne ka option kaha hai?" (boss 30-10-2026)
 *
 * Boss:
 *   "bhai upi id add karne ka option to de — kaha payment lunga?"
 *
 * Yeh test (offline) proves:
 *   1. Boss panel me 💳 Payment UPI button hai (panel home + fee panel).
 *   2. Panel batata hai paisa KAHAN aayega (order QR fallback + ₹ verification).
 *   3. Set/change flow: state → validate → save → wahi panel turant dikhta hai.
 *   4. Placeholder / galat UPI reject (us QR par paisa nahi aata).
 *   5. Env fallback (BOSS_UPI_ID/UPI_ID) + boot seed — wallet aur order QR ek
 *      hi UPI par.
 *   6. UPI set na ho to boss ko seedha "UPI set karo" button, fake success nahi.
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

const indexSrc = fs.readFileSync('./index.js', 'utf8');
const bossPanelSrc = fs.readFileSync('./boss-panel.js', 'utf8');
const walletSrc = fs.readFileSync('./user-wallet.js', 'utf8');
const { isValidUpiVpa, isPlaceholderUpiId } = await import('./payment-qr-guard.js');

console.log('\n1) Button har jagah (boss ko dikhna chahiye)');
check('boss panel home me Payment UPI button', /boss_upi_panel/.test(bossPanelSrc) && /💳 Payment UPI/.test(bossPanelSrc));
check('fee panel me Payment UPI button', /'💳 Payment UPI', callback_data: 'boss_upi_panel'/.test(indexSrc));
check('panel handler banaya', /bot\.action\('boss_upi_panel'/.test(indexSrc));
check('change handler banaya', /bot\.action\('boss_upi_change'/.test(indexSrc));
check('fee panel par UPI status line', /Payment UPI:<\/b> \$\{upiStatusLine\(\)\}/.test(indexSrc));

console.log('\n2) Panel batata hai paisa kahan aayega');
// v78 (boss 30-10-2026): panel saaf batata hai ki order ka food payment is UPI
// par NAHI aata — sirf verification fee / top-up. Personal UPI ko Swiggy order ka
// QR bana ke bhejna band.
check('panel me saaf likha hai order ka payment yahan nahi aata', /Order ka food payment is UPI par NAHI aata/.test(indexSrc));
check('verification ₹ mention', /order verification/.test(indexSrc));
check('current UPI dikhta hai', /Abhi: \$\{upiStatusLine\(\)\}/.test(indexSrc));
check('set na ho to warning', /UPI set nahi hai/.test(indexSrc));

console.log('\n3) Set / change flow');
check('waiting state set hota hai', /action: 'waiting_boss_upi'/.test(indexSrc));
check('state sirf boss ke liye', /isBoss\(userId\) && state && state\.action === 'waiting_boss_upi'/.test(indexSrc));
check('placeholder reject hota hai', /isPlaceholderUpiId\(candidate\)/.test(indexSrc));
check('format validate hota hai', /isValidUpiVpa\(candidate\)/.test(indexSrc));
check('save ke baad wahi panel', /return sendPaymentUpiPanel\(ctx, \{[\s\S]{0,200}UPI SAVE HO GAYA/.test(indexSrc));
check('save time record hota hai', /bossUpiUpdatedAt/.test(indexSrc));
check('force_reply se type kar sakte hain', /input_field_placeholder: 'name@okaxis'/.test(indexSrc));

console.log('\n4) Validation asli hai');
check('asli UPI ok', isValidUpiVpa('rahul.sharma@okaxis') === true);
check('ybl ok', isValidUpiVpa('9876543210@ybl') === true);
check('bina @ reject', isValidUpiVpa('rahulokaxis') === false);
check('khali reject', isValidUpiVpa('') === false);
check('swiggy placeholder reject', isPlaceholderUpiId('swiggy@icici') === true || isPlaceholderUpiId('upiswiggy@icici') === true);

console.log('\n5) Env fallback + boot seed');
check('walletUpiId env fallback', /process\.env\.BOSS_UPI_ID \|\| process\.env\.UPI_ID/.test(indexSrc));
check('boot par env seed', /bossUpiSeededFromEnv/.test(indexSrc));
check('seed valid UPI par hi', /isValidUpiVpa\(envUpi\) && !isPlaceholderUpiId\(envUpi\)/.test(indexSrc));

console.log('\n6) UPI na ho to honest alert');
check('boss alert me set button', /Payment UPI set karein/.test(indexSrc));
check('boss alert me asli wajah', /UPI set nahi hai — customer paisa bhej hi nahi sakta/.test(indexSrc));
check('customer ko admin raasta', /UPI abhi set nahi — admin se baat karein/.test(indexSrc));
check('verification card UPI leta hai', /formatOrderVerificationCard\(\{/.test(indexSrc));
check('wallet module UPI param', /upiId = ''/.test(walletSrc));

function restoreState() {
  try {
    if (dbSnapshot === null) fs.rmSync(DB_PATH, { force: true });
    else fs.writeFileSync(DB_PATH, dbSnapshot);
    if (mirrorSnapshot === null) fs.rmSync(MIRROR, { force: true });
    else fs.writeFileSync(MIRROR, mirrorSnapshot);
  } catch { /* ignore */ }
}
restoreState();

console.log(`\n${failed === 0 ? '🏆' : '❌'} v75: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
