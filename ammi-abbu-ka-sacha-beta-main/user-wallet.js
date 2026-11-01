/**
 * user-wallet.js — ₹15 per order service fee + user balance vault (boss 29-10-2026).
 *
 * Boss: "other people are using my bot for ordering food… I should charge them
 * 15rs for each order but I don't know how to confirm if they paid me for real or
 * not… they don't need any balance to check the item price but they have to pay
 * after JSON is alloted and then bill is calculated, and when they try to
 * generate QR ask them to pay 15 rs to UPI, then give them option to verify their
 * UTR, and after it is verified if the balance reach how much is needed to place
 * the order it will generate the QR and cut their balance. If they try to cancel
 * it be refunded; also if the order is placed and they click cancel it won't be
 * refunded anymore. And give me a vault of users where I can search by name and
 * adjust everything."
 *
 * Rules implemented:
 *   • Price check / cart / address / bill → NO balance needed (kuch nahi rukta).
 *   • QR generate karne se pehle: balance ≥ service fee (₹15 default).
 *   • Balance badhane ka rasta = ₹15 (ya jitna chahe) boss ke UPI par + UTR.
 *     UTR **sach me verify** tabhi hota hai: provider API configured ho to auto,
 *     warna boss approve kare. Bot apne aap se "verified" kabhi nahi likhta.
 *   • QR bante waqt fee balance se kati jaati hai (order par record).
 *   • Order place nahi hua (QR stage) → cancel par fee REFUND.
 *     Order Swiggy par place ho chuka → cancel par refund NAHI.
 *   • Boss vault: har user ka balance, search (name/username/id), add/deduct,
 *     free-user toggle, pending UTR approve/reject.
 *
 * Money is stored in PAISE (integers) — no float rounding holes.
 * Pure module (no Telegram, no network except injectable fetch) => offline tests.
 */
import { evaluateUtrCredit } from './upi-credit-policy.js';
import { fetchUtrPaymentDetails, describeLookup } from './utr-lookup.js';
import { describeUtrPayment } from './utr-truth.js';

/** ₹15 default; env se badla ja sakta hai (`SERVICE_FEE_PAISE=1500`). */
export function serviceFeePaise() {
  const raw = Number(process.env.SERVICE_FEE_PAISE);
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  return 1500;
}

/**
 * Boss panel se set kiya hua fee (db.config.serviceFeePaise) — env se pehle.
 * Boss: "order par kitna lena hai uska bhi pannel" → wahi value yahan se aati hai.
 */
export function serviceFeePaiseFor(db) {
  const raw = db?.config?.serviceFeePaise;
  if (raw === null || raw === undefined || raw === '') return serviceFeePaise();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return serviceFeePaise();
  return Math.round(n);
}

/** Boss fee (paise) set kare — 0 = free. */
export function setServiceFeePaise(db, paise, { actor = 'boss', at = Date.now() } = {}) {
  const n = Math.round(Number(paise));
  if (!Number.isFinite(n) || n < 0) return { ok: false, code: 'BAD_AMOUNT' };
  if (n > 100000) return { ok: false, code: 'TOO_HIGH', reason: '₹1000 se zyada fee nahi' };
  const c = cfg(db);
  c.serviceFeePaise = n;
  c.serviceFeeUpdatedAt = nowIso(at);
  c.serviceFeeUpdatedBy = String(actor || 'boss');
  return { ok: true, code: 'SET', feePaise: n };
}

/** Top-up minimum (default = ek order ki fee). */
export function minTopupPaise() {
  const raw = Number(process.env.WALLET_MIN_TOPUP_PAISE);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  return serviceFeePaise();
}

export const TOPUP_PRESETS_PAISE = [1500, 5000, 10000, 20000];

/**
 * Boss (31-10-2026, round 11): "DEFAULT UPI WILL BE mius@ybl ... AND I CAN
 * CHANGE IT ALSO." Payment lene wala UPI ek hi jagah se aata hai — boss panel
 * se badal sakta hai, env se bhi (WALLET_UPI_ID), warna default `mius@ybl`.
 */
export function walletUpiId(db) {
  const fromDb = String(db?.config?.walletUpiId || '').trim();
  if (isUpiHandle(fromDb)) return fromDb;
  const fromEnv = String(process.env.WALLET_UPI_ID || '').trim();
  if (isUpiHandle(fromEnv)) return fromEnv;
  return 'mius@ybl';
}

export function isUpiHandle(value) {
  return /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/.test(String(value || '').trim());
}

/** Boss UPI badle. Sirf valid handle; galat par code + wajah. */
export function setWalletUpiId(db, upiId, { actor = 'boss', at = Date.now() } = {}) {
  const value = String(upiId || '').trim();
  if (!isUpiHandle(value)) return { ok: false, code: 'INVALID_UPI', reason: 'UPI id aise likhein: naam@bank (jaise mius@ybl)' };
  const c = cfg(db);
  c.walletUpiId = value;
  c.walletUpiUpdatedAt = nowIso(at);
  c.walletUpiUpdatedBy = String(actor || 'boss');
  return { ok: true, code: 'SET', upiId: value };
}

/** UPI intent jo kisi bhi UPI app se kholta hai (top-up ke liye). */
export function buildTopupUpiIntent({ upiId, amountPaise, note = 'Wallet topup' } = {}) {
  const paise = Math.round(Number(amountPaise) || 0);
  if (!isUpiHandle(upiId) || !(paise > 0)) return '';
  const amount = (paise / 100).toFixed(2);
  const params = new URLSearchParams({
    pa: String(upiId), pn: 'Sacha Beta', am: amount, cu: 'INR', tn: String(note).slice(0, 40)
  });
  return `upi://pay?${params.toString()}`;
}

export const TOPUP_STATUS = {
  PENDING: 'PENDING',
  AUTO_VERIFIED: 'AUTO_VERIFIED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  DUPLICATE: 'DUPLICATE'
};

const LEDGER_LIMIT = 200;
const MAX_TOPUP_REQUESTS = 2000;

export function nowIso(at) {
  return new Date(at || Date.now()).toISOString();
}

