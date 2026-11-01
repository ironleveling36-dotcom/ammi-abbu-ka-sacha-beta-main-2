/**
 * order-account-lock.js — ek order, ek ID, poore order ke liye.
 *
 * Boss (29-10-2026): "abbu ammi ne link bheja, address fetch + cart fetched. Ab jo
 * ID zero order wali hogi uska JSON Ammi ke phone se login hoga → bill → QR →
 * link → updates. After deliver **ya cancel**, account wapas mere vault me aaye
 * — tab tak wo Abbu ko bhi assign na ho. After deliver auto export mujhe aur
 * Ammi ke phone se logout."
 *
 * Pehle sirf ek 90-second in-memory reservation thi (`reserveSwiggyAccountAtomically`)
 * aur 20-minute "busy" window. Usse order ke beech ID doosre order ko mil sakti
 * thi — aur deliver hone par bhi lock ka koi durable record nahi tha.
 *
 * Ab: `acc.orderLock = { orderId, phone, holder, at }` DB me (disk par) rehta hai
 * aur SIRF tab hatta hai jab:
 *   • order terminal ho (COMPLETED / CANCELLED / REJECTED),
 *   • ya safety TTL (6 ghante) beet jaye,
 *   • ya account switch / manual release ho.
 *
 * Yeh module pure hai (koi network/Telegram nahi) — test offline chalti hai.
 */

/** Safety TTL: koi order 6 ghante se zyada ek ID ko na roke. */
export const ACCOUNT_LOCK_TTL_MS = 6 * 60 * 60 * 1000;
export const TERMINAL_ORDER_STATUSES = ['COMPLETED', 'CANCELLED', 'REJECTED'];

function nowIso(at) {
  return new Date(at || Date.now()).toISOString();
}

export function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.includes(String(status || '').toUpperCase());
}

/** Order ka label (boss/customer card me dikhane ke liye). */
export function orderHolderLabel(order) {
  const raw = String(
    order?.customerName || order?.userName || order?.customerLabel ||
    order?.user?.name || order?.userId || ''
  ).trim();
  return raw ? raw.slice(0, 40) : 'Customer';
}

/** Account par maujood lock (ya null). */
export function accountLockOf(acc) {
  const lock = acc?.orderLock;
  if (!lock || typeof lock !== 'object' || !lock.orderId) return null;
  return lock;
}

export function lockAgeMs(lock, nowMs = Date.now()) {
  const at = Date.parse(String(lock?.at || ''));
  if (!Number.isFinite(at)) return Infinity;
  return Math.max(0, nowMs - at);
}

/**
 * ID ko is order ke naam par lock karo (ek order = ek ID).
 * Wahi order ki koi doosri ID pehle locked ho to woh release ho jaati hai.
 */
export function lockAccountToOrder(db, accKey, order, { at = Date.now(), phone = '' } = {}) {
  if (!db || !accKey || !order?.id) return null;
  if (!db.config) db.config = {};
  if (!db.config.accounts) return null;
  const acc = db.config.accounts[accKey];
  if (!acc) return null;

  const orderId = String(order.id);
  // Ek order = ek ID: isi order ki purani lock hata do (ID switch case).
  for (const [key, other] of Object.entries(db.config.accounts)) {
    const lock = accountLockOf(other);
    if (!lock) continue;
    if (String(lock.orderId) === orderId && key !== accKey) {
      other.orderLock = null;
      other.lastUnlockedAt = nowIso(at);
      other.lastUnlockReason = `ID switch → ab ${accKey} is order par`;
    }
  }

  const existing = accountLockOf(acc);
  if (existing && String(existing.orderId) !== orderId) {
    // Doosre order ki locked ID ko chheena nahi jata — caller ko pata chalna chahiye.
    return { conflict: true, lock: existing, accountKey: accKey };
  }

  acc.orderLock = {
    orderId,
    phone: String(phone || acc.phone || acc.mobile || accKey.replace(/^acc_/, '')).slice(0, 20),
    holder: orderHolderLabel(order),
    stage: String(order.cardStage || order.status || ''),
    at: nowIso(at),
    orderAccount: accKey
  };
  order.lockedAccount = accKey;
  order.accountLockedAt = acc.orderLock.at;
  return { conflict: false, lock: acc.orderLock, accountKey: accKey };
}

