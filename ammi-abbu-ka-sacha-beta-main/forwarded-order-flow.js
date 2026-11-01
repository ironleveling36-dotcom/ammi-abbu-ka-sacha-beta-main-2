import crypto from 'crypto';
import { sanitizeUpiUriForQr } from './qr-card.js';
import { renderQrCardBuffered, getQrPoolStats } from './qr-render-pool.js';

export { sanitizeUpiUriForQr, getQrPoolStats };

/**
 * QR card banao — WORKER thread me (main loop block nahi hota). Worker fail ho
 * to yeh khud inline render kar deta hai, isliye API wahi purana hai.
 */
export async function generateNamedUpiQrPngBuffer(job) {
  return renderQrCardBuffered(job);
}
import { Markup } from 'telegraf';
// Rate limiter for heavy lazy callbacks (confirm/track) — same policy as index.js extract_now
const _lazyRateMap = new Map();
function _isLazyRateLimited(userId, maxPerWindow = 5, windowMs = 60_000) {
  const k = String(userId); const now = Date.now(); let rec = _lazyRateMap.get(k);
  if (!rec || now - rec.windowStart > windowMs) { rec = { count: 0, windowStart: now }; _lazyRateMap.set(k, rec); }
  if (rec.count >= maxPerWindow) return true; rec.count += 1; return false;
}
import { getDb, saveDb, upsertOrder, appendAuditEvent, maskAccountCode } from './store.js';
import { validateUpiIntentForQr, describeQrRef, shouldReusePendingQr } from './payment-qr-guard.js';
import { readSwiggyPlacement, placementAlreadyAttemptedError } from './swiggy-placement-journal.js';
import { reserveChatOrderFee, refundChatOrderFeeBeforePlacement } from './wallet-order-gate.js';
import { checkLoggedInFromCookies } from './swiggy-bridge.js';
import { OFFER_TRACKS } from './account-views.js';
import { startJob, clearJob } from './bot-maintenance.js';
import { lockAccountToOrder, releaseAccountLock } from './order-account-lock.js';
import { extractSharedUrls, stripSharedLinks, normalizeSharedUrl, collapseSharedLinks } from './link-utils.js';
import { startOrderTrackingAuto, ensureOrderTracking, isTerminalDeliveryStatus } from './order-tracking.js';
import {
  detectRecipientRole,
  recipientLabelOf,
  planAccountFallbacks,
  retryFetch,
  isRetryableFetchError,
  storeIntakeSnapshot,
  buildLazyConfirmRow,
  buildLazyRescueCard,
  resolveTrackingDelivery,
  trackingRetryPromiseText,
  lazyActionId
} from './lazy-order-pilot.js';

// Robust order lookup — handles stale callback IDs, case mismatch, or swiggyOrderId passed instead of bot orderId
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__']);
export function isSafeOrderKey(key) {
  const k = String(key || '').trim();
  return k && !UNSAFE_KEYS.has(k) && !k.startsWith('__');
}
export function lookupOrder(db, orderId) {
  if (!db?.orders) return null;
  const raw = String(orderId || '').trim();
  if (!raw) return null;
  if (!isSafeOrderKey(raw)) return null;
  // Use hasOwnProperty to avoid prototype chain lookup
  if (Object.prototype.hasOwnProperty.call(db.orders, raw)) return db.orders[raw];
  const q = raw.toLowerCase();
  const qShort = q.slice(-6);
  for (const o of Object.values(db.orders)) {
    if (!o) continue;
    const bid = String(o.id || '').toLowerCase();
    if (bid === q) return o;
    const sid = String(o.swiggyOrderId || '').toLowerCase();
    if (sid && sid === q) return o;
    const pid = String(o.pendingSwiggyOrderId || '').toLowerCase();
    if (pid && pid === q) return o;
    // Short-id fallback: QR caption shows last 4-6 digits like #299100 — match suffix
    if (q.length >= 4 && q.length <= 10) {
      if (bid.endsWith(q) || bid.endsWith(qShort) || (sid && sid.endsWith(q)) || (pid && pid.endsWith(q))) return o;
    }
  }
  return null;
}

export function orderNotFoundDiag(db, orderId) {
  try {
    const asked = String(orderId || '').trim();
    const isNumericSwiggy = /^\d{6,20}$/.test(asked);
    // Friendly hint instead of exposing internal TEST IDs
    if (isNumericSwiggy) {
      return `Order #${asked} bot DB me nahi mila (DB reset/expire ho sakta hai). Swiggy ka numeric ID hai to 🔗 Extract Tracking Link se All IDs scan karein.`;
    }
    return `Order #${asked} nahi mila. Expire ho gaya ho sakta hai — naya order banayein ya Swiggy numeric ID se Extract Tracking Link try karein.`;
  } catch { return `Order #${String(orderId)} nahi mila`; }
}

function placementForChatOrder(order) {
  if (!order?.id) return null;
  return readSwiggyPlacement(`chat:${String(order.id).trim()}`) ||
    (order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.swiggyPlacedUnpaid
      ? { state: 'LEGACY_PENDING', orderId: order.pendingSwiggyOrderId || '' }
      : null);
}

// Genuine Swiggy page used as an honest fallback (never a synthesised tracking URL).
const SWIGGY_ORDERS_PAGE = 'https://www.swiggy.com/orders';

import {
  resolveSwiggyLink,
  parseAddressDetails,
  extractAddressShareUrl,
  isAddressShareUrl,
  reverseGeocodeCoords,
  isValidIndianDeliveryCoordinates,
  geocodeAddressDetails,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  describeAccountRotation,
  pickNextRotationAccount,
  rotationSummary,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  fetchSwiggyTrackingLinkFast,
  extractTrackingViaAllAccounts,
  extractSwiggyProvidedTrackingUrl,
  extractSwiggyDeliveryOtp,
  getStoredSwiggyTrackingUrl,
  isOfficialSwiggyTrackingUrl,
  withSwiggyAccountLock,
  getBusySwiggyAccountsMap,
  releaseSwiggyAccountReservation,
  applyLiveFreeCashRelock,
  applyLiveCouponToOrder,
  adjustOrderItemQuantity,
  clearCouponTrialCache,
  invalidateAccountOrderProfileCache,
  getSwiggySessionAuth,
  warmAccountSessionAuth,
  resolveAccountKeyForHealth,
  swiggyCartFlush,
  dapiFetch,
  computeTrackHmac as swiggyComputeTrackHmac,
  buildSignedOrderTrackUrl
} from './swiggy-cart.js';
import { classifySwiggyAccountFailure, isAccountSuspended, markAccountSuspended, markAccountHealthy, noteAccountFailure, describeSuspendedAccount, suspendedAccountsSummary } from './account-health.js';
import { diagnoseAccountOffers, fixAccountOffers } from './offer-claim-doctor.js';

function isValidCartInput(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  // Never treat tracking links as cart (r.swiggy.com / ofo/track)
  if (isOfficialSwiggyTrackingUrl(s)) return false;
  if (/r\.swiggy\.com|\/ofo\/track/i.test(s)) return false;
  if (/https?:\/\/[^\s]*(swiggy\.com|swig\.gy|onelink\.me)/i.test(s) && !/save my address on swiggy/i.test(s)) return true;
  if (/your cart\s*\n|items total\s*:|final bill/i.test(s)) return true;
  return false;
}

function isValidAddressInput(input) {
  const s = String(input || '').trim();
  if (s.length < 10) return false;
  if (/save my address on swiggy|address\s*:|latitude\s*:|https?:\/\/[^\s]*(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(s)) return true;
  if (/\b\d{6}\b/.test(s) && s.length >= 20) return true;
  if ((s.match(/,/g) || []).length >= 2 && s.length >= 20) return true;
  return false;
}

function primaryCartFallback(s){ const u=String(s).trim(); try{ new URL(u.startsWith('http')?u:'https://'+u); return u; }catch{ return ''; } }

// Instant 0ms synchronous input classifier so burst multi-order intake pairs FIFO drafts cleanly without overwriting!
export function classifyRawOrderInputFast(rawText = '', location = null) {
  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    return { hasCart: false, hasAddress: true, primaryCartUrl: '' };
  }
  const s = String(rawText || '').trim();
  if (!s) return { hasCart: false, hasAddress: false, primaryCartUrl: '' };

  const allUrls = extractSharedUrls(s);
  let hasCart = false;
  let hasAddress = false;
  let primaryCartUrl = '';

  for (const u of allUrls) {
    // Never treat a tracking link as cart or address
    if (isOfficialSwiggyTrackingUrl(u)) {
      continue;
    }
    const isMaps = /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u);
    const isCartHint = /\/gc\/|shared_cart|group[_-]?cart|\/cart|restaurant_id=/i.test(u);
    const isAddrHint = /save my address on swiggy/i.test(s) || /onelink\.me\/jgkq\//i.test(u) || /address|shareaddress|delivery/i.test(u) || /(?:^|\/)(?:ofo\/)?address/i.test(u);

    if (isMaps || (isAddrHint && !isCartHint)) {
      hasAddress = true;
    } else if (isCartHint) {
      hasCart = true;
      if (!primaryCartUrl) primaryCartUrl = u;
    } else if (/(swiggy\.com|swig\.gy|onelink\.me)/i.test(u)) {
      if (!hasCart) {
        hasCart = true;
        if (!primaryCartUrl) primaryCartUrl = u;
      } else {
        // If hasCart is already set from another URL, the second Swiggy/Onelink URL is the address!
        hasAddress = true;
      }
    }
  }

  // If there are 2 or more URLs and one is a cart, any other URL is treated as address
  if (hasCart && !hasAddress && allUrls.length >= 2) {
    const secondUrl = allUrls.find(u => u !== primaryCartUrl && !isOfficialSwiggyTrackingUrl(u));
    if (secondUrl) hasAddress = true;
  }

  const textWithoutUrls = stripSharedLinks(s);
  if (!hasCart && /your cart\s*\n|items total\s*:/i.test(s)) {
    hasCart = true;
  }
  if (!hasAddress && textWithoutUrls.length >= 12 && isValidAddressInput(textWithoutUrls)) {
    hasAddress = true;
  }
  if (!hasAddress && !hasCart && isValidAddressInput(s)) {
    hasAddress = true;
  }
  return { hasCart, hasAddress, primaryCartUrl };
}

// Splits a single mega-message containing 2..N `Cart + Address` order blocks into independent per-order texts!
export function splitMultipleOrderBlocks(rawText = '') {
  const raw = String(rawText || '').trim();
  if (!raw) return [];
  // Markdown pastes contain the same link twice (`[url](url)`); collapse them so
  // each cart link is found exactly once before splitting.
  const normalized = collapseSharedLinks(raw);
  const gcLinks = extractSharedUrls(normalized).filter((u) => /\/gc\/|group_cart/i.test(u));
  if (gcLinks.length <= 1) return [raw];

  const positions = [];
  let searchFrom = 0;
  for (const link of gcLinks) {
    let idx = normalized.indexOf(link, searchFrom);
    if (idx === -1) idx = normalized.indexOf(link);
    positions.push(idx === -1 ? 0 : idx);
    searchFrom = (idx === -1 ? 0 : idx) + link.length;
  }

  // Cut at the end of each cart's line so the address block travels with its link.
  const cutPoints = positions.map((pos, i) => {
    if (i === positions.length - 1) return normalized.length;
    const lineEnd = normalized.indexOf('\n', pos + gcLinks[i].length);
    return lineEnd === -1 ? pos + gcLinks[i].length : lineEnd;
  });

  const segments = [];
  let start = 0;
  for (const end of cutPoints) {
    const chunk = normalized.slice(start, end).trim();
    if (chunk) segments.push(chunk);
    start = end;
  }
  return segments.length >= 2 ? segments : [raw];
}

const activePaymentPollers = new Map();
const activeDeliveryInfoPollers = new Map();
const senderIntakeLocks = new Map();
const orderIngestLocks = new Map();

async function withOrderIngestLock(orderId, fn) {
  const key = String(orderId || 'default_order');
  const prev = orderIngestLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next, () => next);
  orderIngestLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (orderIngestLocks.get(key) === tail) {
      orderIngestLocks.delete(key);
    }
  }
}

export async function withSenderIntakeLock(senderKey, fn) {
  const key = String(senderKey || 'default_sender');
  const prev = senderIntakeLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next, () => next);
  senderIntakeLocks.set(key, tail);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (senderIntakeLocks.get(key) === tail) {
      senderIntakeLocks.delete(key);
    }
  }
}

export function stopOrderPaymentPoller(orderId) {
  const handle = activePaymentPollers.get(orderId);
  if (handle) {
    if (typeof handle === 'object' && handle.state) handle.state.stopped = true;
    const t = typeof handle === 'object' && handle.timer !== undefined ? handle.timer : handle;
    if (t) {
      clearTimeout(t);
      clearInterval(t);
    }
    activePaymentPollers.delete(orderId);
  }
}

export function stopOrderDeliveryInfoPoller(orderId) {
  const state = activeDeliveryInfoPollers.get(String(orderId));
  if (state?.timer) clearTimeout(state.timer);
  if (state) state.stopped = true;
  activeDeliveryInfoPollers.delete(String(orderId));
}

export function computeTrackHmac(orderId) {
  return swiggyComputeTrackHmac(orderId);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasLiveWebSessionCookie(acc) {
  return Boolean(acc?.isLoggedIn && checkLoggedInFromCookies(acc));
}

export function formatBossDiagnosticErrorMessage(err, meta = {}) {
  const code = err?.diag?.code || err?.code || 'UNEXPECTED_ERROR';
  const stage = meta.stage || err?.diag?.stage || 'UNKNOWN_STAGE';
  const msg = err?.message || String(err || 'Unknown failure');
  const lines = [
    `[AI-DIAG]`,
    `code: ${code}`,
    `stage: ${stage}`,
    `orderId: ${meta.orderId || 'N/A'}`,
    `account: ${meta.accountKey || 'N/A'}${meta.accountPhone ? ` (${meta.accountPhone})` : ''}`,
    `sender: ${meta.senderName || 'N/A'} (${meta.isForwarded ? 'forwarded' : 'boss-direct'})`,
    ...(meta.cartLink ? [`cart: ${String(meta.cartLink).slice(0, 180)}`] : []),
    ...(meta.addressSummary ? [`address: ${String(meta.addressSummary).replace(/\s+/g, ' ').slice(0, 160)}`] : []),
    ...(err?.diag?.httpStatus ? [`httpStatus: ${err.diag.httpStatus}`] : []),
    ...(err?.diag?.swiggyStatusCode !== undefined ? [`swiggyStatusCode: ${err.diag.swiggyStatusCode}`] : []),
    ...(err?.diag?.swiggyMessage ? [`swiggyMsg: ${err.diag.swiggyMessage}`] : []),
    ...(err?.diag?.placedOrderId ? [`placedOrderId: ${err.diag.placedOrderId}`] : []),
    ...(err?.diag?.intentProblems?.length ? [`intentProblems: ${err.diag.intentProblems.join(' | ')}`] : []),
    ...(err?.diag?.tried?.length ? [`tried: ${err.diag.tried.join(', ')}`] : []),
    ...(err?.diag?.rawSnippet ? [`raw: ${String(err.diag.rawSnippet).replace(/\s+/g, ' ').slice(0, 320)}`] : []),
    `error: ${msg}`,
    `time: ${new Date().toISOString()}`
  ];

  const stackFirstLine = (err?.stack || '').split('\n').slice(1, 3).map(s => s.trim()).filter(Boolean).join(' | ');
  if (stackFirstLine) lines.push(`at: ${stackFirstLine}`);

  return `<blockquote>${escapeHtml(lines.join('\n'))}</blockquote>`;
}

export async function sendBossDiagnosticError(ctxOrTelegram, chatId, err, meta = {}) {
  console.error('[AI-DIAG]', meta, err);
  const text = formatBossDiagnosticErrorMessage(err, meta);
  const tg = ctxOrTelegram?.telegram || ctxOrTelegram;
  if (tg && chatId) {
    return tg.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => null);
  }
  return null;
}

export function extractForwardSenderInfo(msg) {
  if (!msg) return null;

  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === 'user' && origin.sender_user) {
      const u = origin.sender_user;
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${u.id}`;
      return {
        isForwarded: true,
        senderKey: `tg_${u.id}`,
        senderUserId: u.id,
        senderName: fullName,
        senderUsername: u.username || ''
      };
    }
    if (origin.type === 'hidden_user') {
      const name = String(origin.sender_user_name || 'Customer').trim();
      return {
        isForwarded: true,
        senderKey: `name_${name.toLowerCase()}`,
        senderUserId: null,
        senderName: name,
        senderUsername: ''
      };
    }
    if (origin.type === 'chat' && origin.sender_chat) {
      const ch = origin.sender_chat;
      const title = String(ch.title || ch.username || `Chat ${ch.id}`).trim();
      return {
        isForwarded: true,
        senderKey: `chat_${ch.id}`,
        senderUserId: ch.id,
        senderName: title,
        senderUsername: ch.username || ''
      };
    }
    if (origin.type === 'channel' && origin.chat) {
      const ch = origin.chat;
      const title = String(ch.title || ch.username || `Channel ${ch.id}`).trim();
      return {
        isForwarded: true,
        senderKey: `chan_${ch.id}`,
        senderUserId: ch.id,
        senderName: title,
        senderUsername: ch.username || ''
      };
    }
  }

  if (msg.forward_from) {
    const u = msg.forward_from;
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${u.id}`;
    return {
      isForwarded: true,
      senderKey: `tg_${u.id}`,
      senderUserId: u.id,
      senderName: fullName,
      senderUsername: u.username || ''
    };
  }

  if (msg.forward_sender_name) {
    const name = String(msg.forward_sender_name).trim();
    return {
      isForwarded: true,
      senderKey: `name_${name.toLowerCase()}`,
      senderUserId: null,
      senderName: name,
      senderUsername: ''
    };
  }

  if (msg.forward_from_chat) {
    const ch = msg.forward_from_chat;
    const title = String(ch.title || ch.username || `Chat ${ch.id}`).trim();
    return {
      isForwarded: true,
      senderKey: `chat_${ch.id}`,
      senderUserId: ch.id,
      senderName: title,
      senderUsername: ch.username || ''
    };
  }

  return null;
}

export function resolveOrderSenderInfo(msg, fromUser) {
  const fwd = extractForwardSenderInfo(msg);
  if (fwd) return fwd;

  const u = fromUser || msg?.from || {};
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `Boss ${u.id || ''}`.trim() || 'Boss';
  return {
    isForwarded: false,
    senderKey: `boss_self_${u.id || 'main'}`,
    senderUserId: u.id || null,
    senderName: fullName,
    senderUsername: u.username || ''
  };
}

export function looksLikeBossOrderInput(rawText = '', location = null) {
  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    return true;
  }
  const t = String(rawText || '').trim();
  if (!t || t.startsWith('/')) return false;
  // Never treat pure tracking links as order input
  if (isOfficialSwiggyTrackingUrl(t) || /r\.swiggy\.com.*\/track\//i.test(t)) {
    return false;
  }

  if (/https?:\/\/[^\s]*(swiggy\.com|swig\.gy|onelink\.me|maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(t)) {
    return true;
  }
  if (/save my address on swiggy|address\s*:|flat\s*no|house\s*no|latitude\s*:/i.test(t)) {
    return true;
  }
  if (/\b\d{6}\b/.test(t) && t.length >= 25 && /,/.test(t)) {
    return true;
  }
  if (isValidCartInput(t)) {
    return true;
  }
  return false;
}

