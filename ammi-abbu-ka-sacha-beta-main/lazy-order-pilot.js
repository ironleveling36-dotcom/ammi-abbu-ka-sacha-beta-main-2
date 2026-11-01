// ============================================================================
// lazy-order-pilot.js — "Boss Lazy Mode" autopilot for family forwards
// ----------------------------------------------------------------------------
// Boss's real workflow is: Ammi/Abbu send him a Swiggy cart + address in his
// *personal* chat, he forwards that message into this bot, and the bot is
// supposed to do the rest. Four things used to break that promise:
//
//   1. FETCH      – one flaky Swiggy hop and the bot gave up ("could not detect
//                   a valid cart/address") with no way to retry.
//   2. CONFIRM    – the bill card had 8+ buttons and no single "yes, order it".
//   3. BEST ID    – when the auto-picked account failed, the order froze on
//                   NEED_ACCOUNT instead of trying the next best ID.
//   4. TRACKING   – after payment, a missing Swiggy link left the Boss with
//                   nothing to click and no retry promise.
//
// This module is deliberately dependency-light (pure helpers + injectable
// side effects) so every rule below is unit-testable without network access.
// The Telegram wiring lives in forwarded-order-flow.js.
// ============================================================================

import { extractSharedUrls, stripSharedLinks, normalizeSharedUrl } from './link-utils.js';
import { isAccountSuspended } from './account-health.js';

export const SWIGGY_ORDERS_PAGE = 'https://www.swiggy.com/orders';

// ---------------------------------------------------------------------------
// 1. Who is this order for? (Ammi / Abbu / customer)
// ---------------------------------------------------------------------------
// Boss tags family members with `store.setFamilyRole`; that mapping is the
// authoritative source. Forwarded-name and message-text nicknames are only a
// fallback, so a forwarded receipt mentioning "Mom" can never hijack a tagged
// Telegram user.
export const FAMILY_ROLE_PATTERNS = [
  {
    role: 'Ammi',
    pattern: /\b(ammi|ammi\s*ji|mummy|mumma|mom|mommy|mother|maa|maaji|mata)\b/i
  },
  {
    role: 'Abbu',
    pattern: /\b(abbu|abba|abbajan|abbu\s*ji|papa|pappa|pops|dad|daddy|father|baba|pitaji)\b/i
  }
];

export function detectFamilyRoleFromText(text) {
  const value = String(text || '');
  if (!value.trim()) return '';
  for (const entry of FAMILY_ROLE_PATTERNS) {
    if (entry.pattern.test(value)) return entry.role;
  }
  return '';
}

export function detectRecipientRole({ senderName = '', senderUserId = null, rawText = '', familyMembers = null } = {}) {
  const tagged = senderUserId && familyMembers
    ? String(familyMembers[String(senderUserId)] || '').trim()
    : '';
  if (tagged) {
    return { role: tagged, label: tagged, source: 'family_member_tag' };
  }
  const fromName = detectFamilyRoleFromText(senderName);
  if (fromName) return { role: fromName, label: fromName, source: 'forwarded_name' };
  const fromText = detectFamilyRoleFromText(rawText);
  if (fromText) return { role: fromText, label: fromText, source: 'message_text' };
  const fallback = String(senderName || '').trim() || 'Customer';
  return { role: 'Customer', label: fallback, source: 'sender_name' };
}

/** Short display label used on every lazy card ("Ammi", "Abbu", "Rahul"). */
export function recipientLabelOf(order, fallback = 'Customer') {
  const role = String(order?.recipientRole || '').trim();
  if (role && role !== 'Customer') return role;
  const name = String(order?.fwdSenderName || order?.userName || '').trim();
  return name || role || fallback;
}

// ---------------------------------------------------------------------------
// 2. RETRYABLE FETCH — one flaky hop must never strand the order
// ---------------------------------------------------------------------------
const NON_RETRYABLE_CODES = new Set([
  'GROUP_CART_EXPIRED',
  'GROUP_CART_ALREADY_PLACED',
  'INVALID_LINK',
  'ADDRESS_LINK_UNRESOLVABLE',
  'INDIA_ONLY_DELIVERY'
]);

const RETRYABLE_HINTS = /(timeout|timed out|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|aborted|429|rate.?limit|waf|challenge|502|503|504|internalserver|temporar)/i;

