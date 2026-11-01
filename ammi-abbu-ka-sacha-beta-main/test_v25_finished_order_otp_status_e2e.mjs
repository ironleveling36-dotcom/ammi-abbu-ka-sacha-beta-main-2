// ============================================================================
// V25 — Finished orders still show status + delivery OTP (no tracking link)
// ============================================================================
// Boss request: "delivered orders par bhi OTP/status dikhe".
//
// Swiggy never publishes a share/tracking link for a delivered or cancelled
// order, so the bot must show what Swiggy DOES return — the final status, the
// delivery OTP and the rider — instead of an empty card or a false promise
// that the link is "coming soon".
//
// Contract proven here:
//   • fetchAccountOrders() enriches delivered orders too (trackV4 + trackV2/de)
//   • the delivery OTP survives into the stored order
//   • the boss card shows Swiggy status + OTP and never claims it is retrying
//   • a cancelled order is labelled "order cancelled", not "delivery recorded"

import './network-shield.js';
import assert from 'assert';
import { getDb, saveDb } from './store.js';
import { fetchAccountOrders } from './swiggy-cart.js';
import { ensureOrderTracking } from './order-tracking.js';
import { buildBossOrderCard, trackingLinkDisplay } from './boss-panel.js';

console.log('› Testing V25: status + delivery OTP for finished orders…\n');

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
// Mock Swiggy DAPI — newest order is DELIVERED (index 0) and has no share link.
// ---------------------------------------------------------------------------
const FAKE_JWT = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIn0.eyJ1c2VyX2lkIjoiMjg1NTkxODY0In0.sig';
const DELIVERED_ID = '251614877199247';
const CANCELLED_ID = '251582667172018';

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
          { order_id: DELIVERED_ID, order_status: 'Delivered', restaurant_name: 'Shree Nayak Restaurant', order_total: 23 },
          { order_id: CANCELLED_ID, order_status: 'cancelled', restaurant_name: 'The Nawabi Club', order_total: 25 }
        ]
      }
    });
  }
  if (target.includes('order/trackV4')) {
    const id = (target.match(/order_id=(\d+)/) || [])[1] || '';
    return makeResponse({
      statusCode: 0,
      data: {
        order_status_details: { status_message: id === DELIVERED_ID ? 'Delivered' : 'Cancelled' },
        sla_time: '0'
      }
    });
  }
  if (target.includes('order/trackV2/de')) {
    return makeResponse({ statusCode: 0, data: { name: 'Rider Bhaiya', mobile: '9876500011', otp: '4821' } });
  }
  if (target.includes('/dapi/order/details')) {
    const id = (target.match(/order_id=(\d+)/) || [])[1] || '';
    return makeResponse({
      statusCode: 0,
      data: { orders: [{ order_id: id, order_status: id === DELIVERED_ID ? 'Delivered' : 'cancelled', restaurant_name: 'Shree Nayak Restaurant' }] }
    });
  }
  return makeResponse({ statusCode: 0, data: {} });
};

const testAcc = {
  account: 'acc_v25',
  phone: '6376531847',
  name: 'Panu none',
  customerId: '285591864',
  token: 'tok-v25',
  tid: FAKE_JWT,
  sid: 'test-sid',
  deviceId: 'test-device',
  cookies: `_session_tid=abc; token=tok-v25; _sid=test-sid; _swuid=test-device; tid=${FAKE_JWT}`,
  isLoggedIn: true
};
const getAccountsFn = () => ({ acc_v25: testAcc });

const dbBackup = JSON.parse(JSON.stringify(getDb()));