export function truncateDisplayField(rawText, maxChars = 90) {
  const clean = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(8, maxChars - 3)).trim()}...`;
}

export function safeTelegramCaption(htmlText, maxLen = 1000) {
  const str = String(htmlText || '');
  if (str.length <= maxLen) return str;
  // Strip HTML safely only if extreme fallback needed so no broken `<b` tag ever occurs
  const plain = str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  return `${plain.slice(0, maxLen - 4).trim()}...`;
}

// Preserves bank-signed merchant UPI URIs (`sign=...`) 100% byte-for-byte intact while sanitizing unsigned `pn`/`tn` per NPCI UPI 2.0 spec (`<= 30` clean ASCII chars) so giant/Unicode names NEVER bloat QR density!
export function findIncompleteForwardedOrder(db, senderInfo, incomingHint = null) {
  if (!db?.orders || !senderInfo) return null;

  // If the incoming message ALREADY carries BOTH Cart + Address, start a brand-new independent Order immediately!
  if (incomingHint && incomingHint.hasCart && incomingHint.hasAddress) {
    return null;
  }

  const candidates = Object.values(db.orders).filter(o => {
    if (!o || o.isForwardedOrder !== true) return false;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) return false;
    if (['AUTO_SELECTING', 'NEED_ACCOUNT', 'BILL_READY', 'QR_GENERATED', 'PAID_CONFIRMED'].includes(o.cardStage)) {
      return false;
    }
    // A rescue card older than 30 minutes no longer pairs with new forwards —
    // its links have almost certainly expired, so start a clean order instead.
    if (o.cardStage === 'FETCH_FAILED') {
      const failedAt = new Date(o.fetchFailedAt || o.createdAt || 0).getTime();
      if (Number.isFinite(failedAt) && Date.now() - failedAt > 30 * 60 * 1000) return false;
    }
    // CRITICAL 10x MULTI-ORDER FIX: Once an order has BOTH Cart & Address (or pending slots), its intake is 100% COMPLETE —
    // NEVER overwrite it when Boss shares the 2nd, 3rd, ..., 10th order!
    const hasCartNow = Boolean(o.cart || o._pendingCartSlot);
    const hasAddrNow = Boolean(o.address || o._pendingAddrSlot);
    if (hasCartNow && hasAddrNow) return false;

    if (!senderInfo.isForwarded) {
      return o.isDirectBossOrder === true && String(o.fwdSenderKey) === String(senderInfo.senderKey);
    }
    if (o.isDirectBossOrder === true) return false;

    if (senderInfo.senderUserId && o.fwdSenderUserId) {
      return String(o.fwdSenderUserId) === String(senderInfo.senderUserId);
    }
    return String(o.fwdSenderKey || '').toLowerCase() === String(senderInfo.senderKey || '').toLowerCase();
  });

  if (candidates.length === 0) return null;

  // Sort FIFO oldest-first (`createdAt ASC`) so rapid batches (`Cart1..Cart10` then `Addr1..Addr10`) pair 1-for-1 cleanly!
  candidates.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  if (incomingHint) {
    if (incomingHint.hasCart && !incomingHint.hasAddress) {
      if (incomingHint.primaryCartUrl) {
        const exactSameCart = candidates.find(o => (o.cart || o._pendingCartSlot) === incomingHint.primaryCartUrl);
        if (exactSameCart) return exactSameCart;
      }
      return candidates.find(o => !o.cart && !o._pendingCartSlot && Boolean(o.address || o._pendingAddrSlot)) || null;
    }
    if (incomingHint.hasAddress && !incomingHint.hasCart) {
      return candidates.find(o => !o.address && !o._pendingAddrSlot && Boolean(o.cart || o._pendingCartSlot)) || null;
    }
  }

  return candidates[0];
}

export async function deleteOrderBotMessages(telegram, chatId, order, { includeQr = false } = {}) {
  if (!telegram || !chatId || !order) return;
  const ids = new Set();
  if (order.activeCardMessageId) ids.add(order.activeCardMessageId);
  if (Array.isArray(order.trackedCardMessageIds)) {
    for (const mid of order.trackedCardMessageIds) {
      if (mid) ids.add(mid);
    }
  }
  if (includeQr) {
    if (order.activeQrMessageId) ids.add(order.activeQrMessageId);
    if (Array.isArray(order.trackedQrMessageIds)) {
      for (const qid of order.trackedQrMessageIds) {
        if (qid) ids.add(qid);
      }
    }
  }

  await Promise.all(
    Array.from(ids).map(msgId => telegram.deleteMessage(chatId, msgId).catch(() => {}))
  );

  order.activeCardMessageId = null;
  order.trackedCardMessageIds = [];
  if (includeQr) {
    order.activeQrMessageId = null;
    order.trackedQrMessageIds = [];
  }
}

// Helper: try to edit the existing payment QR message in-place to show tracking link (per user request: payment message edit hokar usme link ajaye)
async function tryEditForwardedPaymentMessageWithTracking(telegram, chatId, order) {
  if (!telegram || !chatId || !order?.activeQrMessageId) return false;
  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  const swiggyId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  const restName = String(order.restaurantName || 'Swiggy Order').trim();
  const senderName = String(order.fwdSenderName || order.userName || 'Customer').trim();
  const otp = String(order.deliveryOtp || '').trim();
  const amt = Number(order.finalPayable || order.finalTotal || 0);

  let caption = '';
  if (trackingUrl) {
    caption = `\u2705 <b>PAYMENT SUCCESS \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (senderName ? `\uD83D\uDC64 <b>For:</b> ${escapeHtml(senderName)}\n` : '') +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      (order.etaMinutes ? `\u23F1\uFE0F <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min\n` : '') +
      (otp ? `\uD83D\uDD22 <b>Delivery OTP:</b> <code>${escapeHtml(otp)}</code>\n` : '') +
      `\n\uD83D\uDD17 <b>Tracking Link:</b>\n<a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingUrl)}</a>\n\n` +
      `<i>Payment verified on Swiggy \u2014 tap tracking to follow rider live.</i>`;
  } else {
    caption = `\u2705 <b>PAYMENT SUCCESS \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      `\n<i>\u2713 Payment verified on Swiggy. Tracking link will appear here automatically \u2014 or tap \"I have paid\" if delayed.</i>`;
  }

  const rows = [];
  if (trackingUrl) rows.push([Markup.button.url('\uD83D\uDD17 Open Swiggy Tracking', trackingUrl)]);
  if (otp) rows.push([Markup.button.callback(`\uD83D\uDCCB Copy OTP ${otp}`, `copy_otp_${order.id}`)]);
  // Per user request: after auto-edit, I-have-paid / fwd_check_paid button disappears (gayab) — only tracking/OTP remain
  const kb = rows.length ? Markup.inlineKeyboard(rows) : { reply_markup: { inline_keyboard: [] } };

  try {
    await telegram.editMessageCaption(chatId, order.activeQrMessageId, undefined, caption, { parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  try {
    await telegram.editMessageText(caption, { chat_id: chatId, message_id: order.activeQrMessageId, parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  return false;
}


function buildSenderHeaderLine(order) {
  const senderLabel = escapeHtml(order.fwdSenderName || order.userName || 'Customer');
  const uname = order.fwdSenderUsername ? ` (@${escapeHtml(order.fwdSenderUsername)})` : '';
  const profileTag = order.fwdSenderUserId
    ? `<a href="tg://user?id=${order.fwdSenderUserId}">${senderLabel}</a>${uname}`
    : `<b>${senderLabel}</b>${uname}`;

  if (order.isDirectBossOrder) {
    return `◉ <b>Order For:</b> ${profileTag}`;
  }
  return `◉ <b>Forwarded From:</b> ${profileTag}`;
}

export function buildTelegramUserBillConfirmationCard(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const itemLines = items.map((item) => {
    const quantity = Number(item.qty || item.quantity || 1);
    const lineTotal = Number(item.lineTotal || (Number(item.price || 0) * quantity) || 0);
    return `▪ ${quantity} × ${escapeHtml(item.name || 'Item')}${lineTotal > 0 ? `: ₹${lineTotal}` : ''}`;
  });
  const address = order?.addressDetails?.address || order?.address || 'Verified delivery address';
  const sub = Number(order?.subtotal || 0);
  const trade = Number(order?.tradeDiscountTotal || 0);
  const disc = Number(order?.discountAmount || 0);
  const fc = Number(order?.freeCashApplied || 0);
  const oneFee = Number(order?.swiggyOneMembershipFee || 0);
  const del = Number(order?.deliveryFee || 0);
  const pack = Number(order?.packingCharges || 0);
  const taxes = Number(order?.taxesAndCharges || 0);
  const computedTotal = Math.max(0, Math.round((sub - trade - disc - fc + oneFee + del + pack + taxes) * 100) / 100);
  let total = Number(order?.finalPayable ?? order?.finalTotal ?? order?.subtotal ?? 0);
  if (!total || (trade + disc + fc > 0 && total >= sub && computedTotal < total)) {
    total = computedTotal;
    if (order) order.finalPayable = total;
  }
  const billLines = [
    `Restaurant: <b>${escapeHtml(order?.restaurantName || 'Swiggy Order')}</b>`,
    `Deliver to: ${escapeHtml(address)}`,
    order?.addressDetails?.city ? `City: ${escapeHtml(order.addressDetails.city)}` : '',
    '',
    '<b>Bill details</b>',
    `Items subtotal: ₹${Number(order?.subtotal || 0)}`,
    Number(order?.tradeDiscountTotal || 0) > 0 ? `Restaurant offer: −₹${Number(order.tradeDiscountTotal)}` : '',
    order?.couponCode && Number(order?.discountAmount || 0) > 0
      ? `Coupon ${escapeHtml(order.couponCode)}: −₹${Number(order.discountAmount)}`
      : '',
    Number(order?.freeCashApplied || 0) > 0 ? `Swiggy Money / Free Cash: −₹${Number(order.freeCashApplied)}` : '',
    Number(order?.freeDeliveryDiscount || 0) > 0 ? `Free-delivery saving: −₹${Number(order.freeDeliveryDiscount)}` : '',
    `Delivery: ${Number(order?.deliveryFee || 0) > 0 ? `₹${Number(order.deliveryFee)}` : 'FREE'}`,
    Number(order?.packingCharges || 0) > 0 ? `Packing: ₹${Number(order.packingCharges)}` : '',
    Number(order?.taxesAndCharges || 0) > 0 ? `GST and other charges: ₹${Number(order.taxesAndCharges)}` : '',
    Number(order?.totalSavings || 0) > 0 ? `Total savings: ₹${Number(order.totalSavings)}` : '',
    `<b>Total to pay: ₹${total}</b>`,
    '',
    '<i>Approving sends the official Swiggy payment details to you. If a Swiggy request already exists, the same request is reused; a button tap alone never marks payment complete.</i>'
  ].filter(Boolean);
  if (itemLines.length) {
    billLines.splice(3, 0, '<b>Items</b>', ...itemLines);
  }

  const text =
    `i <b>Please check the delivery address and final bill.</b>\n\n` +
    `<b>Order #${escapeHtml(order?.id || '')} — Approval pending</b>\n\n` +
    billLines.join('\n');
  const keyboard = Markup.inlineKeyboard([
    [{ text: '✓ Approve bill', callback_data: `user_approve_bill_${order.id}`, style: 'success' }],
    [{ text: '! Something is wrong', callback_data: `user_bill_issue_${order.id}`, style: 'danger' }]
  ]);
  return { text, keyboard };
}

// ---------------------------------------------------------------------------
// Customer identity + one-time bill summary
// ---------------------------------------------------------------------------
// Resolve the customer's Telegram chat for an order. Boss's own orders and
// orders that only exist in the Boss chat return '' so a summary is never sent
// back to the Boss by accident.
export function resolveCustomerChatId(order, bossIds = []) {
  const target = String(order?.fwdSenderUserId || order?.userChatId || order?.userId || '').trim();
  if (!target) return '';
  if (order?.isDirectBossOrder || order?.isForwardedOrder) return '';
  if (order?.isCustomerSubmitted === true) return target;
  const bossSet = new Set((bossIds || []).map(id => String(id)));
  if (bossSet.has(target)) return '';
  if (order?.bossChatId && String(order.bossChatId) === target) return '';
  return target;
}

// Who must see the max-discount bill summary?
//   * Boss forwarded the message  -> only the Bot (Boss chat): the customer may
//     not even be a bot user, and Boss is the one placing the order.
//   * Customer tapped Send to Beta -> BOTH: the customer confirms the bill in
//     their chat, the Boss sees the same bill on the order card.
export function resolveBillSummaryAudience(order, db = null) {
  const liveDb = db || getDb();
  const bossIds = [...new Set((liveDb?.config?.bossIds || []).filter(Boolean).map(String))];
  const bossIntake = order?.isForwardedOrder === true || order?.isDirectBossOrder === true;
  if (bossIntake) return 'BOSS_ONLY';
  return resolveCustomerChatId(order, bossIds) ? 'CUSTOMER_AND_BOSS' : 'BOSS_ONLY';
}

export function shouldSendSummaryToCustomer(order, db = null) {
  return resolveBillSummaryAudience(order, db) === 'CUSTOMER_AND_BOSS';
}

// Sends the max-discount bill summary to the customer EXACTLY ONCE.
// After this the order waits in `APPROVAL_PENDING`: the customer taps
// "Approve bill" and only then are the official Swiggy payment details sent.
export async function sendBillSummaryToCustomerOnce(telegram, order, { db = null, force = false, deliver = null, onMessageSent = null } = {}) {
  if (!telegram?.sendMessage || !order?.id) return { sent: false, reason: 'no-telegram' };

  const liveDb = db || getDb();
  const audience = resolveBillSummaryAudience(order, liveDb);
  // A Boss-forwarded order must never message the customer — the summary lives
  // on the Boss card in the bot chat.
  if (audience !== 'CUSTOMER_AND_BOSS') return { sent: false, reason: 'boss-only' };
  const customerId = resolveCustomerChatId(order, liveDb?.config?.bossIds || []);
  if (!customerId) return { sent: false, reason: 'no-customer-chat' };

  if (!force && (order.billSummarySentAt || order.billApprovedByUser)) return { sent: false, reason: 'already-sent' };
  if (['COMPLETED', 'CANCELLED', 'REJECTED', 'PAYMENT_PENDING'].includes(order.status)) return { sent: false, reason: 'not-awaiting-review' };
  const hasVerifiedZeroBill = Boolean(
    order.swiggyVerified &&
    Number(order.subtotal || order.itemTotal || 0) > 0 &&
    order.finalPayable !== null &&
    order.finalPayable !== undefined &&
    Number(order.finalPayable) === 0
  );
  if (Number(order.finalPayable || 0) <= 0 && !hasVerifiedZeroBill) return { sent: false, reason: 'bill-not-ready' };
  if (!order.selectedAccount) return { sent: false, reason: 'no-account' };

  const summary = buildTelegramUserBillConfirmationCard({ ...order, userId: customerId });

  // When the customer already has a single live card, the caller can render the
  // summary into that card instead of sending another chat bubble. `deliver`
  // returns false when it could not update the card -> normal message is sent.
  let deliveredOnCard = false;
  if (typeof deliver === 'function' && !force) {
    try {
      deliveredOnCard = (await deliver(summary)) === true;
    } catch {
      deliveredOnCard = false;
    }
  }
  if (deliveredOnCard) {
    order.status = 'APPROVAL_PENDING';
    order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
    order.billSummarySentAt = new Date().toISOString();
    order.billSummaryAutoSent = true;
    order.billSummaryDelivery = 'SINGLE_CARD';
    order.billSummaryAudience = audience;
    delete order.billSummarySendError;
    const cardDb = getDb();
    cardDb.orders[order.id] = order;
    saveDb(cardDb);
    return { sent: true, customerId, viaCard: true };
  }

  let sentMsg = null;
  try {
    sentMsg = await telegram.sendMessage(customerId, summary.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...summary.keyboard
    });
  } catch (error) {
    order.billSummarySendError = String(error?.message || error).slice(0, 200);
    const failDb = getDb();
    if (failDb.orders?.[order.id]) {
      failDb.orders[order.id].billSummarySendError = order.billSummarySendError;
      saveDb(failDb);
    }
    return { sent: false, reason: 'telegram-error', error: order.billSummarySendError };
  }

  if (sentMsg?.message_id) {
    order.billSummaryMessageId = sentMsg.message_id;
    order.userChatId = order.userChatId || customerId;
    if (typeof onMessageSent === 'function') {
      try { onMessageSent(sentMsg); } catch {}
    }
  }
  order.status = 'APPROVAL_PENDING';
  order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
  order.billSummarySentAt = new Date().toISOString();
  order.billSummaryAutoSent = true;
  order.billSummaryDelivery = 'MESSAGE';
  order.billSummaryAudience = audience;
  delete order.billSummarySendError;

  const freshDb = getDb();
  freshDb.orders[order.id] = order;
  saveDb(freshDb);
  return { sent: true, customerId, messageId: sentMsg?.message_id || null };
}

function summarizeAddressPreview(order) {
  const ad = order.addressDetails || parseAddressDetails(order.address);
  if (!ad) {
    // Never echo an entire pasted message back as the address. A bare link is
    // summarised honestly instead of leaking the chat text next to it.
    const raw = String(order.address || '').trim();
    if (isAddressShareUrl(raw)) return '<i>Address link received — fetching address from Swiggy…</i>';
    if (raw && raw.length <= 120 && !/order\s*account|https?:\/\//i.test(raw)) return escapeHtml(raw);
    return '<i>Not verified yet</i>';
  }
  if (ad.unresolvableShortLink) return '<i>Address link could not be resolved — send a fresh address link or GPS pin</i>';
  const parts = [];
  if (ad.city) parts.push(`<b>${escapeHtml(ad.city)}</b>`);
  if (ad.name) parts.push(escapeHtml(ad.name));
  if (ad.address) parts.push(escapeHtml(ad.address.replace(/\s+/g, ' ').trim()));
  if (ad.lat && ad.lng) parts.push(`(${ad.lat}, ${ad.lng})`);
  return parts.join(' • ') || '<i>Not verified yet</i>';
}

function summarizeCartPreview(order) {
  if (order.restaurantName) {
    const cnt = order.items?.reduce((s, it) => s + Number(it.qty || it.quantity || 1), 0) || 0;
    const sub = order.subtotal ? ` • ₹${order.subtotal}` : '';
    return `<b>${escapeHtml(order.restaurantName)}</b>${cnt ? ` (${cnt} item${cnt > 1 ? 's' : ''}${sub})` : ''}`;
  }
  return `<code>${escapeHtml(String(order.cart || '').slice(0, 90))}</code>`;
}

function normalizeRecipientMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function hasVerifiedDeliveryLocation(order) {
  const address = String(order?.addressDetails?.address || '').trim();
  const lat = Number(order?.addressDetails?.lat);
  const lng = Number(order?.addressDetails?.lng);
  return Boolean(
    address.length >= 8 && !order?.addressDetails?.unresolvableShortLink &&
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= 5.5 && lat <= 38.5 && lng >= 67 && lng <= 99
  );
}

function hasVerifiedDeliveryContact(order) {
  return Boolean(normalizeRecipientMobile(order?.addressDetails?.mobile));
}

export function getReadyOrdersWaitingForAccount(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      (o.cardStage === 'NEED_ACCOUNT' || (!o.selectedAccount && o.cardStage !== 'AUTO_SELECTING')) &&
      Boolean(o.cart) &&
      hasVerifiedDeliveryLocation(o) &&
      hasVerifiedDeliveryContact(o)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

export function getBillReadyOrdersWaitingForQr(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      !(o.status === 'APPROVAL_PENDING' && !o.billApprovedByUser) &&
      o.cardStage === 'BILL_READY' &&
      Boolean(o.selectedAccount) &&
      hasVerifiedDeliveryLocation(o) &&
      hasVerifiedDeliveryContact(o) &&
      Number(o.finalPayable || 0) > 0
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

export function getActiveQrOrdersWaitingForPayment(db) {
  return Object.values(db?.orders || {})
    .filter(o =>
      o &&
      o.isForwardedOrder === true &&
      !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      o.cardStage === 'QR_GENERATED' &&
      Boolean(o.selectedAccount) &&
      Boolean(o.pendingSwiggyOrderId)
    )
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

// Honest one-liner about ID rotation ("is order par kitni ID use ho chuki,
// agli fresh ID kaun si hai"). Never throws — a card must always render.
function buildRotationLine(order) {
  try {
    const s = rotationSummary(order);
    if (!s || !s.total) return '';
    const current = order?.selectedAccount
      ? `<code>${escapeHtml(String(order.orderAccount || order.selectedAccount))}</code>`
      : '<i>koi nahi</i>';
    const nextBit = s.nextPhone && String(s.nextPhone) !== String(order?.orderAccount || '')
      ? ` · agla: <code>${escapeHtml(String(s.nextPhone))}</code>`
      : '';
    return `\n⚡ <b>ID:</b> ${current} · fresh ${s.remaining}/${s.total}${nextBit}`;
  } catch {
    return '';
  }
}

export function buildForwardedOrderCardView(order, db, formatOrderBodyFn) {
  const senderLine = buildSenderHeaderLine(order);
  const hasAddress = Boolean(order.address) && hasVerifiedDeliveryLocation(order);
  const hasDeliveryContact = hasVerifiedDeliveryContact(order);
  const hasCart = Boolean(order.cart);
  const directSwiggyUrl = getStoredSwiggyTrackingUrl(order);
  const cancelBtn = Markup.button.callback('✕ Cancel Order', `fwd_cancel_${order.id}`);

  // Stage 0 (Lazy Boss rescue): the forward could not be read. One card, one
  // retry tap — the original forwarded text is already stored on the order.
  if (order.cardStage === 'FETCH_FAILED' && !order.pendingSwiggyOrderId && order.status !== 'COMPLETED') {
    const rescue = buildLazyRescueCard(order, { reason: order.fetchError || '', escapeHtml });
    if (rescue.missing.length > 0 || order.fetchError) {
      return { text: rescue.text, keyboard: { reply_markup: { inline_keyboard: rescue.buttons } } };
    }
  }

  // Stage 4A: show only links returned by Swiggy (or explicitly supplied by the boss).
  if (order.status === 'COMPLETED' && directSwiggyUrl) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const swiggyIdLine = order.swiggyOrderId
      ? `↳ <b>Swiggy order ID:</b> <code>${escapeHtml(String(order.swiggyOrderId))}</code>\n`
      : '';
    const liveStatusLine = order.liveOrderStatus
      ? `↳ <b>Status:</b> ${escapeHtml(order.liveOrderStatus)}${order.etaMinutes ? ` · <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min` : ''}`
      : '';
    const riderLine = order.deliveryBoyName
      ? `\n↳ <b>Delivery partner:</b> ${escapeHtml(order.deliveryBoyName)}${order.deliveryBoyMobile ? ` (<a href="tel:${escapeHtml(order.deliveryBoyMobile)}">${escapeHtml(order.deliveryBoyMobile)}</a>)` : ''}`
      : '';
    const deliveryOtpLine = order.deliveryOtp
      ? `\n⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';

    const text =
      `✓ <b>ORDER PAID &amp; CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n` +
      `${swiggyIdLine}` +
      `${liveStatusLine}${riderLine}${deliveryOtpLine}\n\n` +
      `${bodyHtml}\n\n` +
      `↗ <b>Swiggy tracking link:</b> <a href="${escapeHtml(directSwiggyUrl)}">Open link from Swiggy</a>`;

    const buttons = [
      [Markup.button.url('↗ Open Swiggy tracking', directSwiggyUrl)],
      [Markup.button.callback('🔗 Extract Delivery Link (All IDs)', `fwd_extract_all_${order.id}`)],
      [Markup.button.callback('⌕ Add delivery OTP', `boss_delivery_otp_${order.id}`)],
      [cancelBtn]
    ];
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // Stage 4B (Screen 05): Paid Confirmed, Tracking Delayed -> Retry tracking ONLY, NEVER create 2nd QR!
  if (order.status === 'COMPLETED' && !directSwiggyUrl) {
    const paidAmt = Number(order.finalTotal || order.finalPayable || 0);
    const statusLine = order.liveOrderStatus ? `\n● <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}` : '';
    const etaLine = order.etaMinutes ? `\n◷ <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min` : '';
    const riderLine = order.deliveryBoyName
      ? `\n◉ <b>Delivery partner:</b> ${escapeHtml(order.deliveryBoyName)}${order.deliveryBoyMobile ? ` (<a href="tel:${escapeHtml(order.deliveryBoyMobile)}">${escapeHtml(order.deliveryBoyMobile)}</a>)` : ''}`
      : '';
    const deliveryOtpLine = order.deliveryOtp
      ? `\n⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';
    const text =
      `✓ <b>Payment confirmed: ₹${paidAmt}</b>\n` +
      `<i>No second charge will be requested.</i>\n\n` +
      `<b>#${escapeHtml(order.id)} · ORDER SUMMARY</b>\n` +
      `${senderLine}\n\n` +
      `▣ <b>${escapeHtml(order.restaurantName || 'Swiggy Order')}</b>` +
      `${statusLine}${etaLine}${riderLine}\n` +
      `<i>Swiggy ka tracking link aa raha hai — yehi card update hoga jaise hi Swiggy publish karega (aam taur par kuch second).</i>` +
      `${deliveryOtpLine}\n\n` +
      `<b>Payment is final. Only tracking will be retried.</b>\n` +
      `<i>No replacement payment QR will be created.</i>`;

    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('↻ Retry Swiggy tracking', `fwd_retry_track_${order.id}`)],
        [Markup.button.callback('🔗 Extract Delivery Link (All IDs)', `fwd_extract_all_${order.id}`)],
        [Markup.button.callback('⌕ Add delivery OTP', `boss_delivery_otp_${order.id}`)]
      ])
    };
  }

  if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
    const text =
      `◷ <b>WAITING FOR CUSTOMER BILL APPROVAL (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `${formatOrderBodyFn(order, true)}\n\n` +
      `<i>The verified bill summary was sent in Telegram. Payment details will be sent to the customer after approval.</i>`;
    return { text, keyboard: Markup.inlineKeyboard([[cancelBtn]]) };
  }

  // Stage 3: Account Selected & Live Bill Fetched -> [Generate QR] [Paid] [Parallel Batch Buttons] [Re-Scan Offers] [Switch Account] [Cancel]
  if (hasAddress && hasDeliveryContact && hasCart && (order.cardStage === 'BILL_READY' || order.cardStage === 'QR_GENERATED')) {
    const bodyHtml = formatOrderBodyFn(order, true);
    const offerNotes = [];
    if (order.selectedAccount) {
      const accBadge = order.selectedAccountZeroOrders
        ? `+ <b>0-Order Swiggy ID</b>`
        : `● <b>Free Swiggy ID (0 Active Orders)</b>`;
      offerNotes.push(
        `◎ <b>Auto-Matched Account:</b> <code>${escapeHtml(String(order.orderAccount || order.selectedAccount))}</code> (${accBadge})`
      );
    }
    if (order.eventsClaimSummary) {
      const sum = order.eventsClaimSummary;
      // CHAAR offer — user ko bhi har ek ka status (har ek ₹50). Purane orders
      // jinme sirf BF/LN hai, unke liye neeche fallback rehta hai.
      const four = sum.fourOffer || null;
      if (four) {
        const mark = (st) => {
          const v = String(st || '').toUpperCase();
          if (v === 'CLAIMED' || v === 'ALREADY_CLAIMED') return '✅';
          if (v === 'PRE_LOCKED') return '⏳';
          return '❌';
        };
        const trackRows = OFFER_TRACKS
          .map((t, i) => `${i + 1}. ${t.emoji} ${t.bossLabel} — ${mark(four[t.key])} ₹50`)
          .join('\n');
        const claimedCount = Number(four.claimedCount || 0);
        offerNotes.push(
          `🎁 <b>Saare ${OFFER_TRACKS.length} offer — har ek ₹50:</b>\n` +
          `${trackRows}\n` +
          `📊 <b>${claimedCount}/${four.total || OFFER_TRACKS.length} claimed</b> · ₹${claimedCount * 50} pakka / ₹${(four.total || OFFER_TRACKS.length) * 50} possible`
        );
      }
      const bfMsg = sum.breakfastMsg;
      const lnMsg = sum.lateNightMsg;
      if (!four && bfMsg) offerNotes.push(`• <b>Breakfast:</b> ${escapeHtml(bfMsg)}`);
      if (!four && lnMsg) offerNotes.push(`◷ <b>Late Night:</b> ${escapeHtml(lnMsg)}`);
    }
    if (Number(order.walletSplitPayAmount || 0) > 0) {
      offerNotes.push(`₹ <b>Wallet Split-Pay Ready:</b> ₹${order.walletSplitPayAmount} Swiggy Money auto-deducts from UPI QR!`);
    }
    if (order.offerDiagnostics) {
      offerNotes.push(`i <i>${escapeHtml(order.offerDiagnostics)}</i>`);
    }
    const offerStrip = offerNotes.length > 0 ? `\n\n${offerNotes.join('\n')}` : '';
    const qrStatusNote = order.cardStage === 'QR_GENERATED'
      ? `\n\n● <b>Official Swiggy Dynamic QR Active</b> (Swiggy Order <code>${escapeHtml(String(order.pendingSwiggyOrderId || ''))}</code> • Auto-detecting payment every 5s or tap <b>Paid</b>)`
      : '';
    // Lazy Boss mode: ONE obvious tap on top of the card. It is the explicit
    // confirmation step — nothing is charged before Boss (or the customer on
    // their own order) taps it.
    const isBossIntake = Boolean(order.isForwardedOrder || order.isDirectBossOrder);
    const lazyHint = isBossIntake && order.cardStage !== 'QR_GENERATED'
      ? `\n\n⚡ <i>Ek tap: ✅ Confirm → official Swiggy QR → payment ke baad tracking link khud aa jayega.</i>`
      : '';
    const text =
      `▤ <b>ORDER BILL READY (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `${bodyHtml}${offerStrip}${buildRotationLine(order)}${qrStatusNote}${lazyHint}`;

    const readyForQrCount = getBillReadyOrdersWaitingForQr(db).length;
    const activeQrCount = getActiveQrOrdersWaitingForPayment(db).length;
    const rows = [];
    if (isBossIntake && order.cardStage !== 'QR_GENERATED') {
      rows.push(buildLazyConfirmRow(order));
    }
    rows.push([
      Markup.button.callback(
        order.cardStage === 'QR_GENERATED' ? '↻ Regenerate Swiggy QR' : '□ Generate QR',
        `fwd_gen_qr_${order.id}`
      ),
      Markup.button.callback('✓ Paid', `fwd_check_paid_${order.id}`)
    ]);
    if (readyForQrCount >= 2 && order.cardStage === 'BILL_READY') {
      rows.push([
        Markup.button.callback(
          `! Generate All ${readyForQrCount} Ready QRs in Parallel`,
          `fwd_parallel_qrs_${order.id}`
        )
      ]);
    }
    if (activeQrCount >= 2) {
      rows.push([
        Markup.button.callback(
          `✓ Verify All ${activeQrCount} Active Payments Now`,
          `fwd_check_all_paid`
        )
      ]);
    }
    // INSTANT ID ROTATION: one tap = next unused ID, no offer scan (each account
    // has the same offers), so the bill comes back immediately.
    rows.push([
      Markup.button.callback('⚡ Next ID (instant)', `fwd_next_acc_${order.id}`),
      Markup.button.callback('👤 Choose ID', `fwd_pick_acc_${order.id}`)
    ]);
    rows.push([
      Markup.button.callback('▣ Re-Scan Max Offer', `fwd_rescan_max_${order.id}`),
      Markup.button.callback('🔄 Change Auto Selection', `fwd_change_auto_sel_${order.id}`)
    ]);
    // ONE panel for every offer/cash/coupon/cart control — Boss AND customer see
    // the same buttons (permission is checked in the handler).
    rows.push([
      Markup.button.callback('🛠 Offer & Cash Panel', `fwd_panel_${order.id}`)
    ]);
    if (order.fwdSenderUserId && !order.isDirectBossOrder && !order.billApprovedByUser && !['APPROVAL_PENDING', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
      rows.push([Markup.button.callback('↑ Send Bill Summary ›', `fwd_send_summary_${order.id}`)]);
    }
    if (!order.pendingSwiggyOrderId && !order.pendingSwiggyUpiUri && !order.realUpiIntentUri && order.cardStage !== 'QR_GENERATED') {
      rows.push([
        Markup.button.callback('✎ Change Cart', `fwd_input_cart_${order.id}`),
        Markup.button.callback('⌖ Change Address', `fwd_input_address_${order.id}`)
      ]);
      rows.push([Markup.button.callback('☎ Change Recipient Mobile', `fwd_input_mobile_${order.id}`)]);
    }
    rows.push([cancelBtn]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  // Stage 2-: auto-selection exhausted. Boss gets ONE retry button that walks
  // the fallback ladder across every logged-in ID — never a manual picker.
  if (hasAddress && hasDeliveryContact && hasCart && order.cardStage === 'NEED_ACCOUNT') {
    const errText = escapeHtml(order.accountSyncError || order.lastAccountError || 'Swiggy ID se live bill nahi bana.');
    const vaultCount = planAccountFallbacks(db?.config?.accounts || {}).length;
    const text =
      `⚠️ <b>BEST SWIGGY ID NAHI MILA (#${escapeHtml(order.id)})</b>\n` +
      `${senderLine}\n\n` +
      `⌖ <b>Address:</b> ${summarizeAddressPreview(order)}\n` +
      `▤ <b>Cart:</b> ${summarizeCartPreview(order)}\n\n` +
      `<b>Reason:</b> <i>${errText}</i>\n` +
      (vaultCount > 0
        ? `<i>Vault me ${vaultCount} logged-in ID available hain — ek tap me sab par try hoga.</i>\n`
        : `<i>Vault me koi logged-in ID nahi hai. Session JSON drop karein.</i>\n`) +
      `\n<i>Cart/address safe hain — dobara forward karne ki zarurat nahi.</i>`;
    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Best ID dobara try karo', lazyActionId('best_id', order.id))],
        [Markup.button.callback('▣ Re-Scan Max Offer', `fwd_rescan_max_${order.id}`)],
        [cancelBtn]
      ])
    };
  }

  // Stage 2A & 2B: Automatic Account Selection by default (No manual picker needed!)
  if (hasAddress && hasDeliveryContact && hasCart) {
    order.cardStage = (order.accountSyncError || order.lastAccountError) ? 'NEED_ACCOUNT' : 'AUTO_SELECTING';
    const errNotice = (order.accountSyncError || order.lastAccountError)
      ? `\n\n⚠️ <b>Dikkat:</b> <i>${escapeHtml(order.accountSyncError || order.lastAccountError)}</i>\n<i>Please resolve the account issue or tap below to retry auto-selection.</i>`
      : '';
    const text =
      `! <b>AUTO-SELECTING BEST 0-ORDER SWIGGY ID (#${escapeHtml(order.id)})...</b>\n` +
      `${senderLine}\n\n` +
      `⌖ <b>Address:</b> ${summarizeAddressPreview(order)}\n` +
      `▤ <b>Cart:</b> ${summarizeCartPreview(order)}\n\n` +
      (order.accountSwitchReason === 'next_id' || order.accountSwitchReason === 'manual_pick' || order.accountSwitchReason === 'auto_retry'
        ? `<i>⚡ Instant ID switch → <code>${escapeHtml(String(order.orderAccount || order.selectedAccount || ''))}</code> · offer scan skip (sab ID par same offers), bill turant ban raha hai…</i>${errNotice}`
        : `<i>› Finding free 0-Order Swiggy ID + applying Maximum Coupon, Item Offers, Free Cash &amp; Free Delivery in parallel...</i>${errNotice}`);
    return {
      text,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback(order.accountSyncError || order.lastAccountError ? '🔄 Retry Auto Selection' : '🔄 Change Auto Selection', `fwd_change_auto_sel_${order.id}`)],
        [Markup.button.callback('⚡ Next ID (instant)', `fwd_next_acc_${order.id}`), Markup.button.callback('👤 Choose ID', `fwd_pick_acc_${order.id}`)],
        [cancelBtn]
      ])
    };
  }

  // Stage 1: Partial Card (Waiting for missing Cart or missing Address)
  order.cardStage = 'COLLECTING';
  const hasAddressText = Boolean(order.addressDetails?.address || order.address);
  const addrStatus = hasAddress
    ? `✓ ${summarizeAddressPreview(order)}`
    : hasAddressText
      ? `! <i>Address text received, but its Indian map location is not verified. Send a precise GPS pin or full street address with area, city and PIN.</i>`
      : `◷ <i>Waiting — send Address link / text / GPS pin</i>`;
  const contactStatus = hasDeliveryContact
    ? `✓ <code>${escapeHtml(normalizeRecipientMobile(order.addressDetails.mobile))}</code>`
    : `! <i>Recipient mobile missing — enter the correct 10-digit number in the address box; account/old numbers are never substituted.</i>`;
  const cartStatus = hasCart
    ? `✓ ${summarizeCartPreview(order)}\n↗ <code>${escapeHtml(String(order.cart).slice(0, 95))}</code>`
    : `◷ <i>Waiting — send Swiggy Cart / Group Order link</i>`;

  const missingItem = !hasAddress
    ? 'verified delivery address / exact GPS pin'
    : (!hasDeliveryContact ? 'recipient’s correct 10-digit mobile' : 'Cart link');
  const actionHint = !hasDeliveryContact && hasAddress && hasCart
    ? `i Use <b>Add Recipient Mobile</b> below and enter the correct 10-digit Indian number.`
    : (order.isDirectBossOrder
        ? `i Use the buttons below or send ${missingItem} in this chat.`
        : `i Forward ${escapeHtml(order.fwdSenderName)}'s ${missingItem}, or enter it with the buttons below.`);

  const errLine = (order.accountSyncError || order.lastAccountError)
    ? `\n⚠️ <b>Notice:</b> <i>${escapeHtml(order.accountSyncError || order.lastAccountError)}</i>\n`
    : '';

  const text =
    `✉ <b>NEW ORDER CARD (#${escapeHtml(order.id)})</b>\n` +
    `${senderLine}\n\n` +
    `⌖ <b>Address:</b>\n${addrStatus}\n` +
    `☎ <b>Recipient mobile:</b> ${contactStatus}\n\n` +
    `▤ <b>Cart:</b>\n${cartStatus}\n\n` +
    errLine +
    `<i>${actionHint}</i>\n` +
    `<i>◈ No account allocated; QR is blocked.</i>`;

  const inputButtons = [];
  if (!hasCart) inputButtons.push(Markup.button.callback('▤ Enter Cart Link', `fwd_input_cart_${order.id}`));
  if (!hasAddress) inputButtons.push(Markup.button.callback('⌖ Add / Correct Address', `fwd_input_address_${order.id}`));
  else if (!hasDeliveryContact) inputButtons.push(Markup.button.callback('☎ Add Recipient Mobile', `fwd_input_mobile_${order.id}`));

  const rows = [];
  if (inputButtons.length) rows.push(inputButtons);
  rows.push([cancelBtn]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export async function postOrReplaceForwardedCard(telegram, chatId, order, db, formatOrderBodyFn, { includeQrDelete = false } = {}) {
  await deleteOrderBotMessages(telegram, chatId, order, { includeQr: includeQrDelete });
  const { text, keyboard } = buildForwardedOrderCardView(order, db, formatOrderBodyFn);
  const sent = await telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard
  });
  order.activeCardMessageId = sent.message_id;
  order.trackedCardMessageIds = [sent.message_id];
  order.bossChatId = chatId;
  order.updatedAt = new Date().toISOString();
  upsertOrder(order.id, order);
  return sent;
}