export function rupees(paise) {
  const n = Number(paise) || 0;
  const whole = Math.trunc(n / 100);
  const frac = Math.abs(n % 100);
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : String(whole);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cfg(db) {
  if (!db.config) db.config = {};
  if (!db.config.wallets || typeof db.config.wallets !== 'object') db.config.wallets = {};
  if (!db.config.topupRequests || typeof db.config.topupRequests !== 'object') db.config.topupRequests = {};
  // Boss (31-10-2026, round 16): "SAME UTR BAAR BAAR USE KAR PAA RAHA".
  // `topupRequests` purane records prune karta hai, jisse UTR ki yaad bhi mit
  // jaati thi. Ye ledger kabhi prune nahi hota — ek UTR = ek hi baar, hamesha.
  if (!db.config.usedUtrs || typeof db.config.usedUtrs !== 'object') db.config.usedUtrs = {};
  return db.config;
}

/** UTR ledger ka record (koi bhi user, koi bhi status). */
export function findUsedUtr(db, raw) {
  const utr = normalizeUtr(raw);
  if (!utr) return null;
  const ledger = cfg(db).usedUtrs;
  if (ledger[utr]) return ledger[utr];
  return null;
}

/** UTR ko hamesha ke liye "used" mark karo. */
export function markUtrUsed(db, raw, { userId = '', amountPaise = 0, status = '', source = '', at = Date.now() } = {}) {
  const utr = normalizeUtr(raw);
  if (!utr) return null;
  const c = cfg(db);
  if (!c.usedUtrs[utr]) {
    c.usedUtrs[utr] = {
      utr,
      userId: String(userId || ''),
      amountPaise: Math.round(Number(amountPaise) || 0),
      status: String(status || ''),
      source: String(source || ''),
      at: nowIso(at)
    };
  }
  return c.usedUtrs[utr];
}

/** Wallet record banao (agar pehle se hai to wahi). */
export function ensureWallet(db, userId, { name = '', username = '', at = Date.now() } = {}) {
  const c = cfg(db);
  const key = String(userId || '').trim();
  if (!key) return null;
  let w = c.wallets[key];
  if (!w) {
    w = {
      userId: key,
      name: String(name || '').slice(0, 60),
      username: String(username || '').slice(0, 40),
      balancePaise: 0,
      feeExempt: false,
      createdAt: nowIso(at),
      updatedAt: nowIso(at),
      ledger: []
    };
    c.wallets[key] = w;
  } else {
    if (name && !w.name) w.name = String(name).slice(0, 60);
    if (username && !w.username) w.username = String(username).slice(0, 40);
  }
  return w;
}

export function getWallet(db, userId) {
  return cfg(db).wallets[String(userId || '')] || null;
}

export function walletBalancePaise(db, userId) {
  const w = getWallet(db, userId);
  return Number(w?.balancePaise || 0);
}

function pushLedger(w, entry) {
  w.ledger = Array.isArray(w.ledger) ? w.ledger : [];
  w.ledger.push(entry);
  if (w.ledger.length > LEDGER_LIMIT) w.ledger = w.ledger.slice(-LEDGER_LIMIT);
}

function entryId(prefix, at) {
  return `${prefix}_${at}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Balance badhao (top-up approval / refund / boss credit). */
export function creditWallet(db, userId, amountPaise, {
  reason = 'credit', actor = '', at = Date.now(), meta = null, type = 'CREDIT'
} = {}) {
  const amount = Math.round(Number(amountPaise) || 0);
  if (!(amount > 0)) return { ok: false, reason: 'amount must be > 0' };
  const w = ensureWallet(db, userId, { at });
  if (!w) return { ok: false, reason: 'user id missing' };
  w.balancePaise = Number(w.balancePaise || 0) + amount;
  w.updatedAt = nowIso(at);
  const entry = {
    id: entryId('c', at),
    at: nowIso(at),
    type,
    amountPaise: amount,
    balanceAfterPaise: w.balancePaise,
    reason: String(reason || 'credit').slice(0, 120),
    actor: String(actor || ''),
    meta: meta || null
  };
  pushLedger(w, entry);
  return { ok: true, wallet: w, entry, balancePaise: w.balancePaise };
}

/** Balance kato (fee / boss deduct). Insufficient → kuch nahi hota. */
export function debitWallet(db, userId, amountPaise, {
  reason = 'debit', actor = '', at = Date.now(), meta = null
} = {}) {
  const amount = Math.round(Number(amountPaise) || 0);
  if (!(amount > 0)) return { ok: false, reason: 'amount must be > 0' };
  const w = ensureWallet(db, userId, { at });
  if (!w) return { ok: false, reason: 'user id missing' };
  const balance = Number(w.balancePaise || 0);
  if (balance < amount) {
    return { ok: false, reason: 'INSUFFICIENT_BALANCE', balancePaise: balance, neededPaise: amount - balance };
  }
  w.balancePaise = balance - amount;
  w.updatedAt = nowIso(at);
  const entry = {
    id: entryId('d', at),
    at: nowIso(at),
    type: 'DEBIT',
    amountPaise: amount,
    balanceAfterPaise: w.balancePaise,
    reason: String(reason || 'debit').slice(0, 120),
    actor: String(actor || ''),
    meta: meta || null
  };
  pushLedger(w, entry);
  return { ok: true, wallet: w, entry, balancePaise: w.balancePaise };
}

/**
 * Boss adjustment: + / − kisi bhi amount ka. 0 allowed (no-op).
 * `deltaPaise` positive = jama, negative = kato.
 */
export function adjustWallet(db, userId, deltaPaise, { actor = 'boss', reason = 'boss adjust', at = Date.now() } = {}) {
  const delta = Math.round(Number(deltaPaise) || 0);
  if (delta === 0) return { ok: false, reason: 'zero adjustment' };
  if (delta > 0) {
    const res = creditWallet(db, userId, delta, { reason, actor, at, type: 'ADJUST' });
    return res.ok ? { ...res, adjustedPaise: delta } : res;
  }
  const res = debitWallet(db, userId, -delta, { reason, actor, at });
  if (!res.ok) return res;
  const w = res.wallet;
  if (Array.isArray(w.ledger) && w.ledger.length) {
    const last = w.ledger[w.ledger.length - 1];
    last.type = 'ADJUST';
  }
  return { ...res, adjustedPaise: delta };
}

export function setFeeExempt(db, userId, exempt, { actor = 'boss', at = Date.now() } = {}) {
  const w = ensureWallet(db, userId, { at });
  if (!w) return { ok: false, reason: 'user id missing' };
  w.feeExempt = Boolean(exempt);
  w.updatedAt = nowIso(at);
  const entry = {
    id: entryId('f', at),
    at: nowIso(at),
    type: 'FLAG',
    amountPaise: 0,
    balanceAfterPaise: Number(w.balancePaise || 0),
    reason: exempt ? 'free user (no ₹ fee)' : 'fee applies again',
    actor: String(actor || ''),
    meta: null
  };
  pushLedger(w, entry);
  return { ok: true, wallet: w };
}

/** Order Swiggy par place ho chuka hai? (refund ka faisla isi par). */
export function isOrderPlaced(order) {
  return Boolean(order?.swiggyOrderId || order?.pendingSwiggyOrderId || order?.placedAt);
}

/**
 * 🧊 QR HOLD (boss 30-10-2026): "jab qr ban jaye wo store rahega aur jab fee
 * payment success for that specific order then wo qr release hoga."
 * QR image tab banti hai jab order ka payment data (Swiggy URI / link) ready ho —
 * wahi order par hold hota hai, customer ko fee settle hone ke baad milta hai.
 */
export function holdOrderQr(order, { at = Date.now(), upiUri = '', paymentUrl = '', fallbackReady = false } = {}) {
  if (!order) return { ok: false, code: 'NO_ORDER' };
  const uri = String(upiUri || order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
  const url = String(paymentUrl || order.swiggyPaymentUrl || '').trim();
  if (!uri && !url && !fallbackReady) return { ok: false, code: 'NO_PAYMENT_DATA' };
  order.qrHeld = true;
  order.qrHeldAt = nowIso(at);
  order.qrHeldUri = uri;
  order.qrHeldPaymentUrl = url;
  order.qrHeldViaFallback = Boolean(!uri && !url && fallbackReady);
  order.cardStage = 'QR_HELD';
  return { ok: true, code: 'HELD', upiUri: uri, paymentUrl: url };
}

export function isOrderQrHeld(order) {
  return Boolean(order?.qrHeld && (order?.qrHeldUri || order?.qrHeldPaymentUrl || order?.qrHeldViaFallback));
}

/** Fee settle hone par held QR release (customer ko QR jata hai). */
export function releaseOrderQr(order, { at = Date.now() } = {}) {
  if (!order) return { ok: false, code: 'NO_ORDER' };
  if (!isOrderQrHeld(order)) return { ok: false, code: 'NOT_HELD' };
  if (!order.qrHeldUri && order.qrHeldPaymentUrl && !order.swiggyPaymentUrl) {
    order.swiggyPaymentUrl = order.qrHeldPaymentUrl;
  }
  order.qrHeld = false;
  order.qrReleasedAt = nowIso(at);
  order.cardStage = 'QR_RELEASED';
  return { ok: true, code: 'RELEASED', upiUri: order.qrHeldUri || '', paymentUrl: order.qrHeldPaymentUrl || '' };
}

export function orderFeeState(order) {
  const charged = Number(order?.feeChargedPaise || 0);
  const refunded = Number(order?.feeRefundedPaise || 0);
  return {
    chargedPaise: charged,
    refundedPaise: refunded,
    netPaise: Math.max(0, charged - refunded),
    waived: Boolean(order?.feeWaived),
    chargedAt: order?.feeChargedAt || '',
    refundedAt: order?.feeRefundedAt || '',
    placed: isOrderPlaced(order)
  };
}

/**
 * QR banane se pehle fee kato. Ek order par sirf ek baar (idempotent).
 * Returns `{ ok, code, balancePaise, feePaise }`.
 */
export function chargeServiceFee(db, order, userId, {
  feePaise = null, actor = 'auto', at = Date.now()
} = {}) {
  const fee = feePaise === null ? serviceFeePaiseFor(db) : Math.round(Number(feePaise) || 0);
  if (!order) return { ok: false, code: 'NO_ORDER' };
  const netCharged = Math.max(0, Number(order.feeChargedPaise || 0) - Number(order.feeRefundedPaise || 0));
  if (netCharged > 0) {
    if (order.feeWalletUserId && String(order.feeWalletUserId) !== String(userId)) {
      return { ok: false, code: 'FEE_OWNER_MISMATCH' };
    }
    return { ok: true, code: 'ALREADY_CHARGED', feePaise: netCharged, balancePaise: walletBalancePaise(db, userId) };
  }
  if (fee <= 0) {
    order.feeWaived = true;
    order.feeWaivedAt = nowIso(at);
    return { ok: true, code: 'FREE_BY_CONFIG', feePaise: 0, balancePaise: walletBalancePaise(db, userId) };
  }
  const w = ensureWallet(db, userId, { at });
  if (!w) return { ok: false, code: 'NO_USER' };
  if (w.feeExempt) {
    order.feeWaived = true;
    order.feeWaivedAt = nowIso(at);
    return { ok: true, code: 'WAIVED', feePaise: 0, balancePaise: Number(w.balancePaise || 0) };
  }
  const res = debitWallet(db, userId, fee, {
    reason: `order #${order.id} service fee`,
    actor,
    at,
    meta: { orderId: String(order.id) }
  });
  if (!res.ok) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE', balancePaise: res.balancePaise, neededPaise: res.neededPaise, feePaise: fee };
  }
  order.feeChargedPaise = fee;
  order.feeChargedAt = nowIso(at);
  order.feeWalletUserId = String(userId);
  delete order.feeRefundedAt;
  delete order.feeRefundedPaise;
  delete order.feeRefundReason;
  delete order.feeWaived;
  delete order.feeWaivedAt;
  return { ok: true, code: 'CHARGED', feePaise: fee, balancePaise: res.balancePaise };
}

