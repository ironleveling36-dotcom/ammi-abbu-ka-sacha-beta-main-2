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
  lateNight: 'https://events.swiggy.com/pick-your-late-night-offer?utm_source=app&utm_medium=share',
  // 26-10-2026: boss ne do aur link diye — dono har JSON import par activate hote hain.
  extra50: 'https://events.swiggy.com/pick-your-offer?utm_source=app&utm_medium=share',
  weekend: 'https://events.swiggy.com/byo-weekend?utm_source=app&utm_medium=share',
  // 29-10-2026: boss ka naya link — Karwa Chauth "Pick ₹50 cash".
  karwaChauth: 'https://events.swiggy.com/karwa-chauth-byo?utm_source=app&utm_medium=share'
};

/** Saare offers ka order + boss ke naam (UI me isi order me dikhte hain). */
export const OFFER_TRACKS = [
  { key: 'lateNight', bossLabel: 'Morning Link', label: 'Late night (9PM–6AM)', emoji: '🌙' },
  { key: 'breakfast', bossLabel: 'Night Link', label: 'Breakfast (7AM–11AM)', emoji: '☀️' },
  { key: 'extra50', bossLabel: 'Extra ₹50', label: 'Extra ₹50 offer', emoji: '💸' },
  { key: 'weekend', bossLabel: 'Weekend', label: 'Weekend offer', emoji: '🎉' },
  // 29-10-2026: Karwa Chauth (29 Oct 3PM – 30 Oct 6AM) — Pick ₹50 cash.
  { key: 'karwaChauth', bossLabel: 'Karwa Chauth', label: 'Karwa Chauth (29 Oct 3PM – 30 Oct 6AM)', emoji: '🪔' }
];

/** Kitne offer tracks hain — koi bhi hardcoded "4" nahi (naya link = naya track). */
export const OFFER_TRACK_COUNT = OFFER_TRACKS.length;

/**
 * Chaar offer ka status kaise dikhega. Har line par ₹50 likha jata hai kyunki
 * boss ka rule hai: "sabme 50 50 claim karna hai" — status bhi wahi bataye.
 */
