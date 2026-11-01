import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getDb,
  saveDb,
  createAccount,
  updateAccount,
  deleteAccount,
  permanentLogoutAccount,
  importSessionJson,
  isAccountLoggedInSession,
  findAccountKeyByPhone,
} from './store.js';
import {
  requestSwiggyOtpViaBridge,
  verifySwiggyOtpViaBridge,
  signupSwiggyViaBridge,
  requestSwiggyDeleteOtpViaBridge,
  verifyAndDeleteSwiggyAccountViaBridge,
  deactivateSwiggyAccountViaBridge,
  claimSwiggyBreakfastAndLateNightOffers,
  parseSwiggyOtpError,
} from './swiggy-bridge.js';

const realFetch = globalThis.fetch;

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`✅ [PASS ${String(passed).padStart(2, '0')}] ${label}`);
}

function makeJwtTid(userId = '99887766', expOffsetSec = 86400 * 25) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    user_id: String(userId),
    exp: Math.floor(Date.now() / 1000) + expOffsetSec,
  })).toString('base64url');
  return `${header}.${payload}.sig_v28`;
}

function jsonResponse(bodyObj, { status = 200, setCookies = [], extraHeaders = {} } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...extraHeaders });
  for (const ck of setCookies) headers.append('set-cookie', ck);
  return new Response(JSON.stringify(bodyObj), { status, headers });
}

function htmlResponse(htmlText, { status = 200, setCookies = [], extraHeaders = {} } = {}) {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', ...extraHeaders });
  for (const ck of setCookies) headers.append('set-cookie', ck);
  return new Response(htmlText, { status, headers });
}

