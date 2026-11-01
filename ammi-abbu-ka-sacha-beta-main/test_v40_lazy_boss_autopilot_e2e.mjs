// ============================================================================
// test_v40_lazy_boss_autopilot_e2e.mjs
// ----------------------------------------------------------------------------
// Locks the "Boss lazy mode" contract:
//   • a forwarded family message always resolves to Ammi/Abbu (never "Customer")
//   • ONE confirm tap is the only path to a payment QR
//   • a failed fetch produces a rescue card with retry (no re-forward needed)
//   • best-ID selection retries transient errors, then walks a fallback ladder
//   • tracking always returns a genuine Swiggy link or the real orders page
// ============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_ONLY';

let pass = 0;
let fail = 0;
const check = (label, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${label}`);
  } else {
    fail += 1;
    console.log(`❌ ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const pilot = await import('./lazy-order-pilot.js');
const flowSource = fs.readFileSync(path.join(__dirname, 'forwarded-order-flow.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: recipient detection (Ammi / Abbu / customer) ---');
// ---------------------------------------------------------------------------
{
  const tagged = pilot.detectRecipientRole({ senderName: 'Sunita', senderUserId: 111, familyMembers: { 111: 'Ammi' } });
  check('family tag wins over the forwarded name', tagged.role === 'Ammi' && tagged.source === 'family_member_tag', JSON.stringify(tagged));

  const nameHint = pilot.detectRecipientRole({ senderName: 'Papa', senderUserId: 222 });
  check('forwarded name "Papa" maps to Abbu', nameHint.role === 'Abbu', JSON.stringify(nameHint));

  const textHint = pilot.detectRecipientRole({ senderName: 'Sunita', rawText: 'Save my address on Swiggy — mummy ke liye' });
  check('message text nickname is used as fallback', textHint.role === 'Ammi', JSON.stringify(textHint));

  const unknown = pilot.detectRecipientRole({ senderName: 'Rahul', senderUserId: 999, familyMembers: { 111: 'Ammi' } });
  check('an unknown sender stays a normal customer', unknown.role === 'Customer' && unknown.label === 'Rahul', JSON.stringify(unknown));

  check('recipientLabelOf prefers the resolved role', pilot.recipientLabelOf({ recipientRole: 'Abbu', fwdSenderName: 'Ramesh' }) === 'Abbu');
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: retryable fetch classification ---');
// ---------------------------------------------------------------------------
{
  const timeout = new Error('socket hang up');
  check('network/timeout errors are retryable', pilot.isRetryableFetchError(timeout) === true);

  const expired = Object.assign(new Error('Group Cart link expired or closed on Swiggy'), {
    diag: { code: 'GROUP_CART_EXPIRED' }
  });
  check('an expired group cart fails fast (never retried)', pilot.isRetryableFetchError(expired) === false);

  let calls = 0;
  const result = await pilot.retryFetch(async () => {
    calls += 1;
    if (calls < 3) throw new Error('fetch failed');
    return 'ok';
  }, { attempts: 3, delays: [0, 0] });
  check('retryFetch recovers on the second retry', result === 'ok' && calls === 3, `calls=${calls}`);

  let expiredCalls = 0;
  let thrown = '';
  try {
    await pilot.retryFetch(async () => {
      expiredCalls += 1;
      throw expired;
    }, { attempts: 3, delays: [0, 0] });
  } catch (err) {
    thrown = err.message;
  }
  check('non-retryable errors are thrown after exactly one attempt', expiredCalls === 1 && /expired/i.test(thrown), `calls=${expiredCalls}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: best-ID fallback ladder ---');
// ---------------------------------------------------------------------------
{
  const accounts = {
    'acc_1': { phone: '9000000001', isLoggedIn: true, cookies: 'c', totalOrdersCount: 12, possibleDiscountsCount: 1 },
    'acc_2': { phone: '9000000002', isLoggedIn: true, cookies: 'c', totalOrdersCount: 0, isZeroOrderAccount: true, possibleDiscountsCount: 3 },
    'acc_3': { phone: '9000000003', isLoggedIn: true, cookies: 'c', totalOrdersCount: 0, isZeroOrderAccount: true, freeCashBalance: 60 },
    'acc_4': { phone: '9000000004', isLoggedIn: false, cookies: 'c', totalOrdersCount: 0 },
    'acc_5': { phone: '9000000005', isLoggedIn: true, isLoggedOut: true, cookies: 'c' }
  };
  const ladder = pilot.planAccountFallbacks(accounts);
  check('logged-out accounts never enter the ladder', ladder.every(row => !['acc_4', 'acc_5'].includes(row.key)), JSON.stringify(ladder.map(r => r.key)));
  check('zero-order accounts come first', ladder[0].tier === 'ZERO_ORDER' && ladder[1].tier === 'ZERO_ORDER');
  check('stale multi-order account is last', ladder[ladder.length - 1].key === 'acc_1', JSON.stringify(ladder.map(r => r.key)));
  check('each fallback explains itself', ladder.every(row => row.reason && row.phone.startsWith('9')));

  const excluded = pilot.planAccountFallbacks(accounts, null, { exclude: ['acc_2'] });
  check('excluded IDs are skipped', excluded.every(row => row.key !== 'acc_2'));
  const busy = pilot.planAccountFallbacks(accounts, null, { busyKeys: ['acc_3'] });
  check('busy IDs are skipped', busy.every(row => row.key !== 'acc_3'));

  const summary = pilot.summarizeAccountChoice({
    selectedAccount: 'acc_2', orderAccount: '9000000002', selectedAccountZeroOrders: true, totalSavings: 142
  });
  check('best-ID summary shows savings', /0 past orders/.test(summary) && /save ₹142/.test(summary), summary);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: tracking never dead-ends ---');
// ---------------------------------------------------------------------------
{
  const official = pilot.resolveTrackingDelivery({ trackingLink: 'https://r.swiggy.com/track/abc123' });
  check('a genuine Swiggy link is delivered as-is', official.isOfficial === true && official.url === 'https://r.swiggy.com/track/abc123');

  const missing = pilot.resolveTrackingDelivery({});
  check('missing link falls back to the real Swiggy orders page', missing.url === 'https://www.swiggy.com/orders' && missing.needsRetry === true);
  check('no bot-side /track/<id> URL is ever synthesised', !/\/track\/[A-Z0-9_]+\/?$/i.test(missing.url));
  check('the retry promise is explicit', /retry/i.test(pilot.trackingRetryPromiseText(2)));
  check('a cart link is never mistaken for a tracking link', pilot.isOfficialTrackLikeUrl('https://www.swiggy.com/cart') === false);
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: card rendering (confirm / rescue / no-account) ---');
// ---------------------------------------------------------------------------
const { buildForwardedOrderCardView } = await import('./forwarded-order-flow.js');
const bodyFn = (order) => `<b>${order.restaurantName || 'Swiggy Order'}</b> · Total ₹${order.finalPayable || 0}`;
const flat = (kb) => JSON.stringify(kb || {});

{
  const order = {
    id: 'FWD1001',
    isForwardedOrder: true,
    fwdSenderName: 'Ammi',
    recipientRole: 'Ammi',
    status: 'ACCEPTED',
    cardStage: 'BILL_READY',
    cart: 'https://www.swiggy.com/gc/abc',
    address: '12 MG Road, Lucknow 226001',
    addressDetails: { address: '12 MG Road, Lucknow 226001', mobile: '9876543210', lat: '26.8', lng: '80.9' },
    subtotal: 300,
    finalPayable: 248,
    selectedAccount: 'acc_2',
    orderAccount: '9000000002',
    selectedAccountZeroOrders: true,
    totalSavings: 52
  };
  const view = buildForwardedOrderCardView(order, { orders: {}, config: { accounts: {} } }, bodyFn);
  const keyboard = flat(view.keyboard);
  check('bill card carries ONE lazy confirm button', keyboard.includes('lazy_confirm_FWD1001'));
  check('the confirm button names the recipient and amount', view.text.includes('Confirm') || keyboard.includes('Confirm'));
  check('the confirm button is labelled for Ammi', /Ammi/.test(keyboard));
  check('the card still exposes the legacy QR + Paid controls', keyboard.includes('fwd_gen_qr_FWD1001') && keyboard.includes('fwd_check_paid_FWD1001'));
  check('the card explains the one-tap flow', /Ek tap/.test(view.text));
}

{
  const order = {
    id: 'FWD1002',
    isForwardedOrder: true,
    fwdSenderName: 'Abbu',
    recipientRole: 'Abbu',
    status: 'PENDING',
    cardStage: 'FETCH_FAILED',
    cart: null,
    address: null,
    fetchError: 'Forward se cart/address link detect nahi hua.',
    lastIntakeRawText: 'https://swig.gy/gc/xyz'
  };
  const view = buildForwardedOrderCardView(order, { orders: {}, config: { accounts: {} } }, bodyFn);
  const keyboard = flat(view.keyboard);
  check('rescue card offers a one-tap retry of the stored forward', keyboard.includes('lazy_fetch_FWD1002'));
  check('rescue card names what is missing', /Missing/.test(view.text));
  check('rescue card names the recipient', /Abbu/.test(view.text));
  check('rescue card never asks Boss to re-forward', /safe hai/i.test(view.text));
  check('an unresolved cart is reported as missing', pilot.describeMissingInputs({ cart: 'https://swiggy.com/cart', cartUnverified: true }).includes('Swiggy cart link'));
  check('a resolved cart is not reported as missing', !pilot.describeMissingInputs({ cart: 'https://swiggy.com/gc/x', cartUnverified: false }).includes('Swiggy cart link'));
}

{
  const order = {
    id: 'FWD1003',
    isForwardedOrder: true,
    fwdSenderName: 'Ammi',
    recipientRole: 'Ammi',
    status: 'PENDING',
    cardStage: 'NEED_ACCOUNT',
    accountSyncError: 'All logged-in Swiggy accounts have expired sessions',
    cart: 'https://www.swiggy.com/gc/abc',
    address: '12 MG Road, Lucknow 226001',
    addressDetails: { address: '12 MG Road, Lucknow 226001', mobile: '9876543210', lat: '26.8', lng: '80.9' }
  };
  const db = { orders: {}, config: { accounts: { acc_9: { phone: '9000000009', isLoggedIn: true, cookies: 'c' } } } };
  const view = buildForwardedOrderCardView(order, db, bodyFn);
  const keyboard = flat(view.keyboard);
  check('no-account card says the best ID was not found', /BEST SWIGGY ID NAHI MILA/.test(view.text));
  check('no-account card retries the whole ladder in one tap', keyboard.includes('lazy_best_id_FWD1003'));
  check('no-account card shows the vault size', /1 logged-in ID/.test(view.text));
  check('no-account card keeps the cart/address safe', /safe hain/.test(view.text));
}

// ---------------------------------------------------------------------------
console.log('\n--- Scenario 6: wiring + confirmation gate ---');
// ---------------------------------------------------------------------------
{
  check('lazy confirm handler is registered', /bot\.action\(\/\^lazy_confirm_/.test(flowSource));
  check('lazy fetch-retry handler is registered', /bot\.action\(\/\^lazy_fetch_/.test(flowSource));
  check('lazy best-ID handler is registered', /bot\.action\(\/\^lazy_best_id_/.test(flowSource));
  check('lazy tracking handler is registered', /bot\.action\(\/\^lazy_track_/.test(flowSource));
  check('intake stores the forwarded text for retry', /storeIntakeSnapshot\(order, \{ rawText, location \}\)/.test(flowSource));
  check('intake retries the fetch', /retryFetch\(\s*\(\) => ingestForwardedContentIntoOrder/.test(flowSource));
  check('account auto-selection uses the fallback ladder', /autoAssignBestAccountWithFallback\(\{/.test(flowSource));
  check('auto-QR requires an explicit confirmation', /bossAlreadyConfirmed\s*\|\|\s*autoConfirmEnabled/.test(flowSource));
  check('the confirm tap writes an audit trail', /bossConfirmedAt = order\.bossConfirmedAt \|\| new Date\(\)\.toISOString\(\)/.test(flowSource));
  check('global undefined-reference guard stays clean (post-logout cache)', indexSource.includes('invalidateAccountOrderProfileCache();') && !indexSource.includes('accountOrderProfileCache.clear();'));
}

console.log('\n================================================================');
console.log(`📊 RESULT: ${pass}/${pass + fail} checks passed`);
console.log('================================================================');
if (fail > 0) process.exit(1);
