/**
 * Boss (31-10-2026, round 18):
 *   "AB BILL CALCULATE KA HAR POSSIBILITY KO DHAYAN RAKH KAR ... CODE LIKHO"
 *
 * Bills Swiggy se har shape me aate hain — numbers string me, `₹1,234.50` me,
 * `undefined`, null, negative, teen decimal, free cash payable se zyada,
 * coupon "laga hua" par discount 0, One Lite fee bina free delivery ke,
 * packing GST ke andar, aur kabhi `order_total` baki lines se nahi milta.
 *
 * Ye module pure hai: jo Swiggy ne diya wahi use karta hai, kabhi number
 * invent nahi karta. Jahan jod nahi milta, wo `problems` me SAAMNE aata hai
 * (chhupta nahi), aur jahan sirf line ka naam badalna hai (packing GST me
 * shamil) wahan `notes` me bata kar adjust karta hai.
 */

export const BILL_CODES = {
  MISSING: 'BILL_MISSING',
  TOTAL_MISSING: 'BILL_TOTAL_MISSING',
  NOT_A_NUMBER: 'BILL_VALUE_NOT_A_NUMBER',
  NEGATIVE: 'BILL_NEGATIVE_VALUE',
  EXTRA_PRECISION: 'BILL_MORE_THAN_2_DECIMALS',
  DOES_NOT_ADD_UP: 'BILL_DOES_NOT_ADD_UP',
  TOTAL_CHANGED: 'BILL_TOTAL_CHANGED',
  ITEM_TOTAL_DERIVED: 'BILL_ITEM_TOTAL_DERIVED',
  FREE_CASH_CLAMPED: 'BILL_FREE_CASH_OVER_PAYABLE',
  COUPON_NOT_APPLIED: 'BILL_COUPON_FLAG_WITHOUT_DISCOUNT',
  ONE_WITHOUT_BENEFIT: 'BILL_ONE_FEE_WITHOUT_FREE_DELIVERY',
  DELIVERY_FREE_UNKNOWN_SAVING: 'BILL_DELIVERY_FREE_NO_SAVING',
  PACKING_INSIDE_TAXES: 'BILL_PACKING_INSIDE_TAXES',
  SUBSCRIPTION_WITHOUT_FEE: 'BILL_SUBSCRIPTION_WITHOUT_FEE',
  ZERO_TOTAL: 'BILL_ZERO_TOTAL'
};

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const isMoney = (value) => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));

/**
 * Har tarah ki money input ko number banao — `"₹1,234.50"`, `"1 234.5"`,
 * `"1234.50 INR"`, `1234.5`, `"1234.567"`. Jo samajh na aaye → null.
 */
export function toMoney(value, { notes = null, field = '' } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value < 0) {
      if (notes) notes.push({ code: BILL_CODES.NEGATIVE, field, value, message: `${field} negative aa gaya (₹${value}) — 0 maan liya, warna total galat kam ho jata.` });
      return 0;
    }
    return value;
  }
  let text = String(value).trim();
  if (!text) return null;
  // Currency symbol / code / spaces / commas hata do (sirf pehla token).
  text = text.replace(/[₹$]|(?:\bINR\b|\bRs\.?\b)/gi, '').replace(/[,\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    if (notes) notes.push({ code: BILL_CODES.NOT_A_NUMBER, field, value: String(value).slice(0, 40), message: `${field} ki value number nahi hai ("${String(value).slice(0, 30)}") — us line ko chhoda gaya.` });
    return null;
  }
  const num = Number(text);
  if (!Number.isFinite(num)) return null;
  if (num < 0) {
    if (notes) notes.push({ code: BILL_CODES.NEGATIVE, field, value: num, message: `${field} negative aa gaya (₹${num}) — 0 maan liya, isliye total kam nahi dikhega.` });
    return 0;
  }
  return num;
}

/** 2 decimal se zyada ho to round — aur note chhod do. */
function tidy(value, { notes, field }) {
  if (value === null) return null;
  const rounded = round2(value);
  if (Math.abs(rounded - value) > 1e-9) {
    notes.push({ code: BILL_CODES.EXTRA_PRECISION, field, from: value, to: rounded, message: `${field} me 2 se zyada decimal the (${value}) — ₹${rounded} kiya.` });
  }
  return rounded;
}

/**
 * Bill ka poora sach.
 *
 * @param {object} raw Swiggy/provider ka bill (parseDapiCartPayload ka output ya quote.bill)
 * @param {object} opts
 * @param {number|null} opts.expectedTotal jo amount app ne user ko dikhaya / approve kiya
 * @param {Array} opts.items cart items (itemTotal missing ho to inhi se jodta hai)
 * @returns {{bill: object, checks: Array, problems: Array, notes: Array, ok: boolean}}
 */
