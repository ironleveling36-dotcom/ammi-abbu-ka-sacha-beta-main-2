// test_v83_ofo_proof_and_early_mode.mjs
// Boss (30-10-2026): "dekhi jab order karne se pehle order for friend choose
// karoge tab wo order as a order for friend count hoga kya? iske liye ham app ko
// integrate kar sakte mere ammi abbu ke liye?"
//
// Jawab code me lock hota hai:
//   1) OFO CART BUILD TIME par hi lagta hai (bill dikhne se pehle) — bilkul app
//      ke "Order for someone else" toggle jaisa.
//   2) OFO ka SABOOT proof ladder se: CART_READBACK > PUSH_ECHO > NONE.
//      Sirf payload bhejna kaafi nahi — live cart me marker wapas dikhna chahiye.
//   3) Push accept hua par cart ne echo nahi kiya → order place hota hai PAR
//      boss ko proof ke saath sach jata hai (jhootha "OFO ho gaya" nahi).
//   4) Bill badha to revert (customer dikhaye bill se zyada nahi deta) — OFO ka
//      lalach nahi.
//   5) Account par OFO capability yaad rehti hai (agli baar pehle se pata).
//   6) Boss alert proof level Hinglish me batata hai.

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-OFO-PROOF';
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

const ACCOUNT = { phone: '9876500001', tid: 'a.b.c', token: 'tok', cookies: '_session_tid=abc;' };
const makeOrder = (over = {}) => ({
  id: 830001,
  restaurantId: '777002',
  restaurantName: 'Test Kitchen',
  finalPayable: 410,
  couponCode: 'SAVE50',
  items: [{ menu_item_id: 21, qty: 1, variants: [], addons: [] }],
  addressDetails: { mobile: '9000011122', name: 'Abbu', lat: '26.84', lng: '80.94', addressId: 'addr-9' },
  ...over
});

// ── 1) buildOfoCartFields: app ke "order for friend" toggle ka server twin ──
{
  const f = cart.buildOfoCartFields(makeOrder());
  check('OFO flag set hota hai', f.is_order_for_someone_else === true);
  check('recipient phone cart me jata hai', f.alternate_mobile === '9000011122');
  check('recipient details me naam+phone', f.recipient_details?.name === 'Abbu' && f.recipient_details?.phone === '9000011122');
  check('delivery instructions me recipient ka number', String(f.delivery_instructions?.[0]?.phone) === '9000011122');
  check('order comments me "do not call the ordering number"', /do not call the ordering number/i.test(f.order_comments));
  const none = cart.buildOfoCartFields({ addressDetails: {} });
  check('recipient phone na ho to OFO fields khaali (jhooth nahi)', Object.keys(none).length === 0);
}

// ── Fake Swiggy engine with configurable echo ──────────────────────────────
const realFetch = globalThis.fetch;
let echo = true;         // cart GET me OFO markers wapas aayenge?
let readbackTotal = 0;   // 0 = same bill
let pushed = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/cart/client')) {
    const isWrite = Boolean(opts.body);
    if (isWrite) pushed.push(JSON.parse(opts.body));
    // write response me bill same rehta hai; badla hua bill sirf read-back me
    const totalNow = isWrite ? 410 : (readbackTotal || 410);
    const baseMeta = { order_total: 410, cart_menu_items: [{ menu_item_id: 21, quantity: 1 }], cart_total_count: 1 };
    const meta = echo
      ? { ...baseMeta, order_total: totalNow, alternate_mobile: '9000011122', order_comments: 'Order for Abbu', is_order_for_someone_else: true }
      : { ...baseMeta, order_total: totalNow };
    const json = { statusCode: 0, statusMessage: 'Done Successfully', data: { cartMeta: meta } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) };
  }
  return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
};

// ── 2) cart read-back se pakka saboot ──────────────────────────────────────
{
  echo = true; readbackTotal = 0; pushed = [];
  const acc = { ...ACCOUNT, phone: '9876500001' };
  const r = await cart.ensureOfoCartMode(acc, makeOrder(), { addressId: 'addr-9', lat: '26.84', lng: '80.94' });
  check('cart ne OFO echo kiya → ofo:true', r.ofo === true, JSON.stringify(r));
  check('proof = CART_READBACK (sabse strong)', r.proof === 'CART_READBACK', r.proof);
  check('confirmed:true', r.confirmed === true);
  check('markers me recipient_phone', (r.markers || []).includes('recipient_phone'), JSON.stringify(r.markers));
  check('account par OFO capability yaad rehti hai', acc.ofoCapability?.proof === 'CART_READBACK', JSON.stringify(acc.ofoCapability));
}

// ── 3) push accept par cart echo nahi → jhootha confirm nahi ──────────────
{
  echo = false; readbackTotal = 0; pushed = [];
  const acc = { ...ACCOUNT, phone: '9876500002' };
  const r = await cart.ensureOfoCartMode(acc, makeOrder(), { addressId: 'addr-9', lat: '26.84', lng: '80.94' });
  check('echo nahi → ofo:false (jhooth nahi)', r.ofo === false, JSON.stringify(r));
  check('echo nahi → ok:true (push chala tha)', r.ok === true);
  check('echo nahi → reason batata hai ki marker wapas nahi aaya', /marker/i.test(r.reason), r.reason);
  check('echo nahi → capability NONE record hota hai', acc.ofoCapability?.proof === 'NONE', JSON.stringify(acc.ofoCapability));
}

// ── 4) read-back me bill badha → revert (customer ka nuksaan nahi) ────────
{
  echo = true; readbackTotal = 610; pushed = [];
  const r = await cart.ensureOfoCartMode({ ...ACCOUNT, phone: '9876500003' }, makeOrder(), { addressId: 'addr-9', lat: '26.84', lng: '80.94' });
  check('read-back bill badha → ofo:false', r.ofo === false, JSON.stringify(r));
  check('read-back bill badha → proof REVERTED', r.proof === 'REVERTED', r.proof);
  check('read-back bill badha → plain cart wapas push hui', pushed.length >= 2 && pushed[pushed.length - 1]?.is_order_for_someone_else === undefined, JSON.stringify(pushed.map(p => p.is_order_for_someone_else)));
  readbackTotal = 0;
}

// ── 5) OFO cart build time par bhi lagta hai (bill se pehle) ──────────────
{
  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  const fnIdx = src.indexOf('export async function applyLiveCouponToOrder');
  const seg = src.slice(fnIdx, fnIdx + 4000);
  check('coupon/cart build par OFO fields lagti hain (bill se pehle)', /\.\.\.buildOfoCartFields\(order\)/.test(seg));
  check('ensureOfoCartMode bhi wahi helper use karta hai (ek hi sach)', (src.match(/buildOfoCartFields\(order\)/g) || []).length >= 2);
}

// ── 6) Boss alert proof level batata hai ──────────────────────────────────
{
  const iSrc = fs.readFileSync('./index.js', 'utf8');
  check('boss alert CART_READBACK ka matlab batata hai', /CART_READBACK: 'live cart ne OFO wapas dikhaya \(pakka\)'/.test(iSrc));
  check('boss alert proof level dikhata hai', /OFO confirm nahi hua \(\$\{proofHinglish\}\)/.test(iSrc));
}

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} v83 OFO proof + early mode: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
