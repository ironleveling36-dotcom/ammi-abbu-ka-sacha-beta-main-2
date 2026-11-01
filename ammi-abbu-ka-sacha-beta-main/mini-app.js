// mini-app.js
// Boss (30-10-2026): "ID choose karne ka option ho, har ID ke saamne likha ho ki
// isse koi order place hua hai ki nahi, suspend ya koi bhi dikkat ho… free cash
// icon, offer active hai ya nahi… aur bot ek button de — OPEN MINI APP."
//
// Yeh module do kaam karta hai:
//   1) TOKEN — sirf jis user ka token hai wahi apna mini app khol sakta hai.
//   2) STATE — ID list ka SACH (used / 0-order / suspended / expired / busy /
//      unverified) + free cash + offer status. Koi jhooth nahi: jo live verify
//      nahi hua usko "unverified" hi likha jata hai.
//
// Network calls kahan hote hain: index.js server routes me (deps inject hote
// hain), taaki ye module offline test ho sake.

import crypto from 'node:crypto';
import { getDb, saveDb } from './store.js';
import { isAccountSuspended, describeSuspendedAccount } from './account-health.js';
import { liveOrderTruth, offerClaimTruth, OFFER_TRACKS } from './account-views.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_KEY = 'miniApp';

function appSecret() {
  // Koi naya secret na ho to BOT_TOKEN se derive karo (har bot ke liye unique),
  // taaki link bina token ke na chale. Kabhi bhi source me hardcode nahi.
  const explicit = String(process.env.MINI_APP_SECRET || '').trim();
  if (explicit) return explicit;
  const base = String(process.env.PAY_WEBHOOK_SECRET || process.env.BOT_TOKEN || 'mini-app-local-dev').trim();
  return crypto.createHash('sha256').update(`mini-app:${base}`).digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', appSecret()).update(payload).digest('base64url');
}

/** User ke liye signed mini-app token — 7 din. */
export function issueMiniAppToken(userId, { now = Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('mini app token ke liye userId chahiye');
  const payload = b64url(JSON.stringify({ u: uid, e: now + Math.max(60_000, Number(ttlMs) || TOKEN_TTL_MS) }));
  return `${payload}.${sign(payload)}`;
}

/** Token check — tampered / expired / khaali, sab saaf reason ke saath. */
export function verifyMiniAppToken(token, { now = Date.now() } = {}) {
  const raw = String(token || '').trim();
  if (!raw || !raw.includes('.')) return { ok: false, reason: 'TOKEN_MISSING' };
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return { ok: false, reason: 'TOKEN_MALFORMED' };
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'TOKEN_BAD_SIGNATURE' };
  }
  let data = null;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'TOKEN_MALFORMED' }; }
  const userId = String(data?.u || '');
  const exp = Number(data?.e || 0);
  if (!userId) return { ok: false, reason: 'TOKEN_MALFORMED' };
  if (!exp || exp <= now) return { ok: false, reason: 'TOKEN_EXPIRED' };
  return { ok: true, userId, expiresAt: exp };
}

// ---------------------------------------------------------------------------
// Per-user mini app state (db me hi, taaki restart par na khoye)
// ---------------------------------------------------------------------------
export function getMiniAppState(userId, { db = null } = {}) {
  const database = db || getDb();
  const all = database?.miniApp && typeof database.miniApp === 'object' ? database.miniApp : {};
  const saved = all[String(userId)] && typeof all[String(userId)] === 'object' ? all[String(userId)] : {};
  return {
    userId: String(userId),
    accountKey: String(saved.accountKey || ''),
    addressText: String(saved.addressText || ''),
    addressDetails: saved.addressDetails && typeof saved.addressDetails === 'object' ? saved.addressDetails : null,
    addresses: Array.isArray(saved.addresses) ? saved.addresses.slice(0, 8) : [],
    cartText: String(saved.cartText || ''),
    cart: saved.cart && typeof saved.cart === 'object' ? saved.cart : null,
    items: Array.isArray(saved.items) ? saved.items.slice(0, 30) : [],
    search: String(saved.search || ''),
    orderId: String(saved.orderId || ''),
    phoneLoginChosen: saved.phoneLoginChosen === true,
    updatedAt: saved.updatedAt || ''
  };
}

export function saveMiniAppState(userId, patch, { db = null } = {}) {
  const database = db || getDb();
  if (!database.miniApp || typeof database.miniApp !== 'object') database.miniApp = {};
  const current = getMiniAppState(userId, { db: database });
  const next = { ...current, ...patch, userId: String(userId), updatedAt: new Date().toISOString() };
  database.miniApp[String(userId)] = next;
  saveDb(database);
  return next;
}

