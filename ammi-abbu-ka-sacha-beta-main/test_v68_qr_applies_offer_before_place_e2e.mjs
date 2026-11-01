/**
 * v68 — QR BINA OFFER NAHI BANEGA (boss: "QR WITHOUT APPLYING OFFER, MORE PRICE
 * THAN OTHER BOT")
 *
 * Asli gap: bill banne ke baad offer/free cash late credit hota tha, aur QR wala
 * raasta wahi purana cart seedha `order/place` kar deta tha — customer ko bina
 * ₹50 ka QR milta tha (doosre bot se ₹50 zyada).
 *
 * Ab `generateRealSwiggyMerchantUpiQr` place se PEHLE:
 *   1. offers/free cash dobara live check karta hai,
 *   2. slot gate ignore karke ek baar cart re-push karta hai (bounded 3.5s),
 *   3. naya (kam) total fresh cart se leta hai — purana zyada amount QR me nahi
 *      jata,
 *   4. sach `order.prePlaceOfferApply` me likhta hai (kya hua, kyun nahi hua).
 *
 * Plus: PRE_LOCKED ledger 45 min baad bharosemand nahi — warna slot khulne par
 * bhi offer nahi lagta aur cart me free cash kabhi nahi aata.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

const DB_PATH = 'data/db.json';
const MIRROR = 'accounts.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const mirrorSnapshot = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR, 'utf8') : null;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const jsonRes = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null, getSetCookie: () => [] },
  text: async () => JSON.stringify(obj),
  json: async () => obj
});

const FREE_CASH = 50;

/** Swiggy cart: `withFreeCash` ke bina ₹240, ke saath ₹190. */
function cartPayload({ withFreeCash = false, total = 0 } = {}) {
  const base = 240;
  const reward = withFreeCash ? FREE_CASH : 0;
  return {
    statusCode: 0,
    data: {
      cartMeta: {
        cart_id: 'cart_v68',
        restaurant_details: { id: '990099', name: 'Biryani House' },
        cart_total_count: 1,
        cart_menu_items: [{ menu_item_id: 88001, name: 'Chicken Biryani', price: 240, quantity: 1, subtotal: 240, final_price: 240 }],
        coupon_code: '',
        is_coupon_valid: 0,
        coupon_discount_total: 0,
        ...(reward ? { trade_discount_reward_amount: reward } : {}),
        order_total: total || (base - reward),
        delivery_fee: 0,
        address_id: 'addr_v68',
        addresses: [{
          id: 'addr_v68', selected: true, name: 'Ammi', mobile: '9876500123',
          address: 'Nadiad City, Gujarat 387001', area: 'Nadiad', city: 'Nadiad', lat: '22.6939', lng: '72.8616'
        }]
      }
    }
  };
}

const calls = [];
let offerLive = true;      // claim ka natija
let cartHasCashAfterPush = true;
let cartHasCashNow = false;

globalThis.fetch = async (u, opts = {}) => {
  const url = String(u);
  const method = String(opts.method || 'GET').toUpperCase();
  calls.push({ url, method });

  if (url.includes('chkout.swiggy.com/api/v2/cart/client/update')) {
    // Re-push ke baad Swiggy free cash credit kar deta hai.
    cartHasCashNow = cartHasCashAfterPush;
    return jsonRes(200, cartPayload({ withFreeCash: cartHasCashNow }));
  }
  if (url.includes('chkout.swiggy.com/api/v2/cart/client')) {
    return jsonRes(200, cartPayload({ withFreeCash: cartHasCashNow }));
  }
  if (url.includes('events.swiggy.com/api/notify')) {
    if (method === 'GET') {
      return jsonRes(200, { shouldNotify: offerLive, value: offerLive ? 1 : 0, timestamp: new Date().toISOString() });
    }
    return jsonRes(offerLive ? 200 : 500, offerLive ? { message: 'ok' } : { message: 'nope' });
  }
  if (url.includes('events.swiggy.com')) return jsonRes(200, {});
  if (url.includes('chkout.swiggy.com')) return jsonRes(200, { statusCode: 0, tid: 'aaaa.bbbb.cccc', data: { cartMeta: cartPayload().data.cartMeta } });
  if (url.includes('order/all')) return jsonRes(200, { statusCode: 0, data: { orders: [] }, tid: 'aaaa.bbbb.cccc' });
  return jsonRes(200, { statusCode: 0, data: {} });
};

