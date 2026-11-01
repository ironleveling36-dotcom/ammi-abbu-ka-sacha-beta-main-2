// test_v82_ofo_placement.mjs
// Boss (30-10-2026): "bhai ab samajh aaya link kiu nahi aaraha kiuki order to
// ofo place nahi horaha".
//
// Sach: Swiggy ka `ofo/track` link SIRF tab banta hai jab order asli OFO order
// ho. Pehle bot sirf place payload me OFO flags bhejta tha, live cart normal
// cart hi rehta tha — isliye link kabhi publish nahi hota tha.
//
// Yeh guard lock karta hai:
//   1) `ensureOfoCartMode` recipient phone ke bina OFO ka jhootha dawa nahi
//      karta — saaf reason deta hai.
//   2) Cart push confirm hua + bill same → `ofo:true` (sach me OFO laga).
//   3) Cart push ne bill badha diya → wapas plain cart + `ofo:false` (customer
//      kabhi dikhaye bill se zyada nahi deta).
//   4) `detectOfoFromPlaceResponse` place response se hi OFO ka saboot nikalta
//      hai (jhooth nahi: flag na ho to false).
//   5) Place ke baad order par `ofoCart` + `ofoPlaced` likha jata hai.
//   6) Different recipient ke liye OFO confirm na bane to place band hai;
//      `OFO_STRICT=1` self-orders ke liye bhi confirmation maangta hai.
//   7) Tracking extractor OFO na bane par `OFO_ORDER_NAHI_BANA` bolta hai.
//   8) Customer card OFO na bane par admin button deta hai (koi jhootha
//      "Track on Swiggy" nahi).

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

const ACCOUNT = {
  phone: '9876543210',
  tid: 'header.payload.sig',
  token: 'tok-abc',
  cookies: '_session_tid=abc123;'
};

const makeOrder = (over = {}) => ({
  id: 820001,
  restaurantId: '777001',
  restaurantName: 'Test Dhaba',
  finalPayable: 523,
  couponCode: 'OFF50',
  items: [{ menu_item_id: 11, qty: 2, variants: [], addons: [] }],
  addressDetails: { mobile: '9123456780', name: 'Ammi', lat: '26.8467', lng: '80.9462', addressId: 'addr-1' },
  ...over
});

// ── Fake Swiggy cart engine ────────────────────────────────────────────────
let cartTotal = 523;
let cartFail = null;
let lastCartBody = null;
let echoOfo = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/cart/client')) {
    if (opts.body) {
      lastCartBody = JSON.parse(opts.body);
      echoOfo = Boolean(lastCartBody.is_order_for_someone_else);
    }
    const json = cartFail
      ? { statusCode: Number(cartFail.code || 1), statusMessage: String(cartFail.message || 'cart failed') }
      : {
        statusCode: 0,
        statusMessage: 'Done Successfully',
        data: {
          cartMeta: {
            order_total: cartTotal,
            cart_menu_items: [{ menu_item_id: 11, quantity: 2 }],
            cart_total_count: 2,
            // Swiggy OFO accept kare to cart me markers wapas aate hain (asli proof)
            ...(echoOfo ? { is_order_for_someone_else: true, alternate_mobile: '9123456780' } : {})
          }
        }
      };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
  }
  return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
};

// ── 1) Recipient phone ke bina OFO ka dawa nahi ────────────────────────────
{
  const no = await cart.ensureOfoCartMode(ACCOUNT, makeOrder({ addressDetails: { name: 'Ammi', lat: '26.8467', lng: '80.9462', addressId: 'addr-1' } }), { addressId: 'addr-1', lat: '26.8467', lng: '80.9462' });
  check('recipient phone missing → ofo:false (jhooth nahi)', no.ok === false && no.ofo === false);
  check('recipient phone missing → reason phone ka naam leta hai', /phone/i.test(no.reason), no.reason);
}

// ── 2) Address id ke bina OFO push nahi ────────────────────────────────────
{
  const noAddr = await cart.ensureOfoCartMode(ACCOUNT, makeOrder(), { addressId: '', lat: '26.8467', lng: '80.9462' });
  check('address_id missing → ofo:false + reason', noAddr.ofo === false && /address_id/i.test(noAddr.reason), noAddr.reason);
}

// ── 3) Cart OFO mode me chala + bill same → ofo:true ───────────────────────
{
  cartTotal = 523; cartFail = null; lastCartBody = null;
  const ok = await cart.ensureOfoCartMode(ACCOUNT, makeOrder(), { addressId: 'addr-1', lat: '26.8467', lng: '80.9462' });
  check('cart confirm hua → ofo:true', ok.ok === true && ok.ofo === true, JSON.stringify(ok));
  check('OFO push me recipient phone gayi', String(lastCartBody?.alternate_mobile || '') === '9123456780', String(lastCartBody?.alternate_mobile));
  check('OFO push me OFO flag gayi', lastCartBody?.is_order_for_someone_else === true);
  check('OFO push me recipient_details gayi', String(lastCartBody?.recipient_details?.phone || '') === '9123456780');
}

