// ============================================================================
// V24 — "Extract Tracking Link" with a manually pasted Swiggy order id
// ============================================================================
// Regression suite for the production report:
//
//   boss pastes 251614877199247  →  "No tracking found ... Scanned: 0 IDs"
//
// Root cause: the text handler called `ensureOrderTracking(order.id)`. For a
// pasted id that is not in the bot DB, `findOrderRecord(id)` returns null, so
// `ensureOrderTracking` answered ORDER_NOT_FOUND and NEVER scanned an account.
// The fix is to pass the transient order object.
//
// Contract proven here:
//   • a pasted id is really scanned (scanned >= 1, never "0 IDs" while order/all works)
//   • a finished (delivered/cancelled) order is reported honestly and never gets
//     an endless "auto-fetching" retry ladder
//   • an unknown id is never invented as a saved order
//   • every row label tells the truth about a cancelled vs delivered vs live order

import './network-shield.js';
import assert from 'assert';
import { getDb, saveDb } from './store.js';
import { scanOrderAcrossAccounts } from './swiggy-cart.js';
import {
  ensureOrderTracking,
  startOrderTrackingAuto,
  stopOrderTrackingAuto,
  isTerminalDeliveryStatus
} from './order-tracking.js';
import { trackingLinkDisplay } from './boss-panel.js';

console.log('› Testing V24: Extract Tracking with a pasted Swiggy order id…\n');

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
// Mock Swiggy DAPI (no network) — a DELIVERED order with no share link, which
// is exactly the "Panu none / 251614877199247" case from production.
// ---------------------------------------------------------------------------
const FAKE_JWT = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIn0.eyJ1c2VyX2lkIjoiMjg1NTkxODY0In0.sig';
const DELIVERED_ID = '251614877199247';
const CANCELLED_ID = '251582667172018';
const LIVE_ID = '251613518187663';
const UNKNOWN_ID = '259999999999999';

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
const fetchCalls = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  fetchCalls.push(target);

  if (target.includes('/dapi/order/all')) {
    return makeResponse({
      statusCode: 0,
      tid: FAKE_JWT,
      sid: 'test-sid',
      deviceId: 'test-device',
      data: {
        orders: [
          { order_id: LIVE_ID, order_status: 'Out for delivery', restaurant_name: 'Metro Plaza', order_total: 34 },
          { order_id: CANCELLED_ID, order_status: 'cancelled', restaurant_name: 'The Nawabi Club', order_total: 25 },
          { order_id: DELIVERED_ID, order_status: 'Delivered', restaurant_name: 'Shree Nayak Restaurant', order_total: 23 }
        ]
      }
    });
  }
  if (target.includes('/dapi/order/details')) {
    const id = (target.match(/order_id=(\d+)/) || [])[1] || '';
    if (id !== DELIVERED_ID && id !== CANCELLED_ID) return makeResponse({ statusCode: 0, data: {} });
    return makeResponse({
      statusCode: 0,
      data: {
        orders: [{
          order_id: id,
          order_status: id === DELIVERED_ID ? 'Delivered' : 'cancelled',
          post_status: id === DELIVERED_ID ? 'delivered' : 'cancelled',
          restaurant_name: 'Shree Nayak Restaurant'
        }]
      }
    });
  }
  if (target.includes('order/trackV4')) return makeResponse({ statusCode: 0, data: {} });
  if (target.includes('order/trackV2/de')) return makeResponse({ statusCode: 0, data: {} });
  return makeResponse({ statusCode: 0, data: {} });
};

const testAcc = {
  account: 'acc_v24',
  phone: '6376531847',
  name: 'Panu none',
  customerId: '285591864',
  token: 'tok-v24',
  tid: FAKE_JWT,
  sid: 'test-sid',
  deviceId: 'test-device',
  cookies: `_session_tid=abc; token=tok-v24; _sid=test-sid; _swuid=test-device; tid=${FAKE_JWT}`,
  isLoggedIn: true
};
const getAccountsFn = () => ({ acc_v24: testAcc });

const dbBackup = JSON.parse(JSON.stringify(getDb()));

