// ============================================================================
// V23 — Automatic Swiggy tracking + Boss dashboard (order id · tracking · phone)
// ============================================================================
// Proves the user-facing contract:
//   • the bot fetches the real Swiggy share link by itself ("My Orders" scan)
//   • a short/unknown number can never borrow another order's tracking link
//   • the dashboard always shows Swiggy order id + tracking + placed-from phone
//   • no literal `${...}` / "\n" junk leaks into Telegram HTML

import './network-shield.js';
import assert from 'assert';
import fs from 'node:fs';

// Yeh test ek fake tracking link (TARGET123) asli order id par save karta hai.
// Store ab orders ko honest tareeke se disk par rakhta hai (pehle woh write
// chup-chaap kho jata tha), isliye test ke baad state wapas kar dena zaroori
// hai — warna baad ke test (v26) us fake link ko asli samajh lete hain.
const DB_PATH_V23 = 'data/db.json';
const ACC_PATH_V23 = 'accounts.json';
const dbSnapV23 = fs.existsSync(DB_PATH_V23) ? fs.readFileSync(DB_PATH_V23, 'utf8') : null;
const accSnapV23 = fs.existsSync(ACC_PATH_V23) ? fs.readFileSync(ACC_PATH_V23, 'utf8') : null;
process.on('exit', () => {
  try {
    if (dbSnapV23 !== null) fs.writeFileSync(DB_PATH_V23, dbSnapV23);
    else if (fs.existsSync(DB_PATH_V23)) fs.unlinkSync(DB_PATH_V23);
  } catch {}
  try {
    if (accSnapV23 !== null) fs.writeFileSync(ACC_PATH_V23, accSnapV23);
    else if (fs.existsSync(ACC_PATH_V23)) fs.unlinkSync(ACC_PATH_V23);
  } catch {}
});
import { getDb, saveDb } from './store.js';
import {
  normalizeSwiggyOrderId,
  extractOrderShareUrlDeep,
  scanOrderAcrossAccounts,
  checkRealSwiggyPaymentAndExtractTracking,
  isOfficialSwiggyTrackingUrl
} from './swiggy-cart.js';
import { ensureOrderTracking, orderPlacedFromPhone } from './order-tracking.js';
import { buildBossDashboard, buildBossPanelHome, buildBossOrderCard } from './boss-panel.js';

