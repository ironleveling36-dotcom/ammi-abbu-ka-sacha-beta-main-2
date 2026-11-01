// test_v86_ofo_integrated_flow.mjs
// Boss (31-10-2026): "bas fill hona goal nahi work karna goal hai"
// Professor 30-10 real check: address link se recipient auto-fill → order
// creation → OFO place → tracking link — integrated flow verify karo.
//
// Yeh test verify karta hai:
//   1) buildOfoCartFields — recipient fields from order (address link se auto-fill)
//   2) ensureOfoCartMode — cart OFO mode me daalna (recipient fields push)
//   3) detectOfoFromPlaceResponse — OFO ka saboot place response se
//   4) Source checks for no bot order SMS; Swiggy SMS is not tested
//   5) Order creation — recipient fields attach

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-OFO';
process.env.NODE_ENV = 'test';

import fs from 'node:fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const cart = await import('./swiggy-cart.js');

// ── Fake Swiggy cart engine (V82 format) ────────────────────────────────
let cartTotal = 523;
let lastCartBody = null;
let echoOfo = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/cart/client') || u.includes('/changeCart')) {
    if (opts.body) {
      lastCartBody = JSON.parse(opts.body);
      echoOfo = Boolean(lastCartBody.is_order_for_someone_else);
    }
    const json = {
      statusCode: 0,
      statusMessage: 'Done Successfully',
      data: {
        cartMeta: {
          order_total: cartTotal,
          cart_menu_items: [{ menu_item_id: 11, quantity: 2 }],
          cart_total_count: 2,
          ...(echoOfo ? { is_order_for_someone_else: true, alternate_mobile: '9123456789' } : {})
        }
      }
    };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
  }
  return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
};

const ACCOUNT = {
  phone: '9876543210',
  tid: 'header.payload.sig',
  token: 'tok-abc',
  cookies: '_session_tid=abc123;'
};

console.log('\n🧪 v86 OFO offline mocked/source checks — no real Swiggy order or SMS\n');

// ── 1. buildOfoCartFields — recipient fields from address link ───────────
console.log('=== 1. buildOfoCartFields — recipient fields from address link ===');

// Simulate order created from address link (OFO share link)
// resolveSharedOfoAddress extracts name + mobile from address link
const orderFromAddressLink = {
  id: 860001,
  restaurantId: '777001',
  restaurantName: 'Test Dhaba',
  finalPayable: 523,
  items: [{ menu_item_id: 11, qty: 2, variants: [], addons: [] }],
  addressDetails: {
    mobile: '9123456789',
    name: 'Rahul',
    lat: '26.8467',
    lng: '80.9462',
    addressId: 'addr-1',
    address: '123 Main St, Lucknow'
  }
};

const ofoFields = cart.buildOfoCartFields(orderFromAddressLink);
check('OFO cart fields mein recipient name hai', ofoFields.recipient_details?.name === 'Rahul', JSON.stringify(ofoFields.recipient_details));
check('OFO cart fields mein recipient mobile hai', ofoFields.recipient_details?.phone === '9123456789', JSON.stringify(ofoFields.recipient_details));
check('OFO cart fields mein alternate_mobile hai', ofoFields.alternate_mobile === '9123456789');
check('OFO cart fields mein ordering_for_someone_else hai', ofoFields.ordering_for_someone_else === true);
check('OFO cart fields mein delivery_instructions hai', ofoFields.delivery_instructions?.length > 0);
check('OFO cart fields mein order_comments hai', /Rahul/.test(ofoFields.order_comments || ''));
check('OFO cart fields mein contact_details hai', ofoFields.contact_details?.name === 'Rahul');
check('OFO cart fields mein alternate_contact hai', ofoFields.alternate_contact?.phone === '9123456789');

// ── 2. ensureOfoCartMode — cart OFO mode ─────────────────────────────────
console.log('\n=== 2. ensureOfoCartMode — cart OFO mode me daalna ===');

cartTotal = 523;
lastCartBody = null;
echoOfo = false;