/** Lock hatao (order terminal / switch / manual). */
export function releaseAccountLock(db, accKey, { orderId = '', reason = '', at = Date.now() } = {}) {
  if (!db?.config?.accounts) return { released: false, reason: 'no db' };
  const acc = db.config.accounts[accKey];
  if (!acc) return { released: false, reason: 'account not found' };
  const lock = accountLockOf(acc);
  if (!lock) return { released: false, reason: 'no lock' };
  if (orderId && String(lock.orderId) !== String(orderId)) {
    return { released: false, reason: `lock doosre order ki hai (#${lock.orderId})`, lock };
  }
  acc.orderLock = null;
  acc.lastUnlockedAt = nowIso(at);
  acc.lastUnlockReason = reason || 'released';
  const order = db.orders?.[String(lock.orderId)];
  if (order) {
    order.accountLockReleasedAt = acc.lastUnlockedAt;
    order.accountLockReleaseReason = acc.lastUnlockReason;
  }
  return { released: true, orderId: lock.orderId, reason: acc.lastUnlockReason, accountKey: accKey };
}

/** Kya yeh ID kisi DOOSRE order ke naam par locked hai? (sach, koi andaza nahi) */
export function isAccountLockedForOtherOrder(db, accKey, orderId = '', { nowMs = Date.now() } = {}) {
  const acc = db?.config?.accounts?.[accKey];
  const lock = accountLockOf(acc);
  if (!lock) return { locked: false };
  const lockOrderId = String(lock.orderId);
  if (orderId && lockOrderId === String(orderId)) return { locked: false, ownLock: true, lock };
  const lockOrder = db?.orders?.[lockOrderId];
  const stale = lockAgeMs(lock, nowMs) > ACCOUNT_LOCK_TTL_MS;
  const terminal = lockOrder ? isTerminalOrderStatus(lockOrder.status) : false;
  if (stale || terminal || !lockOrder) {
    // Dead lock — sach me koi order nahi hai, isliye roka nahi jata (par caller sweep chala sakta hai).
    return { locked: false, deadLock: true, lock, reason: !lockOrder ? 'order missing' : (terminal ? 'order terminal' : 'lock stale') };
  }
  return {
    locked: true,
    lock,
    orderId: lockOrderId,
    holder: lock.holder || orderHolderLabel(lockOrder),
    ageMs: lockAgeMs(lock, nowMs)
  };
}

/** Doosre orders ke naam par locked IDs (selection/busy map ke liye). */
export function lockedKeysForOtherOrders(db, orderId = '', { nowMs = Date.now() } = {}) {
  const out = new Map();
  for (const [key, acc] of Object.entries(db?.config?.accounts || {})) {
    const v = isAccountLockedForOtherOrder(db, key, orderId, { nowMs });
    if (v.locked) out.set(key, v);
  }
  return out;
}

/**
 * Dead locks saaf karo: order terminal/missing, ya TTL beet gaya.
 * Har removal ka asli reason return hota hai (jhooth nahi).
 */
export function sweepAccountLocks(db, { nowMs = Date.now() } = {}) {
  const released = [];
  for (const [key, acc] of Object.entries(db?.config?.accounts || {})) {
    const lock = accountLockOf(acc);
    if (!lock) continue;
    const orderId = String(lock.orderId);
    const order = db?.orders?.[orderId];
    let reason = '';
    if (!order) reason = 'order missing';
    else if (isTerminalOrderStatus(order.status)) reason = `order ${String(order.status).toLowerCase()}`;
    else if (lockAgeMs(lock, nowMs) > ACCOUNT_LOCK_TTL_MS) reason = 'lock TTL (6h) beet gaya';
    if (!reason) continue;
    const res = releaseAccountLock(db, key, { orderId, reason, at: nowMs });
    if (res.released) released.push({ accountKey: key, orderId, reason });
  }
  return { released, at: new Date(nowMs).toISOString() };
}