console.log('› Testing V23: automatic tracking + dashboard…\n');

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`❌ ${label}\n   ↳ ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Mock Swiggy DAPI (no real network)
// ---------------------------------------------------------------------------
const FAKE_JWT = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIn0.eyJ1c2VyX2lkIjoiMjg1NTkxODY0In0.sig';
const TARGET_ORDER = '251585352131266';
const OTHER_ORDER = '251614877199247';

function makeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

const realFetch = globalThis.fetch;
let fetchCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  fetchCalls.push({ url: target, cookie: String(options?.headers?.Cookie || '') });

  if (target.includes('/dapi/order/all')) {
    return makeResponse({
      statusCode: 0,
      tid: FAKE_JWT,
      sid: 'test-sid',
      deviceId: 'test-device',
      data: {
        orders: [
          {
            order_id: TARGET_ORDER,
            order_status: 'Processing',
            restaurant_name: 'Mouj Mela',
            order_total: 73,
            shareable_url: 'https://r.swiggy.com/track/TARGET123',
            order_items: [{ name: 'Biryani', quantity: 1 }]
          },
          {
            order_id: OTHER_ORDER,
            order_status: 'Order Confirmed',
            restaurant_name: 'Other Rest',
            order_total: 218
          }
        ]
      }
    });
  }
  if (target.includes('vpa-txn-status')) {
    return makeResponse({ data: 'pending' });
  }
  if (target.includes('/dapi/order/details')) {
    // Swiggy answers with a DIFFERENT order for the short number → must be ignored
    return makeResponse({
      statusCode: 0,
      data: {
        orders: [{
          order_id: OTHER_ORDER,
          order_status: 'processing',
          post_status: 'processing',
          payment_info_v2: { payment_transactions: [{ state: 'STATE_SUCCESS' }] },
          shareable_url: 'https://r.swiggy.com/track/OTHER999'
        }]
      }
    });
  }
  if (target.includes('order/trackV4')) {
    return makeResponse({ statusCode: 0, data: { order_status_details: { status_message: 'Preparing' }, sla_time: '32' } });
  }
  if (target.includes('order/trackV2/de')) {
    return makeResponse({ statusCode: 0, data: { name: 'Rider', mobile: '9876500011', otp: '4821' } });
  }
  return makeResponse({ statusCode: 0, data: {} });
};

const testAcc = {
  account: 'acc_test_v23',
  phone: '6296591407',
  name: 'Rahul',
  customerId: '285591864',
  token: 'tok-123',
  tid: FAKE_JWT,
  sid: 'test-sid',
  deviceId: 'test-device',
  cookies: `_session_tid=abc; token=tok-123; _sid=test-sid; _swuid=test-device; tid=${FAKE_JWT}`,
  isLoggedIn: true
};

const emptyAcc = { account: 'acc_empty_v23', phone: '9935123518', name: 'Prithvi', cookies: '_session_tid=empty; token=empty', isLoggedIn: true };

// ---------------------------------------------------------------------------
await check('Only real numeric Swiggy order ids are accepted (short numbers rejected)', () => {
  assert.strictEqual(normalizeSwiggyOrderId('299100'), '');
  assert.strictEqual(normalizeSwiggyOrderId('TEST'), '');
  assert.strictEqual(normalizeSwiggyOrderId(TARGET_ORDER), TARGET_ORDER);
});

await check('Share link is extracted from Swiggy payloads (r.swiggy.com, share fields, deep links)', () => {
  assert.strictEqual(extractOrderShareUrlDeep({ shareable_url: 'https://r.swiggy.com/abc123' }), 'https://r.swiggy.com/abc123');
  assert.strictEqual(
    extractOrderShareUrlDeep({ deeplink: 'swiggy://order?tracking_url=https%3A%2F%2Fr.swiggy.com%2Fxyz789' }),
    'https://r.swiggy.com/xyz789'
  );
  assert.strictEqual(
    extractOrderShareUrlDeep({ data: { orders: [{ share_url: 'https://www.swiggy.com/orders/250070826195484' }] } }),
    'https://www.swiggy.com/orders/250070826195484'
  );
  assert.strictEqual(extractOrderShareUrlDeep({ order_id: TARGET_ORDER }), '');
  assert.strictEqual(extractOrderShareUrlDeep({ cart: 'https://swig.gy/gc/1467977/Umbashiya-642855918' }), '');
  assert.ok(isOfficialSwiggyTrackingUrl('https://r.swiggy.com/abc123', { allowProviderShortLink: true }));
});

await check('All-IDs scan finds the order + tracking link and reports the account phone', async () => {
  const scan = await scanOrderAcrossAccounts(TARGET_ORDER, {
    getAccountsFn: () => ({ acc_test_v23: testAcc, acc_empty_v23: emptyAcc }),
    budgetMs: 6000,
    deep: false
  });
  assert.strictEqual(scan.status, 'TRACKING_FOUND');
  assert.strictEqual(scan.trackingUrl, 'https://r.swiggy.com/track/TARGET123');
  assert.strictEqual(scan.accPhone, '6296591407');
  assert.strictEqual(scan.hasOrder, true);
  assert.ok(scan.scanned >= 1);
});

await check('A short/unknown number can never borrow another order\'s tracking link', async () => {
  const res = await checkRealSwiggyPaymentAndExtractTracking(testAcc, {
    id: 'SHORT',
    swiggyOrderId: '299100',
    pendingSwiggyOrderId: '299100',
    restaurantName: 'Swiggy',
    finalPayable: 35
  });
  assert.strictEqual(res.paid, false, 'a short number must never be reported as paid');
  assert.strictEqual(res.nativeShareUrl || '', '', 'no tracking link may be attached');
  assert.strictEqual(res.trackingUrl || '', '', 'no tracking url may be attached');
});

const dbBackup = JSON.parse(JSON.stringify(getDb()));
const TEST_REF = 'V23TESTREF';

try {
  await check('ensureOrderTracking persists the link, the Swiggy id and the placing phone', async () => {
    const db = getDb();
    db.orders = db.orders || {};
    db.orders[TEST_REF] = {
      id: TEST_REF,
      status: 'COMPLETED',
      swiggyOrderId: TARGET_ORDER,
      pendingSwiggyOrderId: TARGET_ORDER,
      selectedAccount: 'acc_test_v23',
      restaurantName: 'Mouj Mela',
      finalPayable: 73,
      userName: 'Shanu',
      userId: '111',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    saveDb(db);

    const res = await ensureOrderTracking(TEST_REF, {
      force: true,
      budgetMs: 6000,
      deep: false,
      getAccountsFn: () => ({ acc_test_v23: testAcc })
    });

    assert.strictEqual(res.trackingUrl, 'https://r.swiggy.com/track/TARGET123');
    const stored = getDb().orders[TEST_REF];
    assert.strictEqual(stored.trackingLink, 'https://r.swiggy.com/track/TARGET123');
    assert.strictEqual(stored.trackingLinkSource, 'SWIGGY_API');
    assert.strictEqual(stored.swiggyOrderId, TARGET_ORDER);
    assert.strictEqual(stored.selectedAccountPhone, '6296591407');
    assert.strictEqual(orderPlacedFromPhone(stored), '6296591407');
    assert.ok(stored.deliveryOtp, 'delivery OTP from trackV2/de should be stored');
  });

  await check('Boss dashboard always renders order id + tracking + placing phone', () => {
    const view = buildBossDashboard(getDb(), { limit: 8 });
    assert.ok(view.text.includes(`Swiggy #${TARGET_ORDER}`), 'dashboard must show the real Swiggy order id');
    assert.ok(view.text.includes('Placed from'), 'dashboard must label the placing phone');
    assert.ok(view.text.includes('6296591407'), 'dashboard must show the account phone');
    assert.ok(view.text.includes('Open live tracking'), 'dashboard must link the live tracking page');
    assert.strictEqual(view.summary.tracked, 1);
    assert.ok(!view.text.includes('${escapeHtml'), 'dashboard text must not contain literal template code');
    assert.ok(!view.text.includes('#TEST'), 'placeholder TEST orders must be hidden');
  });

  await check('Boss order card shows Swiggy id, tracking state and placing phone', () => {
    const card = buildBossOrderCard(getDb().orders[TEST_REF], getDb());
    assert.ok(card.text.includes('Swiggy order id:'), 'card must label the Swiggy order id');
    assert.ok(card.text.includes(TARGET_ORDER), 'card must include the real Swiggy id');
    assert.ok(card.text.includes('Placed from:'), 'card must label the placing phone');
    assert.ok(card.text.includes('6296591407'), 'card must include the account phone');
    assert.ok(!card.text.includes('&lt;i&gt;'), 'card must not print escaped HTML source');
    assert.ok(!card.text.includes('${'), 'card must not print template placeholders');
  });

  await check('Extract Now on a pasted numeric id scans it and saves only a Swiggy-confirmed order', async () => {
    const transient = {
      id: TARGET_ORDER,
      swiggyOrderId: TARGET_ORDER,
      pendingSwiggyOrderId: TARGET_ORDER,
      status: 'UNVERIFIED',
      isSwiggyIdLookup: true,
      selectedAccount: ''
    };
    const res = await ensureOrderTracking(transient, {
      force: true,
      budgetMs: 6000,
      deep: false,
      getAccountsFn: () => ({ acc_test_v23: testAcc })
    });
    assert.strictEqual(res.hasOrder, true, 'the pasted id must actually be scanned (not ORDER_NOT_FOUND)');
    const stored = getDb().orders[TARGET_ORDER];
    assert.ok(stored, 'a Swiggy-confirmed external order must be registered');
    assert.strictEqual(stored.isExternalOrder, true);
    assert.strictEqual(stored.trackingLink, 'https://r.swiggy.com/track/TARGET123');
    assert.strictEqual(stored.selectedAccountPhone, '6296591407');
    delete getDb().orders[TARGET_ORDER];
    saveDb(getDb());
  });

  await check('An unknown numeric id is never invented as an order', async () => {
    const res = await ensureOrderTracking(
      { id: '259999999999999', swiggyOrderId: '259999999999999', pendingSwiggyOrderId: '259999999999999', status: 'UNVERIFIED' },
      { force: true, budgetMs: 4000, deep: false, getAccountsFn: () => ({ acc_test_v23: testAcc }) }
    );
    assert.strictEqual(res.hasOrder, false);
    assert.strictEqual(getDb().orders['259999999999999'], undefined, 'nothing may be saved when Swiggy has no such order');
  });
} finally {
  saveDb(dbBackup);
}

await check('Boss Panel home exposes the Dashboard button', () => {
  const home = buildBossPanelHome(getDb());
  const buttons = home.keyboard.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button => button.callback_data === 'boss_dashboard'), 'boss_dashboard button must exist');
});

await check('Order list enrichment stays capped (no 20-trackV4-per-account storm)', async () => {
  const { fetchAccountOrders } = await import('./swiggy-cart.js');
  fetchCalls = [];
  const orders = await fetchAccountOrders(testAcc);
  const trackCalls = fetchCalls.filter(call => call.url.includes('order/trackV4'));
  assert.ok(orders.length >= 1, 'mock orders should be returned');
  assert.ok(trackCalls.length <= 2, `expected at most 2 trackV4 calls, got ${trackCalls.length}`);
});

globalThis.fetch = realFetch;

console.log('\n================================================================');
console.log(`📊 RESULT: ${passed}/${passed + failed} V23 automatic-tracking checks passed`);
console.log('================================================================');
if (failed > 0) process.exitCode = 1;