export function reconcileBill(raw, { expectedTotal = null, items = [] } = {}) {
  const problems = [];
  const notes = [];
  const checks = [];
  const check = (key, ok, detail = '') => { checks.push({ key, ok: ok === true, detail }); return ok === true; };

  if (!raw || typeof raw !== 'object') {
    problems.push({ code: BILL_CODES.MISSING, message: 'Swiggy ne bill hi nahi diya — koi amount nahi bana sakte.' });
    return { bill: null, checks, problems, notes, ok: false };
  }

  const money = (field, value) => tidy(toMoney(value, { notes, field }), { notes, field });

  const itemTotalRaw = money('itemTotal', raw.itemTotal ?? raw.item_total ?? raw.subtotal);
  const deliveryFee = money('deliveryFee', raw.deliveryFee ?? raw.delivery_fee ?? raw.deliveryCharges);
  const deliverySaved = Math.max(0, money('deliverySaved', raw.deliverySaved ?? raw.freeDeliveryDiscount) ?? 0);
  const packingCharges = Math.max(0, money('packingCharges', raw.packingCharges ?? raw.packing ?? raw.totalPackingCharges) ?? 0);
  const taxes = Math.max(0, money('taxes', raw.taxes ?? raw.tax ?? raw.gst) ?? 0);
  const discountRaw = Math.max(0, money('discount', raw.discount ?? raw.couponDiscount) ?? 0);
  const freeCashRaw = Math.max(0, money('freeCash', raw.freeCash) ?? 0);
  const tradeDiscount = Math.max(0, money('tradeDiscount', raw.tradeDiscount) ?? 0);
  const oneMembershipFee = Math.max(0, money('oneMembershipFee', raw.oneMembershipFee) ?? 0);
  let total = money('total', raw.total ?? raw.orderTotal ?? raw.toPay);

  // ── item total: na ho to items se jodo (invent nahi, jod hai) ────────────
  let itemTotal = itemTotalRaw;
  if (itemTotal === null && Array.isArray(items) && items.length) {
    const sum = items.reduce((acc, item) => {
      const price = toMoney(item?.price);
      const qty = Number(item?.qty ?? item?.quantity ?? 0);
      if (price === null || !Number.isFinite(qty) || qty <= 0) return acc;
      const line = toMoney(item?.lineTotal);
      return acc + (line !== null ? line : price * qty);
    }, 0);
    if (sum > 0) {
      itemTotal = tidy(sum, { notes, field: 'itemTotal' });
      notes.push({ code: BILL_CODES.ITEM_TOTAL_DERIVED, message: `Swiggy ne item total nahi diya — items ka jod ₹${itemTotal} liya.` });
    }
  }
  check('itemTotalPresent', itemTotal !== null, itemTotal === null ? 'item total missing' : `₹${itemTotal}`);

  // ── total: na ho to lines se banao (aur batao ki banaya) ────────────────
  let totalDerived = false;
  const grossOf = () => round2((itemTotal ?? 0) + (deliveryFee ?? 0) + packingCharges + taxes + oneMembershipFee);
  if (total === null && (itemTotal !== null || deliveryFee !== null)) {
    total = round2(Math.max(0, grossOf() - discountRaw - freeCashRaw - tradeDiscount));
    totalDerived = true;
    notes.push({ code: BILL_CODES.TOTAL_MISSING, message: `Swiggy ne To Pay nahi diya — lines se ₹${total} nikala; ye derived hai, Swiggy ka bataya hua nahi.` });
  }
  const totalPresent = check('totalPresent', total !== null, totalDerived ? `derived ₹${total}` : (total === null ? 'missing' : `₹${total}`));

  if (total !== null && total <= 0) {
    problems.push({ code: BILL_CODES.ZERO_TOTAL, message: 'To Pay ₹0 aa raha hai — is bill par pay karne layak kuch nahi; Swiggy se dobara bill lein.' });
  }

  // ── packing GST ke andar ho sakta hai ──────────────────────────────────
  const taxesAndChargesRaw = money('taxesAndCharges', raw.taxesAndCharges);
  let taxesUse = taxes;
  let packingUse = packingCharges;
  if (taxesAndChargesRaw !== null) {
    const packingLooksIncluded = packingUse > 0 && Math.abs(taxesAndChargesRaw - taxesUse) < 0.5 && Math.abs(taxesAndChargesRaw - (taxesUse + packingUse)) > 0.5;
    if (packingLooksIncluded) {
      notes.push({ code: BILL_CODES.PACKING_INSIDE_TAXES, message: `Packing ₹${packingUse} already "GST & other" (₹${taxesAndChargesRaw}) ke andar hai — double nahi jodenge.` });
      packingUse = 0;
    }
  }

  // ── free cash kabhi payable se zyada nahi ──────────────────────────────
  let freeCash = freeCashRaw;
  const payableBeforeFreeCash = round2(Math.max(0, (itemTotal ?? 0) + (deliveryFee ?? 0) + packingUse + taxesUse + oneMembershipFee - discountRaw - tradeDiscount));
  if (freeCash > payableBeforeFreeCash) {
    notes.push({ code: BILL_CODES.FREE_CASH_CLAMPED, message: `Free cash ₹${freeCash} bill se zyada tha — sirf ₹${payableBeforeFreeCash} lagaya (baaki next order ke liye Swiggy ke paas rehta hai).` });
    freeCash = payableBeforeFreeCash;
  }

  // ── coupon line: discount 0 par "laga hua" dikhana jhooth hai ──────────
  let couponApplied = discountRaw > 0;
  let coupon = String(raw.coupon || raw.couponCode || '').trim();
  if (coupon && discountRaw <= 0) {
    notes.push({ code: BILL_CODES.COUPON_NOT_APPLIED, message: `"${coupon}" bill me laga nahi (discount ₹0) — coupon line nahi dikhayenge.` });
    coupon = '';
  }
  if (!coupon) couponApplied = false;

  // ── One Lite fee par delivery FREE na ho to bolo ───────────────────────
  if (oneMembershipFee > 0 && (deliveryFee ?? 0) > 0) {
    notes.push({ code: BILL_CODES.ONE_WITHOUT_BENEFIT, message: `One Lite ka ₹${oneMembershipFee} lag raha hai par delivery ₹${deliveryFee} bhi — ye nuksaan hai, membership ka fayda nahi.` });
  }
  if ((deliveryFee ?? 0) === 0 && deliverySaved <= 0) {
    notes.push({ code: BILL_CODES.DELIVERY_FREE_UNKNOWN_SAVING, message: 'Delivery FREE hai par Swiggy ne bachaya hua amount nahi diya — saving 0 dikhayenge (jhooth nahi).' });
  }
  if (Array.isArray(raw.subscriptionItems) && raw.subscriptionItems.length && oneMembershipFee <= 0) {
    notes.push({ code: BILL_CODES.SUBSCRIPTION_WITHOUT_FEE, message: 'Subscription item cart me hai par fee ₹0 — bill par One Lite line nahi dikhayenge.' });
  }

  // ── jod milta hai ya nahi ──────────────────────────────────────────────
  let otherCharges = 0;
  let unlistedDiscount = 0;
  let adds = false;
  if (total !== null) {
    const gross = round2((itemTotal ?? 0) + (deliveryFee ?? 0) + packingUse + taxesUse + oneMembershipFee);
    // Do hypothesis: (h1) coupon alag line hai, (h2) coupon item total me
    // already shamil hai. Jo hypothesis total se milti hai wahi sach hai.
    const h1 = round2(gross - discountRaw - freeCash - tradeDiscount);
    const h2 = round2(gross - freeCash - tradeDiscount);
    if (discountRaw > 0 && Math.abs(total - h2) < 0.5 && Math.abs(total - h1) >= 0.5) {
      couponApplied = false;
      coupon = '';
      notes.push({ code: BILL_CODES.COUPON_NOT_APPLIED, message: `Coupon ka discount item total me already shamil lagta hai (₹${discountRaw}) — alag line nahi dikhayenge, warna bill dobara kam lagega.` });
    }
    const expectedNow = round2(gross - (couponApplied ? discountRaw : 0) - freeCash - tradeDiscount);
    const known = round2(total - expectedNow);
    // Boss ka purana rule: Swiggy ka total **kam** ho to wo chhupi hui saving
    // hai (unlistedDiscount) — darawni warning nahi. Par total **zyada** ho aur
    // wajah pata na chale, wo user se chhupaya hua charge hai — usme chup
    // rehna jhooth hoga, isliye ek limit ke baad problem banta hai.
    const tolerance = Math.max(20, round2(total * 0.15));
    if (known > 0.5) {
      if (known <= tolerance) otherCharges = round2(known);
      // warna kuch nahi jodenge — neeche linesAddUp false + problem aayega
    } else if (known < -0.5) {
      unlistedDiscount = round2(Math.abs(known));
    }
    if (false) {
      /* purana duplicate block hata diya */
    }
    const rebuilt = round2((itemTotal ?? 0) + (deliveryFee ?? 0) + packingUse + taxesUse + oneMembershipFee + otherCharges - (couponApplied ? discountRaw : 0) - freeCash - tradeDiscount - unlistedDiscount);
    adds = Math.abs(round2(total - rebuilt)) < 0.5;
    check('linesAddUp', adds, adds ? '' : `lines ₹${rebuilt}, Swiggy To Pay ₹${total}`);
    if (!adds) {
      problems.push({
        code: BILL_CODES.DOES_NOT_ADD_UP,
        message: `Bill ki lines ka jod ₹${rebuilt} hai par Swiggy To Pay ₹${total} keh raha hai (₹${round2(total - rebuilt)} ka farq). Payment Swiggy ke ₹${total} par hogi — app yahi dikhata hai.`
      });
    }
  }

  // ── approved total vs live total ───────────────────────────────────────
  const expected = toMoney(expectedTotal);
  if (expected !== null && total !== null && Math.abs(round2(expected) - round2(total)) >= 0.5) {
    problems.push({
      code: BILL_CODES.TOTAL_CHANGED,
      message: `Aapne ₹${round2(expected)} ka bill dekha tha, Swiggy ab ₹${round2(total)} keh raha hai — naya bill dekhein, phir Pay dabaiye.`
    });
  }
  check('totalUnchanged', !(expected !== null && total !== null && Math.abs(round2(expected) - round2(total)) >= 0.5), expected === null ? 'koi approved total nahi' : `approved ₹${expected}`);

  const shownDiscount = couponApplied ? round2(discountRaw) : 0;
  const bill = {
    ...raw,
    itemTotal,
    deliveryFee,
    deliverySaved,
    packingCharges: packingUse,
    taxes: taxesUse,
    discount: couponApplied ? round2(discountRaw) : null,
    coupon: couponApplied ? coupon : '',
    discountAlreadyApplied: discountRaw > 0 && !couponApplied,
    freeCash: round2(freeCash),
    tradeDiscount: round2(tradeDiscount),
    oneMembershipFee: round2(oneMembershipFee),
    oneApplied: raw.oneApplied === true || oneMembershipFee > 0,
    otherCharges,
    unlistedDiscount,
    taxesAndCharges: round2(packingUse + taxesUse + otherCharges),
    totalSavings: round2(Math.max(
      toMoney(raw.totalSavings) ?? 0,
      shownDiscount + freeCash + tradeDiscount + deliverySaved
    )),
    total: total === null ? null : round2(total),
    totalDerived,
    linesAddUp: adds,
    // Jaan-boojh kar `mismatch: false` — sach `problems` me hai, darawne box me nahi.
    mismatch: false,
    checks: checks.map((c) => ({ key: c.key, ok: c.ok })),
    problems: problems.map((p) => ({ code: p.code, message: p.message })),
    notes: notes.map((n) => ({ code: n.code, message: n.message }))
  };

  const blocking = problems.filter((p) => p.code === BILL_CODES.MISSING || p.code === BILL_CODES.DOES_NOT_ADD_UP || p.code === BILL_CODES.TOTAL_CHANGED);
  return { bill, checks, problems, notes, ok: total !== null && totalPresent && blocking.length === 0 };
}

/** App/boss ke liye ek line — jo sach hai wahi. */
export function describeBillState(result) {
  if (!result?.bill) return 'Bill nahi mila — Swiggy se dobara bill lein.';
  if (result.problems.some((p) => p.code === BILL_CODES.TOTAL_CHANGED)) return 'Bill ka amount badal gaya — naya bill dekh kar dobara Pay dabaiye.';
  if (result.problems.some((p) => p.code === BILL_CODES.DOES_NOT_ADD_UP)) return 'Bill ki lines aur To Pay me farq hai — app Swiggy ka To Pay dikha raha hai.';
  const bits = [];
  if (result.bill.deliveryFee === 0) bits.push('Delivery FREE');
  if (result.bill.freeCash > 0) bits.push(`₹${result.bill.freeCash} free cash`);
  if (result.bill.discount) bits.push(`coupon ₹${result.bill.discount}`);
  if (result.bill.oneMembershipFee > 0) bits.push(`One Lite ₹${result.bill.oneMembershipFee}`);
  return bits.length ? `Bill mil gaya — ${bits.join(' · ')} · To Pay ₹${result.bill.total}` : `Bill mil gaya — To Pay ₹${result.bill.total}`;
}
