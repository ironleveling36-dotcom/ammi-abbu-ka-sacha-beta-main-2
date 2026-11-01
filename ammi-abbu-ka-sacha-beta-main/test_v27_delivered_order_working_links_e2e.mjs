// ============================================================================
// test_v27_delivered_order_working_links_e2e.mjs
// End-to-end verification that EVERY delivered Swiggy order produces a real,
// working, clickable zero-login link (Priority 1: official r.swiggy.com link
// when provided by Swiggy/Vault; Priority 2: HMAC-signed /track/<orderId>?sig=
// order receipt & map link backed by live Swiggy order details, even for
// standalone Swiggy order IDs placed outside the bot).
// ============================================================================

process.env.TEST_MODE = '1';

import assert from 'node:assert';
import http from 'node:http';
import { getDb, saveDb } from './store.js';
import {
  fetchAccountOrders,
  scanOrderAcrossAccounts,
  computeTrackHmac,
  buildSignedOrderTrackUrl,
  notePublicServiceOrigin,
  getPublicServiceBaseUrl,
  isOfficialSwiggyTrackingUrl
} from './swiggy-cart.js';
import {
  resolveTrackEndpointPayload
} from './order-tracking.js';
import {
  trackingLinkDisplay,
  buildBossOrderCard,
  buildBossDashboard
} from './boss-panel.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   → ${err?.message || err}`);
  }
}

console.log('› Testing V27: guaranteed working links for all delivered Swiggy orders…\n');

const dbBackup = JSON.parse(JSON.stringify(getDb()));
const realFetch = globalThis.fetch;

const EXTERNAL_DELIVERED_ID = '251585352131266'; // Placed outside bot, already delivered, no r.swiggy.com URL
const VAULT_DELIVERED_ID = '251614049143835';    // Delivered order that DOES have an official r.swiggy.com URL
const NONEXISTENT_ID = '259999999999999';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function makeFakeFetch() {
  return async (input) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('swiggy.com')) {
      return jsonResponse({ ok: true });
    }

    if (url.includes('/dapi/order/all')) {
      return jsonResponse({
        statusCode: 0,
        data: {
          orders: [
            {
              order_id: EXTERNAL_DELIVERED_ID,
              order_status: 'Delivered',
              post_status: 'Delivered',
              restaurant_name: '24/7 Food Ex',
              restaurant_area_name: 'Alambagh',
              restaurant_lat_lng: '26.8124,80.9012',
              order_total: 36,
              order_time: '2026-10-22 02:19:12',
              order_items: [{ name: 'Veg Fried Rice', quantity: 1, total: 36 }],
              delivery_address: {
                name: 'Fer aex',
                address: 'Krishna Campus, Alambagh',
                area: 'Krishna Campus',
                city: 'Lucknow',
                lat: '26.8015',
                lng: '80.8951',
                mobile: '9876543210'
              }
            },
            {
              order_id: VAULT_DELIVERED_ID,
              order_status: 'Delivered',
              post_status: 'Delivered',
              restaurant_name: 'Roll King',
              order_total: 42,
              order_time: '2026-10-22 10:19:17',
              order_items: [{ name: 'Egg Roll [2 Egg]', quantity: 1, total: 42 }],
              shareable_url: 'http://r.swiggy.com/swiggy/ofo/track/RollKing99Ab',
              delivery_address: {
                name: 'Fer aex',
                address: 'Krishna Campus',
                area: 'Krishna Campus',
                city: 'Lucknow',
                lat: '26.8015',
                lng: '80.8951'
              }
            }
          ]
        }
      });
    }

    if (url.includes(`order_id=${EXTERNAL_DELIVERED_ID}`)) {
      if (url.includes('order/trackV4')) {
        return jsonResponse({
          statusCode: 0,
          data: {
            order_status_details: { status_message: 'Rate your delivery' }
          }
        });
      }
      if (url.includes('order/trackV2/de')) {
        return jsonResponse({
          statusCode: 0,
          data: {
            name: 'Raju Kumar',
            mobile: '9988776655',
            delivery_otp: '4821'
          }
        });
      }
      if (url.includes('order/details')) {
        return jsonResponse({
          statusCode: 0,
          data: {
            orders: [
              {
                order_id: EXTERNAL_DELIVERED_ID,
                order_status: 'Delivered',
                post_status: 'Delivered',
                restaurant_name: '24/7 Food Ex',
                restaurant_area_name: 'Alambagh',
                restaurant_lat_lng: '26.8124,80.9012',
                order_total: 36,
                order_time: '2026-10-22 02:19:12',
                order_items: [{ name: 'Veg Fried Rice', quantity: 1, total: 36 }],
                delivery_address: {
                  name: 'Fer aex',
                  address: 'Krishna Campus, Alambagh',
                  area: 'Krishna Campus',
                  city: 'Lucknow',
                  lat: '26.8015',
                  lng: '80.8951',
                  mobile: '9876543210'
                },
                delivery_boy: { name: 'Raju Kumar', mobile: '9988776655' }
              }
            ]
          }
        });
      }
      return jsonResponse({ statusCode: 0, data: {} });
    }

    if (url.includes(`order_id=${VAULT_DELIVERED_ID}`)) {
      return jsonResponse({
        statusCode: 0,
        data: {
          order_status_details: { status_message: 'Delivered' },
          shareable_url: 'http://r.swiggy.com/swiggy/ofo/track/RollKing99Ab'
        }
      });
    }

    return jsonResponse({ statusCode: 1, statusMessage: 'not found', data: {} });
  };
}