export async function ingestForwardedContentIntoOrder(order, { rawText = '', location = null } = {}) {
  let updatedCart = false;
  let updatedAddress = false;

  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    if (!isValidIndianDeliveryCoordinates(location.latitude, location.longitude)) {
      return { updatedCart, updatedAddress: false, error: 'Swiggy delivery is India-only. Send a valid Indian delivery pin.' };
    }
    const geo = await reverseGeocodeCoords(location.latitude, location.longitude);
    const formatted = geo?.formattedAddress || `GPS Pin (${location.latitude}, ${location.longitude})`;
    order.address = formatted;
    order.addressOriginalText = formatted;
    order.addressDetails = {
      name: order.fwdSenderName || order.userName || '',
      // A newly supplied pin may be for a different recipient; never carry the old delivery phone over silently.
      mobile: '',
      address: formatted,
      area: geo?.area || '',
      city: geo?.city || '',
      lat: String(location.latitude),
      lng: String(location.longitude)
    };
    updatedAddress = true;
    return { updatedCart, updatedAddress };
  }

  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { updatedCart, updatedAddress };

  const contactMatch = trimmed.match(/^(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?([6-9]\d{4}[\s-]?\d{5})$/);
  if (contactMatch && order.addressDetails?.address) {
    const mobile = contactMatch[1].replace(/\D/g, '');
    order.addressDetails = { ...order.addressDetails, mobile };
    return { updatedCart, updatedAddress: true };
  }

  // Extract forwarded coupon / promo code if present in the message
  const couponMatch = trimmed.match(/(?:coupon|promo|code)\s*[:\-]?\s*([A-Z0-9_-]{3,25})\b/i);
  if (couponMatch && !/^(?:on|off|true|false|none|null|undefined)$/i.test(couponMatch[1])) {
    const extractedCode = couponMatch[1].toUpperCase();
    order.couponCode = extractedCode;
    order.discoveredCoupon = extractedCode;
  }

  const allUrls = extractSharedUrls(trimmed);
  const swiggyUrls = allUrls.filter(u => /(swiggy\.com|swig\.gy|onelink\.me)/i.test(u) && !isOfficialSwiggyTrackingUrl(u) && !/r\.swiggy\.com.*\/track\//i.test(u));
  const mapsUrls = allUrls.filter(u => /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u));

  // URL-FIRST: if the message carries an address share link, delivery data comes
  // from that link only. Text sitting next to the link (order account, receipt,
  // forwarded header, "Address: ..." line) is never used.
  const addressShareUrl = extractAddressShareUrl(trimmed);

  // Pre-extract plain-text street address BEFORE `Promise.all` so links + geocoding run 100% concurrently!
  const textWithoutUrlsEarly = stripSharedLinks(trimmed);
  const earlyPlainAd = addressShareUrl
    ? (parseAddressDetails(textWithoutUrlsEarly, { allowWithUrl: true }) || parseAddressDetails(trimmed, { allowWithUrl: true }))
    : (allUrls.length === 0 && !isValidCartInput(trimmed) && isValidAddressInput(trimmed)
        ? parseAddressDetails(trimmed)
        : textWithoutUrlsEarly.length >= 12 && isValidAddressInput(textWithoutUrlsEarly)
          ? parseAddressDetails(textWithoutUrlsEarly)
          : null);
  const firstAccEarly = earlyPlainAd && (!earlyPlainAd.lat || !earlyPlainAd.lng)
    ? Object.values(getDb()?.config?.accounts || {}).find(a => a?.isLoggedIn && (a.cookies || a.tid || a.token)) || null
    : null;

  // Resolve ALL links + plain-text street address geocoding IN ONE SINGLE PARALLEL BATCH!
  // If `earlyPlainAd?.address` is already extracted from plain text (e.g. `Save my address on Swiggy... Address: ...`),
  // skip external HTTP hop on `onelink.me/JgkQ` (`0ms` instead of `1.9s`!) and reuse `preGeocodedPlainAd` directly!
  const [resolvedSwiggyList, resolvedMapsList, preGeocodedPlainAd] = await Promise.all([
    Promise.all(
      swiggyUrls.map(url => resolveSwiggyLink(url).then(resolved => ({ url, resolved })))
    ),
    Promise.all(mapsUrls.map(mUrl => resolveSwiggyLink(mUrl).then(resolved => ({ mUrl, resolved })))),
    earlyPlainAd && (!earlyPlainAd.lat || !earlyPlainAd.lng)
      ? geocodeAddressDetails(earlyPlainAd).catch(() => earlyPlainAd)
      : Promise.resolve(earlyPlainAd)
  ]);

  for (const { url, resolved } of resolvedSwiggyList) {
    const looksLikeAddressShare =
      resolved?.linkType === 'ADDRESS' ||
      Boolean(resolved?.addressDetails) ||
      (/save my address on swiggy/i.test(trimmed) && !/\/gc\//i.test(url)) ||
      (/(?:swiggy\.onelink\.me|onelink\.me\/jgkq)/i.test(url) && !/\/gc\//i.test(url)) ||
      (/(?:swiggy\.com|swig\.gy).*(?:address|shareaddress)/i.test(url));

    if (looksLikeAddressShare) {
      const ad = resolved?.addressDetails || null;
      if (ad && !ad.unresolvableShortLink && ad.address) {
        delete ad.id;
        // Never overwrite recipient name with sender's Telegram name — link's contact_name is authoritative (recipient = Ammi/Abbu)
        order.addressDetails = ad;
        order.address = ad.address || ad.city || url;
        order.addressLink = url;
      } else {
        // Keep the link (never the surrounding chat text) for order.address, but retain preGeocodedPlainAd in addressDetails
        order.addressDetails = ad || preGeocodedPlainAd || null;
        if (preGeocodedPlainAd && order.addressDetails) {
          if (!order.addressDetails.address && preGeocodedPlainAd.address) order.addressDetails.address = preGeocodedPlainAd.address;
          if (!order.addressDetails.lat && preGeocodedPlainAd.lat) {
            order.addressDetails.lat = preGeocodedPlainAd.lat;
            order.addressDetails.lng = preGeocodedPlainAd.lng;
          }
        }
        order.address = url;
        order.addressLink = url;
      }

      // If mobile is not inside the onelink, extract recipient mobile from the message text
      const extractedMobile = normalizeRecipientMobile(
        order.addressDetails?.mobile ||
        preGeocodedPlainAd?.mobile ||
        earlyPlainAd?.mobile ||
        (trimmed.match(/(?:(?:phone|mobile|contact|tel|call)[\s:.-]*)?(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?([6-9]\d{9})\b/i)?.[1])
      );
      if (extractedMobile) {
        if (!order.addressDetails) order.addressDetails = {};
        order.addressDetails.mobile = extractedMobile;
        order.recipientMobile = extractedMobile;
        order.deliveryPhone = extractedMobile;
      }

      order.addressOriginalText = order.address;
      updatedAddress = true;
    } else if (isValidCartInput(url)) {
      if (resolved?.expired || resolved?.groupCartStatus === 'EXPIRED' || resolved?.status === 'EXPIRED') {
        const err = new Error(`Group Cart link expired or closed on Swiggy: ${url}`);
        err.diag = { code: 'GROUP_CART_EXPIRED', stage: 'RESOLVE_CART_LINK', swiggyMessage: resolved?.groupCartStatus || 'EXPIRED' };
        throw err;
      }
      if (resolved?.groupCartStatus === 'PLACED') {
        const err = new Error(`Group Cart order was already placed on Swiggy: ${url}`);
        err.diag = { code: 'GROUP_CART_ALREADY_PLACED', stage: 'RESOLVE_CART_LINK', swiggyMessage: 'PLACED' };
        throw err;
      }
      order.cart = url;
      // Lazy Boss mode: remember whether Swiggy actually answered for this link.
      // An unresolved link must never masquerade as a live cart on the bill card.
      const cartResolved = Boolean(resolved && (
        resolved.groupCartId || resolved.restaurantId || resolved.restaurantName || resolved.cartDetails
      ));
      order.cartUnverified = !cartResolved;
      if (resolved?.groupCartId) order.groupCartId = resolved.groupCartId;
      if (resolved?.hostName) order.hostName = resolved.hostName;
      if (resolved?.restaurantId) order.restaurantId = resolved.restaurantId;
      if (resolved?.restaurantName) order.restaurantName = resolved.restaurantName;
      if (resolved?.cartDetails?.items?.length) {
        order.items = resolved.cartDetails.items;
        order.subtotal = resolved.cartDetails.subtotal || 0;
        order.tradeDiscountTotal = resolved.cartDetails.tradeDiscountTotal || 0;
      }
      updatedCart = true;
    }
  }

  for (const { mUrl, resolved } of resolvedMapsList) {
    // GPS pin / Maps link is authoritative too: reverse-geocoded location only, never sender's name
    const ad = resolved?.addressDetails || null;
    if (ad) {
      delete ad.id;
      order.addressDetails = ad;
      order.address = ad.address || mUrl;
      order.addressLink = mUrl;
    } else {
      order.address = mUrl;
    }
    order.addressOriginalText = order.address;
    updatedAddress = true;
  }

  if (!updatedCart && !updatedAddress) {
    if (isValidCartInput(trimmed)) {
      // Only store the actual cart URL, not the whole message text — prevents address text leaking into cart
      const urlsForCart = extractSharedUrls(trimmed).filter(u => isValidCartInput(u));
      order.cart = urlsForCart[0] || primaryCartFallback(trimmed);
      // Text/receipt fallback — Swiggy never confirmed this cart, so the intake
      // handler shows the rescue card (with one-tap retry) instead of pretending.
      order.cartUnverified = true;
      updatedCart = true;
    } else if (!addressShareUrl && isValidAddressInput(trimmed)) {
      // Plain-text address (no address link in the message) — the text IS the source.
      const ad = preGeocodedPlainAd || parseAddressDetails(trimmed);
      order.address = trimmed;
      order.addressOriginalText = trimmed;
      if (ad) {
        delete ad.id;
        order.addressDetails = ad;
      }
      updatedAddress = true;
    }
  } else if (updatedCart && !updatedAddress && !addressShareUrl) {
    const textWithoutUrls = trimmed.replace(/https?:\/\/[^\s]+/gi, ' ').trim();
    if (textWithoutUrls.length >= 12 && isValidAddressInput(textWithoutUrls)) {
      const ad = preGeocodedPlainAd || parseAddressDetails(textWithoutUrls);
      if (ad && (ad.address || ad.lat || /\d{6}/.test(textWithoutUrls))) {
        delete ad.id;
        order.address = textWithoutUrls;
        order.addressOriginalText = textWithoutUrls;
        order.addressDetails = ad;
        updatedAddress = true;
      }
    }
  }

  // Eagerly pre-geocode plain-text street addresses during message intake (~200ms via Swiggy autocomplete)
  // so `order.addressDetails.lat`/`lng` are ALREADY ready in 0ms when any account / Multi-ID Best Offer syncs!
  if (updatedAddress && order.addressDetails && (!order.addressDetails.lat || !order.addressDetails.lng)) {
    try {
      const db = getDb();
      const firstAcc = Object.values(db?.config?.accounts || {}).find(a => a?.isLoggedIn && (a.cookies || a.tid || a.token)) || null;
      order.addressDetails = await geocodeAddressDetails(order.addressDetails, firstAcc);
    } catch (e) {}
  }

  return { updatedCart, updatedAddress };
}

// ---------------------------------------------------------------------------
// INSTANT LINK WATCHER
// ---------------------------------------------------------------------------
// Swiggy publishes the share link a moment AFTER the payment settles. Instead of
// waiting for the slow tracking ladder (0s -> 15s -> 180s...), this watches the
// order every few seconds and, the second the link exists, writes it into the
// SAME card the user is already looking at. That is the "unka bot turant
// publish karta hai" behaviour, without spamming: one order, one ID, few calls.
const _instantLinkWatchers = new Map(); // orderId -> timer

export function stopInstantTrackingWatcher(orderId) {
  const timer = _instantLinkWatchers.get(String(orderId));
  if (timer) {
    clearTimeout(timer);
    _instantLinkWatchers.delete(String(orderId));
  }
}

export function watchInstantTrackingLink({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  fastUntilMs = 90_000,
  maxWaitMs = 12 * 60 * 1000
} = {}) {
  const key = String(orderId || '');
  if (!key) return;
  stopInstantTrackingWatcher(key);
  const startedAt = Date.now();

  const tick = async () => {
    _instantLinkWatchers.delete(key);
    const db = getDb();
    const order = db.orders?.[key];
    if (!order) return;
    if (getStoredSwiggyTrackingUrl(order)) return; // already there — nothing to do
    const swiggyOrderId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || '');
    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxWaitMs) return;

    let url = '';
    if (acc && swiggyOrderId) {
      try {
        const fast = await fetchSwiggyTrackingLinkFast(acc, swiggyOrderId, {
          budgetMs: elapsed < fastUntilMs ? 3500 : 6000,
          attempts: elapsed < fastUntilMs ? 2 : 1
        });
        url = fast?.url || '';
      } catch {}
    }
    // Selected ID has nothing after ~20s? The order may sit on a different vault
    // ID, so try a couple more (one cheap call each) — still far cheaper than the
    // full all-account scan.
    if (!url && swiggyOrderId && elapsed > 20_000) {
      const accounts = Object.entries(db.config?.accounts || {})
        .filter(([k, a]) => a && a.isLoggedIn && !a.isLoggedOut && k !== order.selectedAccount && (a.cookies || a.tid || a.token))
        .slice(0, 3);
      for (const [, otherAcc] of accounts) {
        try {
          const hit = await fetchSwiggyTrackingLinkFast(otherAcc, swiggyOrderId, { budgetMs: 2500, attempts: 1 });
          if (hit?.url) { url = hit.url; break; }
        } catch {}
      }
    }

    if (url) {
      const fresh = getDb();
      const freshOrder = fresh.orders?.[key];
      if (freshOrder) {
        freshOrder.trackingLink = url;
        freshOrder.trackingLinkSource = 'SWIGGY_API';
        freshOrder.shareTrackUrl = '';
        freshOrder.trackingFoundAt = new Date().toISOString();
        if (!freshOrder.swiggyOrderId) freshOrder.swiggyOrderId = swiggyOrderId;
        upsertOrder(key, freshOrder);
        console.log(`[Tracking] Instant link found ${Math.round(elapsed / 1000)}s after payment: ${swiggyOrderId}`);
        try {
          await postOrReplaceForwardedCard(telegram, chatId, freshOrder, getDb(), formatOrderBodyFn);
        } catch {}
        try {
          await tryEditForwardedPaymentMessageWithTracking(telegram, chatId, freshOrder);
        } catch {}
        try {
          await sendOrderDeliveryInfoNotice(telegram, chatId, freshOrder);
        } catch {}
      }
      return;
    }

    // Fast window first (every 3s for 90s), then a slow tail that still beats
    // the default 180s ladder.
    const nextDelay = elapsed < fastUntilMs ? 3000 : 20_000;
    const timer = setTimeout(tick, nextDelay);
    if (typeof timer.unref === 'function') timer.unref();
    _instantLinkWatchers.set(key, timer);
  };

  const firstDelay = 2000;
  const timer = setTimeout(tick, firstDelay);
  if (typeof timer.unref === 'function') timer.unref();
  _instantLinkWatchers.set(key, timer);
}

export async function finalizePaidOrderCard({
  telegram,
  chatId,
  order,
  livePaidResult,
  formatOrderBodyFn
}) {
  stopOrderPaymentPoller(order.id);
  if (order.selectedAccount) {
    releaseSwiggyAccountReservation(order.selectedAccount, order.id);
    // Invalidate cached `0-Order` badge so once a `0-Order` ID completes its 1st order, next order grabs another fresh `0-Order` ID!
    invalidateAccountOrderProfileCache(order.selectedAccount);
    const curDb = getDb();
    const persistedOrder = curDb?.orders?.[order.id];
    const usedAccObj = curDb?.config?.accounts?.[order.selectedAccount];
    const alreadyCounted = Boolean(order.accountOrderCountIncremented || persistedOrder?.accountOrderCountIncremented);
    const alreadyCompleted = (order.status === 'COMPLETED' && order.cardStage === 'PAID_CONFIRMED') ||
      (persistedOrder?.status === 'COMPLETED' && persistedOrder?.cardStage === 'PAID_CONFIRMED');
    if (usedAccObj && !alreadyCounted && !alreadyCompleted) {
      const knownCounts = [usedAccObj.totalOrdersCount, usedAccObj.cachedTotalOrdersCount, order.selectedAccountTotalOrders]
        .filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
        .map(value => Math.max(0, Number(value)));
      const nextOrderCount = (knownCounts.length ? Math.max(...knownCounts) : 0) + 1;
      usedAccObj.isZeroOrderAccount = false;
      usedAccObj.totalOrdersCount = nextOrderCount;
      usedAccObj.cachedTotalOrdersCount = nextOrderCount;
      order.accountOrderCountIncremented = true;
      if (persistedOrder) persistedOrder.accountOrderCountIncremented = true;
      saveDb(curDb);
    } else if (usedAccObj && alreadyCompleted && !alreadyCounted) {
      // Legacy completed cards predate the idempotency marker; don't increment them again.
      order.accountOrderCountIncremented = true;
      if (persistedOrder) persistedOrder.accountOrderCountIncremented = true;
      saveDb(curDb);
    } else if (alreadyCounted) {
      order.accountOrderCountIncremented = true;
    }
  }

  order.status = 'COMPLETED';
  order.cardStage = 'PAID_CONFIRMED';
  order.swiggyOrderId = String(livePaidResult.swiggyOrderId || order.pendingSwiggyOrderId || '');
  order.liveOrderStatus = livePaidResult.orderStatus || 'Order Confirmed';
  order.etaMinutes = livePaidResult.etaMinutes || order.etaMinutes || '';
  order.deliveryBoyName = livePaidResult.deliveryBoy?.name || order.deliveryBoyName || '';
  order.deliveryBoyMobile = livePaidResult.deliveryBoy?.mobile || order.deliveryBoyMobile || '';
  order.deliveryOtp = livePaidResult.deliveryOtp || order.deliveryOtp || '';
  if (livePaidResult.restaurantName) order.restaurantName = livePaidResult.restaurantName;

  // INSTANT LINK: before the paid card goes out, ask Swiggy directly the same way
  // the app does (`trackV4` -> `fyi_details[].value.cta_link`). A few fast
  // retries cover the 1-2s publish lag, so the very first card already carries
  // the link instead of "tracking link not shared yet".
  let instantTrackingUrl = '';
  let instantTrackingOrderId = '';
  if (order.selectedAccount) {
    const instantAcc = getDb().config?.accounts?.[order.selectedAccount];
    instantTrackingOrderId = String(livePaidResult.swiggyOrderId || order.pendingSwiggyOrderId || order.swiggyOrderId || '');
    if (instantAcc && instantTrackingOrderId) {
      try {
        const fast = await fetchSwiggyTrackingLinkFast(instantAcc, instantTrackingOrderId, { budgetMs: 4500, attempts: 3 });
        instantTrackingUrl = fast?.url || '';
        if (instantTrackingUrl) console.log(`[Tracking] Instant link at payment confirm: ${instantTrackingOrderId}`);
      } catch (fastErr) {
        console.warn('[Tracking] Instant link fetch failed:', fastErr?.message || fastErr);
      }
    }
  }

  const providerTrackingCandidate = instantTrackingUrl || livePaidResult.nativeShareUrl || livePaidResult.swiggyWebTrackUrl || '';
  const providerTrackingUrl = providerTrackingCandidate
    ? getStoredSwiggyTrackingUrl({ trackingLink: providerTrackingCandidate, trackingLinkSource: 'SWIGGY_API' })
    : '';
  const existingTrustedTrackingUrl = getStoredSwiggyTrackingUrl(order);
  order.shareTrackUrl = '';
  order.trackingLink = providerTrackingUrl || existingTrustedTrackingUrl;
  order.trackingLinkSource = providerTrackingUrl ? 'SWIGGY_API' : (existingTrustedTrackingUrl ? order.trackingLinkSource : '');
  order.paidAt = new Date().toISOString();

  // NEW: Try to edit the existing payment QR message in-place to inject tracking link/OTP (user request: payment message auto-edit)
  // If edit succeeds, keep the edited QR visible (do not delete it) and only clear card messages.
  let qrPaymentEdited = false;
  try {
    qrPaymentEdited = await tryEditForwardedPaymentMessageWithTracking(telegram, chatId, order);
  } catch {}

  if (qrPaymentEdited) {
    await deleteOrderBotMessages(telegram, chatId, order, { includeQr: false });
  } else {
    await deleteOrderBotMessages(telegram, chatId, order, { includeQr: true });
  }
  upsertOrder(order.id, order);
  const freshDb = getDb();
  const { text, keyboard } = buildForwardedOrderCardView(order, freshDb, formatOrderBodyFn);
  const sent = await telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard
  });
  order.activeCardMessageId = sent.message_id;
  order.trackedCardMessageIds = [sent.message_id];
  upsertOrder(order.id, order);
  await sendOrderDeliveryInfoNotice(telegram, chatId, order, { force: true });
  startOrderDeliveryInfoPoller({ telegram, chatId, orderId: order.id, formatOrderBodyFn });
  // Order confirmed → the bot fetches the genuine Swiggy share link itself and
  // pushes it to the Boss dashboard + customer as soon as Swiggy publishes it.
  try { startOrderTrackingAuto(order.id, { budgetMs: 15000 }); } catch {}
  // …and this watches the first ~90 seconds closely, so the link appears in the
  // very card the user is staring at (instead of 3 minutes later).
  if (!getStoredSwiggyTrackingUrl(order)) {
    try {
      watchInstantTrackingLink({ telegram, chatId, orderId: order.id, formatOrderBodyFn });
    } catch {}
  }
  return sent;
}

export async function sendOrderDeliveryInfoNotice(telegram, chatId, order, { force = false } = {}) {
  const recipientId = String(order?.fwdSenderUserId || order?.userId || '').trim();
  if (!recipientId || recipientId === String(chatId || '') || typeof telegram?.sendMessage !== 'function') return false;

  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  const deliveryOtp = String(order?.deliveryOtp || '').trim();
  const noticeKey = `${trackingUrl}\n${deliveryOtp}`;
  const notices = order.deliveryInfoNotices && typeof order.deliveryInfoNotices === 'object'
    ? order.deliveryInfoNotices
    : {};
  if (!force && notices[recipientId] === noticeKey) return false;

  // User-requested format: "Fer aex has just placed an order (ID: 251144921143559) for you on Swiggy. Click this link to track: http://r.swiggy.com/..."
  const bossName = String(order.bossName || order.placedByName || order.confirmedByName || 'Fer aex').trim() || 'Fer aex';
  const displayOrderId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  const trackDisplay = trackingUrl ? escapeHtml(trackingUrl) : '';
  const trackLinkHtml = trackingUrl ? `<a href="${escapeHtml(trackingUrl)}">${trackDisplay}</a>` : '';
  const lines = [];
  if (order.status === 'COMPLETED' && trackingUrl) {
    lines.push(`✓ <b>Payment received — aapka Swiggy order place ho gaya (#${escapeHtml(displayOrderId)})</b>`);
    lines.push(`${escapeHtml(bossName)} ne aapke liye order kiya hai. Track karne ke liye: ${trackLinkHtml}`);
  } else if (trackingUrl) {
    lines.push(`${escapeHtml(bossName)} has just placed an order (ID: ${escapeHtml(displayOrderId)}) for you on Swiggy. Click this link to track: ${trackLinkHtml}`);
    lines.push(`✓ <b>Payment received — Swiggy order confirmed</b>`);
    if (order.liveOrderStatus) lines.push(`Status: ${escapeHtml(String(order.liveOrderStatus))}`);
  } else {
    lines.push(`✓ <b>Swiggy order update</b>`);
    lines.push(`Order reference: <code>#${escapeHtml(String(order.id))}</code>`);
    if (order.swiggyOrderId) lines.push(`Swiggy order no.: <code>${escapeHtml(String(order.swiggyOrderId))}</code>`);
    if (order.liveOrderStatus) lines.push(`Status: ${escapeHtml(String(order.liveOrderStatus))}`);
    lines.push('Payment verified successfully. Swiggy tracking link is not available yet — jaldi hi bheja jayega.');
    // Sach + raasta: link na ho to Swiggy ke asli orders page ka link do
    // (bot ka apna page kabhi nahi).
    lines.push(`Abhi apna order yahan dekh sakte hain: <a href="https://www.swiggy.com/my-account/orders">Swiggy My Orders</a>`);
    console.log(`[Tracking] No reliable tracking source for order ${order.id} (swiggyOrderId=${order.swiggyOrderId || 'unknown'}). Will retry via poller.`);
  }
  if (deliveryOtp) {
    lines.push(`⌕ <b>Delivery OTP:</b> <code>${escapeHtml(deliveryOtp)}</code>`);
  } else if (!trackingUrl) {
    lines.push('Delivery OTP is not available yet. If Swiggy provides one, I will send it here.');
  }

  const options = {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(trackingUrl
      ? Markup.inlineKeyboard([[Markup.button.url('↗ Open Swiggy tracking', trackingUrl)]])
      : Markup.inlineKeyboard([[Markup.button.url('↗ Swiggy My Orders', 'https://www.swiggy.com/my-account/orders')]]))
  };
  // 📱 SMS band hai (boss/professor 30-10-2026: "bot SMS mat bhejo"). Par
  // customer ko tracking link MILNA chahiye — warna wo order ka pata hi nahi
  // kar sakta aur "link nahi aaya" wali shikayat wapas aati hai.
  // Isliye delivery yahan Telegram DM par hoti hai (bot ka apna channel), SMS
  // gateway ka use nahi hota. Sach: message tabhi bhejte hain jab bheja jaye —
  // `true` sirf tab jab message sach me chala gaya ho.
  let delivered = false;
  try {
    const sent = await telegram.sendMessage(recipientId, lines.join('\n'), options);
    const messageId = sent?.message_id || null;
    order.deliveryInfoNotices = { ...notices, [recipientId]: noticeKey };
    if (messageId) {
      order.deliveryInfoMessageId = messageId;
      order.deliveryInfoSentAt = new Date().toISOString();
    }
    order.deliveryInfoChannel = 'TELEGRAM';
    const db = getDb();
    db.orders[order.id] = order;
    saveDb(db);
    delivered = true;
  } catch (err) {
    // Bhej nahi paye to jhooth nahi bolte: dedupe key bhi stamp nahi hoti, taaki
    // agla attempt dobara try kare.
    console.warn(`[Tracking] Customer notice failed for order ${order.id}:`, err?.message || err);
    delivered = false;
  }
  return delivered;
}

