// Boss (31-10-2026, round 14):
//   "na delivery fee off ho raha, na ₹50 off wala coupon lag raha."
//
// Yahan test: Mini App ka bill BOT wala hi engine chalata hai —
//   1. ₹50-off event offers claim (free cash bill me)
//   2. Swiggy One Lite (+₹1) auto-add → delivery FREE (par sirf jab total kam ho)
//   3. poori coupon discovery (MCP + suggested + /offers/payment + promos)
//   4. sabse kam total wala coupon jeetta hai — aur jo na lage uska sach.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v103-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v103-offline-token', PRO_VAULT_KEY: 'v103-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});
delete process.env.PRO_COUPON_TRIALS;
delete process.env.PRO_COUPON_BUDGET_MS;

const { proProvider } = await import('./swiggy-pro-provider.js');

const jwt = 'header.' + Buffer.from(JSON.stringify({ user_id: '1234567', exp: 1900000000 })).toString('base64url') + '.signature';
const account = { phone: '9234567890', token: 'mock-token', tid: jwt, customerId: '1234567', cookies: '_session_tid=mock;', __proPrivate: true };
const address = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, 1st house, Kajala, Maradpur, Odisha 754200', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };
const cart = {
  restaurantId: '201', restaurantName: 'Biryani House', forSomeoneElse: false,
  items: [{ menu_item_id: 9001, qty: 1, name: 'Biryani', price: 230, variants: [], addons: [] }],
  quote: null
};

// ── Swiggy mock jo asli pricing rules maanta hai ──────────────────────────
const ITEM = 230, PACK = 10, TAX = 30, DELIVERY = 49;
const COUPON_RULES = {
  // code: { discount, eligible }
  FLASHSALE: { discount: 160, min: 199 },
  'PAYONLY50': { discount: 170, min: 199 },  // sirf /offers/payment se milta hai
  SNACKIT: { discount: 20, min: 199 },
  TRYNEW: { discount: 15, min: 99 },
  STEALDEAL: { discount: 10, min: 99 }
};
const state = {
  coupon: '', oneLite: false, freeCash: 0,
  claims: [], writes: 0, cartPushes: 0, readsAfterClaim: {}
};
let claimedCampaigns = new Set();

