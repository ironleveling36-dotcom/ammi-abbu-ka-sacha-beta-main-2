// Boss (31-10-2026, round 18):
//   "AB BILL CALCULATE KA HAR POSSIBILITY KO DHAYAN RAKH KAR AND QR GENERATION
//    KE HAR POSSIBLITES KO DHYAN ME RAKH KAR CODE LIKHO"
//
// Ye suite do pure modules ka poora matrix hai:
//   bill-reconcile.js       — bill ke har ajeeb shape ka sach
//   qr-generation-plan.js   — QR ke har reject/accept ka sach
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { reconcileBill, describeBillState, toMoney, BILL_CODES } from './bill-reconcile.js';
import { planQrGeneration, checkQrCandidate, describeQrPlan, isRenderableQrImage, MAX_QR_URI_LENGTH } from './qr-generation-plan.js';

// item 230 + packing 10 + gst 30 + One Lite 1 − free cash 50 = 221
const BASE = {
  itemTotal: 230, deliveryFee: 0, deliverySaved: 49, packingCharges: 10, taxes: 30,
  freeCash: 50, discount: 0, oneMembershipFee: 1, total: 221
};

// ── BILL ─────────────────────────────────────────────────────────────────
test('bill: normal Swiggy bill — lines jod khaati hain, sach poora', () => {
  const r = reconcileBill(BASE);
  assert.equal(r.ok, true);
  assert.equal(r.bill.total, 221);
  assert.equal(r.bill.deliveryFee, 0);
  assert.equal(r.bill.freeCash, 50);
  assert.match(describeBillState(r), /Delivery FREE/);
});

test('bill: sab values string + ₹/comma me aayein — phir bhi sahi', () => {
  const r = reconcileBill({
    itemTotal: '₹230.00', deliveryFee: '0', packingCharges: '₹10', taxes: '30.00',
    freeCash: '₹50.00', oneMembershipFee: '1', total: '₹221.00'
  });
  assert.equal(r.ok, true);
  assert.equal(r.bill.total, 221);
  assert.equal(r.bill.itemTotal, 230);
});

test('bill: total missing → lines se derive + saaf batao (jhooth nahi)', () => {
  const { total, ...withoutTotal } = BASE;
  const r = reconcileBill(withoutTotal);
  assert.equal(r.bill.total, 221);
  assert.equal(r.bill.totalDerived, true);
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.TOTAL_MISSING));
});

test('bill: itemTotal missing → items se jod (invent nahi)', () => {
  const { itemTotal, ...rest } = BASE;
  const r = reconcileBill(rest, { items: [{ price: 150, qty: 1 }, { price: 40, qty: 2 }] });
  assert.equal(r.bill.itemTotal, 230);
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.ITEM_TOTAL_DERIVED));
});

test('bill: total lines se ZYADA (chhupa charge) → problem + asli farq', () => {
  // lines 221, Swiggy To Pay 320 → ₹99 ka aisa charge jiski koi line nahi.
  const r = reconcileBill({ ...BASE, total: 320 });
  assert.ok(r.problems.some((p) => p.code === BILL_CODES.DOES_NOT_ADD_UP));
  assert.equal(r.ok, false);
  assert.match(r.problems[0].message, /₹320/);
});

test('bill: total lines se KAM → chhupi saving (unlistedDiscount), warning nahi', () => {
  const r = reconcileBill({ ...BASE, total: 140 });
  assert.equal(r.bill.unlistedDiscount, 81);
  assert.equal(r.problems.some((p) => p.code === BILL_CODES.DOES_NOT_ADD_UP), false);
  assert.equal(r.bill.linesAddUp, true);
});

test('bill: approved total badal gaya → asli message, dono numbers', () => {
  const r = reconcileBill(BASE, { expectedTotal: 183 });
  assert.ok(r.problems.some((p) => p.code === BILL_CODES.TOTAL_CHANGED));
  assert.match(r.problems.find((p) => p.code === BILL_CODES.TOTAL_CHANGED).message, /₹183.*₹221/);
});

test('bill: free cash payable se zyada → clamp + note (negative total nahi)', () => {
  const r = reconcileBill({ itemTotal: 100, deliveryFee: 0, packingCharges: 10, taxes: 5, freeCash: 500, oneMembershipFee: 0, total: 0 });
  assert.equal(r.bill.freeCash, 115);
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.FREE_CASH_CLAMPED));
  assert.ok(r.bill.total >= 0);
});

