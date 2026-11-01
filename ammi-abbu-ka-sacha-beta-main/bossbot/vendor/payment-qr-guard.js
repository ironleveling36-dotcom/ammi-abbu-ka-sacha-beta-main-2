/**
 * Payment-QR guard — "QR invalid" kabhi customer tak nahi pahunchna chahiye.
 *
 * Complaint (26-10-2026): customer QR scan karta tha to **invalid** dikhta tha,
 * aur "new QR" maangne par **wahi QR** dobara aata tha.
 *
 * Do asli wajah code me mili:
 *   1. `config.bossUpiId` ka default `swiggy@icici` hai — ye Swiggy ka merchant
 *      VPA nahi hai (`upiswiggy@icici` hai) aur kisi ke account se juda bhi nahi
 *      hai. Jab Swiggy payment intent nahi deta, bot is placeholder se apna QR
 *      bana deta tha → har baar **invalid**, aur har baar **same**.
 *   2. Swiggy ka intent reuse window 4 min tha aur "Regenerate" bhi wahi cached
 *      intent lautata tha (forceNewQr kabhi pass nahi hota tha) → same QR.
 *
 * Ye module pure functions deta hai: intent parse/validate, placeholder detect,
 * safe fallback intent (sirf valid + non-placeholder VPA se), aur reuse decision.
 */
import { escapeLight } from './account-views.js';

/** VPA jo Swiggy ke merchant ke hain ya placeholder hain — inse QR nahi banega. */
export const PLACEHOLDER_UPI_IDS = new Set([
  'swiggy@icici',
  'swiggy@okaxis',
  'swiggy@okhdfcbank',
  'swiggy@ybl',
  'example@upi',
  'test@upi',
  'yourname@upi',
  'abc@upi',
  'demo@upi',
  'upi@upi',
  'none'
]);

/** Swiggy ke asli merchant VPAs (intent Swiggy se aaya ho to yahi hote hain). */
// Asli Swiggy merchant handles: `upiswiggy@icici` (app ka dynamic QR) aur
// `swiggy...online.gpay@okpayaxis` type. Plain `swiggy@icici` inme nahi aata —
// wo purana placeholder hai jise payment app reject karta hai.
const SWIGGY_MERCHANT_VPA_RE = /^(?:upiswiggy@[a-z]|swiggy[a-z0-9.\-_]*online[^@]*@[a-z])/i;

export function normalizeUpiId(value) {
  return String(value || '').trim().toLowerCase();
}

export function isPlaceholderUpiId(value) {
  const v = normalizeUpiId(value);
  if (!v) return true;
  if (PLACEHOLDER_UPI_IDS.has(v)) return true;
  // "swiggy@" prefix ka koi bhi variant Swiggy ka merchant VPA hai, boss ka nahi.
  return /^(?:upi)?swiggy[a-z0-9.\-_]*@/i.test(v);
}

export function isValidUpiVpa(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 255) return false;
  if (/\s/.test(v)) return false;
  return /^[a-zA-Z0-9.\-_]{2,255}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/.test(v);
}

export function isSwiggyMerchantVpa(value) {
  return SWIGGY_MERCHANT_VPA_RE.test(String(value || '').trim());
}

/** Parse `upi://pay?...` into key/value pairs, keeping duplicates visible. */
export function parseUpiIntent(uri) {
  const raw = String(uri || '').trim();
  const out = { ok: false, raw, scheme: '', path: '', pairs: [], map: {}, duplicateKeys: [], problems: [] };
  if (!raw) {
    out.problems.push('QR data khaali hai');
    return out;
  }
  const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^?#]*)(?:\?([^#]*))?/);
  if (!m) {
    out.problems.push('QR data koi valid URI nahi hai');
    return out;
  }
  out.scheme = m[1].toLowerCase();
  out.path = m[2] || '';
  const query = m[3] || '';
  for (const seg of query.split('&').filter(Boolean)) {
    const eq = seg.indexOf('=');
    const key = eq === -1 ? seg : seg.slice(0, eq);
    const value = eq === -1 ? '' : seg.slice(eq + 1);
    const decodedValue = (() => {
      try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
    })();
    out.pairs.push({ key, value, decodedValue });
    if (Object.prototype.hasOwnProperty.call(out.map, key)) {
      out.duplicateKeys.push(key);
    } else {
      out.map[key] = decodedValue;
    }
  }
  if (out.scheme !== 'upi') out.problems.push(`scheme "${out.scheme}" hai, "upi" hona chahiye`);
  if (!/^pay$/i.test(out.path)) out.problems.push(`path "/${out.path}" hai, "/pay" hona chahiye`);
  out.ok = out.problems.length === 0;
  return out;
}

