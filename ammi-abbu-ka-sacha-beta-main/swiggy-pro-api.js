import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { validateUpiIntentForQr } from './payment-qr-guard.js';
import { readSwiggyPlacement } from './swiggy-placement-journal.js';
import { checkRateLimit, rateLimitMessage, rateLimitState } from './pro-rate-limit.js';
import { reconcileBill, describeBillState } from './bill-reconcile.js';
import { backupMoneyNow, backupIdentityNow, durabilityStatus, identityStatus, restoreFromVaultNow } from './db-durability.js';
import { runDurabilityDoctor } from './durability-doctor.js';
import { importStatementText, recordStatementPayment, statementStatus, retryPendingUtrs } from './upi-statement.js';
import { describeSmsTruth, describeTrackingTruth, scanRecipientSmsEvidence } from './tracking-truth.js';
import { summarizeIdentity } from './identity-snapshot.js';
import { planQrGeneration, isRenderableQrImage, describeQrPlan } from './qr-generation-plan.js';
import { exactPaise, sameDeliveryRecipient } from './swiggy-cart-integrity.js';
import { isOfficialSwiggyTrackingUrl, normalizeSwiggyOrderId, validateTrackingUrlForOrder, isZeroSmsTestSandboxActive, isValidIndianDeliveryCoordinates } from './swiggy-cart.js';
import { deleteAccount, getDb, getActiveUserOrder, isBoss, saveDb, saveDbDurable, updateAccount, permanentLogoutAccount, normalizeSwiggySessionPayload } from './store.js';
import { readChatHandoff, markChatHandoffStarted, safeSwiggyShareUrl } from './chat-miniapp-handoff.js';
import { notifyPendingTopup, retryPendingWalletUtrs } from './wallet-topup-service.js';
import {
  buildTopupUpiIntent, chargeServiceFee, creditWallet, ensureWallet, findUsedUtr, getWallet, minTopupPaise,
  refundServiceFee, rupees, serviceFeePaiseFor, setWalletUpiId, submitTopupRequestWithLookup, validateUtr,
  TOPUP_PRESETS_PAISE, walletBalancePaise, walletHistory, walletUpiId
} from './user-wallet.js';
import { requestSwiggyDeleteOtpViaBridge, requestSwiggyOtpViaBridge, verifyAndDeleteSwiggyAccountViaBridge, verifySwiggyOtpViaBridge } from './swiggy-bridge.js';
import { activateAllEventOffers } from './event-offers.js';
import { OFFER_TRACKS } from './account-views.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { describeAccountForPicker } from './mini-app.js';
import { proProvider } from './swiggy-pro-provider.js';
import { backupProWorkspaceNow, cloudBackupEnabled, ensureProWorkspaceHydrated, proBackupStatus, readProWorkspace, writeProWorkspace, withProWorkspaceLock } from './swiggy-pro-store.js';
import { describeIdleClosure, idleTimeoutMs, planIdleExpiry, touchActivity } from './order-idle-expiry.js';
import { fetchUtrPaymentDetails } from './utr-lookup.js';
import { describeUtrPayment, utrTruthRows } from './utr-truth.js';

const ASSETS = {
  '/pro': ['text/html; charset=utf-8', new URL('./swiggy-pro.html', import.meta.url)],
  '/pro/': ['text/html; charset=utf-8', new URL('./swiggy-pro.html', import.meta.url)],
  '/pro/app.js': ['text/javascript; charset=utf-8', new URL('./swiggy-pro-app.js', import.meta.url)],
  '/pro/style.css': ['text/css; charset=utf-8', new URL('./swiggy-pro.css', import.meta.url)]
};
const MAX_INIT_AGE_SECONDS = 24 * 60 * 60;
const otpRequestedAt = new Map();
const otpAttempts = new Map();
const deleteOtpRequestedAt = new Map();
const defaultOtp = { request: requestSwiggyOtpViaBridge, verify: verifySwiggyOtpViaBridge };
const defaultDeleteOtp = {
  request: (userId, phone, key, name, account) => requestSwiggyDeleteOtpViaBridge(userId, phone, key, name, account),
  verify: (userId, otp, key) => verifyAndDeleteSwiggyAccountViaBridge(userId, otp, key)
};