const fakeAccount = {
  phone: '7488934840',
  name: 'Fer aex',
  isLoggedIn: true,
  cookies: '_session_tid=v27session; _device_id=dev-v27; _sid=sid-v27',
  tid: 'v27session',
  sid: 'sid-v27',
  deviceId: 'dev-v27',
  customerId: 'cust_v27'
};

const getAccountsFn = () => ({ acc_7488934840: fakeAccount });

try {
  globalThis.fetch = makeFakeFetch();

  await check('1. Signed delivered-order URL uses valid HMAC and never masquerades as swiggy.com', () => {
    const signedUrl = buildSignedOrderTrackUrl(EXTERNAL_DELIVERED_ID);
    const expectedSig = computeTrackHmac(EXTERNAL_DELIVERED_ID);
    assert.ok(signedUrl.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=${expectedSig}`));
    assert.strictEqual(isOfficialSwiggyTrackingUrl(signedUrl), false, 'bot fallback URL stays distinct from official Swiggy URLs');
  });

  await check('2. Public origin auto-detection captures public x-forwarded-host and ignores localhost/private IPs', () => {
    notePublicServiceOrigin({ headers: { host: 'localhost:3000' } });
    notePublicServiceOrigin({ headers: { host: '127.0.0.1:8080' } });
    notePublicServiceOrigin({ headers: { host: '10.0.0.5:3000' } });
    assert.ok(!getPublicServiceBaseUrl().includes('localhost'));
    assert.ok(!getPublicServiceBaseUrl().includes('127.0.0.1'));

    notePublicServiceOrigin({
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'swiggy-live-tracker.up.railway.app'
      }
    });
    if (!process.env.PUBLIC_URL && !process.env.RENDER_EXTERNAL_URL && !process.env.RAILWAY_PUBLIC_DOMAIN) {
      assert.strictEqual(getPublicServiceBaseUrl(), 'https://swiggy-live-tracker.up.railway.app');
    }
  });

  await check('3. fetchAccountOrders (Orders Done) gives deliveredTrackUrl for delivered orders without r.swiggy.com & prioritizes r.swiggy.com when available', async () => {
    const orders = await fetchAccountOrders(fakeAccount, { enrichLimit: 5 });
    assert.strictEqual(orders.length, 2);

    const extOrder = orders.find(o => String(o.orderId) === EXTERNAL_DELIVERED_ID);
    assert.ok(extOrder, 'external delivered order found');
    assert.strictEqual(extOrder.status, 'Delivered');
    assert.strictEqual(extOrder.trackingUrl, '', 'raw Swiggy share URL stays empty when Swiggy omitted it');
    assert.ok(extOrder.deliveredTrackUrl.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`), 'working signed delivered link provided');
    assert.strictEqual(extOrder.deliveryOtp, '4821');

    const officialOrder = orders.find(o => String(o.orderId) === VAULT_DELIVERED_ID);
    assert.ok(officialOrder, 'delivered order with official link found');
    assert.strictEqual(officialOrder.trackingUrl, 'http://r.swiggy.com/swiggy/ofo/track/RollKing99Ab');
  });

  await check('4. trackingLinkDisplay renders clickable link for EVERY delivered order with an orderId (and prioritizes official Swiggy URL)', () => {
    const noOfficialHtml = trackingLinkDisplay({
      url: '',
      status: 'Rate your delivery',
      orderId: EXTERNAL_DELIVERED_ID
    });
    assert.ok(noOfficialHtml.includes(`<a href="`), 'must render clickable anchor tag');
    assert.ok(noOfficialHtml.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`), 'must link to signed tracking page');
    assert.ok(!noOfficialHtml.includes('No live link'), 'must NOT say No live link when orderId exists');

    const withOfficialHtml = trackingLinkDisplay({
      url: 'http://r.swiggy.com/swiggy/ofo/track/RollKing99Ab',
      status: 'Delivered',
      orderId: VAULT_DELIVERED_ID
    });
    assert.ok(withOfficialHtml.includes('http://r.swiggy.com/swiggy/ofo/track/RollKing99Ab'));
    assert.ok(!withOfficialHtml.includes(`/track/${VAULT_DELIVERED_ID}`));
  });

  await check('5. Boss Order Card & Boss Dashboard include clickable link + button for delivered orders', () => {
    const db = getDb();
    db.orders = db.orders || {};
    db.config = db.config || {};
    db.config.accounts = { acc_7488934840: fakeAccount };
    db.orders.V27_DELIV = {
      id: 'V27_DELIV',
      status: 'COMPLETED',
      userId: '12345',
      userName: 'Fer aex',
      restaurantName: '24/7 Food Ex',
      swiggyOrderId: EXTERNAL_DELIVERED_ID,
      liveOrderStatus: 'Rate your delivery',
      selectedAccount: 'acc_7488934840',
      deliveryOtp: '4821',
      finalPayable: 36,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    const card = buildBossOrderCard(db.orders.V27_DELIV, db);
    assert.ok(card.text.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`), 'Boss card text contains clickable delivered link');
    const flatButtons = (card.keyboard?.reply_markup?.inline_keyboard || []).flat();
    assert.ok(
      flatButtons.some(b => b.url && b.url.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`)),
      'Boss card keyboard contains URL button for delivered order'
    );

    const dash = buildBossDashboard(db, { limit: 5 });
    assert.ok(dash.text.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`), 'Dashboard text contains clickable delivered link');
    const dashButtons = (dash.keyboard?.reply_markup?.inline_keyboard || []).flat();
    assert.ok(
      dashButtons.some(b => b.url && b.url.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`)),
      'Dashboard keyboard contains URL button for delivered order'
    );
  });

  await check('6. /api/track/:id resolves standalone external delivered Swiggy order (even when NOT in db.orders!) + real HTTP server round-trip', async () => {
    const cleanDb = { orders: {}, config: { accounts: { acc_7488934840: fakeAccount } } };

    // Spin up lightweight test HTTP server mirroring index.js /api/track & /track routes
    const srv = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const apiMatch = reqUrl.pathname.match(/^\/api\/track\/([A-Za-z0-9_-]+)$/);
      if (apiMatch) {
        const oid = apiMatch[1];
        const sig = reqUrl.searchParams.get('sig') || '';
        if (sig !== computeTrackHmac(oid)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        }
        const resolved = await resolveTrackEndpointPayload(oid, {
          db: cleanDb,
          forceRefresh: true,
          getAccountsFn
        });
        res.writeHead(resolved.ok ? 200 : (resolved.statusCode || 404), { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resolved.ok ? resolved.payload : { ok: false, error: resolved.error }));
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    try {
      // A) Tampered signature -> 403
      const badRes = await realFetch(`http://127.0.0.1:${port}/api/track/${EXTERNAL_DELIVERED_ID}?sig=bad_sig`);
      assert.strictEqual(badRes.status, 403);

      // B) Valid signature on standalone delivered Swiggy Order ID -> 200 with full Swiggy details!
      const validSig = computeTrackHmac(EXTERNAL_DELIVERED_ID);
      const okRes = await realFetch(`http://127.0.0.1:${port}/api/track/${EXTERNAL_DELIVERED_ID}?sig=${validSig}`);
      assert.strictEqual(okRes.status, 200);
      const body = await okRes.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.swiggyOrderId, EXTERNAL_DELIVERED_ID);
      assert.strictEqual(body.orderStatus, 'Delivered');
      assert.strictEqual(body.isDelivered, true);
      assert.strictEqual(body.restaurantName, '24/7 Food Ex');
      assert.strictEqual(body.finalPayable, 36);
      assert.strictEqual(body.deliveryOtp, '4821');
      assert.strictEqual(body.placedFrom, '7488934840');
      assert.ok(Array.isArray(body.items) && body.items[0]?.name === 'Veg Fried Rice');
      assert.ok(body.deliveryAddress?.address?.includes('Krishna Campus'));
      assert.strictEqual(Number(body.deliveryAddress?.lat), 26.8015);
      assert.strictEqual(body.deliveryBoy?.name, 'Raju Kumar');

      // C) Valid signature on non-existent Swiggy Order ID -> 404
      const nfSig = computeTrackHmac(NONEXISTENT_ID);
      const nfRes = await realFetch(`http://127.0.0.1:${port}/api/track/${NONEXISTENT_ID}?sig=${nfSig}`);
      assert.strictEqual(nfRes.status, 404);
    } finally {
      await new Promise(resolve => srv.close(resolve));
    }
  });

  await check('7. scanOrderAcrossAccounts also returns deliveredTrackUrl for delivered external orders', async () => {
    const scan = await scanOrderAcrossAccounts(EXTERNAL_DELIVERED_ID, {
      getAccountsFn,
      budgetMs: 6000,
      deep: true
    });
    assert.strictEqual(scan.hasOrder, true);
    assert.strictEqual(scan.orderStatus, 'Delivered');
    assert.ok(scan.deliveredTrackUrl && scan.deliveredTrackUrl.includes(`/track/${EXTERNAL_DELIVERED_ID}?sig=`));
  });
} finally {
  globalThis.fetch = realFetch;
  saveDb(dbBackup);
}

console.log('\n================================================================');
console.log(`📊 RESULT: ${passed}/${passed + failed} V27 delivered-order link checks passed`);
console.log('================================================================');
if (failed > 0) process.exitCode = 1;