/**
 * Ek QR bhejne se pehle ka final check.
 * @returns {{ valid: boolean, problems: string[], warnings: string[], info: object }}
 */
export function validateUpiIntentForQr(uri, { amount = 0, requireAmount = true, allowPlaceholder = false } = {}) {
  const parsed = parseUpiIntent(uri);
  const problems = [...parsed.problems];
  const warnings = [];

  if (parsed.raw) {
    if (/[\u0000-\u001f\u007f]/.test(parsed.raw)) problems.push('QR data me control characters hain');
    if (/[^\x20-\x7E]/.test(parsed.raw)) problems.push('QR data me non-ASCII characters hain (encode nahi hue)');
    if (/\s/.test(parsed.raw)) problems.push('QR data me space hai');
    if (parsed.duplicateKeys.length) problems.push(`duplicate params: ${[...new Set(parsed.duplicateKeys)].join(', ')}`);
  }

  const pa = parsed.map.pa ? String(parsed.map.pa).trim() : '';
  if (!pa) problems.push('pa (payee UPI ID) missing hai');
  else if (!isValidUpiVpa(pa)) problems.push(`pa "${pa}" valid UPI ID nahi hai`);
  // Swiggy ka asli merchant VPA (`upiswiggy@icici`) valid payee hai — sirf
  // woh "placeholder" family galat hai jo Swiggy ka merchant bhi nahi hai.
  else if (!allowPlaceholder && isPlaceholderUpiId(pa) && !isSwiggyMerchantVpa(pa)) {
    problems.push(`pa "${pa}" placeholder hai — is QR par payment kabhi nahi hoga`);
  }

  const cu = parsed.map.cu ? String(parsed.map.cu).toUpperCase() : '';
  if (parsed.map.cu !== undefined && cu !== 'INR') problems.push(`cu "${parsed.map.cu}" hai, INR hona chahiye`);

  const amRaw = parsed.map.am !== undefined ? parsed.map.am : parsed.map.amount;
  const am = Number(amRaw);
  if (amRaw !== undefined && amRaw !== '') {
    if (!Number.isFinite(am) || am <= 0) problems.push(`amount "${amRaw}" valid nahi hai`);
  } else if (requireAmount) {
    problems.push('am (amount) missing hai');
  }
  const expected = Number(amount) || 0;
  if (expected > 0 && Number.isFinite(am) && am > 0 && Math.abs(am - expected) > 1) {
    problems.push(`QR ka amount ₹${am} hai par bill ₹${expected} — scan par galat amount aayega`);
  }

  const tr = parsed.map.tr ? String(parsed.map.tr) : '';
  if (tr.length > 35) warnings.push(`tr ${tr.length} chars ka hai (NPCI limit 35)`);

  return {
    valid: problems.length === 0,
    problems: [...new Set(problems)],
    warnings: [...new Set(warnings)],
    info: {
      scheme: parsed.scheme,
      pa,
      amount: Number.isFinite(am) && am > 0 ? am : null,
      tr,
      isSwiggyMerchant: isSwiggyMerchantVpa(pa),
      params: parsed.pairs.map((p) => p.key)
    }
  };
}

/**
 * Bot ke apne UPI se fallback QR — SIRF tab jab ek asli, valid, non-placeholder
 * VPA configured ho. Warna `{ ok: false, reason }` — koi fake QR nahi.
 */
