// ============================================================================
// V34 — Customer "Send to Beta" -> Auto Max Coupon Account Selection ->
//       Bill Confirmation Delivery -> Customer Approval -> Payment QR E2E
// ============================================================================
// Locks in every stage of the customer order pipeline:
//   1. Real `findBestMaxCouponAccountForOrder` inside `autoOptimizeUserOrder`
//      persists `selectedAccount`, `orderAccount`, `couponCode`, `discountAmount`,
//      and `finalPayable` across `getDb()` reloads (never wiped by stale disk read!).
//   2. `jwtTid` + `token` Android accounts (with zero `_session_tid` cookie) AND
//      web-cookie accounts both pass eligibility & cart sync cleanly.
//   3. Inline `action_send_to_boss` AND Reply-Keyboard `🚀 Send to Beta` keep
//      `userChatCards` + `order.userMessageId` synced, delivering `APPROVAL_PENDING`
//      with `[ ✓ Approve bill ]` in-place without duplicate customer edits.
//   4. Customer tapping `[ ✓ Approve bill ]` receives a scannable personalised
//      Payment QR photo even when `swiggyPaymentUrl` holds the generic
//      `https://www.swiggy.com/checkout` placeholder.
//   5. Boss ID testing customer `"Send to Beta"` (`isCustomerSubmitted: true`)
//      receives Bill Confirmation (`CUSTOMER_AND_BOSS`), while Forwarded /
//      Direct-Boss orders remain strictly `BOSS_ONLY`.
//   6. Verified ₹0 payable bills (100% covered by Free Cash / coupons) still
//      deliver Bill Confirmation, and ineligible coupon trials that leave no
//      active coupon never falsely fail with `COUPON_CLEAR_FAILED`.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-V34-E2E';
process.env.NODE_ENV = 'test';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const restoreDb = () => {
  if (dbSnapshot !== null) {
    try { fs.writeFileSync(DB_PATH, dbSnapshot, 'utf8'); } catch {}
  }
};
process.on('exit', restoreDb);

function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const JWT_ZERO_ORDER = makeJwt({ user_id: '700001', exp: 4102444800 });
const JWT_USED_ORDER = makeJwt({ user_id: '700002', exp: 4102444800 });

// Track every Swiggy endpoint hit so we also verify NO 29-account pre-scan storm happens!
const fetchCalls = [];
let simulateWebDapiWaf202 = false;

function buildMockCartResponse({ userId, couponCode = '', addressId = 'addr_live_1' }) {
  const code = String(couponCode || '').trim().toUpperCase();
  const isZeroAcc = String(userId) === '700001';
  let appliedCode = '';
  let couponDiscount = 0;

  if (code === 'REMOVE') {
    appliedCode = '';
    couponDiscount = 0;
  } else if (code === 'WELCOME120' && isZeroAcc) {
    appliedCode = 'WELCOME120';
    couponDiscount = 120;
  } else if (code === 'FEAST60') {
    appliedCode = 'FEAST60';
    couponDiscount = 60;
  }

  const itemTotal = 240;
  const taxes = 18;
  const orderTotal = Math.max(0, itemTotal - couponDiscount + taxes);

  return {
    statusCode: 0,
    tid: isZeroAcc ? JWT_ZERO_ORDER : JWT_USED_ORDER,
    sid: `sid_${userId}`,
    deviceId: `dev_${userId}`,
    data: {
      cartMeta: {
        cartId: 991122,
        restaurantId: '1467977',
        restaurant_details: { id: '1467977', name: 'Royal Darbar Biryani' },
        address_id: addressId,
        addresses: [
          {
            id: addressId,
            selected: true,
            name: 'Ammi',
            mobile: '9876543210',
            flat_no: 'Flat 202',
            area: 'Hazratganj',
            landmark: 'Near Metro',
            city: 'Lucknow',
            address: 'Flat 202, Hazratganj, Lucknow, Uttar Pradesh 226001',
            lat: '26.8500000',
            lng: '80.9499970',
            annotation: 'Home'
          }
        ],
        item_total: itemTotal,
        order_total: orderTotal,
        total_tax: taxes,
        positiveDeliveryChargesExclusive: 0,
        free_delivery_discount: 35,
        swiggyOneBenefitsApplicable: true,
        coupon_code: appliedCode || (isZeroAcc && !code ? 'WELCOME120' : (!code ? 'FEAST60' : '')),
        is_coupon_valid: appliedCode ? 1 : 0,
        coupon_discount_total: couponDiscount
      },
      cartItems: {
        551100: {
          itemId: 551100,
          quantity: 2,
          items: [
            {
              menu_item_id: 551100,
              name: 'Chicken Dum Biryani',
              quantity: 2,
              base_price: 12000,
              subtotal: 24000,
              final_price: 24000
            }
          ]
        }
      }
    }
  };
}