/**
 * Cancel/close par refund: SIRF jab order Swiggy par place nahi hua.
 * Place ho chuka → boss ka rule: "won't be refunded anymore".
 */
export function refundServiceFee(db, order, userId, {
  reason = 'order cancelled before placing', actor = 'auto', at = Date.now()
} = {}) {
  if (!order) return { ok: false, code: 'NO_ORDER' };
  const charged = Number(order.feeChargedPaise || 0);
  if (!(charged > 0)) return { ok: false, code: 'NOTHING_CHARGED' };
  if (Number(order.feeRefundedPaise || 0) >= charged) {
    return { ok: false, code: 'ALREADY_REFUNDED', refundedPaise: Number(order.feeRefundedPaise) };
  }
  if (isOrderPlaced(order)) {
    return { ok: false, code: 'ORDER_PLACED_NO_REFUND', chargedPaise: charged };
  }
  if (order.feeWalletUserId && String(order.feeWalletUserId) !== String(userId)) {
    return { ok: false, code: 'FEE_OWNER_MISMATCH' };
  }
  const remaining = charged - Number(order.feeRefundedPaise || 0);
  const res = creditWallet(db, userId, remaining, {
    reason: `refund: ${String(reason).slice(0, 80)} (order #${order.id})`,
    actor,
    at,
    type: 'REFUND',
    meta: { orderId: String(order.id) }
  });
  if (!res.ok) return { ok: false, code: 'CREDIT_FAILED', reason: res.reason };
  order.feeRefundedPaise = (Number(order.feeRefundedPaise || 0)) + remaining;
  order.feeRefundedAt = nowIso(at);
  order.feeRefundReason = String(reason).slice(0, 120);
  return { ok: true, code: 'REFUNDED', refundedPaise: remaining, balancePaise: res.balancePaise };
}

// ── UTR / top-up requests ───────────────────────────────────────────────────

/** UPI UTR: 8-30 alphanumeric (asli UTR 12 digit hota hai, par sab apps alag likhte hain). */
export function normalizeUtr(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function validateUtr(raw) {
  const utr = normalizeUtr(raw);
  if (!utr) return { ok: false, reason: 'UTR khaali hai' };
  if (utr.length < 8 || utr.length > 30) return { ok: false, reason: 'UTR 8-30 characters ka hota hai' };
  if (!/\d/.test(utr)) return { ok: false, reason: 'UTR me digits hone chahiye' };
  return { ok: true, utr };
}

function utrIndex(db) {
  const c = cfg(db);
  const map = new Map();
  for (const req of Object.values(c.topupRequests)) {
    if (req?.utr) map.set(normalizeUtr(req.utr), req);
  }
  return map;
}

export function findTopupByUtr(db, raw) {
  const utr = normalizeUtr(raw);
  if (!utr) return null;
  for (const req of Object.values(cfg(db).topupRequests)) {
    if (normalizeUtr(req?.utr) === utr) return req;
  }
  return null;
}

/**
 * Provider API se UTR verify karne ki koshish. Configure nahi hai to
 * `{ configured: false }` — bot jhootha "verified" nahi bolta.
 */
export async function verifyUtrWithProvider({ utr, amountPaise, userId }, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const url = String(process.env.UPI_UTR_VERIFY_URL || '').trim();
  if (!url) return { configured: false, verified: false, reason: 'koi UTR verification provider set nahi hai' };
  if (typeof fetchImpl !== 'function') return { configured: true, verified: false, reason: 'network layer missing' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.UPI_UTR_VERIFY_TOKEN ? { Authorization: `Bearer ${process.env.UPI_UTR_VERIFY_TOKEN}` } : {})
      },
      body: JSON.stringify({ utr, amountPaise, userId: String(userId || '') }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await res.json().catch(() => ({}));
    if (!res?.ok) return { configured: true, verified: false, reason: `provider HTTP ${res?.status || 0}` };
    const verified = json?.verified === true || json?.status === 'SUCCESS' || json?.status === 'SUCCESSFUL';
    return {
      configured: true,
      verified,
      reason: String(json?.message || (verified ? 'provider ne UTR confirm kiya' : 'provider ne UTR confirm nahi kiya')).slice(0, 140),
      amountPaise: Number(json?.amountPaise || json?.amount || 0) || null,
      payeeName: String(json?.payeeName || json?.payee || json?.beneficiary || '').slice(0, 60),
      payeeVpa: String(json?.payeeVpa || json?.vpa || '').slice(0, 60),
      at: Number(json?.paidAt || json?.at || 0) || null,
      status: String(json?.paymentStatus || json?.status || '').slice(0, 20),
      providerRef: String(json?.ref || json?.transactionId || json?.utr || '').slice(0, 60)
    };
  } catch (err) {
    return { configured: true, verified: false, reason: `provider error: ${String(err?.message || err).slice(0, 100)}` };
  }
}