/**
 * Order band hone par (deliver ya cancel) ID ka kya karna hai.
 *
 * Rules (boss ka order):
 *   • Lock HAMESHA release — ID wapas vault me, ab kisi bhi naye order ko mil sakti hai.
 *   • DELIVERED → auto export (7-field JSON boss ko) + logout (phone se bhi).
 *   • CANCELLED/REJECTED → export+logout SIRF tab jab ID sach me customer ke phone
 *     par gayi ho ya Swiggy par order ban chuka ho. Warna (bill reject hua, kuch
 *     place nahi hua) session zinda rehta hai — usko maar dena galat hoga.
 */
export function planAccountReturnOnClose(order, { at = Date.now() } = {}) {
  if (!order?.id) return { shouldRelease: false, reason: 'order missing' };
  const accountKey = String(order.selectedAccount || order.lockedAccount || order.injectedSession?.accountKey || '');
  const status = String(order.status || '').toUpperCase();
  const terminal = isTerminalOrderStatus(status);
  const delivered = Boolean(order.deliveredAt) || /delivered/i.test(String(order.liveOrderStatus || ''));
  const wentToCustomerPhone = Boolean(order.deviceLogin?.handoverSentAt) || String(order.placementMode || '').toUpperCase() === 'CUSTOMER_PHONE';
  const placedOnSwiggy = Boolean(order.swiggyOrderId || order.pendingSwiggyOrderId);

  if (!terminal) {
    return { shouldRelease: false, shouldExport: false, shouldLogout: false, accountKey, reason: 'order abhi chal raha hai — lock chalu rahega' };
  }

  const base = { shouldRelease: true, accountKey, delivered, status, at: nowIso(at) };

  if (delivered) {
    return { ...base, shouldExport: true, shouldLogout: true, reason: 'delivered — export + logout' };
  }
  if (status === 'CANCELLED' || status === 'REJECTED') {
    if (placedOnSwiggy || wentToCustomerPhone) {
      return {
        ...base,
        shouldExport: true,
        shouldLogout: true,
        reason: placedOnSwiggy
          ? 'order cancel hua par Swiggy par ban chuka tha — export + logout'
          : 'ID customer ke phone par gayi thi — export + logout'
      };
    }
    return {
      ...base,
      shouldExport: false,
      shouldLogout: false,
      reason: 'cancel hua, Swiggy par kuch place nahi hua aur ID phone par nahi gayi — session zinda, sirf lock hata'
    };
  }
  // COMPLETED par delivery proof nahi (payment confirm hua, delivery pending)
  return { ...base, shouldExport: false, shouldLogout: false, reason: 'payment confirm hua, delivery pending — lock hata, session zinda' };
}

/** UI line: kaunsi ID kis order par atki hai (boss + customer card). */
export function lockStatusLine(db, accKey, { escape = (v) => String(v ?? ''), nowMs = Date.now() } = {}) {
  const acc = db?.config?.accounts?.[accKey];
  const lock = accountLockOf(acc);
  if (!lock) return '';
  const order = db?.orders?.[String(lock.orderId)];
  const mins = Math.round(lockAgeMs(lock, nowMs) / 60000);
  const stage = order?.liveOrderStatus || order?.cardStage || lock.stage || '';
  return `🔒 <b>${escape(lock.phone || accKey)}</b> order <code>#${escape(lock.orderId)}</code> par locked` +
    ` (${escape(String(stage || 'chal raha hai'))} · ${mins} min) — jab tak deliver/cancel nahi hota, kisi aur order ko nahi milegi`;
}