try {
  // -------------------------------------------------------------------------
  await check('Passing a bare id for an unknown order is a no-op scan (why the handler must pass the object)', async () => {
    const res = await ensureOrderTracking(UNKNOWN_ID, { force: true, budgetMs: 4000, deep: false, getAccountsFn });
    assert.strictEqual(res.status, 'ORDER_NOT_FOUND');
    assert.strictEqual(res.scanned, undefined, 'a bare unknown id never reaches the scanner');
  });

  await check('The pasted order OBJECT is really scanned across logged-in IDs', async () => {
    const res = await ensureOrderTracking(
      {
        id: DELIVERED_ID,
        swiggyOrderId: DELIVERED_ID,
        pendingSwiggyOrderId: DELIVERED_ID,
        status: 'UNVERIFIED',
        isSwiggyIdLookup: true,
        selectedAccount: ''
      },
      { force: true, budgetMs: 8000, deep: false, getAccountsFn }
    );
    assert.notStrictEqual(res.status, 'ORDER_NOT_FOUND', 'the scan must actually run');
    assert.ok(Number(res.scanned) >= 1, `expected scanned >= 1, got ${res.scanned}`);
    assert.strictEqual(res.hasOrder, true, 'the delivered order exists on the account');
    assert.strictEqual(res.trackingUrl, '', 'a delivered order has no share link');
    assert.strictEqual(res.accPhone, '6376531847', 'the placing account phone is reported');
  });

  await check('The scan reports ORDER_FOUND (not NOT_FOUND) when the order exists without a link', async () => {
    const scan = await scanOrderAcrossAccounts(DELIVERED_ID, { getAccountsFn, budgetMs: 6000, deep: false });
    assert.strictEqual(scan.status, 'ORDER_FOUND');
    assert.strictEqual(scan.hasOrder, true);
    assert.strictEqual(scan.trackingUrl, '');
    assert.ok(scan.scanned >= 1);
    assert.strictEqual(scan.accountsTotal, 1);
  });

  await check('Delivered / cancelled / live statuses are classified correctly', () => {
    assert.strictEqual(isTerminalDeliveryStatus('Delivered'), true);
    assert.strictEqual(isTerminalDeliveryStatus('cancelled'), true);
    assert.strictEqual(isTerminalDeliveryStatus('Out for delivery'), false);
    assert.strictEqual(isTerminalDeliveryStatus('Arrived at location'), false);
    assert.strictEqual(isTerminalDeliveryStatus(''), false);
    assert.strictEqual(isTerminalDeliveryStatus('COMPLETED'), false, 'bot COMPLETED means paid, not delivered');
  });

  await check('A finished order never starts an endless auto-fetch retry ladder (cancelled skips; delivered does 1 extraction pass then stops)', async () => {
    const db = getDb();
    db.orders = db.orders || {};
    db.orders.V24_CANCELLED = {
      id: 'V24_CANCELLED',
      status: 'COMPLETED',
      swiggyOrderId: CANCELLED_ID,
      liveOrderStatus: 'cancelled',
      selectedAccount: 'acc_v24',
      createdAt: new Date().toISOString()
    };
    db.orders.V24_DONE = {
      id: 'V24_DONE',
      status: 'COMPLETED',
      swiggyOrderId: DELIVERED_ID,
      liveOrderStatus: 'Delivered',
      selectedAccount: 'acc_v24',
      createdAt: new Date().toISOString()
    };
    saveDb(db);

    assert.strictEqual(startOrderTrackingAuto('V24_CANCELLED', { force: true, budgetMs: 4000 }), null, 'cancelled order is never scheduled');
    const started = startOrderTrackingAuto('V24_DONE', { budgetMs: 4000, getAccountsFn });
    assert.ok(started && started.singlePass === true, 'unscanned delivered order runs a single extraction pass');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.strictEqual(stopOrderTrackingAuto('V24_DONE'), false, 'delivered timer stops itself after 1 pass (no endless retry ladder)');
    assert.strictEqual(startOrderTrackingAuto('V24_DONE', { budgetMs: 4000 }), null, 'already-scanned delivered order does not re-schedule');
  });

  await check('An active order still gets the background retry ladder', () => {
    const db = getDb();
    db.orders.V24_LIVE = {
      id: 'V24_LIVE',
      status: 'COMPLETED',
      swiggyOrderId: LIVE_ID,
      liveOrderStatus: 'Out for delivery',
      selectedAccount: 'acc_v24',
      createdAt: new Date().toISOString()
    };
    saveDb(db);
    const state = startOrderTrackingAuto('V24_LIVE', { force: true, budgetMs: 4000, initialDelayMs: 60000 });
    assert.ok(state && state.startedAt, 'an active order must be scheduled');
    assert.strictEqual(stopOrderTrackingAuto('V24_LIVE'), true, 'and can be stopped');
  });

  await check('An unknown id is never invented as an order', async () => {
    await ensureOrderTracking(
      { id: UNKNOWN_ID, swiggyOrderId: UNKNOWN_ID, pendingSwiggyOrderId: UNKNOWN_ID, status: 'UNVERIFIED' },
      { force: true, budgetMs: 4000, deep: false, getAccountsFn }
    );
    assert.strictEqual(getDb().orders[UNKNOWN_ID], undefined);
  });

  await check('Order row labels tell the truth about cancelled / delivered / live rows', () => {
    assert.ok(trackingLinkDisplay({ status: 'cancelled' }).includes('order cancelled'));
    assert.ok(trackingLinkDisplay({ status: 'Delivered' }).includes('order delivered'));
    assert.ok(trackingLinkDisplay({ status: 'Out for delivery' }).includes('auto-fetching'));
    assert.ok(trackingLinkDisplay({ url: 'https://r.swiggy.com/abc', status: 'Delivered' }).includes('Open live tracking'));
    assert.ok(!trackingLinkDisplay({ status: 'cancelled' }).includes('delivered'));
  });
} finally {
  globalThis.fetch = realFetch;
  saveDb(dbBackup);
}

console.log('\n================================================================');
console.log(`📊 RESULT: ${passed}/${passed + failed} V24 Extract-Tracking checks passed`);
console.log('================================================================');
if (failed > 0) process.exitCode = 1;