// ── 4) Cart ne bill badha diya → revert (customer dikhaye bill se zyada na de)
{
  cartTotal = 999; cartFail = null; lastCartBody = null;
  const reverted = await cart.ensureOfoCartMode(ACCOUNT, makeOrder(), { addressId: 'addr-1', lat: '26.8467', lng: '80.9462' });
  check('bill badha → ofo:false', reverted.ofo === false, JSON.stringify(reverted));
  check('bill badha → reason bill ka farq batata hai', /bill|₹/i.test(reverted.reason), reverted.reason);
  check('bill badha → plain cart wapas push hui', lastCartBody?.is_order_for_someone_else === undefined, JSON.stringify(lastCartBody?.is_order_for_someone_else));
}

// ── 5) Cart engine ne OFO reject kiya → saaf reason ────────────────────────
{
  cartTotal = 523; cartFail = { code: 3, message: 'Order for someone else is not allowed for this cart' };
  const rejected = await cart.ensureOfoCartMode(ACCOUNT, makeOrder(), { addressId: 'addr-1', lat: '26.8467', lng: '80.9462' });
  check('OFO reject → ofo:false', rejected.ofo === false);
  check('OFO reject → Swiggy ka message reason me', /not allowed/i.test(rejected.reason), rejected.reason);
  cartFail = null;
}

// ── 6) Place response se OFO saboot ────────────────────────────────────────
{
  const yes = cart.detectOfoFromPlaceResponse({ statusCode: 0, data: { order_id: '123', ordering_for_someone_else: true, recipient_phone: '9123456780' } });
  check('place response me OFO flag → ofo:true', yes.ofo === true, JSON.stringify(yes));
  const no = cart.detectOfoFromPlaceResponse({ statusCode: 0, data: { order_id: '123', order_total: 523 } });
  check('place response me OFO flag nahi → ofo:false', no.ofo === false, JSON.stringify(no));
  const garbage = cart.detectOfoFromPlaceResponse(null);
  check('null response → ofo:false (crash nahi)', garbage.ofo === false);
}

// ── 7) Place ke baad order par OFO truth likhi jati hai ────────────────────
{
  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  const idxOfo = src.indexOf('ensureOfoCartMode(account, order, { addressId, lat, lng })');
  const idxPlace = src.indexOf('detectOfoFromPlaceResponse(json)');
  const idxNative = src.indexOf('chkout.swiggy.com/api/v2/order/place');
  check('cart OFO push place se pehle hota hai', idxOfo > 0 && idxNative > 0 && idxOfo < idxNative);
  check('place response se OFO saboot padha jata hai', idxPlace > idxNative);
  check('order.ofoCart likha jata hai', /order\.ofoCart = \{/.test(src));
  check('order.ofoPlaced likha jata hai', /order\.ofoPlaced = Boolean\(ofoProof\.ofo\)/.test(src));
  check('different receiver + missing OFO marker → place blocked', /needsOfo && !hasExplicitOfoCartFlag\(finalMeta\)/.test(src) && /code: 'OFO_CART_MODE_FAILED'/.test(src));
  check('OFO_STRICT=1 → order place hi nahi (OFO_CART_MODE_FAILED)', /OFO_STRICT/.test(src) && /code: 'OFO_CART_MODE_FAILED'/.test(src));
}

// ── 8) Tracking extractor OFO na bane par sach bolta hai ───────────────────
{
  const tSrc = fs.readFileSync('./order-tracking.js', 'utf8');
  check('extractTrackingNow OFO na bane par OFO_ORDER_NAHI_BANA bolta hai', /OFO_ORDER_NAHI_BANA/.test(tSrc));
  check('extractTrackingNow ofoPlaced/ofoReason lautata hai', /ofoPlaced: fresh\?\.ofoPlaced/.test(tSrc) && /ofoReason:/.test(tSrc));
}

// ── 9) Boss alert + customer card ──────────────────────────────────────────
{
  const iSrc = fs.readFileSync('./index.js', 'utf8');
  check('boss ko OFO ka sach alert jata hai', /📦 <b>ORDER PLACE<\/b>/.test(iSrc) && /OFO confirm nahi hua/.test(iSrc));
  const sSrc = fs.readFileSync('./simple-chat.js', 'utf8');
  check('customer card OFO fail par admin button deta hai', /order\?\.ofoPlaced === false/.test(sSrc) && /support_contact_admin/.test(sSrc));
  check('customer card OFO fail par jhootha track link nahi deta', /if \(!trackingUrl && order\?\.ofoPlaced === false\)/.test(sSrc));
}

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} v82 offline OFO checks: ${pass} pass, ${fail} fail (not a live Swiggy order)`);
process.exit(fail === 0 ? 0 : 1);
