// ============================================================================
// V31 — Scan failure transparency: expired/failed accounts are NAMED, not
// silently counted as "scanned, no order" (order 251630299198497 incident:
// the user's bot said "not found" with zero per-account signal).
//
// IMPORTANT nuance baked in here: Swiggy DAPI does NOT always enforce the tid
// JWT `exp` — the SAME past-exp token was still serving calls in another bot.
// So a past-exp tid must NOT skip an account; the real call is made first and
// only an actual rejection is recorded (with the past-exp hint attached).
// ============================================================================
import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import { getDb, saveDb } from './store.js';
import { scanOrderAcrossAccounts, accountTidExpiryMs } from './swiggy-cart.js';
import { formatBulkVaultImportSummaryHtml } from './account-vault-intake.js';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${label}`); }
  catch (err) { failed += 1; console.log(`❌ ${label}\n   ↳ ${err.message}`); }
}

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function makeJwt(expSeconds, userId = '286684413') {
  return `${b64url({ typ: 'JWT', alg: 'HS256' })}.${b64url({ user_id: userId, iat: expSeconds - 2400, exp: expSeconds })}.sig`;
}
const NOW = Math.floor(Date.now() / 1000);
const PAST_EXP_JWT = makeJwt(NOW - 1500);        // past exp 25 min ago (the 8000958285 case)
const SHORT_JWT = makeJwt(NOW + 1800);           // expires in 30 min
const LONG_JWT = makeJwt(NOW + 30 * 24 * 3600);  // 30-day app session

const ORDER_ID = '251630299198497';
const REAL_OFO_URL = 'http://r.swiggy.com/swiggy/ofo/track/JxFrye5qawn8';

function makeResponse(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
}

const realFetch = globalThis.fetch;
const captured = [];
// `deadCookieReject=true` → the account's session is DEAD, exactly like
// production: web DAPI answers HTTP 200 with `statusCode:401 "Please login
// again"`, and the native android endpoints answer `statusCode:999`.
let deadCookieReject = true;
const isDead = (init) => {
  const hdrs = init?.headers || {};
  const cookie = String(hdrs.Cookie || '');
  return cookie.includes('swiggy_dead_marker')
    || Object.values(hdrs).some(v => String(v).includes('tok-dead-marker'));
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  captured.push({ url: u, cookie: String(init?.headers?.Cookie || '') });
  if (deadCookieReject && isDead(init)) {
    if (u.includes('chkout.swiggy.com') || u.includes('profile.swiggy.com')) {
      return makeResponse({ statusCode: 999, statusMessage: 'Session expired', data: {} });
    }
    return makeResponse({ statusCode: 401, statusMessage: 'Please login again', data: {} });
  }
  if (String(url).includes('/dapi/order/all')) {
    return makeResponse({ statusCode: 0, tid: LONG_JWT, data: { orders: [{ order_id: ORDER_ID, order_status: 'Processing', restaurant_name: 'Sanjay Sweets', order_total: 40 }] } });
  }
  if (String(url).includes('/dapi/order/details')) {
    return makeResponse({ statusCode: 0, data: { orders: [{ order_id: ORDER_ID, order_status: 'processing', restaurant_name: 'Sanjay Sweets' }] } });
  }
  if (String(url).includes('/dapi/order/trackV4')) {
    return makeResponse({ statusCode: 0, data: { order_status_details: { status_message: 'Order accepted by restaurant' }, ofo_details: { share_data: { share_url: REAL_OFO_URL } } } });
  }
  if (String(url).includes('/dapi/order/trackV2/de')) {
    return makeResponse({ statusCode: 0, data: { otp: '4821' } });
  }
  return makeResponse({ statusCode: 0, data: {} });
};

const rawDbDiskBackup = fs.existsSync('data/db.json') ? fs.readFileSync('data/db.json', 'utf8') : null;
const dbBackup = JSON.parse(JSON.stringify(getDb()));

const expiredAcc = {
  name: 'Rahul Kumar', phone: '8000958285', customerId: '286684413',
  token: 'tok-dead-marker', tid: PAST_EXP_JWT, sid: 's1', deviceId: 'd1',
  cookies: `swiggy_dead_marker=1 _session_tid=x; token=tok-dead-marker; tid=${PAST_EXP_JWT}`,
  isLoggedIn: true
};
const aliveAcc = {
  name: 'prithvi', phone: '9935123518', customerId: '283703858',
  token: 'tok-alive', tid: LONG_JWT, sid: 's2', deviceId: 'd2',
  cookies: `alive-cookies _session_tid=y; token=tok-alive; tid=${LONG_JWT}`,
  isLoggedIn: true
};

