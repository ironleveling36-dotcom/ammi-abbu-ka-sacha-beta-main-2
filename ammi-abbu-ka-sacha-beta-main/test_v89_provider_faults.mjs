// Swiggy-shaped MOCK responses only; not a live order or API contract test.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-provider-test-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-test', NODE_ENV: 'test', DB_ASYNC_WRITE: '0', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '0'
});
const { proProvider } = await import('./swiggy-pro-provider.js');
const { readSwiggyPlacement } = await import('./swiggy-placement-journal.js');
const { checkRealSwiggyPaymentAndExtractTracking } = await import('./swiggy-cart.js');
const realFetch = globalThis.fetch;
const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const address = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', selected: true };
const account = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const cart = { restaurantId: '123', restaurantName: 'Mock', forSomeoneElse: true,
  items: [{ menu_item_id: 456, qty: 1, variants: [], addons: [] }], quote: { total: 150.25, coupon: '' } };
const uri = 'upi://pay?pa=upiswiggy%40icici&am=150.25&cu=INR&tr=offline';
const id = '123456789012';
let remoteAddress, meta, mode, calls, placeBodies, unknownUrls, remoteOrders, gateway, confirmCalls;
function reset() {
  remoteAddress = { ...address };
  meta = { order_total: 150.25, cartId: 'cart-1', address_id: 'addr-1', restaurant_details: { id: '123', name: 'Mock' },
    cart_menu_items: [{ menu_item_id: 456, quantity: 1, name: 'Meal', subtotal: 12500, addons: [], variants: [] }],
    is_order_for_someone_else: true };
  mode = 'ok'; calls = 0; placeBodies = []; unknownUrls = []; remoteOrders = []; gateway = { status: 200, data: { data: 'pending' } }; confirmCalls = 0;
}
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('/api/v2/order/place')) {
    calls++; placeBodies.push(JSON.parse(options.body));
    if (mode === 'timeout') throw new Error('mock timeout after send');
    if (mode === 'status8') return response({ statusCode: 8, statusMessage: 'uncertain' });
    return response({ statusCode: 0, data: { order_id: id, app_redirection_info: { intent: mode === 'badamount' ? uri.replace('150.25', '150.26') : uri } } });
  }
  if (u.includes('/api/v2/cart/client')) return response({ statusCode: 0, tid: jwt, data: { cartMeta: { ...meta, addresses: [remoteAddress] } } });
  if (u.includes('/vpa-txn-status')) return response(gateway.data, gateway.status);
  if (u.includes('/api/v3/order/confirm')) { confirmCalls++; return response({ statusCode: 0, data: { order_id: id } }); }
  if (u.includes('/dapi/order/all')) return response({ statusCode: 0, tid: jwt, data: { orders: remoteOrders } });
  if (u.includes('/dapi/order/details')) return response({ statusCode: 0, data: { orders: remoteOrders.filter(o => o.order_id === id) } });
  if (u.includes('/dapi/order/trackV4')) return response({ statusCode: 0, data: { order_id: id, share_url: `https://www.swiggy.com/orders/${id}`, order_status_details: { status_message: 'Confirmed' } } });
  if (u.includes('/dapi/order/trackV2/de')) return response({ statusCode: 0, data: { order_id: id, name: 'Mock rider' } });
  if (u.includes('/api/v1/user/profile')) return response({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [remoteAddress] } });
  unknownUrls.push(u);
  throw new Error('unmocked network request');
};
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

const attempt = key => proProvider.checkout({ ...account }, { ...address }, structuredClone(cart), key);

test('real provider path revalidates and sends exactly one POST with receiver details', async () => {
  reset(); const result = await attempt('provider:one');
  assert.equal(result.orderId, id); assert.equal(result.upiIntentUrl, uri); assert.equal(calls, 1);
  assert.equal(placeBodies[0].address_id, 'addr-1'); assert.equal(placeBodies[0].order_total, 150.25);
  assert.equal(placeBodies[0].is_order_for_someone_else, true);
  assert.equal(placeBodies[0].alternate_mobile, address.mobile);
  assert.equal(readSwiggyPlacement('provider:one').state, 'PROVIDER_ACCEPTED');
  await assert.rejects(attempt('provider:one'), e => e.diag?.placementAttempted === true);
  assert.equal(calls, 1); assert.deepEqual(unknownUrls, []);
});