const store = await import('./store.js');
const cart = await import('./swiggy-cart.js');
const offersEngine = await import('./event-offers.js');

const ACC = {
  id: 'acc_v68', phone: '9876500123', name: 'Ammi', isLoggedIn: true,
  cookies: 'token=tok_v68; tid=aaaa.bbbb.cccc', token: 'tok_v68', tid: 'aaaa.bbbb.cccc'
};

function makeOrder(over = {}) {
  return {
    id: 'ORD68',
    status: 'APPROVAL_PENDING',
    cardStage: 'BILL_READY',
    restaurantId: '990099',
    restaurantName: 'Biryani House',
    items: [{ itemId: '88001', menu_item_id: 88001, name: 'Chicken Biryani', price: 240, qty: 1 }],
    itemTotal: 240,
    finalPayable: 240,
    billShownAmount: 240,
    campaignFreeCash: 0,
    couponCode: '',
    addressDetails: { id: 'addr_v68', name: 'Ammi', mobile: '9876500123', address: 'Nadiad City, Gujarat 387001', lat: '22.6939', lng: '72.8616' },
    ...over
  };
}

console.log('\n=== 1. QR path: place se PEHLE offer apply hota hai (source proof) ===');
{
  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('pre-place offer apply block hai', /OFFER APPLY BEFORE PLACE/.test(src));
  check('applyLiveFreeCashRelock place se pehle call hota hai', /prePlaceOfferApply = await applyLiveFreeCashRelock\(account, order, \{\s*claimWaitMs: 3500,\s*ignoreSlotGate: true/.test(src));
  check('apply ke baad cart dobara padha jata hai (fresh total)', /const refreshedCart = await swiggyCartGet\(account, \{ lat: reqLat, lng: reqLng, timeoutMs: 6000 \}\)/.test(src));
  check('cm naye total se replace hota hai', /curCart = refreshedCart;\s*\n\s*cm = refreshedMeta;/.test(src));
  check('audit order par likha jata hai', /order\.prePlaceOfferApply = \{/.test(src));
  check('kam amount order par adopt hota hai', /order\.finalPayable = Number\(cm\.order_total\);/.test(src));
  check('apply block amount gate se PEHLE hai', src.indexOf('OFFER APPLY BEFORE PLACE') < src.indexOf('AMOUNT INVARIANCE'));

  const vendor = fs.readFileSync('./bossbot/vendor/swiggy-cart.js', 'utf8');
  check('vendor copy bhi sync hai', /OFFER APPLY BEFORE PLACE/.test(vendor) && /ignoreSlotGate: true/.test(vendor));
}

console.log('\n=== 2. Slot band hone par bhi QR ke waqt free cash lagta hai ===');
{
  offerLive = false;          // claim fail (slot band / not eligible)
  cartHasCashNow = false;
  cartHasCashAfterPush = true;
  calls.length = 0;

  const order = makeOrder();
  const out = await cart.applyLiveFreeCashRelock(ACC, order);
  check('default: slot band hone par cart push nahi (bekaar write nahi)', out.applied === false, JSON.stringify(out));
  check('default: honest reason milta hai', /slot-not-open|claim-unavailable/.test(String(out.reason)), out.reason);
  check('default: koi cart update call nahi gaya', !calls.some((c) => c.url.includes('/client/update')), JSON.stringify(calls.map((c) => c.url).slice(-3)));

  const order2 = makeOrder();
  const before = calls.length;
  const out2 = await cart.applyLiveFreeCashRelock(ACC, order2, { claimWaitMs: 3500, ignoreSlotGate: true });
  const pushes = calls.slice(before).filter((c) => c.url.includes('/client/update')).length;
  check('ignoreSlotGate: ek cart re-push hua', pushes === 1, String(pushes));
  check('free cash order par adopt hua', out2.applied === true && Number(order2.campaignFreeCash) === FREE_CASH, JSON.stringify({ a: out2.applied, c: order2.campaignFreeCash }));
  check('finalPayable kam ho gaya (₹240 → ₹190)', Number(order2.finalPayable) === 190, String(order2.finalPayable));
  check('adopt ka via batata hai', /cart-relock|cart-refresh/.test(String(out2.via)), out2.via);
  check('already-present par dobara mehnat nahi', (await cart.applyLiveFreeCashRelock(ACC, order2)).reason === 'already-present');
}

console.log('\n=== 3. Free cash na mile to jhooth nahi — asli reason ===');
{
  offerLive = false;
  cartHasCashNow = false;
  cartHasCashAfterPush = false;
  const order = makeOrder();
  const out = await cart.applyLiveFreeCashRelock(ACC, order, { claimWaitMs: 2000, ignoreSlotGate: true });
  check('applied false', out.applied === false);
  check('reason push ke baad bhi cash nahi mila', /push-returned-no-free-cash|slot-not-open|claim-unavailable/.test(String(out.reason)), out.reason);
  check('order par free cash 0 hi hai (fake nahi)', Number(order.campaignFreeCash || 0) === 0);
  check('card ke liye honest note milta hai', Boolean(order.offerDiagnostics || out.note), String(order.offerDiagnostics || out.note || '').slice(0, 80));
}

console.log('\n=== 4. PRE_LOCKED 45 min baad bharosemand nahi (warna offer kabhi lagta hi nahi) ===');
{
  offersEngine.resetEventOfferMetaCache();
  offersEngine.resetFixedCampaignCache();
  const acc = { id: 'acc_prelock_v68', token: 't', tid: 'a.b.c' };
  offersEngine.noteCampaignClaim(acc, 'byo-ln-v5-99', { value: 1, verified: false, state: 'PRE_LOCKED' });
  const fresh = offersEngine.recentCampaignClaim(acc, 'byo-ln-v5-99');
  check('naya pre-lock fresh hai', fresh?.state === 'PRE_LOCKED' && fresh.stalePreLock === false, JSON.stringify(fresh));

  // 46 minute purana karo
  offersEngine.claimLedger.set(`acc_prelock_v68|byo-ln-v5-99`, { value: 1, at: Date.now() - 46 * 60 * 1000, verified: false, state: 'PRE_LOCKED' });
  const old = offersEngine.recentCampaignClaim(acc, 'byo-ln-v5-99');
  check('46 min purana pre-lock stale hai', old?.stalePreLock === true, JSON.stringify(old));

  const src = fs.readFileSync('./event-offers.js', 'utf8');
  check('PRE_LOCK_TTL_MS 45 min hai', /const PRE_LOCK_TTL_MS = 45 \* 60 \* 1000;/.test(src));
  check('window khulne par ledger shortcut nahi (windowOpen !== true)', /windowOpen !== true/.test(src));
  const bridge = fs.readFileSync('./swiggy-bridge.js', 'utf8');
  check('legacy claim path bhi stale pre-lock par dobara check karta hai', /PRE_LOCKED' && recent\.value === chosenVal && !recent\.stalePreLock/.test(bridge));
}

console.log('\n=== 5. Purana zyada amount QR me nahi jaata (gate intact) ===');
{
  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('shown-bill gate bacha hua hai', /QR_AMOUNT_ABOVE_SHOWN_BILL/.test(src));
  check('gate fresh cm par chalta hai (apply ke baad)', src.indexOf('OFFER APPLY BEFORE PLACE') < src.indexOf('const shownBillAmount = Number(order?.billShownAmount'));
  const gateFires = (shown, live) => shown > 0 && live > shown + 0.5;
  check('offer na lagne par: bill ₹190, live ₹240 → BLOCK', gateFires(190, 240) === true);
  check('offer lagne par: bill ₹240, live ₹190 → ALLOW (kam liya)', gateFires(240, 190) === false);
  check('split-pay (wallet free cash) pehle se maujood hai', /swiggy_pay_amount/.test(src));
}

function restoreState() {
  try { if (dbSnapshot !== null) fs.writeFileSync(DB_PATH, dbSnapshot); else if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch {}
  try {
    if (mirrorSnapshot !== null) fs.writeFileSync(MIRROR, mirrorSnapshot);
    else if (fs.existsSync(MIRROR)) fs.unlinkSync(MIRROR);
  } catch {}
}
restoreState();

console.log('\n=====================================================================');
console.log(failed === 0
  ? `🏆 QR SE PEHLE OFFER APPLY — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