try {
  const db = getDb();
  db.config.accounts = { ...db.config.accounts, acc_exp: expiredAcc, acc_alive: aliveAcc };
  db.orders.V31_A = {
    id: 'V31_A', status: 'COMPLETED', swiggyOrderId: ORDER_ID, pendingSwiggyOrderId: ORDER_ID,
    selectedAccount: 'acc_exp', createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
  };
  saveDb(db);

  await check('accountTidExpiryMs decodes past-exp/short/long tids correctly', () => {
    assert.ok(accountTidExpiryMs(expiredAcc) < Date.now(), 'past-exp tid detected');
    const shortExp = accountTidExpiryMs({ ...aliveAcc, tid: SHORT_JWT });
    assert.ok(shortExp > Date.now() && shortExp < Date.now() + 3600_000, 'short tid detected');
    assert.ok(accountTidExpiryMs(aliveAcc) > Date.now() + 29 * 24 * 3600_000, 'long tid detected');
    assert.strictEqual(accountTidExpiryMs({ cookies: 'no tid here' }), null);
  });

  await check('Rejection on the dead session is NAMED (with past-exp hint); order found on the alive account', async () => {
    captured.length = 0;
    const scan = await scanOrderAcrossAccounts(ORDER_ID, { budgetMs: 15000, deep: true, getAccountsFn: () => ({ acc_exp: expiredAcc, acc_alive: aliveAcc }) });
    assert.strictEqual(scan.hasOrder, true, `order must be found via alive account: status=${scan.status}`);
    assert.strictEqual(scan.trackingUrl, REAL_OFO_URL);
    const fails = (scan.failures || []).filter(f => f.phone === '8000958285');
    assert.strictEqual(fails.length, 1, `failures must name the rejected account: ${JSON.stringify(scan.failures)}`);
    assert.ok(['SESSION_EXPIRED', 'AUTH_FAILED'].includes(fails[0].reason), `reason=${fails[0].reason}`);
    assert.ok(/tid past exp/.test(fails[0].detail || ''), `past-exp hint in detail: ${fails[0].detail}`);
    // The past-exp account was NOT pre-skipped — the real call went out.
    assert.ok(captured.some(c => c.cookie.includes('swiggy_dead_marker')), 'no pre-skip: the real DAPI call must be attempted');
    // okScanned must count only the account that actually returned a list.
    assert.strictEqual(scan.okScanned, 1, `okScanned=${scan.okScanned}`);
    assert.deepStrictEqual(scan.okScannedPhones, ['9935123518']);
  });

  await check('Swiggy STILL ACCEPTS a past-exp tid → account is scanned normally, NO false "expired" failure', async () => {
    // The other-bot fact: the same past-exp token was serving calls at 3:14 PM.
    deadCookieReject = false;
    captured.length = 0;
    delete expiredAcc.sessionExpired;
    expiredAcc.isLoggedIn = true;
    const scan = await scanOrderAcrossAccounts(ORDER_ID, { budgetMs: 15000, deep: true, getAccountsFn: () => ({ acc_exp: expiredAcc }) });
    assert.strictEqual(scan.hasOrder, true, `order must be found via the past-exp-tid account: status=${scan.status} ${JSON.stringify(scan.failures)}`);
    assert.strictEqual((scan.failures || []).length, 0, 'no failure may be recorded when Swiggy accepts the calls');
    assert.strictEqual(scan.okScanned, 1);
    assert.deepStrictEqual(scan.okScannedPhones, ['8000958285']);
    deadCookieReject = true;
  });

  await check('When the account is rejected, NOT_FOUND carries the per-account failure + okScanned=0', async () => {
    // Fresh cookie value → fresh `sig` → bypasses the 45s sessionAuthCache
    // that test 2 (accepted) populated for the identical cookies.
    delete expiredAcc.sessionExpired;
    expiredAcc.isLoggedIn = true;
    const freshSigAcc = { ...expiredAcc, cookies: expiredAcc.cookies.replace('swiggy_dead_marker=1', 'swiggy_dead_marker=2') };
    const scan = await scanOrderAcrossAccounts('259999999999999', { budgetMs: 12000, deep: true, getAccountsFn: () => ({ acc_exp: freshSigAcc }) });
    assert.strictEqual(scan.hasOrder, false);
    assert.strictEqual(scan.status, 'NOT_FOUND');
    assert.strictEqual(scan.okScanned, 0);
    assert.ok(Array.isArray(scan.failures) && scan.failures.length === 1, 'one failure recorded');
    assert.ok(['SESSION_EXPIRED', 'AUTH_FAILED'].includes(scan.failures[0].reason));
    assert.strictEqual(scan.failures[0].phone, '8000958285');
  });

  await check('Import summary warns about short-lived sessions at save time', () => {
    const result = {
      savedAccounts: [
        { key: 'acc_short', account: { phone: '8000958285', tid: SHORT_JWT } },
        { key: 'acc_long', account: { phone: '9935123518', tid: LONG_JWT } }
      ],
      zeroOrderCount: 0, usedAccountCount: 1, expiredList: [], parseErrors: [],
      totalVaultActiveCount: 2, totalVaultZeroOrderCount: 0
    };
    const html = formatBulkVaultImportSummaryHtml(result, 1);
    assert.ok(/Short session \(1\)/.test(html), `summary must flag the short session: ${html.slice(0, 300)}`);
    assert.ok(html.includes('8000958285'), 'short-session phone shown');
  });
} finally {
  globalThis.fetch = realFetch;
  try {
    if (rawDbDiskBackup !== null) fs.writeFileSync('data/db.json', rawDbDiskBackup, 'utf8');
    saveDb(JSON.parse(JSON.stringify(dbBackup)));
  } catch {}
}

console.log(`\n================================================================\n📊 V31 RESULT: ${passed}/${passed + failed} scan-failure-transparency checks passed${failed ? ` — ${failed} FAILED` : ''}\n================================================================`);
process.exit(failed ? 1 : 0);