try {
  console.log('========================================================================');
  console.log('🧪 V28 E2E SUITE: ANTI-BOT FAST OTP + NEW ACCOUNT SIGNUP + SAFE DELETE');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // SCENARIO 1: Sub-second Anti-Bot Pure-HTTP OTP Dispatch + Coalescing + CSRF
  // -------------------------------------------------------------------------
  {
    let smsOtpCalls = 0;
    let capturedSmsBody = null;
    let capturedSmsHeaders = null;

    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/web-cart-add-address')) {
        return htmlResponse('<html><script>window._csrf = "csrf_tok_live_101";</script></html>', {
          setCookies: [
            '_csrf=secret_101; Path=/; HttpOnly',
            '_guest_tid=guest_tid_101; Path=/',
            '_sid=sid_101; Path=/'
          ]
        });
      }
      if (u.includes('/dapi/auth/sms-otp')) {
        smsOtpCalls++;
        await new Promise(r => setTimeout(r, 20));
        capturedSmsBody = JSON.parse(init.body || '{}');
        capturedSmsHeaders = init.headers || {};
        return jsonResponse({ statusCode: 0, statusMessage: 'OTP sent successfully' });
      }
      if (u.includes('/dapi/auth/otp-verify')) {
        const body = JSON.parse(init.body || '{}');
        assert.equal(body._csrf, 'csrf_tok_live_101', 'otp-verify must send paired _csrf token');
        return jsonResponse(
          { statusCode: 0, statusMessage: 'done successfully', tid: makeJwtTid('44556677'), sid: 'sid_auth_101', data: { name: 'Aman Verma' } },
          { setCookies: [`_session_tid=${'a'.repeat(64)}; Path=/; HttpOnly`, '_is_logged_in=1; Path=/'] }
        );
      }
      if (u.includes('/dapi/profile/info')) {
        return jsonResponse({
          statusCode: 0,
          tid: makeJwtTid('44556677'),
          sid: 'sid_auth_101',
          deviceId: 'dev_101',
          data: { customer_id: '44556677', name: 'Aman Verma', email: 'aman@example.com', token: 'tok_live_44556677' }
        });
      }
      if (u.includes('/dapi/order/all')) {
        return jsonResponse({ statusCode: 0, data: { orders: [{ order_id: 1 }, { order_id: 2 }] } });
      }
      if (u.includes('events.swiggy.com/api/notify')) {
        return jsonResponse({ shouldNotify: true, value: 1, message: 'Booked' });
      }
      return jsonResponse({ statusCode: 0 });
    };

    const t0 = Date.now();
    // Fire TWO simultaneous OTP requests for the same user & phone -> must coalesce into ONE Swiggy SMS call!
    const [otpRes1, otpRes2] = await Promise.all([
      requestSwiggyOtpViaBridge(7001, '9876543211', 'acc_9876543211', 'Aman'),
      requestSwiggyOtpViaBridge(7001, '+91 9876543211', 'acc_9876543211', 'Aman'),
    ]);
    const elapsedOtpMs = Date.now() - t0;

    ok(otpRes1.success === true && otpRes2.success === true, 'Pure-HTTP OTP dispatch succeeds without Chromium');
    ok(smsOtpCalls === 1, `Concurrent double-tap coalesced into 1 SMS call (got ${smsOtpCalls})`);
    ok(elapsedOtpMs < 400, `OTP dispatch latency ultra-fast: ${elapsedOtpMs}ms (<400ms budget)`);
    ok(capturedSmsBody?._csrf === 'csrf_tok_live_101' && capturedSmsBody?.mobile === '9876543211', 'POST /dapi/auth/sms-otp includes paired _csrf token + normalized 10-digit mobile');
    ok(String(capturedSmsHeaders?.Cookie || '').includes('_csrf=secret_101') && String(capturedSmsHeaders?.Cookie || '').includes('_device_id='), 'Anti-bot Cookie jar sends _csrf secret + deterministic _device_id');

    // Immediate accidental tap 50ms later should also be deduplicated without firing SMS #2
    const otpRes3 = await requestSwiggyOtpViaBridge(7001, '9876543211', 'acc_9876543211', 'Aman');
    ok(otpRes3.success === true && otpRes3.deduplicated === true && smsOtpCalls === 1, 'Rapid 3.5s anti-spam shield prevents duplicate OTP dispatch');

    const tVerify0 = Date.now();
    const verRes = await verifySwiggyOtpViaBridge(7001, '482910');
    const elapsedVerifyMs = Date.now() - tVerify0;

    ok(verRes.success === true && verRes.customerId === '44556677', 'OTP verify succeeds and resolves real numeric customerId');
    ok(verRes.totalOrdersCount === 2 && verRes.isZeroOrderAccount === false, 'Existing account order count hydrated immediately');
    ok(elapsedVerifyMs < 500, `OTP verify + offer pre-lock completed in ${elapsedVerifyMs}ms (<500ms budget)`);

    const saved = getDb().config.accounts.acc_9876543211;
    ok(isAccountLoggedInSession(saved) && saved.cookies.includes('_session_tid=') && saved.token === 'tok_live_44556677', 'Verified account persisted with _session_tid + native token');
    deleteAccount('acc_9876543211', { purgeVault: true, skipImmediateCloudPush: true });
    delete getDb().config.deletedAccounts.acc_9876543211;
  }

  // -------------------------------------------------------------------------
  // SCENARIO 2: Auto-Recovery from Stale CSRF 403 & AWS WAF 202 Transport Switch
  // -------------------------------------------------------------------------
  {
    let csrfBootCount = 0;
    let smsTries = 0;

    // Verify parseSwiggyOtpError does NOT misclassify CSRF 403 as non-retryable WAF block
    const csrfDiag = parseSwiggyOtpError({ status: 403, rawText: 'invalid csrf token', data: { statusMessage: 'invalid csrf token' } });
    ok(csrfDiag.code === 'SWIGGY_CSRF_EXPIRED' && csrfDiag.retryable === true, 'parseSwiggyOtpError distinguishes CSRF 403 from AWS WAF challenge');

    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/web-cart-add-address')) {
        csrfBootCount++;
        const tok = `csrf_gen_${csrfBootCount}`;
        return htmlResponse(`<script>window._csrf = "${tok}";</script>`, {
          setCookies: [`_csrf=sec_${csrfBootCount}; Path=/`, '_guest_tid=gt_2; Path=/']
        });
      }
      if (u.includes('/dapi/order/all')) {
        return jsonResponse({ statusCode: 0, csrfToken: 'csrf_android_ok', tid: 'gt_android', sid: 'sid_android' });
      }
      if (u.includes('/dapi/auth/sms-otp')) {
        smsTries++;
        const ua = init.headers?.['User-Agent'] || '';
        const body = JSON.parse(init.body || '{}');
        if (smsTries === 1) {
          // 1st attempt: stale CSRF 403
          return jsonResponse({ statusCode: 1, statusMessage: 'invalid csrf token' }, { status: 403 });
        }
        if (smsTries === 2 && ua !== 'Swiggy-Android') {
          // 2nd attempt on mWeb: simulate AWS WAF 202 challenge -> triggers automatic switch to Swiggy-Android!
          return new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } });
        }
        assert.equal(ua, 'Swiggy-Android', '3rd attempt must automatically use Swiggy-Android transport');
        assert.ok(body._csrf, '_csrf must be populated after transport switch');
        return jsonResponse({ statusCode: 0, statusMessage: 'OTP sent' });
      }
      return jsonResponse({ statusCode: 0 });
    };

    const wafRes = await requestSwiggyOtpViaBridge(7002, '9876543212', 'acc_9876543212', 'Rohan');
    ok(wafRes.success === true && smsTries === 3, 'Automatically recovered from stale CSRF 403 AND mWeb WAF 202 via Swiggy-Android transport');
    await deactivateSwiggyAccountViaBridge(7002, 'acc_9876543212', false);
  }

  // -------------------------------------------------------------------------
  // SCENARIO 3: Brand-New Unregistered Account Signup (Both Clusters + Email Collision + 0-Order Tag)
  // -------------------------------------------------------------------------
  {
    // 3A: Signup-First Cluster with 1st-attempt email collision -> auto-regenerates email -> verifies -> 0-order account!
    let signupCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/web-cart-add-address')) {
        return htmlResponse('<script>window._csrf = "csrf_new_3a";</script>', {
          setCookies: ['_csrf=sec_3a; Path=/', '_guest_tid=gt_3a; Path=/', '_sid=sid_3a; Path=/']
        });
      }
      if (u.includes('/dapi/auth/sms-otp')) {
        return jsonResponse({ statusCode: 1, statusMessage: 'Mobile number is not registered' });
      }
      if (u.includes('/dapi/auth/signup')) {
        signupCalls++;
        const body = JSON.parse(init.body || '{}');
        assert.equal(body._csrf, 'csrf_new_3a', 'signup must include _csrf');
        if (signupCalls === 1) {
          return jsonResponse({ statusCode: 1, statusMessage: 'Email id already exists' });
        }
        return jsonResponse({ statusCode: 0, statusMessage: 'OTP sent successfully' });
      }
      if (u.includes('/dapi/auth/otp-verify')) {
        return jsonResponse(
          { statusCode: 0, statusMessage: 'done successfully', tid: makeJwtTid('88001122'), sid: 'sid_3a_auth' },
          { setCookies: [`_session_tid=${'b'.repeat(64)}; Path=/; HttpOnly`, '_is_logged_in=1; Path=/'] }
        );
      }
      if (u.includes('/dapi/profile/info')) {
        return jsonResponse({
          statusCode: 0,
          tid: makeJwtTid('88001122'),
          data: { customer_id: '88001122', name: 'Naya Dost', token: 'tok_new_88001122' }
        });
      }
      if (u.includes('events.swiggy.com/api/notify')) {
        return jsonResponse({ shouldNotify: true, value: 1, message: 'Booked' });
      }
      return jsonResponse({ statusCode: 0 });
    };

    const req3a = await requestSwiggyOtpViaBridge(7003, '9876543213', 'naya_dost', 'Naya Dost');
    ok(req3a.success === true && req3a.isNewUser === true && signupCalls === 2, 'New number signup auto-recovered from email collision and dispatched OTP');

    const ver3a = await verifySwiggyOtpViaBridge(7003, '112233');
    ok(ver3a.success === true && ver3a.wasNewSignup === true, 'New account OTP verification succeeded in 1 step');
    ok(ver3a.customerId === '88001122' && ver3a.customerId !== 'RegisteredUser', 'New account stores real numeric customerId (never dummy RegisteredUser)');
    ok(ver3a.totalOrdersCount === 0 && ver3a.isZeroOrderAccount === true, 'New account automatically tagged as 0-Order (isZeroOrderAccount: true) for Max Coupon picker');

    // 3B: OTP-First Cluster (`sms-otp` returns 0, then `otp-verify` says `User does not exist` -> auto-completes `/dapi/auth/signup` with OTP!)
    let otpFirstSignupCalled = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/web-cart-add-address')) {
        return htmlResponse('<script>window._csrf = "csrf_new_3b";</script>', {
          setCookies: ['_csrf=sec_3b; Path=/', '_guest_tid=gt_3b; Path=/']
        });
      }
      if (u.includes('/dapi/auth/sms-otp')) {
        return jsonResponse({ statusCode: 0, statusMessage: 'OTP sent' });
      }
      if (u.includes('/dapi/auth/otp-verify')) {
        return jsonResponse({ statusCode: 1, statusMessage: 'User does not exist, please sign up' });
      }
      if (u.includes('/dapi/auth/signup')) {
        const body = JSON.parse(init.body || '{}');
        otpFirstSignupCalled = Boolean(body.otp === '778899' && body._csrf === 'csrf_new_3b');
        return jsonResponse(
          { statusCode: 0, statusMessage: 'Account created', tid: makeJwtTid('88003344') },
          { setCookies: [`_session_tid=${'c'.repeat(64)}; Path=/; HttpOnly`, '_is_logged_in=1; Path=/'] }
        );
      }
      if (u.includes('/dapi/profile/info')) {
        return jsonResponse({ statusCode: 0, tid: makeJwtTid('88003344'), data: { customer_id: '88003344', token: 'tok_3b' } });
      }
      if (u.includes('events.swiggy.com/api/notify')) {
        return jsonResponse({ shouldNotify: true, value: 1 });
      }
      return jsonResponse({ statusCode: 0 });
    };

    const req3b = await requestSwiggyOtpViaBridge(7004, '9876543214', 'acc_9876543214', 'Zaid');
    ok(req3b.success === true, 'OTP-first new number dispatched SMS cleanly');
    const ver3b = await verifySwiggyOtpViaBridge(7004, '778899');
    ok(ver3b.success === true && otpFirstSignupCalled === true && ver3b.isZeroOrderAccount === true, 'OTP-first cluster auto-completed /dapi/auth/signup with OTP + _csrf seamlessly');

    // 3C: Explicit `signupSwiggyViaBridge` after failed/deferred verify preserves `session.otp` (regression test for L1678 bug!)
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/web-cart-add-address')) {
        return htmlResponse('<script>window._csrf = "csrf_3c";</script>', { setCookies: ['_csrf=sec_3c; Path=/'] });
      }
      if (u.includes('/dapi/auth/sms-otp')) {
        return jsonResponse({ statusCode: 0 });
      }
      if (u.includes('/dapi/auth/otp-verify')) {
        return jsonResponse({ statusCode: 1, statusMessage: 'Temporary defer' });
      }
      if (u.includes('/dapi/auth/signup')) {
        const body = JSON.parse(init.body || '{}');
        assert.equal(body.otp, '334455', 'signupSwiggyViaBridge must receive stored session.otp');
        return jsonResponse(
          { statusCode: 0, tid: makeJwtTid('88005566') },
          { setCookies: [`_session_tid=${'d'.repeat(64)}; Path=/`, '_is_logged_in=1; Path=/'] }
        );
      }
      if (u.includes('/dapi/profile/info')) {
        return jsonResponse({ statusCode: 0, data: { customer_id: '88005566', token: 'tok_3c' } });
      }
      return jsonResponse({ statusCode: 0 });
    };

    await requestSwiggyOtpViaBridge(7005, '9876543215', 'acc_9876543215', 'Kabir');
    await verifySwiggyOtpViaBridge(7005, '334455');
    const manualSignup = await signupSwiggyViaBridge(7005, 'Kabir Khan');
    ok(manualSignup.success === true && manualSignup.customerId === '88005566', 'signupSwiggyViaBridge succeeds with preserved session.otp (L1678 bug eliminated)');

    deleteAccount('naya_dost', { purgeVault: true, skipImmediateCloudPush: true });
    deleteAccount('acc_9876543214', { purgeVault: true, skipImmediateCloudPush: true });
    deleteAccount('acc_9876543215', { purgeVault: true, skipImmediateCloudPush: true });
  }

  // -------------------------------------------------------------------------
  // SCENARIO 4: Custom Named Slot + Duplicate Phone Consolidation & Tombstone Safety
  // -------------------------------------------------------------------------
  {
    // First create auto slot `acc_9876500022`, then create custom slot `chacha` for same phone `9876500022`
    updateAccount('acc_9876500022', {
      name: 'Swiggy 9876500022',
      phone: '9876500022',
      mobile: '9876500022',
      token: 'tok_dup_22',
      tid: makeJwtTid('770022'),
      cookies: `_session_tid=${'e'.repeat(64)}; _is_logged_in=1`,
      totalOrdersCount: 0,
      isZeroOrderAccount: true,
      isLoggedIn: true,
    });
    createAccount('chacha', 'Chacha Ji', '9876500022');
    updateAccount('chacha', {
      name: 'Chacha Ji',
      phone: '9876500022',
      mobile: '9876500022',
      token: 'tok_dup_22_new',
      tid: makeJwtTid('770022'),
      cookies: `_session_tid=${'f'.repeat(64)}; _is_logged_in=1`,
      isLoggedIn: true,
    });

    const dbAfterMerge = getDb();
    ok(Boolean(dbAfterMerge.config.accounts.chacha) && !dbAfterMerge.config.accounts.acc_9876500022, 'Duplicate acc_<phone> slot automatically consolidated into Boss custom named slot');
    ok(dbAfterMerge.config.accounts.chacha.isZeroOrderAccount === true, 'Consolidated slot preserved 0-Order metadata from prior slot');
    ok(findAccountKeyByPhone(dbAfterMerge.config.accounts, '9876500022') === 'chacha', 'findAccountKeyByPhone resolves custom named slot accurately');

    // Hold a stale concurrent fiber snapshot BEFORE deleting `chacha`!
    const staleConcurrentFiberDb = getDb();
    assert.ok(staleConcurrentFiberDb.config.accounts.chacha, 'Stale fiber holds chacha before delete');

    const delOk = deleteAccount('chacha', { purgeVault: true, skipImmediateCloudPush: true });
    ok(delOk === true && !getDb().config.accounts.chacha, 'deleteAccount removed custom slot cleanly');
    ok(getDb().config.deletedAccounts.chacha === true && getDb().config.deletedAccounts.acc_9876500022 === true, 'deleteAccount tombstoned BOTH custom key and acc_<phone> key');

    // Now simulate background fiber saving its stale snapshot 200ms AFTER deletion!
    staleConcurrentFiberDb.config.slotsLeft = staleConcurrentFiberDb.config.slotsLeft;
    saveDb(staleConcurrentFiberDb);

    const dbAfterConcurrentSave = getDb();
    ok(!dbAfterConcurrentSave.config.accounts.chacha && !dbAfterConcurrentSave.config.accounts.acc_9876500022, 'Concurrent stale saveDb() NEVER resurrects a deleted account');
    ok(dbAfterConcurrentSave.config.deletedAccounts.chacha === true && dbAfterConcurrentSave.config.deletedAccounts.acc_9876500022 === true, 'Concurrent stale saveDb() preserves deletion tombstones');

    // Re-importing same phone later clears BOTH tombstones cleanly!
    const reImp = importSessionJson({
      phone: '9876500022',
      name: 'Chacha Reloaded',
      tid: makeJwtTid('770022'),
      token: 'tok_reloaded_22',
      cookies: `_session_tid=${'f'.repeat(64)}; _is_logged_in=1`,
    });
    ok(reImp.success === true && !getDb().config.deletedAccounts.acc_9876500022, 'Re-importing deleted phone clears tombstones cleanly');
    deleteAccount(reImp.key, { purgeVault: true, skipImmediateCloudPush: true });
  }

  // -------------------------------------------------------------------------
  // SCENARIO 5: Swiggy Server Delete for Token-Only Android Account + Stale CSRF Retry + Wrong OTP Retry
  // -------------------------------------------------------------------------
  {
    importSessionJson({
      phone: '9876500033',
      name: 'Token Only User',
      tid: makeJwtTid('66554433'),
      token: 'android_tok_0033',
      sid: 'sid_0033',
      deviceId: 'dev_0033',
      // Notice: NO `_session_tid` cookie — pure Android token-only import!
      cookies: '',
    }, 'acc_9876500033');

    ok(isAccountLoggedInSession(getDb().config.accounts.acc_9876500033), 'Token-only Android session recognized as logged-in');

    let deletePostAttempts = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/web-cart-add-address')) {
        // Bootstrap `_session_tid` + `window._csrf`
        return htmlResponse('<script>window._csrf = "csrf_del_fresh_33";</script>', {
          setCookies: [`_session_tid=${'9'.repeat(64)}; Path=/; HttpOnly`, '_csrf=sec_del_33; Path=/']
        });
      }
      if (u.includes('/mapi/auth/delete/userCheck')) {
        assert.ok(String(init.headers?.Cookie || '').includes('_session_tid='), 'userCheck must receive bootstrapped _session_tid');
        // Intentionally omit `csrfToken` in JSON to test fallback CSRF extraction!
        return jsonResponse({ statusCode: 28, statusMessage: 'Archive OTP Sent' });
      }
      if (u.includes('/mapi/auth/delete/user')) {
        deletePostAttempts++;
        const body = JSON.parse(init.body || '{}');
        if (body.otp === '000000') {
          return jsonResponse({ statusCode: 29, statusMessage: 'Invalid OTP entered' });
        }
        if (deletePostAttempts === 2) {
          // Simulate expired CSRF 403 on first valid OTP submit -> must auto-refresh CSRF and succeed!
          return jsonResponse({ statusCode: 1, statusMessage: 'invalid csrf token' }, { status: 403 });
        }
        assert.equal(body._csrf, 'csrf_del_fresh_33', 'POST /mapi/auth/delete/user must include refreshed _csrf');
        return jsonResponse({ statusCode: 33, statusMessage: 'Account deleted permanently' });
      }
      return jsonResponse({ statusCode: 0 });
    };

    const delOtpRes = await requestSwiggyDeleteOtpViaBridge(7009, '9876500033', 'acc_9876500033', 'Token Only User');
    ok(delOtpRes.success === true, 'Token-only Android account bootstrapped _session_tid and dispatched Swiggy Delete OTP');

    // Wrong OTP attempt first -> must NOT wipe activeDeleteSessions!
    const wrongDelVerify = await verifyAndDeleteSwiggyAccountViaBridge(7009, '000000', 'acc_9876500033');
    ok(wrongDelVerify.success === false && /invalid otp/i.test(wrongDelVerify.message), 'Wrong Delete OTP rejected cleanly while keeping delete session alive');

    // Correct OTP -> auto-recovers from stale CSRF 403 -> deletes permanently!
    const rightDelVerify = await verifyAndDeleteSwiggyAccountViaBridge(7009, '654321', 'acc_9876500033');
    ok(rightDelVerify.success === true && deletePostAttempts === 3, 'Swiggy Server Delete auto-refreshed stale CSRF and permanently deleted account');

    deleteAccount('acc_9876500033', { purgeVault: true, skipImmediateCloudPush: true });
  }

  // -------------------------------------------------------------------------
  // SCENARIO 6: Parallel 15-Day Offer Claiming Latency Benchmark
  // -------------------------------------------------------------------------
  {
    let notifyCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('events.swiggy.com/api/notify')) {
        notifyCalls++;
        await new Promise(r => setTimeout(r, 25));
        return jsonResponse({ shouldNotify: true, value: 1, timestamp: '2026-10-22T00:10:00.000Z' });
      }
      return jsonResponse({ statusCode: 0 });
    };

    const dummyAcc = {
      id: 'bench_acc_v28',
      phone: '9876500099',
      tid: makeJwtTid('550099'),
      token: 'tok_bench_99',
      cookies: `_session_tid=${'7'.repeat(64)}; _is_logged_in=1`,
    };

    const tFull = Date.now();
    const fullClaim = await claimSwiggyBreakfastAndLateNightOffers(dummyAcc, { force: true });
    const fullMs = Date.now() - tFull;
    ok(fullClaim.bothClaimed === true && fullMs < 600, `Parallel 15-day offer lock completed in ${fullMs}ms (<600ms vs 1500ms+ sequential)`);
  }

  console.log(`\n========================================================================`);
  console.log(`🏆 ALL ${passed}/${passed} V28 AUTH + NEW ACCOUNT + DELETE + ANTI-BOT TESTS PASSED!`);
  console.log(`========================================================================`);
} finally {
  globalThis.fetch = realFetch;
  try {
    const curDb = JSON.parse(fs.readFileSync('./data/db.json', 'utf8'));
    for (const testKey of ['acc_9876543210', 'acc_9876543211', 'acc_9876543212', 'acc_9876500033', 'acc_9876500034', 'acc_9876500035']) {
      delete curDb.config?.accounts?.[testKey];
      delete curDb.sessionVault?.[testKey];
      delete curDb.config?.deletedAccounts?.[testKey];
    }
    fs.writeFileSync('./data/db.json', JSON.stringify(curDb, null, 2), 'utf8');
  } catch {}
}