export function startOrderDeliveryInfoPoller({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  customTrackingFetcher = null,
  intervalMs = 60_000,
  maxDurationMs = 6 * 60 * 60 * 1000
}) {
  const key = String(orderId);
  if (activeDeliveryInfoPollers.has(key)) return activeDeliveryInfoPollers.get(key);

  const state = { timer: null, startedAt: Date.now(), attempts: 0, checking: false, stopped: false };
  activeDeliveryInfoPollers.set(key, state);
  const stop = () => stopOrderDeliveryInfoPoller(key);
  const schedule = () => {
    if (state.stopped) return;
    const delay = Math.min(5 * 60_000, Math.round(intervalMs * Math.pow(1.5, Math.min(state.attempts, 6))));
    state.timer = setTimeout(poll, delay);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  };
  const poll = async () => {
    if (state.stopped || state.checking) return;
    if (Date.now() - state.startedAt >= maxDurationMs) return stop();
    state.checking = true;
    try {
      const db = getDb();
      const order = db.orders?.[key];
      if (!order || !['COMPLETED', 'ACCEPTED'].includes(order.status) || ['CANCELLED', 'REJECTED'].includes(order.status)) return stop();
      const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
      if (!acc || (!acc.cookies && !acc.tid && !acc.token) || !order.swiggyOrderId) return;

      let update = null;
      if (typeof customTrackingFetcher === 'function') {
        update = await customTrackingFetcher(acc, order);
      } else {
        const customerId = String(order.swiggyCustomerId || '');
        const [trackRes, deRes] = await Promise.all([
          dapiFetch(acc, `order/trackV4?order_id=${encodeURIComponent(order.swiggyOrderId)}&type=full&version=V2${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`).catch(() => null),
          dapiFetch(acc, `order/trackV2/de?order_id=${encodeURIComponent(order.swiggyOrderId)}`).catch(() => null)
        ]);
        const trackData = trackRes?.json?.data || {};
        const deData = deRes?.json?.data || {};
        update = {
          trackingUrl: extractSwiggyProvidedTrackingUrl(trackData, deData),
          deliveryOtp: extractSwiggyDeliveryOtp(trackData, { delivery: deData }),
          status: trackData?.order_status_details?.status_message || trackData?.order_status || '',
          etaMinutes: trackData?.sla_time || '',
          deliveryBoy: {
            name: deData?.name || '',
            mobile: deData?.mobile || ''
          }
        };
      }

      const candidateUrl = update?.trackingUrl || update?.swiggyWebTrackUrl || update?.nativeShareUrl || '';
      const verifiedUrl = candidateUrl
        ? getStoredSwiggyTrackingUrl({ trackingLink: candidateUrl, trackingLinkSource: 'SWIGGY_API' })
        : '';
      const previousUrl = getStoredSwiggyTrackingUrl(order);
      const otpDigits = String(update?.deliveryOtp || '').replace(/\D/g, '');
      const nextOtp = /^\d{4,8}$/.test(otpDigits) ? otpDigits : '';
      const previousOtp = String(order.deliveryOtp || '');
      const previousStatus = String(order.liveOrderStatus || '');
      const changed = Boolean((verifiedUrl && verifiedUrl !== previousUrl) || (nextOtp && nextOtp !== previousOtp));

      if (verifiedUrl) {
        order.trackingLink = verifiedUrl;
        order.trackingLinkSource = 'SWIGGY_API';
        order.shareTrackUrl = '';
      }
      if (nextOtp) order.deliveryOtp = nextOtp;
      if (update?.status) order.liveOrderStatus = String(update.status);
      if (update?.etaMinutes) order.etaMinutes = String(update.etaMinutes);
      if (update?.deliveryBoy?.name) order.deliveryBoyName = String(update.deliveryBoy.name);
      if (update?.deliveryBoy?.mobile) order.deliveryBoyMobile = String(update.deliveryBoy.mobile);
      const statusChanged = previousStatus !== String(order.liveOrderStatus || '');
      upsertOrder(order.id, order);

      if (changed || statusChanged) {
        if (formatOrderBodyFn && telegram?.sendMessage) {
          await postOrReplaceForwardedCard(telegram, chatId, order, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
        }
        // Also re-edit the payment QR message in-place when tracking/OTP finally appears (delay auto-edit)
        if (changed && order.activeQrMessageId) {
          try { await tryEditForwardedPaymentMessageWithTracking(telegram, chatId, order); } catch {}
        }
        if (changed) await sendOrderDeliveryInfoNotice(telegram, chatId, order);
      }
      if (/delivered|cancelled|canceled|rejected/i.test(String(order.liveOrderStatus || ''))) return stop();
    } catch {
      // Swiggy tracking can be temporarily unavailable; retry with bounded backoff.
    } finally {
      state.checking = false;
      state.attempts++;
      if (!state.stopped) schedule();
    }
  };

  schedule();
  return state;
}

// Payment pollers = sabse zyada network load. Pehle HAR order 5 second me ek
// live Swiggy call karta tha; 10 pending QRs = 120 calls/minute => instance
// saans nahi le pata tha. Ab exponential backoff + global cap + stage check.
const PAYMENT_BACKOFF_MS = [5000, 8000, 12000, 18000, 25000, 30000];
const PAYMENT_MAX_CONCURRENT_CHECKS = Math.max(1, Number(process.env.PAYMENT_POLL_CONCURRENCY) || 4);
let paymentChecksInFlight = 0;

export function getPaymentPollerStats() {
  return { activePollers: activePaymentPollers.size, checksInFlight: paymentChecksInFlight };
}

export function startOrderPaymentPoller({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  customPaymentChecker = null,
  intervalMs = 0, // 0 = adaptive backoff (recommended)
  maxDurationMs = 12 * 60 * 1000
}) {
  stopOrderPaymentPoller(orderId);
  const startedAt = Date.now();
  const state = { stopped: false, attempt: 0, checking: false };
  const handle = { state, timer: null };
  activePaymentPollers.set(orderId, handle);

  const schedule = (ms) => {
    if (state.stopped) return;
    handle.timer = setTimeout(runCheck, Math.max(1000, ms));
    if (typeof handle.timer.unref === 'function') handle.timer.unref();
  };

  const runCheck = async () => {
    if (state.stopped) return;
    if (Date.now() - startedAt > maxDurationMs) {
      stopOrderPaymentPoller(orderId);
      return;
    }
    if (state.checking || paymentChecksInFlight >= PAYMENT_MAX_CONCURRENT_CHECKS) {
      schedule(2000);
      return;
    }
    state.checking = true;
    paymentChecksInFlight += 1;
    let nextDelay = PAYMENT_BACKOFF_MS[Math.min(state.attempt, PAYMENT_BACKOFF_MS.length - 1)];
    try {
      const db = getDb();
      const order = db.orders?.[orderId];
      if (!order || ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
        stopOrderPaymentPoller(orderId);
        return;
      }
      // Payment ka intezaar hi nahi ho raha? Swiggy ko bekaar tang na karo.
      const awaitingPayment = Boolean(order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri)
        && !['PAID', 'PAID_CONFIRMED'].includes(String(order.paymentStatus || ''))
        && ['QR_GENERATED', 'PAYMENT_PENDING', 'PAID_PENDING_CONFIRM'].includes(String(order.cardStage || 'QR_GENERATED'));
      const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
      if (awaitingPayment && acc) {
        const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
        const res = await checker(acc, order);
        state.attempt += 1;
        if (res?.paid && res?.swiggyOrderId) {
          await finalizePaidOrderCard({
            telegram,
            chatId: order.bossChatId || chatId,
            order,
            livePaidResult: res,
            formatOrderBodyFn
          });
          stopOrderPaymentPoller(orderId);
          return;
        }
      } else {
        state.attempt += 1;
        nextDelay = PAYMENT_BACKOFF_MS[1];
      }
    } catch (e) {
      // Network blip: aur peeche hato (thundering herd se bacho)
      state.attempt += 1;
      nextDelay = Math.min(30000, nextDelay * 2);
    } finally {
      paymentChecksInFlight = Math.max(0, paymentChecksInFlight - 1);
      state.checking = false;
      if (!state.stopped) schedule(intervalMs > 0 ? intervalMs : nextDelay);
    }
  };

  schedule(PAYMENT_BACKOFF_MS[0]);
}

// Shared helper to sync a single order onto a chosen Swiggy ID safely in parallel
// EK ORDER = EK BILL SYNC. Logs me ek hi order par 3-4 accounts parallel bill
// bana rahe the => "ID switch" storm, lock timeouts aur aapas me takraav.
const orderBillSyncInFlight = new Map();

/** Kya is order ka bill abhi ban raha hai? */
export function isOrderBillSyncInFlight(orderId) {
  return orderBillSyncInFlight.has(String(orderId || ''));
}

export function executeOrderBillSyncOnAccount(args = {}) {
  const key = String(args?.orderId || '');
  if (!key) return executeOrderBillSyncOnAccountInternal(args);
  const running = orderBillSyncInFlight.get(key);
  if (running) {
    // Naya request purane ke saath hi chalega — jhagdna nahi.
    return running;
  }
  const run = executeOrderBillSyncOnAccountInternal(args);
  orderBillSyncInFlight.set(key, run);
  const clear = () => { if (orderBillSyncInFlight.get(key) === run) orderBillSyncInFlight.delete(key); };
  run.then(clear, clear);
  return run;
}

async function executeOrderBillSyncOnAccountInternal({
  telegram,
  chatId,
  orderId,
  accKey,
  formatOrderBodyFn,
  excludeAccountKeys = [],
  // INSTANT switch (⚡ Next ID / 👤 Choose ID): the picked ID builds the bill
  // straight away — no coupon/MCP/offer wave, no Swiggy One auto-add, no
  // free-cash relock. Every account carries the same offers, so nothing is lost.
  skipAutoOffers = false
}) {
  const db = getDb();
  let order = lookupOrder(db, orderId);
  if (!order) {
    console.warn('[OrderLookup] miss throw', orderNotFoundDiag(db, orderId));
    throw new Error(`Order #${orderId} not found. ` + orderNotFoundDiag(db, orderId));
  }

  // Resyncing or switching accounts clears pending payment fields. Do not do
  // it once this logical order may already exist on Swiggy.
  const existingPlacement = placementForChatOrder(order);
  if (existingPlacement || isQrGenerationInFlight(order.id)) throw placementAlreadyAttemptedError(existingPlacement || { state: 'IN_FLIGHT' });

  // SPEED: baseline auth call (ek network round-trip) sync ke saath PARALLEL
  // chalti hai, sync ke baad sequential nahi — ID switch ~1 RTT tez.
  const baselineAcc = accKey === 'BEST'
    ? null
    : (getDb().config?.accounts?.[order.selectedAccount || accKey] || null);
  const baselineAuthPromise = baselineAcc
    ? getSwiggySessionAuth(baselineAcc).catch(() => null)
    : Promise.resolve(null);

  let syncRes = null;
  if (accKey === 'BEST') {
    // HARD DEADLINE: three parallel probes × waves × coupon trials must never
    // stretch ID selection to minutes. 22s budget + a 28s backstop keeps the
    // card coming back inside Telegraf's handler window.
    // SPEED: 22s se 12s — koi bhi ID 12s me bill na bana paye to honest error
    // (aur turant agla ID try karne ka mauka) instead of minute-long wait.
    const scanBudgetMs = Math.max(6_000, Number(process.env.ID_SELECT_BUDGET_MS) || 12_000);
    let deadlineTimer = null;
    syncRes = await Promise.race([
      findBestMaxCouponAccountForOrder(order, {
        captureScreenshot: false,
        excludeAccountKeys,
        maxScanBudgetMs: scanBudgetMs
      }),
      new Promise((resolve) => {
        deadlineTimer = setTimeout(() => resolve(null), scanBudgetMs + 4_000);
        if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
      })
    ]).finally(() => { if (deadlineTimer) clearTimeout(deadlineTimer); });
    if (!syncRes) {
      // A timed-out search may have left reservations behind; free them so the
      // very next tap can immediately try again.
      try {
        for (const key of Object.keys(getDb()?.config?.accounts || {})) {
          releaseSwiggyAccountReservation(key, orderId);
        }
      } catch {}
      const timeoutErr = new Error(`ID selection timed out after ${Math.round((scanBudgetMs + 4_000) / 1000)}s (Swiggy slow / WAF). Koi ID logout nahi hui — dobara tap karein.`);
      timeoutErr.code = 'ID_SELECT_TIMEOUT';
      timeoutErr.diag = { code: 'ID_SELECT_TIMEOUT', stage: 'PICK_BEST_ACCOUNT', budgetMs: scanBudgetMs };
      throw timeoutErr;
    }
    if (!syncRes?.success) {
      const err = new Error(syncRes?.error || 'Could not sync cart across logged-in accounts.');
      err.diag = {
        code: syncRes?.code === 'ALL_ACCOUNTS_SUSPENDED' ? 'ALL_ACCOUNTS_SUSPENDED' : 'BEST_ACCOUNT_SYNC_FAILED',
        stage: 'PICK_BEST_ACCOUNT',
        comparison: syncRes?.accountComparison
      };
      throw err;
    }
  } else {
    const acc = db.config?.accounts?.[accKey];
    if (!acc || !acc.isLoggedIn || (!acc.cookies && !acc.tid && !acc.jwtTid && !acc.token)) {
      const err = new Error(`Selected Swiggy account (${accKey}) is not logged in.`);
      err.diag = { code: 'ACCOUNT_NOT_LOGGED_IN', stage: 'PICK_SPECIFIC_ACCOUNT' };
      throw err;
    }
    // Suspended ID par bill banana hi nahi hai — turant honest error, warna
    // waqt barbaad aur order atka rehta hai.
    const preCheckAcc = db.config?.accounts?.[accKey];
    if (isAccountSuspended(preCheckAcc)) {
      const suspErr = new Error(`⛔ Swiggy ID ${preCheckAcc?.phone || accKey} suspended hai — ${describeSuspendedAccount(preCheckAcc)}. Order dusri ID par shift hoga.`);
      suspErr.diag = { code: 'ACCOUNT_SUSPENDED', stage: 'PICK_SPECIFIC_ACCOUNT', accountKey: accKey };
      throw suspErr;
    }

    // Execute inside per-account lock so DIFFERENT accounts run 100% simultaneously in parallel!
    // SPEED: instant switch me lock ka intezaar 25s nahi, 8s — warna "ID select
    // karne me lag" wala hi problem. Actually free accounts ko farq nahi padta.
    syncRes = await withSwiggyAccountLock(accKey, async () => {
      // Clear any foreign `addressDetails.id` from a previous account before syncing on `accKey`!
      if (order.addressDetails?.id && order.selectedAccount && order.selectedAccount !== accKey) {
        delete order.addressDetails.id;
      }
      const r = await syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false, skipAutoOffers });
      return r;
    }, { maxWaitMs: skipAutoOffers ? 8_000 : 25_000 });
    if (!syncRes?.success) {
      const err = new Error(syncRes?.error || 'Failed to sync cart & address on selected Swiggy account.');
      err.diag = {
        code: syncRes?.code || 'ACCOUNT_CART_SYNC_FAILED',
        stage: 'PICK_SPECIFIC_ACCOUNT',
        accountKey: accKey,
        suspended: Boolean(syncRes?.suspended)
      };
      // Suspension sirf message me nahi — vault me lock hoti hai, taaki rotation
      // ise dobara pick na kare (user ka order healthy ID par chala jaye).
      if (syncRes?.suspended || syncRes?.code === 'ACCOUNT_SUSPENDED') {
        markAccountSuspended(accKey, {
          reason: String(syncRes?.reason || syncRes?.error || 'Swiggy account suspended'),
          code: 'ACCOUNT_SUSPENDED',
          stage: 'PICK_SPECIFIC_ACCOUNT',
          orderId: order.id
        });
        void notifyBossAccountSuspended(telegram, {
          orderId: order.id,
          key: accKey,
          phone: acc?.phone || acc?.mobile || accKey,
          reason: String(syncRes?.reason || syncRes?.error || 'Swiggy account suspended')
        });
      } else {
        noteAccountFailure(accKey, {
          kind: classifySwiggyAccountFailure({ message: String(syncRes?.error || ''), code: syncRes?.code || '' }).kind,
          reason: String(syncRes?.error || ''),
          code: syncRes?.code || '',
          stage: 'PICK_SPECIFIC_ACCOUNT',
          orderId: order.id
        });
      }
      throw err;
    }
    order.selectedAccount = accKey;
    order.orderAccount = acc.phone || accKey;
  }

  // Remember the coupons this scan actually found, so the Offer & Cash panel can
  // show every offer as its own button (no re-scan needed to open the panel).
  if (Array.isArray(syncRes?.availableCoupons) && syncRes.availableCoupons.length > 0) {
    order.availableCoupons = syncRes.availableCoupons.slice(0, 14).map((c) => ({
      code: String(c.code || '').toUpperCase(),
      title: String(c.title || c.code || '').slice(0, 60),
      description: String(c.description || '').slice(0, 80),
      discountAmount: Number(c.discountAmount || 0),
      finalPayable: c.finalPayable === null || c.finalPayable === undefined ? null : Number(c.finalPayable)
    })).filter((c) => /^[A-Z0-9_-]{3,28}$/.test(c.code));
  }

  // Free cash / late-night second chance on the SELECTED ID (outside the ID-scan
  // deadline, so it can never turn a good scan into a timeout). Bounded to 10s.
  if (!skipAutoOffers && order.selectedAccount && getDb().config?.accounts?.[order.selectedAccount]) {
    let freeCashTimer = null;
    try {
      const freeCashOut = await Promise.race([
        applyLiveFreeCashRelock(getDb().config.accounts[order.selectedAccount], order),
        new Promise((resolve) => { freeCashTimer = setTimeout(() => resolve(null), 10_000); })
      ]);
      if (freeCashOut?.reason) console.log(`[FreeCash] ${order.orderAccount || order.selectedAccount}: ${freeCashOut.reason}`);
    } catch (freeCashErr) {
      console.warn('[FreeCash] relock skipped:', freeCashErr?.message || freeCashErr);
    } finally {
      if (freeCashTimer) clearTimeout(freeCashTimer);
    }
  }

  // ROTATION MEMORY: an ID is selected ONCE per order. The next ⚡ Next ID tap
  // therefore always lands on a different account.
  if (order.selectedAccount) {
    order.usedAccountKeys = [...new Set([...(Array.isArray(order.usedAccountKeys) ? order.usedAccountKeys : []), String(order.selectedAccount)])];
  }
  order.lastAccountPickedAt = new Date().toISOString();
  order.fastAccountSwitch = skipAutoOffers ? true : Boolean(order.fastAccountSwitch);

  order.status = 'ACCEPTED';
  order.cardStage = 'BILL_READY';
  // Jo bill ab customer/boss ko dikhega WAHI QR ka amount hona chahiye. Isliye
  // yahan snapshot lete hain; QR banate waqt isse zyada amount ho to QR block
  // hota hai (log me ₹37 ka bill -> ₹82 ka QR, yeh wahi bug tha).
  if (Number(order.finalPayable || 0) > 0) {
    order.billShownAmount = Number(order.finalPayable);
    order.billShownAt = new Date().toISOString();
    order.billShownAccount = String(order.selectedAccount || '');
  }
  order.pendingSwiggyUpiUri = '';
  order.pendingSwiggyOrderId = '';
  order.pendingSwiggyPaasId = '';
  order.pendingQrAddressId = '';
  order.pendingQrAddressText = '';
  order.pendingQrDeliveryMobile = '';
  order.pendingQrLat = '';
  order.pendingQrLng = '';
  order.pendingQrAddressAccount = '';

  const usedAcc = getDb().config?.accounts?.[order.selectedAccount];
  if (usedAcc) {
    const authSnap = await baselineAuthPromise;
    const latestExisting = authSnap?.orders?.[0]?.order_id;
    order.baselineSwiggyOrderId = latestExisting ? String(latestExisting) : '';
  }

  let freshDb = getDb();
  freshDb.orders[order.id] = order;
  saveDb(freshDb);

  // Bill summary routing: a Boss-forwarded / Boss-entered order keeps the summary
  // INSIDE the bot (the Boss card below is that summary) and never messages the
  // customer. Only a customer's own "Send to Beta" order goes to the customer.
  const audience = resolveBillSummaryAudience(order, freshDb);
  if (audience === 'BOSS_ONLY') {
    order.billSummaryAudience = 'BOSS_ONLY';
    order.billSummaryDelivery = 'BOSS_CARD';
    order.billSummarySentAt = order.billSummarySentAt || new Date().toISOString();
    order.billSummarySentTo = {
      ...(order.billSummarySentTo && typeof order.billSummarySentTo === 'object' ? order.billSummarySentTo : {}),
      [String(chatId)]: new Date().toISOString()
    };
    freshDb = getDb();
    freshDb.orders[order.id] = order;
    saveDb(freshDb);
  } else {
    try {
      const summarySend = await sendBillSummaryToCustomerOnce(telegram, order, { db: freshDb });
      if (summarySend?.sent) {
        console.log(`[BillSummary] Sent to customer ${summarySend.customerId} for Order #${order.id}`);
      }
    } catch (summaryErr) {
      console.warn('[BillSummary] Auto-send skipped:', summaryErr?.message || summaryErr);
    }
  }

  freshDb = getDb();
  await postOrReplaceForwardedCard(telegram, chatId, order, freshDb, formatOrderBodyFn, { includeQrDelete: true });

  // Bill ban gaya => ID healthy hai (purana suspend/quarantine clear), aur agla
  // fresh ID background me "garam" ho jata hai (session auth cache) taaki
  // ⚡ Next ID dabate hi bill turant bane.
  try {
    if (order.selectedAccount) markAccountHealthy(order.selectedAccount, { note: 'bill sync ok' });
    const nextPick = pickNextRotationAccount(order);
    if (nextPick?.success && nextPick.key) void warmAccountSessionAuth(nextPick.key);
    // ₹50 / night offer: agar is ID par reward option galat ya campaign book hi
    // nahi hua to background me theek ho jata hai (kaam karte hue, block kiye bina).
    if (order.selectedAccount) void autoHealOffersForAccount(order.selectedAccount);
  } catch {}

  return order;
}

/**
 * OFFER AUTO-HEAL — jab ID cart me lagti hai, us waqt offer ki asli state
 * padho; agar reward option galat (~₹150 coupon) ya campaign book hi nahi hua
 * to ek baar khud theek kar do. Har ID par 15 min me max ek baar, background me,
 * order flow ko kabhi block nahi karta.
 */
export async function autoHealOffersForAccount(key, { minGapMs = 15 * 60 * 1000, nowMs = Date.now() } = {}) {
  const k = String(key || '');
  if (!k) return null;
  try {
    const db = getDb();
    const acc = db?.config?.accounts?.[k];
    if (!acc || !acc.isLoggedIn || isAccountSuspended(acc)) return null;
    const lastAt = Date.parse(String(acc.offerAutoHealAt || '')) || 0;
    if (lastAt && nowMs - lastAt < minGapMs) return null;
    acc.offerAutoHealAt = new Date(nowMs).toISOString();
    saveDb(db);

    const diag = await diagnoseAccountOffers(acc, { key: k, nowMs });
    const ln = diag?.tracks?.lateNight;
    const bf = diag?.tracks?.breakfast;
    const needsFix = [ln, bf].some((t) => t && (t.state === 'WRONG_REWARD' || t.state === 'NOT_BOOKED'));
    if (!needsFix) return diag;

    const fixed = await fixAccountOffers(acc, { key: k, nowMs });
    console.log(`[OfferAutoHeal] ${acc.phone || k}: ${(fixed.changes || []).map((c) => `${c.campaign}:${c.verified ? 'ok' : 'fail'}`).join(' ')}`);
    return fixed;
  } catch (err) {
    console.warn('[OfferAutoHeal] skipped:', err?.message || err);
    return null;
  }
}

/**
 * Lazy Boss mode — never leave an order stuck on "no account".
 *
 * 1. Try the automatic multi-probe pick (`BEST`) twice (transient WAF/network
 *    failures are retried; expired-cart style errors fail fast).
 * 2. If that still fails, walk a deterministic fallback ladder across every
 *    logged-in Swiggy ID (0-order → 0-active → rest) and stop at the first
 *    one that can build a live bill.
 * 3. Only when the whole vault is unusable does the order go back to Boss.
 */
export async function autoAssignBestAccountWithFallback({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  excludeAccountKeys = []
}) {
  const startDb = getDb();
  const order = lookupOrder(startDb, orderId);
  if (!order) throw new Error(`Order #${orderId} not found. ` + orderNotFoundDiag(startDb, orderId));

  const excluded = [...new Set((excludeAccountKeys || []).filter(Boolean).map(String))];
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId,
        accKey: 'BEST',
        formatOrderBodyFn,
        excludeAccountKeys: excluded
      });
    } catch (err) {
      lastError = err;
      if (attempt === 2 || !isRetryableFetchError(err)) break;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  const ladder = planAccountFallbacks(getDb()?.config?.accounts, order, { exclude: excluded });
  const tried = [];
  for (const candidate of ladder.slice(0, 3)) {
    try {
      const result = await executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId,
        accKey: candidate.key,
        formatOrderBodyFn
      });
      const doneDb = getDb();
      const doneOrder = doneDb.orders?.[orderId];
      if (doneOrder) {
        doneOrder.accountFallbackReason = candidate.reason;
        doneOrder.accountFallbackTier = candidate.tier;
        doneOrder.accountSyncError = '';
        doneOrder.lastAccountError = '';
        upsertOrder(orderId, doneOrder);
      }
      return result;
    } catch (err) {
      lastError = err;
      tried.push(candidate.phone || candidate.key);
    }
  }

  if (lastError && tried.length) {
    lastError.message = `${lastError.message} (aage try kiye: ${tried.join(', ')})`;
  }
  throw lastError || new Error('No usable Swiggy ID could build a live bill.');
}

// Shared helper to generate REAL Swiggy Dynamic QR for a single order (safe for `Promise.all` across 10+ distinct IDs!)
const SUSPENSION_QUARANTINE_HOURS = Math.max(
  1,
  Math.round((Number(process.env.ACCOUNT_SUSPEND_QUARANTINE_MS) || 6 * 60 * 60 * 1000) / (60 * 60 * 1000))
);

/**
 * Swiggy ne order place kar diya par UPI intent nahi diya — Boss ko saaf batao
 * (ghabrane wali "rejected" error nahi) aur naya QR maangne ka button do.
 */
export async function notifyBossOrderPlacedNoIntent(telegram, { orderId = '', phone = '', placedOrderId = '' } = {}) {
  try {
    const db = getDb();
    const bossId = Number(db?.config?.bossIds?.[0] || process.env.BOSS_ID || 0);
    if (!bossId || typeof telegram?.sendMessage !== 'function') return false;
    await telegram.sendMessage(
      bossId,
      `⚠️ <b>ORDER PLACE HUA, QR NAHI MILA</b>\n\n` +
      `◈ Order: <b>#${escapeHtml(String(orderId))}</b>\n` +
      `# Swiggy order: <code>${escapeHtml(String(placedOrderId || '—'))}</code>\n` +
      `☎ ID: <code>${escapeHtml(String(phone || '—'))}</code>\n\n` +
      `<i>Swiggy ne request accept ki, lekin verified order ID ya sahi UPI intent nahi mila. ` +
      `Doosra QR ya account try nahi hua. Isi Swiggy account ke My Orders me check karein; ` +
      `pehle order ka status clear kiye bina dobara order mat dein.</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([
          // Pehle ye order clear karo — tabhi naya QR. Isliye "Naya QR" ke bajaye
          // wo do cheezein jo sach me aage badhati hain:
          //   1) is order ka payment aaya ya nahi (status check, koi naya order nahi)
          //   2) Swiggy My Orders (pay ya cancel karne ke liye)
          ...(orderId ? [[
            Markup.button.callback('✓ Paid check karo', `fwd_check_paid_${orderId}`),
            Markup.button.callback('☎ Accounts', 'boss_view_accounts')
          ]] : []),
          [Markup.button.url('↗ Swiggy My Orders', 'https://www.swiggy.com/my-account/orders')]
        ])
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Boss ko seedha batao ki ek ID suspended ho gayi aur order kis order par shift hua.
 * Buttons: ⛔ Retry (quarantine clear) + ◉ Accounts.
 */
export async function notifyBossAccountSuspended(telegram, {
  orderId = '', key = '', phone = '', reason = '', switchedTo = '', switchedToKey = '', attempted = []
} = {}) {
  try {
    const db = getDb();
    const bossId = Number(db?.config?.bossIds?.[0] || process.env.BOSS_ID || 0);
    if (!bossId || typeof telegram?.sendMessage !== 'function') return false;
    const lines = [
      `⛔ <b>SWIGGY ID SUSPENDED</b>`,
      ``,
      `☎ ID: <code>${escapeHtml(String(phone || key || '—'))}</code>`,
      `◈ Order: <b>#${escapeHtml(String(orderId || '—'))}</b>`,
      `⚠️ Reason: <i>${escapeHtml(String(reason || 'Swiggy ne account block kiya').slice(0, 200))}</i>`,
      switchedTo
        ? `
✅ <b>Order shift ho gaya:</b> <code>${escapeHtml(String(switchedTo))}</code> — customer ko naya QR isi ID se banega, order nahi rukega.`
        : `
❗ Koi healthy ID nahi mili${attempted.length ? ` (tried: ${escapeHtml(attempted.join(', '))})` : ''}. Naya ID login karein — order card par turant lagega.`,
      `
<i>Ye ID ${Math.round(SUSPENSION_QUARANTINE_HOURS)} ghante rotation me nahi aayegi. Swiggy se block hat jaye to ⛔ Retry dabaiye.</i>`
    ];
    const keyboard = key
      ? { reply_markup: { inline_keyboard: [
          [{ text: '⛔ Retry is ID', callback_data: `boss_retry_acc_${String(key).slice(0, 40)}` }],
          [{ text: '◉ Accounts', callback_data: 'boss_view_accounts' }]
        ] } }
      : { reply_markup: { inline_keyboard: [[{ text: '◉ Accounts', callback_data: 'boss_view_accounts' }]] } };
    await telegram.sendMessage(bossId, lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard
    });
    return true;
  } catch {
    return false;
  }
}

// EK ORDER = EK QR ATTEMPT. Pehle ek hi order par 4-5 parallel attempts chal
// jate the (har ek Swiggy par naya unpaid order place karta tha, aur har ek
// apna error spam karta tha). Ab doosra caller wahi promise paata hai.
const qrGenerationInFlight = new Map();

// ⏱ QR GEN BUDGET (boss 30-10-2026: "bot hang hogaya hai").
// Timer se race karke worker ko chhodna khatarnaak tha (chalta worker + retry =
// Swiggy par doosra unpaid order). Isliye: worker ko mara nahi jata, par uska
// waqt naap liya jata hai — budget se zyada chale to maintenance/boss ko
// `QR_GENERATION_TIMEOUT` ke roop me pata chalta hai, aur usi order par naya
// attempt sirf purana khatam hone ke baad shuru hota hai (dedupe).
const QR_GEN_BUDGET_MS = Math.max(20_000, Number(process.env.QR_GEN_BUDGET_MS) || 90_000);

export function executeRealQrGenerationForOrder(args = {}) {
  const requested = String(args?.orderId || '');
  const key = String(lookupOrder(getDb(), requested)?.id || requested);
  if (key && qrGenerationInFlight.has(key)) {
    return qrGenerationInFlight.get(key);
  }
  let reservation;
  try {
    // All bot QR entry points converge here. Charge the actual order owner,
    // not the admin who happened to press the button, before provider work.
    reservation = reserveChatOrderFee(key);
  } catch (err) {
    return Promise.reject(err);
  }
  // Job registry: agar ye budget se zyada chale to maintenance isko "atka hua"
  // batata hai (code QR_GENERATION_TIMEOUT) — chup-chaap hang nahi.
  const qrStartedAt = Date.now();
  const endJob = key ? startJob('QR_GENERATE', { timeoutMs: QR_GEN_BUDGET_MS, orderId: key }) : null;
  const run = executeRealQrGenerationForOrderInternal({ ...args, orderId: key || args.orderId }).catch((err) => {
    if (err && typeof err === 'object' && !err.diag) err.diag = {};
    try { refundChatOrderFeeBeforePlacement(key, reservation, err); }
    catch (refundErr) { console.error('[Wallet] fee refund failed:', refundErr?.message || refundErr); }
    throw err;
  }).finally(() => {
    if (endJob) endJob();
    if (key) clearJob('QR_GENERATE', key);
    const tookMs = Date.now() - qrStartedAt;
    if (key && tookMs > QR_GEN_BUDGET_MS) {
      // Budget se zyada laga — order par SACH likho (jhooth nahi ki sab theek),
      // aur boss ko maintenance card me yahi code dikhega. Worker ko mara nahi
      // jata, isliye duplicate order ka khatra nahi.
      try {
        const slowDb = getDb();
        const slowOrder = slowDb.orders?.[key];
        if (slowOrder) {
          slowOrder.qrGenerationSlow = {
            code: 'QR_GENERATION_TIMEOUT',
            tookMs,
            budgetMs: QR_GEN_BUDGET_MS,
            at: new Date().toISOString()
          };
          saveDb(slowDb);
        }
      } catch { /* audit fail se QR result na ruke */ }
      console.warn(`[QR] Order ${key}: generation took ${Math.round(tookMs / 1000)}s (budget ${Math.round(QR_GEN_BUDGET_MS / 1000)}s) — QR_GENERATION_TIMEOUT recorded.`);
    }
  });
  if (key) {
    qrGenerationInFlight.set(key, run);
    const clear = () => { if (qrGenerationInFlight.get(key) === run) qrGenerationInFlight.delete(key); };
    run.then(clear, clear);
  }
  return run;
}

/** Kya is order ka QR abhi ban raha hai? (UI ko "chal raha hai" batane ke liye) */
export function isQrGenerationInFlight(orderId) {
  return qrGenerationInFlight.has(String(orderId || ''));
}