/**
 * 🤖 AUTO-VERIFY available hai ya nahi (boss 30-10-2026):
 * "ek to UTR auto verify na ho raha" — jab tak koi asli auto-verify ka rasta
 * (provider API ya gateway webhook) set nahi hai, UTR daalne ka chakkar customer
 * par nahi daalna chahiye. Paisa aaya to webhook/provider khud confirm karega.
 */
export function autoVerifyConfigured() {
  return Boolean(
    String(process.env.UPI_UTR_VERIFY_URL || '').trim() ||
    String(process.env.PAY_WEBHOOK_SECRET || '').trim() ||
    String(process.env.PAY_AUTO_VERIFY || '').trim() === '1'
  );
}

/**
 * Fee abhi liye bina order aage badhaya — boss panel me "due" ke roop me dikhta
 * hai (koi manual UTR queue nahi, koi customer block nahi).
 */
export function recordDeferredFee(order, feePaise, { at = Date.now(), reason = 'auto-verify set nahi' } = {}) {
  if (!order) return { ok: false, code: 'NO_ORDER' };
  const fee = Math.round(Number(feePaise) || 0);
  if (!(fee > 0)) return { ok: false, code: 'NO_FEE' };
  order.feeDeferredPaise = Number(order.feeDeferredPaise || 0) + fee;
  order.feeDeferredAt = nowIso(at);
  order.feeDeferredReason = String(reason).slice(0, 120);
  return { ok: true, code: 'DEFERRED', feePaise: fee, totalDeferredPaise: order.feeDeferredPaise };
}

/** Deferred (baad me lene wali) fee settle — boss ne cash/UPI me le li. */
export function settleDeferredFee(db, order, userId, { at = Date.now(), actor = 'boss' } = {}) {
  if (!order) return { ok: false, code: 'NO_ORDER' };
  const due = Math.round(Number(order.feeDeferredPaise || 0));
  if (!(due > 0)) return { ok: false, code: 'NOTHING_DUE' };
  order.feeChargedPaise = Number(order.feeChargedPaise || 0) + due;
  order.feeChargedAt = nowIso(at);
  order.feeWalletUserId = String(userId || '');
  order.feeDeferredPaise = 0;
  order.feeSettledManuallyAt = nowIso(at);
  order.feeSettledBy = String(actor || 'boss');
  return { ok: true, code: 'SETTLED', feePaise: due };
}

/**
 * User ne UTR daala → request banao. Duplicate UTR (kisi bhi user ka) reject.
 * Provider configured ho to usi waqt verify; warna PENDING (boss approve karega).
 */
export async function submitTopupRequest(db, options = {}) {
  const checked = validateUtr(options.utr);
  let lookupResult = null;
  if (checked.ok && options.autoVerify !== false) {
    lookupResult = await fetchUtrPaymentDetails(checked.utr, {
      fetchImpl: options.fetchImpl || globalThis.fetch, userId: options.userId
    }).catch((err) => ({ configured: false, found: false, reason: String(err?.message || err), tried: [] }));
  }
  return submitTopupRequestWithLookup(db, { ...options, lookupResult });
}

