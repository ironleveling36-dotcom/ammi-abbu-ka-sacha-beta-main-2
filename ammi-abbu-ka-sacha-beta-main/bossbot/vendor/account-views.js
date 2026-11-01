/**
 * Account cards — compact list rows + expanded per-account truth + the portable
 * session JSON the Boss pastes into other tools.
 *
 * HARD RULE (user): an order count written inside an uploaded `.json` is NOT
 * acceptable evidence. Only a LIVE Swiggy answer (`ordersVerifiedLive === true`)
 * may say "0 orders". Everything here therefore reads `liveOrderTruth()`, never
 * a raw `totalOrdersCount` that came from a file.
 *
 * Pure functions only — no Telegram, no network — so they are unit-testable.
 */

import { isAccountSuspended, describeSuspendedAccount } from './account-health.js';

export const PORTABLE_SESSION_FIELDS = ['name', 'customerId', 'mobile', 'token', 'tid', 'sid', 'deviceId'];

/** "₹50 off on ₹199" — the reward the bot must lock on every imported ID. */
export const PREFERRED_OFFER_LABEL = '₹50 off on ₹199';
export const PREFERRED_OFFER_VALUE = 1;

export const OFFER_CAMPAIGN_URLS = {
  breakfast: 'https://events.swiggy.com/book-your-offer?utm_source=app&utm_medium=share',
  lateNight: 'https://events.swiggy.com/pick-your-late-night-offer?utm_source=app&utm_medium=share'
};

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return String(phone || '—');
  return `${digits.slice(0, 5)}•${digits.slice(5)}`;
}

/**
 * The exact 7-field object the Boss asked for, in that key order:
 * { name, customerId, mobile, token, tid, sid, deviceId }
 */
export function buildPortableSessionJson(acc, key = '') {
  const src = acc || {};
  const phone = String(src.mobile || src.phone || String(key || '').replace(/^acc_/, '') || '').replace(/\D/g, '').slice(-10);
  const cookieStr = String(src.cookies || '');
  const fromCookie = (name) => {
    const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? m[1].trim() : '';
  };
  let customerId = String(src.customerId || src.userId || '').trim();
  let tid = String(src.tid || src.jwtTid || fromCookie('tid') || '').trim();
  if (!customerId && tid.includes('.')) {
    try {
      const payload = JSON.parse(Buffer.from(tid.split('.')[1], 'base64').toString('utf8'));
      const uid = String(payload?.user_id ?? payload?.userId ?? payload?.sub ?? '');
      if (uid && uid !== '0' && uid !== '-1' && /^\d+$/.test(uid)) customerId = uid;
    } catch { /* ignore */ }
  }
  return {
    name: String(src.name || src.swiggyName || (phone ? `User ${phone}` : key || 'Swiggy User')),
    customerId,
    mobile: phone,
    token: String(src.token || fromCookie('token') || tid || ''),
    tid,
    sid: String(src.sid || fromCookie('_sid') || fromCookie('sid') || ''),
    deviceId: String(src.deviceId || fromCookie('_device_id') || fromCookie('deviceId') || '')
  };
}

/**
 * Caption used when the 7-field JSON is sent to the Boss as a real `.json` file
 * (manual "Export & Logout" and the automatic delivered-order export).
 */
export function buildPortableSessionJsonCaption({ name = '', phone = '', orderId = '', prefix = '⇧ Exported' } = {}) {
  const safeName = escapeLight(name || phone || 'Swiggy Session');
  const safePhone = escapeLight(String(phone || ''));
  const orderBit = orderId ? ` · order <code>#${escapeLight(String(orderId))}</code>` : '';
  return `${escapeLight(prefix)}: <b>${safeName}</b> · <code>${safePhone}</code>${orderBit}\n` +
    `<i>7 fields: name, customerId, mobile, token, tid, sid, deviceId</i>`;
}

export function portableSessionJsonText(acc, key = '', { pretty = true } = {}) {
  const obj = buildPortableSessionJson(acc, key);
  return pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
}

/**
 * LIVE order truth. `verified` is true only when Swiggy itself answered the
 * order-history call in this bot (`ordersVerifiedLive === true`).
 */