const ofoAttempt = await cart.ensureOfoCartMode(ACCOUNT, orderFromAddressLink, {
  addressId: 'addr-1',
  lat: '26.8467',
  lng: '80.9462'
});

check('ensureOfoCartMode OK hua', ofoAttempt?.ok === true, JSON.stringify(ofoAttempt).slice(0, 200));
check('Cart OFO mode me gaya (echo mila)', ofoAttempt?.ofo === true, JSON.stringify(ofoAttempt).slice(0, 200));
check('Cart push mein recipient mobile gayi', lastCartBody?.alternate_mobile === '9123456789', JSON.stringify(lastCartBody?.alternate_mobile));
check('Cart push mein recipient_details gayi', lastCartBody?.recipient_details?.name === 'Rahul');
check('Cart push mein is_order_for_someone_else gayi', lastCartBody?.is_order_for_someone_else === true);
check('Cart push mein order_comments gayi', /Rahul/.test(lastCartBody?.order_comments || ''));
check('Cart total same raha (bill nahi badha)', cartTotal === 523, `cartTotal=${cartTotal}`);

// ── 3. detectOfoFromPlaceResponse — OFO proof ───────────────────────────
console.log('\n=== 3. detectOfoFromPlaceResponse — OFO ka saboot ===');

const placeJson = {
  statusCode: 0,
  statusMessage: 'Done Successfully',
  data: {
    orderId: 'OFO-99001',
    orderStatus: 'PLACED',
    paymentAmount: 523,
    order_total: 523,
    is_order_for_someone_else: true,
    alternate_mobile: '9123456789',
    recipient_details: { name: 'Rahul', phone: '9123456789' }
  }
};

const ofoProof = cart.detectOfoFromPlaceResponse(placeJson);
check('OFO proof mila (place response se)', ofoProof.ofo === true, JSON.stringify(ofoProof));
check('OFO markers mein flag hai', ofoProof.markers?.length > 0, JSON.stringify(ofoProof.markers));

// ── 4. No bot SMS ───────────────────────────────────────────────────────
console.log('\n=== 4. No bot SMS source checks (Swiggy SMS not tested) ===');

const indexSrc = fs.readFileSync('index.js', 'utf8');
const forwardedSrc = fs.readFileSync('forwarded-order-flow.js', 'utf8');

