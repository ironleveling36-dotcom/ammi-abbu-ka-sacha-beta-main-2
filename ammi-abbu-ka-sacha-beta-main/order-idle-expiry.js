/**
 * order-idle-expiry.js — boss (31-10-2026, round 13):
 *   "jaise koi id active karke order kar raha aur order chhod kar chala gaya to
 *    uska pura order 2 minutes of activity ke baad band ho jayega."
 *
 * Matlab: user ne ID chuni, cart/bill banaya aur phir chala gaya — wo draft ID
 * ko hamesha ke liye nahi pakadta. 2 minute tak koi asli activity na ho to draft
 * order (cart + bill + checkout barrier) band, fee wapas, aur ID agle order ke
 * liye free.
 *
 * Kya KABHI band nahi hota (jhooth ya paisa ka nuksaan nahi):
 *   • `PAID` checkout — paid order band nahi karte.
 *   • `OUTCOME_UNKNOWN` — order Swiggy par ban gaya ho sakta hai; use kisi
 *     timeout se "cancel" kehna jhooth hoga. Uska rasta wahi hai: My Orders.
 *   • `PAYMENT_PENDING` jisme real `orderId` hai — order Swiggy par BANA hua
 *     hai. Use sirf UI se "closed" karte hain (fee wapas nahi), taaki ID free
 *     ho aur doosra order place na ho jaye.
 *
 * Ye module pure hai (koi network, koi file I/O nahi) — isliye test offline.
 */

export const MIN_IDLE_TIMEOUT_MS = 30 * 1000;
export const MAX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Boss ka rule: 2 minute. */
export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * Boss (01-11-2026, round 34): "IT SHOULD BE AFTER BILL IS FETCHED — YOU HAVE
 * 2 MINUTES TO CLICK PAY NOW, OTHERWISE EVERYTHING WILL GET CLEAR."
 *
 * Matlab: 2 minute ka clock **bill aane ke baad** shuru hota hai. Jab tak bill
 * load ho raha hai (ya bill manga hi nahi gaya), kuch saaf nahi hota — warna
 * dheere bill me cart khud hi ud jata tha. Bahut purana adhoora draft (15
 * minute) phir bhi saaf hota hai, taaki pada na rahe.
 */
export const STALE_DRAFT_TIMEOUT_MS = 15 * 60 * 1000;

/** Bill aaya hai ya nahi — sirf asli fetchedAt maante hain. */
export function billFetched(ws = {}) {
  return ms(ws?.cart?.quote?.fetchedAt) > 0;
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(n)));
}