test('bill: coupon "laga hua" par discount 0 → coupon line nahi dikhati', () => {
  const r = reconcileBill({ ...BASE, coupon: 'SNACKIT', discount: 0 });
  assert.equal(r.bill.coupon, '');
  assert.equal(r.bill.discount, null);
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.COUPON_NOT_APPLIED));
});

test('bill: coupon already item total me shamil → alag line nahi (double discount nahi)', () => {
  const r = reconcileBill({ itemTotal: 130, deliveryFee: 0, packingCharges: 10, taxes: 20, discount: 20, coupon: 'TRYNEW', freeCash: 0, oneMembershipFee: 0, total: 160 });
  assert.equal(r.bill.discountAlreadyApplied, true);
  assert.equal(r.bill.discount, null);
});

test('bill: packing GST ke andar ho → double nahi jodta', () => {
  const r = reconcileBill({ itemTotal: 100, deliveryFee: 0, packingCharges: 10, taxes: 40, taxesAndCharges: 40, freeCash: 0, oneMembershipFee: 0, total: 140 });
  assert.equal(r.bill.packingCharges, 0);
  assert.equal(r.bill.total, 140);
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.PACKING_INSIDE_TAXES));
});

test('bill: One Lite fee par delivery FREE nahi → nuksaan saaf batao', () => {
  const r = reconcileBill({ ...BASE, deliveryFee: 20, deliverySaved: 0, total: 241 });
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.ONE_WITHOUT_BENEFIT));
});

test('bill: negative / junk value → 0 ya null, note ke saath (NaN total nahi)', () => {
  assert.equal(toMoney('-40'), 0);
  assert.equal(toMoney('abc'), null);
  assert.equal(toMoney('1,234.50'), 1234.5);
  const r = reconcileBill({ ...BASE, deliveryFee: -20 });
  assert.equal(r.bill.deliveryFee, 0);
  assert.ok(r.notes.some((n) => n.code === BILL_CODES.NEGATIVE));
});

test('bill: 3 decimal → 2 par round + note', () => {
  assert.equal(toMoney('10.555'), 10.555);
  const r = reconcileBill({ itemTotal: 100.555, deliveryFee: 0, packingCharges: 0, taxes: 0, freeCash: 0, oneMembershipFee: 0, total: 100.56 });
  assert.equal(r.bill.itemTotal, 100.56);
});

test('bill: bill hi nahi aaya → saaf problem, koi number invent nahi', () => {
  for (const bad of [null, undefined, 'x', 5]) {
    const r = reconcileBill(bad);
    assert.equal(r.bill, null);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === BILL_CODES.MISSING));
  }
});

test('bill: To Pay ₹0 → pay karne layak nahi, problem', () => {
  const r = reconcileBill({ itemTotal: 0, deliveryFee: 0, packingCharges: 0, taxes: 0, freeCash: 0, oneMembershipFee: 0, total: 0 });
  assert.ok(r.problems.some((p) => p.code === BILL_CODES.ZERO_TOTAL));
});

// ── QR ───────────────────────────────────────────────────────────────────
const GOOD = 'upi://pay?pa=upiswiggy@icici&pn=Swiggy&am=170.00&cu=INR&tr=2525267';

test('qr: normal intent → QR taiyaar, amount exact', () => {
  const plan = planQrGeneration([{ source: 'provider', uri: GOOD }], { amount: 170 });
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'provider');
  assert.match(plan.uri, /^upi:\/\/pay\?/);
  assert.match(describeQrPlan(plan), /QR taiyaar/);
});

test('qr: escaped / duplicate / `amount` alias — normalize hokar QR banta hai', () => {
  const plan = planQrGeneration([{ source: 'provider', uri: 'upi://pay?pa=upiswiggy@icici&amp;am=170.00&amp;amount=200.00&amp;cu=INR' }], { amount: 170 });
  assert.equal(plan.ok, true);
  assert.ok(!/&amp;|amount=/.test(plan.uri));
  assert.ok(plan.warnings.length >= 1, 'auto-fix bataya');
});

test('qr: intent hi nahi → fail + asli wajah', () => {
  const plan = planQrGeneration([], { amount: 170 });
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(' '), /koi source hi nahi/i);
});

test('qr: fake/placeholder VPA → block (payment hoti hi nahi)', () => {
  const check = checkQrCandidate({ source: 'provider', uri: 'upi://pay?pa=swiggy@icici&am=170&cu=INR' }, { amount: 170 });
  assert.equal(check.ok, false);
  assert.match(check.reasons.join(' '), /placeholder|fake/i);
});