/** Verify Telegram's signature and freshness; never trust initDataUnsafe. */
export function verifyTelegramWebAppInitData(initData, botToken = process.env.BOT_TOKEN, now = Date.now()) {
  const raw = String(initData || '');
  if (!raw || raw.length > 8192 || !botToken) return null;
  try {
    const params = new URLSearchParams(raw);
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) return null;
    const hash = params.get('hash') || '';
    const dateText = params.get('auth_date') || '';
    if (!/^[0-9a-f]{64}$/i.test(hash) || !/^\d{1,12}$/.test(dateText)) return null;
    const age = Math.floor(now / 1000) - Number(dateText);
    if (age < -30 || age > MAX_INIT_AGE_SECONDS) return null;
    const check = [...params.entries()].filter(([key]) => key !== 'hash')
      .map(([key, value]) => `${key}=${value}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(check).digest();
    const supplied = Buffer.from(hash, 'hex');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !/^\d{1,20}$/.test(String(user.id)) || !Number.isSafeInteger(Number(user.id))) return null;
    return { id: String(user.id), firstName: String(user.first_name || '').slice(0, 80) };
  } catch { return null; }
}

function error(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/**
 * Boss (31-10-2026, round 17): "PEHLE SAARI POSSIBILITIES IDENTIFY KARKE BLOCK
 * KARO". Har mehnga/nuksaan wala route ek hi jagah se rate-limited hai —
 * 429 + asli wajah + kitni der baad.
 */
function enforceRateLimit(user, bucket) {
  const db = getDb();
  const result = checkRateLimit(db, user.id, bucket);
  saveDb(db);
  if (!result.allowed) {
    const e = error(429, rateLimitMessage(bucket, result));
    e.code = 'RATE_LIMITED';
    e.retryAfterSec = result.retryAfterSec;
    e.bucket = bucket;
    throw e;
  }
  return result;
}

/** Sirf padhne ke liye — kitna quota bacha hai (app me dikhane ke liye). */
export function rateLimitSnapshot(userId) {
  const db = getDb();
  const out = {};
  for (const bucket of ['accountImport', 'otpSend', 'walletClaim', 'walletTopup', 'checkout', 'cartSync']) {
    const state = rateLimitState(db, userId, bucket);
    out[bucket] = { used: state.used, max: state.max, remaining: state.remaining };
  }
  return out;
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw error(415, 'Send JSON.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 100_000) throw error(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw error(400, 'Invalid JSON.'); }
}

/**
 * Operator IDs are available to authenticated Telegram users by default, as
 * requested. A Boss can deny a particular user/ID in Tools; user-owned IDs
 * remain private. Old per-ID grant hashes are retained for compatibility.
 * Decisions are key-bound so replacing an account cannot silently undo a deny.
 */
const SHARED_ACCESS_DENIED = '!';
const unconfirmedAccessChanges = new Set();
const accessDecisionKey = (userId, accountKey) => `${userId}\0${accountKey}`;
function sharedAccountMap() {
  try { return getDb().config?.accounts || {}; } catch { return {}; }
}
function offerTrackStatus(rec) {
  const status = String(rec?.status || rec?.state || 'NOT_CLAIMED');
  // The primary campaign can already be active while another is partial or was
  // just claimed. Only describe the overall track as already claimed if any
  // detailed results also confirm that every campaign was already active.
  const allAlready = !Array.isArray(rec?.results) || rec.results.every(r =>
    r?.verified === true && ['ALREADY_ACTIVE', 'ALREADY_VERIFIED', 'ALREADY_CLAIMED'].includes(String(r.state || '').toUpperCase()));
  return rec?.alreadyActive === true && rec?.verified === true && status.toUpperCase() === 'CLAIMED' && allAlready
    ? 'ALREADY_CLAIMED' : status;
}
function sharedAccountAllowed(db, userId, key) {
  if (unconfirmedAccessChanges.has(accessDecisionKey(userId, key))) return false;
  const decisions = db.config?.proAccountGrants;
  if (decisions !== undefined && (!decisions || typeof decisions !== 'object' || Array.isArray(decisions))) return false;
  const row = decisions?.[String(userId)];
  if (row !== undefined && (!row || typeof row !== 'object' || Array.isArray(row))) return false;
  const decision = row?.[key];
  // Unknown/corrupt entries are not permission to share. Missing is the new
  // default; old valid grant hashes continue to allow the account.
  return decision === undefined || (typeof decision === 'string' && /^[a-f0-9]{64}$/.test(decision));
}
function accountMap(user, workspace) {
  const db = getDb();
  const shared = db.config?.accounts || {};
  if (isBoss(user.id)) return shared;
  const allowed = Object.fromEntries(Object.entries(shared).filter(([key]) => sharedAccountAllowed(db, user.id, key)));
  return { ...allowed, ...workspace.accounts };
}
/**
 * Kya ye ID operator (boss) ki hai? User ke apne workspace me isi key ka
 * account ho to wo uska apna hai — shared map me same naam ho to bhi private
 * hi rahega (key collision se kisi ka data kisi ko nahi dikhna chahiye).
 */
function isSharedAccountFor(user, workspace, key) {
  const k = String(key);
  if (isBoss(user.id)) return false;
  if (Object.prototype.hasOwnProperty.call(workspace?.accounts || {}, k)) return false;
  return Object.prototype.hasOwnProperty.call(sharedAccountMap(), k);
}
/** Doosre ke number poora nahi dikhta — sirf operator ko poora. */
function maskAccountPhone(phone) {
  const p = normalizeIndianMobileNumber(phone || '') || '';
  if (p.length !== 10) return '';
  return `${p.slice(0, 2)}••••${p.slice(-4)}`;
}
/**
 * Boss (30-10-2026): "har ID ke saamne likha ho ki isse order place hua hai ki
 * nahi, suspend ya koi dikkat ho… free cash icon… offer active hai ya nahi…
 * aur used ID ko kaat de."
 *
 * Har row ab ASLI sach ke saath aati hai (`mini-app.js` ka picker helper):
 *   READY (0 order) / USED (kaat di jati hai) / SUSPENDED / SESSION_EXPIRED /
 *   BUSY (kisi chalte order ki ID) / UNVERIFIED (live check nahi hua).
 * Jo verify nahi hua usko kabhi "used" nahi likhte.
 */
/**
 * "Is ID me ye offer hai?" — record hai aur FAILED nahi hai to haan.
 * Koi record hi nahi = pata nahi = nahi (jhooth nahi bolte).
 */
function hasOfferTrack(account, key) {
  const rec = account?.offerAutoActivation?.[key] || account?.offers?.[key] || null;
  if (!rec) return false;
  return String(rec.status || rec.state || '').toUpperCase() !== 'FAILED';
}
function listAccounts(user, workspace) {
  const map = accountMap(user, workspace);
  const boss = isBoss(user.id);
  const bossDb = boss ? getDb() : null;
  return Object.entries(map)
    .filter(([, a]) => a && a.isLoggedIn && !a.isLoggedOut)
    .map(([key, a]) => {
      const shared = isSharedAccountFor(user, workspace, key);
      const mine = !shared;
      // Shared ID par kisi ka live order chal raha ho to wo sabke liye busy
      // hai — isliye shared rows ke liye poora db dekhte hain.
      const truth = describeAccountForPicker(key, a, boss || shared ? { db: bossDb || getDb() } : { accounts: map, orders: {} });
      return {
        key,
        name: String(a.swiggyName || a.name || 'Swiggy account').slice(0, 80),
        phone: mine ? (normalizeIndianMobileNumber(a.phone || a.mobile || '') || '') : '',
        phoneMasked: mine ? '' : maskAccountPhone(a.phone || a.mobile || ''),
        owner: shared || boss ? 'operator' : 'self',
        canClaim: mine,
        canRemove: mine,
        // Used ID sirf warning ke baad khulti hai (boss 31-10-2026).
        needsConfirm: truth.status === 'USED',
        active: key === workspace.activeAccountKey,
        ordersCount: Number.isInteger(a.totalOrdersCount) ? a.totalOrdersCount : null,
        sessionExpired: Boolean(a.sessionExpired),
        // ── sach (UI inhi par icons/reason dikhata hai) ──
        status: truth.status,
        selectable: truth.selectable,
        reason: truth.reason,
        icons: truth.icons,
        freeCash: truth.freeCash,
        offers: truth.offers,
        // Round 33 (boss): "USED / FRESH / NIGHT / BREAKFAST" filter ke liye.
        // Sirf sach: `used`/`fresh` live check par based hain (status READY =
        // live 0 order, USED = live orders mile). Jahan check nahi hua, wahan
        // dono false — jhootha "fresh" nahi.
        used: truth.status === 'USED',
        fresh: truth.status === 'READY',
        night: hasOfferTrack(a, 'lateNight'),
        breakfast: hasOfferTrack(a, 'breakfast'),
        // Har track ka sach — Mini App me claim button isi par chalta hai.
        offerTracks: OFFER_TRACKS.map(track => {
          const rec = a.offerAutoActivation?.[track.key] || a.offers?.[track.key] || null;
          return {
            key: track.key,
            label: track.label,
            emoji: track.emoji,
            status: offerTrackStatus(rec),
            // A saved status alone is not a provider read-back verification.
            verified: rec?.verified === true,
            message: String(rec?.message || '').slice(0, 160)
          };
        }),
        busyOrderId: truth.busyOrderId,
        ordersVerifiedLive: truth.ordersVerifiedLive
      };
    });
}
function sessionFingerprint(account) {
  // Bind a verified customer ID to the actual stored credentials, not merely a
  // phone/account key. Never send this digest or any session field to a client.
  const stable = [account?.cookies || account?.cookie, account?.token, account?.sid, account?._session_tid].filter(Boolean);
  const material = stable.length ? stable : [account?.jwtTid || account?.tid].filter(Boolean);
  if (!material.length) return '';
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
function validCustomerId(value) {
  const id = String(value || '').trim();
  return id && id !== '0' && id !== '-1' ? id : '';
}
function accountWithBinding(ws, key, saved) {
  const account = { ...saved, __proPrivate: true };
  const binding = ws.sessionBindings?.[key];
  if (!validCustomerId(account.customerId) && binding && sessionFingerprint(saved) &&
      binding.fingerprint === sessionFingerprint(saved)) account.customerId = validCustomerId(binding.customerId);
  return account;
}
function currentAccount(user, workspace) {
  const map = accountMap(user, workspace);
  const key = workspace.activeAccountKey;
  if (!key || !Object.prototype.hasOwnProperty.call(map, key) || !map[key]?.isLoggedIn || map[key]?.isLoggedOut) {
    throw error(400, 'First select a logged-in Swiggy account in Accounts.');
  }
  return accountWithBinding(workspace, key, map[key]);
}
async function verifyAndBindAccount(provider, user, ws, key, saved) {
  const fingerprint = sessionFingerprint(saved);
  if (!fingerprint) throw error(409, 'Selected ID ka session available nahi hai. Admin se baat karein.');
  const live = await provider.verifySession({ ...saved, __proPrivate: true }).catch(() => null);
  const resolved = validCustomerId(live?.customerId);
  if (live?.valid !== true || !resolved) throw error(409, 'Selected ID ka Swiggy session verify nahi hua. Doosri ID chunein ya admin se baat karein.');
  const original = validCustomerId(saved.customerId);
  if (original && original !== resolved) throw error(409, 'Selected ID ka session saved customer se match nahi hua. Admin se baat karein.');
  ws.sessionBindings ||= {};
  ws.sessionBindings[key] = { fingerprint, customerId: resolved };
  writeProWorkspace(user.id, ws);
  return resolved;
}
async function ensureAccountCustomerId(provider, user, ws, account) {
  const existing = validCustomerId(account?.customerId);
  if (existing) return existing;
  const key = String(ws.activeAccountKey || '');
  const saved = accountMap(user, ws)[key];
  if (!key || !saved) return '';
  try {
    const id = await verifyAndBindAccount(provider, user, ws, key, saved);
    account.customerId = id;
    return id;
  } catch { return ''; }
}
function requireEditableCart(ws) {
  if (ws.checkout && ws.checkout.status !== 'PAID') {
    throw error(409, 'Resolve the existing Swiggy checkout before changing the draft cart or receiver.');
  }
}
function invalidateAccountDependentState(ws) {
  ws.selectedAddress = null;
  ws.addressCandidates = [];
  ws.pendingAddress = null;
  ws.menu = null;
  if (ws.cart) ws.cart.quote = null;
}
/** JWT ke andar se sirf asli numeric user id — kuch invent nahi. */
function jwtIdentity(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return '';
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const id = String(claims?.user_id ?? claims?.customer_id ?? claims?.uid ?? '');
    return /^\d{2,20}$/.test(id) && id !== '0' && id !== '-1' ? id : '';
  } catch { return ''; }
}
function cleanAddress(a) {
  return {
    name: String(a?.name || '').slice(0, 120), mobile: normalizeIndianMobileNumber(a?.mobile || '') || '',
    address: String(a?.address || '').slice(0, 500), area: String(a?.area || '').slice(0, 200),
    city: String(a?.city || '').slice(0, 100), flat_no: String(a?.flat_no || '').slice(0, 100),
    landmark: String(a?.landmark || '').slice(0, 200), lat: String(a?.lat || ''), lng: String(a?.lng || ''),
    annotation: String(a?.annotation || 'OTHER').slice(0, 50), id: String(a?.id || '').slice(0, 100)
  };
}
function activeAccountForClient(user, ws) {
  return listAccounts(user, ws).find(a => a.active) || null;
}
function safeTrackingUrl(value, orderId) {
  let link = String(value || '').trim();
  // Swiggy kabhi `swiggy://share?text=https://…/ofo/track/<token>` bhejta hai —
  // usme se asli https link nikaal lo, warna customer ko khaali link dikhta.
  if (!/^https:\/\//i.test(link)) {
    let candidate = '';
    try {
      const url = new URL(link);
      candidate = url.searchParams.get('text') || url.searchParams.get('url') || url.searchParams.get('link') || '';
    } catch { candidate = ''; }
    if (!candidate) {
      const inner = link.match(/https?:\/\/[^\s&"']+/i) || link.match(/https?%3A%2F%2F[^\s&"']+/i);
      candidate = inner ? decodeURIComponent(inner[0]) : '';
    }
    link = /^https?:\/\//i.test(candidate.trim()) ? candidate.trim() : '';
  }
  if (!/^https:\/\//i.test(link) || !isOfficialSwiggyTrackingUrl(link, { allowProviderShortLink: true }) ||
      !validateTrackingUrlForOrder(link, { swiggyOrderId: orderId }, 'SWIGGY_API')) return '';
  try {
    const pathId = new URL(link).pathname.match(/\/(?:orders?|track|tracking)\/(\d{10,20})(?:\/|$)/i)?.[1];
    return pathId && pathId !== String(orderId) ? '' : link;
  } catch { return ''; }
}
/**
 * `restricted` = user ne operator (shared) ID par order kiya. Us haalat me
 * operator ka poora number, delivery OTP aur rider nahi dikhte.
 *
 * Round 19 (boss 31-10-2026): "SAME ISSUE TRACKING LINK BHI NAHI AARAHA".
 * Isliye tracking ka **link + status/ETA** ab restricted user ko bhi milta hai
 * — link Swiggy ka public tracking page hai, private detail nahi.
 */
function publicRestrictedTracking(tracking) {
  if (!tracking || typeof tracking !== 'object') return null;
  const link = /^https:\/\//i.test(String(tracking.trackingUrl || '')) ? String(tracking.trackingUrl) : '';
  return {
    orderId: String(tracking.orderId || ''),
    status: String(tracking.status || '').slice(0, 200),
    eta: String(tracking.eta || '').slice(0, 100),
    trackingUrl: link,
    deliveryOtp: '',
    deliveryPartner: { name: '', phone: '' },
    restricted: true,
    via: String(tracking.via || ''),
    tried: Array.isArray(tracking.tried) ? tracking.tried.slice(0, 4) : [],
    sms: tracking.sms || null,
    note: (() => {
      const truth = describeTrackingTruth({
        trackingUrl: link, via: tracking.via, tried: tracking.tried, orderStatus: tracking.status, restricted: true, attempts: tracking.attempts
      });
      return truth.ok
        ? `${truth.line} OTP/address sirf operator ke paas rehta hai.`
        : truth.reason;
    })()
  };
}
function publicCheckout(checkout, { restricted = false } = {}) {
  if (!checkout) return null;
  const output = {
    status: String(checkout.status || 'UNKNOWN'), createdAt: String(checkout.createdAt || ''),
    accountPhone: restricted ? maskAccountPhone(checkout.accountPhone) : String(checkout.accountPhone || ''),
    orderId: String(checkout.orderId || ''), amount: Number(checkout.amount) || 0,
    restaurantName: String(checkout.restaurantName || ''),
    ofoConfirmed: checkout.ofoConfirmed === true,
    paymentVerified: checkout.paymentVerified === true,
    message: String(checkout.message || ''),
    tracking: restricted ? publicRestrictedTracking(checkout.tracking) : (checkout.tracking || null),
    // Round 21: SMS ka poora sach (line + state) aur tracking ka reason.
    receiverMasked: maskAccountPhone(checkout.receiverPhone || ''),
    sms: smsTruthFor(checkout),
    restricted: restricted === true,
    // Round 12: order bana par QR nahi mila — asli wajah + (agar Swiggy ne
    // diya ho to) uske payment page ka link. Koi apna banaya hua link nahi.
    qrSource: String(checkout.qrSource || '').slice(0, 30),
    qrMissing: checkout.qrMissing === true,
    qrMissingReason: String(checkout.qrMissingReason || ''),
    // Asli wajahon ki list (round 15) — app inhe line-by-line dikhata hai.
    qrMissingReasons: Array.isArray(checkout.qrMissingReasons) ? checkout.qrMissingReasons.slice(0, 3).map(String) : [],
    paymentPageUrl: /^https:\/\//i.test(String(checkout.paymentPageUrl || '')) ? String(checkout.paymentPageUrl) : ''
  };
  if (checkout.status === 'PAYMENT_PENDING' && checkout.paymentVerified !== true && checkout.upiIntentUrl && checkout.qrDataUrl) {
    output.upiIntentUrl = checkout.upiIntentUrl;
    output.qrDataUrl = checkout.qrDataUrl;
  }
  return output;
}
/**
 * Boss: "direct cart wale page par le jaye — ek auto ID select karke."
 * Sirf tab jab user ne khud koi ID na chuni ho, aur sirf selectable ID.
 */
function autoSelectAccount(user, ws) {
  try {
    if (ws.activeAccountKey) return;
    const rows = listAccounts(user, ws);
    const pick = rows.find(r => r.selectable);
    if (!pick) return;
    ws.activeAccountKey = pick.key;
    invalidateAccountDependentState(ws);
    writeProWorkspace(user.id, ws);
  } catch { /* auto-select fail ho to user khud chun sakta hai */ }
}

/**
 * Boss (31-10-2026): "BILL CALCULATION BHI NA HORAHA SAHI SE — IMAGE JAISA HONA
 * CHAHIYE." Swiggy screenshot: Item total (list strike), Delivery FREE,
 * GST & other charges, To Pay. Yahan hum sirf wahi numbers rakhte hain jo
 * Swiggy ne diye, aur lines ko itna banana ki unka jod To Pay ke barabar ho.
 * Jod nahi milta to hum chupe nahi rakhte — `mismatch` sach bolta hai.
 */
function round2(value) { return Math.round(Number(value) * 100) / 100; }
/**
 * Bill ka sach ek hi jagah (`bill-reconcile.js`) — yahan sirf app ka shape.
 * Har possibility (string money, missing total, packing inside GST, free cash
 * payable se zyada, coupon bina discount, lines vs To Pay) wahan handle hoti
 * hai; jo jod nahi milta wo `checks`/`problems` me saamne aata hai.
 */
function billBreakdown(bill, { expectedTotal = null, items = [] } = {}) {
  if (!bill || typeof bill !== 'object') return bill;
  const result = reconcileBill(bill, { expectedTotal, items });
  if (!result.bill) return bill;
  const out = {
    ...result.bill,
    billState: describeBillState(result),
    checks: result.checks.map((c) => ({ key: c.key, ok: c.ok })),
    problems: result.problems.map((p) => ({ code: p.code, message: p.message })),
    notes: result.notes.map((n) => ({ code: n.code, message: n.message }))
  };
  // `mismatch` app ke purane contract ke liye: sirf tab true jab lines jod
  // nahi khaati ya approved total badal gaya ho (wajah `problems` me hai).
  out.mismatch = result.problems.some((p) => p.code === 'BILL_DOES_NOT_ADD_UP' || p.code === 'BILL_TOTAL_CHANGED');
  return out;
}

/**
 * Round 33: quote ko workspace me likhna — sync aur optimize dono ek hi jagah.
 * (Pehle sirf sync likhta tha; optimize aate hi duplicate code na ho.)
 */
function saveProviderQuote(ws, quote) {
  if (Array.isArray(quote?.bill?.subscriptionItems)) ws.cart.activeSubscriptionItems = quote.bill.subscriptionItems;
  ws.selectedAddress = cleanAddress(quote.address);
  // Round 34: ab confirmed address yaad rehta hai — agla bill 2 Swiggy call
  // bacha kar turant aata hai (fingerprint match hone par hi reuse).
  if (quote?.addressFingerprint && ws.cart) {
    ws.cart.confirmedAddress = {
      ...cleanAddress(quote.address),
      id: String(quote.address?.id || ''),
      fingerprint: String(quote.addressFingerprint),
      savedAt: Date.now()
    };
  }
  ws.cart.quote = {
    ...billBreakdown(quote.bill, { items: ws.cart?.items || [] }),
    // Asli coupon code (billBreakdown discount na hone par isse clear kar
    // deta hai) — checkout isi se Swiggy ka live coupon match karta hai.
    couponCode: String(quote.bill?.couponCode || quote.bill?.coupon || '').toUpperCase(),
    couponSaving: Number(quote.bill?.discount) > 0 ? Number(quote.bill.discount) : 0,
    couponReason: String(quote.bill?.couponReason || '').slice(0, 160),
    offerTracks: Array.isArray(quote.bill?.offerTracks) ? quote.bill.offerTracks.slice(0, 2) : [],
    autoCoupon: quote.bill?.autoCoupon === true,
    couponTried: Array.isArray(quote.bill?.couponTried) ? quote.bill.couponTried.slice(0, 5) : [],
    ofoConfirmed: quote.ofoConfirmed === true,
    // Bill turant aaya, par offers/One Lite/coupon ka check bacha hai.
    optimizePending: quote.optimizePending === true,
    // Round 35: offer claim ka SACH — free cash laga, ya Swiggy ne mana kiya.
    // Bill card par ek chhoti line, taaki "free cash nahi laga" ka andhera na rahe.
    offerNote: String(quote.offerNote || '').slice(0, 160),
    fetchedAt: new Date().toISOString()
  };
  return ws.cart.quote;
}
/**
 * Mini App me claim aur delete jaise write kaam ke liye ek hi jagah.
 * Boss ka account shared vault me, user ka uske apne workspace me.
 */
function persistAccountPatch(user, ws, key, patch) {
  if (isBoss(user.id)) { updateAccount(key, patch); return; }
  if (!Object.prototype.hasOwnProperty.call(ws.accounts || {}, key)) throw error(404, 'Account not found.');
  ws.accounts[key] = { ...ws.accounts[key], ...patch };
}
function removeAccountLocally(user, ws, key) {
  if (isBoss(user.id)) {
    // Boss ne Swiggy se delete kar diya — local vault se bhi hatao.
    deleteAccount(key, { purgeVault: true });
    return;
  }
  delete ws.accounts[key];
}
function offerClaimSummary(result) {
  const offers = result?.offers && typeof result.offers === 'object' ? result.offers : {};
  return OFFER_TRACKS.map(track => {
    const rec = offers[track.key] || null;
    return {
      key: track.key, label: track.label, emoji: track.emoji,
      status: offerTrackStatus(rec),
      verified: rec?.verified === true,
      message: String(rec?.message || '').slice(0, 200)
    };
  });
}

/**
 * Backup ka sach: boss ko poora detail (kahan fail hua), user ko bas itna ki
 * uska data mirror me hai ya nahi. Jhooth nahi — jo hai wahi.
 */
function userBackupView(user) {
  const status = proBackupStatus();
  if (isBoss(user.id)) return status;
  return {
    cloud: { enabled: cloudBackupEnabled() },
    dbMirror: { enabled: true, rows: status.dbMirror.rows },
    restored: { count: status.restored.count, lastAt: status.restored.lastAt }
  };
}

function checkoutEnabled() {
  if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1') return false;
  return process.env.PRO_ENABLE_CHECKOUT !== '0';
}
/** Payment band hone ki asli wajah — bina wajah koi dead end nahi. */
function checkoutBlockReason() {
  if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1') return 'Live order placement is blocked in this environment (SWIGGY_BLOCK_LIVE_ORDER_PLACE=1).';
  if (process.env.PRO_ENABLE_CHECKOUT === '0') return 'In-app checkout is turned off by PRO_ENABLE_CHECKOUT=0.';
  return '';
}

/**
 * Boss (31-10-2026, round 11): "WHEN WE PAY OUR WALLET MUST REACH A BALANCE OF
 * 15 OTHERWISE IT WILL SAY YOUR BALANCE IS LOW ADD AMOUNT TO YOUR WALLET."
 *
 * Mini App ka wallet — wahi vault jo Telegram bot use karta hai (ek hi ledger).
 * Balance paise me rehta hai; app ko rupees (string) aur paise dono milte hain.
 */
function walletView(user, { history = false } = {}) {
  const db = getDb();
  const wallet = getWallet(db, user.id);
  const balancePaise = walletBalancePaise(db, user.id);
  const feePaise = serviceFeePaiseFor(db);
  const exempt = isBoss(user.id) || Boolean(wallet?.feeExempt);
  const shortfallPaise = exempt || feePaise <= 0 ? 0 : Math.max(0, feePaise - balancePaise);
  return {
    balancePaise, balance: rupees(balancePaise),
    feePaise, fee: rupees(feePaise),
    exempt, ready: shortfallPaise === 0,
    shortfallPaise, shortfall: rupees(shortfallPaise),
    upiId: walletUpiId(db),
    minTopupPaise: minTopupPaise(),
    presets: TOPUP_PRESETS_PAISE.map(paise => ({ paise, rupees: rupees(paise) })),
    ...(history ? { history: walletHistory(db, user.id, { limit: 6 }) } : {})
  };
}

/** ₹ me value — app rupees bhejta hai, server paise me kaam karta hai. */
function amountPaiseFromBody(body) {
  const direct = Number(body?.amountPaise);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const value = Number(body?.amount ?? body?.amountRupees ?? body?.paid);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

const TOPUP_MAX_PAISE = 50000; // ₹500
// Boss (31-10-2026, round 16): "JITNA BOL RAHA" — credit wahi hoga jitne ka
// top-up QR bana tha. Isliye har top-up ek intent ke roop me server par rehta
// hai (10 minute), aur claim usi intent ke amount par hota hai.
const TOPUP_INTENT_TTL_MS = 10 * 60 * 1000;

function topupIntents(db) {
  const c = db.config || (db.config = {});
  if (!c.topupIntents || typeof c.topupIntents !== 'object') c.topupIntents = {};
  return c.topupIntents;
}

function createTopupIntent(db, userId, amountPaise) {
  const all = topupIntents(db);
  const now = Date.now();
  // Ek user ke paas ek hi zinda top-up — purane khule intent band (warna ek
  // user kai intent bana kar uljha sakta tha).
  for (const rec of Object.values(all)) {
    if (String(rec.userId) === String(userId) && !rec.usedAt && Number(rec.expiresAt || 0) > now) {
      rec.usedAt = new Date(now).toISOString();
      rec.supersededBy = 'naya top-up khula';
    }
  }
  const id = `ti_${now}_${crypto.randomBytes(3).toString('hex')}`;
  all[id] = {
    id, userId: String(userId), amountPaise: Math.round(Number(amountPaise) || 0),
    createdAt: new Date(now).toISOString(), expiresAt: now + TOPUP_INTENT_TTL_MS,
    usedAt: '', requestId: ''
  };
  // Purane expired intents hatao (max 500 rakho) — UTR ledger alag hai, ye
  // sirf pending QR ka record hai.
  const ids = Object.keys(all);
  for (const key of ids) {
    if (ids.length <= 500) break;
    const rec = all[key];
    if (rec.usedAt || Number(rec.expiresAt || 0) < now) { delete all[key]; ids.splice(ids.indexOf(key), 1); }
  }
  return all[id];
}

function resolveTopupIntent(db, userId, topupId) {
  const all = topupIntents(db);
  const now = Date.now();
  const usable = (rec) => rec && !rec.usedAt && Number(rec.expiresAt || 0) > now && String(rec.userId) === String(userId);
  const wanted = topupId ? all[String(topupId)] : null;
  if (wanted) return usable(wanted) ? wanted : null;
  // topupId na diya ho to us user ka sabse taaza zinda intent.
  const mine = Object.values(all)
    .filter(usable)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return mine[0] || null;
}

function markTopupIntentUsed(db, intentId, requestId = '') {
  const rec = topupIntents(db)[String(intentId || '')];
  if (!rec) return;
  rec.usedAt = new Date().toISOString();
  rec.requestId = String(requestId || '');
}


/**
 * "I have paid" — boss ka rule: "IF USER PAY LESS AND SAY I HAVE PAID YOU HAVE
 * TO ADD HOW MUCH THEY PAID." Isliye jo unho ne bataya wahi jama hota hai, aur
 * ledger me CLAIMED likha rehta hai (jhootha "verified" nahi). UTR/provider
 * mila to wahi paisa asli mana jaata hai.
 */
/**
 * Round 25: boss ka UTR tracker — "UTR SE SAB DETAILS".
 * Har lookup db me yaad rehta hai (`config.utrLookups`), taaki baad me bhi
 * poochha ja sake: kab aaya, kisko, kitna, kis user ne daala.
 */
function rememberUtrLookup(db, { utr, userId = '', name = '', truth = null, request = null, at = Date.now() } = {}) {
  const key = String(utr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key) return null;
  if (!db.config.utrLookups || typeof db.config.utrLookups !== 'object') db.config.utrLookups = {};
  const row = {
    utr: key,
    at: new Date(at).toISOString(),
    userId: String(userId || ''),
    name: String(name || '').slice(0, 60),
    claimId: String(request?.id || ''),
    found: Boolean(truth?.found ?? request?.lookup?.found),
    amountPaise: Number(truth?.amountPaise || 0),
    askedPaise: Number(truth?.askedPaise || 0),
    paidAt: String(truth?.paidAt || ''),
    freshness: String(truth?.freshness || ''),
    payeeOurs: truth?.payeeOurs === true,
    payeeLine: String(truth?.payeeLine || '').slice(0, 160),
    verdictAction: String(truth?.verdictAction || ''),
    verdictCode: String(truth?.verdictCode || ''),
    summaryLine: String(truth?.summaryLine || '').slice(0, 240)
  };
  db.config.utrLookups[key] = row;
  const keys = Object.keys(db.config.utrLookups);
  if (keys.length > 500) {
    keys.sort((a, b) => String(db.config.utrLookups[a]?.at || '').localeCompare(String(db.config.utrLookups[b]?.at || '')));
    for (const old of keys.slice(0, keys.length - 500)) delete db.config.utrLookups[old];
  }
  return row;
}

/** Boss ko UTR ki poori detail — pehle db/ledger, phir live provider. */
async function utrTruthForBoss(user, body = {}) {
  const db = getDb();
  const raw = String(body?.utr || '').trim();
  const checked = validateUtr(raw);
  if (!raw) {
    const e = error(400, 'UTR daalein — 12 digit ka UPI reference number.');
    e.code = 'UTR_REQUIRED';
    throw e;
  }
  if (!checked.ok) {
    const e = error(400, `UTR galat hai (${checked.reason}).`);
    e.code = 'UTR_INVALID';
    throw e;
  }
  const utr = checked.utr;
  const cached = db.config?.utrLookups?.[utr] || null;
  const statementEntry = db.config?.upiStatement?.[utr] || null;
  let lookup = { configured: true, found: false, payment: null, reason: '' };
  const wantsLive = body?.refresh !== false;
  if (wantsLive) {
    lookup = await fetchUtrPaymentDetails(utr, { userId: `boss:${user.id}` })
      .catch((err) => ({ configured: false, found: false, payment: null, reason: String(err?.message || err), tried: [] }));
  }
  const statementPayment = statementEntry ? { ...statementEntry, source: statementEntry.source || 'statement' } : null;
  const payment = statementPayment || (lookup.found ? { ...lookup.payment, utr, source: 'provider' } : null);
  const usedUtr = findUsedUtr(db, utr) || null;
  const claim = Object.values(db.config?.topupRequests || {})
    .find((row) => String(row?.utr || '').toUpperCase() === utr) || null;
  const truth = describeUtrPayment({
    utr, payment, lookup, usedUtr, claimedPaise: Number(body?.amountPaise || 0), now: Date.now(), allowedPayeeVpas: [walletUpiId(db)]
  });
  if (wantsLive) {
    rememberUtrLookup(db, {
      utr, userId: `boss:${user.id}`, name: 'boss',
      truth: { ...truth, found: Boolean(payment) }, request: claim
    });
    saveDb(db);
  }
  return {
    ok: true,
    utr,
    truth: { ...truth, rows: utrTruthRows(truth) },
    bossLine: truth.bossLine,
    ledger: usedUtr ? { status: usedUtr.status, userId: usedUtr.userId, at: usedUtr.at, amountPaise: usedUtr.amountPaise } : null,
    lastTrackedAt: cached?.at || '',
    claim: claim ? { id: claim.id, userId: claim.userId, status: claim.status, claimedPaise: claim.claimedPaise, approvedPaise: claim.approvedPaise, at: claim.at } : null,
    history: Object.values(db.config?.utrLookups || {})
      .filter((row) => String(row.utr) === utr)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 10)
  };
}

async function claimWalletTopup(user, body) {
  let db = getDb();
  ensureWallet(db, user.id, { name: user.firstName || '' });
  // Boss (31-10-2026, round 16):
  //   "DUSRE KA UTR BHI AGAR KOI DAAL RAHA TO USSE PAYMENT LE LE RHA"
  //   "JITNA BOL RAHA" aur "SAME UTR BAAR BAAR USE KAR PAA RAHA"
  // Isliye: (1) UTR ke bina credit nahi, (2) UTR globally ek hi baar,
  // (3) credit SIRF utne paise jitne ka top-up QR bana tha — user jo likhe wo
  // nahi. Jo bhi in teeno se hat kar aaye, uska asli reason dikhta hai.
  const utrRaw = String(body?.utr || '').trim();
  const utrCheck = validateUtr(utrRaw);
  if (!utrRaw) {
    const e = error(400, 'UTR daalna zaroori hai — UPI app ke payment detail me 12 digit ka UTR milta hai.');
    e.code = 'UTR_REQUIRED';
    e.field = 'utr';
    throw e;
  }
  if (!utrCheck.ok) {
    const e = error(400, `UTR galat hai (${utrCheck.reason}). UPI app me payment kholein aur poora UTR copy karein.`);
    e.code = 'UTR_INVALID';
    e.field = 'utr';
    throw e;
  }
  const utr = utrCheck.utr;
  const used = findUsedUtr(db, utr);
  if (used) {
    const e = error(409, used.userId && String(used.userId) !== String(user.id)
      ? 'Ye UTR pehle kisi aur ke top-up me use ho chuka hai — ek UTR sirf ek hi baar chalta hai.'
      : 'Ye UTR pehle use ho chuka hai — ek UTR sirf ek hi baar chalta hai.');
    e.code = 'DUPLICATE_UTR';
    throw e;
  }
  // Boss (31-10-2026, round 23): "BAS USER KO BOL SEND HOW MUCH MONEY YOU WANT
  // THAT WILL BE FETCHED AND ADDED UPON SUBMITTING UTR". Isliye user pehle
  // top-up QR khole ya na khole — wo jitna paisa bhejna chahta hai utna likh kar
  // UTR daal sakta hai. Server usi waqt itne ka intent bana leta hai (10 min,
  // ek user = ek zinda intent), phir UTR se asli payment detail fetch hoti hai.
  const toldPaise = amountPaiseFromBody(body);
  let intent = resolveTopupIntent(db, user.id, body?.topupId);
  // Purana top-up (id diya par use ho chuka / expire) — usi id par naya credit
  // nahi. Naya paisa bhejna hai to naya UTR + naya top-up.
  if (!intent && body?.topupId) {
    const e = error(409, 'Ye top-up pehle use ho chuka hai ya expire ho gaya — naya paisa bhejne ke liye naya amount likh kar naya UTR daalein.');
    e.code = 'NO_TOPUP_INTENT';
    throw e;
  }
  if (!intent && toldPaise > 0) {
    if (toldPaise < 100) throw error(400, '₹1 se kam ka top-up nahi hota.');
    if (toldPaise > TOPUP_MAX_PAISE) throw error(400, `Ek baar me ₹${rupees(TOPUP_MAX_PAISE)} tak hi add kar sakte hain.`);
    intent = createTopupIntent(db, user.id, toldPaise);
    intent.implicit = true;
    saveDb(db);
  }
  if (!intent) {
    const e = error(409, 'Jitna paisa bhejna hai utna likhein (₹) aur UTR daalein — ya pehle top-up QR kholein. Bina amount/UTR ke credit nahi hota.');
    e.code = 'NO_TOPUP_INTENT';
    throw e;
  }
  const claimedPaise = intent.amountPaise;
  if (toldPaise > 0 && Math.abs(toldPaise - claimedPaise) >= 1) {
    // Implicit intent me amount wahi hota hai; QR wale intent me user ka likha
    // amount alag ho to saaf batao ki credit asli (fetched) amount par hoga.
    const e = error(409, `Top-up ₹${rupees(claimedPaise)} ka tha; aap ₹${rupees(toldPaise)} bata rahe hain. Credit wahi hoga jo UTR se fetch hoga — galat amount nahi judega.`);
    e.code = 'TOPUP_AMOUNT_MISMATCH';
    e.amountPaise = claimedPaise;
    e.toldPaise = toldPaise;
    throw e;
  }
  if (claimedPaise < 100) throw error(400, 'Top-up ₹1 se zyada hona chahiye.');
  if (claimedPaise > TOPUP_MAX_PAISE) throw error(400, `Ek baar me ₹${rupees(TOPUP_MAX_PAISE)} tak hi add kar sakte hain.`);
  let verified = false;
  let creditPaise = claimedPaise;
  let request = null;
  {
    // Boss (31-10-2026, round 17): bina provider verify, bada amount apne aap
    // credit karna hi "jitna bol raha" ka darwaza tha. Ab auto-credit sirf
    // chhote amount tak (default ₹15 = ek order ki fee); usse zyada → PENDING,
    // boss approve karega. Env: WALLET_AUTO_CREDIT_MAX_PAISE.
    // Boss (31-10-2026, round 20): ab har claim par asli proof check hota hai
    // (bank/UPI statement ya provider verify). Bina proof credit NAHI — sirf
    // PENDING. Chhota amount bhi bina proof nahi judega, isliye random UTR se
    // wallet bharne ka rasta band. Bada verified amount boss approval par.
    const autoMaxPaise = (() => {
      const raw = Number(process.env.WALLET_AUTO_CREDIT_MAX_PAISE);
      return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 1500;
    })();
    const lookupResult = await fetchUtrPaymentDetails(utr, { userId: user.id })
      .catch(err => ({ configured: false, found: false, reason: String(err?.message || err), tried: [] }));
    // Do not write a pre-lookup snapshot over wallet changes made while the
    // provider was slow. Recheck both the intent and UTR against the latest DB.
    db = getDb();
    intent = resolveTopupIntent(db, user.id, intent.id);
    if (!intent) {
      const e = error(409, 'Top-up intent expired or already used.');
      e.code = 'NO_TOPUP_INTENT';
      throw e;
    }
    const submitted = submitTopupRequestWithLookup(db, {
      userId: user.id, utr, amountPaise: claimedPaise, name: user.firstName || '',
      note: `Mini App claim ₹${rupees(claimedPaise)}`,
      autoVerify: true, minPaise: 100, autoMaxPaise, lookupResult
    });
    if (!submitted.ok) {
      if (submitted.request && !saveDbDurable(db)) throw error(503, 'Recharge record save nahi hua. Admin se baat karein.');
      const code = String(submitted.code || '');
      const status = code === 'DUPLICATE_UTR' || code === 'UTR_ALREADY_USED' ? 409 : 400;
      const e = error(status, submitted.reason || 'UTR accept nahi hua.');
      e.code = code;
      throw e;
    }
    request = submitted.request;
    verified = submitted.code === 'AUTO_VERIFIED';
    // Round 23: credit wahi hai jo UTR se fetch hua (asli aaya amount) — user ka
    // likha amount nahi. Response me bhi wahi sach jaata hai.
    if (verified && Number(submitted.creditedPaise) > 0) creditPaise = Number(submitted.creditedPaise);
    if (request) markTopupIntentUsed(db, intent.id, request.id);
  }
  if (!db.config.topupClaims || typeof db.config.topupClaims !== 'object') db.config.topupClaims = {};
  const pending = String(request?.status || '').toUpperCase() === 'PENDING';
  if (pending) creditPaise = 0; // jhooth nahi — abhi kuch jama nahi hua
  if (request) db.config.topupClaims[request.id] = { ...request, creditedPaise: creditPaise, utr };
  const utrTruth = request?.utrTruth || null;
  rememberUtrLookup(db, { utr, userId: user.id, name: user.firstName || '', truth: utrTruth, request });
  if (!saveDbDurable(db)) throw error(503, 'Recharge record save nahi hua. Admin se baat karein.');
  const wallet = walletView(user, { history: true });
  return {
    requestId: String(request?.id || ''),
    wallet,
    verified,
    creditedPaise: creditPaise,
    pending,
    verifyNote: String(request?.verifyPendingReason || request?.reason || ''),
    lookupLine: String(request?.lookup?.line || ''),
    utrTruth: utrTruth ? { ...utrTruth, rows: utrTruthRows({ checklist: utrTruth.checklist }) } : null,
    message: pending
      ? `${request?.lookup?.line ? `${request.lookup.line} ` : ''}Abhi balance ₹${wallet.balance} hai — jitna paisa sach me aayega utna hi judega. ${String(request?.verifyPendingReason || '').slice(0, 140)}`.trim()
      : (wallet.ready
        ? `₹${rupees(creditPaise)} juda (UTR se fetch hua asli amount) — balance ₹${wallet.balance} hai, ab order place kar sakte hain.`
        : `₹${rupees(creditPaise)} juda (UTR se fetch hua asli amount). Abhi balance ₹${wallet.balance} hai — ₹${wallet.shortfall} aur add karein.`)
  };
}

/**
 * Boss (31-10-2026, round 13): "ID active karke order karke chhod kar chala gaya
 * to 2 minute of activity ke baad pura order band ho jayega."
 *
 * Har API call par pehle yahi chalta hai: agar draft/bill/checkout 2 minute se
 * zyada bina kisi asli activity ke pada hai to band. Paid order aur
 * outcome-unknown kabhi band nahi hote.
 */
const IDLE_ACTIVITY_EXEMPT = new Set([
  '/pro/api/bootstrap',            // page refresh activity nahi hai
  '/pro/api/checkout/status',      // status poll order ko zinda nahi rakhta
  '/pro/api/orders',
  '/pro/api/orders/tracking'
]);

function applyIdleExpiry(user, ws, { route = '' } = {}) {
  const now = Date.now();
  const db = getDb();
  const timeout = idleTimeoutMs(db);
  let placementInFlight = false;
  if (ws?.checkout && String(ws.checkout.status || '').toUpperCase() === 'SUBMITTING') {
    try {
      placementInFlight = Boolean(readSwiggyPlacement(`pro:${user.id}:${ws.checkoutGeneration ?? 0}`));
    } catch { placementInFlight = true; } // journal padha na jaye to ruk jao
  }
  const plan = planIdleExpiry({ ws, now, timeoutMs: timeout, placementInFlight });
  let changed = false;

  if (plan.expire) {
    let feeRefundPaise = 0;
    if (plan.refundFee && ws.checkout) {
      const walletDb = getDb();
      const refunded = refundServiceFee(walletDb, ws.checkout, user.id, { reason: 'draft 2 minute idle tha — band' });
      if (refunded?.ok) { feeRefundPaise = Number(refunded.refundedPaise || 0); saveDb(walletDb); }
    }
    const record = {
      at: plan.idledAt, kind: plan.kind, orderId: plan.orderId,
      idleMs: plan.idleMs, refundedPaise: feeRefundPaise,
      amount: Number(ws.checkout?.amount || 0) || null,
      accountKey: String(ws.checkout?.accountKey || ws.activeAccountKey || ''),
      reason: String(ws.checkout?.message || '').slice(0, 200)
    };
    record.message = describeIdleClosure(record);
    ws.abandoned = Array.isArray(ws.abandoned) ? ws.abandoned.slice(-9) : [];
    ws.abandoned.push(record);
    // Placed-unpaid order ka journal record rehta hai — usi key par naya
    // placement block hota, isliye generation aage badhata hai (naya order
    // possible, par Swiggy par pada unpaid order app me dikhta rahega).
    if (plan.kind === 'PLACED_UNPAID') {
      const generation = ws.checkoutGeneration ?? 0;
      if (Number.isSafeInteger(generation) && generation < Number.MAX_SAFE_INTEGER) ws.checkoutGeneration = generation + 1;
    }
    ws.checkout = null;
    ws.cart = null;
    ws.lastClosed = record;
    changed = true;
  }

  if (!IDLE_ACTIVITY_EXEMPT.has(route)) {
    const before = Date.parse(String(ws.lastActivityAt || '')) || 0;
    if (now - before > 5000) { touchActivity(ws, now); changed = true; }
  }
  return { changed, closed: plan.expire ? ws.abandoned[ws.abandoned.length - 1] : null, timeoutMs: timeout };
}

function draftDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
function chatCartDigest(cart) {
  return draftDigest({ restaurantId: String(cart?.restaurantId || ''), items: cart?.items || [], forSomeoneElse: cart?.forSomeoneElse === true });
}
function reconcileChatFlow(user, ws) {
  const flow = ws.chatFlow;
  if (!flow || flow.stage === 'DONE' || ws.checkout) return false;
  let changed = false;
  if (flow.accountKey && (ws.activeAccountKey !== flow.accountKey || !accountMap(user, ws)[flow.accountKey])) {
    preserveHandoffDraft(ws);
    flow.stage = 'ACCOUNT'; flow.accountKey = ''; flow.sessionFingerprint = '';
    ws.pendingAddress = null; ws.selectedAddress = null;
    if (ws.cart) ws.cart.quote = null;
    changed = true;
  } else if (['CART', 'BILL'].includes(flow.stage) && !ws.selectedAddress) {
    flow.stage = 'ADDRESS'; changed = true;
  } else if (flow.stage === 'BILL' && !ws.cart?.quote) {
    flow.stage = 'CART'; changed = true;
  }
  return changed;
}
function chatHandoffView(user, ws) {
  const pending = readChatHandoff(user.id);
  const ready = pending?.id && safeSwiggyShareUrl(pending.cartUrl) && safeSwiggyShareUrl(pending.addressUrl) && pending.cartUrl !== pending.addressUrl;
  const flow = ws.chatFlow && ws.chatFlow.stage !== 'DONE' ? ws.chatFlow : null;
  const newLink = ready && pending.id !== ws.chatFlow?.id ? pending.id : '';
  if (!flow && !newLink) return null;
  let stage = flow?.stage || '';
  if (stage === 'BILL' && !ws.cart?.quote) stage = 'CART';
  if (['CART', 'BILL'].includes(stage) && !ws.selectedAddress) stage = 'ADDRESS';
  if (flow?.accountKey && ws.activeAccountKey !== flow.accountKey) stage = 'ACCOUNT';
  return {
    pendingId: String(newLink || ''), activeId: String(flow?.id || ''), stage,
    address: stage === 'ADDRESS' ? (ws.pendingAddress || null) : null,
    cartFetched: stage === 'CART' && Boolean(ws.cart?.items?.length),
    existingDraft: Boolean(ws.cart || ws.selectedAddress || ws.pendingAddress || flow),
    blockedByCheckout: Boolean(ws.checkout), blockedByChatOrder: Boolean(getActiveUserOrder(user.id))
  };
}
function bossAccountAccessView() {
  const db = getDb();
  const accounts = Object.entries(db.config?.accounts || {}).map(([key, a]) => ({
    key, name: String(a?.swiggyName || a?.name || 'Swiggy ID').slice(0, 80), phoneMasked: maskAccountPhone(a?.phone || a?.mobile || '')
  }));
  const users = Object.entries(db.knownUsers || {})
    .filter(([id]) => /^\d{1,20}$/.test(id) && !isBoss(id))
    .sort((a, b) => Number(b[1]?.lastSeen || 0) - Number(a[1]?.lastSeen || 0)).slice(0, 300)
    .map(([id, u]) => ({
      id, name: String([u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.username || id).slice(0, 80),
      allowed: accounts.filter(a => sharedAccountAllowed(db, id, a.key)).map(a => a.key)
    }));
  return { accounts, users };
}
function preserveHandoffDraft(ws) {
  if (!ws.cart && !ws.selectedAddress && !ws.pendingAddress && !ws.chatFlow) return;
  ws.handoffDraftBackups ||= [];
  ws.handoffDraftBackups.push(structuredClone({
    savedAt: new Date().toISOString(), activeAccountKey: ws.activeAccountKey || '',
    selectedAddress: ws.selectedAddress || null, pendingAddress: ws.pendingAddress || null,
    cart: ws.cart || null, chatFlow: ws.chatFlow || null
  }));
}
function requireChatFlow(user, ws, body, stages, { checkAccount = true } = {}) {
  const flow = ws.chatFlow;
  if (!flow || flow.stage === 'DONE' || String(body?.handoffId || '') !== String(flow.id)) throw error(409, 'Links badal gaye. Mini App refresh karein.');
  if (ws.checkout) throw error(409, 'Pehle existing checkout check karein.');
  if (!stages.includes(flow.stage)) throw error(409, 'Pehle pichla step complete karein.');
  if (checkAccount && flow.accountKey) {
    const saved = accountMap(user, ws)[flow.accountKey];
    if (ws.activeAccountKey !== flow.accountKey || !saved || !saved.isLoggedIn || saved.isLoggedOut ||
        !flow.sessionFingerprint || sessionFingerprint(saved) !== flow.sessionFingerprint) {
      throw error(409, 'Selected ID badal gayi ya unavailable hai. Mini App refresh karke ID phir chunein.');
    }
    const row = listAccounts(user, ws).find(a => a.key === flow.accountKey);
    if (!row || (!row.selectable && !(row.needsConfirm && flow.confirmedUsed))) throw error(409, row?.reason || 'Selected ID abhi available nahi hai.');
  }
  return flow;
}
async function quoteChatHandoff(provider, user, ws, flow, { quick }) {
  if (!ws.cart?.items?.length || flow.cartDigest !== chatCartDigest(ws.cart) ||
      !ws.selectedAddress || flow.addressDigest !== draftDigest(ws.selectedAddress)) {
    throw error(409, 'Cart ya address badal gaya. Dobara check karein.');
  }
  const account = currentAccount(user, ws);
  if (!validCustomerId(account.customerId)) throw error(409, 'Selected ID ko dobara verify karein.');
  if (getActiveUserOrder(user.id)) throw error(409, 'Chat mein active order hai. Pehle usko check karein.');
  enforceRateLimit(user, 'cartSync');
  ws.cart.quote = null;
  flow.stage = 'CART';
  writeProWorkspace(user.id, ws);
  const quote = await provider.quoteCart(account, ws.selectedAddress, { ...ws.cart, quickBill: quick, autoOneLite: false, skipOfferClaim: true }, '');
  if (!quote?.bill || exactPaise(quote.bill.total) === null || Number(quote.bill.total) <= 0 ||
      !quote.address?.id || !sameDeliveryRecipient(ws.selectedAddress, quote.address)) {
    throw error(502, 'Swiggy ne same address aur valid bill confirm nahi kiya. Koi order place nahi hua.');
  }
  ws.selectedAddress = cleanAddress(quote.address);
  flow.addressDigest = draftDigest(ws.selectedAddress);
  ws.cart.activeSubscriptionItems = Array.isArray(quote.bill.subscriptionItems) ? quote.bill.subscriptionItems : [];
  ws.cart.quote = {
    ...billBreakdown(quote.bill, { items: ws.cart.items }),
    couponCode: String(quote.bill.coupon || '').toUpperCase(), autoCoupon: quote.bill.autoCoupon === true,
    couponTried: Array.isArray(quote.bill.couponTried) ? quote.bill.couponTried.slice(0, 5) : [],
    ofoConfirmed: quote.ofoConfirmed === true, quickBill: quick, fetchedAt: new Date().toISOString()
  };
  flow.stage = 'BILL';
  writeProWorkspace(user.id, ws);
}
function publicState(user, ws) {
  const handoff = chatHandoffView(user, ws);
  // For a chat handoff the customer must explicitly choose or auto-choose.
  if (!handoff) autoSelectAccount(user, ws);
  return {
    user: { name: user.firstName || 'Friend', isBoss: isBoss(user.id) },
    orderFee: { paise: serviceFeePaiseFor(getDb()), exempt: isBoss(user.id) || Boolean(getWallet(getDb(), user.id)?.feeExempt) },
    accounts: listAccounts(user, ws), activeAccount: activeAccountForClient(user, ws),
    selectedAddress: ws.selectedAddress, cart: ws.cart, chatHandoff: chatHandoffView(user, ws),
    checkout: publicCheckout(ws.checkout, { restricted: Boolean(ws.checkout) && isSharedAccountFor(user, ws, ws.checkout.accountKey) }),
    // Boss (31-10-2026, round 3): "ACTUAL PAYMENT FLOW APPLY KAR." Ab in-app
    // checkout default ON hai; band karna ho to PRO_ENABLE_CHECKOUT=0.
    // Asli order placement ka hard block (SWIGGY_BLOCK_LIVE_ORDER_PLACE=1) phir
    // bhi sabse upar hai.
    checkoutEnabled: checkoutEnabled(),
    checkoutBlockReason: checkoutBlockReason()
  };
}
function checkoutAccount(user, ws) {
  const key = String(ws.checkout?.accountKey || '');
  const map = accountMap(user, ws);
  // Revoking a shared ID must stop new use but must not strand an already
  // submitted order. Only this checkout's original account is available for
  // status/recovery; normal account selection still requires a grant.
  const account = Object.prototype.hasOwnProperty.call(map, key) ? map[key]
    : (isSharedAccountFor(user, ws, key) ? sharedAccountMap()[key] : null);
  if (!account?.isLoggedIn || account.isLoggedOut) throw error(409, 'The original Swiggy account is unavailable. Reconnect that account before checking this order.');
  const bound = accountWithBinding(ws, key, account);
  if (ws.checkout?.accountSessionFingerprint && sessionFingerprint(account) !== ws.checkout.accountSessionFingerprint) {
    throw error(409, 'The original account session changed. Reconnect the verified original account before checking this order.');
  }
  const originalId = String(ws.checkout?.accountCustomerId || '').trim();
  if (originalId && String(bound.customerId || '').trim() !== originalId) throw error(409, 'The saved account no longer matches the original checkout account. Check Swiggy My Orders.');
  return bound;
}
/**
 * Boss (31-10-2026): "USER KO ORDER HISTORY ME BAS CHOTA CARD DIKHEGA, JAB ME
 * KHOLU TO PURA DETAILS." Shared (operator) ID par user ko sirf compact card —
 * address, item-wise detail aur tracking link nahi. Apne add kiye ID par aur
 * boss ke liye poora detail.
 */
function orderDetailAllowed(user, workspace, key) {
  return !isSharedAccountFor(user, workspace, key);
}
/**
 * Round 21: SMS ka sach ek jagah — receiver/Swiggy ke diye number aur Swiggy ke
 * payload me SMS flag ke hisaab se. Jhootha "SMS gaya" kabhi nahi.
 */
function smsTruthFor(checkout, { tracking = null } = {}) {
  const t = tracking || checkout?.tracking || null;
  return describeSmsTruth({
    sms: t?.sms || null,
    receiverPhone: checkout?.receiverPhone || '',
    accountPhone: checkout?.accountPhone || '',
    ofoRequested: checkout?.forSomeoneElse === true,
    ofoConfirmed: checkout?.ofoConfirmed === true,
    orderStatus: String(t?.status || checkout?.status || '')
  });
}

/**
 * Tracking/SMS ke liye order ka context: checkout wale order par checkout ka
 * sach, warna active account + abhi chuna hua address. Jahan number pata nahi,
 * wahan khaali — SMS ke baare me jhooth nahi bolte.
 */
function orderScopeContext(ws, scope) {
  if (scope === 'checkout') return ws.checkout || {};
  const account = (ws.accounts || {})[ws.activeAccountKey] || {};
  return {
    accountPhone: String(account.phone || ''),
    receiverPhone: String(normalizeIndianMobileNumber(ws.selectedAddress?.mobile) || ''),
    forSomeoneElse: ws.cart?.forSomeoneElse === true,
    ofoConfirmed: false
  };
}

/**
 * Boss (31-10-2026, round 21): "NO SMS RECEIVED". SMS sirf tab aata hai jab
 * order ASLI Swiggy par jaata hai. Agar ye environment block/sandbox me hai to
 * koi SMS aana hi nahi tha — ye sach UI me dikhta hai, chhupta nahi.
 */
function liveOrderStatus() {
  let sandbox = false;
  try { sandbox = isZeroSmsTestSandboxActive(); } catch { sandbox = false; }
  const blocked = process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1' || sandbox;
  return {
    blocked,
    sandbox,
    smsAllowed: process.env.ALLOW_LIVE_SWIGGY_SMS_ORDER === '1',
    nodeEnv: String(process.env.NODE_ENV || ''),
    line: blocked
      ? `Is environment me live order place band hai (${process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1' ? 'SWIGGY_BLOCK_LIVE_ORDER_PLACE=1' : 'sandbox/test mode'}) — isliye Swiggy ka SMS aana possible nahi tha.`
      : 'Live order path chalu hai — SMS/OTP Swiggy bhejta hai, bot nahi.'
  };
}

function compactOrder(order) {
  return {
    id: order.id, restaurant: order.restaurant, status: order.status,
    placedAt: order.placedAt, amount: order.amount,
    items: [], address: '', restricted: true
  };
}
function orderHistoryAccount(user, ws, scope) {
  if (scope === 'checkout') {
    if (!ws.checkout) throw error(404, 'No Mini App checkout exists.');
    return checkoutAccount(user, ws);
  }
  if (scope !== 'active') throw error(400, 'Invalid order history scope.');
  return currentAccount(user, ws);
}
function requireOriginalReconnect(user, ws, key, incoming) {
  if (!ws.checkout || ws.checkout.status === 'PAID') return;
  const saved = accountMap(user, ws)[ws.checkout.accountKey];
  const originalId = String(ws.checkout.accountCustomerId || saved?.customerId || '').trim();
  if (key !== ws.checkout.accountKey || !originalId || String(incoming.customerId || '').trim() !== originalId) {
    throw error(409, 'Only the verified original checkout account can be reconnected while its outcome is unresolved.');
  }
}
function storeAccount(user, ws, incoming) {
  const phone = normalizeIndianMobileNumber(incoming.phone || incoming.mobile || '') || '';
  const unresolved = Boolean(ws.checkout && ws.checkout.status !== 'PAID');
  if (isBoss(user.id)) {
    if (!phone) throw error(400, 'Swiggy did not return an account phone number.');
    const key = `acc_${phone}`;
    requireOriginalReconnect(user, ws, key, incoming);
    updateAccount(key, { ...incoming, phone, mobile: phone, isLoggedIn: true });
    ws.activeAccountKey = key;
  } else {
    const match = Object.entries(ws.accounts).find(([, a]) =>
      (phone && normalizeIndianMobileNumber(a.phone || a.mobile) === phone) ||
      (incoming.customerId && String(a.customerId || '') === String(incoming.customerId))
    );
    const key = match?.[0] || `private_${crypto.randomUUID()}`;
    requireOriginalReconnect(user, ws, key, incoming);
    ws.accounts[key] = { ...incoming, phone, mobile: phone, isLoggedIn: true };
    ws.activeAccountKey = key;
  }
  // Refreshing the verified original session must not erase the pending order.
  // Bind its new credentials only after requireOriginalReconnect matched the
  // provider-verified customer ID; a different account remains blocked.
  if (unresolved) {
    const fresh = accountMap(user, ws)[ws.activeAccountKey];
    ws.checkout.accountSessionFingerprint = sessionFingerprint(fresh);
  } else invalidateAccountDependentState(ws);
}

export async function handleSwiggyProHttp(req, res, { provider = proProvider, otp = defaultOtp, authorizeUser = null, claim = activateAllEventOffers, deleteOtp = defaultDeleteOtp, telegram = null } = {}) {
  const url = new URL(req.url || '/', 'http://local');
  const route = url.pathname;
  if (route !== '/pro' && !route.startsWith('/pro/')) return false;

  if (req.method === 'GET' && ASSETS[route]) {
    const [type, file] = ASSETS[route];
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https://media-assets.swiggy.com data:; connect-src 'self'; base-uri 'none'; form-action 'self'"
      });
      res.end(data);
    } catch { json(res, 500, { ok: false, error: 'Mini App asset missing.' }); }
    return true;
  }
  if (!route.startsWith('/pro/api/')) {
    json(res, 404, { ok: false, error: 'Not found.' });
    return true;
  }

  const user = verifyTelegramWebAppInitData(req.headers['x-telegram-init-data']);
  if (!user) {
    json(res, 401, { ok: false, error: 'Open this Mini App from the Telegram bot. Session may need to be reopened.' });
    return true;
  }
  // A menu-button launch bypasses Telegram chat middleware; explicitly apply
  // the same service-pause and membership policy to every Mini App API call.
  if (typeof authorizeUser !== 'function') {
    json(res, 503, { ok: false, error: 'Mini App access policy is not configured.' });
    return true;
  }
  try {
    const decision = await authorizeUser(user);
    if (!decision?.allowed) {
      json(res, 403, { ok: false, error: decision?.message || 'Mini App access is not available.' });
      return true;
    }
  } catch {
    json(res, 503, { ok: false, error: 'Unable to verify Mini App access. Please retry.' });
    return true;
  }

  await withProWorkspaceLock(user.id, async () => {
    try {
      // Redeploy ke baad naya disk khali ho sakta hai — encrypted workspace
      // cloud vault se wapas (sirf jab local file na ho).
      await ensureProWorkspaceHydrated(user.id);
      const ws = readProWorkspace(user.id);
      // Idle sweep — har request par, routes se pehle (boss: 2 minute rule).
      const idle = applyIdleExpiry(user, ws, { route });
      const handoffReconciled = reconcileChatFlow(user, ws);
      if (idle.changed || handoffReconciled) writeProWorkspace(user.id, ws);
      if (route === '/pro/api/bootstrap' && req.method === 'GET') {
        const quotedAt = Date.parse(ws.cart?.quote?.fetchedAt || '');
        if (ws.cart?.quote && (!Number.isFinite(quotedAt) || Date.now() - quotedAt > 5 * 60_000 || quotedAt > Date.now() + 30_000)) {
          ws.cart.quote = null;
          writeProWorkspace(user.id, ws);
        }
        // Idle closure ek hi baar dikhti hai (phir clear), taaki toast repeat na ho.
        const idleClosed = ws.lastClosed ? { ...ws.lastClosed } : null;
        if (ws.lastClosed) { delete ws.lastClosed; writeProWorkspace(user.id, ws); }
        json(res, 200, {
          ok: true, ...publicState(user, ws), backup: userBackupView(user),
          idle: { timeoutMs: idle.timeoutMs, closed: idleClosed, abandoned: Array.isArray(ws.abandoned) ? ws.abandoned.slice(-3) : [] },
          // Round 17: har user ka apna quota — kaun si cheez kitni baar ho chuki.
          rateLimits: rateLimitSnapshot(user.id),
          // Round 19: "deploy par data reset" ka asli sach — wallet/UTR cloud me
          // safe hai ya nahi. User ko bas ek line, boss ko poora detail.
          durability: (() => {
            const d = durabilityStatus();
            return user?.isBoss || isBoss(user.id)
              ? d
              : { cloud: d.cloud, restoredAt: d.restoredAt, line: d.line };
          })(),
          // Round 20: asli paisa ka sabooot (sirf boss ko) — statement summary.
          ...(user?.isBoss || isBoss(user.id) ? { statement: statementStatus(getDb()), identities: identityStatus() } : {}),
          // Round 21 ("NO SMS RECEIVED"): SMS/order ka asli rasta ya block?
          // Sandbox/blocked environment me order hi place nahi hota, isliye SMS
          // ka intezaar bekaar hai — boss ko yahi saaf dikhna chahiye.
          liveOrder: liveOrderStatus()
        });
        return;
      }
      // Only the operator can override default shared-ID access for a known
      // Telegram user. Denials do not remove any account or workspace.
      if (route === '/pro/api/boss/account-access' && req.method === 'GET') {
        if (!isBoss(user.id)) throw error(403, 'ID access sirf admin manage kar sakta hai.');
        json(res, 200, { ok: true, access: bossAccountAccessView() });
        return;
      }
      if (route === '/pro/api/boss/account-access' && req.method === 'POST') {
        if (!isBoss(user.id)) throw error(403, 'ID access sirf admin manage kar sakta hai.');
        const body = await bodyJson(req);
        const target = String(body.userId || '');
        const key = String(body.accountKey || '');
        const db = getDb();
        if (body.confirm !== true || typeof body.allow !== 'boolean') throw error(400, 'Access change confirm karein.');
        if (!/^\d{1,20}$/.test(target) || !Object.prototype.hasOwnProperty.call(db.knownUsers || {}, target) || isBoss(target)) {
          throw error(400, 'Pehle user ko bot kholne ko kahein, phir user list se chunein.');
        }
        if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) ||
            !Object.prototype.hasOwnProperty.call(db.config?.accounts || {}, key)) throw error(404, 'Operator ID nahi mili.');
        if (db.config.proAccountGrants === undefined) db.config.proAccountGrants = {};
        if (!db.config.proAccountGrants || typeof db.config.proAccountGrants !== 'object' || Array.isArray(db.config.proAccountGrants)) {
          throw error(503, 'ID access data unreadable; operator must restore it before changing access.');
        }
        const previous = db.config.proAccountGrants[target];
        if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous))) {
          throw error(503, 'This user’s ID access data is unreadable; restore it before changing access.');
        }
        const grants = previous ? { ...previous } : {};
        if (body.allow) delete grants[key];
        else grants[key] = SHARED_ACCESS_DENIED;
        db.config.proAccountGrants[target] = grants;
        const guard = accessDecisionKey(target, key);
        if (!saveDbDurable(db)) {
          // saveDb may have updated its in-memory cache before a write/fsync
          // failed. Never allow an unconfirmed change in this process; attempt
          // to persist a deny as well, and require a successful retry to clear it.
          unconfirmedAccessChanges.add(guard);
          try {
            const rollback = getDb();
            rollback.config.proAccountGrants ||= {};
            rollback.config.proAccountGrants[target] = { ...(rollback.config.proAccountGrants[target] || {}), [key]: SHARED_ACCESS_DENIED };
            saveDbDurable(rollback);
          } catch { /* the in-process deny remains active */ }
          throw error(503, 'ID access save nahi hua. Dobara check karein.');
        }
        unconfirmedAccessChanges.delete(guard);
        if (sharedAccountAllowed(getDb(), target, key) !== body.allow) {
          throw error(409, 'ID access changed concurrently. Check and retry.');
        }
        json(res, 200, { ok: true, access: bossAccountAccessView() });
        return;
      }
      // Chat hands off only links. Every transition below is scoped to the
      // verified Telegram user and persisted in their encrypted workspace.
      if (route === '/pro/api/chat-handoff/start' && req.method === 'POST') {
        const body = await bodyJson(req);
        const links = readChatHandoff(user.id);
        if (!links || String(body.handoffId || '') !== String(links.id || '') ||
            !safeSwiggyShareUrl(links.cartUrl) || !safeSwiggyShareUrl(links.addressUrl) || links.cartUrl === links.addressUrl) {
          throw error(409, 'Dono Swiggy links chat mein dobara bhejein.');
        }
        if (ws.chatFlow?.id === links.id && ws.chatFlow.stage !== 'DONE') {
          json(res, 200, { ok: true, ...publicState(user, ws) }); return;
        }
        if (ws.checkout) throw error(409, 'Existing checkout pehle check karein; naya order start nahi hua.');
        if (getActiveUserOrder(user.id)) throw error(409, 'Chat mein pehle se active order hai. Pehle usko check karein.');
        const existing = Boolean(ws.cart || ws.selectedAddress || ws.pendingAddress || (ws.chatFlow && ws.chatFlow.stage !== 'DONE'));
        if (existing && body.confirmReplaceDraft !== true) {
          const e = error(409, 'Mini App mein pehle se draft hai. Replace karne se pehle confirm karein.');
          e.code = 'DRAFT_EXISTS'; throw e;
        }
        if (existing) preserveHandoffDraft(ws);
        ws.cart = null; ws.selectedAddress = null; ws.pendingAddress = null; ws.addressCandidates = []; ws.menu = null;
        ws.chatFlow = {
          id: String(links.id), stage: 'ACCOUNT', accountKey: '', sessionFingerprint: '',
          cartUrl: safeSwiggyShareUrl(links.cartUrl), addressUrl: safeSwiggyShareUrl(links.addressUrl),
          createdAt: new Date().toISOString()
        };
        writeProWorkspace(user.id, ws);
        if (!markChatHandoffStarted(user.id, links.id)) throw error(503, 'Links Mini App mein saved hain; app dobara khol kar continue karein.');
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/select' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['ACCOUNT']);
        const rows = listAccounts(user, ws);
        const row = body.auto === true
          ? (rows.find(r => r.selectable && r.status === 'READY') || rows.find(r => r.selectable))
          : rows.find(r => r.key === String(body.key || ''));
        if (!row) throw error(404, 'Koi available ID nahi mili. Admin se baat karein.');
        if (!row.selectable && !(row.needsConfirm && body.confirmUsed === true)) {
          const e = error(409, row.reason || 'Ye ID abhi available nahi hai.');
          e.code = row.needsConfirm ? 'ACCOUNT_NEEDS_CONFIRM' : 'ACCOUNT_UNAVAILABLE'; throw e;
        }
        const saved = accountMap(user, ws)[row.key];
        if (!saved || !saved.isLoggedIn || saved.isLoggedOut) throw error(409, 'Ye ID abhi available nahi hai.');
        const fingerprint = sessionFingerprint(saved);
        await verifyAndBindAccount(provider, user, ws, row.key, saved);
        const after = accountMap(user, ws)[row.key];
        if (!after || sessionFingerprint(after) !== fingerprint) throw error(409, 'ID ka session badal gaya. Dobara chunein.');
        ws.activeAccountKey = row.key;
        invalidateAccountDependentState(ws);
        flow.accountKey = row.key; flow.sessionFingerprint = fingerprint;
        flow.confirmedUsed = row.needsConfirm === true && body.confirmUsed === true;
        flow.stage = 'ADDRESS';
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/leave' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['ACCOUNT', 'ADDRESS', 'CART', 'BILL'], { checkAccount: false });
        if (body.confirmLeave !== true) throw error(400, 'Draft chhodne se pehle confirm karein.');
        preserveHandoffDraft(ws);
        flow.stage = 'DONE';
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/reselect' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['ADDRESS', 'CART', 'BILL'], { checkAccount: false });
        if (body.confirmChange !== true) throw error(400, 'ID change confirm karein.');
        preserveHandoffDraft(ws);
        ws.pendingAddress = null; ws.selectedAddress = null; ws.cart = null;
        flow.stage = 'ACCOUNT'; flow.accountKey = ''; flow.sessionFingerprint = '';
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/address' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['ADDRESS']);
        if (ws.pendingAddress?.address) { json(res, 200, { ok: true, ...publicState(user, ws) }); return; }
        enforceRateLimit(user, 'addressResolve');
        const address = cleanAddress(await provider.resolveAddress(currentAccount(user, ws), flow.addressUrl));
        if (!address.address || !isValidIndianDeliveryCoordinates(address.lat, address.lng)) {
          throw error(502, 'Swiggy se pura address aur location nahi mila. Link check karke dobara try karein.');
        }
        ws.pendingAddress = address;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/confirm-address' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['ADDRESS']);
        if (body.confirmAddress !== true || !ws.pendingAddress?.address ||
            !isValidIndianDeliveryCoordinates(ws.pendingAddress.lat, ws.pendingAddress.lng)) {
          throw error(400, 'Pehle fetched address check karke confirm karein.');
        }
        const name = String(body.name || '').trim().slice(0, 120);
        const mobile = normalizeIndianMobileNumber(body.mobile || '');
        if (!name || !mobile) throw error(400, 'Receiver ka naam aur 10-digit mobile number zaroori hai.');
        ws.selectedAddress = cleanAddress({ ...ws.pendingAddress, name, mobile });
        ws.pendingAddress = null;
        flow.addressDigest = draftDigest(ws.selectedAddress);
        flow.stage = 'CART';
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/cart' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['CART']);
        if (!ws.selectedAddress || flow.addressDigest !== draftDigest(ws.selectedAddress)) throw error(409, 'Address badal gaya. Phir se confirm karein.');
        if (ws.cart?.items?.length && flow.cartDigest === chatCartDigest(ws.cart)) { json(res, 200, { ok: true, ...publicState(user, ws) }); return; }
        enforceRateLimit(user, 'cartImport');
        const group = await provider.groupCart(currentAccount(user, ws), ws.selectedAddress, flow.cartUrl);
        if (!group?.restaurantId || !Array.isArray(group.items) || !group.items.length ||
            group.items.some(i => !i?.menu_item_id || !Number.isFinite(Number(i.qty ?? i.quantity)) || Number(i.qty ?? i.quantity) <= 0 || i.inStock === false)) {
          throw error(502, 'Swiggy se available cart items nahi mile. Link check karke dobara try karein.');
        }
        ws.cart = { ...group, items: group.items.map(i => ({ ...i, lineKey: crypto.randomUUID() })), forSomeoneElse: true, activeSubscriptionItems: [], quote: null };
        flow.cartDigest = chatCartDigest(ws.cart);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/bill' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['CART']);
        if (body.confirmReplaceSwiggyCart !== true) throw error(400, 'Selected ID ka Swiggy cart replace karne ki permission dein.');
        await quoteChatHandoff(provider, user, ws, flow, { quick: true });
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/chat-handoff/offers' && req.method === 'POST') {
        const body = await bodyJson(req);
        const flow = requireChatFlow(user, ws, body, ['BILL']);
        if (body.confirmResync !== true) throw error(400, 'Swiggy cart phir se sync karne ki permission dein.');
        await quoteChatHandoff(provider, user, ws, flow, { quick: false });
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/backup' && req.method === 'POST') {
        // Boss (31-10-2026): "DATA TO ERASE HOJATA." Ab backup ka asli sach +
        // ek button jo turant backup kar ke result dikhata hai.
        if (!isBoss(user.id)) throw error(403, 'Backup sirf boss kar sakta hai.');
        const result = await backupProWorkspaceNow(user.id);
        json(res, 200, { ok: true, result, backup: userBackupView(user) });
        return;
      }
      // ── Round 20: UPI/bank statement = asli paisa ka sabooot ────────────
      // Boss (31-10-2026): "UTR PAR JITNA AMOUNT JAYE AGAR WO MISBAHUL ISLAM HO
      // UTNA ADD HOJAYE". Boss apni UPI/bank statement (ya SMS) paste karta hai
      // → jis UTR ka paisa Misbahul Islam ke account me aaya hai, sirf wahi
      // amount credit hota hai; random/chhota UTR ka rasta band.
      if (route === '/pro/api/boss/statement' && req.method === 'GET') {
        if (!isBoss(user.id)) throw error(403, 'UPI statement sirf boss dekh sakta hai.');
        json(res, 200, { ok: true, statement: statementStatus(getDb()) });
        return;
      }
      if (route === '/pro/api/boss/statement' && req.method === 'POST') {
        if (!isBoss(user.id)) throw error(403, 'UPI statement sirf boss daal sakta hai.');
        const body = await bodyJson(req);
        const db = getDb();
        let imported = { parsed: 0, accepted: [], rejected: [], settled: [] };
        if (Array.isArray(body.entries)) {
          for (const entry of body.entries.slice(0, 500)) {
            const saved = recordStatementPayment(db, entry, { actor: `boss:${user.id}` });
            (saved.ok ? imported.accepted : imported.rejected).push(saved.ok ? saved.record : { utr: entry?.utr, reason: saved.reason });
          }
        }
        const text = String(body.text || '').trim();
        if (text) {
          const fromText = importStatementText(db, text, { actor: `boss:${user.id}` });
          imported = {
            parsed: imported.parsed + fromText.parsed,
            accepted: imported.accepted.concat(fromText.accepted),
            rejected: imported.rejected.concat(fromText.rejected),
            settled: imported.settled.concat(fromText.settled)
          };
        }
        if (!imported.accepted.length && !imported.settled.length) {
          // Kuch bhi useful nahi mila — jhoothi "ho gaya" nahi.
          const e = error(400, 'Statement me koi credit line (UTR + amount) nahi mili. Poori line copy karein, jaise: "31-10-2026 UPI/CR 123456789012 MISBAHUL ISLAM ₹15.00 credit".');
          e.code = 'STATEMENT_NOT_PARSED';
          throw e;
        }
        if (imported.settled.length) {
          saveDb(db);
          backupMoneyNow().catch(() => {});
        }
        json(res, 200, {
          ok: true,
          imported: { parsed: imported.parsed, accepted: imported.accepted.length, rejected: imported.rejected },
          settled: imported.settled,
          statement: statementStatus(db)
        });
        return;
      }
      // ── Round 26: "deploy hote hi sab erase" ka asli check + ek button restore ──
      if (route === '/pro/api/boss/durability' && req.method === 'GET') {
        if (!isBoss(user.id)) throw error(403, 'Backup ka sach sirf boss dekh sakta hai.');
        const doctor = await runDurabilityDoctor();
        json(res, 200, { ok: true, doctor });
        return;
      }
      if (route === '/pro/api/boss/durability/restore' && req.method === 'POST') {
        if (!isBoss(user.id)) throw error(403, 'Vault se restore sirf boss kar sakta hai.');
        const report = await restoreFromVaultNow({ actor: `boss:${user.id}` });
        // Restore ke baad dobara backup — taaki naya data bhi vaapas vault me ho.
        backupIdentityNow({ force: true }).catch(() => {});
        backupMoneyNow({ force: true }).catch(() => {});
        const lines = [];
        if (report.identity?.restored) lines.push(`${report.identity.accounts || 0} login ID wapas`);
        if (report.money?.restored) lines.push('paisa/UTR wapas');
        json(res, 200, {
          ok: report.ok,
          restored: report,
          identities: identityStatus(),
          durability: durabilityStatus(),
          message: report.ok
            ? `Vault se data wapas aa gaya — ${lines.join(' · ') || 'jo vault me tha wo merge ho gaya'}.`
            : `Vault me restore karne layak data nahi mila. Wajah: ${report.identity?.reason || report.money?.reason || 'pata nahi'}`
        });
        return;
      }
      // ── Round 25: UTR se poori payment detail (boss) ────────────────────
      // Boss: "UPI PAYMENT AGAR ME TRACK KARNA CHAHTA ... BAS USSE UTR LUNGA
      // AUR UTR SE SAB DETAILS NIKAALUNGA — ABHI YA OLD, KISI AUR KO, KITNA".
      if (route === '/pro/api/boss/utr' && (req.method === 'POST' || req.method === 'GET')) {
        if (!isBoss(user.id)) throw error(403, 'UTR ki detail sirf boss dekh sakta hai.');
        const body = req.method === 'POST' ? await bodyJson(req) : Object.fromEntries(new URL(req.url, 'http://x').searchParams);
        const out = await utrTruthForBoss(user, body);
        json(res, 200, out);
        return;
      }
      // ── Round 22: login IDs ka data deploy par bachega ya nahi ──────────
      // Boss: "JITNE BHI LOGIN ID HOTE HAIN KISKA DATA NAHI BACHTA". Yahan har
      // ID ka asli sach: session saved hai ya nahi, cloud backup chalu hai ya
      // nahi, deploy ke baad restore hua ya nahi.
      if (route === '/pro/api/boss/identities' && req.method === 'GET') {
        if (!isBoss(user.id)) throw error(403, 'Login IDs ka data sirf boss dekh sakta hai.');
        const status = identityStatus();
        json(res, 200, { ok: true, identities: status, backup: userBackupView(user) });
        return;
      }
      if (route === '/pro/api/boss/identities' && req.method === 'POST') {
        if (!isBoss(user.id)) throw error(403, 'Login IDs ka backup sirf boss kar sakta hai.');
        const body = await bodyJson(req);
        if (body.verify === true) {
          // Har ID ka session Swiggy par asli check — jhootha "sab theek" nahi.
          const db = getDb();
          const accounts = Object.entries(db.config?.accounts || {}).filter(([, a]) => a && (a.cookies || a.tid || a.token));
          const results = [];
          for (const [key, account] of accounts.slice(0, 8)) {
            const summary = summarizeIdentity(key, account);
            let live = { valid: false, reason: 'provider ne jawab nahi diya' };
            try {
              live = await provider.verifySession(account) || live;
            } catch (err) {
              live = { valid: false, reason: String(err?.message || err).slice(0, 120) };
            }
            const target = db.config.accounts[key];
            if (target) {
              target.lastVerifiedAt = new Date().toISOString();
              target.sessionExpired = live?.valid !== true;
              if (live?.valid) {
                if (live.liveTid) target.tid = live.liveTid;
                if (live.cookies) target.cookies = live.cookies;
                if (live.token) target.token = live.token;
                target.isLoggedIn = true;
              }
            }
            results.push({ ...summary, valid: live?.valid === true, reason: String(live?.reason || '') });
          }
          saveDb(db);
          backupIdentityNow({ force: true }).catch(() => {});
          json(res, 200, {
            ok: true,
            checked: results.length,
            results,
            identities: identityStatus(),
            note: results.length ? '' : 'Koi session saved nahi hai — pehle ID add karein.'
          });
          return;
        }
        // Backup button — abhi, debounce ke bina.
        const pushed = await backupIdentityNow({ force: true });
        json(res, 200, {
          ok: true,
          backup: pushed,
          identities: identityStatus(),
          message: pushed.ok
            ? 'Login IDs + mini-app data cloud me save ho gaya.'
            : (pushed.localOnly
              ? 'Sirf local copy bani — cloud token (GITHUB_VAULT_TOKEN) Render env me set nahi hai.'
              : `Backup nahi hua: ${pushed.error || pushed.skipped || pushed.reason || 'wajah nahi mili'}`)
        });
        return;
      }
      if (route === '/pro/api/accounts/send-otp' && req.method === 'POST') {
        enforceRateLimit(user, 'otpSend');
        const body = await bodyJson(req);
        const phone = normalizeIndianMobileNumber(body.phone);
        if (!phone) throw error(400, 'Enter a valid 10-digit Indian mobile number.');
        if (ws.checkout && ws.checkout.status !== 'PAID') {
          const original = normalizeIndianMobileNumber(ws.checkout.accountPhone || '');
          if (!original || phone !== original) throw error(409, 'Only the original checkout account can be reconnected while its outcome is unresolved.');
        }
        const now = Date.now();
        if (now - (otpRequestedAt.get(user.id) || 0) < 30_000) throw error(429, 'Please wait 30 seconds before requesting another OTP.');
        // Boss (31-10-2026): "KOI NAYA ACCOUNT HAI TO LOGIN HI NAHI HOTA." Naya
        // number = Swiggy par account hi nahi. Chat flow ki tarah app bhi
        // signup kar sakta hai — bas pehle user se saaf confirm karwa ke.
        const signup = body.signup === true;
        const result = await otp.request(`pro_${user.id}`, phone, `private_${user.id}`, user.firstName || 'Swiggy User', {
          persistAccount: false, allowSignup: signup, claimOffers: false
        });
        if (!result?.success) {
          const notRegistered = result?.code === 'SWIGGY_ACCOUNT_NOT_REGISTERED' || /not registered|create your account/i.test(String(result?.message || ''));
          if (notRegistered) {
            const e = error(409, signup
              ? 'Swiggy ne is number ka naya account nahi banaya. Ek baar Swiggy app se account bana kar phir OTP dabaiye.'
              : 'Ye number Swiggy par naya hai. Naya Swiggy account banayein? Har number par ek hi account banta hai.');
            e.code = 'SWIGGY_ACCOUNT_NOT_REGISTERED';
            throw e;
          }
          throw error(502, result?.message || 'Swiggy did not confirm that an OTP was sent.');
        }
        // Cooldown sirf SUCCESS par — warna naya number "account banayein?"
        // ke baad 30 second tak retry hi nahi kar paata (asli bug tha).
        otpRequestedAt.set(user.id, now);
        ws.otpPhone = phone;
        otpAttempts.delete(user.id);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, message: 'Swiggy accepted the OTP request.' });
        return;
      }
      if (route === '/pro/api/accounts/verify-otp' && req.method === 'POST') {
        enforceRateLimit(user, 'otpVerify');
        const body = await bodyJson(req);
        const digits = String(body.otp || '').trim();
        if (!ws.otpPhone || !/^\d{6}$/.test(digits)) throw error(400, 'Request an OTP and enter its six digits.');
        const attempts = otpAttempts.get(user.id) || 0;
        if (attempts >= 5) throw error(429, 'Too many attempts. Request a fresh OTP after the wait.');
        otpAttempts.set(user.id, attempts + 1);
        const result = await otp.verify(`pro_${user.id}`, digits);
        if (!result?.success || !result.exportJson) throw error(400, result?.message || 'Swiggy did not verify this OTP.');
        const session = normalizeSwiggySessionPayload(result.exportJson);
        if (!session || normalizeIndianMobileNumber(result.phone) !== ws.otpPhone) throw error(502, 'Swiggy returned an unexpected account; nothing was saved.');
        let live = await provider.verifySession({ ...session, __proPrivate: true }).catch(() => null);
        // Brand-new account par profile/cart kabhi kabhi customer id nahi deta —
        // OTP to Swiggy ne khud verify kiya hai, isliye session ke andar se
        // identity nikaal lete hain (jhoothi ID nahi, wahi token).
        const identity = String(live?.customerId || '').trim() || jwtIdentity(session.tid || session.jwtTid || '') || String(session.customerId || '').trim();
        if (!identity) {
          const e = error(502, 'Swiggy ne is OTP ke baad account ki identity nahi di. Naya OTP maangein — kuch bhi save nahi hua.');
          e.code = 'OTP_IDENTITY_MISSING';
          throw e;
        }
        if (!live?.valid) live = { valid: true, customerId: identity, phone: '', name: '', liveTid: session.tid || '' };
        else live.customerId = identity;
        const profilePhone = normalizeIndianMobileNumber(live.phone || '');
        if (profilePhone && profilePhone !== ws.otpPhone) throw error(502, 'Swiggy returned a different account phone. Nothing was saved.');
        storeAccount(user, ws, {
          ...session, phone: ws.otpPhone, mobile: ws.otpPhone, customerId: live.customerId,
          tid: live.liveTid || session.tid || '', token: live.token || session.token || '', cookies: live.cookies || session.cookies || '',
          name: live.name || result.name || user.firstName, swiggyName: live.name || result.swiggyName || '', totalOrdersCount: result.totalOrdersCount
        });
        delete ws.otpPhone;
        otpAttempts.delete(user.id);
        writeProWorkspace(user.id, ws);
        // Round 22: naya ID add hote hi backup — deploy iske turant baad bhi ho,
        // to ID wapas milegi.
        backupIdentityNow({ force: true }).catch(() => {});
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/import' && req.method === 'POST') {
        enforceRateLimit(user, 'accountImport');
        const body = await bodyJson(req);
        const session = normalizeSwiggySessionPayload(body.session);
        if (!session || !(session.token || session.tid || session.cookies)) throw error(400, 'Session JSON must contain Swiggy credentials.');
        const live = await provider.verifySession({ ...session, __proPrivate: true });
        if (!live?.valid || !live.customerId) throw error(502, 'Swiggy could not verify this session. Nothing was imported; check the session or retry later.');
        const suppliedPhone = normalizeIndianMobileNumber(session.phone || session.mobile || '');
        const verifiedPhone = normalizeIndianMobileNumber(live.phone || '');
        if (suppliedPhone && verifiedPhone && suppliedPhone !== verifiedPhone) throw error(400, 'The phone in this JSON differs from the Swiggy profile. Nothing was imported.');
        // Never display or use a JSON-supplied phone as a verified Swiggy
        // account phone when the provider did not return it.
        const phone = verifiedPhone || '';
        // Boss (31-10-2026, round 17): ek hi Swiggy ID do jagah nahi chalegi.
        // Warna ek hi ID se do log order karte aur "ek order = ek ID" ka lock
        // toot jata. Vault (boss/shared) ka ID private workspace me copy nahi
        // ho sakta — sirf wahi user jiske paas pehle se hai use refresh kar sakta hai.
        if (!isBoss(user.id)) {
          const mine = Object.entries(ws.accounts || {});
          const alreadyMine = mine.some(([, a]) =>
            (phone && normalizeIndianMobileNumber(a.phone || a.mobile || '') === phone) ||
            (live.customerId && String(a.customerId || '') === String(live.customerId))
          );
          if (!alreadyMine) {
            const shared = Object.entries(getDb().config?.accounts || {}).find(([, a]) =>
              (phone && normalizeIndianMobileNumber(a?.phone || a?.mobile || '') === phone) ||
              (live.customerId && String(a?.customerId || '') === String(live.customerId))
            );
            if (shared) {
              const e = error(409, 'Ye Swiggy ID pehle se operator ke paas hai — ise apne workspace me add nahi kar sakte (ek ID = ek order). Doosri ID se order karein.');
              e.code = 'ACCOUNT_ALREADY_MANAGED';
              throw e;
            }
          }
        }
        storeAccount(user, ws, {
          ...session, phone, mobile: phone, customerId: live.customerId || session.customerId || '',
          name: live.name || session.name || 'Swiggy account', swiggyName: live.name || '',
          tid: live.liveTid || session.tid || '', token: live.token || session.token || '', cookies: live.cookies || session.cookies || ''
        });
        writeProWorkspace(user.id, ws);
        // Round 22: imported ID turant cloud me — deploy bhi ho jaye, ID na jaye.
        backupIdentityNow({ force: true }).catch(() => {});
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      /**
       * Boss (01-11-2026): reference me har account ke saath "copy JSON" button hai.
       * Yahan wo asli session JSON deta hai — par sirf usi account ka jise user
       * khud manage karta hai (canRemove). Shared/vault ID ka session kabhi
       * kisi client ko nahi jata. Jo copy hota hai wahi import me wapas chalta hai.
       */
      if (route === '/pro/api/accounts/session' && req.method === 'GET') {
        enforceRateLimit(user, 'accountExport');
        const key = String(url.searchParams.get('key') || '');
        const map = accountMap(user, ws);
        const account = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
        if (!account || !account.isLoggedIn || account.isLoggedOut) throw error(404, 'Account not found.');
        const shared = isSharedAccountFor(user, ws, key);
        if (shared && !isBoss(user.id)) {
          const e = error(403, 'Ye ID operator ke vault me hai — uska session sirf operator khud dekh sakta hai.');
          e.code = 'ACCOUNT_SESSION_OPERATOR_ONLY';
          throw e;
        }
        // Sirf hamare apne internal flags hata kar wahi JSON jise import samajhta hai.
        const { isLoggedIn, isLoggedOut, sessionExpired, offerAutoActivation, ...rest } = account;
        json(res, 200, { ok: true, key, session: rest, note: 'Yahi JSON import me wapas chalta hai. Kisi ke saath share na karein.' });
        return;
      }
      if (route === '/pro/api/accounts/select' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key) || !map[key]?.isLoggedIn || map[key]?.isLoggedOut) throw error(404, 'Account not found.');
        // Boss (31-10-2026): "JAISE KOI USED ID HAI PHIR BHI KOI USKO SELECT
        // KARNA CHAHTA TO EK WARNING DEKAR USKO PHIR WO SELECT KAR PAYEGA."
        // Isliye USED ab confirm ke baad khulti hai. Suspended / expired /
        // busy ID phir bhi band rehti hai — unse order ho hi nahi sakta, aur
        // busy ID kisi chalte order ki hai (wo kabhi doosre ko nahi milti).
        {
          const row = listAccounts(user, ws).find(r => r.key === key);
          if (row && row.needsConfirm === true && body.confirmUsed === true) {
            // explicit user warning acknowledgement — aage badho
          } else if (row && row.selectable === false) {
            const e = error(409, row.reason || `Ye ID abhi select nahi ho sakti (${row.status}).`);
            e.code = 'ACCOUNT_NEEDS_CONFIRM';
            throw e;
          }
        }
        if (ws.activeAccountKey !== key) {
          if (ws.checkout && ws.checkout.status !== 'PAID') throw error(409, 'Resolve the existing Swiggy checkout before switching accounts.');
          ws.activeAccountKey = key;
          invalidateAccountDependentState(ws);
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/remove' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
        if (ws.checkout && ws.checkout.accountKey === key && ws.checkout.status !== 'PAID') {
          throw error(409, 'This account has an unresolved checkout. Check it in Swiggy My Orders before removing the account.');
        }
        // Boss (31-10-2026): delete par DO option — sirf database se hatana, ya
        // Swiggy se account hi delete karna (uske liye Swiggy ka delete OTP).
        if (String(body.mode || 'local') === 'swiggy') {
          if (isSharedAccountFor(user, ws, key)) {
            const e = error(403, 'Operator ka ID aap Swiggy se delete nahi kar sakte. Sirf apna add kiya ID.');
            e.code = 'SHARED_ACCOUNT_RESTRICTED';
            throw e;
          }
          const account = map[key];
          const phone = normalizeIndianMobileNumber(account?.phone || account?.mobile || '') || '';
          if (!phone) throw error(400, 'Is account ka phone number nahi mila, isliye Swiggy delete OTP nahi bhej sakte.');
          const now = Date.now();
          if (now - (deleteOtpRequestedAt.get(user.id) || 0) < 30_000) throw error(429, 'Please wait 30 seconds before requesting another delete OTP.');
          deleteOtpRequestedAt.set(user.id, now);
          let requested;
          try {
            requested = await deleteOtp.request(`pro_${user.id}`, phone, key, account?.swiggyName || account?.name || '', { ...account, __proPrivate: true });
          } catch (delErr) {
            throw error(502, `Swiggy delete OTP fail hua: ${String(delErr?.message || 'jawab nahi mila').slice(0, 160)}. Account waisa hi hai.`);
          }
          if (!requested?.success) throw error(502, requested?.message || 'Swiggy ne delete OTP nahi bheja. Account waisa hi hai.');
          json(res, 200, {
            ok: true, otpRequired: true, key,
            phoneMasked: maskAccountPhone(phone),
            message: 'Swiggy ne delete OTP bheja hai. OTP daalne par account Swiggy se delete ho jayega — ye wapas nahi hota.'
          });
          return;
        }
        if (isBoss(user.id)) permanentLogoutAccount(key);
        else if (isSharedAccountFor(user, ws, key)) {
          // Operator ka ID sabko dikhta hai par kisi user ke haath se delete
          // nahi hota — warna ek user sabka ID uda dega.
          throw error(403, 'Ye operator ka ID hai; aap ise remove nahi kar sakte. Apna add kiya ID hi remove hota hai.');
        } else delete ws.accounts[key];
        if (ws.activeAccountKey === key) { ws.activeAccountKey = ''; invalidateAccountDependentState(ws); }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/accounts/remove/confirm' && req.method === 'POST') {
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const digits = String(body.otp || '').replace(/\D/g, '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
        if (isSharedAccountFor(user, ws, key)) {
          const e = error(403, 'Operator ka ID aap Swiggy se delete nahi kar sakte.');
          e.code = 'SHARED_ACCOUNT_RESTRICTED';
          throw e;
        }
        if (!/^\d{6}$/.test(digits)) throw error(400, 'Swiggy ne jo 6-digit delete OTP bheja hai wahi daalein.');
        if (ws.checkout && ws.checkout.accountKey === key && ws.checkout.status !== 'PAID') {
          throw error(409, 'Is account ka checkout pending hai. Pehle Swiggy My Orders me check karein.');
        }
        const deleted = await deleteOtp.verify(`pro_${user.id}`, digits, key);
        if (!deleted?.success) throw error(400, deleted?.message || 'Swiggy ne delete OTP accept nahi kiya. Account waisa hi hai.');
        removeAccountLocally(user, ws, key);
        if (ws.activeAccountKey === key) { ws.activeAccountKey = ''; invalidateAccountDependentState(ws); }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, deleted: true, message: 'Account Swiggy se delete ho gaya aur yahan se bhi hat gaya.', ...publicState(user, ws) });
        return;
      }
      if (route === '/pro/api/offers/claim' && req.method === 'POST') {
        enforceRateLimit(user, 'offersClaim');
        const body = await bodyJson(req);
        const key = String(body.key || '');
        const map = accountMap(user, ws);
        if (!Object.prototype.hasOwnProperty.call(map, key)) throw error(404, 'Account not found.');
        if (isSharedAccountFor(user, ws, key)) {
          // Boss (31-10-2026): operator ke ID par claim band — wo unka free cash hai.
          const e = error(403, 'Operator ke ID par offer claim nahi hota. Apna add kiya ID select karein.');
          e.code = 'SHARED_ACCOUNT_RESTRICTED';
          throw e;
        }
        const account = map[key];
        if (!account?.isLoggedIn || account?.isLoggedOut) throw error(409, 'Pehle is ID ko login karein.');
        if (ws.checkout && ws.checkout.status !== 'PAID') throw error(409, 'Checkout pending hai. Pehle usko resolve karein, phir claim karein.');
        let result;
        try {
          result = await claim({ ...account, __proPrivate: true }, { force: false });
        } catch (claimErr) {
          throw error(502, `Claim fail hua: ${String(claimErr?.message || 'Swiggy ne jawab nahi diya').slice(0, 160)}. Dobara try kar sakte hain.`);
        }
        const tracks = offerClaimSummary(result);
        // Jo sach mila wahi save — icons agla boot bhi sach dikhayein.
        persistAccountPatch(user, ws, key, {
          offerAutoActivation: {
            ...(account.offerAutoActivation && typeof account.offerAutoActivation === 'object' ? account.offerAutoActivation : {}),
            ...Object.fromEntries(Object.entries(result?.offers || {}).filter(([, value]) => value && typeof value === 'object'))
          },
          offersUpdatedAt: new Date().toISOString()
        });
        writeProWorkspace(user.id, ws);
        json(res, 200, {
          ok: true,
          claim: {
            summary: result?.summary || null,
            allActive: result?.allActive === true,
            tracks
          },
          ...publicState(user, ws)
        });
        return;
      }
      if (route === '/pro/api/addresses' && req.method === 'GET') {
        // Boss (31-10-2026): "ADDRESS WAGAIRA BHI WO NAHI DEKH SAKTA DUSRE LOGO
        // KA — ONLY USKA DEKH SAKTA, BUT ME SABKA DEKH SAKTA."
        // Shared (operator) ID par saved address list kisi user ko nahi dikhti;
        // user apna address link se add karta hai, aur wo uske workspace me
        // rehta hai. Boss ko sab dikhta hai.
        const activeKey = String(ws.activeAccountKey || '');
        if (isSharedAccountFor(user, ws, activeKey)) {
          ws.addressCandidates = [];
          writeProWorkspace(user.id, ws);
          json(res, 200, {
            ok: true, addresses: [],
            note: 'Ye operator ka ID hai. Purane address (kisi aur ke) nahi dikhaye jaate — apna address link se add karein. Aapka add kiya address sirf aapko dikhta hai.'
          });
          return;
        }
        const account = currentAccount(user, ws);
        // Ek transient failure par seedha error nahi — Swiggy kabhi kabhi ek
        // hi try me jawab nahi deta (boss: "ADDRESS FETCH NA HORAHA").
        let addresses = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2 && addresses === null; attempt += 1) {
          try {
            const result = await provider.addresses(account);
            if (Array.isArray(result)) addresses = result;
            else lastError = error(502, 'Could not fetch addresses from Swiggy.');
          } catch (err) {
            lastError = err;
            if (attempt === 0) await new Promise(r => setTimeout(r, 350));
          }
        }
        if (!Array.isArray(addresses)) throw lastError || error(502, 'Could not fetch addresses from Swiggy.');
        ws.addressCandidates = addresses.slice(0, 50).map(a => ({ ...cleanAddress(a), ref: crypto.randomUUID() }));
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, addresses: ws.addressCandidates, note: addresses.length ? '' : 'Swiggy ne koi saved address nahi diya. Address link se add karein, ya ek baar Refresh dabayein — Swiggy kabhi kabhi late jawab deta hai.' });
        return;
      }
      if (route === '/pro/api/addresses/select' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        const address = ws.addressCandidates.find(a => a.ref === String(body.ref || ''));
        if (!address) throw error(404, 'Address not found. Refresh the list.');
        ws.selectedAddress = cleanAddress(address);
        if (ws.cart) ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, selectedAddress: ws.selectedAddress, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/addresses/update-contact' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        if (!ws.selectedAddress) throw error(400, 'Select an address first.');
        const name = String(body.name || '').trim().slice(0, 120);
        const mobile = normalizeIndianMobileNumber(body.mobile || '');
        if (!name || !mobile) throw error(400, 'Enter the receiver name and valid 10-digit mobile number.');
        ws.selectedAddress = { ...ws.selectedAddress, name, mobile };
        if (ws.cart) ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, selectedAddress: ws.selectedAddress, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/addresses/resolve' && req.method === 'POST') {
        enforceRateLimit(user, 'addressResolve');
        requireEditableCart(ws);
        const body = await bodyJson(req);
        const account = currentAccount(user, ws);
        if (typeof body.url !== 'string' || body.url.length > 2000) throw error(400, 'Paste a Swiggy address link.');
        const resolved = await provider.resolveAddress(account, body.url);
        ws.pendingAddress = cleanAddress(resolved);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, address: ws.pendingAddress });
        return;
      }
      if (route === '/pro/api/addresses/confirm' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        if (!ws.pendingAddress) throw error(400, 'Resolve an address link first.');
        const name = String(body.name || ws.pendingAddress.name || '').trim().slice(0, 120);
        const mobile = normalizeIndianMobileNumber(body.mobile || ws.pendingAddress.mobile || '');
        if (!name || !mobile) throw error(400, 'Confirm the receiver name and valid 10-digit mobile number.');
        ws.selectedAddress = { ...ws.pendingAddress, name, mobile };
        ws.pendingAddress = null;
        if (ws.cart) ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, selectedAddress: ws.selectedAddress, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/search' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (q.length < 2 || q.length > 80) throw error(400, 'Enter at least 2 characters.');
        const restaurants = await provider.search(currentAccount(user, ws), ws.selectedAddress, q);
        json(res, 200, { ok: true, restaurants });
        return;
      }
      if (route === '/pro/api/menu' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        if (!/^\d{1,20}$/.test(id)) throw error(400, 'Invalid restaurant.');
        const menu = await provider.menu(currentAccount(user, ws), ws.selectedAddress, id);
        ws.menu = menu;
        if (ws.cart && String(ws.cart.restaurantId) === String(menu?.restaurant?.id)) {
          Object.assign(ws.cart, {
            restaurantArea: String(menu.restaurant.area || ''),
            restaurantTime: String(menu.restaurant.time || ''),
            restaurantImage: String(menu.restaurant.image || ''),
            restaurantRating: String(menu.restaurant.rating || '')
          });
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...menu });
        return;
      }
      if (route === '/pro/api/cart/add' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        currentAccount(user, ws);
        const menu = ws.menu;
        const id = String(body.itemId || '');
        // A background menu request must never make an item tap add a dish
        // from a different restaurant. Old clients without this field retain
        // their existing behavior; the Mini App always supplies it.
        if (body.restaurantId && String(menu?.restaurant?.id || '') !== String(body.restaurantId)) {
          throw error(400, 'Menu changed. Open the restaurant again before adding an item.');
        }
        const item = menu?.categories?.flatMap(c => c.items || []).find(i => i.id === id);
        if (!item) throw error(404, 'Menu item not found. Open its restaurant again.');
        if (menu.restaurant?.isOpen === false || item.inStock === false) throw error(400, 'This item is unavailable.');
        if (item.customizable || item.price === null) throw error(400, 'This item needs choices that are not supported here yet. Please use Swiggy for this item.');
        if (ws.cart && ws.cart.restaurantId !== menu.restaurant.id && body.replace !== true) throw error(409, 'Your cart has items from another restaurant. Confirm replacement.');
        if (!ws.cart || ws.cart.restaurantId !== menu.restaurant.id) {
          ws.cart = { restaurantId: menu.restaurant.id, restaurantName: menu.restaurant.name, items: [], forSomeoneElse: true, quote: null };
        }
        // Cart header ke liye outlet ka sach (boss 31-10-2026 round 3).
        Object.assign(ws.cart, {
          restaurantArea: String(menu.restaurant.area || ''),
          restaurantTime: String(menu.restaurant.time || ''),
          restaurantImage: String(menu.restaurant.image || ''),
          restaurantRating: String(menu.restaurant.rating || '')
        });
        const existing = ws.cart.items.find(i => i.menu_item_id === Number(item.id) && !(i.variants?.length || i.addons?.length));
        if (existing) existing.qty = Math.min(20, existing.qty + 1);
        else ws.cart.items.push({ lineKey: crypto.randomUUID(), id: item.id, menu_item_id: Number(item.id), name: item.name, price: item.price, qty: 1, isVeg: item.isVeg === true ? true : item.isVeg === false ? false : null, variants: [], addons: [], offer_ids: item.offer_ids, item_offer_cart_meta: item.item_offer_cart_meta });
        ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/cart/quantity' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        const item = ws.cart?.items?.find(i => i.lineKey === String(body.lineKey || ''));
        const qty = Number(body.qty);
        if (!item || !Number.isInteger(qty) || qty < 0 || qty > 20) throw error(400, 'Invalid item or quantity.');
        if (!qty) ws.cart.items = ws.cart.items.filter(i => i !== item);
        else item.qty = qty;
        ws.cart.quote = null;
        if (!ws.cart.items.length) ws.cart = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/cart/import-group' && req.method === 'POST') {
        enforceRateLimit(user, 'cartImport');
        requireEditableCart(ws);
        const body = await bodyJson(req);
        const account = currentAccount(user, ws);
        if (ws.cart && body.replace !== true) throw error(409, 'Confirm replacing your current cart.');
        if (typeof body.url !== 'string' || body.url.length > 2000) throw error(400, 'Paste a Swiggy group cart link.');
        const group = await provider.groupCart(account, ws.selectedAddress, body.url);
        if (!group?.restaurantId || !Array.isArray(group.items) || !group.items.length) throw error(502, 'Swiggy did not return group-cart items.');
        ws.cart = { ...group, items: group.items.map(i => ({ ...i, lineKey: crypto.randomUUID() })), forSomeoneElse: true, quote: null };
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart });
        return;
      }
      if (route === '/pro/api/cart/clear' && req.method === 'POST') {
        requireEditableCart(ws);
        const body = await bodyJson(req);
        if (body.confirmClear !== true) throw error(400, 'Cart clear karne ke liye confirm karein.');
        ws.cart = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: null });
        return;
      }
      if (route === '/pro/api/coupons' && req.method === 'GET') {
        // Boss (31-10-2026): coupon choose karne ka asli page — Swiggy ke apne
        // coupon list se, jhootha code nahi.
        const account = currentAccount(user, ws);
        const requested = String(url.searchParams.get('id') || '').trim();
        const restaurantId = requested || String(ws.cart?.restaurantId || '');
        if (!/^\d{1,20}$/.test(restaurantId)) throw error(400, 'Pehle cart ya restaurant kholein.');
        const cached = ws.cart?.quote?.engine?.couponOptions;
        if (String(ws.cart?.restaurantId || '') === restaurantId && Array.isArray(cached) && cached.length) {
          const trials = new Map((ws.cart.quote.engine.couponTrials || []).map(t => [String(t.code).toUpperCase(), t]));
          const coupons = cached.map(c => {
            const t = trials.get(String(c.code).toUpperCase());
            return { ...c, applicable: t ? t.ok !== false : c.applicable !== false, reason: t && t.ok === false ? String(t.reason || c.reason || '') : (c.reason || '') };
          });
          json(res, 200, { ok: true, coupons, note: '', discovery: true });
          return;
        }
        const out = await provider.coupons(account, ws.selectedAddress || {}, restaurantId);
        json(res, 200, { ok: true, ...out });
        return;
      }
      if (route === '/pro/api/restaurants/outlets' && req.method === 'GET') {
        // Boss (31-10-2026): ek restaurant ke kai franchise — location ka naam
        // aur dropdown, taaki aas-paas ka outlet chuna ja sake.
        const name = String(url.searchParams.get('q') || '').trim().slice(0, 80);
        if (name.length < 2) throw error(400, 'Restaurant ka naam chahiye.');
        const account = currentAccount(user, ws);
        if (!ws.selectedAddress) throw error(400, 'Pehle delivery address chunein.');
        const list = await provider.search(account, ws.selectedAddress, name);
        // Substring matching incorrectly treated similarly named restaurants as
        // branches. Keep only distinct IDs with the same normalized name; do
        // not invent outlets when Swiggy search does not return them.
        const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const target = norm(name);
        const seen = new Set();
        const outlets = (Array.isArray(list) ? list : [])
          .filter(r => {
            const id = String(r?.id || '');
            if (!target || !id || seen.has(id) || norm(r.name) !== target) return false;
            seen.add(id); return true;
          })
          .slice(0, 20)
          .map(r => ({
            id: String(r.id), name: String(r.name || ''), area: String(r.area || ''),
            distance: String(r.distance || ''), time: String(r.time || ''), rating: String(r.rating || ''), ratings: String(r.ratings || ''),
            isOpen: r.isOpen === true ? true : r.isOpen === false ? false : null
          }));
        json(res, 200, { ok: true, outlets, note: outlets.length ? '' : 'Is naam ka koi outlet nahi mila. Search me poora naam try karein.' });
        return;
      }
      if (route === '/pro/api/cart/sync' && req.method === 'POST') {
        enforceRateLimit(user, 'cartSync');
        const body = await bodyJson(req);
        requireEditableCart(ws);
        const account = currentAccount(user, ws);
        await ensureAccountCustomerId(provider, user, ws, account);
        if (body.confirmReplaceSwiggyCart !== true) throw error(400, 'Confirm that the existing Swiggy cart may be replaced.');
        if (!ws.cart?.items?.length || !ws.selectedAddress) throw error(400, 'Add items and select an address first.');
        const coupon = String(body.coupon || '').trim().toUpperCase();
        if (coupon && !/^[A-Z0-9_-]{3,28}$/.test(coupon)) throw error(400, 'Invalid coupon code.');
        ws.cart.forSomeoneElse = body.forSomeoneElse === true;
        // Boss (31-10-2026, round 11): "AUTO SAARE COUPON LAG". Default haan —
        // user ne koi code diya ho to wahi, warna best coupon khud lagta hai.
        ws.cart.autoCoupon = body.autoCoupon !== false;
        ws.cart.quote = null;
        writeProWorkspace(user.id, ws);
        // One Lite (+₹1) subscription jo bill me laga, wo cart par bhi yaad
        // rakho — warna agla sync/place usse gira kar delivery fee wapas le aata.
        ws.cart.activeSubscriptionItems = Array.isArray(ws.cart.activeSubscriptionItems) ? ws.cart.activeSubscriptionItems : [];
        // Round 35 (boss): "JO BILL DIKHA RAHA PAY NOW PAR CLICK KARTA HU TO WO
        // CHANGE HOJATA" — do kadam (fast phir optimize) hi is badlav ki jad
        // thi. Ab ek hi bill: poora offer/One Lite/coupon check pehle, phir
        // quote. `body.phase === 'fast'` sirf tab jab koi jaan-boojh kar turant
        // number maange (chat handoff) — default poora hi hai.
        const phase = body.phase === 'fast' ? 'fast' : 'full';
        const quote = await provider.quoteCart(account, ws.selectedAddress, ws.cart, coupon, { phase, autoCoupon: ws.cart.autoCoupon !== false });
        saveProviderQuote(ws, quote);
        // Bill ke saath outlet ka sach bhi — header/outlet row ke liye.
        if (ws.menu?.restaurant && String(ws.menu.restaurant.id) === String(ws.cart.restaurantId)) {
          Object.assign(ws.cart, {
            restaurantArea: String(ws.menu.restaurant.area || ''),
            restaurantTime: String(ws.menu.restaurant.time || ''),
            restaurantImage: String(ws.menu.restaurant.image || ''),
            restaurantRating: String(ws.menu.restaurant.rating || '')
          });
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart, selectedAddress: ws.selectedAddress });
        return;
      }
      if (route === '/pro/api/cart/optimize' && req.method === 'POST') {
        // Pehla bill aa chuka hai; ab offers + One Lite + coupon trials chala
        // kar bill sudhaarte hain. Total phir bhi sirf Swiggy ka.
        enforceRateLimit(user, 'cartOptimize');
        await bodyJson(req);
        requireEditableCart(ws);
        if (!ws.cart?.items?.length || !ws.selectedAddress) throw error(400, 'Pehle bill lein.');
        const account = currentAccount(user, ws);
        await ensureAccountCustomerId(provider, user, ws, account);
        const coupon = String(ws.cart.quote?.couponCode || '').toUpperCase();
        const quote = await provider.quoteCart(account, ws.selectedAddress, ws.cart, coupon, { phase: 'full' });
        saveProviderQuote(ws, quote);
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, cart: ws.cart, selectedAddress: ws.selectedAddress });
        return;
      }
      if (route === '/pro/api/checkout/cancel' && req.method === 'POST') {
        // Boss (round 33): payment page par "Cancel order". Yahan hum jhooth
        // nahi bolte: Swiggy ne jo order bana diya hai use hum cancel nahi kar
        // sakte — apna checkout band karte hain, fee wapas karte hain (unpaid
        // hai), aur cart wapas de dete hain.
        const body = await bodyJson(req);
        if (body.confirmCancel !== true) throw error(400, 'Cancel confirm karein.');
        const checkout = ws.checkout;
        if (!checkout) throw error(404, 'Koi checkout khula nahi hai.');
        if (checkout.status === 'PAID') throw error(409, 'Paid order yahan cancel nahi hota — Swiggy app se cancel karein.');
        let refundLine = '';
        try {
          const freshWalletDb = getDb();
          const refund = refundServiceFee(freshWalletDb, checkout, user.id, { reason: 'user ne payment page par cancel kiya' });
          if (refund?.ok) {
            saveDbDurable(freshWalletDb);
            backupMoneyNow().catch(() => {});
            refundLine = ' Wallet fee wapas kar di.';
          }
        } catch { /* refund ka sach neeche message me */ }
        const placedOnSwiggy = Boolean(normalizeSwiggyOrderId(checkout.orderId));
        ws.lastClosed = {
          at: new Date().toISOString(), orderId: String(checkout.orderId || ''), reason: 'USER_CANCELLED',
          amount: Number(checkout.amount) || 0
        };
        ws.checkout = null;
        writeProWorkspace(user.id, ws);
        json(res, 200, {
          ok: true, checkout: null, cart: ws.cart,
          message: placedOnSwiggy
            ? `Checkout band. Paisa nahi kata.${refundLine} Swiggy par ye unpaid order #${checkout.orderId} reh gaya hai — Swiggy usey khud cancel karta hai, hum use cancel nahi kar sakte.`
            : `Checkout band. Paisa nahi kata.${refundLine} Cart wapas khula hai.`
        });
        return;
      }
      if (route === '/pro/api/orders' && req.method === 'GET') {
        const scope = url.searchParams.get('scope') || 'active';
        const account = orderHistoryAccount(user, ws, scope);
        const orders = await provider.orders(account);
        const key = scope === 'checkout' ? String(ws.checkout?.accountKey || '') : String(ws.activeAccountKey || '');
        const detailed = orderDetailAllowed(user, ws, key);
        json(res, 200, { ok: true, orders: detailed ? orders : orders.map(compactOrder), detailAllowed: detailed });
        return;
      }
      if (route === '/pro/api/orders/tracking' && req.method === 'GET') {
        const id = normalizeSwiggyOrderId(url.searchParams.get('id'));
        if (!id) throw error(400, 'Invalid Swiggy order ID.');
        const scope = url.searchParams.get('scope') || 'active';
        const scopeKey = scope === 'checkout' ? String(ws.checkout?.accountKey || '') : String(ws.activeAccountKey || '');
        if (scope === 'checkout' && isSharedAccountFor(user, ws, scopeKey) &&
            id !== normalizeSwiggyOrderId(ws.checkout?.orderId || '')) {
          throw error(403, 'Only this checkout order can be tracked through the original shared ID.');
        }
        // Boss (31-10-2026, round 19): "TRACKING LINK BHI NAHI AARAHA".
        // Operator ke ID par pehle poora tracking band tha. Tracking LINK
        // Swiggy ka public page hai (order ID ka token) — customer ko wo
        // mile, par address/OTP/delivery partner jaisa private detail nahi.
        if (!orderDetailAllowed(user, ws, scopeKey)) {
          const account = orderHistoryAccount(user, ws, scope);
          let tracking = null;
          let tried = [];
          try { tracking = await provider.tracking(account, id); } catch (err) { tracking = null; tried = Array.isArray(err?.tried) ? err.tried : []; }
          const link = String(tracking?.trackingUrl || tracking?.nativeShareUrl || '');
          const smsTruth = smsTruthFor({ ...orderScopeContext(ws, scope), tracking });
          json(res, 200, { ok: true, restricted: true, sms: smsTruth, tracking: {
            orderId: id,
            status: String(tracking?.status || '').slice(0, 200),
            eta: String(tracking?.eta || tracking?.etaMinutes || '').slice(0, 100),
            trackingUrl: safeTrackingUrl(link, id),
            deliveryOtp: '',
            deliveryPartner: { name: '', phone: '' },
            restricted: true,
            via: String(tracking?.via || ''),
            tried: (Array.isArray(tracking?.tried) ? tracking.tried : tried).slice(0, 4),
            sms: tracking?.sms || null,
            note: (() => {
              const truth = describeTrackingTruth({
                trackingUrl: safeTrackingUrl(link, id), via: tracking?.via, tried: tracking?.tried,
                orderStatus: tracking?.status, restricted: true, attempts: tracking?.attempts
              });
              return truth.ok ? `${truth.line} OTP/address sirf operator ke paas rehta hai.` : truth.reason;
            })()
          } });
          return;
        }
        const account = orderHistoryAccount(user, ws, scope);
        const orders = await provider.orders(account);
        if (!orders.some(o => String(o.id) === id)) throw error(404, 'Order was not returned for this Swiggy account.');
        const tracking = await provider.tracking(account, id);
        const link = String(tracking?.trackingUrl || '');
        const safeLink = safeTrackingUrl(link, id);
        json(res, 200, { ok: true, sms: smsTruthFor({ ...orderScopeContext(ws, scope), tracking }), tracking: {
          orderId: id, status: String(tracking?.status || '').slice(0, 200), eta: String(tracking?.eta || '').slice(0, 100),
          trackingUrl: safeLink,
          via: String(tracking?.via || ''),
          tried: Array.isArray(tracking?.tried) ? tracking.tried.slice(0, 4) : [],
          sms: tracking?.sms || null,
          note: describeTrackingTruth({ trackingUrl: safeLink, via: tracking?.via, tried: tracking?.tried, orderStatus: tracking?.status, attempts: tracking?.attempts }).reason,
          deliveryOtp: /^\d{4,8}$/.test(String(tracking?.deliveryOtp || '')) ? String(tracking.deliveryOtp) : '',
          deliveryPartner: { name: String(tracking?.deliveryPartner?.name || '').slice(0, 100), phone: String(tracking?.deliveryPartner?.phone || '').slice(0, 30) }
        } });
        return;
      }
      if (route === '/pro/api/wallet' && req.method === 'GET') {
        json(res, 200, { ok: true, wallet: walletView(user, { history: true }) });
        return;
      }
      if (route === '/pro/api/wallet/topup' && req.method === 'POST') {
        enforceRateLimit(user, 'walletTopup');
        // Boss (31-10-2026, round 11): "DEFAULT UPI mius@ybl ... PAYMENT WILL
        // BE AUTO VERIFIED." Yahan asli UPI intent + QR banta hai — user apne
        // UPI app se paisa bhej sakta hai.
        const body = await bodyJson(req);
        const wallet = walletView(user);
        const amountPaise = amountPaiseFromBody(body) || Math.max(wallet.shortfallPaise, wallet.minTopupPaise);
        if (amountPaise < 100) throw error(400, 'Top-up ₹1 se zyada hona chahiye.');
        if (amountPaise > TOPUP_MAX_PAISE) throw error(400, `Ek baar me ₹${rupees(TOPUP_MAX_PAISE)} tak hi add kar sakte hain.`);
        const upiUri = buildTopupUpiIntent({ upiId: wallet.upiId, amountPaise, note: 'Wallet topup' });
        if (!upiUri) throw error(503, 'Boss ka UPI set nahi hai — top-up abhi nahi ho sakta.');
        const qrDataUrl = await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
        // Intent server par — claim isi amount par hoga (user jo likhe us par nahi).
        const intentDb = getDb();
        const intent = createTopupIntent(intentDb, user.id, amountPaise);
        saveDb(intentDb);
        // Round 19: paisa/UTR ka snapshot turant cloud me (deploy-proof).
        backupMoneyNow().catch(() => {});
        json(res, 200, {
          ok: true,
          topup: {
            topupId: intent.id, amountPaise, amount: rupees(amountPaise), upiId: wallet.upiId, upiUri, qrDataUrl,
            expiresInMin: Math.round(TOPUP_INTENT_TTL_MS / 60000),
            note: `UPI app me ₹${rupees(amountPaise)} bhejein (UPI id ${wallet.upiId}). Paisa bhejne ke baad neeche UPI ka 12-digit UTR daal kar "Paisa bhej diya" dabaiye.`
          }
        });
        return;
      }
      if (route === '/pro/api/wallet/claim' && req.method === 'POST') {
        enforceRateLimit(user, 'walletClaim');
        const out = await claimWalletTopup(user, await bodyJson(req));
        backupMoneyNow().catch(() => {});
        // Keep this legacy route for users who already paid using an older
        // client; pending claims get the same admin review as bot recharges.
        if (out?.pending) {
          await notifyPendingTopup(telegram, out.requestId);
          retryPendingWalletUtrs({ telegram }).catch(() => {});
        }
        json(res, 200, { ok: true, ...out });
        return;
      }
      if (route === '/pro/api/wallet/upi' && req.method === 'POST') {
        // "AND I CAN CHANGE IT ALSO" — sirf boss.
        if (!isBoss(user.id)) throw error(403, 'UPI sirf boss badal sakta hai.');
        const body = await bodyJson(req);
        const db = getDb();
        const res2 = setWalletUpiId(db, body.upiId, { actor: `miniapp:${user.id}` });
        if (!res2.ok) {
          const e = error(400, res2.reason || 'UPI id galat hai.');
          e.code = 'INVALID_UPI';
          throw e;
        }
        saveDb(db);
        json(res, 200, { ok: true, upiId: res2.upiId, wallet: walletView(user) });
        return;
      }
      if (route === '/pro/api/checkout' && req.method === 'POST') {
        const body = await bodyJson(req);
        if (!checkoutEnabled()) throw error(503, checkoutBlockReason());
        if (ws.checkout) throw error(409, 'A checkout is already pending or unresolved. Check its status; do not place another order.');
        if (ws.chatFlow && ws.chatFlow.stage !== 'DONE') {
          const flow = requireChatFlow(user, ws, { handoffId: ws.chatFlow.id }, ['BILL']);
          if (flow.cartDigest !== chatCartDigest(ws.cart) || flow.addressDigest !== draftDigest(ws.selectedAddress)) {
            throw error(409, 'Cart ya address badal gaya. Pehle naya bill check karein.');
          }
          if (getActiveUserOrder(user.id)) throw error(409, 'Chat mein active order hai. Pehle usko check karein.');
        }
        const account = currentAccount(user, ws);
        const customerId = String(account.customerId || '').trim();
        if (!customerId) throw error(409, 'Reconnect this Swiggy account before checkout so its identity can be verified for recovery.');
        const quote = ws.cart?.quote;
        const quotedAt = Date.parse(quote?.fetchedAt || '');
        const total = Number(quote?.total);
        if (body.confirmCheckout !== true || !quote || !ws.cart?.items?.length || !ws.selectedAddress ||
            !Number.isFinite(quotedAt) || quotedAt > Date.now() + 30_000 || Date.now() - quotedAt > 5 * 60_000 ||
            String(body.quoteFetchedAt || '') !== String(quote.fetchedAt) || exactPaise(total) === null || total <= 0 ||
            exactPaise(body.expectedTotal) === null || exactPaise(body.expectedTotal) !== exactPaise(total)) {
          throw error(400, 'Review a fresh Swiggy bill and explicitly confirm its exact amount before placing an order.');
        }
        // Recover an existing journal before considering a new fee. If the
        // workspace was lost, the original account is unknown: never present a
        // newly-selected account as the one that sent the earlier request.
        const generation = ws.checkoutGeneration ?? 0;
        if (!Number.isSafeInteger(generation) || generation < 0) throw error(503, 'Checkout state is invalid; contact the operator.');
        const checkoutId = String(generation);
        const placementKey = `pro:${user.id}:${checkoutId}`;
        const previousPlacement = readSwiggyPlacement(placementKey);
        if (previousPlacement) {
          ws.checkout = {
            id: checkoutId, status: 'OUTCOME_UNKNOWN', accountKey: '', accountPhone: '',
            createdAt: String(previousPlacement.createdAt || ''),
            orderId: normalizeSwiggyOrderId(previousPlacement.orderId || ''),
            message: 'Order Swiggy par ho sakta hai. Original account me My Orders check karein; dobara order na karein.'
          };
          writeProWorkspace(user.id, ws);
          json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout) });
          return;
        }
        // Bill dekhne par kuch nahi rukta — placement se pehle fee chahiye.
        const walletDb = getDb();
        const feePaise = serviceFeePaiseFor(walletDb);
        const walletRecord = getWallet(walletDb, user.id);
        const feeExempt = isBoss(user.id) || Boolean(walletRecord?.feeExempt);
        const balancePaise = walletBalancePaise(walletDb, user.id);
        if (!feeExempt && feePaise > 0 && balancePaise < feePaise) {
          const e = error(409, `Wallet ₹${rupees(balancePaise)} · fee ₹${rupees(feePaise)}. Bot me Wallet se add karein.`);
          e.code = 'WALLET_LOW_BALANCE';
          throw e;
        }
        // One durable barrier per user and checkout generation, regardless of
        // account, quote refresh or concurrent stale workspace reads. Advance the
        // generation ONLY after this order is verified paid and explicitly closed.
        // Workspace/cart mutation still requires one app instance (see setup).
        ws.checkout = {
          id: checkoutId, accountKey: ws.activeAccountKey, accountPhone: String(account.phone || ''), status: 'SUBMITTING',
          accountCustomerId: customerId, accountSessionFingerprint: sessionFingerprint(accountMap(user, ws)[ws.activeAccountKey]),
          createdAt: new Date().toISOString(), amount: total, restaurantName: String(ws.cart.restaurantName || ''),
          // Round 21 ("NO SMS RECEIVED"): SMS ka sach receiver ke number par
          // tika hai — isliye order ke waqt hi yaad rakho ki Swiggy ko kaunsa
          // number diya gaya aur "someone else" chaha gaya tha ya nahi.
          receiverPhone: String(normalizeIndianMobileNumber(ws.selectedAddress?.mobile) || ''),
          receiverName: String(ws.selectedAddress?.name || '').slice(0, 60),
          forSomeoneElse: ws.cart?.forSomeoneElse === true
        };
        // Check the journal and rate limit before touching the wallet. Persist
        // the logical checkout first, so a crash between debit and provider POST
        // cannot create a second debit/placement for the same checkout.
        enforceRateLimit(user, 'checkout');
        writeProWorkspace(user.id, ws);
        const feeCharge = isBoss(user.id)
          ? { ok: true, code: 'ADMIN_EXEMPT' }
          : chargeServiceFee(walletDb, ws.checkout, user.id);
        if (!feeCharge.ok) {
          ws.checkout = null;
          writeProWorkspace(user.id, ws);
          const e = error(feeCharge.code === 'INSUFFICIENT_BALANCE' ? 409 : 503,
            feeCharge.code === 'INSUFFICIENT_BALANCE' ? 'Wallet balance kam hai. Bot me Wallet se add karein.' : 'Wallet check nahi hua. Admin se baat karein.');
          e.code = feeCharge.code === 'INSUFFICIENT_BALANCE' ? 'WALLET_LOW_BALANCE' : feeCharge.code;
          throw e;
        }
        if (!isBoss(user.id) && !saveDbDurable(walletDb)) {
          // Keep SUBMITTING blocked for review; no provider call has occurred.
          const e = error(503, 'Wallet record save nahi hua. Order place nahi hua; admin se baat karein.');
          e.code = 'WALLET_SAVE_FAILED';
          throw e;
        }
        try {
          writeProWorkspace(user.id, ws);
        } catch (err) {
          // There has been no provider call. Refund from a fresh wallet and
          // leave the first workspace barrier in place if it cannot be cleared.
          const fresh = getDb();
          const refund = refundServiceFee(fresh, ws.checkout, user.id, { reason: 'checkout state save nahi hua' });
          const feeWasCharged = ['CHARGED', 'ALREADY_CHARGED'].includes(feeCharge.code);
          const refundSaved = !feeWasCharged || (refund.ok && saveDbDurable(fresh));
          if (refundSaved) {
            ws.checkout = null;
            try { writeProWorkspace(user.id, ws); } catch {}
            if (refund.ok) backupMoneyNow().catch(() => {});
          } else {
            // The first SUBMITTING barrier is already durable; never clear it
            // while the fee refund may not have reached stable storage.
            ws.checkout.status = 'OUTCOME_UNKNOWN';
            ws.checkout.message = 'Order place nahi hua; wallet refund check ke liye admin se baat karein.';
            try { writeProWorkspace(user.id, ws); } catch {}
          }
          const e = error(503, refundSaved
            ? 'Checkout save nahi hua. Order place nahi hua; admin se baat karein.'
            : 'Wallet refund confirm nahi hua. Order place nahi hua; admin se baat karein.');
          e.code = refundSaved ? 'CHECKOUT_SAVE_FAILED' : 'WALLET_SAVE_FAILED';
          throw e;
        }
        if (feeCharge.code === 'CHARGED') backupMoneyNow().catch(() => {});
        let providerReturned = false;
        let result;
        try {
          result = await provider.checkout(account, ws.selectedAddress, ws.cart, placementKey);
          providerReturned = true;
          const orderId = normalizeSwiggyOrderId(result?.orderId);
          // Boss (31-10-2026, round 15): provider ne jo intent diya wo pehle se
          // saaf + validated hai. Yahan sirf wahi string QR me jaati hai —
          // dobara kachra check karke QR rokna galat tha.
          const uri = String(result?.upiIntentUrl || '');
          // Boss (31-10-2026, round 18): QR generation ka aakhri gate bhi wahi
          // plan hai — amount, encoding, length, VPA, scheme sab ek jagah.
          const qrPlan = planQrGeneration([{ source: 'provider', uri }], { amount: total });
          if (!orderId || !qrPlan.ok) {
            const reasons = (qrPlan.reasons || []).slice(0, 3);
            throw new Error(`Payment details match nahi hue: ${reasons.join(' · ') || 'QR string khaali/galat hai'}.`);
          }
          const qrUri = qrPlan.uri;
          const qrDataUrl = await QRCode.toDataURL(qrUri, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
          // Image sach me QR hai? Nahi to QR dikhane ka matlab hi nahi.
          if (!isRenderableQrImage(qrDataUrl)) {
            throw new Error(`QR image ban nahi payi (${describeQrPlan({ ...qrPlan, ok: false })}). Swiggy se payment status check karein.`);
          }
          Object.assign(ws.checkout, {
            status: 'PAYMENT_PENDING', orderId, paymentTxnId: String(result.paymentTxnId || '').slice(0, 200),
            upiIntentUrl: qrUri, qrDataUrl, ofoConfirmed: result.ofoConfirmed === true,
            // Round 18: QR kis source se bana (provider / payment page) aur baaki
            // candidates ka sach — jhooth nahi, debug ke liye.
            qrSource: String(result.intentSource || 'provider').slice(0, 30),
            qrPlan: (result.intentAttempts || []).slice(0, 4),
            message: 'Swiggy returned payment details. Payment and restaurant acceptance are not yet verified.'
          });
          writeProWorkspace(user.id, ws);
        } catch (err) {
          // Boss (31-10-2026, round 12): "QR NAHI AYA AISA HO GAYA". Order ban
          // gaya par Swiggy ne QR nahi diya — ise "outcome unknown" ki tarah
          // chhupana galat tha. Ab order ID + asli wajah dikhati hai, aur
          // payment status check chalta rehta hai (koi naya order nahi banta).
          if (err?.diag?.qrMissing === true && err?.diag?.placedOrderId) {
            ws.checkout.status = 'PAYMENT_PENDING';
            ws.checkout.orderId = normalizeSwiggyOrderId(err.diag.placedOrderId);
            ws.checkout.qrMissing = true;
            ws.checkout.qrMissingReason = String(err.diag.intentProblem || err.message || '').slice(0, 300);
            ws.checkout.qrMissingReasons = Array.isArray(err.diag.intentProblems)
              ? err.diag.intentProblems.slice(0, 3).map(String)
              : [];
            ws.checkout.paymentTxnId = String(err.diag.paymentTxnId || '').slice(0, 200);
            ws.checkout.paymentPageUrl = /^https:\/\//i.test(String(err.diag.paymentPageUrl || '')) ? String(err.diag.paymentPageUrl).slice(0, 1500) : '';
            ws.checkout.message = 'Swiggy ne order accept kar liya par payment QR nahi diya. Order Swiggy par bana hua hai — dobara order na karein; yahan se payment status check karte rahein.';
            delete ws.checkout.upiIntentUrl;
            delete ws.checkout.qrDataUrl;
            writeProWorkspace(user.id, ws);
            json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout, { restricted: isSharedAccountFor(user, ws, ws.checkout.accountKey) }) });
            return;
          }
          const record = readSwiggyPlacement(placementKey);
          if (record || err?.diag?.placementAttempted === true || providerReturned) {
            ws.checkout.status = 'OUTCOME_UNKNOWN';
            ws.checkout.orderId = normalizeSwiggyOrderId(result?.orderId || err?.diag?.placedOrderId || record?.orderId || '');
            ws.checkout.message = 'An order may exist on Swiggy. Open My Orders on the original account; do not retry or switch accounts.';
            delete ws.checkout.upiIntentUrl;
            delete ws.checkout.qrDataUrl;
            writeProWorkspace(user.id, ws);
            json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout, { restricted: isSharedAccountFor(user, ws, ws.checkout.accountKey) }) });
            return;
          }
          // Order place nahi hua — fee wapas (boss ka rule: QR stage par
          // cancel/nakami = refund; place ho jaye to nahi).
          if (ws.checkout) {
            const freshWalletDb = getDb();
            const refund = refundServiceFee(freshWalletDb, ws.checkout, user.id, { reason: 'order place nahi hua' });
            const feeWasCharged = ['CHARGED', 'ALREADY_CHARGED'].includes(feeCharge.code);
            if (feeWasCharged && (!refund.ok || !saveDbDurable(freshWalletDb))) {
              // Keep checkout blocked if refund persistence is uncertain.
              ws.checkout.status = 'OUTCOME_UNKNOWN';
              ws.checkout.message = 'Order place nahi hua, lekin wallet refund save nahi hua. Admin se baat karein.';
              writeProWorkspace(user.id, ws);
              const failure = error(503, ws.checkout.message);
              failure.code = 'WALLET_SAVE_FAILED';
              throw failure;
            }
            if (refund.ok) backupMoneyNow().catch(() => {});
          }
          ws.checkout = null;
          // Bill/coupon badal gaya par items+address wahi hain: Swiggy ka naya
          // bill save karke dikhate hain, taaki user use dekh kar dobara Pay
          // dabaye. Order tabhi jaata hai jab user naya amount khud dekhe.
          if (err?.code === 'BILL_CHANGED' && err?.diag?.freshBill && ws.cart) {
            ws.cart.quote = {
              ...billBreakdown(err.diag.freshBill),
              couponCode: String(err.diag.freshBill.coupon || '').toUpperCase(),
              ofoConfirmed: false, fetchedAt: new Date().toISOString()
            };
            writeProWorkspace(user.id, ws);
            const changed = error(409, String(err.message || 'Bill badal gaya — naya bill dekh kar dobara Pay dabaiye.'));
            changed.code = 'BILL_CHANGED';
            throw changed;
          }
          if (ws.cart) ws.cart.quote = null;
          writeProWorkspace(user.id, ws);
          const detail = Array.isArray(err?.diag?.problems) && err.diag.problems.length
            ? ` Wajah: ${err.diag.problems.map(p => p.message).join(' ')}`
            : '';
          const failure = error(Number(err?.statusCode) || 502, `${String(err?.message || 'Checkout could not be prepared. No order was placed.')}${detail}`);
          failure.code = String(err?.code || '');
          throw failure;
        }
        json(res, 200, { ok: true, checkout: publicCheckout(ws.checkout, { restricted: isSharedAccountFor(user, ws, ws.checkout.accountKey) }) });
        return;
      }
      if (route === '/pro/api/checkout/status' && req.method === 'POST') {
        await bodyJson(req);
        const checkout = ws.checkout;
        if (!checkout) throw error(404, 'No Mini App checkout exists.');
        if (checkout.status === 'PAID' || !normalizeSwiggyOrderId(checkout.orderId)) {
          json(res, 200, { ok: true, checkout: publicCheckout(checkout, { restricted: isSharedAccountFor(user, ws, checkout.accountKey) }) });
          return;
        }
        const payment = await provider.checkPayment(checkoutAccount(user, ws), checkout);
        const exactPaidOrder = payment?.paid === true && String(payment.swiggyOrderId || '') === String(checkout.orderId);
        checkout.paymentVerified = checkout.paymentVerified === true || payment?.paymentVerified === true || exactPaidOrder;
        if (exactPaidOrder) {
          const link = String(payment.trackingUrl || payment.nativeShareUrl || payment.swiggyWebTrackUrl || '');
          checkout.status = 'PAID';
          checkout.message = 'Swiggy returned a paid order for this exact order ID.';
          // Round 21: payment ke waqt jo link mila usse shuru, phir deep probe
          // (trackV4 → order/details → order page) — kyunki aksar payment
          // response me link nahi hota aur boss ko khaali screen dikhti thi.
          checkout.tracking = {
            orderId: checkout.orderId, status: String(payment.orderStatus || '').slice(0, 200),
            eta: String(payment.etaMinutes || '').slice(0, 100),
            trackingUrl: safeTrackingUrl(link, checkout.orderId),
            via: link ? 'CHECKOUT' : '',
            tried: [],
            sms: scanRecipientSmsEvidence(payment),
            deliveryOtp: /^\d{4,8}$/.test(String(payment.deliveryOtp || '')) ? String(payment.deliveryOtp) : '',
            deliveryPartner: { name: String(payment.deliveryBoy?.name || '').slice(0, 100), phone: String(payment.deliveryBoy?.mobile || '').slice(0, 30) }
          };
          // Link/ SMS ka gehra sach — fail ho to jo hai wahi rehta hai (jhooth nahi).
          try {
            const deep = await provider.tracking(checkoutAccount(user, ws), checkout.orderId);
            if (deep) {
              checkout.tracking = {
                ...checkout.tracking,
                status: String(deep.status || checkout.tracking.status || '').slice(0, 200),
                eta: String(deep.eta || checkout.tracking.eta || '').slice(0, 100),
                trackingUrl: safeTrackingUrl(deep.trackingUrl, checkout.orderId) || checkout.tracking.trackingUrl,
                via: deep.trackingUrl ? String(deep.via || 'FYI_CTA') : checkout.tracking.via,
                tried: Array.isArray(deep.tried) ? deep.tried.slice(0, 4) : [],
                attempts: Number(deep.attempts || 0),
                sms: deep.sms?.state && deep.sms.state !== 'UNKNOWN' ? deep.sms : checkout.tracking.sms,
                deliveryOtp: checkout.tracking.deliveryOtp || (deep.deliveryOtp || ''),
                deliveryPartner: checkout.tracking.deliveryPartner?.name ? checkout.tracking.deliveryPartner : (deep.deliveryPartner || checkout.tracking.deliveryPartner)
              };
            }
          } catch (err) {
            checkout.tracking.deepError = String(err?.message || err).slice(0, 200);
          }
          delete checkout.upiIntentUrl;
          delete checkout.qrDataUrl;
        } else if (checkout.paymentVerified) {
          checkout.message = 'Payment was reported by Swiggy, but this exact order is not yet confirmed. Check My Orders; do not pay again.';
        }
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, checkout: publicCheckout(checkout, { restricted: isSharedAccountFor(user, ws, checkout.accountKey) }) });
        return;
      }
      if (route === '/pro/api/checkout/finish' && req.method === 'POST') {
        const body = await bodyJson(req);
        if (body.confirmNewDraft !== true || ws.checkout?.status !== 'PAID') throw error(409, 'Only a verified paid order can be closed here.');
        const generation = ws.checkoutGeneration ?? 0;
        if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) throw error(503, 'Checkout state is invalid; contact the operator.');
        ws.checkoutGeneration = generation + 1;
        ws.checkout = null;
        ws.cart = null;
        if (ws.chatFlow) ws.chatFlow.stage = 'DONE';
        writeProWorkspace(user.id, ws);
        json(res, 200, { ok: true, ...publicState(user, ws) });
        return;
      }
      throw error(404, 'Not found.');
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      // Do not log inputs, tokens, addresses, or raw Swiggy errors.
      // Boss (31-10-2026): app ko asli wajah ke saath code chahiye — warna wo
      // "outcome unknown" ka darr dikha deta hai jabki kuch bhi place nahi hua.
      const KNOWN_CODES = new Set([
        'PRO_VAULT_NOT_CONFIGURED', 'PRO_VAULT_DECRYPT_FAILED', 'ACCOUNT_NEEDS_CONFIRM', 'ADDRESS_INCOMPLETE',
        'SHARED_ACCOUNT_RESTRICTED', 'BILL_CHANGED', 'CART_ITEMS', 'CART_FETCH', 'CART_PARSE', 'CART_ID',
        'ADDRESS', 'OFO', 'COUPON', 'AMOUNT', 'AMOUNT_MISSING', 'RESTAURANT', 'GROUP_CART_EXPIRED',
        'GROUP_CART_PLACED', 'GROUP_CART_BUSY', 'GROUP_CART_FETCH_FAILED', 'SWIGGY_ACCOUNT_NOT_REGISTERED',
        'OTP_IDENTITY_MISSING', 'WALLET_LOW_BALANCE', 'INVALID_UPI', 'DUPLICATE_UTR',
        'UTR_REQUIRED', 'UTR_INVALID', 'NO_TOPUP_INTENT', 'TOPUP_AMOUNT_MISMATCH',
        'RATE_LIMITED', 'ACCOUNT_ALREADY_MANAGED', 'ACCOUNT_UNAVAILABLE', 'DRAFT_EXISTS', 'AMOUNT_TOO_LOW'
      ]);
      const code = KNOWN_CODES.has(String(err?.code || '')) ? err.code : undefined;
      json(res, status, {
        ok: false,
        error: status >= 500 && status !== 501 && status !== 502 && status !== 503 ? 'Unable to complete this request. Please retry.' : String(err?.message || 'Request failed.'),
        ...(code ? { code } : {}),
        ...(err?.wallet ? { wallet: err.wallet } : {})
      });
    }
  });
  return true;
}