/** Boss panel se set ho to wahi, warna env, warna 2 minute. */
export function idleTimeoutMs(db = null) {
  const fromDb = db?.config?.orderIdleTimeoutMs;
  if (fromDb !== null && fromDb !== undefined && fromDb !== '') return clampTimeout(fromDb);
  const fromEnv = process.env.ORDER_IDLE_TIMEOUT_MS;
  if (fromEnv !== null && fromEnv !== undefined && fromEnv !== '') return clampTimeout(fromEnv);
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function ms(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Aakhri ASLI activity kab thi — user ne jo bhi kiya (cart add, bill, address,
 * login) wahi count hota hai. Sirf page refresh (bootstrap) activity nahi hai,
 * warna banda app khol kar chala jaye to timer kabhi poora hi na ho.
 */
export function lastActivityAt(ws = {}) {
  const candidates = [
    ms(ws.lastActivityAt),
    ms(ws.cart?.updatedAt),
    ms(ws.cart?.quote?.fetchedAt),
    ms(ws.checkout?.createdAt),
    ms(ws.selectedAddressAt)
  ].filter(t => t > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

export function touchActivity(ws, at = Date.now()) {
  if (!ws || typeof ws !== 'object') return ws;
  ws.lastActivityAt = new Date(at).toISOString();
  return ws;
}

/**
 * Checkout ki asli haalat.
 * @returns {'PAID'|'UNKNOWN'|'SUBMITTING'|'PLACED_UNPAID'|'DRAFT'}
 */
export function classifyCheckout(checkout) {
  if (!checkout) return 'DRAFT';
  const status = String(checkout.status || '').toUpperCase();
  if (status === 'PAID') return 'PAID';
  if (status === 'OUTCOME_UNKNOWN') return 'UNKNOWN';
  if (status === 'SUBMITTING') return 'SUBMITTING';
  if (String(checkout.orderId || '').trim()) return 'PLACED_UNPAID';
  return 'DRAFT';
}

/**
 * Kya ab band karna chahiye?
 * @param {object} args
 * @param {object} args.ws            workspace (cart / checkout)
 * @param {number} [args.now]
 * @param {number} [args.timeoutMs]   default 2 minute
 * @param {boolean} [args.placementInFlight] SUBMITTING ke liye journal record?
 * @returns {{expire:boolean, kind:string, idleMs:number, idledAt:string, refundFee:boolean, keepRecord:boolean, orderId:string}}
 */
export function planIdleExpiry({ ws = null, now = Date.now(), timeoutMs = DEFAULT_IDLE_TIMEOUT_MS, placementInFlight = false } = {}) {
  const timeout = clampTimeout(timeoutMs);
  const idleMs = (() => {
    const last = lastActivityAt(ws);
    if (!last) return 0;
    return Math.max(0, now - last);
  })();
  const base = { expire: false, kind: 'NONE', idleMs, idledAt: '', refundFee: false, keepRecord: false, orderId: '' };
  if (idleMs < timeout) return base;

  const hasCart = Boolean(ws?.cart && (Array.isArray(ws.cart.items) ? ws.cart.items.length : true));
  const checkout = ws?.checkout || null;
  const kind = classifyCheckout(checkout);
  const idledAt = new Date(now).toISOString();

  if (!checkout && !hasCart) return base;
  if (kind === 'PAID' || kind === 'UNKNOWN') return { ...base, kind, idledAt }; // kabhi nahi
  // Round 34: bill abhi aaya hi nahi — 2 minute ka clock shuru hi nahi hua.
  // (Bill load hote hote cart saaf hona boss ki shikayat thi.)
  if (kind === 'DRAFT' && hasCart && !billFetched(ws) && idleMs < STALE_DRAFT_TIMEOUT_MS) {
    return { ...base, kind, idledAt, waitingForBill: true };
  }
  // SUBMITTING may have crashed between saving the fee and creating the
  // dispatch journal. A placed/unpaid order can still exist on Swiggy. Neither
  // is safe to clear automatically or to unlock a second checkout.
  if (kind === 'SUBMITTING' || kind === 'PLACED_UNPAID') {
    return { ...base, kind, idledAt, orderId: String(checkout?.orderId || '') };
  }
  // Draft (cart/bill bana, order place nahi hua) — fee wapas, sab saaf.
  return { expire: true, kind: 'DRAFT', idleMs, idledAt, refundFee: Boolean(checkout && checkout.id), keepRecord: false, orderId: '' };
}

/** App/Telegram ke liye insaani wajah — jhooth nahi. */
export function describeIdleClosure(record = {}) {
  const minutes = Math.max(1, Math.round(Number(record.idleMs || 0) / 60_000));
  if (record.kind === 'PLACED_UNPAID') {
    return `Order #${record.orderId || '—'} Swiggy par bana hua tha aur ${minutes} minute tak koi activity nahi thi — draft yahan band kar diya. Fee wapas nahi hui (order place ho chuka tha). Swiggy par wo unpaid order apne aap cancel ho jata hai.`;
  }
  return `${minutes} minute tak koi activity nahi thi — draft order band kar diya aur ID agle order ke liye free hai${record.refundFee ? '; fee wapas kar di gayi' : ''}.`;
}