async function executeRealQrGenerationForOrderInternal({
  telegram,
  chatId,
  orderId,
  formatOrderBodyFn,
  customRealQrGenerator = null,
  // Boss/customer ne "Regenerate" dabaya => Swiggy se NAYA QR (naya tr), cached
  // wala nahi. Yahi wajah thi ki "new QR" par wahi purana QR aata tha.
  forceNewQr = false
}) {
  const db = getDb();
  let order = lookupOrder(db, orderId);
  if (!order) {
    console.warn('[OrderLookup] miss throw', orderNotFoundDiag(db, orderId));
    throw new Error(`Order #${orderId} not found. ` + orderNotFoundDiag(db, orderId));
  }
  if (order.status === 'COMPLETED') {
    const err = new Error('Paid is final — never create another payment QR.');
    err.code = 'PAID_IS_FINAL_NO_NEW_QR';
    throw err;
  }
  if (orderBillSyncInFlight.has(String(order.id))) {
    const err = new Error('Bill sync is still in progress. Review the finished bill before placing the order.');
    err.diag = { code: 'BILL_SYNC_IN_FLIGHT', placementAttempted: false };
    throw err;
  }

  let accKey = order.selectedAccount;
  let acc = accKey ? db.config?.accounts?.[accKey] : null;
  if (!acc || !acc.isLoggedIn) {
    const attempted = placementForChatOrder(order);
    if (attempted) throw placementAlreadyAttemptedError(attempted);
    const autoPick = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });
    if (autoPick?.success && autoPick.winningKey) {
      accKey = autoPick.winningKey;
      acc = getDb().config?.accounts?.[accKey] || autoPick.winningAccount;
      order.selectedAccount = accKey;
      order.orderAccount = acc?.phone || accKey;
    } else {
      const err = new Error('No saved Swiggy JSON session is active right now — drop `.json` session files into chat to replenish the Account Vault.');
      err.diag = { code: 'QR_ACCOUNT_MISSING', stage: 'GENERATE_REAL_SWIGGY_QR' };
      throw err;
    }
  }

  // The real generator uses the wrapped form. forceNewQr never bypasses an
  // existing placement; it can only affect whether a valid QR is reused.
  const runGenerator = (accArg, orderArg, force = false) => (
    customRealQrGenerator
      ? customRealQrGenerator(accArg, orderArg)
      : generateRealSwiggyMerchantUpiQr({ account: accArg, order: orderArg, forceNewQr: force })
  );
  let realQr;
  try {
    // Do not race a deadline against a continuing placement worker. A timeout
    // does not cancel that worker and used to let a retry create a second order.
    // Individual network calls have their own deadlines; this promise remains
    // in the in-flight map until the worker actually finishes.
    realQr = await withSwiggyAccountLock(accKey, () => runGenerator(acc, order, forceNewQr));
    if (!realQr) {
      const err = new Error('Payment details were not returned. Check Swiggy My Orders before trying anything else.');
      err.diag = { code: 'QR_RESULT_MISSING', stage: 'GENERATE_REAL_SWIGGY_QR', placementAttempted: true };
      throw err;
    }
  } catch (qrErr) {
    const failure = classifySwiggyAccountFailure({
      message: String(qrErr?.message || ''),
      detailed: String(qrErr?.diag?.swiggyMessage || ''),
      code: String(qrErr?.diag?.code || qrErr?.code || ''),
      httpStatus: qrErr?.diag?.httpStatus,
      statusCode: qrErr?.diag?.swiggyStatusCode,
      rawText: String(qrErr?.diag?.rawSnippet || '')
    });
    // Suspended ID (Swiggy "account blocked") aur dead session — dono par order
    // ko dusri healthy ID par le jaana hai, warna customer ka order ruk jata hai.
    // (A) Order place ho chuka hai, bas UPI intent nahi mila. Is haalat me
    // DOOSRE account par jaana sabse bada nuksaan tha: Swiggy par ek aur unpaid
    // order ban jata, aur customer ko kuch nahi milta. Yahan rukna sahi hai.
    // Order place ho chuka hai par QR nahi mila — intent missing (A) ya intent
    // invalid/mismatch (B). Dono me retry = doosra unpaid order, isliye rukna.
    if (['SWIGGY_PLACED_NO_UPI_INTENT', 'SWIGGY_UPI_INTENT_INVALID'].includes(String(qrErr?.diag?.code || ''))) {
      const placedId = String(qrErr?.diag?.placedOrderId || '');
      const placedDb = getDb();
      const placedOrder = placedDb.orders?.[order.id];
      if (placedOrder) {
        placedOrder.pendingSwiggyOrderId = placedId || placedOrder.pendingSwiggyOrderId || '';
        placedOrder.swiggyPlacedUnpaid = true;
        placedOrder.placedWithoutIntentAt = placedOrder.placedWithoutIntentAt || new Date().toISOString();
        placedOrder.qrBlockedReason = 'Swiggy placed the order but returned no UPI intent';
        upsertOrder(placedOrder.id, placedOrder);
      }
      const noIntentErr = new Error(
        `Swiggy ne request accept ki (order #${placedId || '—'}) par verified payment details nahi mili. ` +
        `Isi account ke Swiggy My Orders me check karein; dobara order mat dein.`
      );
      noIntentErr.diag = {
        code: 'QR_PLACED_NO_INTENT',
        stage: 'GENERATE_REAL_SWIGGY_QR',
        placementAttempted: true,
        placedOrderId: placedId,
        paymentFallbacks: qrErr?.diag?.paymentFallbacks || null,
        accountPhone: acc?.phone || accKey
      };
      noIntentErr.placedOrderId = placedId;
      noIntentErr.code = 'QR_PLACED_NO_INTENT';
      await notifyBossOrderPlacedNoIntent(telegram, {
        orderId: order.id,
        phone: acc?.phone || accKey,
        placedOrderId: placedId
      });
      throw noIntentErr;
    }

    // A transport error or provider response after dispatch is ambiguous,
    // even when the message mentions an expired/suspended account.
    if (qrErr?.diag?.placementAttempted === true) throw qrErr;
    if (!failure.suspended && !failure.sessionDead) throw qrErr;

    const failedFirstKey = String(accKey || '');
    const failedFirstPhone = String(acc?.phone || acc?.mobile || failedFirstKey);
    const failedKeys = [failedFirstKey].filter(Boolean);

    if (failure.suspended) {
      markAccountSuspended(failedFirstKey, {
        reason: failure.reason,
        code: failure.matched || 'ACCOUNT_SUSPENDED',
        stage: 'GENERATE_REAL_SWIGGY_QR',
        orderId: order.id,
        httpStatus: qrErr?.diag?.httpStatus
      });
      // Swiggy qr block karta hai to pending intent/order id jhoothe hain — clear.
      order.pendingSwiggyUpiUri = '';
      order.pendingSwiggyOrderId = '';
      order.pendingSwiggyPaasId = '';
      order.qrInvalidatedAt = new Date().toISOString();
      order.qrInvalidReason = 'account suspended';
    } else {
      const markDb = getDb();
      if (markDb.config?.accounts?.[failedFirstKey]) {
        markDb.config.accounts[failedFirstKey].isLoggedIn = false;
        saveDb(markDb);
      }
      invalidateAccountOrderProfileCache(failedFirstKey);
    }
    releaseSwiggyAccountReservation(failedFirstKey, order.id);

    // INSTANT failover: lokal vault pick (0ms). Pehle yahan poora multi-account
    // network scan hota tha — wahi "ID selection slow" ki asli wajah thi.
    let switched = false;
    let lastErr = qrErr;
    for (let attempt = 0; attempt < 3 && !switched; attempt++) {
      const pick = pickNextRotationAccount(order, { excludeKeys: failedKeys });
      if (!pick?.success) break;
      const nextKey = String(pick.key);
      if (!nextKey || failedKeys.includes(nextKey)) break;
      failedKeys.push(nextKey);
      const nextAcc = getDb().config?.accounts?.[nextKey];
      if (!nextAcc || !nextAcc.isLoggedIn || isAccountSuspended(nextAcc)) continue;
      try {
        const nextQr = await withSwiggyAccountLock(
          nextKey,
          () => runGenerator(nextAcc, order, true),
          { maxWaitMs: 10_000 }
        );
        if (nextQr) {
          realQr = nextQr;
          accKey = nextKey;
          acc = nextAcc;
          order.selectedAccount = nextKey;
          order.orderAccount = nextAcc.phone || nextKey;
          order.accountFailoverFrom = failedFirstPhone;
          order.accountFailoverAt = new Date().toISOString();
          switched = true;
        }
      } catch (nextErr) {
        // Never continue the failover loop once any account may have placed it.
        if (nextErr?.diag?.placementAttempted === true) throw nextErr;
        lastErr = nextErr;
        const nextFailure = classifySwiggyAccountFailure({
          message: String(nextErr?.message || ''),
          detailed: String(nextErr?.diag?.swiggyMessage || ''),
          code: String(nextErr?.diag?.code || ''),
          httpStatus: nextErr?.diag?.httpStatus,
          statusCode: nextErr?.diag?.swiggyStatusCode
        });
        if (nextFailure.suspended) {
          markAccountSuspended(nextKey, {
            reason: nextFailure.reason,
            code: nextFailure.matched,
            stage: 'GENERATE_REAL_SWIGGY_QR',
            orderId: order.id
          });
        } else if (nextFailure.sessionDead) {
          const db2 = getDb();
          if (db2.config?.accounts?.[nextKey]) {
            db2.config.accounts[nextKey].isLoggedIn = false;
            saveDb(db2);
          }
        }
        releaseSwiggyAccountReservation(nextKey, order.id);
      }
    }

    await notifyBossAccountSuspended(telegram, {
      orderId: order.id,
      key: failedFirstKey,
      phone: failedFirstPhone,
      reason: failure.reason,
      switchedTo: switched ? String(acc?.phone || accKey) : '',
      attempted: failedKeys.map((k) => getDb()?.config?.accounts?.[k]?.phone || k)
    });

    if (!switched) {
      const exhausted = new Error(
        `Koi bhi healthy Swiggy ID QR nahi bana payi (${failure.suspended ? `${failedFirstPhone} suspended hai` : failure.reason}). ` +
        `Tried: ${failedKeys.map((k) => getDb()?.config?.accounts?.[k]?.phone || k).join(', ')}. ` +
        `Naya ID login karein ya ⛔ Retry se suspended ID wapas enable karein — order tab tak ruka rahega.`
      );
      exhausted.diag = {
        code: failure.suspended ? 'ALL_ACCOUNTS_SUSPENDED' : 'QR_FAILOVER_EXHAUSTED',
        stage: 'GENERATE_REAL_SWIGGY_QR',
        tried: failedKeys,
        reason: failure.reason,
        cause: lastErr?.diag || null
      };
      throw exhausted;
    }
  }
  const payable = Number(realQr.amount || order.finalPayable || 0);
  if (payable > 0) order.finalPayable = payable;

  // NEVER show a QR that a UPI app will reject. If the intent itself is
  // malformed (placeholder VPA / amount mismatch / broken encoding), fail with
  // the exact reason instead of sending a scannable-looking "invalid" QR.
  const intentGate = validateUpiIntentForQr(realQr.upiIntentUrl, { amount: payable, requireAmount: false });
  if (!intentGate.valid) {
    const badQrErr = new Error(
      `Swiggy ka payment QR valid nahi hai — ${intentGate.problems.join('; ')}. Customer ko bheja nahi gaya.`
    );
    badQrErr.diag = {
      code: 'QR_INTENT_INVALID',
      stage: 'GENERATE_REAL_SWIGGY_QR',
      placementAttempted: Boolean(placementForChatOrder(order)),
      problems: intentGate.problems,
      accountPhone: acc?.phone || accKey
    };
    throw badQrErr;
  }

  order.pendingSwiggyUpiUri = realQr.upiIntentUrl;
  order.realUpiIntentUri = realQr.upiIntentUrl;
  order.qrGeneratedAt = new Date().toISOString();
  // Regeneration counter: card par "QR #2" dikhta hai, aur reuse planner ise
  // dekh kar purana QR dobara nahi bhejta.
  order.qrVersion = forceNewQr ? (Number(order.qrVersion || 1) + 1) : Number(order.qrVersion || 1);
  if (forceNewQr) order.qrRegenerateCount = Number(order.qrRegenerateCount || 0) + 1;
  order.pendingSwiggyOrderId = String(realQr.swiggyOrderId || '');
  order.pendingSwiggyPaasId = String(realQr.paymentTxnId || '');
  order.pendingQrAddressId = String(order.addressDetails?.id || '');
  order.pendingQrAddressText = String(order.addressDetails?.address || '').normalize('NFKC').toLocaleLowerCase('en-IN').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  order.pendingQrDeliveryMobile = normalizeRecipientMobile(order.addressDetails?.mobile);
  order.pendingQrLat = String(order.addressDetails?.lat || '');
  order.pendingQrLng = String(order.addressDetails?.lng || '');
  order.pendingQrAddressAccount = String(acc?.phone || acc?.mobile || '');
  if (realQr.slaMinutes) order.etaMinutes = String(realQr.slaMinutes);
  order.cardStage = 'QR_GENERATED';
  upsertOrder(order.id, order);
  appendAuditEvent('qr_created', { orderId: order.id, amount: payable, account: maskAccountCode(acc || accKey) });

  const qrBuffer = await generateNamedUpiQrPngBuffer({
    upiUri: realQr.upiIntentUrl,
    senderName: order.fwdSenderName || order.userName || 'Customer',
    restaurantName: realQr.restaurantName || order.restaurantName || 'Swiggy',
    amount: payable,
    orderId: order.id
  });

  if (order.activeQrMessageId) {
    await telegram.deleteMessage(chatId, order.activeQrMessageId).catch(() => {});
  }

  const senderTag = escapeHtml(truncateDisplayField(order.fwdSenderName || order.userName || 'Customer', 110));
  const restTag = escapeHtml(truncateDisplayField(realQr.restaurantName || order.restaurantName || 'Swiggy', 120));
  const sendPhotoFn = typeof telegram.sendPhoto === 'function'
    ? (cid, photo, extra) => telegram.sendPhoto(cid, photo, extra)
    : null;
  if (!sendPhotoFn) {
    throw new Error('Telegram instance does not implement sendPhoto.');
  }
  const rawQrCaption =
    `□ <b>OFFICIAL SWIGGY DYNAMIC PAYMENT QR (#${escapeHtml(order.id)})</b>` +
    `${Number(order.qrVersion || 1) > 1 ? ` · <b>QR #${Number(order.qrVersion)}</b> (naya)` : ''}\n` +
    `◉ <b>Order For:</b> ${senderTag}\n` +
    `▤ <b>Restaurant:</b> ${restTag}\n` +
    `₹ <b>Exact Swiggy Amount:</b> ₹${payable}\n` +
    `# <b>Swiggy Checkout Order ID:</b> <code>${escapeHtml(order.pendingSwiggyOrderId)}</code>\n` +
    (describeQrRef(realQr.upiIntentUrl).ref ? `⌗ <b>QR Ref:</b> <code>${describeQrRef(realQr.upiIntentUrl).ref}</code>\n` : '') +
    `☎ <b>Swiggy Account:</b> <code>${escapeHtml(truncateDisplayField(acc.phone || order.selectedAccount, 40))}</code>\n\n` +
    `<i>✓ 100% Real Swiggy Merchant Dynamic QR — Pay from GPay / PhonePe / Paytm to place order directly on Swiggy! Auto-detecting payment every 5s...</i>`;
  const qrSent = await sendPhotoFn(
    chatId,
    { source: qrBuffer },
    {
      caption: safeTelegramCaption(rawQrCaption, 1000),
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✓ Paid (Verify & Get Live Tracking)', `fwd_check_paid_${order.id}`)],
        [Markup.button.callback('× Cancel Order', `fwd_cancel_${order.id}`)]
      ])
    }
  );

  order.activeQrMessageId = qrSent.message_id;
  order.trackedQrMessageIds = [qrSent.message_id];
  upsertOrder(order.id, order);

  const freshDb = getDb();
  const { text: updatedBillText, keyboard: updatedBillKb } = buildForwardedOrderCardView(order, freshDb, formatOrderBodyFn);
  if (order.activeCardMessageId) {
    await telegram.editMessageText(
      chatId,
      order.activeCardMessageId,
      undefined,
      updatedBillText,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...updatedBillKb
      }
    ).catch(() => {});
  }
  upsertOrder(order.id, order);

  startOrderPaymentPoller({
    telegram,
    chatId,
    orderId: order.id,
    formatOrderBodyFn,
    customPaymentChecker: null
  });

  return { order, realQr, qrMessageId: qrSent.message_id };
}

// Parallel Batch Dispatcher: assigns each ready order its own distinct FREE `0-Order` Swiggy ID with Max Offer & fetches ALL simultaneously!
export async function dispatchAllReadyOrdersInParallel({
  telegram,
  chatId,
  formatOrderBodyFn
}) {
  const db = getDb();
  const readyOrders = getReadyOrdersWaitingForAccount(db);
  if (readyOrders.length === 0) {
    return { dispatched: 0, results: [], reason: 'No ready orders waiting for account selection right now.' };
  }

  const busyMap = getBusySwiggyAccountsMap(db);
  const freeValidAccounts = Object.entries(db?.config?.accounts || {})
    .filter(([k, a]) => hasLiveWebSessionCookie(a) && !busyMap.has(k));

  if (freeValidAccounts.length === 0) {
    const err = new Error('No FREE Swiggy accounts with active web session (`_session_tid`) are available right now.');
    err.diag = { code: 'NO_FREE_VALID_SWIGGY_ACCOUNTS', stage: 'PARALLEL_MULTI_ORDER_DISPATCH' };
    throw err;
  }

  // Mark all dispatched orders `AUTO_SELECTING` first so `findBestMaxCouponAccountForOrder` knows exact concurrency count!
  const targetOrders = readyOrders.slice(0, freeValidAccounts.length);
  for (const ord of targetOrders) {
    ord.cardStage = 'AUTO_SELECTING';
    upsertOrder(ord.id, ord);
  }

  const settled = await Promise.allSettled(
    targetOrders.map(ord =>
      executeOrderBillSyncOnAccount({
        telegram,
        chatId,
        orderId: ord.id,
        accKey: 'BEST',
        formatOrderBodyFn
      })
    )
  );

  const refreshedDb = getDb();
  const pairs = targetOrders.map(ord => {
    const updated = refreshedDb?.orders?.[ord.id] || ord;
    return {
      order: updated,
      accKey: updated.selectedAccount || '',
      acc: updated.selectedAccount ? refreshedDb?.config?.accounts?.[updated.selectedAccount] : null
    };
  });

  return {
    dispatched: targetOrders.length,
    queuedRemaining: Math.max(0, readyOrders.length - targetOrders.length),
    pairs,
    settled
  };
}