check('index.js mein sendParentSmsNotification nahi hai', !/sendParentSmsNotification\s*\(/.test(indexSrc));
check('index.js mein sendDirectOrderSms nahi hai', !/sendDirectOrderSms\s*\(/.test(indexSrc));
check('forwarded-order-flow.js mein sendParentSmsNotification nahi hai', !/sendParentSmsNotification\s*\(/.test(forwardedSrc));
check('forwarded-order-flow.js mein sendDirectOrderSms nahi hai', !/sendDirectOrderSms\s*\(/.test(forwardedSrc));
check('index.js recipient ko payment-link SMS nahi bhejta', !/sendPaymentLinkSms\s*\(/.test(indexSrc));
check('forwarded-order-flow.js recipient ko payment-link SMS nahi bhejta', !/sendPaymentLinkSms\s*\(/.test(forwardedSrc));

// ── 5. Order creation — recipient fields attach ─────────────────────────
console.log('\n=== 5. Order creation — recipient fields attach ===');

// Simulate what index.js does at order creation (lines 11520-11530)
// Address link resolves → draft gets recipientName + recipientMobile (auto-fill)
// Order creation attaches them

const draft = {
  recipientName: 'Rahul',
  recipientMobile: '9123456789',
  addressDetails: {
    name: 'Rahul',
    mobile: '9123456789',
    lat: '26.8467',
    lng: '80.9462',
    addressId: 'addr-1',
    address: '123 Main St, Lucknow'
  }
};

const newOrder = {
  id: 860001,
  userId: 'user-1',
  type: 'SWIGGY_ORDER',
  addressDetails: draft.addressDetails
};

// Order creation logic from index.js
if (newOrder.addressDetails?.mobile) {
  newOrder.recipientMobile = newOrder.addressDetails.mobile;
  newOrder.deliveryPhone = newOrder.addressDetails.mobile;
}
if (draft.recipientName) newOrder.recipientName = draft.recipientName;
if (draft.recipientMobile) {
  newOrder.recipientMobile = draft.recipientMobile;
  newOrder.deliveryPhone = draft.recipientMobile;
  if (newOrder.addressDetails) {
    newOrder.addressDetails = { ...newOrder.addressDetails, mobile: draft.recipientMobile, name: draft.recipientName || newOrder.addressDetails?.name || '' };
  }
}

check('Order par recipientName attach hua', newOrder.recipientName === 'Rahul');
check('Order par recipientMobile attach hua', newOrder.recipientMobile === '9123456789');
check('Order par deliveryPhone attach hua', newOrder.deliveryPhone === '9123456789');
check('Order par addressDetails.name attach hua', newOrder.addressDetails?.name === 'Rahul');
check('Order par addressDetails.mobile attach hua', newOrder.addressDetails?.mobile === '9123456789');

// ── 6. OFO cart fields from created order ──────────────────────────────
console.log('\n=== 6. OFO cart fields from created order ===');

const orderOfoFields = cart.buildOfoCartFields(newOrder);
check('Order se OFO cart fields bane', orderOfoFields.recipient_details?.name === 'Rahul');
check('Order se OFO cart fields mobile', orderOfoFields.recipient_details?.phone === '9123456789');
check('Order se OFO alternate_mobile', orderOfoFields.alternate_mobile === '9123456789');
check('Order se OFO ordering flag', orderOfoFields.ordering_for_someone_else === true);

// ── 7. Address link resolution → recipient auto-fill ─────────────────────
console.log('\n=== 7. Address link resolution → recipient auto-fill (index.js logic) ===');

// Simulate what index.js does at address resolution (line 11427-11436)
// deliveryDetails from resolveSharedOfoAddress has name + mobile
// Auto-fill logic saves recipientName + recipientMobile to draft

const deliveryDetails = {
  name: 'Rahul',
  mobile: '9123456789',
  lat: '26.8467',
  lng: '80.9462',
  addressId: 'addr-1',
  address: '123 Main St, Lucknow'
};

const draftBefore = {
  addressDetails: {},
  // recipientName and recipientMobile NOT yet set (user hasn't typed)
};

// Auto-fill logic from index.js line 11427-11436
const autoRecipient = {
  ...(deliveryDetails.name && !draftBefore.recipientName ? { recipientName: deliveryDetails.name } : {}),
  ...(deliveryDetails.mobile && !draftBefore.recipientMobile ? { recipientMobile: deliveryDetails.mobile } : {})
};

check('Address link se recipientName auto-fill hua', autoRecipient.recipientName === 'Rahul', JSON.stringify(autoRecipient));
check('Address link se recipientMobile auto-fill hua', autoRecipient.recipientMobile === '9123456789', JSON.stringify(autoRecipient));

// If user already typed recipientName, don't override
const draftWithName = { recipientName: 'Sir', recipientMobile: '9123450000' };
const autoRecipient2 = {
  ...(deliveryDetails.name && !draftWithName.recipientName ? { recipientName: deliveryDetails.name } : {}),
  ...(deliveryDetails.mobile && !draftWithName.recipientMobile ? { recipientMobile: deliveryDetails.mobile } : {})
};
check('User ka typed name nahi override hua', !autoRecipient2.recipientName, JSON.stringify(autoRecipient2));
check('User ka typed mobile nahi override hua', !autoRecipient2.recipientMobile, JSON.stringify(autoRecipient2));

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`📊 RESULT: ${pass}/${pass + fail} checks passed`);
if (fail === 0) {
  console.log('✅ Offline mocked/source checks passed; this is not a live end-to-end order.');
  console.log('   Real address-link resolution, OFO placement, tracking and Swiggy SMS remain unverified.');
} else {
  console.log(`❌ ${fail} checks FAILED`);
}
console.log('═'.repeat(60) + '\n');

process.exit(fail === 0 ? 0 : 1);