// Apply a completed lookup synchronously. Production callers read a fresh DB
// after the network lookup, then apply + save without yielding: another order
// fee or UTR claim cannot overwrite an intervening wallet mutation.
export function submitTopupRequestWithLookup(db, {
  userId, utr, amountPaise, name = '', username = '', note = '', at = Date.now(),
  autoVerify = true, minPaise = null, autoMaxPaise = 0, lookupResult = null
} = {}) {
  const checked = validateUtr(utr);
  if (!checked.ok) return { ok: false, code: 'INVALID_UTR', reason: checked.reason };
  const amount = Math.round(Number(amountPaise) || 0);
  // Mini App ka claim partial ho sakta hai (boss: "IF USER PAY LESS ... ADD HOW
  // MUCH THEY PAID"), isliye floor override hota hai — par ₹1 se kam kabhi nahi.
  const floor = Math.max(100, Math.round(Number(minPaise) || minTopupPaise()));
  if (!(amount >= floor)) {
    return { ok: false, code: 'AMOUNT_TOO_LOW', reason: `minimum ₹${rupees(floor)}`, minPaise: floor };
  }
  const c = cfg(db);
  // Pehle permanent ledger, phir live requests — dono me se koi bhi mila to
  // wahi UTR dobara nahi chalega (bhale purana record prune ho chuka ho).
  const used = findUsedUtr(db, checked.utr);
  const dup = used || utrIndex(db).get(checked.utr);
  if (dup) {
    return {
      ok: false,
      code: 'DUPLICATE_UTR',
      reason: `ye UTR pehle ${dup.status === TOPUP_STATUS.REJECTED ? 'reject' : 'use'} ho chuka hai (${String(dup.at || '').slice(0, 10)})`,
      existingStatus: dup.status
    };
  }
  markUtrUsed(db, checked.utr, { userId, amountPaise: amount, status: 'CLAIMED', source: 'submitTopupRequest', at });
  ensureWallet(db, userId, { name, username, at });
  const req = {
    id: `tu_${at}_${Math.random().toString(36).slice(2, 7)}`,
    userId: String(userId),
    name: String(name || '').slice(0, 60),
    username: String(username || '').slice(0, 40),
    utr: checked.utr,
    claimedPaise: amount,
    approvedPaise: 0,
    status: TOPUP_STATUS.PENDING,
    note: String(note || '').slice(0, 160),
    at: nowIso(at),
    reviewedAt: '',
    reviewedBy: '',
    reason: ''
  };
  c.topupRequests[req.id] = req;

  const keys = Object.keys(c.topupRequests);
  if (keys.length > MAX_TOPUP_REQUESTS) {
    // Purane closed requests hata do (PENDING kabhi nahi).
    for (const k of keys.slice(0, keys.length - MAX_TOPUP_REQUESTS)) {
      if (c.topupRequests[k]?.status !== TOPUP_STATUS.PENDING) delete c.topupRequests[k];
    }
  }

  if (autoVerify) {
    // Boss (31-10-2026, round 20):
    //   "JAB CHOTA AMOUNT DAAL KAR RANDOM KOI BHI UTR DAALTA WO ADD HO JATA ...
    //    UTR PAR JITNA AMOUNT JAYE AGAR WO MISBAHUL ISLAM HO UTNA ADD HOJAYE"
    //
    // Pehle provider set na hone par sirf "UTR unique hai" se credit ho jata
    // tha — koi bhi random UTR + chhota amount wallet me add. Ab credit ka
    // faisla sirf ASLI payment proof se hota hai (upi-credit-policy.js):
    //   statement entry (bank/UPI) ya provider verify → payee Misbahul Islam,
    //   status SUCCESS, aur jitna paisa aaya utna hi. Proof na ho → PENDING,
    //   balance me kuch nahi judta.
    // Round 23 (boss): "UTR SE PAYMENT DETAILS ... THAT WILL BE FETCHED AND
    // ADDED". Provider se poori payment detail fetch hoti hai (amount, payee,
    // status) — credit usi asli amount par, claim par nahi.
    const lookup = lookupResult || { configured: false, found: false, reason: 'Payment details unavailable', tried: [] };
    req.providerConfigured = lookup.configured === true;
    req.lookup = {
      configured: lookup.configured === true,
      found: lookup.found === true,
      tried: Array.isArray(lookup.tried) ? lookup.tried : [],
      reason: String(lookup.reason || '').slice(0, 200),
      line: describeLookup(lookup, { utr: checked.utr })
    };
    const providerPayment = lookup.found && lookup.payment
      ? { ...lookup.payment, utr: checked.utr, source: 'provider', at: Number(lookup.payment.at) || at }
      : null;
    // Bank/UPI statement me boss ne ye payment dekhi hai? (`upi-statement.js`)
    const statementPayment = (() => {
      const entry = (c.upiStatement && typeof c.upiStatement === 'object') ? c.upiStatement[checked.utr] : null;
      return entry ? { ...entry, source: entry.source || 'statement' } : null;
    })();
    // Sabse pehle asli statement (boss ne dekhi), warna live provider fetch.
    const payment = statementPayment || providerPayment || null;
    const decision = evaluateUtrCredit({
      claim: { utr: checked.utr, claimedPaise: amount, userId },
      intent: { amountPaise: amount, createdAt: Date.parse(req.at || '') || at },
      payment,
      usedUtrs: {}, // duplicate pehle hi upar check ho chuka (+ ledger mark ho chuki hai)
      autoMaxPaise: Math.max(0, Math.round(Number(autoMaxPaise) || 0)),
      allowedPayeeVpas: [walletUpiId(db)],
      at
    });
    req.paymentEvidence = payment ? { source: payment.source || '', amountPaise: Number(payment.amountPaise) || 0, payee: payment.payeeName || payment.payeeVpa || '', ref: payment.ref || '' } : null;
    // Round 25 (boss): "UTR SE SAB DETAILS NIKAALUNGA — ABHI YA OLD, KISI AUR KO,
    // AUR KITNA". Poora sach request par hi rehta hai (kitna aaya, kab, kisko,
    // kaun bheja, status, kya kya chahiye).
    const truth = describeUtrPayment({
      utr: checked.utr, payment, lookup, intent: { amountPaise: amount, createdAt: Date.parse(req.at || '') || at },
      claimedPaise: amount, now: at, autoMaxPaise, allowedPayeeVpas: [walletUpiId(db)]
    });
    req.utrTruth = {
      amountPaise: truth.amountPaise, amountLine: truth.amountLine,
      askedPaise: truth.askedPaise, askedLine: truth.askedLine,
      paidAt: truth.paidAt, freshness: truth.freshness, whenLine: truth.whenLine,
      payeeLine: truth.payee.line, payeeOurs: truth.payee.isOurs,
      payerLine: truth.payer.line, statusLine: truth.statusLine,
      verdictAction: truth.verdict.action, verdictCode: truth.verdict.code,
      summaryLine: truth.summaryLine, bossLine: truth.bossLine,
      checklist: truth.checklist, missing: truth.missing
    };
    if (decision.action === 'CREDIT') {
      const credit = creditWallet(db, userId, decision.creditedPaise, {
        reason: `Top-up verified: UTR ${checked.utr} — ${decision.reason}`.slice(0, 240),
        actor: decision.verifiedBy || 'verified',
        at,
        type: 'CREDIT',
        meta: { utr: checked.utr, topupId: req.id, verifiedBy: decision.verifiedBy || 'verified', providerRef: String(payment?.ref || '') }
      });
      if (!credit.ok) {
        req.providerReason = credit.reason;
        return { ok: false, code: 'CREDIT_FAILED', reason: credit.reason, request: req };
      }
      // Ledger me asli amount likho (claim ka nahi).
      const ledger = findUsedUtr(db, checked.utr);
      if (ledger) { ledger.status = 'CREDITED'; ledger.amountPaise = decision.creditedPaise; }
      req.status = TOPUP_STATUS.AUTO_VERIFIED;
      req.approvedPaise = decision.creditedPaise;
      req.claimedPaise = amount;
      req.verifiedBy = decision.verifiedBy || 'verified';
      req.reviewedAt = nowIso(at);
      req.reviewedBy = decision.verifiedBy || 'verified';
      req.reason = decision.reason;
      return {
        ok: true, code: 'AUTO_VERIFIED', request: req, balancePaise: credit.balancePaise,
        verifiedBy: decision.verifiedBy, creditedPaise: decision.creditedPaise, utrTruth: req.utrTruth
      };
    }
    if (decision.action === 'REJECT') {
      // Jhootha claim: UTR ledger me reh jata hai (dobara try nahi), par paisa
      // nahi judta aur asli wajah likhi jati hai.
      req.status = TOPUP_STATUS.REJECTED;
      req.approvedPaise = 0;
      req.reviewedAt = nowIso(at);
      req.reviewedBy = 'verify';
      req.reason = decision.reason;
      req.providerReason = decision.reason;
      return { ok: false, code: decision.code, reason: decision.reason, request: req, balancePaise: walletBalancePaise(db, userId), utrTruth: req.utrTruth };
    }
    req.providerReason = decision.reason;
    req.verifyPendingReason = decision.reason;
  }

  return { ok: true, code: 'PENDING', request: req, balancePaise: walletBalancePaise(db, userId), utrTruth: req.utrTruth || null };
}

/** Boss ne UTR approve kiya → balance jama. Idempotent. */
export function approveTopupRequest(db, requestId, { actor = 'boss', approvedPaise = null, at = Date.now(), note = '' } = {}) {
  const req = cfg(db).topupRequests[String(requestId || '')];
  if (!req) return { ok: false, code: 'NOT_FOUND' };
  if (req.status === TOPUP_STATUS.APPROVED || req.status === TOPUP_STATUS.AUTO_VERIFIED) {
    return { ok: false, code: 'ALREADY_APPROVED', request: req };
  }
  if (req.status === TOPUP_STATUS.REJECTED) return { ok: false, code: 'REJECTED_EARLIER', request: req };
  const used = findUsedUtr(db, req.utr);
  const otherSettled = Object.values(cfg(db).topupRequests).some((other) =>
    other?.id !== req.id && normalizeUtr(other?.utr) === normalizeUtr(req.utr) &&
    [TOPUP_STATUS.APPROVED, TOPUP_STATUS.AUTO_VERIFIED].includes(other?.status)
  );
  if (otherSettled || String(used?.status || '').toUpperCase() === 'CREDITED') return { ok: false, code: 'UTR_ALREADY_CREDITED', request: req };
  if (used?.userId && String(used.userId) !== String(req.userId)) return { ok: false, code: 'UTR_OWNER_MISMATCH', request: req };
  const amount = Math.round(Number(approvedPaise ?? req.claimedPaise) || 0);
  if (!(amount > 0)) return { ok: false, code: 'BAD_AMOUNT' };
  const credit = creditWallet(db, req.userId, amount, {
    reason: `UTR ${req.utr} approved${note ? ` — ${String(note).slice(0, 60)}` : ''}`,
    actor,
    at,
    meta: { utr: req.utr, topupId: req.id }
  });
  if (!credit.ok) return { ok: false, code: 'CREDIT_FAILED', reason: credit.reason };
  req.status = TOPUP_STATUS.APPROVED;
  req.approvedPaise = amount;
  req.reviewedAt = nowIso(at);
  req.reviewedBy = String(actor || 'boss');
  req.reason = String(note || 'boss approved').slice(0, 140);
  const ledger = used || markUtrUsed(db, req.utr, { userId: req.userId, amountPaise: amount, status: 'CREDITED', source: 'approval', at });
  if (ledger) { ledger.status = 'CREDITED'; ledger.amountPaise = amount; ledger.topupId = req.id; }
  return { ok: true, code: 'APPROVED', request: req, balancePaise: credit.balancePaise };
}