test('stale quote, missing/changed address, recipient, quantity, add-on or variant stop before POST', async () => {
  for (const mutate of [
    () => { meta.order_total = 150.26; },
    () => { meta.address_id = 'another'; },
    () => { delete meta.address_id; },
    () => { remoteAddress.mobile = '9345678901'; },
    () => { meta.cart_menu_items[0].quantity = 2; },
    () => { meta.cart_menu_items[0].addons = [{ group_id: '1', choice_id: '2' }]; },
    () => { meta.cart_menu_items[0].variants = [{ group_id: '5', variation_id: '7' }]; }
  ]) {
    reset(); mutate();
    await assert.rejects(attempt('provider:preflight-' + Math.random()), /Swiggy|receiver|recipient/i);
    assert.equal(calls, 0); assert.deepEqual(unknownUrls, []);
  }
});

test('cart OFO flag na aaye to order rukta nahi — OFO ka sach note me (round 11)', async () => {
  reset();
  remoteAddress = { ...address };
  meta.is_order_for_someone_else = false; // Swiggy ne flag echo nahi kiya
  const out = await attempt('provider:ofo-soft');
  assert.equal(out.orderId, id);
  assert.equal(calls, 1);
  assert.equal(out.ofoConfirmed, false);
  assert.match(out.ofoNote, /OFO flag nahi diya|normal order/i);
});

test('differing receiver cannot be silently sent as a normal order', async () => {
  reset(); const selfModeCart = { ...structuredClone(cart), forSomeoneElse: false };
  await assert.rejects(proProvider.checkout({ ...account }, { ...address }, selfModeCart, 'provider:normal'), /receiver differs/i);
  assert.equal(calls, 0);
});

test('timeout, error status and mismatched UPI amount never try a second endpoint', async () => {
  for (const m of ['timeout', 'status8', 'badamount']) {
    reset(); mode = m; const key = 'provider:' + m;
    await assert.rejects(attempt(key), e => e.diag?.placementAttempted === true);
    assert.equal(calls, 1); assert.ok(readSwiggyPlacement(key));
    await assert.rejects(attempt(key), e => e.diag?.placementAttempted === true);
    assert.equal(calls, 1); assert.deepEqual(unknownUrls, []);
  }
});


test('payment verification rejects HTTP errors, cross-order gateway data, pending and cancelled orders', async () => {
  const paidCheck = ref => checkRealSwiggyPaymentAndExtractTracking({ account: { ...account }, order: { pendingSwiggyOrderId: id, pendingSwiggyPaasId: ref } });
  reset(); gateway = { status: 500, data: { data: 'success' } };
  remoteOrders = [{ order_id: id, order_status: 'Confirmed' }];
  let out = await paidCheck('http-error'); assert.equal(out.paid, false); assert.equal(confirmCalls, 0);

  reset(); gateway = { status: 200, data: { data: { status: 'success', order_id: '123456789099' } } };
  remoteOrders = [{ order_id: id, order_status: 'Confirmed' }];
  out = await paidCheck('wrong-order'); assert.equal(out.paid, false); assert.equal(confirmCalls, 0);

  reset(); gateway = { status: 200, data: { data: 'success' } };
  remoteOrders = [{ order_id: '123456789099', order_status: 'Confirmed' }];
  out = await paidCheck('wrong-history'); assert.equal(out.paid, false); assert.equal(out.paymentVerified, true); assert.equal(confirmCalls, 1);
  await paidCheck('wrong-history'); assert.equal(confirmCalls, 1);

  reset(); gateway = { status: 200, data: { data: 'success' } };
  remoteOrders = [{ order_id: id, order_status: 'Payment pending' }];
  out = await paidCheck('pending-order'); assert.equal(out.paid, false); assert.equal(out.paymentVerified, true);

  reset(); gateway = { status: 200, data: { data: 'success' } };
  remoteOrders = [{ order_id: id, order_status: 'Confirmed', post_status: 'Cancelled' }];
  out = await paidCheck('cancelled-order'); assert.equal(out.paid, false); assert.equal(out.paymentVerified, true);

  reset(); gateway = { status: 200, data: { data: 'success' } };
  remoteOrders = [{ order_id: id, order_status: 'Not confirmed' }];
  out = await paidCheck('not-confirmed'); assert.equal(out.paid, false); assert.equal(out.paymentVerified, true);
});

test('only a verified transaction and the exact confirmed order can return paid', async () => {
  reset(); gateway = { status: 200, data: { data: { status: 'success', order_id: id, transaction_id: 'matching' } } };
  remoteOrders = [{ order_id: id, order_status: 'Confirmed', restaurant_name: 'Mock' }];
  const out = await checkRealSwiggyPaymentAndExtractTracking({ account: { ...account }, order: { pendingSwiggyOrderId: id, pendingSwiggyPaasId: 'matching' } });
  assert.equal(out.paid, true); assert.equal(out.swiggyOrderId, id);
  assert.equal(out.trackingUrl, `https://www.swiggy.com/orders/${id}`); assert.equal(confirmCalls, 1);
});
