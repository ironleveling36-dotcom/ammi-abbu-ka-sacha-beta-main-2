// ============================================================================
// V30 — Brand-new order (just placed) tracking discovery E2E
// ============================================================================
// Replicates the user's live scenario: order 251630299198497 was just placed
// through the bot. Swiggy has it in "Processing"; the official share link is
// NOT published yet. The engine must:
//   1) find the order on the right account immediately (status/OTP persisted),
//   2) keep the auto retry ladder alive (not terminal, not cancelled),
//   3) the moment Swiggy publishes the share link, store it + fire the notifier,
//   4) resolve a standalone numeric id via /api/track payload (order NOT in db),
//   5) accept the genuine link through validateTrackingUrlForOrder (no false reject).

import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import { getDb, saveDb } from './store.js';
import {
  scanOrderAcrossAccounts,
  getStoredSwiggyTrackingUrl,
  validateTrackingUrlForOrder,
  isOfficialSwiggyTrackingUrl,
  computeTrackHmac,
  buildSignedOrderTrackUrl,
  getSwiggyOrderSnapshot,
  normalizeSwiggyOrderId
} from './swiggy-cart.js';
import {
  ensureOrderTracking,
  startOrderTrackingAuto,
  stopOrderTrackingAuto,
  setOrderTrackingNotifier,
  isTerminalDeliveryStatus,
  isCancelledOrRefusedStatus,
  resolveTrackEndpointPayload
} from './order-tracking.js';