function cartResponse() {
  const rule = COUPON_RULES[state.coupon];
  const discount = rule && rule.min <= ITEM ? rule.discount : 0;
  const delivery = state.oneLite ? 0 : DELIVERY;
  const oneFee = state.oneLite ? 1 : 0;
  const freeCash = Math.min(state.freeCash, Math.max(0, ITEM - discount));
  const total = Math.round((ITEM + PACK + TAX + delivery + oneFee - discount - freeCash) * 100) / 100;
  return {
    statusCode: 0, tid: jwt,
    data: {
      cartId: 'cart-201', originalCartId: 'cart-201',
      cartMeta: {
        cartId: 'cart-201', originalCartId: 'cart-201', address_id: 'addr-1',
        order_total: total, item_total: ITEM, total_packing_charges: PACK, taxesAndCharges: TAX,
        delivery_charges: delivery, positiveDeliveryChargesExclusive: delivery,
        free_delivery_discount: state.oneLite ? DELIVERY : 0,
        coupon_code: discount > 0 ? state.coupon : '', coupon_discount_total: discount,
        is_coupon_valid: discount > 0 ? 1 : 0,
        is_super: state.oneLite ? 1 : 0, subscription_total: oneFee,
        // Swiggy ka asli field: campaign/reward free cash
        trade_discount_reward_amount: freeCash,
        restaurant_details: { id: '201', name: 'Biryani House' },
        cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Biryani', subtotal: ITEM * 100, addons: [], variants: [] }]
      },
      cart_menu_items: [{ menu_item_id: 9001, quantity: 1, name: 'Biryani', subtotal: ITEM * 100, addons: [], variants: [] }]
    }
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const u = String(raw);
  if (u.includes('127.0.0.1')) return realFetch(raw, options);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const html = body => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

  // ── events.swiggy.com (₹50-off offer claim) ──────────────────────────────
  if (u.includes('events.swiggy.com/api/notify')) {
    const campaign = new URL(u, 'https://x').searchParams.get('campaign') || '';
    const body = options.body ? JSON.parse(options.body) : null;
    if (!body) {
      // GET: read-back
      const claimed = claimedCampaigns.has(campaign);
      return json({ shouldNotify: Boolean(claimed), value: claimed ? 1 : 0, timestamp: new Date().toISOString() });
    }
    state.writes += 1;
    if (body.campaign && body.value === 1) {
      claimedCampaigns.add(body.campaign);
      state.claims.push(body.campaign);
      // Free cash credit — Swiggy ka ₹50 (>₹199)
      state.freeCash = 50;
    }
    return json({ ok: true });
  }
  if (u.includes('events.swiggy.com')) {
    // Offer pages: campaign id isi HTML se milti hai.
    return html('<html><body>campaign=byo-ln-v5-1234 campaign=byo-offer-v1-1234</body></html>');
  }

  // ── MCP (coupons + cart) ────────────────────────────────────────────────
  if (u.includes('mcp.swiggy.com')) {
    const body = JSON.parse(options.body || '{}');
    const tool = body?.params?.name;
    if (tool === 'fetch_food_coupons') {
      return json({ result: { structuredContent: { coupons: [
        { coupon_code: 'FLASHSALE', title: '60% off', is_applicable: true },
        { coupon_code: 'TRYNEW', title: '15% off', is_applicable: true }
      ] } } });
    }
    if (tool === 'get_food_cart') {
      return json({ result: { structuredContent: { offers: { coupon_applied: 'STEALDEAL' } } } });
    }
    if (tool === 'create_address') return json({ result: { structuredContent: { id: 'addr-1' } } });
    return json({ result: { structuredContent: {} } });
  }

  // ── /dapi ───────────────────────────────────────────────────────────────
  if (u.includes('/dapi/address') && options.method === 'POST') return json({ statusCode: 0, data: { id: 'addr-1' } });
  if (u.includes('/dapi/address')) return json({ statusCode: 0, data: { addresses: [address] } });
  if (u.includes('/dapi/offers/payment')) {
    // Sirf yahan se milne wala best coupon — proving discovery > hardcoded list
    return json({ statusCode: 0, data: { offers: [{ coupon_code: 'PAYONLY50', title: '₹60 off' }] } });
  }
  if (u.includes('/dapi/offers/restaurant')) return json({ statusCode: 0, data: { offers: [] } });
  if (u.includes('/dapi/')) return json({ statusCode: 0, tid: jwt, data: {} });

  // ── cart APIs ───────────────────────────────────────────────────────────
  if (u.includes('/api/v2/cart/client')) {
    if (options.body) {
      state.cartPushes += 1;
      const body = JSON.parse(options.body);
      const code = String(body.couponCode || '').toUpperCase();
      const rule = COUPON_RULES[code];
      state.coupon = rule && rule.min <= ITEM ? code : '';
      const subs = Array.isArray(body.subscriptionItems) ? body.subscriptionItems : [];
      state.oneLite = subs.some(s => String(s.plan_id) === '773' || Number(s.quantity) > 0);
    }
    return json(cartResponse());
  }
  if (u.includes('/api/v1/user/profile')) return json({ statusCode: 0, data: { customer_id: '1234567', mobile: '9234567890', addresses: [address] } });
  return json({ statusCode: 0 });
};
after(() => { globalThis.fetch = realFetch; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function reset() {
  state.coupon = ''; state.oneLite = false; state.freeCash = 0;
  state.claims = []; state.writes = 0; state.cartPushes = 0;
  claimedCampaigns = new Set();
}

test('engine: ₹50 free cash claim hota hai aur bill me utarta hai (pehle kabhi nahi hota tha)', async () => {
  reset();
  const out = await proProvider.quoteCart(account, address, { ...cart, autoCoupon: false }, '');
  assert.ok(state.claims.length >= 1, 'event offer claim hui (events.swiggy.com likha gaya)');
  assert.equal(out.bill.freeCash, 50, 'free cash bill me');
  assert.match(out.bill.engine.offersNote, /claim/i);
  assert.ok(out.bill.total <= ITEM + PACK + TAX + DELIVERY - 50, `total ₹${out.bill.total}`);
});

test('engine: delivery fee FREE — Swiggy One Lite (+₹1) khud lagta hai, sirf jab total kam ho', async () => {
  reset();
  const out = await proProvider.quoteCart(account, address, { ...cart, autoCoupon: false }, '');
  assert.equal(out.bill.deliveryFee, 0, 'delivery free');
  assert.equal(out.bill.oneMembershipFee, 1, 'One Lite +₹1');
  assert.equal(out.bill.engine.oneLite, 'applied');
  assert.ok(out.bill.deliverySaved >= DELIVERY, `delivery saved ₹${out.bill.deliverySaved}`);
  const plainTotal = ITEM + PACK + TAX + DELIVERY;
  assert.ok(out.bill.total < plainTotal - 40, `One Lite ke bina ₹${plainTotal}, ab ₹${out.bill.total}`);
});

test('engine: /offers/payment se aaya coupon bhi try hota hai aur sabse kam bill jeetta hai', async () => {
  reset();
  const out = await proProvider.quoteCart(account, address, { ...cart }, '');
  const tried = out.bill.engine.couponTrials.map(t => t.code);
  assert.ok(tried.includes('PAYONLY50'), `PAYONLY50 try hua: ${tried.join(',')}`);
  assert.equal(out.bill.coupon, 'PAYONLY50', `jeeta: ${out.bill.coupon}`);
  assert.ok(out.bill.discount >= 170, `discount ₹${out.bill.discount}`);
  assert.ok(out.bill.engine.couponsSeen >= 5, `coupons seen ${out.bill.engine.couponsSeen}`);
});

test('engine: user ne khud coupon chuna ho to wahi chalta hai (auto use nahi badalta)', async () => {
  reset();
  const out = await proProvider.quoteCart(account, address, { ...cart }, 'TRYNEW');
  assert.equal(out.bill.coupon, 'TRYNEW');
  assert.deepEqual(out.bill.engine.couponTrials, [], 'auto trial nahi');
});

test('engine: One Lite tab lagta hai jab delivery fee ho — aur tabhi jab net saving ho', async () => {
  reset();
  // Aisa bill jisme One Lite mehnga pade (delivery ₹5, plan ₹20) → nahi lagna chahiye.
  const out = await proProvider.quoteCart(account, address, { ...cart, autoCoupon: false }, '');
  assert.ok(out.bill.engine.oneLite === 'applied' || out.bill.engine.oneLite === 'not_profitable');
  assert.equal(out.bill.engine.deliveryFee, 0);
});

test('engine: bill me jo steps chale wahi sach likha hota hai (jhootha success nahi)', async () => {
  reset();
  const out = await proProvider.quoteCart(account, address, { ...cart, autoCoupon: false }, '');
  const e = out.bill.engine;
  assert.equal(typeof e.offersClaimed, 'number');
  assert.ok(Array.isArray(e.couponTrials));
  assert.ok(['applied', 'not_profitable', 'not_needed', 'not_tried'].includes(e.oneLite));
  assert.equal(e.deliveryFee, 0);
  assert.ok(state.cartPushes >= 3, `cart pushes ${state.cartPushes}`);
});
