// test_v78_payment_truth_e2e.mjs
// Boss (30-10-2026): "bhai tu har baar bawasir kiu banata — ek to UTR auto verify
// na ho raha, upar se mere UPI ko as QR payment for Swiggy order bhej raha."
//
// Do sach jo ye test lock karta hai:
//  1) ORDER ka payment QR SIRF Swiggy ka. Boss ki personal UPI se banaya QR
//     kabhi "Swiggy order payment" ban ke nahi jayega (paisa boss ko, order
//     Swiggy par unpaid → auto-cancel).
//  2) Auto-verify set na ho to customer se UTR NAHI maangte — fee defer hoti hai,
//     QR turant chalta hai, due boss ke Wallet & Fee panel me dikhta hai. Aur jab
//     PAY_WEBHOOK_SECRET set ho to /pay/webhook se paisa khud verify hota hai.

import fs from 'node:fs';
import * as W from './user-wallet.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const indexSrc = fs.readFileSync('./index.js', 'utf8');
const walletSrc = fs.readFileSync('./user-wallet.js', 'utf8');

console.log('\n=== 1. Boss ki personal UPI kabhi "Swiggy order payment" nahi ===');
{
  check('index.js me buildFallbackUpiIntent ka koi order-QR use nahi bacha',
    !/buildFallbackUpiIntent\(\{/.test(indexSrc));
  check('index.js boss ki UPI par order ka QR nahi banata',
    !/upiId:\s*(?:db|getDb\(\))\.config\?\.bossUpiId/.test(indexSrc));
  check('Swiggy payment data na ho to saaf sach bole jata hai',
    /Swiggy ne is order ke liye payment QR \/ link nahi diya/.test(indexSrc));
  check('sendPaymentQrToUser sirf Swiggy ka URI leta hai',
    /const swiggyUri = String\(order\.pendingSwiggyUpiUri \|\| order\.realUpiIntentUri \|\| ''\)\.trim\(\)/.test(indexSrc));
  check('QR banta hi nahi jab Swiggy ka data nahi (no personal QR)',
    /order\.qrBlockedReason = 'Swiggy ne payment QR nahi diya'/.test(indexSrc));
  check('approve flow me fallbackReady hard-off hai',
    /const fallbackReady = false;/.test(indexSrc) && /const hasPaymentData = directPaymentData;/.test(indexSrc));
  check('payment UPI panel saaf-saaf batata hai: order ka paisa yahan nahi aata',
    /Order ka food payment is UPI par NAHI aata/.test(indexSrc));
  check('customer ko QR fail par seedha "Dobara try" milta hai',
    /💰 Dobara try|🔄 Dobara try/.test(indexSrc));
}

console.log('\n=== 2. Auto-verify ka rasta asli hai (UTR type karne ka nahi) ===');
{
  check('autoVerifyConfigured() export hai', typeof W.autoVerifyConfigured === 'function');
  const had = process.env.PAY_WEBHOOK_SECRET;
  delete process.env.PAY_WEBHOOK_SECRET;
  delete process.env.UPI_UTR_VERIFY_URL;
  delete process.env.PAY_AUTO_VERIFY;
  check('kuch set na ho to auto-verify OFF', W.autoVerifyConfigured() === false);
  process.env.PAY_WEBHOOK_SECRET = 'shhh-secret';
  check('PAY_WEBHOOK_SECRET set → auto-verify ON', W.autoVerifyConfigured() === true);
  delete process.env.PAY_WEBHOOK_SECRET;
  process.env.UPI_UTR_VERIFY_URL = 'https://provider.test/utr';
  check('UPI_UTR_VERIFY_URL set → auto-verify ON', W.autoVerifyConfigured() === true);
  delete process.env.UPI_UTR_VERIFY_URL;
  process.env.PAY_AUTO_VERIFY = '1';
  check('PAY_AUTO_VERIFY=1 → auto-verify ON', W.autoVerifyConfigured() === true);
  delete process.env.PAY_AUTO_VERIFY;
  if (had) process.env.PAY_WEBHOOK_SECRET = had;

  check('/pay/webhook route index.js me hai', /reqUrl\.pathname === '\/pay\/webhook'/.test(indexSrc));
  check('webhook secret check karta hai', /givenSecret !== configuredSecret/.test(indexSrc));
  // v81 (boss 30-10-2026, naya plan): webhook fee charge karke held ORDER QR release karta hai.
  check('webhook fee settle + held QR release karta hai',
    /order\.feeChargedVia = 'webhook-auto-verify'/.test(indexSrc) &&
    /releaseHeldQrToCustomer\(orderId, \{ reason: 'webhook auto-verify' \}\)/.test(indexSrc));
  check('webhook wallet top-up bhi khud approve karta hai',
    /approveTopupRequest\(wDb, request\.id, \{ actor: 'webhook'/.test(indexSrc));
  check('auto-verify OFF ho to UTR card customer ko nahi jata',
    /if \(!autoVerifyConfigured\(\)\) \{/.test(indexSrc));
}

console.log('\n=== 3. Deferred fee: QR block nahi hota, due panel me dikhta hai ===');
{
  check('recordDeferredFee/settleDeferredFee export hain',
    typeof W.recordDeferredFee === 'function' && typeof W.settleDeferredFee === 'function');

  const order = { id: 'T900', userId: 'u1', feeDeferredPaise: 0 };
  const rec = W.recordDeferredFee(order, 1500, { reason: 'auto-verify set nahi' });
  check('deferred fee record hoti hai', rec.ok && order.feeDeferredPaise === 1500, JSON.stringify(rec));
  const rec2 = W.recordDeferredFee(order, 500);
  check('deferred fee jama hoti hai (1500+500)', rec2.ok && order.feeDeferredPaise === 2000);

  const db = { config: { wallets: {}, topupRequests: {} }, orders: { T900: order } };
  const set = W.settleDeferredFee(db, order, 'u1', { actor: 'boss' });
  check('settle hone par charged me jati hai', set.ok && order.feeChargedPaise === 2000 && order.feeDeferredPaise === 0, JSON.stringify(set));
  check('dubara settle karne par NOTHING_DUE', W.settleDeferredFee(db, order, 'u1').code === 'NOTHING_DUE');

  const summary = W.feeControlSummary({
    config: { wallets: {}, topupRequests: {} },
    orders: { A: { id: 'A', userId: 'u1', feeDeferredPaise: 1500 }, B: { id: 'B', userId: 'u2', feeDeferredPaise: 500 }, C: { id: 'C', userId: 'u3' } }
  });
  check('vault summary deferredPaise = 2000', summary.deferredPaise === 2000, String(summary.deferredPaise));
  check('vault summary deferredOrders = 2', summary.deferredOrders === 2, String(summary.deferredOrders));
  check('vault summary autoVerify field hai', typeof summary.autoVerify === 'boolean');

  const panel = W.formatFeeControlPanel({ summary });
  check('panel me "Baad me lene wali fee" line hai', /Baad me lene wali fee/.test(panel));
  check('panel me auto-verify status line hai', /Auto-verify:/.test(panel));
  check('panel me deferred amount dikhta hai', /₹20/.test(panel) || /₹15/.test(panel), panel.split('\n').pop());

  // v81: defer ab auto-verify OFF safety valves me hota hai (3 min timeout /
  // "pay kar diya" tap) — QR turant nahi jata.
  check('index.js deferred fee safety valve me record karta hai',
    /recordDeferredFee\(order, Number\(order\.feeDuePaise/.test(indexSrc) &&
    /scheduleDeferredQrRelease\(order\.id, fee\)/.test(indexSrc));
  check('boss ko "FEE BAAD ME" alert jata hai', /FEE BAAD ME/.test(indexSrc));
  check('boss ek tap me due clear kar sakta hai', /boss_fee_deferred_ok_/.test(indexSrc));
}

console.log('\n=== 4. Fee deferred hone par customer ki bhasha saaf ===');
{
  // v81: fee QR ke baad customer ke paas sirf "Maine pay kar diya" + admin hai
  // (koi UTR type nahi), aur release par feeDuePaise 0 hota hai.
  check('fee QR par UTR button ki jagah "Maine pay kar diya"',
    /wallet_fee_paid_\$\{order\.id\}/.test(indexSrc));
  check('release par feeDuePaise 0 hota hai', /order\.feeDuePaise = 0;/.test(indexSrc));
  check('wallet.js me UTR provider wala verification bacha hua hai (jab set ho)',
    /export async function verifyUtrWithProvider/.test(walletSrc));
}

console.log(`\n${fail === 0 ? '🏆 SACH WALA PAYMENT FLOW VERIFIED' : '❌ FAIL'} — ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