export function liveOrderTruth(acc) {
  const src = acc || {};
  const verified = src.ordersVerifiedLive === true;
  const rawCount = Number(src.totalOrdersCount ?? src.cachedTotalOrdersCount);
  const hasCount = verified && Number.isFinite(rawCount) && rawCount !== 999999;
  const totalOrders = hasCount ? rawCount : null;
  const activeOrders = Number.isFinite(Number(src.liveActiveOrdersCount)) ? Number(src.liveActiveOrdersCount) : null;
  const claimsZero = src.isZeroOrderAccount === true;
  return {
    verified,
    totalOrders,
    activeOrders,
    zeroOrder: hasCount ? totalOrders === 0 : null,
    // A file that says "0 orders" is worthless: it is neither verified nor zero.
    fileClaimIgnored: !verified && (rawCount === 0 || claimsZero),
    label: hasCount
      ? (totalOrders === 0 ? '★ 0 orders (LIVE check)' : `● ${totalOrders} order${totalOrders === 1 ? '' : 's'} (LIVE check)`)
      : '⚠️ Not checked live yet — tap “Live Check”'
  };
}

/** Claimed vs new, based on the stored claim result — never assumed. */
export function offerClaimTruth(acc) {
  const src = acc || {};
  const activation = (src.offerAutoActivation && typeof src.offerAutoActivation === 'object') ? src.offerAutoActivation : null;
  const stored = src.offers && typeof src.offers === 'object' ? src.offers : null;
  const pick = (slot) => activation?.[slot] || stored?.[slot] || null;

  const describe = (slot) => {
    const rec = pick(slot);
    if (!rec) {
      return { status: 'NEW', claimed: false, label: 'NEW — abhi claim nahi hua', at: '' };
    }
    const state = String(rec.status || '').toUpperCase();
    const claimed = state === 'CLAIMED' || state === 'ALREADY_CLAIMED' || Boolean(rec.claimed === true);
    if (claimed) {
      return {
        status: 'CLAIMED',
        claimed: true,
        label: rec.alreadyActive || rec.alreadyClaimed
          ? `✓ Already claimed (${rec.discount || PREFERRED_OFFER_LABEL})`
          : `✓ Claimed (${rec.discount || PREFERRED_OFFER_LABEL})`,
        at: rec.claimedAt || activation?.at || ''
      };
    }
    return {
      status: 'FAILED',
      claimed: false,
      label: `× Not claimed${rec.message ? ` — ${String(rec.message).slice(0, 60)}` : ''}`,
      at: activation?.at || ''
    };
  };

  const breakfast = describe('breakfast');
  const lateNight = describe('lateNight');
  const both = breakfast.claimed && lateNight.claimed;
  return {
    breakfast,
    lateNight,
    both,
    isNew: !pick('breakfast') && !pick('lateNight'),
    offerLabel: activation?.label || stored?.offerLabel || PREFERRED_OFFER_LABEL,
    offerValue: Number(activation?.offerValue || stored?.offerValue || PREFERRED_OFFER_VALUE),
    autoActivatedAt: activation?.at || '',
    campaigns: { ...OFFER_CAMPAIGN_URLS }
  };
}

export function isLiveSession(acc) {
  const src = acc || {};
  return Boolean(src.isLoggedIn && (src.cookies || src.tid || src.jwtTid || src.token));
}

/** ONE compact line per account ("less" — details come on tap). */
export function compactAccountLine(acc, key, { activeKey = '', index = 1 } = {}) {
  const src = acc || {};
  const live = isLiveSession(src);
  // ⛔ suspended ID rotation me nahi aayegi — list me saaf dikhna chahiye.
  const suspended = isAccountSuspended(src);
  const icon = suspended
    ? '⛔'
    : (src.sessionExpired
      ? '⚠️'
      : (live ? (String(key) === String(activeKey) ? '★' : '🟢') : '⚪'));
  const truth = liveOrderTruth(src);
  const orders = truth.verified
    ? (truth.totalOrders === 0 ? '0 ord' : `${truth.totalOrders} ord`)
    : 'ord ?';
  const claim = offerClaimTruth(src);
  const claimBit = claim.both ? '₹50 ✓' : (claim.isNew ? '₹50 new' : '₹50 ✕');
  const name = String(src.name || '').trim();
  const expiredBit = src.sessionExpired ? ' · ⚠️ session expired' : '';
  const suspendBit = suspended ? ` · ⛔ suspended` : '';
  return `${index}. ${icon} <code>${maskPhone(src.phone || src.mobile || key)}</code>${name ? ` ${escapeLight(name)}` : ''} · ${orders} · ${claimBit}${expiredBit}${suspendBit}`;
}