try {
  await check('Delivered orders are enriched too (trackV4 + trackV2/de are called)', async () => {
    fetchCalls.length = 0;
    const orders = await fetchAccountOrders(testAcc);
    const delivered = orders.find(o => String(o.orderId) === DELIVERED_ID);
    assert.ok(delivered, 'the delivered order must be returned');
    const trackCalls = fetchCalls.filter(call => call.includes('order/trackV4'));
    assert.ok(trackCalls.length >= 1, `expected a trackV4 call for the delivered order, got ${trackCalls.length}`);
    assert.ok(trackCalls.some(call => call.includes(DELIVERED_ID)), 'trackV4 must target the delivered order');
  });

  await check('A delivered order keeps its final status and delivery OTP', async () => {
    const orders = await fetchAccountOrders(testAcc);
    const delivered = orders.find(o => String(o.orderId) === DELIVERED_ID);
    assert.strictEqual(delivered.status, 'Delivered');
    assert.strictEqual(delivered.deliveryOtp, '4821');
    assert.strictEqual(delivered.trackingUrl, '', 'no share link is invented for a delivered order');
  });

  await check('The scan persists the OTP even when there is no tracking link', async () => {
    const db = getDb();
    db.orders = db.orders || {};
    db.orders.V25_TEST = {
      id: 'V25_TEST',
      status: 'COMPLETED',
      swiggyOrderId: DELIVERED_ID,
      pendingSwiggyOrderId: DELIVERED_ID,
      selectedAccount: 'acc_v25',
      createdAt: new Date().toISOString()
    };
    saveDb(db);

    const res = await ensureOrderTracking('V25_TEST', { force: true, budgetMs: 8000, deep: false, getAccountsFn });
    const stored = getDb().orders.V25_TEST;
    assert.strictEqual(res.trackingUrl, '', 'no link for a delivered order');
    assert.strictEqual(stored.liveOrderStatus, 'Delivered');
    assert.strictEqual(stored.deliveryOtp, '4821', 'the delivery OTP must be stored');
  });

  await check('Boss card shows Swiggy status + OTP and never promises a retry', () => {
    const db = getDb();
    db.config.accounts = db.config.accounts || {};
    db.config.accounts.acc_v25 = { phone: '6376531847', name: 'Panu none', isLoggedIn: true };
    saveDb(db);

    const card = buildBossOrderCard(getDb().orders.V25_TEST, getDb());
    assert.ok(card.text.includes('Swiggy status:'), 'card must show the real Swiggy status');
    assert.ok(card.text.includes('Delivered'), 'card must show "Delivered"');
    assert.ok(card.text.includes('4821'), 'card must show the delivery OTP');
    assert.ok(card.text.includes('delivery recorded'), 'OTP label must say the delivery already happened');
    assert.ok(!card.text.includes('keeps retrying'), 'a finished order must not claim the bot is still retrying');
    assert.ok(!card.text.includes('${'), 'no template placeholders');
    assert.ok(!card.text.includes('&lt;'), 'no escaped HTML source');
  });

  await check('A cancelled order is labelled "order cancelled", not "delivery recorded"', () => {
    const db = getDb();
    db.orders.V25_CANCELLED = {
      id: 'V25_CANCELLED',
      status: 'COMPLETED',
      swiggyOrderId: CANCELLED_ID,
      liveOrderStatus: 'cancelled',
      deliveryOtp: '1111',
      selectedAccount: 'acc_v25',
      createdAt: new Date().toISOString()
    };
    saveDb(db);
    const card = buildBossOrderCard(getDb().orders.V25_CANCELLED, getDb());
    assert.ok(card.text.includes('order cancelled'), 'cancelled OTP must be labelled correctly');
    assert.ok(!card.text.includes('delivery recorded'));
    assert.ok(!card.text.includes('keeps retrying'));
  });

  await check('Row labels stay honest (cancelled vs delivered vs live)', () => {
    assert.ok(trackingLinkDisplay({ status: 'cancelled' }).includes('order cancelled'));
    assert.ok(trackingLinkDisplay({ status: 'Delivered' }).includes('order delivered'));
    assert.ok(trackingLinkDisplay({ status: 'Out for delivery' }).includes('auto-fetching'));
  });
} finally {
  globalThis.fetch = realFetch;
  saveDb(dbBackup);
}

console.log('\n================================================================');
console.log(`📊 RESULT: ${passed}/${passed + failed} V25 finished-order checks passed`);
console.log('================================================================');
if (failed > 0) process.exitCode = 1;
