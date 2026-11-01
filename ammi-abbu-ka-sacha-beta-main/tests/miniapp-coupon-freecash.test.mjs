// Offline regression: coupon apply/remove fallback, Free Cash visibility,
// parser effective-discount handling, and the curved circular bill loader.
// No live Swiggy/Telegram/UPI request is made.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-coupon-freecash-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-coupon-test', NODE_ENV: 'test', DB_ASYNC_WRITE: '0',
  SWIGGY_BLOCK_LIVE_ORDER_PLACE: '1'
});
const { proProvider, addressFingerprint } = await import('../swiggy-pro-provider.js');
const { parseDapiCartPayload } = await import('../swiggy-cart.js');

const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567', exp: 1900000000 })).toString('base64url') + '.signature';
const account = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const address = { id: 'addr-1', name: 'Receiver', mobile: '9234567890', address: 'Test Road 1', lat: '18.5204', lng: '73.8567', selected: true };
const baseCart = () => ({
  restaurantId: '201', restaurantName: 'Mock', forSomeoneElse: false, autoCoupon: false, skipOfferClaim: true,
  confirmedAddress: { ...address, fingerprint: addressFingerprint(address), savedAt: Date.now() },
  items: [{ menu_item_id: 9001, qty: 1, name: 'Biryani', price: 230, variants: [], addons: [] }],
  quote: null
});
const state = { coupon: '', trade: 0, reward: 0, bulkHonorsCoupon: true, bulkHonorsRemove: true, applyCalls: 0, removeCalls: 0, discoveryCalls: 0 };
function reset() { Object.assign(state, { coupon: '', trade: 0, reward: 0, bulkHonorsCoupon: true, bulkHonorsRemove: true, applyCalls: 0, removeCalls: 0, discoveryCalls: 0 }); }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function cartPayload() {
  const discount = state.coupon === 'SAVE50' ? 50 : 0;
  const total = 270 - discount - state.trade;
  return { statusCode: 0, data: { cartMeta: {
    address_id: 'addr-1', cartId: 'cart-1', order_total: total, item_total: 230,
    restaurant_details: { id: '201', name: 'Mock' },
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Biryani', subtotal: 23000, final_price: 23000, addons: [], variants: [] }],
    coupon_code: state.coupon, is_coupon_valid: state.coupon ? 1 : 0,
    coupon_discount_total: discount, coupon_discount_effective: discount,
    trade_discount_total: state.trade, trade_discount_reward_amount: state.reward,
    user_swiggy_money: 0, swiggy_money: 0, positiveDeliveryChargesExclusive: 0,
    taxesAndCharges: 30, total_packing_charges: 10, is_order_for_someone_else: false
  } } };
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('mcp.swiggy.com') || u.includes('/dapi/offers/')) { state.discoveryCalls++; return json({ statusCode: 0, data: { offers: [] }, result: { structuredContent: { coupons: [] } } }); }
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwt, data: { addresses: [address] } });
  if (u.includes('events.swiggy.com')) return new Response('<html></html>', { status: 200 });
  if (u.includes('/api/v2/cart/client')) {
    const body = options.body ? JSON.parse(options.body) : null;
    if (u.includes('applycoupon')) { state.applyCalls++; state.coupon = String(body?.coupon_code || body?.couponCode || '').toUpperCase(); return json(cartPayload()); }
    if (u.includes('removecoupon')) { state.removeCalls++; state.coupon = ''; return json(cartPayload()); }
    if (u.includes('/flush')) return json({ statusCode: 0, data: {} });
    if (u.includes('/update') && body) {
      const code = String(body.couponCode || '').toUpperCase();
      if (code && state.bulkHonorsCoupon) state.coupon = code;
      if (!code && state.bulkHonorsRemove) state.coupon = '';
      return json(cartPayload());
    }
    return json(cartPayload());
  }
  return json({ statusCode: 0, data: {} });
};
after(() => { globalThis.fetch = realFetch; });

test('parser: positive coupon_discount_effective is not hidden by a zero total', () => {
  const parsed = parseDapiCartPayload({ cartMeta: {
    item_total: 230, order_total: 180, coupon_code: 'SAVE50', is_coupon_valid: true,
    coupon_discount_total: 0, coupon_discount_effective: 50,
    cart_menu_items: [{ menu_item_id: 9001, quantity: 1, subtotal: 23000, final_price: 23000 }]
  } });
  assert.equal(parsed.couponCode, 'SAVE50');
  assert.equal(parsed.discountAmount, 50);
});

test('provider: bulk cart ignores couponCode -> dedicated applycoupon endpoint applies and readback verifies', async () => {
  reset(); state.bulkHonorsCoupon = false;
  const out = await proProvider.quoteCart(account, address, baseCart(), 'SAVE50', { phase: 'full', autoCoupon: false });
  assert.equal(out.bill.couponCode, 'SAVE50');
  assert.equal(out.bill.discount, 50);
  assert.equal(out.bill.total, 220);
  assert.ok(state.applyCalls >= 1, 'dedicated coupon endpoint was used');
});

test('provider: REMOVE actually clears coupon and autoCoupon=false does not reapply', async () => {
  reset(); state.coupon = 'SAVE50'; state.bulkHonorsRemove = false;
  const out = await proProvider.quoteCart(account, address, { ...baseCart(), autoCoupon: false }, '', { phase: 'full', autoCoupon: false });
  assert.equal(out.bill.couponCode, '');
  assert.equal(out.bill.total, 270);
  assert.ok(state.removeCalls >= 1, 'dedicated remove endpoint was used');
  assert.equal(state.discoveryCalls, 0, 'autoCoupon=false skips coupon discovery');
});

test('provider: campaign Free Cash inside trade discount is shown once, not as restaurant discount', async () => {
  reset(); state.trade = 50; state.reward = 50;
  const out = await proProvider.quoteCart(account, address, baseCart(), '', { phase: 'full', autoCoupon: false });
  assert.equal(out.bill.freeCash, 50);
  assert.equal(out.bill.tradeDiscount, null);
  assert.equal(out.bill.total, 220);
});

test('UI: bill/coupon loading uses curved circular loader and Pay Now has no dash/clock chip', () => {
  const app = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../swiggy-pro.css', import.meta.url), 'utf8');
  assert.match(app, /function playLoader\(/);
  assert.match(app, /bill-loading-card/);
  assert.match(css, /\.play-loader-arc/);
  assert.match(css, /stroke-linecap: round/);
  assert.equal(/idle-chip/.test(app), false);
  assert.equal(/bill-paper/.test(app), false);
  assert.match(app, /coupon-code/);
});