export function rejectTopupRequest(db, requestId, { actor = 'boss', reason = '', at = Date.now() } = {}) {
  const req = cfg(db).topupRequests[String(requestId || '')];
  if (!req) return { ok: false, code: 'NOT_FOUND' };
  if (req.status === TOPUP_STATUS.APPROVED || req.status === TOPUP_STATUS.AUTO_VERIFIED) {
    return { ok: false, code: 'ALREADY_APPROVED' };
  }
  if (req.status === TOPUP_STATUS.REJECTED) return { ok: false, code: 'ALREADY_REJECTED' };
  req.status = TOPUP_STATUS.REJECTED;
  req.reviewedAt = nowIso(at);
  req.reviewedBy = String(actor || 'boss');
  req.reason = String(reason || 'payment nahi mila').slice(0, 140);
  return { ok: true, code: 'REJECTED', request: req };
}

export function listTopupRequests(db, { status = '', userId = '', limit = 20 } = {}) {
  return Object.values(cfg(db).topupRequests)
    .filter((r) => (!status || r.status === status))
    .filter((r) => (!userId || String(r.userId) === String(userId)))
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, limit);
}

export function pendingTopupCount(db) {
  return Object.values(cfg(db).topupRequests).filter((r) => r.status === TOPUP_STATUS.PENDING).length;
}

// ── boss vault: users, search, summary ──────────────────────────────────────

