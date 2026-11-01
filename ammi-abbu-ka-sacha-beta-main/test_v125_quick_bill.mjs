// Swiggy-shaped mocked HTTP only: this is not a live bill or order test.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-bill-offline-'));
Object.assign(process.env, { DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'), BOT_TOKEN: '123456:offline', NODE_ENV: 'test', DB_ASYNC_WRITE: '0', PRO_COUPON_TRIALS: '1' });
const { proProvider } = await import('./swiggy-pro-provider.js');
const realFetch = globalThis.fetch;
const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567' })).toString('base64url') + '.signature';
const address = { id: 'addr-1', name: 'Receiver', mobile: '9123456789', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', city: 'Pune', selected: true };
const account = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const cart = { restaurantId: '123', restaurantName: 'Mock', forSomeoneElse: true, quickBill: true, autoOneLite: false,
  items: [{ menu_item_id: 456, qty: 1, variants: [], addons: [] }], activeSubscriptionItems: [] };
let remoteAddress, meta, requests, updateBodies, trialMode, failSettle;
function reset() {
  remoteAddress = { ...address }; requests = []; updateBodies = []; trialMode = false; failSettle = false;
  meta = { order_total: 150.25, item_total: 125, delivery_charges: 20, taxesAndCharges: 5.25,
    cartId: 'cart-1', address_id: 'addr-1', restaurant_details: { id: '123', name: 'Mock' },
    cart_menu_items: [{ menu_item_id: 456, quantity: 1, name: 'Meal', subtotal: 12500, addons: [], variants: [] }] };
}
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (raw, options = {}) => {
  const url = String(raw); requests.push(url);
  if (url.includes('/api/v2/cart/client/update')) {
    const body = JSON.parse(options.body);
    updateBodies.push(body);
    if (trialMode) {
      if (failSettle && updateBodies.length > 1 && !body.couponCode) return response({ statusCode: 1, statusMessage: 'settle failed' });
      meta.order_total = body.couponCode ? 160.25 : 150.25;
      meta.coupon_code = body.couponCode || '';
      meta.is_coupon_valid = 0;
      meta.coupon_discount_total = 0;
    }
    return response({ statusCode: 0, tid: jwt, data: {} });
  }
  if (url.includes('/api/v2/cart/client')) return response({ statusCode: 0, tid: jwt, data: { cartMeta: { ...meta, addresses: [remoteAddress] } } });
  if (url.includes('/dapi/order/all')) return response({ statusCode: 0, tid: jwt, data: { orders: [] } });
  if (url.includes('/api/v1/user/profile')) return response({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [remoteAddress] } });
  if (url.includes('/dapi/address')) return response({ statusCode: 0, data: [remoteAddress] });
  throw new Error('Unmocked offline request');
};
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

test('quick bill uses provider cart/address readback, no offer search or paid subscription', async () => {
  reset();
  const out = await proProvider.quoteCart({ ...account }, { ...address }, structuredClone(cart), '');
  assert.equal(out.bill.total, 150.25);
  assert.equal(out.address.id, 'addr-1');
  assert.equal(updateBodies.length, 1);
  assert.deepEqual(updateBodies[0].subscriptionItems, []);
  assert.equal(updateBodies[0].is_order_for_someone_else, true);
  assert.equal(updateBodies[0].alternate_mobile, address.mobile);
  assert.equal(requests.some(x => /offers\/(payment|restaurant)|fetch_food_coupons|claim.*offer/i.test(x)), false);
  assert.match(out.bill.engine.notes.join(' '), /offers.*not checked/i);
});

test('quick bill refuses changed recipient, items, address or invalid payable', async () => {
  for (const mutate of [
    () => { remoteAddress.mobile = '9345678901'; },
    () => { meta.address_id = 'wrong-address'; },
    () => { meta.cart_menu_items[0].quantity = 2; },
    () => { meta.order_total = 0; }
  ]) {
    reset(); mutate();
    await assert.rejects(proProvider.quoteCart({ ...account }, { ...address }, structuredClone(cart), ''), /Swiggy|address|cart|receiver|recipient|amount|location/i);
  }
});

test('offer trials settle and read back the final cart; a failed settle returns no stale bill', async () => {
  reset(); trialMode = true;
  const full = { ...structuredClone(cart), quickBill: false, skipOfferClaim: true };
  const out = await proProvider.quoteCart({ ...account }, { ...address }, full, '');
  assert.ok(updateBodies.length >= 3, 'base, coupon trial and final settlement');
  assert.equal(updateBodies.at(-1).couponCode, '');
  assert.equal(out.bill.total, 150.25);
  assert.equal(out.bill.total, meta.order_total, 'bill matches final readback');
  assert(updateBodies.every(b => b.subscriptionItems.length === 0), 'no One Lite subscription added');
  reset(); trialMode = true; failSettle = true;
  await assert.rejects(proProvider.quoteCart({ ...account }, { ...address }, full, ''), /settle failed|Swiggy/i);
});