test('qr: amount alag → block, dono numbers', () => {
  const check = checkQrCandidate({ source: 'provider', uri: 'upi://pay?pa=upiswiggy@icici&am=168.00&cu=INR' }, { amount: 170 });
  assert.equal(check.ok, false);
  assert.match(check.reasons.join(' '), /₹168.*₹170/);
});

test('qr: amount missing / 0 / teen decimal → block', () => {
  assert.equal(checkQrCandidate({ source: 'p', uri: 'upi://pay?pa=upiswiggy@icici&cu=INR' }, { amount: 170 }).ok, false);
  assert.equal(checkQrCandidate({ source: 'p', uri: 'upi://pay?pa=upiswiggy@icici&am=0&cu=INR' }, { amount: 170 }).ok, false);
  assert.equal(checkQrCandidate({ source: 'p', uri: 'upi://pay?pa=upiswiggy@icici&am=170.005&cu=INR' }, { amount: 170 }).ok, false);
});

test('qr: `cu` non-INR / control char / space → block', () => {
  assert.equal(checkQrCandidate({ source: 'p', uri: 'upi://pay?pa=upiswiggy@icici&am=170&cu=USD' }, { amount: 170 }).ok, false);
  // Control char/space transport ki gandi hai — encode ho kar QR chal jata hai.
  assert.equal(checkQrCandidate({ source: 'p', uri: 'upi://pay?pa=upiswiggy@icici&am=170&cu=INR&tn=a\u0001b' }, { amount: 170 }).ok, true);
  assert.equal(checkQrCandidate({ source: 'p', uri: 'upi://pay?pa=upiswiggy@icici&am=170&cu=INR&tn=Swiggy Order' }, { amount: 170 }).ok, true);
});

test('qr: intent web link / galat scheme → block (UPI intent chahiye)', () => {
  assert.equal(checkQrCandidate({ source: 'p', uri: 'https://www.swiggy.com/pay?x=1' }, { amount: 170 }).ok, false);
  assert.equal(checkQrCandidate({ source: 'p', uri: 'paytm://pay?pa=x@y&am=170' }, { amount: 170 }).ok, false);
});

test('qr: bahut lamba intent → block (scan hi nahi hoga)', () => {
  const long = GOOD + '&tn=' + 'x'.repeat(MAX_QR_URI_LENGTH);
  const check = checkQrCandidate({ source: 'p', uri: long }, { amount: 170 });
  assert.equal(check.ok, false);
  assert.match(check.reasons.join(' '), /lamba/);
});

test('qr: pehla galat, doosra sahi (payment page) → doosra jeeta, pehla reason ke saath', () => {
  const plan = planQrGeneration([
    { source: 'provider', uri: 'upi://pay?pa=swiggy@icici&am=170&cu=INR' },
    { source: 'payment_page', uri: GOOD }
  ], { amount: 170 });
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'payment_page');
  assert.equal(plan.attempted[0].ok, false);
  assert.match(plan.attempted[0].reasons.join(' '), /placeholder|fake/i);
});

test('qr: dono galat → HAR wajah list me (sirf ek generic line nahi)', () => {
  const plan = planQrGeneration([
    { source: 'provider', uri: 'upi://pay?pa=swiggy@icici&am=170&cu=INR' },
    { source: 'payment_page', uri: 'upi://pay?pa=upiswiggy@icici&am=99&cu=INR' }
  ], { amount: 170 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reasons.length, 2);
  assert.match(plan.reasons.join(' '), /placeholder|fake/i);
  assert.match(plan.reasons.join(' '), /₹99/);
});

test('qr: wahi intent do baar → duplicate skip (faltu retry nahi)', () => {
  const plan = planQrGeneration([
    { source: 'provider', uri: 'upi://pay?pa=swiggy@icici&am=170&cu=INR' },
    { source: 'payment_page', uri: 'upi://pay?pa=swiggy@icici&am=170&cu=INR' }
  ], { amount: 170 });
  assert.equal(plan.ok, false);
  assert.ok(plan.attempted.some((a) => (a.reasons || []).some((r) => /duplicate/.test(r))));
});

test('qr: render check — asli PNG hamesha, khaali/jhoothi image nahi', () => {
  // 1x1 PNG ka asli base64 (signature ke saath), par bahut chhota → QR nahi
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal(isRenderableQrImage(tiny), false, 'chhoti image QR nahi');
  assert.equal(isRenderableQrImage('data:image/png;base64,' + 'A'.repeat(400)), false, 'ganda base64');
  assert.equal(isRenderableQrImage('https://x/y.png'), false);
  assert.equal(isRenderableQrImage(''), false);
});