// ---------------------------------------------------------------------------
// ID picker — har ID ka sach
// ---------------------------------------------------------------------------
function maskPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '').slice(-10);
  if (p.length !== 10) return '—';
  return `${p.slice(0, 2)}••••${p.slice(-4)}`;
}

function offersFor(acc) {
  const claim = offerClaimTruth(acc) || {};
  // `offerClaimTruth` har track ka sach sidha track-key par deta hai
  // (`breakfast`, `lateNight`, …) — slots wrapper nahi.
  const slotOf = (key) => claim[key] || claim?.slots?.[key] || null;
  const active = OFFER_TRACKS
    .filter((t) => slotOf(t.key)?.claimed)
    .map((t) => ({ key: t.key, emoji: t.emoji, label: t.bossLabel || t.label }));
  const preLocked = OFFER_TRACKS
    .filter((t) => slotOf(t.key)?.status === 'PRE_LOCKED')
    .map((t) => ({ key: t.key, emoji: t.emoji, label: t.bossLabel || t.label }));
  return {
    active,
    preLocked,
    claimedCount: active.length,
    total: OFFER_TRACKS.length,
    text: `🎁 ${active.length}/${OFFER_TRACKS.length}`
  };
}

/**
 * Ek ID ka picker row. `status` sirf sach par based hai:
 *   USED          → live check me orders mile (used off)
 *   READY         → live check me 0 orders
 *   BUSY          → abhi kisi chalte order ki ID hai
 *   SUSPENDED     → Swiggy ne block kiya
 *   SESSION_EXPIRED → re-login chahiye
 *   UNVERIFIED    → live check nahi hua (jhooth nahi: "check karna hai")
 */
export function describeAccountForPicker(key, acc, { db = null, accounts = null, orders = null, now = Date.now() } = {}) {
  const database = accounts || orders ? { config: { accounts: accounts || {} }, orders: orders || {} } : (db || getDb());
  const phone = String(acc?.phone || acc?.mobile || key || '');
  const truth = liveOrderTruth(acc);
  const offers = offersFor(acc);
  const freeCash = Math.max(0, Number(acc?.freeCashBalance || acc?.walletBalance || 0));
  const suspended = isAccountSuspended(acc, { now });
  const expired = Boolean(acc?.sessionExpired || acc?.isLoggedOut) || !(acc?.cookies || acc?.tid || acc?.jwtTid || acc?.token);
  let busyOrderId = '';
  try {
    const busy = database?.orders || {};
    for (const order of Object.values(busy)) {
      if (!order || ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) continue;
      if (String(order.selectedAccount || '') !== String(key)) continue;
      if (!['AUTO_SELECTING', 'BILL_READY', 'QR_GENERATED'].includes(order.cardStage)) continue;
      busyOrderId = String(order.id || '');
      break;
    }
  } catch { /* db issue → koi busy claim nahi */ }

  let status = 'READY';
  let reason = '';
  if (suspended) {
    status = 'SUSPENDED';
    reason = describeSuspendedAccount(acc) || 'Swiggy ne ID block ki hai';
  } else if (expired) {
    status = 'SESSION_EXPIRED';
    reason = 'Is ID ka login khatam — re-login chahiye';
  } else if (busyOrderId) {
    status = 'BUSY';
    reason = `Abhi order #${busyOrderId} is ID par chal raha hai`;
  } else if (truth.zeroOrder === false) {
    status = 'USED';
    reason = `Is ID par ${truth.totalOrders} order ho chuke hain`;
  } else if (truth.zeroOrder === true) {
    status = 'READY';
    reason = '0 order — fresh ID';
  } else {
    status = 'UNVERIFIED';
    reason = 'Live check nahi hua — pehle check karein';
  }

  const selectable = status === 'READY' || status === 'UNVERIFIED';
  const icons = [];
  if (suspended) icons.push('⛔');
  else if (status === 'USED') icons.push('✔');
  else if (status === 'READY') icons.push('★');
  else if (status === 'BUSY') icons.push('⏳');
  else if (status === 'SESSION_EXPIRED') icons.push('🔑');
  if (freeCash > 0) icons.push('💵');
  if (offers.claimedCount > 0) icons.push('🎁');

  return {
    key: String(key),
    phoneMasked: maskPhone(phone),
    name: String(acc?.name || '').slice(0, 30),
    status,
    selectable,
    reason,
    icons: icons.join(' '),
    orders: truth.totalOrders,
    ordersVerifiedLive: truth.verified,
    zeroOrder: truth.zeroOrder,
    freeCash: Math.round(freeCash),
    offers: offers.active,
    offersPreLocked: offers.preLocked,
    offersText: offers.text,
    busyOrderId,
    label: `${icons.join(' ')} ${maskPhone(phone)} · ${reason}`.trim()
  };
}