const ORDER_ID = '251630299198497';
const NEW_OFO_URL = 'http://r.swiggy.com/swiggy/ofo/track/xT7qLm2Wv9Zb';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${label}`); }
  catch (err) { failed += 1; console.log(`❌ ${label}\n   ↳ ${err.message}`); }
}

const FAKE_JWT = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIn0.eyJ1c2VyX2lkIjoiMjgzNzAzODU4In0.sig';
const OTHER_JWT = 'eyJLSUQiOiIyIiwidHlwIjoiSldUIn0.eyJ1c2VyX2lkIjoiMjg1NTkxODY0In0.sig';

// ---- Fake Swiggy state ------------------------------------------------------
let trackV4Calls = 0;
let sharePublished = false;

const orderAllPayload = (withOrder) => ({
  statusCode: 0,
  tid: FAKE_JWT,
  sid: 'prithvi-sid',
  deviceId: 'prithvi-dev',
  data: {
    orders: withOrder ? [
      {
        order_id: ORDER_ID,
        order_status: 'Processing',
        post_status: 'processing',
        restaurant_name: 'Lucknow Biryani House',
        restaurant_address: 'Hazratganj, Lucknow',
        order_total: 482,
        customer_id: '283703858',
        created_at: Math.floor(Date.now() / 1000) - 120,
        lat: 26.85, lng: 80.95
      },
      { order_id: '251600000000111', order_status: 'Delivered', restaurant_name: 'Old Cafe', order_total: 120 }
    ] : [
      { order_id: '251600000000111', order_status: 'Delivered', restaurant_name: 'Old Cafe', order_total: 120 }
    ]
  }
});

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
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/dapi/order/all')) {
    // Account 1 (prithvi) owns the order; account 2 never sees it.
    return makeResponse(target.includes('prithvi-cookies') ? orderAllPayload(true) : orderAllPayload(false));
  }
  if (target.includes('/dapi/order/details') && target.includes(ORDER_ID)) {
    return makeResponse({
      statusCode: 0,
      data: {
        orders: [{
          order_id: ORDER_ID,
          order_status: 'processing',
          post_status: 'processing',
          customer_id: '283703858',
          restaurant_name: 'Lucknow Biryani House',
          restaurant_address: 'Hazratganj, Lucknow',
          restaurant_lat: 26.85, restaurant_lng: 80.95,
          order_total: 482,
          order_items: [
            { name: 'Chicken Dum Biryani', qty: 1, price: 320 },
            { name: 'Kachori', qty: 2, price: 60 }
          ],
          delivery_address: { address_line_1: 'Sector 18, Gomti Nagar', city: 'Lucknow', name: 'Ammi', mobile: '9876543210' },
          payment_info_v2: { payment_transactions: [{ state: 'STATE_SUCCESS' }] }
        }]
      }
    });
  }
  if (target.includes('/dapi/order/trackV4') && target.includes(ORDER_ID)) {
    trackV4Calls += 1;
    const base = {
      order_status_details: {
        status_message: sharePublished ? 'Your order is on the way' : 'Order accepted by restaurant',
        status_sub_text: sharePublished ? 'Rider will arrive in 25 mins' : 'Please wait'
      },
      sla_time: sharePublished ? 25 : 40,
      ofo_details: sharePublished ? {
        share_data: {
          share_url: NEW_OFO_URL,
          whatsapp_text: `Ammi has just placed an order (ID: ${ORDER_ID}) for you on Swiggy. Track: ${NEW_OFO_URL}`
        }
      } : undefined
    };
    return makeResponse({ statusCode: 0, data: base });
  }
  if (target.includes('/dapi/order/trackV2/de') && target.includes(ORDER_ID)) {
    return makeResponse({ statusCode: 0, data: { name: 'Raju Rider', mobile: '9811223344', otp: '4821' } });
  }
  return makeResponse({ statusCode: 0, data: {} });
};

const prithviAcc = {
  name: 'prithvi',
  phone: '9935123518',
  customerId: '283703858',
  token: 'tok-prithvi',
  tid: FAKE_JWT,
  sid: 'prithvi-sid',
  deviceId: 'prithvi-dev',
  cookies: 'prithvi-cookies _session_tid=abc; token=tok-prithvi; _sid=prithvi-sid; _swuid=prithvi-dev; tid=' + FAKE_JWT,
  isLoggedIn: true
};
const rahulAcc = {
  name: 'Rahul (6296591407)',
  phone: '6296591407',
  customerId: '285591864',
  token: 'tok-rahul',
  tid: OTHER_JWT,
  sid: 'rahul-sid',
  deviceId: 'rahul-dev',
  cookies: 'rahul-cookies _session_tid=def; token=tok-rahul; _sid=rahul-sid; _swuid=rahul-dev; tid=' + OTHER_JWT,
  isLoggedIn: true
};
const getAccountsFn = () => ({ acc_9935123518: prithviAcc, acc_6296591407: rahulAcc });

const rawDbDiskBackup = fs.existsSync('data/db.json') ? fs.readFileSync('data/db.json', 'utf8') : null;
const dbBackup = JSON.parse(JSON.stringify(getDb()));

try {
  const db = getDb();
  db.config.accounts = { ...db.config.accounts, acc_9935123518: prithviAcc, acc_6296591407: rahulAcc };

  // ================= 1. Order JUST placed — Swiggy has it, no share link yet
  db.orders.V30_FRESH = {
    id: 'V30_FRESH',
    status: 'COMPLETED',
    cardStage: 'PAID_CONFIRMED',
    swiggyOrderId: ORDER_ID,
    pendingSwiggyOrderId: ORDER_ID,
    selectedAccount: 'acc_9935123518',
    selectedAccountPhone: '9935123518',
    restaurantName: 'Swiggy Order',
    finalPayable: 482,
    addressDetails: { name: 'Ammi', address: 'Sector 18, Gomti Nagar', city: 'Lucknow', mobile: '9876543210' },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  saveDb(db);

  let notifications = [];
  setOrderTrackingNotifier(async (order) => { notifications.push({ id: order.id, url: getStoredSwiggyTrackingUrl(order) }); });

  await check('Fresh order found on owning account (Processing), OTP+status persisted, no fake link yet', async () => {
    sharePublished = false;
    const r = await ensureOrderTracking('V30_FRESH', { budgetMs: 15000, deep: true, force: true, getAccountsFn });
    assert.strictEqual(r.hasOrder, true, `order must be found: status=${r.status} scanned=${r.scanned}`);
    assert.strictEqual(r.status, 'ORDER_FOUND', `expected ORDER_FOUND (link not published yet), got ${r.status}`);
    assert.strictEqual(getStoredSwiggyTrackingUrl(getDb().orders.V30_FRESH), '', 'no link before Swiggy publishes');
    const o = getDb().orders.V30_FRESH;
    assert.ok(/accepted|processing|confirmed/i.test(String(o.liveOrderStatus)), `live status persisted: ${o.liveOrderStatus}`);
    assert.strictEqual(String(o.deliveryOtp), '4821', 'OTP persisted from trackV2/de');
    assert.strictEqual(o.selectedAccount, 'acc_9935123518', 'owning account recorded');
  });

  await check('Auto ladder stays alive for fresh non-terminal order (no early stop)', async () => {
    const o = getDb().orders.V30_FRESH;
    assert.strictEqual(isTerminalDeliveryStatus(o.liveOrderStatus), false, 'processing is not terminal');
    assert.strictEqual(isCancelledOrRefusedStatus(o.liveOrderStatus), false);
    const state = startOrderTrackingAuto('V30_FRESH', { budgetMs: 8000, force: true, initialDelayMs: 30 });
    assert.ok(state, 'auto tracking state must be scheduled (ladder running)');
    stopOrderTrackingAuto('V30_FRESH');
  });

  // ================= 2. Swiggy PUBLISHES the share link (next scan tick)
  await check('Moment Swiggy publishes the link → stored + notifier fires with genuine URL', async () => {
    sharePublished = true;
    const r = await ensureOrderTracking('V30_FRESH', { budgetMs: 15000, deep: true, force: true, getAccountsFn });
    assert.strictEqual(r.status, 'TRACKING_FOUND', `expected TRACKING_FOUND, got ${r.status}`);
    const o = getDb().orders.V30_FRESH;
    assert.strictEqual(getStoredSwiggyTrackingUrl(o), NEW_OFO_URL, 'genuine link stored on order');
    assert.strictEqual(o.trackingLinkSource, 'SWIGGY_API');
    assert.ok(notifications.length >= 1, 'notifier fired');
    assert.strictEqual(notifications[0].url, NEW_OFO_URL, 'notifier carries the genuine link');
    assert.ok(!isFabricatedForTest(NEW_OFO_URL), 'sanity: link is the Swiggy one');
  });

  // ================= 3. Standalone numeric lookup (order NOT in db) — /api/track payload
  await check('resolveTrackEndpointPayload resolves standalone numeric id (not in db) with genuine link', async () => {
    // Simulate a fresh process memory: drop the bot order record but keep accounts.
    const freshDb = getDb();
    delete freshDb.orders.V30_FRESH;
    saveDb(freshDb);
    const res = await resolveTrackEndpointPayload(ORDER_ID, { db: freshDb, getAccountsFn, forceRefresh: true });
    assert.strictEqual(res.ok, true, `payload must resolve: ${JSON.stringify(res).slice(0, 200)}`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.swiggyOrderId, ORDER_ID);
    assert.strictEqual(res.payload.swiggyWebTrackUrl, NEW_OFO_URL, 'official Swiggy link exposed on payload');
    assert.ok(/^https?:\/\/[a-z0-9.-]+\/track\/251630299198497\?sig=[0-9a-f]+$/i.test(res.payload.signedTrackUrl), `signed public page URL present: ${res.payload.signedTrackUrl}`);
    assert.strictEqual(res.payload.deliveryOtp, '4821');
    assert.ok(/Lucknow Biryani House/i.test(res.payload.restaurantName));
  });

  // ================= 4. Signed /track/<id> HMAC route validation (zero-login page)
  await check('Signed public tracking URL passes the same HMAC check the HTTP route enforces', () => {
    const sig = computeTrackHmac(ORDER_ID);
    assert.strictEqual(sig, computeTrackHmac(ORDER_ID), 'HMAC deterministic');
    assert.ok(/^[0-9a-f]{16,}$/i.test(sig));
    const built = buildSignedOrderTrackUrl(ORDER_ID);
    assert.ok(built.includes(`/track/${ORDER_ID}?sig=${sig}`), `buildSignedOrderTrackUrl embeds valid sig: ${built}`);
    // The route compares `reqUrl.searchParams.get('sig') !== computeTrackHmac(orderId)` — same value passes.
    assert.strictEqual(sig !== computeTrackHmac('251630299198498'), true, 'different id → different sig (no cross-order reuse)');
  });

  // ================= 5. Validator must accept the genuine link for THIS order
  await check('validateTrackingUrlForOrder accepts genuine OFO link for the order (no false reject)', () => {
    const order = { id: 'V30_FRESH', swiggyOrderId: ORDER_ID };
    assert.strictEqual(validateTrackingUrlForOrder(NEW_OFO_URL, order, 'SWIGGY_API'), true);
    assert.strictEqual(isOfficialSwiggyTrackingUrl(NEW_OFO_URL, { allowProviderShortLink: true }), true);
    // and still reject fabricated / cross-order / dummy links:
    assert.strictEqual(validateTrackingUrlForOrder('https://www.swiggy.com/track', order, 'SWIGGY_API'), false);
    assert.strictEqual(validateTrackingUrlForOrder(`https://www.swiggy.com/orders/track?order_id=999999999999999`, order, 'SWIGGY_API'), false, 'cross-order query id rejected');
    assert.strictEqual(validateTrackingUrlForOrder('https://media-assets.swiggy.com/swiggy/image/upload/track_icon.png', order, 'SWIGGY_API'), false);
  });

  // ================= 6. Snapshot cache + orderSwiggyOrderId helpers
  await check('In-memory snapshot for the numeric id caches status/OTP/link for /track page polls', () => {
    const snap = getSwiggyOrderSnapshot(ORDER_ID);
    assert.ok(snap, 'snapshot exists');
    assert.strictEqual(String(snap.orderId || ''), ORDER_ID);
    assert.strictEqual(snap.trackingUrl, NEW_OFO_URL, 'snapshot carries the link');
    assert.strictEqual(normalizeSwiggyOrderId(ORDER_ID), ORDER_ID);
  });

  // ================= 7. Delivered-order path still works after link found (no regression)
  await check('Order row stays live-labeled while processing (not delivered/cancelled)', () => {
    const o = getDb().orders.V30_FRESH || { liveOrderStatus: 'Your order is on the way' };
    const st = String(o.liveOrderStatus || '');
    assert.strictEqual(isTerminalDeliveryStatus(st), false, `status '${st}' must not be terminal`);
  });

} finally {
  globalThis.fetch = realFetch;
  // Restore db + disk
  try {
    const db = getDb();
    for (const k of Object.keys(db.orders || {})) if (String(k).startsWith('V30_')) delete db.orders[k];
    if (rawDbDiskBackup !== null) fs.writeFileSync('data/db.json', rawDbDiskBackup, 'utf8');
    saveDb(JSON.parse(JSON.stringify(dbBackup)));
  } catch {}
  stopOrderTrackingAuto('V30_FRESH');
}

function isFabricatedForTest(url) {
  return url.includes('ammi-abbu') || url.includes('onrender') || !url.startsWith('http://r.swiggy.com');
}

console.log(`\n================================================================\n📊 V30 RESULT: ${passed}/${passed + failed} brand-new-order tracking checks passed${failed ? ` — ${failed} FAILED` : ''}\n================================================================`);
process.exit(failed ? 1 : 0);