export function compactAccountListText(accounts = {}, { activeKey = '', header = '' } = {}) {
  const entries = Object.entries(accounts || {});
  const live = entries.filter(([, a]) => isLiveSession(a)).length;
  const lines = entries.map(([key, acc], i) => compactAccountLine(acc, key, { activeKey, index: i + 1 }));
  return {
    liveCount: live,
    totalCount: entries.length,
    text: (header || '◉ <b>SWIGGY ACCOUNTS</b>') + `\n<i>${live} live / ${entries.length} total — tap any account to expand</i>` +
      (entries.filter(([, a]) => isAccountSuspended(a)).length > 0
        ? `\n⛔ <b>${entries.filter(([, a]) => isAccountSuspended(a)).length} suspended</b> — inpar order place nahi hoga (rotation inhe skip karti hai)`
        : '') +
      (lines.length ? `\n\n${lines.join('\n')}` : '\n\n<i>Koi account nahi — JSON bhejein ya Number se login karein.</i>')
  };
}

/**
 * Expanded account card: live order truth + claim truth + the portable JSON.
 * `orderLines` lets the caller append live "previous orders" when it has them.
 */
export function accountDetailText({ acc, key, activeKey = '', orderLines = [] } = {}) {
  const src = acc || {};
  const truth = liveOrderTruth(src);
  const claim = offerClaimTruth(src);
  const live = isLiveSession(src);
  const json = portableSessionJsonText(src, key);
  const suspendedNow = isAccountSuspended(src);
  const statusText = suspendedNow
    ? `⛔ Suspended — ${describeSuspendedAccount(src)}`
    : (live
      ? '● Logged In'
      : (src.sessionExpired ? '⚠️ Session Expired' : '○ Logged Out'));
  const lines = [
    `◉ <b>${escapeLight(src.name || key)}</b>${String(key) === String(activeKey) ? ' ★ <b>[ACTIVE]</b>' : ''}`,
    `☎ <code>${String(src.phone || src.mobile || 'not set')}</code> · ◈ ${statusText}`,
    '',
    `📦 <b>Orders:</b> ${truth.label}`,
    truth.verified
      ? `   ▪ Active orders: <b>${truth.activeOrders === null ? '—' : truth.activeOrders}</b>`
      : '   ▪ <i>File me jo order count likha ho wo nahi maana jata — sirf live check.</i>',
    '',
    `🎁 <b>Offers (${escapeLight(claim.offerLabel)}):</b>`,
    `   ▪ Breakfast: ${claim.breakfast.label}`,
    `   ▪ Late night: ${claim.lateNight.label}`,
    `   ▪ Account: <b>${claim.both ? 'ALREADY CLAIMED' : (claim.isNew ? 'NEW (claim pending)' : 'PARTIAL')}</b>`,
    claim.autoActivatedAt ? `   ▪ Auto-activated: ${escapeLight(claim.autoActivatedAt.slice(0, 19).replace('T', ' '))}` : '',
    src.offerDoctor
      ? `   ▪ 🎁 Doctor: LN <b>${escapeLight(String(src.offerDoctor.lateNight || '?'))}</b> · BF <b>${escapeLight(String(src.offerDoctor.breakfast || '?'))}</b>` +
        (Array.isArray(src.offerDoctor.verdict) && src.offerDoctor.verdict[0] ? `\n     <i>${escapeLight(String(src.offerDoctor.verdict[0]).slice(0, 110))}</i>` : '')
      : '',
    ...(orderLines.length ? ['', `▤ <b>Previous orders:</b>`, ...orderLines] : []),
    '',
    `▤ <b>Session JSON (7 fields):</b>`,
    `<pre><code class="language-json">${escapeLight(json)}</code></pre>`
  ].filter(Boolean);
  return { text: lines.join('\n'), json, truth, claim };
}

export function escapeLight(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strips order-count fields that came from an uploaded file, so they can never
 * masquerade as a live check ("JSON me 0 likha hai" is not evidence).
 */
export function stripUntrustedOrderClaims(payload) {
  const out = { ...(payload || {}) };
  delete out.totalOrdersCount;
  delete out.cachedTotalOrdersCount;
  delete out.isZeroOrderAccount;
  delete out.ordersVerifiedLive;
  delete out.liveActiveOrdersCount;
  delete out.orderCount;
  delete out.previousOrderCount;
  delete out.ordersCount;
  return out;
}

/** Detects "order count" style fields inside an uploaded file (for reporting). */
export function detectedFileOrderClaims(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const keys = ['totalOrdersCount', 'cachedTotalOrdersCount', 'isZeroOrderAccount', 'orderCount', 'ordersCount', 'previousOrderCount', 'previous_orders'];
  return keys.filter((k) => Object.prototype.hasOwnProperty.call(raw, k)).map((k) => `${k}=${String(raw[k])}`);
}