/** Poori picker list — fresh + free cash wali IDs upar, used off. */
export function buildMiniAppIdList(userId, { db = null, now = Date.now() } = {}) {
  const database = db || getDb();
  const accounts = database?.config?.accounts || {};
  const state = getMiniAppState(userId, { db: database });
  const rows = Object.entries(accounts).map(([key, acc]) => describeAccountForPicker(key, acc, { db: database, now }));
  const rank = { READY: 0, UNVERIFIED: 1, BUSY: 2, USED: 3, SESSION_EXPIRED: 4, SUSPENDED: 5 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.freeCash - a.freeCash) || (b.offers.length - a.offers.length));
  return {
    rows,
    selectedKey: state.accountKey,
    readyCount: rows.filter((r) => r.status === 'READY').length,
    usedCount: rows.filter((r) => r.status === 'USED').length,
    blockedCount: rows.filter((r) => ['SUSPENDED', 'SESSION_EXPIRED'].includes(r.status)).length
  };
}

/** ID select — jo select ho hi nahi sakti usko mana kar do, saaf reason ke saath. */
export function selectMiniAppAccount(userId, key, { db = null, now = Date.now() } = {}) {
  const database = db || getDb();
  const acc = database?.config?.accounts?.[String(key)];
  if (!acc) return { ok: false, code: 'ACCOUNT_NOT_FOUND', error: 'Ye ID vault me nahi mili' };
  const row = describeAccountForPicker(key, acc, { db: database, now });
  if (!row.selectable) {
    return { ok: false, code: `ID_${row.status}`, error: row.reason, row };
  }
  const state = saveMiniAppState(userId, { accountKey: row.key }, { db: database });
  return { ok: true, row, state };
}

/** Chuni hui ID — warna saaf error (kabhi chupchaap dusri ID nahi). */
export function resolveSelectedAccount(userId, { db = null, now = Date.now() } = {}) {
  const database = db || getDb();
  const state = getMiniAppState(userId, { db: database });
  if (!state.accountKey) return { ok: false, code: 'NO_ID_SELECTED', error: 'Pehle list me se ek ID chuno' };
  const acc = database?.config?.accounts?.[state.accountKey];
  if (!acc) return { ok: false, code: 'ACCOUNT_NOT_FOUND', error: 'Chuni hui ID vault me nahi mili' };
  const row = describeAccountForPicker(state.accountKey, acc, { db: database, now });
  if (row.status === 'SUSPENDED' || row.status === 'SESSION_EXPIRED') {
    return { ok: false, code: `ID_${row.status}`, error: row.reason, row };
  }
  return { ok: true, key: state.accountKey, account: acc, row, state };
}

// ---------------------------------------------------------------------------
// Search / products
// ---------------------------------------------------------------------------
export function filterMenuItems(menuItems, query, { limit = 25 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const items = Array.isArray(menuItems) ? menuItems : [];
  const filtered = q
    ? items.filter((it) => String(it?.name || '').toLowerCase().includes(q))
    : items;
  return filtered.slice(0, Math.max(1, Number(limit) || 25)).map((it) => ({
    id: String(it.id || it.menu_item_id || ''),
    name: String(it.name || '').slice(0, 80),
    price: Math.round(Number(it.price || 0)),
    inStock: it.inStock !== false,
    offerIds: Array.isArray(it.offer_ids) ? it.offer_ids.slice(0, 5) : []
  }));
}

// ---------------------------------------------------------------------------
// Bot card
// ---------------------------------------------------------------------------
export function buildMiniAppInviteCard(userId, { baseUrl = '', reason = '' } = {}) {
  const token = issueMiniAppToken(userId);
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const url = root ? `${root}/app?t=${encodeURIComponent(token)}` : '';
  const text = [
    '🛍 <b>OPEN MINI APP — apna order khud complete karo</b>',
    '',
    '1️⃣ ID chuno — har ID ke saamne sach likha hai (0-order / used / suspend / free cash / offer)',
    '2️⃣ Address link paste karo — address khud select hoga',
    '3️⃣ Cart link paste karo — item change karna ho to search se badlo',
    '4️⃣ Confirm — bill yahin par',
    '',
    reason ? `<i>${reason}</i>` : ''
  ].filter(Boolean).join('\n');
  const keyboard = url
    ? { inline_keyboard: [[{ text: '🛍 Open Mini App', url }], [{ text: '★ Boss Panel', callback_data: 'boss_panel_home' }]] }
    : { inline_keyboard: [[{ text: '★ Boss Panel', callback_data: 'boss_panel_home' }]] };
  return { text, keyboard, url };
}

export const MINI_APP_STATE_KEY = STATE_KEY;