export const OFFER_STATUS_VIEW = {
  CLAIMED: { icon: '✅', label: 'CLAIMED' },
  ALREADY_CLAIMED: { icon: '✅', label: 'CLAIMED' },
  PRE_LOCKED: { icon: '⏳', label: 'PRE-LOCKED' },
  FAILED: { icon: '❌', label: 'FAILED' },
  // Swiggy ne offer "save" kar diya par doosra reward (coupon) — yeh ₹50 free
  // cash NAHI hai, isliye ✅ nahi dikhaya jata.
  WRONG_REWARD: { icon: '🟡', label: 'WRONG REWARD' },
  NO_CAMPAIGN_ID: { icon: '❌', label: 'NO CAMPAIGN' },
  CLAIMED_OTHER_VALUE: { icon: '🟡', label: 'WRONG REWARD' },
  NEW: { icon: '⚪', label: 'NEW' }
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
    if (state === 'PRE_LOCKED' || rec.preLocked === true) {
      return {
        status: 'PRE_LOCKED',
        claimed: false,
        preLocked: true,
        label: '⏳ Pre-locked (slot khulne par apne aap lagega)',
        at: activation?.at || ''
      };
    }
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
    if (state === 'WRONG_REWARD' || state === 'CLAIMED_OTHER_VALUE') {
      return {
        status: 'WRONG_REWARD',
        claimed: false,
        label: `🟡 Offer save hui par ₹50 free cash nahi${rec.message ? ` — ${String(rec.message).slice(0, 70)}` : ''}`,
        at: activation?.at || ''
      };
    }
    return {
      status: 'FAILED',
      claimed: false,
      label: `× Not claimed${rec.message ? ` — ${String(rec.message).slice(0, 60)}` : ''}`,
      at: activation?.at || ''
    };
  };

  // Har track ka sach — ginti OFFER_TRACKS se, isliye naya offer khud jud jata hai.
  const slots = {};
  for (const track of OFFER_TRACKS) slots[track.key] = describe(track.key);
  const breakfast = slots.breakfast;
  const lateNight = slots.lateNight;
  const extra50 = slots.extra50;
  const weekend = slots.weekend;
  const karwaChauth = slots.karwaChauth;
  const both = breakfast.claimed && lateNight.claimed;
  const allFour = OFFER_TRACKS.every((t) => slots[t.key].claimed);
  return {
    ...slots,
    breakfast,
    lateNight,
    extra50,
    weekend,
    karwaChauth,
    both,
    allFour,
    totalTracks: OFFER_TRACK_COUNT,
    claimedCount: OFFER_TRACKS.filter((t) => slots[t.key].claimed).length,
    preLockedCount: OFFER_TRACKS.filter((t) => slots[t.key].preLocked).length,
    isNew: OFFER_TRACKS.every((t) => !pick(t.key)),
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
/**
 * Chaaron offer ka line-by-line status — har line par ₹50 saaf likha jata hai.
 * `escape` pass karo jab Telegram HTML me jana ho.
 */
export function fourOfferStatusLines(acc, { escape = (v) => String(v ?? ''), showReason = true } = {}) {
  const truth = offerClaimTruth(acc || {});
  return OFFER_TRACKS.map((track, idx) => {
    const slot = truth[track.key] || { status: 'NEW' };
    const view = OFFER_STATUS_VIEW[String(slot.status || 'NEW').toUpperCase()] || OFFER_STATUS_VIEW.NEW;
    let reason = '';
    if (showReason && String(slot.status).toUpperCase() === 'FAILED' && slot.label) {
      reason = String(slot.label).replace(/^×\s*Not claimed\s*—?\s*/i, '').trim();
    }
    const tail = view.label === 'PRE-LOCKED'
      ? '₹50 — slot khulte hi lagega'
      : view.label === 'WRONG REWARD'
        ? '₹50 free cash nahi mila (Swiggy ne doosra reward rakha)'
        : (view.label === 'NEW' ? '₹50 — claim pending' : '₹50');
    return `${idx + 1}. ${track.emoji} <b>${escape(track.bossLabel)}</b> — ${view.icon} <b>${view.label}</b> · ${tail}` +
      (reason ? `\n     <i>${escape(reason.slice(0, 90))}</i>` : '');
  });
}

/** "2/5 claimed · ₹100 pakka / ₹250 possible" — jhooth nahi, sirf ginti. */
export function fourOfferScoreLine(acc) {
  const truth = offerClaimTruth(acc || {});
  const each = 50;
  const total = Number(truth.totalTracks || OFFER_TRACK_COUNT);
  return `📊 Score: <b>${truth.claimedCount}/${total} claimed</b> · ₹${truth.claimedCount * each} pakka / ₹${total * each} possible` +
    (truth.preLockedCount ? ` · ⏳ ${truth.preLockedCount} pre-locked` : '');
}

/** Poora chaar-offer status block (boss card, user card, import summary — sab jagah). */
export function fourOfferStatusBlock(acc, { escape = (v) => String(v ?? ''), header = '' } = {}) {
  return [
    header || `🎁 <b>SAARE ${OFFER_TRACK_COUNT} OFFER — har ek ₹50 (option 1: ₹50 off on ₹199)</b>`,
    ...fourOfferStatusLines(acc, { escape }),
    fourOfferScoreLine(acc)
  ].join('\n');
}

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
  // Chaaron offers ka sach: 4/4 par hi "✓", warna kitne lage (jhooth nahi).
  const claimTotal = Number(claim.totalTracks || OFFER_TRACK_COUNT);
  const claimBit = claim.allFour
    ? `₹50 ✓ ${claimTotal}/${claimTotal}`
    : claim.isNew
      ? '₹50 new'
      : `₹50 ${claim.claimedCount}/${claimTotal}${claim.preLockedCount ? ' ⏳' : ''}`;
  const name = String(src.name || '').trim();
  // 🔒 Order lock (boss 29-10-2026): ID kis order par atki hai — sach, chhupaya nahi.
  const lock = (src.orderLock && typeof src.orderLock === 'object' && src.orderLock.orderId) ? src.orderLock : null;
  const lockBit = lock ? ` · 🔒 #${escapeLight(String(lock.orderId))}` : '';
  const expiredBit = src.sessionExpired ? ' · ⚠️ session expired' : '';
  const suspendBit = suspended ? ` · ⛔ suspended` : '';
  return `${index}. ${icon} <code>${maskPhone(src.phone || src.mobile || key)}</code>${name ? ` ${escapeLight(name)}` : ''} · ${orders} · ${claimBit}${lockBit}${expiredBit}${suspendBit}`;
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
    // 🔒 Kis order par locked hai — deliver/cancel hone tak ID kisi aur ko nahi milegi.
    (src.orderLock && typeof src.orderLock === 'object' && src.orderLock.orderId)
      ? `🔒 <b>Locked</b> to order <code>#${escapeLight(String(src.orderLock.orderId))}</code>` +
        ` · ${escapeLight(String(src.orderLock.holder || 'Customer'))}` +
        ` · ${escapeLight(String(src.orderLock.stage || ''))}` +
        `\n   <i>Deliver ya cancel hone par apne aap free hogi (warna max 6h).</i>`
      : '',
    '',
    `📦 <b>Orders:</b> ${truth.label}`,
    truth.verified
      ? `   ▪ Active orders: <b>${truth.activeOrders === null ? '—' : truth.activeOrders}</b>`
      : '   ▪ <i>File me jo order count likha ho wo nahi maana jata — sirf live check.</i>',
    '',
    `🎁 <b>SAARE ${OFFER_TRACK_COUNT} OFFER (${escapeLight(claim.offerLabel)}) — har ek ₹50:</b>`,
    ...fourOfferStatusLines(src, { escape: escapeLight }),
    `   ▪ ${fourOfferScoreLine(src)}`,
    claim.autoActivatedAt ? `   ▪ Auto-activated: ${escapeLight(claim.autoActivatedAt.slice(0, 19).replace('T', ' '))}` : '',
    src.offerDoctor
      ? `   ▪ 🎁 Doctor: LN <b>${escapeLight(String(src.offerDoctor.lateNight || '?'))}</b> · BF <b>${escapeLight(String(src.offerDoctor.breakfast || '?'))}</b>` +
        ` · ₹50 <b>${escapeLight(String(src.offerDoctor.extra50 || '?'))}</b> · WKND <b>${escapeLight(String(src.offerDoctor.weekend || '?'))}</b>` +
        ` · KC <b>${escapeLight(String(src.offerDoctor.karwaChauth || '?'))}</b>` +
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