let uniqueOrderSeq = 0;
function generateUniqueOrderId(db, prefix = 'ORD') {
  uniqueOrderSeq = (uniqueOrderSeq + 1) % 10000;
  for (let tries = 0; tries < 50; tries++) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    const id = tries < 10 ? `${prefix}${rand}` : `${prefix}${rand}${uniqueOrderSeq}`;
    if (!db?.orders?.[id]) return id;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

export async function handleBossForwardedOrderInput(
  ctx,
  {
    rawText = '',
    location = null,
    formatOrderBodyFn,
    autoSelectAccount = undefined,
    autoGenerateQr = undefined,
    nonBlockingAutoSync = false,
    customRealQrGenerator = null
  } = {}
) {
  // Input cap to prevent OOM from multi-order bulk pastes
  if (String(rawText || '').length > 8000) {
    rawText = String(rawText).slice(0, 8000);
    console.warn('[handleBossForwardedOrderInput] truncated oversized rawText to 8000');
  }
  const sender = resolveOrderSenderInfo(ctx.message, ctx.from);
  if (!sender) return false;

  // If Boss pasted 2..10+ `Cart + Address` pairs inside ONE single message, split & spawn ALL orders in parallel!
  if (!location && rawText) {
    const blocks = splitMultipleOrderBlocks(rawText);
    if (blocks.length >= 2) {
      await Promise.all(
        blocks.map(block =>
          handleBossForwardedOrderInput(ctx, {
            rawText: block,
            location: null,
            formatOrderBodyFn,
            autoSelectAccount,
            autoGenerateQr,
            nonBlockingAutoSync,
            customRealQrGenerator
          })
        )
      );
      return true;
    }
  }

  let allocatedOrderId = null;
  let shouldAutoSelect = true;
  let shouldAutoQr = false;

  // Phase 1 (<0.2ms PURE IN-MEMORY FIFO SLOT ALLOCATION — ZERO NETWORK CALLS INSIDE SENDER LOCK!):
  // All 10 incoming orders pair & register `AUTO_SELECTING` in <2ms total, then execute HTTP resolution + Swiggy sync 100% IN PARALLEL!
  await withSenderIntakeLock(sender.senderKey, async () => {
    const db = getDb();
    if (!db.orders) db.orders = {};

    shouldAutoSelect = autoSelectAccount !== undefined
      ? Boolean(autoSelectAccount)
      : (db.config?.autoSelectAccount !== false);
    shouldAutoQr = autoGenerateQr !== undefined
      ? Boolean(autoGenerateQr)
      : Boolean(db.config?.autoGenerateQr === true);

    const incomingHint = classifyRawOrderInputFast(rawText, location);
    let order = findIncompleteForwardedOrder(db, sender, incomingHint);

    if (!order) {
      // Never create an order for pure tracking links — they belong to existing orders
      const hasAnyOrderContent = Boolean(incomingHint.hasCart || incomingHint.hasAddress);
      if (!hasAnyOrderContent) {
        // Check if this is a tracking link that should attach to a recent order
        const allUrlsCheck = extractSharedUrls(rawText);
        const isTrackingOnly = allUrlsCheck.some(u => isOfficialSwiggyTrackingUrl(u) || /r\.swiggy\.com.*\/track\//i.test(u));
        if (isTrackingOnly) {
          // Find most recent order for this sender that needs tracking — attach directly and notify
          const recentOrders = Object.values(db.orders || {}).filter(o => o && (o.fwdSenderKey === sender.senderKey || String(o.userId) === String(sender.senderUserId)) && ['COMPLETED','ACCEPTED','PAYMENT_PENDING','APPROVAL_PENDING'].includes(o.status) && !getStoredSwiggyTrackingUrl(o));
          if (recentOrders.length > 0) {
            recentOrders.sort((a,b)=> new Date(b.createdAt||0)-new Date(a.createdAt||0));
            const targetOrder = recentOrders[0];
            const trackingUrl = allUrlsCheck.find(u => isOfficialSwiggyTrackingUrl(u) || /r\.swiggy\.com.*\/track\//i.test(u)) || allUrlsCheck[0];
            if (trackingUrl) {
              targetOrder.trackingLink = trackingUrl;
              targetOrder.trackingLinkSource = 'BOSS_PROVIDED';
              targetOrder.shareTrackUrl = '';
              if (!targetOrder.swiggyOrderId && targetOrder.pendingSwiggyOrderId) targetOrder.swiggyOrderId = targetOrder.pendingSwiggyOrderId;
              upsertOrder(targetOrder.id, targetOrder);
              // SMS band — Swiggy khud recipient ke number par bhejta hai

              try {
                await ctx.reply(`✓ Tracking link attached to ${targetOrder.id}. The bot did not send an SMS; Swiggy's own notification has not been verified.`).catch(()=>{});
              } catch(e){}
            }
            allocatedOrderId = null;
            return;
          }
        }
        // No valid cart/address and not a trackable recent order — don't create empty order
        allocatedOrderId = null;
        return;
      }
      const prefix = sender.isForwarded ? 'FWD' : 'ORD';
      const orderId = generateUniqueOrderId(db, prefix);
      order = {
        id: orderId,
        isForwardedOrder: true,
        isDirectBossOrder: !sender.isForwarded,
        userId: sender.senderUserId || ctx.from.id,
        userName: sender.senderName,
        username: sender.senderUsername || '',
        fwdSenderKey: sender.senderKey,
        fwdSenderUserId: sender.senderUserId,
        fwdSenderName: sender.senderName,
        fwdSenderUsername: sender.senderUsername,
        bossChatId: ctx.chat.id,
        address: null,
        addressOriginalText: null,
        addressDetails: null,
        cart: null,
        items: [],
        subtotal: 0,
        finalPayable: 0,
        status: 'PENDING',
        cardStage: 'COLLECTING',
        activeCardMessageId: null,
        trackedCardMessageIds: [],
        activeQrMessageId: null,
        trackedQrMessageIds: [],
        createdAt: new Date().toISOString()
      };
    }

    if (incomingHint.hasCart) order._pendingCartSlot = incomingHint.primaryCartUrl || 'PENDING_CART';
    if (incomingHint.hasAddress) order._pendingAddrSlot = 'PENDING_ADDR';

    // Lazy Boss mode: remember who the order is for (Ammi/Abbu tag first),
    // and bookmark the forwarded text so a failed fetch can be retried without
    // asking Boss to forward the message again.
    const roleInfo = detectRecipientRole({
      senderName: sender.senderName,
      senderUserId: sender.senderUserId,
      rawText,
      familyMembers: db.config?.familyMembers || null
    });
    order.recipientRole = roleInfo.role;
    order.recipientLabel = roleInfo.label;
    order.recipientRoleSource = roleInfo.source;
    storeIntakeSnapshot(order, { rawText, location });

    const willHaveBoth = Boolean(order.cart || order._pendingCartSlot) && Boolean(order.address || order._pendingAddrSlot);
    if (willHaveBoth && shouldAutoSelect) {
      order.cardStage = 'AUTO_SELECTING';
    }
    upsertOrder(order.id, order);
    allocatedOrderId = order.id;
  });

  if (!allocatedOrderId) {
    // Pure tracking link or empty input — don't create order, silently ignore to prevent fake ₹0 orders
    return true;
  }

  // Phase 2 (PER-ORDER LOCK ONLY — ALL 10 INDEPENDENT ORDERS EXECUTE 100% CONCURRENTLY AT THE EXACT SAME MILLISECOND!):
  const runOrderPipeline = withOrderIngestLock(allocatedOrderId, async () => {
    const db0 = getDb();
    const order = db0.orders?.[allocatedOrderId];
    if (!order) return;

    try {
      // One flaky Swiggy hop must never strand the order: retry the whole
      // resolution once with a short delay (expired carts fail fast — they
      // carry a non-retryable diagnostic code).
      const { updatedCart, updatedAddress } = await retryFetch(
        () => ingestForwardedContentIntoOrder(order, { rawText, location }),
        {
          attempts: 2,
          delays: [900],
          onRetry: (retryErr, attempt) => {
            console.warn(`[LazyFetch] retry ${attempt} for #${order.id}: ${retryErr?.message || retryErr}`);
          }
        }
      );
      delete order.fetchError;
      if (updatedCart) delete order._pendingCartSlot;
      if (updatedAddress) delete order._pendingAddrSlot;

      // A cart link that Swiggy never answered for is NOT a fetched cart: show
      // the rescue card instead of letting the bill sync fail later and report
      // a misleading "no account" error.
      const cartUnreadable = Boolean(order.cart && order.cartUnverified);
      if ((!updatedCart && !updatedAddress) || cartUnreadable) {
        delete order._pendingCartSlot;
        delete order._pendingAddrSlot;
        if (cartUnreadable || (!order.cart && !order.address)) {
          // Keep the order (and its intake snapshot) so the rescue card's
          // "Retry fetch" works without a re-forward.
          order.cardStage = 'FETCH_FAILED';
          order.fetchError = cartUnreadable
            ? 'Cart link mila, par Swiggy se read nahi hua — retry karein.'
            : 'Forward se cart/address link detect nahi hua.';
          order.fetchFailedAt = new Date().toISOString();
          upsertOrder(order.id, order);
          await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        } else {
          if (order.cardStage === 'AUTO_SELECTING') order.cardStage = 'COLLECTING';
          upsertOrder(order.id, order);
          await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        }
        return;
      }
      order.fetchFailedAt = '';
      order.fetchAttempts = (Number(order.fetchAttempts) || 0) + 1;

      const completeNow = Boolean(order.cart) && hasVerifiedDeliveryLocation(order) && hasVerifiedDeliveryContact(order);
      if (completeNow && shouldAutoSelect) {
        order.cardStage = 'AUTO_SELECTING';
        upsertOrder(order.id, order);
        const freshDb = getDb();
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, freshDb, formatOrderBodyFn);
        // Direct SMS to registered mobile on order creation (rare bot feature)
        // SMS band — Swiggy khud bhejega
        const targetOrderId = order.id;
        const targetChatId = ctx.chat.id;
        try {
          // Auto-pick + automatic fallback ladder across the whole vault.
          await autoAssignBestAccountWithFallback({
            telegram: ctx.telegram,
            chatId: targetChatId,
            orderId: targetOrderId,
            formatOrderBodyFn
          });
          // Never create the payment QR before the customer confirms the bill —
          // and, in Lazy Boss mode, never before Boss taps the single
          // [ ✅ Confirm ] button either (unless auto-confirm is explicitly on).
          const syncedDb = getDb();
          const awaitingCustomerApproval = syncedDb.orders?.[targetOrderId]?.status === 'APPROVAL_PENDING';
          const bossAlreadyConfirmed = Boolean(syncedDb.orders?.[targetOrderId]?.bossConfirmedAt);
          const autoConfirmEnabled = syncedDb.config?.autoConfirmOrders === true;
          if (shouldAutoQr && !awaitingCustomerApproval && (bossAlreadyConfirmed || autoConfirmEnabled)) {
            const tgAdapter = typeof ctx.telegram?.sendPhoto === 'function'
              ? ctx.telegram
              : {
                  ...ctx.telegram,
                  sendPhoto: (_cid, photo, extra) => ctx.replyWithPhoto(photo, extra)
                };
            await executeRealQrGenerationForOrder({
              telegram: tgAdapter,
              chatId: targetChatId,
              orderId: targetOrderId,
              formatOrderBodyFn,
              customRealQrGenerator
            });
          }
        } catch (syncErr) {
          const errDb = getDb();
          const failedOrd = errDb.orders?.[targetOrderId] || order;
          releaseSwiggyAccountReservation(failedOrd.selectedAccount, targetOrderId);
          failedOrd.cardStage = 'NEED_ACCOUNT';
          failedOrd.accountSyncError = syncErr.message || 'Could not auto-select Swiggy account.';
          failedOrd.lastAccountError = syncErr.message || 'Could not auto-select Swiggy account.';
          upsertOrder(targetOrderId, failedOrd);
          await postOrReplaceForwardedCard(ctx.telegram, targetChatId, failedOrd, getDb(), formatOrderBodyFn).catch(() => {});
          await sendBossDiagnosticError(ctx, targetChatId, syncErr, {
            stage: 'AUTO_SELECT_ZERO_ORDER_MAX_OFFER_ACCOUNT',
            orderId: targetOrderId,
            senderName: failedOrd.fwdSenderName || failedOrd.userName,
            isForwarded: !failedOrd.isDirectBossOrder,
            cartLink: failedOrd.cart,
            addressSummary: failedOrd.address
          });
        }
        return;
      }

      upsertOrder(order.id, order);
      const freshDb = getDb();
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, freshDb, formatOrderBodyFn);
    } catch (err) {
      delete order._pendingCartSlot;
      delete order._pendingAddrSlot;
      if (!order.cart && !order.address) {
        order.cardStage = 'FETCH_FAILED';
        order.fetchError = String(err?.message || err || 'Fetch failed').slice(0, 300);
        order.fetchFailedAt = new Date().toISOString();
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
      } else {
        if (order.cardStage === 'AUTO_SELECTING') order.cardStage = 'COLLECTING';
        upsertOrder(order.id, order);
      }
      await sendBossDiagnosticError(ctx, ctx.chat?.id, err, {
        stage: 'INGEST_LINK_OR_ADDRESS',
        orderId: order.id,
        senderName: sender.senderName,
        isForwarded: sender.isForwarded,
        cartLink: order.cart || rawText,
        addressSummary: order.address || ''
      });
    }
  });

  if (!nonBlockingAutoSync) {
    await runOrderPipeline;
  }
  return true;
}

export function registerForwardedOrderHandlers(bot, {
  isBoss,
  formatOrderBodyFn,
  customRealQrGenerator = null,
  customPaymentChecker = null
}) {
  // 0. 1-Click Parallel Multi-ID Batch Fetch for ALL ready orders simultaneously!
  bot.action('fwd_parallel_fetch_all', async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    await ctx.answerCbQuery('! Fetching ALL ready orders across separate FREE Swiggy IDs in parallel...');
    try {
      const out = await dispatchAllReadyOrdersInParallel({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        formatOrderBodyFn
      });
      if (out.dispatched === 0) {
        return ctx.reply(`i ${escapeHtml(out.reason)}`, { parse_mode: 'HTML' });
      }
      const failed = out.settled.filter(s => s.status === 'rejected');
      for (const f of failed) {
        await sendBossDiagnosticError(ctx, ctx.chat.id, f.reason, {
          stage: 'PARALLEL_MULTI_ORDER_FETCH'
        });
      }
      const okCount = out.settled.filter(s => s.status === 'fulfilled').length;
      await ctx.reply(
        `! <b>Parallel Multi-ID Sync Complete:</b> <b>${okCount}/${out.dispatched}</b> order bill(s) fetched simultaneously on separate Swiggy IDs!` +
        (out.queuedRemaining > 0 ? `\n<i>(${out.queuedRemaining} more order(s) waiting for a FREE account.)</i>` : ''),
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, { stage: 'PARALLEL_MULTI_ORDER_FETCH' });
    }
  });

  // 0B. 1-Click Parallel Multi-ID Real Swiggy QR Generator for ALL Bill-Ready orders simultaneously!
  bot.action(/^fwd_parallel_qrs_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const db = getDb();
    const readyForQr = getBillReadyOrdersWaitingForQr(db);
    if (readyForQr.length === 0) {
      return ctx.answerCbQuery('No Bill-Ready orders waiting for QR right now.', { show_alert: true });
    }
    await ctx.answerCbQuery(`! Generating ${readyForQr.length} Official Swiggy QRs in parallel...`);
    const settled = await Promise.allSettled(
      readyForQr.map(ord =>
        executeRealQrGenerationForOrder({
          telegram: ctx.telegram,
          chatId: ctx.chat.id,
          orderId: ord.id,
          formatOrderBodyFn,
          customRealQrGenerator
        })
      )
    );
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected') {
        const ord = readyForQr[i];
        await sendBossDiagnosticError(ctx, ctx.chat.id, settled[i].reason, {
          stage: 'PARALLEL_QR_GENERATION',
          orderId: ord.id,
          accountKey: ord.selectedAccount,
          senderName: ord.fwdSenderName || ord.userName
        });
      }
    }
  });

  // 0C. 1-Click Parallel Payment Verification Across ALL Active Swiggy QRs Simultaneously (`10x` Simultaneous Payment!)
  bot.action('fwd_check_all_paid', async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const db = getDb();
    const activeQrs = getActiveQrOrdersWaitingForPayment(db);
    if (activeQrs.length === 0) {
      return ctx.answerCbQuery('No active Swiggy QRs waiting for payment right now.', { show_alert: true });
    }
    await ctx.answerCbQuery(`! Checking all ${activeQrs.length} active payments in parallel...`);
    const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
    const results = await Promise.allSettled(
      activeQrs.map(async (ord) => {
        const curDb = getDb();
        const curOrd = curDb.orders?.[ord.id];
        const acc = curOrd?.selectedAccount ? curDb.config?.accounts?.[curOrd.selectedAccount] : null;
        if (!curOrd || !acc || !acc.isLoggedIn) return { ordId: ord.id, paid: false };
        const liveCheck = await checker(acc, curOrd);
        if (liveCheck?.paid && liveCheck?.swiggyOrderId) {
          await finalizePaidOrderCard({
            telegram: ctx.telegram,
            chatId: ctx.chat.id,
            order: curOrd,
            livePaidResult: liveCheck,
            formatOrderBodyFn
          });
          return { ordId: ord.id, paid: true };
        }
        return { ordId: ord.id, paid: false, state: liveCheck?.txnState || 'pending' };
      })
    );
    const paidCount = results.filter(r => r.status === 'fulfilled' && r.value?.paid).length;
    await ctx.reply(
      `✓ <b>Parallel Payment Check Complete:</b> <b>${paidCount}/${activeQrs.length}</b> order(s) confirmed &amp; tracking extracted!` +
      (paidCount < activeQrs.length ? `\n<i>Remaining ${activeQrs.length - paidCount} QR(s) are still auto-polling every 5s in background.</i>` : ''),
      { parse_mode: 'HTML' }
    );
  });

  // 1. Choose Account -> Sync Cart + Max Coupon IN PARALLEL without blocking any other account!
  bot.action(/^fwd_pick_acc_([A-Za-z0-9_]+)__([A-Za-z0-9_]+)(?:__(FORCE))?$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const accKey = ctx.match[2];
    const forceUse = ctx.match[3] === 'FORCE';

    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }

    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      return ctx.answerCbQuery('Placement may already exist. Check the original Swiggy account; switching is blocked.', { show_alert: true });
    }
    // Protect active unpaid orders on busy IDs unless explicitly confirmed with FORCE!
    if (accKey !== 'BEST' && !forceUse) {
      const busyMap = getBusySwiggyAccountsMap(db, orderId);
      const conflictOrder = busyMap.get(accKey);
      if (conflictOrder) {
        const acc = db.config?.accounts?.[accKey];
        await ctx.answerCbQuery(`! ${acc?.phone || accKey} is currently holding Order #${conflictOrder.id}!`, { show_alert: true });
        return ctx.editMessageText(
          `! <b>Account Busy Warning (#${escapeHtml(orderId)})</b>\n\n` +
          `Swiggy ID <b>${escapeHtml(acc?.name || accKey)} (${escapeHtml(acc?.phone || '')})</b> currently holds active unpaid order <b>#${escapeHtml(conflictOrder.id)}</b> (${escapeHtml(conflictOrder.fwdSenderName || conflictOrder.userName || 'Customer')} • ₹${conflictOrder.finalPayable || 0}).\n\n` +
          `Pick another <b>● FREE</b> Swiggy ID to run both orders simultaneously at the same time, or force-override this ID:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('← Pick Another ● FREE Swiggy ID', `fwd_rechoose_acc_${orderId}`)],
              [Markup.button.callback(`! Force Override ${acc?.phone || accKey}`, `fwd_pick_acc_${orderId}__${accKey}__FORCE`)],
              [Markup.button.callback('× Cancel Order', `fwd_cancel_${orderId}`)]
            ])
          }
        ).catch(() => {});
      }
    }

    await ctx.answerCbQuery(`◷ Syncing on ${accKey === 'BEST' ? 'Best FREE Account (Parallel)' : accKey}...`);
    await ctx.editMessageText(
      `◷ <b>Fetching Live Swiggy Bill &amp; Applying Max Coupon (#${escapeHtml(orderId)})...</b>\n` +
      `${buildSenderHeaderLine(order)}\n\n` +
      `<i>Syncing on <code>${escapeHtml(accKey)}</code> — other Swiggy IDs remain 100% free &amp; parallel!</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('× Cancel Order', `fwd_cancel_${orderId}`)]])
      }
    ).catch(() => {});

    try {
      await executeOrderBillSyncOnAccount({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        orderId,
        accKey,
        formatOrderBodyFn
      });
    } catch (err) {
      const freshDb = getDb();
      const freshOrder = freshDb.orders?.[orderId] || order;
      freshOrder.cardStage = 'NEED_ACCOUNT';
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, freshOrder, freshDb, formatOrderBodyFn).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'SYNC_CART_AND_MAX_COUPON',
        orderId,
        accountKey: accKey,
        accountPhone: freshDb.config?.accounts?.[accKey]?.phone || '',
        senderName: freshOrder.fwdSenderName || freshOrder.userName,
        isForwarded: !freshOrder.isDirectBossOrder,
        cartLink: freshOrder.cart,
        addressSummary: freshOrder.address
      });
    }
  });

  // ===========================================================================
  // INSTANT ID ROTATION — "ek account ek baar hi select hoga, refresh dabao to
  // turant dusra". Boss aur customer dono ke paas yeh buttons hote hain.
  //   1. Selection is LOCAL (vault read) → instant, no offer scan.
  //   2. An ID already picked for this order is never picked again.
  //   3. If the new ID fails to build the bill, the next fresh ID is tried
  //      automatically (no extra taps needed).
  // ===========================================================================
  const rotationStatusIcon = (status) => ({
    FREE: '🟢', MAYBE_USED: '🟡', BUSY: '🟠', USED: '🔵', OFFLINE: '⚪', SUSPENDED: '⛔'
  }[status] || '⚪');

  const rotationRowsText = (order) => {
    const summary = rotationSummary(order);
    if (summary.total === 0) return { summary, line: '⚪ Vault me koi Swiggy ID nahi.' };
    const usedLine = summary.used > 0
      ? ` · is order par ${summary.used} ID use ho chuki`
      : '';
    const suspendedRows = summary.rows.filter((r) => r.status === 'SUSPENDED');
    const suspendedLine = suspendedRows.length > 0
      ? `\n⛔ <b>${suspendedRows.length} ID suspended</b> (order inpar place nahi hoga) — <i>${escapeHtml(String(suspendedRows[0].suspendedReason || suspendedRows[0].reason).slice(0, 120))}</i>`
      : '';
    const current = order.selectedAccount
      ? `<code>${escapeHtml(String(order.orderAccount || order.selectedAccount))}</code>`
      : '<i>koi nahi</i>';
    const line = `⚡ <b>ID rotation:</b> ${current}${usedLine} · bachi hui fresh ID: <b>${summary.remaining}</b>/${summary.total}${suspendedLine}`;
    return { summary, line };
  };

  const canManageAccountChoice = (order, userId) => {
    if (!order) return false;
    if (isBoss(Number(userId))) return true;
    const uid = String(userId || '');
    return Boolean(uid) && [order.userId, order.fwdSenderUserId, order.userChatId]
      .filter(Boolean)
      .some((v) => String(v) === uid);
  };

  // One rotation attempt: mark the new ID, push the (fast) bill, report honestly.
  const runInstantAccountSwitch = async (ctx, orderId, { forcedKey = null, reason = 'next' } = {}) => {
    const db = getDb();
    const order = lookupOrder(db, orderId);
    if (!order) return { success: false, error: 'Order not found' };
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      return { success: false, error: 'Swiggy placement may already exist. Check My Orders on the original account; account switching is blocked.' };
    }

    let target = null;
    if (forcedKey) {
      const row = describeAccountRotation(order).find((r) => String(r.key) === String(forcedKey));
      if (!row) return { success: false, error: 'Ye ID vault me nahi mila' };
      if (row.status === 'OFFLINE') return { success: false, error: `${row.phone} logged out hai — pehle login karein` };
      target = { key: row.key, phone: row.phone, warning: row.status === 'BUSY' ? `⚠️ ${row.phone} dusre live order me hai` : '' };
    } else {
      const pick = pickNextRotationAccount(order);
      if (!pick?.success) return { success: false, error: pick?.error || 'Koi fresh ID nahi mili' };
      target = { key: pick.key, phone: pick.phone, warning: pick.warning || '' };
    }

    const prevKey = order.selectedAccount ? String(order.selectedAccount) : '';
    if (prevKey && prevKey !== target.key) {
      releaseSwiggyAccountReservation(prevKey, order.id);
      // 🔒 Purani ID ka durable lock bhi chhodo — warna wo ID hamesha atki rahegi.
      try {
        const lockDb = getDb();
        const prevAcc = lockDb.config?.accounts?.[prevKey];
        if (prevAcc?.orderLock && String(prevAcc.orderLock.orderId) === String(order.id)) {
          releaseAccountLock(lockDb, prevKey, { orderId: order.id, reason: 'ID switch (naya ID chuna)' });
          saveDb(lockDb);
        }
      } catch {}
    }
    order.usedAccountKeys = [...new Set([...(Array.isArray(order.usedAccountKeys) ? order.usedAccountKeys : []), prevKey].filter(Boolean))];
    order.selectedAccount = target.key;
    order.orderAccount = target.phone;
    order.accountPickerKeys = undefined;
    order.cardStage = 'AUTO_SELECTING';
    order.accountSyncError = '';
    order.lastAccountError = '';
    order.accountSwitchReason = reason;
    order.accountSelectedAt = new Date().toISOString();
    order.pendingSwiggyUpiUri = '';
    order.pendingSwiggyOrderId = '';
    order.pendingSwiggyPaasId = '';
    // 🔒 Nayi ID is order ke naam par lock — deliver/cancel tak kisi aur ko nahi.
    try {
      const lockDb = getDb();
      const res = lockAccountToOrder(lockDb, target.key, order, { phone: target.phone });
      if (res && !res.conflict) saveDb(lockDb);
    } catch {}
    upsertOrder(order.id, order);

    // Card updates IMMEDIATELY (before any network call) — the switch is instant.
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: true }).catch(() => {});

    try {
      await executeOrderBillSyncOnAccount({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        orderId: order.id,
        accKey: target.key,
        formatOrderBodyFn,
        skipAutoOffers: true
      });
      return { success: true, key: target.key, phone: target.phone, warning: target.warning };
    } catch (err) {
      // This ID did not work → it is already marked used, so the automatic retry
      // lands on the NEXT fresh ID (never the same one twice).
      const failedDb = getDb();
      const failed = failedDb.orders?.[order.id];
      if (failed) {
        failed.cardStage = 'NEED_ACCOUNT';
        failed.accountSyncError = String(err?.message || err).slice(0, 220);
        failed.lastAccountError = failed.accountSyncError;
        failed.lastFailedAccount = target.key;
        upsertOrder(failed.id, failed);
      }
      return { success: false, error: String(err?.message || err), key: target.key, phone: target.phone };
    }
  };

  bot.action(/^fwd_next_acc_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = lookupOrder(getDb(), orderId);
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    if (!canManageAccountChoice(order, ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) return ctx.answerCbQuery('Placement may already exist. Check the original Swiggy account.', { show_alert: true });
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Bill approval lock hai — pehle naya bill banayein.', { show_alert: true });
    }
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(order.status))) {
      return ctx.answerCbQuery('Ye order band ho chuka hai.', { show_alert: true });
    }

    const preview = pickNextRotationAccount(order);
    if (!preview?.success) {
      return ctx.answerCbQuery(preview?.error || 'Koi fresh ID nahi mili', { show_alert: true });
    }
    await ctx.answerCbQuery(`⚡ ${preview.phone}`).catch(() => {});

    // Detached: the card already shows the new ID; the bill lands right after.
    void (async () => {
      const attempts = [];
      let current = preview;
      for (let i = 0; i < 3 && current?.success; i++) {
        const out = await runInstantAccountSwitch(ctx, orderId, { forcedKey: current.key, reason: i === 0 ? 'next_id' : 'auto_retry' });
        attempts.push({ phone: current.phone, ok: out.success, error: out.error || '' });
        const currentOrder = lookupOrder(getDb(), orderId);
        if (currentOrder && (isQrGenerationInFlight(currentOrder.id) || placementForChatOrder(currentOrder))) {
          await ctx.reply('Placement may already exist. Check the original Swiggy account; account switching stopped.').catch(() => {});
          return;
        }
        if (out.success) {
          await ctx.reply(
            `⚡ <b>ID switch ho gayi: ${escapeHtml(String(current.phone))}</b>\n` +
            `<i>Offer scan skip (har ID par same offers) — bill turant bana.</i>` +
            (out.warning ? `\n${escapeHtml(out.warning)}` : ''),
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
          ).catch(() => {});
          return;
        }
        const freshDb = getDb();
        const freshOrder = freshDb.orders?.[orderId];
        current = freshOrder ? pickNextRotationAccount(freshOrder) : null;
      }

      const tried = attempts.map((a) => `${a.phone}${a.ok ? ' ✓' : ' ✕'}`).join(', ');
      const lastErr = attempts[attempts.length - 1]?.error || 'ID sync fail';
      const finalDb = getDb();
      const finalOrder = finalDb.orders?.[orderId];
      if (finalOrder) {
        finalOrder.cardStage = 'NEED_ACCOUNT';
        finalOrder.accountSyncError = `${lastErr} (tried: ${tried})`;
        finalOrder.lastAccountError = finalOrder.accountSyncError;
        upsertOrder(finalOrder.id, finalOrder);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, finalOrder, getDb(), formatOrderBodyFn).catch(() => {});
      }
      await ctx.reply(
        `⚠️ <b>ID switch fail:</b> ${escapeHtml(String(lastErr).slice(0, 200))}\n` +
        `<i>Tried: ${escapeHtml(tried)}</i>\n<i>👤 Choose ID se manually pick karein, ya naya account login karein.</i>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      ).catch(() => {});
    })();
  });

  // ⛔ Suspended IDs ko Boss jaan-boojh kar wapas enable kar sakta hai (Swiggy
  // ne block hata diya ho, ya ye galti se flag hui ho).
  bot.action(/^fwd_retry_susp_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = lookupOrder(getDb(), orderId);
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    if (!canManageAccountChoice(order, ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    const rows = describeAccountRotation(order).filter((r) => r.status === 'SUSPENDED');
    if (rows.length === 0) return ctx.answerCbQuery('Koi suspended ID nahi hai.');
    for (const r of rows) markAccountHealthy(r.key, { note: 'manual retry by user' });
    await ctx.answerCbQuery(`⛔ ${rows.length} ID retry ke liye enable`).catch(() => {});
    await ctx.reply(
      `⛔ <b>${rows.length} suspended ID wapas enable</b>\n` +
      rows.map((r) => `• <code>${escapeHtml(r.phone)}</code>`).join('\n') +
      `\n\n<i>Ab ⚡ Next fresh ID dabaiye — bill usi par banega. Agar Swiggy ne sach me block kiya hai to dobara ⛔ ho jayegi (honest).</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
  });

  // Manual picker — every account is a button with an honest status.
  bot.action(/^fwd_pick_acc_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = lookupOrder(getDb(), orderId);
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    if (!canManageAccountChoice(order, ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    await ctx.answerCbQuery('👤 ID chunein').catch(() => {});

    const rows = describeAccountRotation(order);
    const suspendedRows = rows.filter((r) => r.status === 'SUSPENDED');
    const pickable = rows.filter((r) => r.status !== 'OFFLINE' && r.status !== 'SUSPENDED').slice(0, 20);
    // Remember the exact order the buttons were rendered in, so a tap always
    // resolves to the ID the user actually saw.
    const liveDb = getDb();
    const liveOrder = liveDb.orders?.[orderId];
    if (liveOrder) {
      liveOrder.accountPickerKeys = pickable.map((r) => r.key);
      upsertOrder(liveOrder.id, liveOrder);
    }

    const lines = [
      `👤 <b>ID CHOOSE — #${escapeHtml(String(orderId))}</b>`,
      ``,
      `🟢 free · 🟡 shayad order chal raha · 🟠 dusre order me · 🔵 is order par use ho chuki · ⛔ suspended`,
      ``
    ];
    if (pickable.length === 0) {
      lines.push('<i>Koi usable ID nahi — pehle account login karein.</i>');
    } else {
      pickable.slice(0, 12).forEach((r, i) => {
        lines.push(`${rotationStatusIcon(r.status)} ${i + 1}. <code>${escapeHtml(r.phone)}</code>${r.name ? ` · ${escapeHtml(r.name)}` : ''} — <i>${escapeHtml(r.reason)}</i>`);
      });
      lines.push('', '<i>Tap = turant usi ID par bill (offer scan skip).</i>');
    }

    const buttons = pickable.slice(0, 12).map((r, i) => ([
      Markup.button.callback(
        `${rotationStatusIcon(r.status)} ${r.phone}${r.selected ? ' ✓' : ''}`,
        `fwd_set_acc_${orderId}_${i}`
      )
    ]));
    if (suspendedRows.length > 0) {
      lines.push('', `⛔ <b>${suspendedRows.length} ID suspended</b> (inpar order place nahi hoga):`);
      suspendedRows.slice(0, 5).forEach((r) => {
        lines.push(`   • <code>${escapeHtml(r.phone)}</code> — <i>${escapeHtml(r.suspendedReason || r.reason)}</i>`);
      });
      buttons.push([Markup.button.callback('⛔ Suspended ID retry karein', `fwd_retry_susp_${orderId}`)]);
    }
    buttons.push([Markup.button.callback('⚡ Next fresh ID', `fwd_next_acc_${orderId}`)]);
    buttons.push([Markup.button.callback('♻ Reset rotation', `fwd_reset_rot_${orderId}`)]);
    buttons.push([Markup.button.callback('‹ Back to Bill', `fwd_panel_back_${orderId}`)]);

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard(buttons)
    }).catch(() => {});
  });

  bot.action(/^fwd_set_acc_([A-Za-z0-9_]+)_(\d{1,2})$/, async (ctx) => {
    const orderId = ctx.match[1];
    const idx = Number(ctx.match[2]);
    const order = lookupOrder(getDb(), orderId);
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    if (!canManageAccountChoice(order, ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Bill approval lock hai — pehle naya bill banayein.', { show_alert: true });
    }
    const keys = Array.isArray(order.accountPickerKeys) ? order.accountPickerKeys : [];
    const targetKey = keys[idx];
    if (!targetKey) {
      return ctx.answerCbQuery('Picker purana ho gaya — 👤 Choose ID dobara kholein.', { show_alert: true });
    }
    await ctx.answerCbQuery('⚡ Select kar raha hoon…').catch(() => {});
    void (async () => {
      const out = await runInstantAccountSwitch(ctx, orderId, { forcedKey: targetKey, reason: 'manual_pick' });
      if (out.success) {
        await ctx.reply(
          `✅ <b>ID set: ${escapeHtml(String(out.phone))}</b> — bill turant bana (offer scan skip).` +
          (out.warning ? `\n${escapeHtml(out.warning)}` : ''),
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        ).catch(() => {});
      } else {
        await ctx.reply(`⚠️ <b>${escapeHtml(String(out.phone || targetKey))} par bill nahi bana:</b> ${escapeHtml(String(out.error || 'unknown').slice(0, 200))}`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
    })();
  });

  bot.action(/^fwd_reset_rot_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = lookupOrder(getDb(), orderId);
    if (!order) return ctx.answerCbQuery('Order not found', { show_alert: true });
    if (!canManageAccountChoice(order, ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    const db2 = getDb();
    const fresh = db2.orders?.[orderId];
    if (fresh) {
      fresh.usedAccountKeys = [];
      upsertOrder(fresh.id, fresh);
    }
    await ctx.answerCbQuery('♻ Rotation reset').catch(() => {});
    await ctx.reply('♻ <b>Rotation reset</b> — saare ID dobara available hain (agli tap naya ID chunegi).', { parse_mode: 'HTML' }).catch(() => {});
  });

  // 2. Change Auto-Selected Swiggy Account before payment (Auto-cycles to next best ID with ZERO manual picker!)
  bot.action(/^(?:fwd_change_auto_sel|fwd_rechoose_acc)_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    const isOwner = (String(order.userId) === String(ctx.from.id) || String(order.fwdSenderUserId) === String(ctx.from.id));
    if (!isBoss(ctx.from.id) && !isOwner) {
      return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    }
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      return ctx.answerCbQuery('Placement may already exist. Check the original Swiggy account; switching is blocked.', { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer bill approval locks account changes.', { show_alert: true });
    }
    stopOrderPaymentPoller(orderId);

    const prevAccount = order.selectedAccount;
    if (prevAccount) {
      releaseSwiggyAccountReservation(prevAccount, orderId);
      // Rotation memory: the ID we just left is never picked again for this order.
      order.usedAccountKeys = [...new Set([...(Array.isArray(order.usedAccountKeys) ? order.usedAccountKeys : []), String(prevAccount)])];
    }
    order.selectedAccount = null;
    order.cardStage = 'AUTO_SELECTING';
    upsertOrder(order.id, order);

    await ctx.answerCbQuery('🔄 Re-selecting best Swiggy ID in parallel...').catch(() => {});
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: true }).catch(() => {});

    // FIRE-AND-FORGET: the heavy ID scan runs detached with its own deadline and
    // error reporting. The handler returns instantly, so Telegraf can never kill a
    // long scan with `Promise timed out after 240000 milliseconds` while the card
    // stays on "selecting" — the result/error always lands as a card message.
    void (async () => {
      try {
        await executeOrderBillSyncOnAccount({
          telegram: ctx.telegram,
          chatId: ctx.chat.id,
          orderId,
          accKey: 'BEST',
          formatOrderBodyFn,
          excludeAccountKeys: prevAccount ? [prevAccount] : []
        });
      } catch (syncErr) {
        // A hard timeout already released reservations; retrying the SAME budget
        // would just burn another 28s, so go straight to a retry card.
        if (syncErr?.code === 'ID_SELECT_TIMEOUT') {
          const fresh = getDb().orders?.[orderId] || order;
          fresh.cardStage = 'COLLECTING';
          fresh.accountSyncError = syncErr.message;
          fresh.lastAccountError = syncErr.message;
          upsertOrder(fresh.id, fresh);
          await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, fresh, getDb(), formatOrderBodyFn).catch(() => {});
          await ctx.reply(`⏱ <b>ID Selection slow tha</b> — ${escapeHtml(syncErr.message)}`, { parse_mode: 'HTML' }).catch(() => {});
          return;
        }
        try {
          await executeOrderBillSyncOnAccount({
            telegram: ctx.telegram,
            chatId: ctx.chat.id,
            orderId,
            accKey: 'BEST',
            formatOrderBodyFn
          });
        } catch (err2) {
          const fresh = getDb().orders?.[orderId] || order;
          fresh.cardStage = 'COLLECTING';
          fresh.accountSyncError = err2.message || syncErr.message;
          fresh.lastAccountError = err2.message || syncErr.message;
          upsertOrder(fresh.id, fresh);
          await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, fresh, getDb(), formatOrderBodyFn).catch(() => {});
          await ctx.reply(`⚠️ <b>ID Selection Issue:</b> ${escapeHtml(err2.message || syncErr.message)}\n\n<i>Swiggy account sync me issue aaya. Kripya ID check karein ya naya JSON session drop karein.</i>`, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    })();
  });

  // 3. Generate 100% REAL Swiggy Dynamic Merchant UPI QR (parallel across distinct Swiggy IDs!)
  bot.action(/^fwd_gen_qr_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
      return ctx.answerCbQuery('Wait for the customer to approve the bill before generating or sending payment details.', { show_alert: true });
    }

    await ctx.answerCbQuery('! Generating Official Swiggy Payment QR...');
    // Detached so a slow QR can never trip Telegraf's 240s handler watchdog: the
    // QR (or a clear failure reason) always arrives as a normal message.
    void (async () => {
      try {
        const tgAdapter = typeof ctx.telegram?.sendPhoto === 'function'
          ? ctx.telegram
          : {
              ...ctx.telegram,
              sendPhoto: (_cid, photo, extra) => ctx.replyWithPhoto(photo, extra)
            };
        await executeRealQrGenerationForOrder({
          telegram: tgAdapter,
          chatId: ctx.chat.id,
          orderId,
          formatOrderBodyFn,
          customRealQrGenerator,
          // "↻ Regenerate Swiggy QR" = genuinely new QR. Without this the cached
          // QR came back byte-identical ("same QR, same problem").
          forceNewQr: order.cardStage === 'QR_GENERATED' || Boolean(order.pendingSwiggyUpiUri) || Boolean(order.qrInvalidatedAt) || Boolean(order.swiggyPlacedUnpaid)
        });
      } catch (err) {
        const freshDb = getDb();
        const freshOrder = freshDb.orders?.[orderId] || order;
        const acc = freshOrder.selectedAccount ? freshDb.config?.accounts?.[freshOrder.selectedAccount] : null;
        await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
          stage: 'GENERATE_REAL_SWIGGY_QR',
          orderId: freshOrder.id,
          accountKey: freshOrder.selectedAccount,
          accountPhone: acc?.phone || '',
          senderName: freshOrder.fwdSenderName || freshOrder.userName,
          isForwarded: !freshOrder.isDirectBossOrder,
          cartLink: freshOrder.cart,
          addressSummary: freshOrder.address
        });
      }
    })();
  });

  // 4. Verify REAL Payment on Swiggy -> Confirm Order -> Delete Old Card + QR -> Post Real Tracking Card!
  bot.action(/^fwd_check_paid_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }

    const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('! Selected Swiggy account is not logged in!', { show_alert: true });
    }

    try {
      const checker = customPaymentChecker || checkRealSwiggyPaymentAndExtractTracking;
      // Bounded verify: a slow Swiggy answer must report "still checking", never
      // kill the handler with `Promise timed out after 240000 milliseconds`.
      let verifyTimer = null;
      const liveCheck = await Promise.race([
        checker(acc, order),
        new Promise((resolve) => {
          verifyTimer = setTimeout(() => resolve({ paid: false, txnState: 'verify-timeout', gatewayFetchError: 'Swiggy verify timed out (75s)' }), 75_000);
          if (typeof verifyTimer.unref === 'function') verifyTimer.unref();
        })
      ]).finally(() => { if (verifyTimer) clearTimeout(verifyTimer); });

      if (!liveCheck?.paid) {
        // Delay rescue: try All-IDs scan before declaring pending (user clicked I have paid)
        if (!getStoredSwiggyTrackingUrl(order)) {
          try {
            let rescueTimer = null;
            const rescue = await Promise.race([
              extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null),
              new Promise((resolve) => {
                rescueTimer = setTimeout(() => resolve(null), 45_000);
                if (typeof rescueTimer.unref === 'function') rescueTimer.unref();
              })
            ]).finally(() => { if (rescueTimer) clearTimeout(rescueTimer); });
            if (rescue?.trackingUrl) {
              await ctx.answerCbQuery('✓ Payment verified via linked Swiggy account — injecting tracking into payment message...');
              // Build synthetic paid result from rescue
              const syntheticPaid = {
                paid: true,
                swiggyOrderId: rescue.res?.swiggyOrderId || order.pendingSwiggyOrderId || '',
                orderStatus: rescue.res?.orderStatus || 'Order Confirmed',
                nativeShareUrl: rescue.trackingUrl,
                swiggyWebTrackUrl: rescue.trackingUrl,
                deliveryOtp: rescue.res?.deliveryOtp || order.deliveryOtp || '',
                deliveryBoy: rescue.res?.deliveryBoy || null,
                restaurantName: rescue.res?.restaurantName || order.restaurantName || ''
              };
              await finalizePaidOrderCard({ telegram: ctx.telegram, chatId: ctx.chat.id, order, livePaidResult: syntheticPaid, formatOrderBodyFn });
              return;
            }
          } catch {}
        }
        const dbg = [];
        if (liveCheck?.txnState) dbg.push('txn=' + liveCheck.txnState);
        if (liveCheck?.payTxnState) dbg.push('pay=' + liveCheck.payTxnState);
        if (liveCheck?.gatewayFetchError) dbg.push('gw=' + String(liveCheck.gatewayFetchError).slice(0,35));
        if (liveCheck?.postStatusLower) dbg.push('post=' + liveCheck.postStatusLower);
        const stateLabel = liveCheck?.txnState === 'pending' || !liveCheck?.txnState
          ? 'Payment is processing'
          : `Payment status: ${liveCheck.txnState}`;
        await ctx.answerCbQuery(
          ('◷ ' + stateLabel + (dbg.length ? ' (' + dbg.join(' ') + ')' : '') + ' — wait 30s & retry, auto-detect every 5s').slice(0,190),
          { show_alert: true }
        );
        return;
      }

      await ctx.answerCbQuery('✓ Payment Verified on Swiggy! Extracting live tracking link...');
      await finalizePaidOrderCard({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        order,
        livePaidResult: liveCheck,
        formatOrderBodyFn
      });
    } catch (err) {
      await ctx.answerCbQuery('× Error while checking payment — diagnostic sent!', { show_alert: true }).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'VERIFY_PAYMENT_AND_EXTRACT_TRACKING',
        orderId: order.id,
        accountKey: order.selectedAccount,
        accountPhone: acc?.phone || '',
        senderName: order.fwdSenderName || order.userName,
        isForwarded: !order.isDirectBossOrder,
        cartLink: order.cart
      });
    }
  });

  // 5. Cancel Order at ANY Stage (immediately frees that Swiggy ID back to `● FREE`!)
  bot.action(/^fwd_cancel_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) return ctx.answerCbQuery('Order already removed', { show_alert: true });
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      return ctx.answerCbQuery('The bot cannot cancel a possibly placed Swiggy order. Check/cancel it in the original Swiggy account.', { show_alert: true });
    }
    stopOrderPaymentPoller(orderId);

    const freedAccKey = order.selectedAccount;
    const freedAcc = freedAccKey ? db.config?.accounts?.[freedAccKey] : null;
    if (freedAccKey) {
      releaseSwiggyAccountReservation(freedAccKey, orderId);
    }

    // Flush unpaid cart cleanly & atomically inside per-account lock before returning (~180ms)!
    if (freedAcc && (freedAcc.cookies || freedAcc.tid || freedAcc.token) && order.status !== 'COMPLETED') {
      await withSwiggyAccountLock(freedAccKey, () =>
        swiggyCartFlush(freedAcc).catch(() => {})
      ).catch(() => {});
    }

    order.status = 'CANCELLED';
    order.cardStage = 'CANCELLED';
    order.cancelledAt = new Date().toISOString();

    await deleteOrderBotMessages(ctx.telegram, ctx.chat.id, order, { includeQr: true });
    upsertOrder(order.id, order);

    await ctx.answerCbQuery('Order Cancelled — Account freed!');
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `× <b>Order Cancelled (#${escapeHtml(order.id)})</b> — ${buildSenderHeaderLine(order)}` +
      (freedAcc ? `\n● <i>Account ${escapeHtml(freedAcc.phone || freedAccKey)} is now FREE for new orders!</i>` : ''),
      { parse_mode: 'HTML' }
    );
  });

  // 6. Force Re-Scan Max Coupon + Breakfast/Late Night Free Cash on Current Account
  // ===========================================================================
  // OFFER & CASH PANEL — one place for items, cart link, coupons, free cash.
  // Boss AND the customer both get these buttons (permission checked inside).
  // ===========================================================================
  const panelWait = new Map(); // userId -> { orderId, kind }

  const canManageOrder = (order, userId) => {
    if (!order) return false;
    const uid = String(userId || '');
    if (isBoss(Number(userId))) return true;
    return Boolean(uid) && [order.userId, order.fwdSenderUserId, order.userChatId]
      .filter(Boolean)
      .some((v) => String(v) === uid);
  };

  const money = (n) => `₹${Math.round(Number(n || 0) * 100) / 100}`;

  // ---- USER CONTROLS (ON/OFF switches) --------------------------------------
  // Every switch below is a real button and a real behaviour change: coupon
  // engine, free-cash relock, Swiggy One auto-add and item offers can each be
  // turned off by the BOSS or the CUSTOMER from the same panel.
  const CONTROL_KEYS = ['coupon', 'freeCash', 'swiggyOne', 'itemOffers'];
  const CONTROL_META = {
    coupon: { on: '🎟 Coupon', off: '🎟 Coupon' },
    freeCash: { on: '💸 Free cash', off: '💸 Free cash' },
    swiggyOne: { on: '⭐ Swiggy One', off: '⭐ Swiggy One' },
    itemOffers: { on: '🏷 Item offers', off: '🏷 Item offers' }
  };
  const orderControls = (order) => {
    const raw = (order && typeof order.controls === 'object' && order.controls) ? order.controls : {};
    const out = {};
    for (const key of CONTROL_KEYS) out[key] = raw[key] !== false;
    return out;
  };
  const controlStateLabel = (order, key) => {
    const on = orderControls(order)[key];
    return `${on ? '✅' : '⛔'} ${CONTROL_META[key].on}: ${on ? 'ON' : 'OFF'}`;
  };
  const buildControlRows = (order) => {
    const id = order.id;
    return [
      [
        Markup.button.callback(controlStateLabel(order, 'coupon'), `fwd_tgl_${id}_coupon`),
        Markup.button.callback(controlStateLabel(order, 'freeCash'), `fwd_tgl_${id}_freeCash`)
      ],
      [
        Markup.button.callback(controlStateLabel(order, 'swiggyOne'), `fwd_tgl_${id}_swiggyOne`),
        Markup.button.callback(controlStateLabel(order, 'itemOffers'), `fwd_tgl_${id}_itemOffers`)
      ]
    ];
  };

  const panelCouponList = (order) => {
    const list = Array.isArray(order?.availableCoupons) ? order.availableCoupons : [];
    const active = String(order?.couponCode || '').toUpperCase();
    return [...list].sort((a, b) => {
      if (a.code === active) return -1;
      if (b.code === active) return 1;
      const pa = Number.isFinite(Number(a.finalPayable)) ? Number(a.finalPayable) : Number(a.discountAmount || 0) * -1;
      const pb = Number.isFinite(Number(b.finalPayable)) ? Number(b.finalPayable) : Number(b.discountAmount || 0) * -1;
      return pa - pb;
    });
  };

  const panelSummaryLines = (order) => {
    const lines = [
      `🛠 <b>OFFER & CASH PANEL</b>`,
      `<b>#${escapeHtml(String(order.id))}</b>${order.swiggyOrderId ? ` · Swiggy <code>${escapeHtml(String(order.swiggyOrderId))}</code>` : ''}`,
      ''
    ];
    lines.push(`▪ <b>Item total:</b> ${money(order.itemTotal || order.subtotal)}`);
    if (order.couponCode) lines.push(`▪ <b>Coupon:</b> <code>${escapeHtml(String(order.couponCode))}</code> (−${money(order.discountAmount)})`);
    else lines.push(`▪ <b>Coupon:</b> <i>koi nahi</i>`);
    const freeCash = Number(order.campaignFreeCash || 0) + Number(order.walletSplitPayAmount || 0);
    if (freeCash > 0) lines.push(`▪ <b>Free cash / wallet:</b> −${money(freeCash)}`);
    else lines.push(`▪ <b>Free cash:</b> <i>abhi 0 — "Refresh Cash" dabaiye</i>`);
    if (Number(order.freeCashBalance || 0) > 0) lines.push(`▪ <b>Wallet balance:</b> ${money(order.freeCashBalance)}`);
    lines.push(`▪ <b>Payable:</b> <b>${money(order.finalPayable)}</b>`);
    if (order.selectedAccount) lines.push(`▪ <b>Swiggy ID:</b> <code>${escapeHtml(String(order.orderAccount || order.selectedAccount))}</code>`);
    if (order.address) lines.push(`▪ <b>Address:</b> ${escapeHtml(String(order.address).slice(0, 70))}`);
    const ctl = orderControls(order);
    lines.push('', `⚙ <b>Switches:</b> Coupon ${ctl.coupon ? 'ON' : 'OFF'} · Free cash ${ctl.freeCash ? 'ON' : 'OFF'} · Swiggy One ${ctl.swiggyOne ? 'ON' : 'OFF'} · Item offers ${ctl.itemOffers ? 'ON' : 'OFF'}`);
    lines.push(`<i>Har button turant kaam karta hai — bill dono (boss + customer) me update hota hai.</i>`);
    return lines;
  };

  const buildPanelKeyboard = (order) => {
    const id = order.id;
    return Markup.inlineKeyboard([
      ...buildControlRows(order),
      [
        Markup.button.callback('✎ Items / Qty +−', `fwd_panel_items_${id}`),
        Markup.button.callback('🔗 Import Cart Link', `fwd_panel_import_${id}`)
      ],
      [
        Markup.button.callback('🎟 Coupons / Change', `fwd_panel_coupons_${id}`),
        Markup.button.callback('🔄 Refresh Cash', `fwd_panel_cash_${id}`)
      ],
      [
        Markup.button.callback('🧹 Clear Cart', `fwd_panel_clear_${id}`),
        Markup.button.callback('↻ Re-scan All Offers', `fwd_panel_rescan_${id}`)
      ],
      [
        Markup.button.callback('⚡ Next ID (instant)', `fwd_next_acc_${id}`),
        Markup.button.callback('👤 Choose ID', `fwd_pick_acc_${id}`)
      ],
      [Markup.button.callback('‹ Back to Bill', `fwd_panel_back_${id}`)]
    ]);
  };

  // The panel is sent to BOTH parties (boss + customer) — "dono ko send".
  const sendPanelToBoth = async (ctx, order, text, keyboard) => {
    const chatIds = new Set();
    const add = (v) => { if (v) chatIds.add(String(v)); };
    add(ctx.chat?.id);
    add(order.userChatId); add(order.userId); add(order.fwdSenderUserId); add(order.bossChatId);
    const db = getDb();
    for (const bossId of (Array.isArray(db.config?.bossIds) ? db.config.bossIds : [])) add(bossId);
    let sent = 0;
    for (const chatId of chatIds) {
      try {
        await ctx.telegram.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...keyboard
        });
        sent += 1;
      } catch {}
    }
    return sent;
  };

  const replyPanel = async (ctx, order, extraLines = [], { edit = true } = {}) => {
    const lines = panelSummaryLines(order).concat(extraLines.length ? ['', ...extraLines] : []);
    const text = lines.join('\n');
    const keyboard = buildPanelKeyboard(order);
    if (edit) {
      const ok = await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...keyboard
      }).then(() => true).catch(() => false);
      if (ok) return true;
    }
    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard
    }).catch(() => {});
    return true;
  };

  // Re-price the order after a coupon/cash/cart change and push the new card to
  // both parties (they both must see the same bill).
  const refreshBillAndNotifyBoth = async (ctx, order, note = '') => {
    const freshDb = getDb();
    const fresh = freshDb.orders?.[order.id] || order;
    fresh.cardStage = fresh.cardStage === 'QR_GENERATED' ? 'QR_GENERATED' : 'BILL_READY';
    upsertOrder(fresh.id, fresh);
    const latest = getDb().orders?.[fresh.id] || fresh;
    const targets = new Set();
    const add = (v) => { if (v) targets.add(String(v)); };
    add(ctx.chat?.id); add(latest.userChatId); add(latest.userId); add(latest.fwdSenderUserId); add(latest.bossChatId);
    for (const bossId of (Array.isArray(getDb().config?.bossIds) ? getDb().config.bossIds : [])) add(bossId);
    for (const chatId of targets) {
      await postOrReplaceForwardedCard(ctx.telegram, chatId, latest, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
    }
    if (note) {
      await ctx.reply(note, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => {});
    }
    return latest;
  };

  const loadOrderForPanel = (ctx, orderId) => {
    const db = getDb();
    const order = lookupOrder(db, orderId);
    if (!order) {
      ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {});
      return null;
    }
    if (!canManageOrder(order, ctx.from?.id)) {
      ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
      return null;
    }
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      ctx.answerCbQuery('Checkout is in progress or unresolved. Check the original Swiggy account; do not change or retry this cart.', { show_alert: true }).catch(() => {});
      return null;
    }
    return order;
  };

  const panelAccount = (order) => {
    const db = getDb();
    const key = order?.selectedAccount;
    const acc = key ? db.config?.accounts?.[key] : null;
    return { key, acc };
  };

  // NOTE: this generic pattern must NOT swallow the sub-actions
  // (`fwd_panel_items_…`, `fwd_panel_cash_…`, …) — Telegraf runs only the first
  // matching handler, so a bare `[A-Za-z0-9_]+` would shadow every one of them.
  bot.action(/^fwd_panel_(?!items_|import_|cancelinput_|coupons_|cash_|clear_|rescan_|cartrefresh_|back_)([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    await ctx.answerCbQuery('🛠 Offer & Cash panel').catch(() => {});
    const sent = await sendPanelToBoth(ctx, order, panelSummaryLines(order).join('\n'), buildPanelKeyboard(order));
    if (sent === 0) await replyPanel(ctx, order);
  });

  bot.action(/^fwd_panel_back_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    await ctx.answerCbQuery('‹ Bill').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    const freshDb = getDb();
    const fresh = freshDb.orders?.[order.id] || order;
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, fresh, freshDb, formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
  });

  // ---- 1) ITEMS / QUANTITY (+ / − / remove) — real buttons -------------------
  const buildItemQuantityView = (order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    const lines = [`✎ <b>ITEMS / QUANTITY — #${escapeHtml(String(order.id))}</b>`, ''];
    if (items.length === 0) {
      lines.push('<i>Cart khaali hai — 🔗 Import Cart Link se cart laayein.</i>');
    } else {
      items.slice(0, 12).forEach((it, i) => {
        const qty = Number(it.qty || it.quantity || 1);
        lines.push(`${i + 1}. ${escapeHtml(String(it.name || it.itemId || 'Item'))} × <b>${qty}</b> — ${money(Number(it.price || 0) * qty)}`);
      });
      if (items.length > 12) lines.push(`<i>… +${items.length - 12} more (pehle 12 hi adjust ho sakte hain)</i>`);
      lines.push('', `▪ <b>Items total:</b> ${money(order.itemTotal)}`);
      lines.push(`▪ <b>Payable:</b> <b>${money(order.finalPayable)}</b>`);
      lines.push('', '<i>➖ / ➕ seedha Swiggy cart me lagta hai. 0 par 🗑 item hat jayega. Naya QR dobara banega.</i>');
    }
    const rows = [];
    items.slice(0, 12).forEach((it, i) => {
      const label = String(it.name || it.itemId || 'Item').slice(0, 14);
      const qty = Number(it.qty || it.quantity || 1);
      rows.push([
        Markup.button.callback(`➖ ${label}`, `fwd_qty_${order.id}_${i}_minus`),
        Markup.button.callback(`${qty}×`, `fwd_panel_items_${order.id}`),
        Markup.button.callback(`➕`, `fwd_qty_${order.id}_${i}_plus`)
      ]);
      rows.push([
        Markup.button.callback(`🗑 Remove ${label}`, `fwd_qty_${order.id}_${i}_remove`)
      ]);
    });
    rows.push([Markup.button.callback('🔗 Import Cart Link', `fwd_panel_import_${order.id}`)]);
    rows.push([Markup.button.callback('↻ Cart Refresh', `fwd_panel_cartrefresh_${order.id}`)]);
    rows.push([Markup.button.callback('‹ Panel', `fwd_panel_${order.id}`)]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
  };

  bot.action(/^fwd_panel_items_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    await ctx.answerCbQuery('✎ Items / Qty').catch(() => {});
    const view = buildItemQuantityView(order);
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...view.keyboard
    }).catch(() => {});
  });

  // ➕ / ➖ / 🗑 — one tap = one real Swiggy cart change.
  bot.action(/^fwd_qty_([A-Za-z0-9_]+)_(\d{1,2})_(plus|minus|remove)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    const index = Number(ctx.match[2]);
    const action = ctx.match[3];
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer approval lock hai — pehle naya bill banayein.', { show_alert: true });
    }
    const { key: accKey, acc } = panelAccount(order);
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('Koi logged-in Swiggy ID nahi — pehle ID select karein.', { show_alert: true });
    }
    const item = (order.items || [])[index];
    if (!item) return ctx.answerCbQuery('Item cart me nahi mila (refresh karein).', { show_alert: true });
    const itemName = String(item.name || item.itemId || 'Item').slice(0, 30);
    await ctx.answerCbQuery(action === 'plus' ? `➕ ${itemName}` : action === 'minus' ? `➖ ${itemName}` : `🗑 ${itemName}`).catch(() => {});
    const wait = await ctx.reply('◷ <i>Swiggy cart update…</i>', { parse_mode: 'HTML' }).catch(() => null);
    try {
      const before = JSON.stringify((order.items || []).map((it) => [it.name, it.qty || it.quantity]));
      const res = await withSwiggyAccountLock(accKey, () => adjustOrderItemQuantity(acc, order, {
        index,
        delta: action === 'plus' ? 1 : action === 'minus' ? -1 : 0,
        setQty: action === 'remove' ? 0 : null
      }));
      if (!res?.success) throw new Error(res?.error || 'Cart update fail');
      upsertOrder(order.id, order);
      if (wait) { try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
      const note = action === 'remove'
        ? `🗑 <b>${escapeHtml(itemName)}</b> cart se hata diya — naya bill dono ko bhej diya.`
        : (res.changed === false
          ? `ℹ️ <b>${escapeHtml(itemName)}</b> ki quantity pehle se wahi hai.`
          : `${action === 'plus' ? '➕' : '➖'} <b>${escapeHtml(itemName)}</b> → ab <b>${Number(res.quantity) || 0}×</b> — naya bill dono ko bhej diya.`);
      console.log(`[PanelQty] ${order.id} ${itemName} ${action}: ${before} -> ${JSON.stringify((order.items || []).map((it) => [it.name, it.qty || it.quantity]))}`);
      if (res.empty) {
        // Empty cart = no bill to show. Keep COLLECTING and ask for a new cart.
        order.cardStage = 'COLLECTING';
        order.items = [];
        upsertOrder(order.id, order);
        const emptyNote = '🧹 <b>Cart khaali ho gaya</b> — 🔗 Import Cart Link se naya cart bhejein.';
        await sendPanelToBoth(
          ctx,
          order,
          panelSummaryLines(order).join('\n') + '\n\n' + emptyNote,
          buildPanelKeyboard(order)
        );
        await ctx.reply(`${note}\n${emptyNote}`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => {});
        return;
      }
      const latest = await refreshBillAndNotifyBoth(ctx, order, note);
      await sendPanelToBoth(ctx, latest, buildItemQuantityView(latest).text, buildItemQuantityView(latest).keyboard);
    } catch (err) {
      if (wait) { try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
      await ctx.reply(`❌ <b>Quantity change nahi hua:</b> ${escapeHtml(String(err?.message || err).slice(0, 180))}\n<i>Cart refresh karke dobara try karein.</i>`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ---- 1b) ON/OFF SWITCHES ---------------------------------------------------
  bot.action(/^fwd_tgl_([A-Za-z0-9_]+)_(coupon|freeCash|swiggyOne|itemOffers)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    const key = ctx.match[2];
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer approval lock hai — pehle naya bill banayein.', { show_alert: true });
    }
    const current = orderControls(order);
    const nextValue = !current[key];
    const label = CONTROL_META[key].on;
    await ctx.answerCbQuery(`${nextValue ? '✅' : '⛔'} ${label} ${nextValue ? 'ON' : 'OFF'}`).catch(() => {});
    order.controls = { ...current, [key]: nextValue };
    const notes = [`${nextValue ? '✅' : '⛔'} <b>${label} ${nextValue ? 'ON' : 'OFF'}</b> — dono taraf lag gaya.`];

    const { key: accKey, acc } = panelAccount(order);
    try {
      // Turning the coupon switch OFF must really remove the live coupon.
      if (key === 'coupon' && !nextValue && order.couponCode && acc && acc.isLoggedIn) {
        const removed = await withSwiggyAccountLock(accKey, () =>
          applyLiveCouponToOrder(acc, order, 'REMOVE', { fastSingleEngine: false })
        ).catch(() => null);
        if (removed?.items?.length) {
          Object.assign(order, {
            couponCode: removed.couponCode || null,
            discountAmount: Number(removed.discountAmount || 0),
            finalPayable: Number(removed.finalPayable || order.finalPayable),
            itemTotal: Number(removed.itemTotal || order.itemTotal),
            campaignFreeCash: Number(removed.campaignFreeCash || 0),
            walletSplitPayAmount: Number(removed.walletSplitPayAmount || 0)
          });
          notes.push('🎟 Live coupon hata diya gaya.');
        } else {
          notes.push('⚠️ Swiggy ne coupon remove confirm nahi kiya — bill refresh karke check karein.');
        }
      }
      // Turning free cash OFF with money already applied: state it plainly.
      if (key === 'freeCash' && !nextValue) {
        notes.push('💸 Aage free-cash relock nahi hoga. Jo credit Swiggy ne already diya hai wo bill me wahi rahega.');
      }
      // Any switch change can move the total → old QR is stale.
      order.pendingSwiggyUpiUri = '';
      order.pendingSwiggyOrderId = '';
      order.pendingSwiggyPaasId = '';
      if (order.cardStage === 'QR_GENERATED') order.cardStage = 'BILL_READY';
      upsertOrder(order.id, order);
      const latest = await refreshBillAndNotifyBoth(ctx, order, notes.join('\n'));
      await sendPanelToBoth(ctx, latest, panelSummaryLines(latest).join('\n'), buildPanelKeyboard(latest));
    } catch (err) {
      upsertOrder(order.id, order);
      await ctx.reply(`⚠️ <b>Switch update:</b> ${escapeHtml(String(err?.message || err).slice(0, 160))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ---- 2) IMPORT CART LINK (text input) -------------------------------------
  bot.action(/^fwd_panel_import_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    panelWait.set(String(ctx.from.id), { orderId: order.id, kind: 'cart' });
    await ctx.answerCbQuery('🔗 Cart link bhejein').catch(() => {});
    await ctx.reply(
      `🔗 <b>Cart link import — #${escapeHtml(String(order.id))}</b>\n\n` +
      `Swiggy app → cart → <b>Share</b> → link copy karke yahan paste karein.\n` +
      `<i>(Ya poori cart text bhej dein — bot khud items nikaal lega.)</i>\n\n` +
      `<i>Cancel: /cancel</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('✕ Cancel', `fwd_panel_cancelinput_${order.id}`)]])
      }
    ).catch(() => {});
  });

  bot.action(/^fwd_panel_cancelinput_([A-Za-z0-9_]+)$/, async (ctx) => {
    panelWait.delete(String(ctx.from.id));
    await ctx.answerCbQuery('Cancelled').catch(() => {});
    await ctx.editMessageText('✕ Cart import cancel ho gaya.').catch(() => {});
  });

  // Text listener: runs BEFORE the global menu/order dispatcher (registered
  // earlier), and passes everything else straight through with next().
  bot.on('text', async (ctx, next) => {
    const uid = String(ctx.from?.id || '');
    const wait = panelWait.get(uid);
    if (!wait) return next();
    const raw = String(ctx.message?.text || '').trim();
    if (/^\/cancel$/i.test(raw)) {
      panelWait.delete(uid);
      return ctx.reply('✕ Cancelled.');
    }
    panelWait.delete(uid);

    const db = getDb();
    const order = db.orders?.[wait.orderId] || lookupOrder(db, wait.orderId);
    if (!order) return next();
    if (!canManageOrder(order, ctx.from?.id)) return next();
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      return ctx.reply('Checkout in progress or unresolved. Check the original Swiggy account; do not change the cart.');
    }

    const { key: accKey, acc } = panelAccount(order);
    if (!acc || (!acc.cookies && !acc.tid && !acc.token)) {
      return ctx.reply('⚠️ Pehle koi logged-in Swiggy ID select karein (🔄 Change Auto Selection).');
    }
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.reply('⚠️ Customer bill approval lock hai — pehle naya bill banayein.');
    }

    const isLink = /https?:\/\/|swiggy\.com|swig\.gy|onelink\.me/i.test(raw);
    const looksLikeCartText = /items?\s*total|final bill|your cart|cart/i.test(raw);
    if (!isLink && !looksLikeCartText) {
      return ctx.reply(
        '⚠️ Ye cart link ya cart text nahi lagta.\nSwiggy cart ka share link paste karein (https://www.swiggy.com/... ya r.swiggy.com/...).',
        { parse_mode: 'HTML' }
      );
    }

    const statusMsg = await ctx.reply('◷ <i>Cart import + live bill bana raha hoon…</i>', { parse_mode: 'HTML' }).catch(() => null);
    try {
      if (isLink) {
        order.cart = raw;
        order.addressOriginalText = order.addressOriginalText || order.address || '';
      } else {
        // Raw Swiggy cart text: keep it as the source so the parser can read items.
        order.cartText = raw;
        order.cart = order.cart || '';
      }
      // A new cart means the old bill/coupon/QR is stale.
      order.couponCode = null;
      order.discountAmount = 0;
      order.pendingSwiggyUpiUri = '';
      order.pendingSwiggyOrderId = '';
      order.cardStage = 'AUTO_SELECTING';
      upsertOrder(order.id, order);
      clearCouponTrialCache();

      const fresh = getDb().orders?.[order.id] || order;
      const res = await withSwiggyAccountLock(accKey, () => syncGroupCartAndCheckoutForAccount(acc, fresh, { captureScreenshot: false }));
      if (!res?.success) throw new Error(res?.error || 'Cart import failed');
      // IMPORTANT: persist the SAME object the sync wrote to. `getDb()` re-reads
      // the db file, so taking the order from a second `getDb()` here would save
      // a copy without the freshly synced items/bill (cart looked empty).
      const saved = fresh;
      saved.availableCoupons = (res.availableCoupons || []).slice(0, 14).map((c) => ({
        code: String(c.code || '').toUpperCase(),
        title: String(c.title || c.code || '').slice(0, 60),
        description: String(c.description || '').slice(0, 80),
        discountAmount: Number(c.discountAmount || 0),
        finalPayable: c.finalPayable === null || c.finalPayable === undefined ? null : Number(c.finalPayable)
      }));
      saved.cardStage = 'BILL_READY';
      upsertOrder(saved.id, saved);
      if (statusMsg) { try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }
      const latest = await refreshBillAndNotifyBoth(ctx, saved);
      await replyPanel(ctx, latest, [`✓ <b>Naya cart import ho gaya</b> — bill dono ko bhej diya.`], { edit: false });
    } catch (err) {
      if (statusMsg) { try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }
      await ctx.reply(`❌ <b>Cart import fail:</b> ${escapeHtml(String(err?.message || err).slice(0, 200))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ---- 3) COUPONS: har offer ka apna button --------------------------------
  bot.action(/^fwd_panel_coupons_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    await ctx.answerCbQuery('🎟 Coupons').catch(() => {});
    const coupons = panelCouponList(order);
    const active = String(order.couponCode || '').toUpperCase();
    const lines = [`🎟 <b>COUPONS — #${escapeHtml(String(order.id))}</b>`, ''];
    if (coupons.length === 0) {
      lines.push('<i>Is scan me koi coupon list nahi mili.</i>');
      lines.push('↻ <b>Re-scan All Offers</b> dabaiye — Swiggy se taaza coupons aayenge.');
    } else {
      lines.push(`<i>${coupons.length} offer mile. Jo lagana hai uspar tap karein:</i>`);
      coupons.slice(0, 10).forEach((c) => {
        const tag = c.code === active ? ' ✓ (laga hua)' : '';
        const amt = Number(c.discountAmount || 0) > 0 ? ` −${money(c.discountAmount)}` : '';
        lines.push(`• <code>${escapeHtml(c.code)}</code>${amt}${tag}`);
      });
    }
    lines.push('', `<i>Coupon badalne par bill turant re-price hoga (dono ko naya card).</i>`);
    const rows = coupons.slice(0, 10).map((c) => {
      const amt = Number(c.discountAmount || 0) > 0 ? ` −${money(c.discountAmount)}` : '';
      return [Markup.button.callback(`${c.code === active ? '✓ ' : '🎟 '}${c.code}${amt}`, `fwd_cpn_${order.id}_${c.code}`)];
    });
    if (order.couponCode) rows.push([Markup.button.callback('✕ Coupon hatao', `fwd_cpn_${order.id}_REMOVE`)]);
    rows.push([Markup.button.callback('↻ Naye coupons dhundo', `fwd_panel_rescan_${order.id}`)]);
    rows.push([Markup.button.callback('‹ Panel', `fwd_panel_${order.id}`)]);
    const sent = await sendPanelToBoth(ctx, order, lines.join('\n'), Markup.inlineKeyboard(rows));
    if (sent === 0) {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard(rows) }).catch(() => {});
    }
  });

  bot.action(/^fwd_cpn_([A-Za-z0-9_]+)_([A-Z0-9_-]{3,28}|REMOVE)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    const code = String(ctx.match[2] || '').toUpperCase();
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer approval lock hai — pehle naya bill banayein.', { show_alert: true });
    }
    const { key: accKey, acc } = panelAccount(order);
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('Koi logged-in Swiggy ID nahi — pehle ID select karein.', { show_alert: true });
    }
    await ctx.answerCbQuery(code === 'REMOVE' ? 'Coupon hata raha hoon…' : `Coupon ${code} laga raha hoon…`).catch(() => {});
    try {
      const parsed = await withSwiggyAccountLock(accKey, () =>
        applyLiveCouponToOrder(acc, order, code === 'REMOVE' ? 'REMOVE' : code, { fastSingleEngine: false })
      );
      if (!parsed || !parsed.items?.length) throw new Error('Swiggy ne cart return nahi kiya');
      if (code !== 'REMOVE' && (String(parsed.couponCode || '').toUpperCase() !== code || Number(parsed.discountAmount || 0) <= 0)) {
        throw new Error(`Swiggy ne ${code} accept nahi kiya (is cart/ID par eligible nahi)`);
      }
      Object.assign(order, {
        couponCode: parsed.couponCode || null,
        discountAmount: Number(parsed.discountAmount || 0),
        finalPayable: Number(parsed.finalPayable || order.finalPayable),
        itemTotal: Number(parsed.itemTotal || order.itemTotal),
        totalSavings: Number(parsed.totalSavings || order.totalSavings),
        campaignFreeCash: Number(parsed.campaignFreeCash || 0),
        walletSplitPayAmount: Number(parsed.walletSplitPayAmount || 0)
      });
      upsertOrder(order.id, order);
      // Any old QR belongs to the previous price — never let them pay the stale one.
      if (order.pendingSwiggyUpiUri || order.pendingSwiggyOrderId) {
        order.pendingSwiggyUpiUri = '';
        order.pendingSwiggyOrderId = '';
        order.pendingSwiggyPaasId = '';
        order.cardStage = 'BILL_READY';
        upsertOrder(order.id, order);
      }
      const latest = await refreshBillAndNotifyBoth(
        ctx,
        order,
        code === 'REMOVE'
          ? '✓ Coupon hata diya — naya bill dono ko bhej diya.'
          : `✓ Coupon <code>${escapeHtml(code)}</code> lag gaya (−${money(order.discountAmount)}) — naya bill dono ko bhej diya.`
      );
      await replyPanel(ctx, latest, [`✓ Coupon <b>${escapeHtml(code === 'REMOVE' ? 'removed' : code)}</b> applied.`], { edit: false });
    } catch (err) {
      await ctx.reply(`❌ <b>Coupon ${escapeHtml(code)} nahi laga:</b> ${escapeHtml(String(err?.message || err).slice(0, 180))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ---- 4) REFRESH CASH / FREE CASH -----------------------------------------
  bot.action(/^fwd_panel_cash_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    const { key: accKey, acc } = panelAccount(order);
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('Koi logged-in Swiggy ID nahi.', { show_alert: true });
    }
    await ctx.answerCbQuery('🔄 Free cash refresh…').catch(() => {});
    const wait = await ctx.reply('◷ <i>Late-night / breakfast free cash claim + bill refresh…</i>', { parse_mode: 'HTML' }).catch(() => null);
    try {
      // Chaaron offers ek hi engine se (double claim band: shared ledger + single-flight).
      const { autoActivateEventOffers } = await import('./swiggy-bridge.js');
      const claim = await autoActivateEventOffers(acc, { force: false, skipIfRunInFlight: true }).catch(() => null);
      const relock = await withSwiggyAccountLock(accKey, () => applyLiveFreeCashRelock(acc, order, { claimWaitMs: 4000 })).catch(() => null);
      // A cheap re-read makes sure the totals on screen match Swiggy exactly.
      const res = await withSwiggyAccountLock(accKey, () => syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false })).catch(() => null);
      if (res?.success) {
        Object.assign(order, {
          itemTotal: Number(res.cartData?.itemTotal ?? (order.itemTotal || 0)),
          subtotal: Number(res.cartData?.subtotal ?? (order.subtotal || 0)),
          couponCode: res.cartData?.couponCode || order.couponCode || null,
          discountAmount: Number(res.cartData?.discountAmount || 0),
          campaignFreeCash: Number(res.cartData?.campaignFreeCash || 0),
          walletSplitPayAmount: Number(res.cartData?.walletSplitPayAmount || 0),
          freeCashApplied: Number(res.cartData?.freeCashApplied || 0),
          freeCashBalance: Number(res.cartData?.freeCashBalance || 0),
          finalPayable: Number(res.cartData?.finalPayable || order.finalPayable),
          totalSavings: Number(res.cartData?.totalSavings || order.totalSavings)
        });
        if (Array.isArray(res.availableCoupons) && res.availableCoupons.length) {
          order.availableCoupons = res.availableCoupons.slice(0, 14).map((c) => ({
            code: String(c.code || '').toUpperCase(),
            title: String(c.title || c.code || '').slice(0, 60),
            description: String(c.description || '').slice(0, 80),
            discountAmount: Number(c.discountAmount || 0),
            finalPayable: c.finalPayable === null || c.finalPayable === undefined ? null : Number(c.finalPayable)
          }));
        }
      }
      upsertOrder(order.id, order);
      if (wait) { try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }

      const fc = Number(order.campaignFreeCash || 0) + Number(order.walletSplitPayAmount || 0);
      const bf = claim?.breakfast?.slotState || '?';
      const ln = claim?.lateNight?.slotState || '?';
      const stateLine =
        fc > 0
          ? `✓ <b>Free cash lag gaya: −${money(fc)}</b>`
          : `⚠️ <b>Free cash abhi 0</b> — ${escapeHtml(relock?.note || relock?.reason || 'Swiggy ne is cart par credit nahi diya')}`;
      const lines = [
        `🔄 <b>CASH REFRESH — #${escapeHtml(String(order.id))}</b>`,
        '',
        `▪ Breakfast offer: <code>${escapeHtml(bf)}</code>`,
        `▪ Late-night offer: <code>${escapeHtml(ln)}</code>`,
        `▪ ${stateLine}`,
        `▪ Coupon: ${order.couponCode ? `<code>${escapeHtml(String(order.couponCode))}</code> (−${money(order.discountAmount)})` : '<i>none</i>'}`,
        `▪ <b>Naya payable: ${money(order.finalPayable)}</b>`
      ];
      const latest = await refreshBillAndNotifyBoth(ctx, order);
      await sendPanelToBoth(ctx, latest, lines.join('\n'), buildPanelKeyboard(latest));
    } catch (err) {
      if (wait) { try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
      await ctx.reply(`❌ <b>Cash refresh fail:</b> ${escapeHtml(String(err?.message || err).slice(0, 180))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ---- 5) CLEAR CART --------------------------------------------------------
  bot.action(/^fwd_panel_clear_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    const { key: accKey, acc } = panelAccount(order);
    if (!acc || !acc.isLoggedIn) return ctx.answerCbQuery('Koi logged-in Swiggy ID nahi.', { show_alert: true });
    await ctx.answerCbQuery('🧹 Cart clear…').catch(() => {});
    try {
      await withSwiggyAccountLock(accKey, () => swiggyCartFlush(acc)).catch(() => null);
      order.items = [];
      order.cart = '';
      order.cartText = '';
      order.couponCode = null;
      order.discountAmount = 0;
      order.campaignFreeCash = 0;
      order.walletSplitPayAmount = 0;
      order.finalPayable = 0;
      order.itemTotal = 0;
      order.availableCoupons = [];
      order.pendingSwiggyUpiUri = '';
      order.pendingSwiggyOrderId = '';
      order.pendingSwiggyPaasId = '';
      order.cardStage = 'COLLECTING';
      upsertOrder(order.id, order);
      panelWait.set(String(ctx.from.id), { orderId: order.id, kind: 'cart' });
      await ctx.reply(
        `🧹 <b>Cart clear ho gaya — #${escapeHtml(String(order.id))}</b>\n\n` +
        `Ab Swiggy app se naya cart banakar uska <b>share link</b> yahan paste karein.\n` +
        `<i>Items aur bill turant refresh ho jayenge, dono ko card chala jayega.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('✕ Cancel', `fwd_panel_cancelinput_${order.id}`)]])
        }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ <b>Clear cart fail:</b> ${escapeHtml(String(err?.message || err).slice(0, 160))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ---- 6) CART REFRESH / RE-SCAN ALL OFFERS --------------------------------
  const runPanelRescan = async (ctx, order, { keepCoupon = false } = {}) => {
    const { key: accKey, acc } = panelAccount(order);
    if (!acc || !acc.isLoggedIn) return ctx.answerCbQuery('Koi logged-in Swiggy ID nahi.', { show_alert: true });
    const wait = await ctx.reply('↻ <i>Swiggy se taaza offers + free cash…</i>', { parse_mode: 'HTML' }).catch(() => null);
    try {
      clearCouponTrialCache();
      // Chaaron offers ek hi engine se (double claim band).
      const { autoActivateEventOffers } = await import('./swiggy-bridge.js');
      await autoActivateEventOffers(acc, { force: false, skipIfRunInFlight: true }).catch(() => null);
      if (!keepCoupon) order.couponCode = null;
      const res = await withSwiggyAccountLock(accKey, () => syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false }));
      if (!res?.success) throw new Error(res?.error || 'Re-scan failed');
      Object.assign(order, {
        itemTotal: Number(res.cartData?.itemTotal ?? (order.itemTotal || 0)),
        subtotal: Number(res.cartData?.subtotal ?? (order.subtotal || 0)),
        couponCode: res.cartData?.couponCode || order.couponCode || null,
        discountAmount: Number(res.cartData?.discountAmount || 0),
        campaignFreeCash: Number(res.cartData?.campaignFreeCash || 0),
        walletSplitPayAmount: Number(res.cartData?.walletSplitPayAmount || 0),
        freeCashApplied: Number(res.cartData?.freeCashApplied || 0),
        finalPayable: Number(res.cartData?.finalPayable || order.finalPayable),
        totalSavings: Number(res.cartData?.totalSavings || order.totalSavings)
      });
      order.availableCoupons = (res.availableCoupons || []).slice(0, 14).map((c) => ({
        code: String(c.code || '').toUpperCase(),
        title: String(c.title || c.code || '').slice(0, 60),
        description: String(c.description || '').slice(0, 80),
        discountAmount: Number(c.discountAmount || 0),
        finalPayable: c.finalPayable === null || c.finalPayable === undefined ? null : Number(c.finalPayable)
      }));
      order.cardStage = order.cardStage === 'QR_GENERATED' ? 'BILL_READY' : order.cardStage;
      order.pendingSwiggyUpiUri = '';
      order.pendingSwiggyOrderId = '';
      upsertOrder(order.id, order);
      if (wait) { try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
      const latest = await refreshBillAndNotifyBoth(ctx, order);
      await replyPanel(ctx, latest, [`✓ Re-scan ho gaya — ${Array.isArray(latest.availableCoupons) ? latest.availableCoupons.length : 0} offer mile.`], { edit: false });
    } catch (err) {
      if (wait) { try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
      await ctx.reply(`❌ <b>Re-scan fail:</b> ${escapeHtml(String(err?.message || err).slice(0, 180))}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  };

  bot.action(/^fwd_panel_rescan_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    await ctx.answerCbQuery('↻ Re-scan all offers…').catch(() => {});
    await runPanelRescan(ctx, order);
  });

  bot.action(/^fwd_panel_cartrefresh_([A-Za-z0-9_]+)$/, async (ctx) => {
    const order = loadOrderForPanel(ctx, ctx.match[1]);
    if (!order) return;
    await ctx.answerCbQuery('↻ Cart refresh…').catch(() => {});
    await runPanelRescan(ctx, order, { keepCoupon: true });
  });

  bot.action(/^fwd_rescan_max_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    if (isQrGenerationInFlight(order.id) || placementForChatOrder(order)) {
      return ctx.answerCbQuery('Placement may already exist; do not change the cart. Check Swiggy My Orders.', { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer bill approval locks offer and bill changes.', { show_alert: true });
    }
    const accKey = order.selectedAccount;
    const acc = accKey ? db.config?.accounts?.[accKey] : null;
    if (!acc || !acc.isLoggedIn) {
      return ctx.answerCbQuery('! Select a logged-in Swiggy account first!', { show_alert: true });
    }
    await ctx.answerCbQuery('▣ Re-claiming Free Cash & testing all Max Coupons...').catch(() => {});
    try {
      // Chaaron offers ek hi engine se (double claim band).
      const { autoActivateEventOffers } = await import('./swiggy-bridge.js');
      await autoActivateEventOffers(acc, { force: false, skipIfRunInFlight: true }).catch(() => null);
      order.couponCode = null;
      await withSwiggyAccountLock(accKey, async () => {
        const res = await syncGroupCartAndCheckoutForAccount(acc, order, { captureScreenshot: false });
        if (!res?.success) throw new Error(res?.error || 'Re-scan sync failed');
      });
      order.cardStage = 'BILL_READY';
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, db, formatOrderBodyFn, { includeQrDelete: true });
    } catch (err) {
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, { stage: 'RESCAN_MAX_OFFER', orderId: order.id, accountKey: accKey });
    }
  });

  // 7. Screen 02 -> Screen 03: Send Clean Bill Confirmation Summary to Customer (Sending summary is NOT approval!)
  bot.action(/^fwd_send_summary_([A-Za-z0-9_-]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
      // The summary is automatic now; this button becomes an explicit resend.
      if (!order.billSummarySentAt) {
        return ctx.answerCbQuery('Bill summary is already awaiting customer approval.', { show_alert: true });
      }
      const resend = await sendBillSummaryToCustomerOnce(ctx.telegram, order, { db, force: true });
      if (!resend?.sent) {
        return ctx.answerCbQuery(
          `Could not resend the bill summary: ${resend?.reason || 'delivery failed'}.`,
          { show_alert: true }
        );
      }
      const resentDb = getDb();
      const resentOrder = resentDb.orders?.[orderId] || order;
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, resentOrder, resentDb, formatOrderBodyFn).catch(() => {});
      return ctx.answerCbQuery('✓ Bill summary resent to the customer (same bill, same QR later).');
    }
    if (['COMPLETED', 'CANCELLED', 'REJECTED', 'PAYMENT_PENDING'].includes(order.status) || order.billApprovedByUser || !['BILL_READY', 'QR_GENERATED'].includes(order.cardStage)) {
      return ctx.answerCbQuery('Only a verified bill awaiting customer approval can be sent.', { show_alert: true });
    }
    if (Number(order.finalPayable || 0) <= 0) {
      return ctx.answerCbQuery('The verified amount is invalid; no approval card was sent.', { show_alert: true });
    }
    const targetUserId = order.fwdSenderUserId || order.userId;
    if (!targetUserId) {
      return ctx.answerCbQuery('Customer chat ID is not available. Ask them to start the bot first.', { show_alert: true });
    }
    const previousStatus = order.status;
    const previousUxStage = order.uxStage;
    order.status = 'APPROVAL_PENDING';
    order.uxStage = 'SCREEN_03_BILL_CONFIRMATION';
    upsertOrder(order.id, order);
    const summaryView = buildTelegramUserBillConfirmationCard({ ...order, userId: targetUserId });
    try {
      await ctx.telegram.sendMessage(targetUserId, summaryView.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...summaryView.keyboard
      });
    } catch (error) {
      order.status = previousStatus;
      order.uxStage = previousUxStage || 'SCREEN_02_BILL_READY';
      upsertOrder(order.id, order);
      return ctx.answerCbQuery(`Could not send bill summary: ${String(error?.message || 'Telegram delivery failed.').slice(0, 130)}`, { show_alert: true });
    }
    const freshDb = getDb();
    const freshOrder = freshDb.orders?.[orderId] || order;
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, freshOrder, freshDb, formatOrderBodyFn).catch(() => {});
    await ctx.answerCbQuery('✓ Bill summary sent — awaiting explicit approval!');
  });

  // Retry retrieval only. Never synthesize a tracking URL or create another payment QR.
  bot.action(/^fwd_retry_track_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    let order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    let acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    // Fallback: if selected account missing/expired, try all accounts automatically
    if ((!acc || !order.swiggyOrderId) && Object.keys(db.config?.accounts || {}).length > 0) {
      const allRes = await extractTrackingViaAllAccounts(order, { getAccountsFn: () => db.config.accounts }).catch(() => null);
      if (allRes?.trackingUrl) {
        order.trackingLink = allRes.trackingUrl;
        order.trackingLinkSource = 'SWIGGY_API';
        order.shareTrackUrl = '';
        if (allRes.res?.deliveryOtp) order.deliveryOtp = allRes.res.deliveryOtp;
        if (allRes.res?.orderStatus) order.liveOrderStatus = allRes.res.orderStatus;
        if (allRes.res?.swiggyOrderId) order.swiggyOrderId = allRes.res.swiggyOrderId;
        order.selectedAccount = allRes.accKey || order.selectedAccount;
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
        await sendOrderDeliveryInfoNotice(ctx.telegram, ctx.chat.id, order);
        return ctx.answerCbQuery('✓ Tracking extracted via ' + (allRes.acc?.phone || allRes.accKey) + ' (All IDs scan)', { show_alert: true });
      }
    }
    if (!acc || !order.swiggyOrderId) {
      return ctx.answerCbQuery('Swiggy tracking is not available for this order yet.', { show_alert: true });
    }

    const refreshed = await checkRealSwiggyPaymentAndExtractTracking(acc, order).catch(() => null);
    if (!refreshed?.paid || (refreshed.swiggyOrderId && String(refreshed.swiggyOrderId) !== String(order.swiggyOrderId))) {
      return ctx.answerCbQuery('… Swiggy has not published new tracking details yet.', { show_alert: true });
    }

    const previousUrl = getStoredSwiggyTrackingUrl(order);
    const nextCandidateUrl = refreshed.nativeShareUrl || refreshed.swiggyWebTrackUrl || '';
    const nextUrl = nextCandidateUrl
      ? getStoredSwiggyTrackingUrl({ trackingLink: nextCandidateUrl, trackingLinkSource: 'SWIGGY_API' })
      : '';
    const previousOtp = String(order.deliveryOtp || '');
    const nextOtpDigits = String(refreshed.deliveryOtp || '').replace(/\D/g, '');
    const nextOtp = /^\d{4,8}$/.test(nextOtpDigits) ? nextOtpDigits : '';
    if (nextUrl) {
      order.trackingLink = nextUrl;
      order.trackingLinkSource = 'SWIGGY_API';
      order.shareTrackUrl = '';
    }
    if (nextOtp) order.deliveryOtp = nextOtp;
    order.liveOrderStatus = refreshed.orderStatus || order.liveOrderStatus || 'Order Confirmed';
    if (refreshed.etaMinutes) order.etaMinutes = refreshed.etaMinutes;
    if (refreshed.deliveryBoy?.name) order.deliveryBoyName = refreshed.deliveryBoy.name;
    if (refreshed.deliveryBoy?.mobile) order.deliveryBoyMobile = refreshed.deliveryBoy.mobile;
    upsertOrder(order.id, order);
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
    if ((nextUrl && nextUrl !== previousUrl) || (nextOtp && nextOtp !== previousOtp)) {
      await sendOrderDeliveryInfoNotice(ctx.telegram, ctx.chat.id, order);
    }

    const hasInfo = Boolean(getStoredSwiggyTrackingUrl(order) || order.deliveryOtp);
    return ctx.answerCbQuery(
      hasInfo ? '✓ Swiggy tracking details refreshed.' : '… Swiggy has not shared a tracking link or delivery OTP yet.',
      { show_alert: !hasInfo }
    );
  });

  // Dedicated Extract Delivery Link — scans ALL logged-in IDs, not just selectedAccount
  bot.action(/^fwd_extract_all_([A-Za-z0-9_-]+)$/, async (ctx) => {
    if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
    const orderId = ctx.match[1];
    const db = getDb();
    const order = lookupOrder(db, orderId);
    if (!order) {
      console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
      return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true });
    }
    await ctx.answerCbQuery('Scanning all Swiggy IDs for the live tracking link…').catch(() => {});
    const accountCount = Object.keys(db.config?.accounts || {}).length;
    const scanMsg = await ctx.reply(
      `⏳ <i>Scanning ${accountCount} logged-in Swiggy IDs for the live tracking link…</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    try {
      const result = await ensureOrderTracking(order.id, { force: true, budgetMs: 20000, deep: true });
      if (scanMsg) { try { await ctx.telegram.deleteMessage(ctx.chat.id, scanMsg.message_id); } catch {} }

      const fresh = getDb().orders?.[order.id] || order;
      const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
      const swiggyId = String(fresh.swiggyOrderId || order.swiggyOrderId || '—');
      const phone = String(fresh.selectedAccountPhone || order.selectedAccountPhone || '');

      if (!trackingUrl) {
        if (result?.hasOrder) {
          const rawLiveStatus = String(fresh.liveOrderStatus || result.orderStatus || 'Order Confirmed');
          const liveStatus = rawLiveStatus;
          const cancelled = /cancel|refus|return/i.test(liveStatus);
          const delivered = !cancelled && /deliv/i.test(liveStatus);
          const deliveredUrl = delivered ? buildSignedOrderTrackUrl(fresh) : '';
          await ctx.reply(
            `✅ <b>${delivered && deliveredUrl ? 'Tracking link ready' : 'Order Swiggy par mil gaya'}</b>\n` +
            `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
            `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
            `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>` +
            (deliveredUrl ? `\n▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredUrl)}">Open order tracking</a>` : '') +
            (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '') +
            (fresh.deliveryBoyName || fresh.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([fresh.deliveryBoyName, fresh.deliveryBoyMobile].filter(Boolean).join(' · '))}` : '') +
            `\n\n` +
            (cancelled
              ? `<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`
              : delivered
                ? `<i>Order delivered hai — live order summary &amp; map link upar taiyaar hai.</i>`
                : `<i>Swiggy ne share link abhi publish nahi kiya. Bot background me retry karta rahega aur link aate hi bhej dega.</i>`),
            {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...(!cancelled
                ? Markup.inlineKeyboard([
                    ...(deliveredUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredUrl)]] : []),
                    [Markup.button.callback('🔄 Re-check Swiggy Link', `fwd_extract_all_${order.id}`)]
                  ])
                : {})
            }
          );
          if (!cancelled && !delivered) startOrderTrackingAuto(order.id, { force: true, budgetMs: 12000 });
        } else {
          await ctx.reply(
            `❌ <b>No tracking link found on any ID yet.</b>\n` +
            `▪ Scanned <b>${Number(result?.scanned) || 0}</b> IDs${result?.status === 'TIMEOUT' ? ' (time out)' : ''}\n` +
            `▪ Swiggy order id: <code>${escapeHtml(swiggyId)}</code>\n\n` +
            `<i>Swiggy may not have published it yet. Bot retry karta rahega — koi fake link nahi banaya jayega.</i>`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('↗ Add Swiggy tracking manually', `boss_tracking_${order.id}`)]]) }
          );
          startOrderTrackingAuto(order.id, { force: true, budgetMs: 12000 });
        }
        return;
      }

      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, fresh, getDb(), formatOrderBodyFn, { includeQrDelete: false }).catch(() => {});
      await sendOrderDeliveryInfoNotice(ctx.telegram, ctx.chat.id, fresh, { force: true });
      await ctx.reply(
        `✅ <b>Tracking extracted!</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open Swiggy tracking</a>` +
        (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : ''),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard([[Markup.button.url('↗ Open tracking', trackingUrl)]]) }
      );
    } catch (e) {
      if (scanMsg) { try { await ctx.telegram.deleteMessage(ctx.chat.id, scanMsg.message_id); } catch {} }
      await ctx.reply(`❌ Extract failed: ${escapeHtml(String(e?.message || e))}`, { parse_mode: 'HTML' });
    }
  });

  // =========================================================================
  // 8. LAZY BOSS AUTOPILOT — one forward, one tap, zero babysitting
  // =========================================================================
  // Boss forwards Ammi/Abbu's chat into the bot. From here he should only ever
  // need ONE tap: [ ✅ Confirm · for Ammi · ₹248 ]. Everything else
  // (fetch retry, best-ID fallback, tracking) self-heals in the background.
  const resolveLazyOrder = (ctx, orderId) => {
    const db = getDb();
    const order = lookupOrder(db, orderId);
    return { db, order };
  };
  const canOperateLazyOrder = (ctx, order) =>
    isBoss(ctx.from.id) ||
    String(order?.userId) === String(ctx.from.id) ||
    String(order?.fwdSenderUserId) === String(ctx.from.id);

  // 8A. ONE-TAP CONFIRM → official Swiggy QR (this IS the confirmation step)
  bot.action(/^lazy_confirm_([A-Za-z0-9_]+)$/, async (ctx) => {
    if (_isLazyRateLimited(ctx.from.id, 5, 60_000)) return ctx.answerCbQuery('⏳ Thoda slow — 1 min me max 5 taps!', { show_alert: true }).catch(()=>{});
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    if (order.status === 'COMPLETED') return ctx.answerCbQuery('✓ This order is already paid and confirmed.', { show_alert: true });
    if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer ka bill approval pending hai — uske approve karne ke baad QR jayega.', { show_alert: true });
    }
    if (order.cardStage === 'QR_GENERATED' && order.activeQrMessageId) {
      return ctx.answerCbQuery('✓ Payment QR already bheja gaya hai — QR scan karke pay karein.', { show_alert: true });
    }
    if (!['BILL_READY', 'NEED_ACCOUNT', 'QR_GENERATED'].includes(order.cardStage)) {
      return ctx.answerCbQuery('! Pehle cart + address complete hone dein — bot abhi fetch kar raha hai.', { show_alert: true });
    }

    const who = recipientLabelOf(order);
    await ctx.answerCbQuery(`✅ Confirmed for ${who} — QR ban raha hai...`).catch(() => {});

    order.bossConfirmedAt = order.bossConfirmedAt || new Date().toISOString();
    order.bossConfirmedBy = String(ctx.from.id);
    order.bossConfirmedName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim() || 'Boss';
    order.confirmedRecipient = who;
    upsertOrder(order.id, order);

    const tgAdapter = typeof ctx.telegram?.sendPhoto === 'function'
      ? ctx.telegram
      : { ...ctx.telegram, sendPhoto: (_cid, photo, extra) => ctx.replyWithPhoto(photo, extra) };

    try {
      await executeRealQrGenerationForOrder({
        telegram: tgAdapter,
        chatId: ctx.chat.id,
        orderId,
        formatOrderBodyFn,
        customRealQrGenerator
      });
    } catch (err) {
      // Self-heal: transient account/WAF problems get one automatic re-pick +
      // one automatic QR retry before Boss hears about it.
      if (err?.diag?.placementAttempted !== true && !placementForChatOrder(order) && isRetryableFetchError(err)) {
        try {
          await autoAssignBestAccountWithFallback({ telegram: ctx.telegram, chatId: ctx.chat.id, orderId, formatOrderBodyFn });
          await executeRealQrGenerationForOrder({
            telegram: tgAdapter,
            chatId: ctx.chat.id,
            orderId,
            formatOrderBodyFn,
            customRealQrGenerator
          });
          return;
        } catch (retryErr) {
          err = retryErr;
        }
      }
      const freshDb = getDb();
      const freshOrder = freshDb.orders?.[orderId] || order;
      freshOrder.cardStage = 'NEED_ACCOUNT';
      freshOrder.accountSyncError = String(err?.message || err || 'QR generation failed').slice(0, 300);
      upsertOrder(freshOrder.id, freshOrder);
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, freshOrder, getDb(), formatOrderBodyFn).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, {
        stage: 'LAZY_CONFIRM_GENERATE_QR',
        orderId,
        accountKey: freshOrder.selectedAccount,
        senderName: freshOrder.fwdSenderName || freshOrder.userName,
        isForwarded: !freshOrder.isDirectBossOrder,
        cartLink: freshOrder.cart,
        addressSummary: freshOrder.address
      });
    }
  });

  // 8B. RETRY FETCH — replays the stored forward; Boss never re-sends anything
  bot.action(/^lazy_fetch_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    const rawText = String(order.lastIntakeRawText || '');
    const location = order.lastIntakeLocation || null;
    if (!rawText && !location) {
      return ctx.answerCbQuery('Original message stored nahi hai — cart link ya address dobara bhej dein.', { show_alert: true });
    }
    await ctx.answerCbQuery('↻ Retrying the same forward...').catch(() => {});

    try {
      const { updatedCart, updatedAddress } = await retryFetch(
        () => ingestForwardedContentIntoOrder(order, { rawText, location }),
        { attempts: 3, delays: [500, 1500] }
      );
      delete order._pendingCartSlot;
      delete order._pendingAddrSlot;
      const cartUnreadable = Boolean(order.cart && order.cartUnverified);
      const complete = Boolean(order.cart) && !cartUnreadable &&
        hasVerifiedDeliveryLocation(order) && hasVerifiedDeliveryContact(order);
      const progress = !cartUnreadable && Boolean(updatedCart || updatedAddress || order.cart || order.address);
      if (!progress) {
        order.cardStage = 'FETCH_FAILED';
        order.fetchError = 'Retry bhi fail hua — link expire ho sakta hai ya galat forward hai.';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        return;
      }
      delete order.fetchError;
      order.fetchFailedAt = '';
      if (complete) {
        order.cardStage = 'AUTO_SELECTING';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
        await autoAssignBestAccountWithFallback({ telegram: ctx.telegram, chatId: ctx.chat.id, orderId, formatOrderBodyFn });
      } else {
        order.cardStage = 'COLLECTING';
        upsertOrder(order.id, order);
        await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
      }
    } catch (err) {
      order.cardStage = 'FETCH_FAILED';
      order.fetchError = String(err?.message || err).slice(0, 300);
      upsertOrder(order.id, order);
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
    }
  });

  // 8C. BEST ID DOBARA — walks the fallback ladder across every logged-in ID
  bot.action(/^lazy_best_id_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
      return ctx.answerCbQuery('Customer approval ke baad ID change lock hai.', { show_alert: true });
    }
    const previous = order.selectedAccount;
    if (previous) releaseSwiggyAccountReservation(previous, orderId);
    order.selectedAccount = null;
    order.cardStage = 'AUTO_SELECTING';
    order.accountSyncError = '';
    order.lastAccountError = '';
    upsertOrder(order.id, order);
    await ctx.answerCbQuery('🔄 Best ID dobara dhoond raha hoon...').catch(() => {});
    await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn, { includeQrDelete: true }).catch(() => {});
    try {
      await autoAssignBestAccountWithFallback({
        telegram: ctx.telegram,
        chatId: ctx.chat.id,
        orderId,
        formatOrderBodyFn,
        excludeAccountKeys: previous ? [previous] : []
      });
    } catch (err) {
      order.cardStage = 'NEED_ACCOUNT';
      order.accountSyncError = String(err?.message || err).slice(0, 300);
      upsertOrder(order.id, order);
      await postOrReplaceForwardedCard(ctx.telegram, ctx.chat.id, order, getDb(), formatOrderBodyFn).catch(() => {});
      await sendBossDiagnosticError(ctx, ctx.chat.id, err, { stage: 'LAZY_BEST_ID_RETRY', orderId });
    }
  });

  // 8D. TRACKING ABHI — force scan + always return something clickable
  bot.action(/^lazy_track_([A-Za-z0-9_]+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const { order } = resolveLazyOrder(ctx, orderId);
    if (!order) return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true });
    if (!canOperateLazyOrder(ctx, order)) return ctx.answerCbQuery('Unauthorized', { show_alert: true });
    await ctx.answerCbQuery('🔗 Swiggy tracking dhoond raha hoon...').catch(() => {});

    let scan = null;
    try { scan = await ensureOrderTracking(orderId, { force: true, budgetMs: 20000, deep: true }); } catch {}
    const fresh = getDb().orders?.[orderId] || order;
    const delivery = resolveTrackingDelivery(fresh, { storedUrl: getStoredSwiggyTrackingUrl(fresh) });
    const swiggyId = String(fresh.swiggyOrderId || fresh.pendingSwiggyOrderId || '—');
    const otpLine = fresh.deliveryOtp ? `\n⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '';
    const header = delivery.isOfficial
      ? `✅ <b>Tracking link ready (#${escapeHtml(fresh.id)})</b>`
      : `◷ <b>Tracking abhi publish nahi hua (#${escapeHtml(fresh.id)})</b>`;

    await ctx.reply(
      `${header}\n` +
      `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      `▪ <b>${delivery.isOfficial ? 'Tracking' : 'Swiggy orders page'}:</b> <a href="${escapeHtml(delivery.url)}">Open</a>` +
      `${otpLine}\n\n` +
      `<i>${delivery.isOfficial ? 'Yeh Swiggy ka apna link hai.' : trackingRetryPromiseText(Number(fresh.trackingRetryCount) || 0)}</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([
          [Markup.button.url(delivery.isOfficial ? '↗ Open Swiggy tracking' : '↗ Swiggy My Orders', delivery.url)],
          [Markup.button.callback('↻ Tracking dobara check', lazyActionId('track', fresh.id))]
        ])
      }
    ).catch(() => {});
    if (!delivery.isOfficial) {
      try { startOrderTrackingAuto(fresh.id, { force: true, budgetMs: 12000 }); } catch {}
    }
  });
}