let activeCouponByUser = {};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = String(init?.method || 'GET').toUpperCase();
  const headers = init?.headers || {};
  const getHeader = (k) => {
    const low = k.toLowerCase();
    for (const [hk, hv] of Object.entries(headers)) {
      if (hk.toLowerCase() === low) return String(hv || '');
    }
    return '';
  };
  fetchCalls.push({ url: u, method });

  // Simulate AWS WAF HTTP 202 on web `/dapi/*` when enabled
  if (simulateWebDapiWaf202 && u.includes('www.swiggy.com/dapi/')) {
    return {
      ok: false,
      status: 202,
      headers: { get: (h) => (String(h).toLowerCase() === 'x-amzn-waf-action' ? 'challenge' : null) },
      text: async () => '',
      json: async () => null
    };
  }

  // Group cart resolution
  if (u.includes('shared_cart')) {
    const gcData = {
      statusCode: 0,
      data: {
        group_cart_status: 'ACTIVE',
        restaurant_id: '1467977',
        restaurant_details: { id: '1467977', name: 'Royal Darbar Biryani' },
        cart_Key: 'gc_test_642855918',
        menu_items: [
          { menu_item_id: 551100, name: 'Chicken Dum Biryani', quantity: 2, price: 12000, subtotal: 24000 }
        ]
      }
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(gcData),
      json: async () => gcData
    };
  }

  // Native Android Profile (`profile.swiggy.com`)
  if (u.includes('profile.swiggy.com')) {
    const tidHdr = getHeader('tid');
    const tokHdr = getHeader('token');
    const isZero = tidHdr === JWT_ZERO_ORDER || tokHdr === 'tok_zero_700001';
    const uid = isZero ? '700001' : '700002';
    const profJson = {
      statusCode: 0,
      data: {
        customer_id: uid,
        name: isZero ? 'Fresh Vault 01' : 'Used Vault 02',
        mobile: isZero ? '9111100001' : '9111100002',
        token: isZero ? 'tok_zero_700001' : 'tok_used_700002',
        addresses: [
          {
            id: 'addr_live_1',
            name: 'Ammi',
            mobile: '9876543210',
            flat_no: 'Flat 202',
            area: 'Hazratganj',
            landmark: 'Near Metro',
            city: 'Lucknow',
            address: 'Flat 202, Hazratganj, Lucknow, Uttar Pradesh 226001',
            lat: '26.8500000',
            lng: '80.9499970',
            annotation: 'Home'
          }
        ]
      }
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(profJson),
      json: async () => profJson
    };
  }

  // Native Android Checkout Cart (`chkout.swiggy.com/api/v2/cart/client`)
  if (u.includes('chkout.swiggy.com/api/v2/cart/client')) {
    const tidHdr = getHeader('tid');
    const tokHdr = getHeader('token');
    const isZero = tidHdr === JWT_ZERO_ORDER || tokHdr === 'tok_zero_700001';
    const uid = isZero ? '700001' : '700002';

    if (u.includes('/flush')) {
      activeCouponByUser[uid] = '';
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ statusCode: 0 }),
        json: async () => ({ statusCode: 0 })
      };
    }

    if (method === 'POST' && init?.body) {
      let parsed = {};
      try { parsed = JSON.parse(String(init.body)); } catch {}
      const reqCoupon = parsed?.cart?.couponCode ?? parsed?.couponCode ?? parsed?.coupon_code;
      if (reqCoupon !== undefined) {
        activeCouponByUser[uid] = reqCoupon === '' ? 'REMOVE' : String(reqCoupon);
      }
    }

    const resp = buildMockCartResponse({
      userId: uid,
      couponCode: activeCouponByUser[uid] || ''
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(resp),
      json: async () => resp
    };
  }

  // Offers discovery endpoint
  if (u.includes('offers/payment') || u.includes('offers/restaurant')) {
    const offJson = {
      statusCode: 0,
      data: {
        cards: [
          { card: { card: { couponCode: 'INELIGIBLE999', title: 'Not applicable coupon' } } },
          { card: { card: { couponCode: 'WELCOME120', title: 'Flat ₹120 OFF' } } },
          { card: { card: { couponCode: 'FEAST60', title: 'Flat ₹60 OFF' } } }
        ]
      }
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(offJson),
      json: async () => offJson
    };
  }

  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => '{}',
    json: async () => ({ statusCode: 1 })
  };
};

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