export function isRetryableFetchError(err) {
  const code = String(err?.diag?.code || err?.code || '').toUpperCase();
  if (code && NON_RETRYABLE_CODES.has(code)) return false;
  const message = `${err?.message || ''} ${err?.diag?.swiggyMessage || ''}`;
  if (RETRYABLE_HINTS.test(message)) return true;
  // Unknown failures are worth one retry: Swiggy's link resolver is flaky far
  // more often than it is deterministic (expired carts already carry a code).
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/**
 * Runs `fn` with a small, bounded retry ladder.
 * Retries only when `shouldRetry` (default: isRetryableFetchError) says so,
 * so an expired group cart still fails fast instead of hammering Swiggy.
 */
export async function retryFetch(fn, {
  attempts = 2,
  delays = [700],
  shouldRetry = isRetryableFetchError,
  onRetry = null
} = {}) {
  const total = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError = null;
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const canRetry = attempt < total && (typeof shouldRetry !== 'function' || shouldRetry(err));
      if (!canRetry) break;
      if (typeof onRetry === 'function') {
        try { await onRetry(err, attempt); } catch { /* never let logging break the retry */ }
      }
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  throw lastError || new Error('Fetch failed');
}

// ---------------------------------------------------------------------------
// 3. BEST ID — deterministic fallback ladder + human-readable reason
// ---------------------------------------------------------------------------
function hasUsableSession(acc) {
  if (!acc) return false;
  // Suspended/quarantined ID par order place hi nahi hoga — ladder me na aaye,
  // warna user ka order us ID par jaakar phir atak jayega.
  if (isAccountSuspended(acc)) return false;
  if (acc.isLoggedIn === false || acc.isLoggedOut === true || acc.sessionExpired === true) return false;
  return Boolean(acc.cookies || acc.tid || acc.jwtTid || acc.token);
}

function accountNumber(acc, key) {
  return String(acc?.phone || acc?.mobile || key || '').trim();
}

/**
 * Orders every logged-in Swiggy ID from "most likely to give the biggest
 * discount on a fresh account" to "last resort". Used when the automatic
 * multi-probe pick fails, so Boss never has to pick an ID by hand.
 *
 * @returns {Array<{key:string,phone:string,tier:string,score:number,reason:string}>}
 */
export function planAccountFallbacks(accounts = {}, order = null, { exclude = [], busyKeys = [] } = {}) {
  const excluded = new Set((exclude || []).filter(Boolean).map(String));
  const busy = new Set((busyKeys || []).filter(Boolean).map(String));
  const rows = [];

  for (const [key, acc] of Object.entries(accounts || {})) {
    if (!hasUsableSession(acc)) continue;
    if (excluded.has(String(key))) continue;
    if (busy.has(String(key))) continue;

    const unknown = acc.totalOrdersCount === null || acc.totalOrdersCount === undefined || acc.totalOrdersCount === '';
    const totalOrders = unknown ? null : Math.max(0, Number(acc.totalOrdersCount) || 0);
    const zeroOrder = acc.isZeroOrderAccount === true || totalOrders === 0;
    const zeroActive = zeroOrder || acc.hasZeroActiveOrders === true;

    let score = 0;
    const reasons = [];
    if (zeroOrder) { score += 1000; reasons.push('0 past orders'); }
    else if (totalOrders !== null) reasons.push(`${totalOrders} orders`);
    if (zeroActive) { score += 300; reasons.push('no active order'); }

    const possibleDiscounts = Number(acc.possibleDiscountsCount || 0);
    if (Number.isFinite(possibleDiscounts) && possibleDiscounts > 0) {
      score += Math.min(200, possibleDiscounts * 10);
      reasons.push(`${possibleDiscounts} offers ready`);
    }
    const freeCash = Number(acc.freeCashBalance || acc.walletBalance || 0);
    if (Number.isFinite(freeCash) && freeCash > 0) {
      score += Math.min(150, freeCash);
      reasons.push(`₹${Math.round(freeCash)} free cash`);
    }
    const last = Number(acc.lastOrderAt ? new Date(acc.lastOrderAt).getTime() : 0);
    if (last) {
      const ageDays = Math.max(0, (Date.now() - last) / 86_400_000);
      score += Math.min(30, Math.round(ageDays));
    }

    const tier = zeroOrder ? 'ZERO_ORDER' : (zeroActive ? 'ZERO_ACTIVE' : 'ACTIVE');
    rows.push({
      key: String(key),
      phone: accountNumber(acc, key),
      tier,
      score,
      reason: reasons.join(' · ') || 'available'
    });
  }

  rows.sort((a, b) => b.score - a.score || a.phone.localeCompare(b.phone));
  return rows;
}

/** "Best ID: 98xxxxxx · 0 past orders · save ₹140" — shown on every card. */
export function summarizeAccountChoice(order, { maskAccountCode = null } = {}) {
  const account = order?.selectedAccount;
  if (!account) return '';
  const phone = maskAccountCode ? maskAccountCode(account) : String(order?.orderAccount || account);
  const bits = [];
  if (order?.selectedAccountZeroOrders) bits.push('0 past orders');
  else bits.push('logged in');
  const savings = Number(order?.totalSavings || 0);
  if (savings > 0) bits.push(`save ₹${Math.round(savings)}`);
  if (order?.couponCode) bits.push(String(order.couponCode));
  return `Best ID: ${phone}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// 4. TRACKING — always give the Boss something clickable
// ---------------------------------------------------------------------------
const OFFICIAL_TRACK_HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:swiggy\.com|swiggy\.onelink\.me)\//i;
const NON_TRACK_HINTS = /(?:\/(?:gc|cart|restaurants?|menu)(?:\/|$)|shared_cart|group_cart)/i;

export function isOfficialTrackLikeUrl(url) {
  const value = String(url || '').trim();
  if (!OFFICIAL_TRACK_HOST_RE.test(value)) return false;
  if (NON_TRACK_HINTS.test(value) && !/(track|orders?|ofo)/i.test(value)) return false;
  return true;
}

/**
 * What should Boss/customer be shown for tracking right now?
 * Never invents a bot-side /track/<id> page: either the genuine Swiggy link,
 * or the real Swiggy "My Orders" page plus an explicit retry promise.
 */
export function resolveTrackingDelivery(order, { storedUrl = '' } = {}) {
  const candidate = String(storedUrl || order?.trackingLink || '').trim();
  if (candidate && isOfficialTrackLikeUrl(candidate)) {
    return { url: candidate, source: 'SWIGGY', isOfficial: true, needsRetry: false };
  }
  return { url: SWIGGY_ORDERS_PAGE, source: 'SWIGGY_ORDERS_PAGE', isOfficial: false, needsRetry: true };
}

export function trackingRetryPromiseText(attempt = 0) {
  return attempt > 0
    ? `Swiggy ne link abhi publish nahi kiya (attempt ${attempt}). Bot khud retry kar raha hai — link aate hi yahin bhej dega.`
    : 'Swiggy ne link abhi publish nahi kiya. Bot khud retry karega aur link aate hi yahin bhej dega.';
}

// ---------------------------------------------------------------------------
// 5. Card buttons — ONE obvious tap for Boss
// ---------------------------------------------------------------------------
export function lazyActionId(action, orderId) {
  return `lazy_${action}_${String(orderId || '')}`;
}

/** Single primary confirm button text: "✅ Confirm & Pay QR · Ammi · ₹248". */
export function lazyConfirmLabel(order) {
  const who = recipientLabelOf(order, '');
  const payable = Number(order?.finalPayable || order?.finalTotal || 0);
  const parts = ['✅ Confirm'];
  if (who && who !== 'Customer') parts.push(`for ${who}`);
  if (payable > 0) parts.push(`₹${Math.round(payable)}`);
  return parts.join(' · ');
}

/**
 * The one row Boss must see on a ready bill. Raw button objects (not
 * `Markup.button.callback`) because Telegraf's third argument is `hide`,
 * while this repo sends `style` for coloured buttons.
 */
export function buildLazyConfirmRow(order) {
  if (!order?.id) return [];
  const confirmed = Boolean(order.bossConfirmedAt);
  return [
    {
      text: confirmed
        ? `✅ Confirmed · ${recipientLabelOf(order)} — Get Payment`
        : lazyConfirmLabel(order),
      callback_data: lazyActionId('confirm', order.id)
    }
  ];
}

/** Secondary "I don't trust this pick" row — still one tap, no picker. */
export function buildLazyRecoveryRows(order) {
  if (!order?.id) return [];
  return [
    [
      { text: '🔄 Best ID dobara', callback_data: lazyActionId('best_id', order.id) },
      { text: '🔗 Tracking abhi', callback_data: lazyActionId('track', order.id) }
    ]
  ];
}

// ---------------------------------------------------------------------------
// 6. Rescue card when fetch could not read the forward
// ---------------------------------------------------------------------------
export function describeMissingInputs(order) {
  const missing = [];
  // A link Swiggy never answered for counts as missing: retry, don't bill on it.
  if (!order?.cart || order?.cartUnverified) missing.push('Swiggy cart link');
  const hasAddress = Boolean(order?.address);
  if (!hasAddress) missing.push('delivery address / GPS pin');
  const mobile = String(order?.addressDetails?.mobile || '').replace(/\D/g, '');
  if (hasAddress && mobile.length !== 10) missing.push('recipient mobile');
  return missing;
}

/**
 * Clear, single-action rescue card: says exactly what is missing, keeps the
 * original forward on file, and gives retry + manual entry buttons.
 */
export function buildLazyRescueCard(order, { reason = '', escapeHtml = (s) => String(s) } = {}) {
  const missing = describeMissingInputs(order);
  const who = recipientLabelOf(order);
  const reasonLine = reason ? `\n<i>${escapeHtml(String(reason).slice(0, 300))}</i>` : '';
  const text =
    `⚠️ <b>Forward padha nahi ja saka (#${escapeHtml(String(order?.id || ''))})</b>\n` +
    `◉ <b>Order for:</b> ${escapeHtml(who)}\n\n` +
    `Missing: <b>${escapeHtml(missing.join(', ') || 'cart + address')}</b>\n` +
    `<i>Boss: ek tap me retry karein — original forward safe hai, dobara bhejne ki zarurat nahi.</i>${reasonLine}`;
  const orderId = String(order?.id || '');
  const buttons = [
    [{ text: '↻ Retry fetch (same message)', callback_data: lazyActionId('fetch', orderId) }],
    [
      { text: '🛒 Cart link', callback_data: `fwd_input_cart_${orderId}` },
      { text: '📍 Address link', callback_data: `fwd_input_address_${orderId}` }
    ],
    [{ text: '✕ Cancel order', callback_data: `fwd_cancel_${orderId}` }]
  ];
  return { text, buttons, missing };
}

/** Compact "what happened" line for diagnostics replies. */
export function buildLazyStatusLine(order) {
  const who = recipientLabelOf(order);
  const payable = Number(order?.finalPayable || 0);
  const account = summarizeAccountChoice(order);
  return [who, payable > 0 ? `₹${Math.round(payable)}` : '', account].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// 7. Intake bookmarking — remember the forwarded text so retry needs no re-send
// ---------------------------------------------------------------------------
export function storeIntakeSnapshot(order, { rawText = '', location = null } = {}) {
  if (!order) return order;
  const text = String(rawText || '');
  if (text) order.lastIntakeRawText = text.slice(0, 4000);
  if (location && location.latitude !== undefined && location.longitude !== undefined) {
    order.lastIntakeLocation = { latitude: location.latitude, longitude: location.longitude };
  }
  order.lastIntakeAt = new Date().toISOString();
  return order;
}

/** Remembers the last unresolved link so retry can go straight to it. */
export function firstOrderLinks(rawText = '') {
  const urls = extractSharedUrls(rawText);
  const mapsUrl = urls.find((u) => /(maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps)/i.test(u)) || '';
  const trackingUrl = urls.find((u) => /(r\.swiggy\.com.*\/track\/|swiggy\.com.*track)/i.test(u)) || '';
  const swiggyUrls = urls.filter((u) => {
    const value = normalizeSharedUrl(u);
    return value && /(swiggy\.com|swig\.gy|onelink\.me)/i.test(value) && !/(r\.swiggy\.com.*\/track\/)/i.test(value);
  });
  return {
    urls,
    mapsUrl,
    trackingUrl,
    primary: swiggyUrls[0] || '',
    secondary: swiggyUrls[1] || '',
    plainText: stripSharedLinks(String(rawText || '')).trim()
  };
}