// =========================================================================
// Telegram button-driven update handler for Boss forwarded / direct orders
// =========================================================================
export async function applyBossOrderUpdate({
  telegram,
  bossChatId,
  orderId,
  cart = '',
  address = '',
  location = null,
  formatOrderBodyFn
}) {
  const db = getDb();
  const order = db?.orders?.[orderId];
  if (!order) return { ok: false, error: `Order #${orderId} not found.` };
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return { ok: false, error: `Order #${orderId} is ${order.status.toLowerCase()} and cannot be edited.` };
  }
  if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
    return { ok: false, error: 'The bill has been sent for approval or approved; ask the customer to report an issue before changing delivery details.' };
  }
  const swiggyCheckoutStarted = Boolean(isQrGenerationInFlight(order.id) || placementForChatOrder(order) || order.cardStage === 'QR_GENERATED');
  if (swiggyCheckoutStarted && (cart || address || location)) {
    return { ok: false, error: 'Cart and delivery details cannot be edited after Swiggy has created a payment QR/order. Resolve or cancel the existing Swiggy order first.' };
  }
  if (!cart && !address && !location) {
    return { ok: false, error: 'Send a cart link, delivery address, recipient mobile, or GPS pin.' };
  }

  let updatedCart = false;
  let updatedAddr = false;

  if (location) {
    try {
      const locationResult = await ingestForwardedContentIntoOrder(order, { location });
      if (locationResult.error) return { ok: false, error: locationResult.error };
      updatedAddr = Boolean(locationResult.updatedAddress);
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not resolve this delivery pin.' };
    }
  }

  if (cart && cart !== order.cart) {
    try {
      const resCart = await ingestForwardedContentIntoOrder(order, { rawText: cart });
      if (!resCart.updatedCart) {
        return { ok: false, error: 'Invalid Swiggy Cart link. Send a genuine Swiggy cart or group-cart link.' };
      }
      updatedCart = true;
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not verify this Swiggy cart link.' };
    }
  }

  if (address && address !== order.address && address !== order.addressOriginalText) {
    let resAddr;
    try {
      resAddr = await ingestForwardedContentIntoOrder(order, { rawText: address });
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not verify these delivery details.' };
    }
    if (resAddr.error) return { ok: false, error: resAddr.error };
    if (!resAddr.updatedAddress && address.trim().length >= 12) {
      // Keep manually entered street addresses, but checkout remains blocked until
      // geocoding supplies verified coordinates and a separate recipient mobile.
      const plainGeo = await geocodeAddressDetails({ address: address.trim(), raw: address.trim() }).catch(() => ({ address: address.trim() }));
      order.address = plainGeo.address || address.trim();
      order.addressOriginalText = address.trim();
      order.addressDetails = plainGeo;
      updatedAddr = true;
    } else if (!resAddr.updatedAddress) {
      return { ok: false, error: 'Invalid delivery details. Send a Swiggy/Google Maps address, full street address, or the recipient’s 10-digit Indian mobile after the address is saved.' };
    } else {
      updatedAddr = true;
    }
  }

  upsertOrder(order.id, order);

  const readyForCheckout = Boolean(
    order.cart &&
    hasVerifiedDeliveryLocation(order) &&
    hasVerifiedDeliveryContact(order)
  );
  if (readyForCheckout) {
    try {
      await executeOrderBillSyncOnAccount({
        telegram,
        chatId: bossChatId,
        orderId: order.id,
        accKey: order.selectedAccount || 'BEST',
        formatOrderBodyFn
      });
      return {
        ok: true,
        message: 'Cart, verified Indian delivery location, and recipient mobile are ready. Swiggy bill and eligible offers are being checked.'
      };
    } catch (syncErr) {
      await postOrReplaceForwardedCard(telegram, bossChatId, order, getDb(), formatOrderBodyFn).catch(() => {});
      return {
        ok: true,
        message: `Delivery details saved. Manual account selection is ready: ${syncErr.message}`
      };
    }
  }

  await postOrReplaceForwardedCard(telegram, bossChatId, order, getDb(), formatOrderBodyFn).catch(() => {});
  const changes = [updatedCart ? 'Cart saved' : '', updatedAddr ? 'Delivery details saved' : ''].filter(Boolean);
  return {
    ok: true,
    message: changes.length ? `${changes.join(' and ')}. Check the refreshed order card for the next required detail.` : 'No order details changed.'
  };
}
