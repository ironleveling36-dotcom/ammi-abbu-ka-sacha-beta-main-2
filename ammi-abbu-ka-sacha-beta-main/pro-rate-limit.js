/**
 * Boss (31-10-2026, round 17):
 *   "KOI BHI KAAM KARNE SE PEHLE KITNI POSSIBILITIES HOSAKTI SABKO IDENTIFY
 *    KARKE BLOCK KARDIA KAR NA"
 *
 * Ye module ek hi jagah sab rate limits rakhta hai — koi route apna alag
 * counter nahi banata. Sab pure functions hain (db object andar, network
 * bahar), isliye test me seedha chalta hai.
 */

/** Har bucket: kitne attempts, kitni der me. */
export const RATE_LIMITS = {
  // Bahut mehnga / khatarnaak — Swiggy session import (galat JSON spam).
  accountImport: { max: 8, windowMs: 60 * 60 * 1000 },
  // Session JSON copy — bahut mehnga nahi, par spam se bachne ke liye capped.
  accountExport: { max: 30, windowMs: 60 * 60 * 1000 },
  // OTP spam (Swiggy ko SMS jata hai, account ban ho sakta hai).
  otpSend: { max: 8, windowMs: 60 * 60 * 1000 },
  otpVerify: { max: 15, windowMs: 15 * 60 * 1000 },
  // Paisa: UTR guessing / claim spam.
  walletClaim: { max: 10, windowMs: 60 * 60 * 1000 },
  walletTopup: { max: 20, windowMs: 60 * 60 * 1000 },
  // Order: ek account par bar-bar place mat karo.
  checkout: { max: 6, windowMs: 15 * 60 * 1000 },
  // Swiggy calls jo paise/ban ka risk rakhte hain.
  cartSync: { max: 90, windowMs: 60 * 1000 },
  // Round 33: bill ka doosra kadam (offers + coupon trials) — mehnga hai,
  // par bill ke saath hi chalta hai, isliye alag aur thoda tight bucket.
  cartOptimize: { max: 40, windowMs: 60 * 1000 },
  cartImport: { max: 20, windowMs: 10 * 60 * 1000 },
  offersClaim: { max: 20, windowMs: 60 * 60 * 1000 },
  addressResolve: { max: 30, windowMs: 30 * 60 * 1000 }
};

function bucketStore(db) {
  if (!db.config) db.config = {};
  if (!db.config.rateLimits || typeof db.config.rateLimits !== 'object') db.config.rateLimits = {};
  return db.config.rateLimits;
}

function bucketKey(userId, bucket) {
  return `${String(bucket)}:${String(userId)}`;
}

/**
 * Kitne attempts ho chuke (window ke andar) — purane automatically saaf.
 * @returns {{ used: number, max: number, windowMs: number, remaining: number, resetInMs: number }}
 */
export function rateLimitState(db, userId, bucket, { now = Date.now() } = {}) {
  const limit = RATE_LIMITS[bucket] || { max: 30, windowMs: 60 * 1000 };
  const store = bucketStore(db);
  const key = bucketKey(userId, bucket);
  const raw = store[key];
  const hits = (Array.isArray(raw) ? raw : (raw?.hits || []))
    .map(Number)
    .filter((at) => Number.isFinite(at) && now - at < limit.windowMs && at <= now + 1000);
  if (raw !== undefined) store[key] = hits;
  const oldest = hits.length ? Math.min(...hits) : now;
  return {
    used: hits.length,
    max: limit.max,
    windowMs: limit.windowMs,
    remaining: Math.max(0, limit.max - hits.length),
    resetInMs: hits.length ? Math.max(0, oldest + limit.windowMs - now) : 0
  };
}

/** Ek attempt count karo (limit check ke baad hi call karo). */
export function recordRateLimitHit(db, userId, bucket, { now = Date.now() } = {}) {
  const store = bucketStore(db);
  const key = bucketKey(userId, bucket);
  const state = rateLimitState(db, userId, bucket, { now });
  const hits = [...(store[key] || []), now];
  store[key] = hits.slice(-Math.max(state.max, 1) * 4);
  return state;
}

/**
 * Check + record ek saath.
 * @returns {{ allowed: boolean, retryAfterSec: number, used: number, max: number }}
 */
export function checkRateLimit(db, userId, bucket, { now = Date.now() } = {}) {
  const state = rateLimitState(db, userId, bucket, { now });
  if (state.used >= state.max) {
    return {
      allowed: false,
      used: state.used,
      max: state.max,
      retryAfterSec: Math.max(1, Math.ceil(state.resetInMs / 1000))
    };
  }
  recordRateLimitHit(db, userId, bucket, { now });
  return { allowed: true, used: state.used + 1, max: state.max, retryAfterSec: 0 };
}

/** App/boss ko dikhane ke liye saaf line (Hinglish, concrete). */
export function rateLimitMessage(bucket, result) {
  const minutes = Math.max(1, Math.ceil(Number(result?.retryAfterSec || 0) / 60));
  const what = {
    accountImport: 'ID import',
    accountExport: 'session JSON copy',
    otpSend: 'OTP bhejna',
    otpVerify: 'OTP verify',
    walletClaim: 'wallet claim',
    walletTopup: 'top-up',
    checkout: 'order place karna',
    cartSync: 'bill sync',
    cartOptimize: 'best coupon check',
    cartImport: 'cart import',
    offersClaim: 'offer claim',
    addressResolve: 'address resolve'
  }[bucket] || 'ye kaam';
  return `Bahut baar ${what} ho gaya (${result?.used || 0}/${result?.max || 0} attempts). ${minutes} minute baad try karein — ye rate limit galat use rokne ke liye hai.`;
}