async function waitUntil(pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return Boolean(await pred());
}

const {
  bot,
  autoOptimizeUserOrder,
  approveUserOrderBillAction,
  sendApprovedOrderPaymentToUser,
  formatUserOrderCard
} = await import('./index.js');
const {
  resolveBillSummaryAudience,
  shouldSendSummaryToCustomer,
  sendBillSummaryToCustomerOnce
} = await import('./forwarded-order-flow.js');
const { applyMaxOfferToOrder, invalidateAccountOrderProfileCache } = await import('./swiggy-cart.js');
const { getDb, saveDb, mutateDb, updateDraft } = await import('./store.js');

const tgCalls = [];
let nextMsgId = 100;
const fakeCallApi = async (method, payload = {}) => {
  tgCalls.push({ method, payload });
  if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendPhoto') {
    const id = method === 'editMessageText' ? (payload.message_id || ++nextMsgId) : ++nextMsgId;
    return {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: 'private' },
      text: payload.text || payload.caption || '',
      photo: method === 'sendPhoto' ? [{ file_id: `file_qr_${id}` }] : undefined
    };
  }
  if (method === 'answerCallbackQuery' || method === 'deleteMessage') return true;
  if (method === 'getMe') return { id: 123456, is_bot: true, first_name: 'Beta Bot', username: 'beta_bot' };
  return true;
};
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const BOSS_ID = 6484999726;
const AMMI_ID = 424242;

// Configure two vault accounts:
//   - `acc_9111100001`: 0-Order pure Android (`jwtTid` + `token`, NO `cookies` / `tid`!) -> wins ₹120 coupon (`₹138` total)
//   - `acc_9111100002`: 3-Order account -> gets ₹60 coupon (`₹198` total)
// AND turn on `simulateWebDapiWaf202 = true` so Web `/dapi/*` returns HTTP 202 WAF challenge!
simulateWebDapiWaf202 = true;
mutateDb((d) => {
  d.config.bossIds = [BOSS_ID];
  d.config.familyMembers = { [AMMI_ID]: 'Ammi' };
  d.config.accounts = {
    acc_9111100001: {
      name: 'Fresh Vault 01',
      phone: '9111100001',
      isLoggedIn: true,
      cookies: '',
      tid: '',
      jwtTid: JWT_ZERO_ORDER,
      token: 'tok_zero_700001',
      sid: 'sid_700001',
      deviceId: 'dev_700001',
      customerId: '700001',
      totalOrdersCount: 0
    },
    acc_9111100002: {
      name: 'Used Vault 02',
      phone: '9111100002',
      isLoggedIn: true,
      cookies: '_session_tid=deadbeef123456',
      tid: JWT_USED_ORDER,
      jwtTid: JWT_USED_ORDER,
      token: 'tok_used_700002',
      sid: 'sid_700002',
      deviceId: 'dev_700002',
      customerId: '700002',
      totalOrdersCount: 3
    }
  };
  d.orders = {};
});
invalidateAccountOrderProfileCache();

