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
import { exactPaise } from './swiggy-cart-integrity.js';

/** VPA jo Swiggy ke merchant ke hain ya placeholder hain — inse QR nahi banega. */
export const FAKE_PLACEHOLDER_UPI_IDS = new Set([
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

/** @deprecated purana naam — wahi set. */
export const PLACEHOLDER_UPI_IDS = FAKE_PLACEHOLDER_UPI_IDS;

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

/**
 * Swiggy ke kisi bhi bank handle ka VPA (`swiggy@axisbank`, `swiggypay@hdfc` …).
 * Ye payee Swiggy ka hi hota hai; payment app ise accept karta hai. Exact fake
 * list (`swiggy@icici` etc.) alag se block hoti hai.
 */
export function isSwiggyFamilyVpa(value) {
  return /^(?:upi)?swiggy[a-z0-9.\-_]*@[a-z][a-z0-9.\-]*$/i.test(String(value || '').trim());
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
 * Swiggy ka intent har baar ek jaisa nahi aata. Kuch cheezein sirf **transport
 * ki gandi** hoti hain (`&amp;`, `\u0026`, escape kiya `/`, `amount` vs `am`,
 * duplicate param jinki value same hai, `tn` me space). Inhe "invalid QR" maan
 * kar customer ko QR na dena hi boss ki shikayat thi —
 *   "qr nahi aata direct ye ajata".
 * Isliye pehle intent ko SAaf karte hain, phir strict check chalate hain.
 * Paisa kabhi nahi badalta: `am` ki value yahan chhui bhi nahi jaati.
 *
 * @returns {{ uri: string, repairs: string[], ok: boolean }}
 */
export function normalizeUpiIntentForQr(uri, { expectedAmount = 0 } = {}) {
  const repairs = [];
  let raw = String(uri === undefined || uri === null ? '' : uri).trim();
  if (!raw) return { uri: '', repairs, ok: false };
  // Transport escapes — value nahi, sirf encoding.
  const unescaped = raw
    .replace(/&amp;/gi, '&')
    .replace(/&AMP;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/');
  if (unescaped !== raw) {
    repairs.push('HTML/JSON escape hata diya (&amp; / \\u0026)');
    raw = unescaped;
  }
  const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^?#]*)(?:\?([^#]*))?/);
  if (!m) return { uri: raw, repairs, ok: false };
  const scheme = m[1];
  const path = m[2] || '';
  const query = m[3] || '';
  const safeDecode = (value) => {
    try { return decodeURIComponent(String(value).replace(/\+/g, ' ')); } catch { return String(value); }
  };
  let pairs = query.split('&').filter(Boolean).map((seg) => {
    const i = seg.indexOf('=');
    return { key: i === -1 ? seg : seg.slice(0, i), value: i === -1 ? '' : seg.slice(i + 1) };
  });

  // `amount` aur `am` ek hi cheez hai. UPI apps `am` padhte hain; jab `am` maujood
  // hai to `amount` sirf kachra hai — bhale value alag ho. Boss (31-10-2026,
  // round 16): "ORDER KA QR TO AAAHI NAHI RAHA" — isi `amount` vs `am` ke
  // jhagde me QR block ho raha tha (card me likha: "multiple amount params
  // (value alag)"). Jo QR hum banate hain usme sirf `am` jaata hai (jo bill se
  // strictly match hota hai), isliye `amount` hata dena hi sahi hai.
  const amPair = pairs.find((p) => p.key === 'am');
  const amountPairs = pairs.filter((p) => p.key === 'amount');
  if (amountPairs.length) {
    if (!amPair) {
      pairs = pairs.map((p) => (p.key === 'amount' ? { ...p, key: 'am' } : p));
      repairs.push('`amount` ko `am` me badla');
    } else {
      const paise = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n * 100) : null;
      };
      const same = amountPairs.every((p) => paise(p.value) === paise(amPair.value));
      const billPaise = Number(expectedAmount) > 0 ? paise(expectedAmount) : null;
      if (!same && billPaise !== null && amountPairs.some((p) => paise(p.value) === billPaise) && paise(amPair.value) !== billPaise) {
        // Swiggy ne dono bheje aur `am` bill se match nahi karta — jo bill se
        // match karta hai wahi sach hai (warna QR galat amount ka banta).
        const winner = amountPairs.find((p) => paise(p.value) === billPaise);
        pairs = pairs.map((p) => {
          if (p.key === 'amount') return { ...p, key: '__drop_amount' };
          if (p.key === 'am') return { ...p, value: winner.value };
          return p;
        }).filter((p) => p.key !== '__drop_amount');
        repairs.push(`\`am\` bill se match nahi karta tha — bill wala amount \`am=${winner.value}\` liya`);
      } else {
        pairs = pairs.filter((p) => p.key !== 'amount');
        repairs.push(same
          ? 'duplicate `amount` (value same thi) hata diya'
          : `extra \`amount\` param hata diya — QR me sirf \`am=${amPair.value}\` (bill se match kiya) jaata hai`);
      }
    }
  }

  const kept = [];
  const seen = new Map();
  for (const pair of pairs) {
    const previous = seen.get(pair.key);
    if (previous) {
      if (String(previous.value) === String(pair.value)) {
        repairs.push(`duplicate \`${pair.key}\` hata diya (value same thi)`);
        continue;
      }
      kept.push(pair); // alag value → validation ko dikhne do
      continue;
    }
    seen.set(pair.key, pair);
    kept.push(pair);
  }

  const encoded = kept.map((pair) => {
    let value = pair.value;
    if (/[^\x21-\x7E]/.test(value) || /[\u0000-\u001f\u007f]/.test(safeDecode(value))) {
      value = encodeURIComponent(safeDecode(value).replace(/[\u0000-\u001f\u007f]/g, ''));
      repairs.push(`\`${pair.key}\` ko URL-safe banaya`);
    }
    return `${pair.key}=${value}`;
  });

  const built = `${scheme}://${path}${encoded.length ? `?${encoded.join('&')}` : ''}`;
  return { uri: built, repairs, ok: true };
}

/**
 * Ek QR bhejne se pehle ka final check.
 * `problems` = jo sach me block karta hai (paisa/galat payee). `warnings` =
 * auto-fix aur chhoti baatein, jo QR bhejne se nahi rokteen.
 * @returns {{ valid: boolean, problems: string[], warnings: string[], info: object }}
 */
export function validateUpiIntentForQr(uri, { amount = 0, requireAmount = true, allowPlaceholder = false } = {}) {
  const normalized = normalizeUpiIntentForQr(uri, { expectedAmount: amount });
  const parsed = parseUpiIntent(normalized.uri);
  const problems = [...parsed.problems];
  const warnings = normalized.repairs.map((repair) => `auto-fix: ${repair}`);

  if (parsed.raw && /[\u0000-\u001f\u007f]/.test(parsed.raw)) problems.push('QR data me control characters hain');
  if (parsed.raw && /[^\x20-\x7E]/.test(parsed.raw)) problems.push('QR data me non-ASCII characters hain (encode nahi hue)');
  if (parsed.raw && /\s/.test(parsed.raw)) problems.push('QR data me space hai');
  if (parsed.duplicateKeys.length) problems.push(`duplicate params alag value ke saath: ${[...new Set(parsed.duplicateKeys)].join(', ')}`);

  const pa = parsed.map.pa ? String(parsed.map.pa).trim() : '';
  if (!pa) problems.push('pa (payee UPI ID) missing hai');
  else if (!isValidUpiVpa(pa)) problems.push(`pa "${pa}" valid UPI ID nahi hai`);
  // Swiggy ka asli merchant VPA (`upiswiggy@icici`, `swiggy…online@…`) valid
  // payee hai. Sirf **exact** purane fake handles block hote hain — warna
  // Swiggy ka naya bank handle aane par QR hi nahi aata tha.
  else if (!allowPlaceholder && FAKE_PLACEHOLDER_UPI_IDS.has(normalizeUpiId(pa))) {
    problems.push(`pa "${pa}" purana fake/placeholder Swiggy ID hai — is QR par payment kabhi nahi hoga`);
  } else if (!allowPlaceholder && isPlaceholderUpiId(pa) && !isSwiggyMerchantVpa(pa) && !isSwiggyFamilyVpa(pa)) {
    problems.push(`pa "${pa}" placeholder hai — is QR par payment kabhi nahi hoga`);
  }

  const cu = parsed.map.cu ? String(parsed.map.cu).toUpperCase() : '';
  if (parsed.map.cu !== undefined && cu !== 'INR') problems.push(`cu "${parsed.map.cu}" hai, INR hona chahiye`);

  const amRaw = parsed.map.am !== undefined ? parsed.map.am : parsed.map.amount;
  const am = Number(amRaw);
  if (parsed.map.am !== undefined && parsed.map.amount !== undefined) problems.push('multiple amount params (value alag)');
  if (amRaw !== undefined && amRaw !== '') {
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(amRaw)) || exactPaise(amRaw) === null || am <= 0) problems.push(`amount "${amRaw}" valid nahi hai`);
  } else if (requireAmount) {
    problems.push('am (amount) missing hai');
  }
  const expected = Number(amount) || 0;
  if (expected > 0 && (exactPaise(expected) === null || exactPaise(amRaw) !== exactPaise(expected))) {
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
      params: parsed.pairs.map((p) => p.key),
      // QR me bas YE string jaani chahiye (auto-fix ke baad).
      uri: normalized.ok ? normalized.uri : String(uri || '').trim(),
      repaired: [...normalized.repairs]
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
      (exactPaise(order.pendingQrAmount) === null || exactPaise(order.pendingQrAmount) !== exactPaise(order.finalPayable))) {
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