export function buildFallbackUpiIntent({ upiId, amount, orderId = '', payeeName = 'SWIGGY' } = {}) {
  const vpa = String(upiId || '').trim();
  if (!vpa) return { ok: false, reason: 'Bot ka payment UPI ID set nahi hai' };
  if (isPlaceholderUpiId(vpa)) return { ok: false, reason: `"${vpa}" placeholder Swiggy ID hai, aapka UPI nahi` };
  if (!isValidUpiVpa(vpa)) return { ok: false, reason: `"${vpa}" valid UPI ID nahi hai` };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'amount valid nahi hai' };

  const safeName = String(payeeName || 'SWIGGY').normalize('NFKD').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'SWIGGY';
  const note = `Swiggy Order ${String(orderId || '').slice(0, 20)}`.trim();
  const uri = `upi://pay?pa=${encodeURIComponent(vpa)}` +
    `&pn=${encodeURIComponent(safeName)}` +
    '&mc=5812' +
    `&am=${amt.toFixed(2)}` +
    '&cu=INR' +
    `&tn=${encodeURIComponent(note)}`;
  const check = validateUpiIntentForQr(uri, { amount: amt });
  if (!check.valid) return { ok: false, reason: check.problems.join('; ') };
  return { ok: true, uri, upiId: vpa };
}

/**
 * Pending QR reuse decision. Reuse sirf tab jab QR taza ho, valid ho, aur Boss ne
 * dobara generate nahi maanga ho. "Same QR dobara" isi liye hota tha.
 */
export function shouldReusePendingQr(order, {
  now = Date.now(),
  maxAgeMs = 90_000,
  accountPhone = '',
  forceNew = false
} = {}) {
  if (!order || typeof order !== 'object') return { reuse: false, reason: 'order missing' };
  if (forceNew) return { reuse: false, reason: 'naya QR maanga gaya hai (forceNew)' };
  if (order.qrInvalidatedAt) return { reuse: false, reason: 'pichhla QR invalid mark hua tha' };
  if (order.qrRegenerateCount > 0) return { reuse: false, reason: 'pichhla QR regenerate ho chuka hai' };
  const uri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
  if (!uri) return { reuse: false, reason: 'koi pending QR nahi hai' };
  const createdAt = Number(order.pendingQrCreatedAt || 0);
  if (!createdAt) return { reuse: false, reason: 'QR ka time stamp nahi hai' };
  const age = now - createdAt;
  if (age < 0 || age > maxAgeMs) return { reuse: false, reason: `QR purana hai (${Math.round(age / 1000)}s)` };
  const amount = Number(order.pendingQrAmount || order.finalPayable || order.amount || 0);
  // Bill badal gaya ho to purana QR (purane amount ka) dobara nahi bhejna.
  if (Number(order.pendingQrAmount || 0) > 0 && Number(order.finalPayable || 0) > 0 &&
      Math.abs(Number(order.pendingQrAmount) - Number(order.finalPayable)) > 1) {
    return { reuse: false, reason: `purana QR ₹${order.pendingQrAmount} ka hai, bill ab ₹${order.finalPayable}` };
  }
  const check = validateUpiIntentForQr(uri, { amount });
  if (!check.valid) return { reuse: false, reason: `purana QR invalid hai: ${check.problems.join('; ')}` };
  if (accountPhone && order.pendingQrAddressAccount && String(accountPhone) !== String(order.pendingQrAddressAccount)) {
    return { reuse: false, reason: 'QR doosre account ka hai' };
  }
  return { reuse: true, reason: `QR ${Math.round(age / 1000)}s purana aur valid hai`, uri };
}

/** Card par dikhane ke liye chhota reference (audit me bhi jaata hai). */
export function describeQrRef(orderOrUri) {
  const uri = typeof orderOrUri === 'string'
    ? orderOrUri
    : String(orderOrUri?.pendingSwiggyUpiUri || orderOrUri?.realUpiIntentUri || '');
  const parsed = parseUpiIntent(uri);
  const tr = String(parsed.map.tr || '');
  const am = parsed.map.am || parsed.map.amount || '';
  const tail = tr ? tr.slice(-6) : (parsed.map.pa ? String(parsed.map.pa).slice(-6) : '');
  return { ref: tail ? `…${escapeLight(tail)}` : '', amount: am ? Number(am) : null, tr };
}