// ----------------------------------------------------------------------------
// Scenario 1: Inline `[ 🚀 Send to Beta ]` -> Real Auto Max Coupon scan under
//             Web WAF 202 -> Selects 0-Order Android `jwtTid` account ->
//             Persists across `getDb()` -> Sends Bill Confirmation on Single Card!
// ----------------------------------------------------------------------------
console.log('\n--- Scenario 1: Live Customer Inline "Send to Beta" -> Auto Max Coupon -> Bill Confirmation ---');
let inlineOrderId = null;
{
  activeCouponByUser = {};
  tgCalls.length = 0;
  fetchCalls.length = 0;

  updateDraft(AMMI_ID, {
    cart: 'https://swig.gy/gc/1467977/Ammi-642855918',
    restaurantId: '1467977',
    groupCartId: '642855918',
    restaurantName: 'Royal Darbar Biryani',
    items: [{ itemId: '551100', menu_item_id: 551100, name: 'Chicken Dum Biryani', qty: 2, price: 120, lineTotal: 240 }],
    cartDetails: {
      restaurantName: 'Royal Darbar Biryani',
      items: [{ itemId: '551100', menu_item_id: 551100, name: 'Chicken Dum Biryani', qty: 2, price: 120, lineTotal: 240 }],
      itemsTotal: 240,
      subtotal: 240
    },
    address: 'Flat 202, Hazratganj, Lucknow, Uttar Pradesh 226001',
    addressDetails: {
      name: 'Ammi',
      mobile: '9876543210',
      flat_no: 'Flat 202',
      area: 'Hazratganj',
      landmark: 'Near Metro',
      city: 'Lucknow',
      address: 'Flat 202, Hazratganj, Lucknow, Uttar Pradesh 226001',
      lat: '26.8500000',
      lng: '80.9499970'
    }
  });

  await bot.handleUpdate({
    update_id: 9001,
    callback_query: {
      id: 'cbq_send_1',
      from: { id: AMMI_ID, is_bot: false, first_name: 'Ammi' },
      message: {
        message_id: 77,
        date: Math.floor(Date.now() / 1000),
        chat: { id: AMMI_ID, type: 'private' },
        text: 'Draft screen'
      },
      chat_instance: 'ci_1',
      data: 'action_send_to_boss'
    }
  });

  const settled = await waitUntil(() => {
    const orders = Object.values(getDb().orders || {});
    return orders.length === 1 && orders[0].status === 'APPROVAL_PENDING' && Boolean(orders[0].selectedAccount);
  }, 5000);

  const savedOrder = Object.values(getDb().orders || {})[0];
  inlineOrderId = savedOrder?.id;

  check('background Auto Max Coupon settles into APPROVAL_PENDING', settled && savedOrder?.status === 'APPROVAL_PENDING');
  check('winning 0-order Android `jwtTid`+`token` account persisted on disk (`selectedAccount`)',
    savedOrder?.selectedAccount === 'acc_9111100001' && savedOrder?.orderAccount === '9111100001');
  check('winning max coupon WELCOME120 (−₹120) & live ₹138 payable persisted (not wiped by getDb!)',
    savedOrder?.couponCode === 'WELCOME120' && Number(savedOrder?.discountAmount) === 120 && Number(savedOrder?.finalPayable) === 138);
  check('billSummarySentAt & SINGLE_CARD delivery recorded cleanly',
    Boolean(savedOrder?.billSummarySentAt) && savedOrder?.billSummaryDelivery === 'SINGLE_CARD');
  check('isCustomerSubmitted marker recorded on customer order', savedOrder?.isCustomerSubmitted === true);

  const ammiEdits = tgCalls.filter((c) => c.method === 'editMessageText' && String(c.payload.chat_id) === String(AMMI_ID));
  const finalAmmiCard = ammiEdits[ammiEdits.length - 1];
  check('customer single card (#77) updated in-place with Approve Bill button',
    finalAmmiCard?.payload?.message_id === 77 &&
    new RegExp(`user_approve_bill_${inlineOrderId}`).test(JSON.stringify(finalAmmiCard?.payload?.reply_markup || {})));
  check('customer card displays verified ₹138 bill & WELCOME120 without leaking account phone',
    /To Pay: ₹138/.test(finalAmmiCard?.payload?.text || '') &&
    /WELCOME120/.test(finalAmmiCard?.payload?.text || '') &&
    !/9111100001/.test(finalAmmiCard?.payload?.text || ''));
  check('no extra standalone chat bubble spammed to customer when single card exists',
    tgCalls.filter((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(AMMI_ID)).length === 0);
  check('no pre-scan `maps.swiggy.com/addresses/nearby` multi-account storm fired',
    !fetchCalls.some((f) => f.url.includes('maps.swiggy.com/addresses/nearby')));
}

// ----------------------------------------------------------------------------
// Scenario 2: Customer taps `[ ✓ Approve bill ]` -> Receives scannable QR photo
//             BOTH on normal customer bill AND when generic `/checkout` URL is set!
// ----------------------------------------------------------------------------
console.log('\n--- Scenario 2: Customer Approves Bill -> Scannable Personalised Payment QR Sent ---');
{
  // Set generic placeholder `https://www.swiggy.com/checkout` (as set by `captureScreenshot: true` / Boss scan)
  // to verify it NEVER suppresses the scannable Personalised Payment QR!
  mutateDb((d) => {
    d.orders[inlineOrderId].swiggyPaymentUrl = 'https://www.swiggy.com/checkout';
  });
  const beforeCalls = tgCalls.length;
  const orderBeforeApprove = getDb().orders[inlineOrderId];
  check('order carries generic https://www.swiggy.com/checkout before approval',
    orderBeforeApprove?.swiggyPaymentUrl === 'https://www.swiggy.com/checkout');

  const approval = await approveUserOrderBillAction(String(AMMI_ID), inlineOrderId);
  const afterApprove = getDb().orders[inlineOrderId];
  const recentPhotos = tgCalls.slice(beforeCalls).filter((c) => c.method === 'sendPhoto' && String(c.payload.chat_id) === String(AMMI_ID));

  check('approveUserOrderBillAction transitions order to PAYMENT_PENDING',
    afterApprove?.billApprovedByUser === true && afterApprove?.status === 'PAYMENT_PENDING');
  check('customer receives a scannable PNG Payment QR photo (not blocked by generic /checkout URL!)',
    recentPhotos.length === 1 && Buffer.isBuffer(recentPhotos[0]?.payload?.photo?.source) && recentPhotos[0].payload.photo.source.length > 1000);
  check('QR caption shows exact ₹138 amount & Check payment status + Resend QR buttons',
    /₹138/.test(recentPhotos[0]?.payload?.caption || '') &&
    new RegExp(`user_paid_status_${inlineOrderId}`).test(JSON.stringify(recentPhotos[0]?.payload?.reply_markup || {})) &&
    new RegExp(`user_resend_approved_qr_${inlineOrderId}`).test(JSON.stringify(recentPhotos[0]?.payload?.reply_markup || {})));
  check('approval ok flag reflects delivered QR', approval?.ok === true || afterApprove?.paymentSentToUser === true);
}

// ----------------------------------------------------------------------------
// Scenario 3: Reply-Keyboard `🚀 Send to Beta` (no callbackQuery) -> Syncs
//             `userChatCards` + `userMessageId` & delivers `[ ✓ Approve bill ]`!
// ----------------------------------------------------------------------------
console.log('\n--- Scenario 3: Reply Keyboard "🚀 Send to Beta" -> Single Card Synced & Bill Confirmation Delivered ---');
{
  // Mark previous order CANCELLED so `getBusySwiggyAccountsMap` immediately releases the 0-order account reservation!
  mutateDb((d) => {
    if (d.orders[inlineOrderId]) d.orders[inlineOrderId].status = 'CANCELLED';
  });
  invalidateAccountOrderProfileCache();
  activeCouponByUser = {};
  tgCalls.length = 0;

  updateDraft(AMMI_ID, {
    cart: 'https://swig.gy/gc/1467977/Ammi-642855918',
    restaurantId: '1467977',
    groupCartId: '642855918',
    restaurantName: 'Royal Darbar Biryani',
    items: [{ itemId: '551100', menu_item_id: 551100, name: 'Chicken Dum Biryani', qty: 2, price: 120, lineTotal: 240 }],
    cartDetails: {
      restaurantName: 'Royal Darbar Biryani',
      items: [{ itemId: '551100', menu_item_id: 551100, name: 'Chicken Dum Biryani', qty: 2, price: 120, lineTotal: 240 }],
      itemsTotal: 240,
      subtotal: 240
    },
    address: 'Flat 202, Hazratganj, Lucknow, Uttar Pradesh 226001',
    addressDetails: {
      name: 'Ammi',
      mobile: '9876543210',
      flat_no: 'Flat 202',
      area: 'Hazratganj',
      landmark: 'Near Metro',
      city: 'Lucknow',
      address: 'Flat 202, Hazratganj, Lucknow, Uttar Pradesh 226001',
      lat: '26.8500000',
      lng: '80.9499970'
    }
  });

  await bot.handleUpdate({
    update_id: 9002,
    message: {
      message_id: 210,
      date: Math.floor(Date.now() / 1000),
      chat: { id: AMMI_ID, type: 'private' },
      from: { id: AMMI_ID, is_bot: false, first_name: 'Ammi' },
      text: '🚀 Send to Beta'
    }
  });

  const settled = await waitUntil(() => {
    const activeOrders = Object.values(getDb().orders || {}).filter((o) => o.status !== 'CANCELLED');
    return activeOrders.length === 1 && activeOrders[0].status === 'APPROVAL_PENDING';
  }, 5000);

  const rkOrder = Object.values(getDb().orders || {}).find((o) => o.status !== 'CANCELLED');
  const sentOrderCard = tgCalls.find((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(AMMI_ID));
  const editsToOrderCard = tgCalls.filter(
    (c) => c.method === 'editMessageText' &&
      String(c.payload.chat_id) === String(AMMI_ID) &&
      c.payload.message_id === sentOrderCard?.payload?.message_id || c.payload?.message_id === rkOrder?.userMessageId
  );
  const lastEdit = editsToOrderCard[editsToOrderCard.length - 1];

  check('reply-keyboard Send to Beta reaches APPROVAL_PENDING with winning account',
    settled && rkOrder?.selectedAccount === 'acc_9111100001');
  check('reply-keyboard card updated in-place on the newly created `userMessageId` (not stale card 77!)',
    Boolean(rkOrder?.userMessageId) &&
    rkOrder.userMessageId !== 77 &&
    lastEdit?.payload?.message_id === rkOrder.userMessageId &&
    new RegExp(`user_approve_bill_${rkOrder.id}`).test(JSON.stringify(lastEdit?.payload?.reply_markup || {})));
}

// ----------------------------------------------------------------------------
// Scenario 4: Boss ID testing customer "Send to Beta" vs Forwarded/Direct Boss
// ----------------------------------------------------------------------------
console.log('\n--- Scenario 4: Audience Routing (Boss testing Send to Beta vs Forwarded Order) ---');
{
  const bossCustomerTestOrder = {
    id: 'V34_BOSS_AS_CUST',
    userId: BOSS_ID,
    userChatId: BOSS_ID,
    isCustomerSubmitted: true,
    status: 'PENDING',
    cardStage: 'BILL_READY',
    selectedAccount: 'acc_9111100001',
    finalPayable: 138
  };
  const bossForwardedOrder = {
    id: 'V34_BOSS_FWD',
    userId: BOSS_ID,
    fwdSenderUserId: AMMI_ID,
    isForwardedOrder: true,
    status: 'PENDING',
    cardStage: 'BILL_READY',
    selectedAccount: 'acc_9111100001',
    finalPayable: 138
  };

  check('Boss testing customer Send to Beta (`isCustomerSubmitted: true`) gets Bill Confirmation',
    resolveBillSummaryAudience(bossCustomerTestOrder, getDb()) === 'CUSTOMER_AND_BOSS' &&
    shouldSendSummaryToCustomer(bossCustomerTestOrder, getDb()) === true);
  check('Forwarded order stays strictly BOSS_ONLY',
    resolveBillSummaryAudience(bossForwardedOrder, getDb()) === 'BOSS_ONLY' &&
    shouldSendSummaryToCustomer(bossForwardedOrder, getDb()) === false);
}

// ----------------------------------------------------------------------------
// Scenario 5: Verified ₹0 Payable Bill (100% Free Cash / Coupon covered)
// ----------------------------------------------------------------------------
console.log('\n--- Scenario 5: Verified ₹0 Payable Bill Covered by Free Cash / Coupon ---');
{
  const zeroOrder = {
    id: 'V34_ZERO_BILL',
    userId: AMMI_ID,
    userChatId: AMMI_ID,
    userName: 'Ammi',
    isCustomerSubmitted: true,
    status: 'PENDING',
    cardStage: 'BILL_READY',
    selectedAccount: 'acc_9111100001',
    orderAccount: '9111100001',
    restaurantName: 'Royal Darbar Biryani',
    items: [{ name: 'Mini Gulab Jamun', qty: 1, price: 99, lineTotal: 99 }],
    subtotal: 99,
    itemTotal: 99,
    discountAmount: 50,
    freeCashApplied: 49,
    finalPayable: 0,
    swiggyVerified: true
  };
  applyMaxOfferToOrder(zeroOrder);
  check('applyMaxOfferToOrder preserves authoritative ₹0 verified Swiggy total', zeroOrder.finalPayable === 0);

  const db = getDb();
  db.orders.V34_ZERO_BILL = zeroOrder;
  saveDb(db);

  tgCalls.length = 0;
  const zeroSend = await sendBillSummaryToCustomerOnce(bot.telegram, getDb().orders.V34_ZERO_BILL, { db: getDb() });
  check('verified ₹0 bill summary is delivered to customer instead of failing with bill-not-ready',
    zeroSend?.sent === true && getDb().orders.V34_ZERO_BILL.status === 'APPROVAL_PENDING');
}

restoreDb();

console.log('\n' + '='.repeat(68));
const passed = results.filter((r) => r.ok).length;
console.log(`📊 V34 RESULT: ${passed}/${results.length} checks passed`);
console.log('='.repeat(68));
if (passed !== results.length) process.exit(1);
process.exit(0);