/** Search: name / username / userId / phone (wallet + users table). */
export function searchWallets(db, query = '', { limit = 12 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const wallets = Object.values(cfg(db).wallets);
  const users = db?.users || {};
  const phoneOf = (w) => String(users?.[String(w.userId)]?.phone || users?.[String(w.userId)]?.mobile || w.phone || '');
  const enriched = wallets.map((w) => ({
    ...w,
    phone: phoneOf(w),
    entry: w.ledger && w.ledger.length ? w.ledger[w.ledger.length - 1] : null
  }));
  const filtered = q
    ? enriched.filter((w) =>
        String(w.name || '').toLowerCase().includes(q) ||
        String(w.username || '').toLowerCase().includes(q) ||
        String(w.userId || '').includes(q) ||
        String(w.phone || '').includes(q))
    : enriched;
  filtered.sort((a, b) => Number(b.balancePaise || 0) - Number(a.balancePaise || 0));
  return filtered.slice(0, limit);
}

export function walletVaultSummary(db) {
  const wallets = Object.values(cfg(db).wallets);
  const totalPaise = wallets.reduce((sum, w) => sum + Number(w.balancePaise || 0), 0);
  const paidUsers = wallets.filter((w) => Number(w.balancePaise || 0) > 0).length;
  const topupTotal = Object.values(cfg(db).topupRequests)
    .filter((r) => r.status === TOPUP_STATUS.APPROVED || r.status === TOPUP_STATUS.AUTO_VERIFIED)
    .reduce((sum, r) => sum + Number(r.approvedPaise || 0), 0);
  return {
    users: wallets.length,
    withBalance: paidUsers,
    totalPaise,
    topupTotalPaise: topupTotal,
    pending: pendingTopupCount(db),
    feePaise: serviceFeePaise()
  };
}

export function walletHistory(db, userId, { limit = 8 } = {}) {
  const w = getWallet(db, userId);
  const ledger = Array.isArray(w?.ledger) ? w.ledger : [];
  return ledger.slice(-limit).reverse();
}

/**
 * Balance top-up hone ke baad: is user ka koi order fee ka intezaar me hai?
 * (Boss: "after it is verified if the balance reaches how much is needed it will
 *  generate the QR and cut their balance".)
 */
export function findOrderAwaitingFee(db, userId, { feePaise = null } = {}) {
  const fee = feePaise === null ? serviceFeePaiseFor(db) : Number(feePaise);
  const orders = Object.values(db?.orders || {});
  const candidates = orders.filter((o) => {
    if (!o || String(o.userId) !== String(userId)) return false;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(o.status || '').toUpperCase())) return false;
    if (Number(o.feeChargedPaise || 0) > 0) return false;
    if (o.pendingSwiggyOrderId || o.swiggyOrderId) return false;
    // QR pehle se ban chuka hai to wo "held" hai — fee aane par wahi release hoga.
    if (isOrderQrHeld(o)) {
      return ['QR_HELD', 'AWAITING_FEE', 'QR_GENERATED', 'PAYMENT_PENDING'].includes(String(o.cardStage || '').toUpperCase())
        || o.status === 'PAYMENT_PENDING';
    }
    if (o.qrGeneratedAt || o.pendingSwiggyUpiUri) return false;
    const stage = String(o.cardStage || '').toUpperCase();
    return ['BILL_READY', 'QR_GENERATED', 'APPROVAL_PENDING', 'AWAITING_FEE'].includes(stage) || o.status === 'APPROVAL_PENDING';
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const order = candidates[0];
  const balance = walletBalancePaise(db, userId);
  const w = getWallet(db, userId);
  const exempt = Boolean(w?.feeExempt);
  return {
    order,
    balancePaise: balance,
    feePaise: fee,
    exempt,
    qrHeld: isOrderQrHeld(order),
    canProceed: exempt || Number(fee) <= 0 || balance >= Number(fee)
  };
}

// ── text (Telegram HTML) ────────────────────────────────────────────────────

export function formatFeePayCard({
  upiId = '', feePaise = serviceFeePaise(), balancePaise = 0, orderId = '', note = ''
} = {}) {
  const short = Math.max(0, Number(feePaise) - Number(balancePaise));
  return [
    '🧾 <b>ORDER FEE — ₹' + rupees(feePaise) + '</b>',
    '',
    `Balance: <b>₹${rupees(balancePaise)}</b>` + (short > 0 ? ` · chahiye <b>₹${rupees(short)}</b> aur` : ' ✓'),
    '',
    `<b>₹${rupees(feePaise)}</b> is UPI par bhejein: <code>${escapeHtml(upiId || '(Boss ne UPI set nahi kiya)')}</code>`,
    note ? `<i>${escapeHtml(note)}</i>` : '',
    '',
    'Payment ke baad <b>UTR / reference number</b> daalna zaroori hai — usi se verify hota hai.',
    '<i>Price check, cart, address aur bill bilkul free hain — sirf QR banane se pehle ye fee hai.</i>'
  ].filter(Boolean).join('\n');
}

export function formatTopupPayCard({ upiId = '', amountPaise = serviceFeePaise(), orderId = '' } = {}) {
  return [
    `➕ <b>BALANCE TOP-UP — ₹${rupees(amountPaise)}</b>`,
    '',
    `Is UPI par <b>₹${rupees(amountPaise)}</b> bhejein: <code>${escapeHtml(upiId || '(UPI set nahi hai)')}</code>`,
    orderId ? `<i>Order <code>#${escapeHtml(String(orderId))}</code> ke liye</i>` : '',
    '',
    'Payment ke baad <b>UTR</b> (UPI app ke history me "UTR / Ref No.") daalna — tabhi balance judega.',
    '<i>Bot khud paisa nahi dekh sakta: UTR provider se ya Boss se verify hota hai — jhootha "verified" nahi milta.</i>'
  ].filter(Boolean).join('\n');
}

export function formatWalletCard({ wallet, feePaise = serviceFeePaise(), pending = null, name = '' } = {}) {
  const w = wallet || {};
  const balance = Number(w.balancePaise || 0);
  const canOrder = w.feeExempt || balance >= Number(feePaise);
  return [
    `👛 <b>MY BALANCE — ₹${rupees(balance)}</b>`,
    name ? `<i>${escapeHtml(name)}</i>` : '',
    '',
    w.feeExempt
      ? '🎁 <b>Free user</b> — per-order fee nahi lagti.'
      : `Per order fee: <b>₹${rupees(feePaise)}</b> · ${canOrder ? '✅ QR ban sakta hai' : `❌ ₹${rupees(Math.max(0, Number(feePaise) - balance))} aur chahiye`}`,
    pending ? `⏳ <b>${pending} top-up</b> verify hone ka wait (UTR check chal raha hai)` : '',
    '',
    '<i>Price check / cart / address / bill — sab free. Fee sirf QR banate waqt, aur cancel (place hone se pehle) par wapas.</i>'
  ].filter(Boolean).join('\n');
}

/**
 * Customer ke liye soft card (koi "wallet/paisa le rahe" wali feeling nahi —
 * boss: "wallet ka option de rha to user ko lagta ki me paisa le rha").
 */
export function formatOrderWalletCard({ wallet = null, feePaise = serviceFeePaise(), pending = null } = {}) {
  const bal = Number(wallet?.balancePaise || 0);
  const fee = Number(feePaise || 0);
  return [
    '🔐 <b>ORDER VERIFICATION</b>',
    '',
    `Ek order ka verification: <b>₹${rupees(fee)}</b> <i>(refundable)</i>`,
    `Aapka jama hua: <b>₹${rupees(bal)}</b>` + (fee > 0 ? ` · ${bal >= fee ? 'ek order ke liye kaafi ✓' : `ek order ke liye ₹${rupees(Math.max(0, fee - bal))} aur`}` : ''),
    pending ? `⏳ <b>${pending}</b> verification check ho raha hai` : '',
    '',
    '<i>Ye paisa order ke bill me nahi judta. Order cancel karenge to turant wapas milta hai.</i>'
  ].filter(Boolean).join('\n');
}

export function formatWalletHistory({ entries = [], limit = 8 } = {}) {
  if (!entries.length) return '🧾 <b>HISTORY</b>\n\n<i>Abhi koi transaction nahi.</i>';
  const icon = (type) => ({
    CREDIT: '➕', DEBIT: '➖', REFUND: '↩️', ADJUST: '⚙️', FLAG: '🏷'
  }[String(type || '').toUpperCase()] || '•');
  const lines = entries.slice(0, limit).map((e) => {
    const amt = Number(e.amountPaise || 0);
    const sign = ['CREDIT', 'REFUND'].includes(String(e.type)) ? '+' : (amt ? '−' : '');
    const day = String(e.at || '').slice(5, 16).replace('T', ' ');
    return `${icon(e.type)} ${day} · ${amt ? `${sign}₹${rupees(amt)}` : ''} <i>${escapeHtml(String(e.reason || '').slice(0, 60))}</i> · bal ₹${rupees(e.balanceAfterPaise)}`;
  });
  return [`🧾 <b>HISTORY (last ${Math.min(entries.length, limit)})</b>`, ...lines].join('\n');
}

export function formatBossWalletList({ wallets = [], summary = null, query = '' } = {}) {
  const head = [
    '👛 <b>USER WALLETS</b>',
    summary
      ? `<i>${summary.users} users · ₹${rupees(summary.totalPaise)} balance · ₹${rupees(summary.topupTotalPaise)} top-up · ${summary.pending} UTR pending · fee ₹${rupees(summary.feePaise)}/order</i>`
      : '',
    query ? `🔎 Search: <b>${escapeHtml(query)}</b>` : ''
  ].filter(Boolean);
  if (!wallets.length) {
    return [...head, '', '<i>Koi user nahi mila.</i>'].join('\n');
  }
  const rows = wallets.map((w, i) => {
    const bal = Number(w.balancePaise || 0);
    const last = w.entry ? ` · last ${String(w.entry.type).toLowerCase()} ₹${rupees(w.entry.amountPaise)}` : '';
    return `${i + 1}. <b>${escapeHtml(w.name || w.username || w.userId)}</b>` +
      `${w.username ? ` (@${escapeHtml(w.username)})` : ''} · <code>${escapeHtml(String(w.userId))}</code>` +
      ` · <b>₹${rupees(bal)}</b>${w.feeExempt ? ' · 🎁 free' : ''}${last}`;
  });
  return [...head, '', ...rows, '', '<i>Kisi user par tap karke balance add/deduct karein.</i>'].join('\n');
}

export function formatBossWalletUser({ wallet = null, userId = '', summaryPending = 0, feePaise = serviceFeePaise(), history = [] } = {}) {
  if (!wallet) return `👤 User <code>${escapeHtml(String(userId))}</code> — wallet nahi mila.`;
  const bal = Number(wallet.balancePaise || 0);
  const orderFee = wallet.feeExempt ? '🎁 free (fee nahi)' : `₹${rupees(feePaise)} / order`;
  return [
    `👤 <b>${escapeHtml(wallet.name || wallet.username || wallet.userId)}</b>`,
    `<code>${escapeHtml(String(wallet.userId))}</code>${wallet.username ? ` · @${escapeHtml(wallet.username)}` : ''}`,
    '',
    `💰 Balance: <b>₹${rupees(bal)}</b>`,
    `🏷 Fee: <b>${orderFee}</b>`,
    summaryPending ? `⏳ Pending UTR: <b>${summaryPending}</b>` : '',
    '',
    formatWalletHistory({ entries: history, limit: 6 })
  ].filter(Boolean).join('\n');
}

/**
 * Boss ka "order par kitna lena hai" panel — fee + paisa + users + orders.
 */
export function feeControlSummary(db) {
  const c = cfg(db);
  const orders = Object.values(db?.orders || {});
  const feeOrders = orders.filter((o) => Number(o?.feeChargedPaise || 0) > 0);
  const grossFeePaise = feeOrders.reduce((sum, o) => sum + Number(o.feeChargedPaise || 0), 0);
  const refundedPaise = orders.reduce((sum, o) => sum + Number(o?.feeRefundedPaise || 0), 0);
  const awaiting = orders.filter((o) => (
    o && !isOrderPlaced(o)
    && Number(o.feeChargedPaise || 0) <= 0
    && ['QR_HELD', 'AWAITING_FEE', 'BILL_READY', 'PAYMENT_PENDING'].includes(String(o.cardStage || '').toUpperCase())
  ));
  const deferredPaise = orders.reduce((sum, o) => sum + Number(o?.feeDeferredPaise || 0), 0);
  const deferredOrders = orders.filter((o) => Number(o?.feeDeferredPaise || 0) > 0).length;
  const wallets = Object.values(c.wallets);
  return {
    feePaise: serviceFeePaiseFor(db),
    feeUpdatedAt: c.serviceFeeUpdatedAt || '',
    users: wallets.length,
    usersWithBalance: wallets.filter((w) => Number(w.balancePaise || 0) > 0).length,
    walletBalanceTotalPaise: wallets.reduce((sum, w) => sum + Number(w.balancePaise || 0), 0),
    freeUsers: wallets.filter((w) => w.feeExempt).length,
    ordersTotal: orders.length,
    ordersWithFee: feeOrders.length,
    grossFeePaise,
    refundedPaise,
    netFeePaise: Math.max(0, grossFeePaise - refundedPaise),
    awaitingFee: awaiting.length,
    deferredPaise,
    deferredOrders,
    autoVerify: autoVerifyConfigured(),
    pendingUtrs: pendingTopupCount(db)
  };
}

export function formatFeeControlPanel({ summary = null } = {}) {
  const s = summary || {};
  return [
    '🧮 <b>WALLET &amp; FEE</b>',
    '',
    `Order par charge: <b>₹${rupees(s.feePaise || 0)}</b> per order` + (Number(s.feePaise || 0) === 0 ? ' <i>(free — 0)</i>' : ''),
    s.feeUpdatedAt ? `<i>Last change: ${escapeHtml(String(s.feeUpdatedAt).slice(0, 16).replace('T', ' '))}</i>` : '<i>Default fee (env se)</i>',
    '',
    `👥 Users: <b>${s.users || 0}</b> · balance wale: <b>${s.usersWithBalance || 0}</b> · free: <b>${s.freeUsers || 0}</b>`,
    `💰 Users ke paas total balance: <b>₹${rupees(s.walletBalanceTotalPaise || 0)}</b>`,
    '',
    `🧾 Orders: <b>${s.ordersTotal || 0}</b> · fee wale: <b>${s.ordersWithFee || 0}</b>`,
    `✔ Fee collected: <b>₹${rupees(s.grossFeePaise || 0)}</b> · refund: ₹${rupees(s.refundedPaise || 0)} · net <b>₹${rupees(s.netFeePaise || 0)}</b>`,
    `⏳ Fee ka intezaar (QR held): <b>${s.awaitingFee || 0}</b> · pending UTR: <b>${s.pendingUtrs || 0}</b>`,
    `🧾 Baad me lene wali fee: <b>₹${rupees(s.deferredPaise || 0)}</b> (${s.deferredOrders || 0} orders)`,
    `🤖 Auto-verify: ${s.autoVerify ? '<b>ON</b> — UTR/paisa khud confirm hota hai' : '<b>OFF</b> — fee QR ko block nahi karti (panel me due dikhti hai)'}`
  ].join('\n');
}

/** Per-user fee/paise summary (boss vault ke andar). */
export function userFeeSummary(db, userId) {
  const orders = Object.values(db?.orders || {}).filter((o) => String(o?.userId || '') === String(userId || ''));
  const charged = orders.reduce((sum, o) => sum + Number(o.feeChargedPaise || 0), 0);
  const refunded = orders.reduce((sum, o) => sum + Number(o.feeRefundedPaise || 0), 0);
  const w = getWallet(db, userId);
  return {
    orders: orders.length,
    feeOrders: orders.filter((o) => Number(o.feeChargedPaise || 0) > 0).length,
    chargedPaise: charged,
    refundedPaise: refunded,
    netPaise: Math.max(0, charged - refunded),
    balancePaise: Number(w?.balancePaise || 0),
    feeExempt: Boolean(w?.feeExempt),
    awaiting: orders.filter((o) => (
      !isOrderPlaced(o)
      && Number(o.feeChargedPaise || 0) <= 0
      && ['QR_HELD', 'AWAITING_FEE'].includes(String(o.cardStage || '').toUpperCase())
    )).length
  };
}

/**
 * Customer ko yahi card jata hai jab order ka QR ban chuka ho par verification
 * baaki hai. Bhasha jaan bujh kar "order ki fee" jaisi nahi — boss: "user ko feel
 * na ho ki wo order par fees de raha".
 */
export function formatOrderVerificationCard({
  orderId = '', restaurant = '', feePaise = serviceFeePaise(), upiId = '', refundable = true
} = {}) {
  return [
    '🧊 <b>AAPKA ORDER QR TAIYAR HAI</b>',
    '',
    `Order <code>#${escapeHtml(String(orderId))}</code>${restaurant ? ` · ${escapeHtml(String(restaurant).slice(0, 42))}` : ''}`,
    'QR ban gaya hai — <b>abhi aapko nahi bheja gaya</b>, safe rakha hua hai.',
    '',
    `🔐 <b>Bas ₹${rupees(feePaise)} verification</b> — upar wala QR scan karke isi amount ka payment karein:`,
    `UPI: <code>${escapeHtml(upiId || '(admin ne UPI set nahi kiya)')}</code>`,
    '',
    refundable
      ? '<i>Ye order ke bill me nahi judta — order cancel karenge to turant wapas mil jayega.</i>'
      : '<i>Ye order ke bill me nahi judta.</i>',
    '',
    '<b>Payment auto verify hota hai</b> — verify hote hi aapka ORDER QR yahin aa jayega (koi UTR type nahi karna).',
    'Koi dikkat ho to neeche <b>Admin se baat</b> dabayein.'
  ].filter(Boolean).join('\n');
}

/** QR ban hi nahi paya — koi fee/shikayat nahi, sirf "try again". */
export function formatQrFailedCard({ orderId = '', reason = '' } = {}) {
  // Boss (30-10-2026): "qr generate fail then user will see something went
  // wrong try again from beginning" — koi fee ka zikr nahi, seedha restart.
  return [
    '⚠️ <b>KUCH GALAT HO GAYA</b>',
    '',
    orderId ? `Order <code>#${escapeHtml(String(orderId))}</code>` : '',
    'Aapke order ka QR ban nahi paya (Swiggy ki taraf se jawab nahi aaya).',
    '',
    '<b>Koi ₹ nahi kata.</b> Neeche button dabaiye — <b>shuru se dobara</b> try karenge.',
    reason ? `<i>${escapeHtml(String(reason).slice(0, 160))}</i>` : '',
    '',
    'Bar bar fail ho raha ho to <b>Admin se baat</b> karein.'
  ].filter(Boolean).join('\n');
}

export function formatPendingUtrs({ requests = [], limit = 10 } = {}) {
  if (!requests.length) return '⏳ <b>PENDING UTR</b>\n\n<i>Koi pending payment nahi.</i>';
  const rows = requests.slice(0, limit).map((r, i) =>
    `${i + 1}. <b>${escapeHtml(r.name || r.username || r.userId)}</b> · <code>${escapeHtml(String(r.userId))}</code>\n` +
    `   UTR <code>${escapeHtml(r.utr)}</code> · claimed <b>₹${rupees(r.claimedPaise)}</b> · ${escapeHtml(String(r.at || '').slice(0, 16).replace('T', ' '))}` +
    (r.providerConfigured ? `\n   <i>provider: ${escapeHtml(String(r.providerReason || 'verify nahi hua'))}</i>` : '\n   <i>provider set nahi hai → aapko UPI statement me dekhna hoga</i>')
  );
  return ['⏳ <b>PENDING UTR — aapke UPI me check karke approve/reject</b>', '', ...rows].join('\n');
}
