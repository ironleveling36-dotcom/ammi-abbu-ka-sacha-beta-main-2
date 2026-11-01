/**
 * Boss (31-10-2026, round 18):
 *   "QR GENERATION KE HAR POSSIBILITES KO DHAYAN ME RAKH KAR CODE LIKHO"
 *
 * QR banane me jo jo galat ho sakta hai, sab yahan ek jagah:
 *
 *  1. Swiggy ne intent hi nahi diya            → payment page se recovery
 *  2. Intent escaped/kachra hai (&amp;, \u0026)   → normalize
 *  3. `am` aur `amount` dono, value alag      → bill wala amount chuno
 *  4. Intent `https://...` page link hai       → QR nahi, page se intent
 *  5. Placeholder/fake VPA (`swiggy@icici`)    → block, asli wajah
 *  6. Amount bill se alag                      → block (galat paisa)
 *  7. Amount missing / 0 / teen decimal        → block
 *  8. `cu` non-INR, control char, non-ASCII    → block
 *  9. Duplicate param alag value ke saath      → block
 * 10. Intent bahut lamba (QR capacity)         → block, wajah ke saath
 * 11. Kai intent mile (nested + page)          → har ek try, pehla valid jeete
 * 12. Wahi intent do baar                       → dedupe
 * 13. QR image banti hai par decode nahi hoti   → renderer verify kare
 * 14. Kuch bhi valid nahi                      → `ok: false` + HAR wajah
 *
 * Jhootha QR kabhi nahi: koi bhi fallback apna VPA bana kar QR nahi banata.
 */
import { validateUpiIntentForQr, normalizeUpiIntentForQr } from './payment-qr-guard.js';
import { exactPaise } from './swiggy-cart-integrity.js';

/** QR me itna lamba data nahi jaata (spec practical limit). */
export const MAX_QR_URI_LENGTH = 1200;

/**
 * Ek candidate ko check karo.
 * @returns {{ source: string, ok: boolean, uri: string, reasons: string[], warnings: string[], info: object }}
 */
export function checkQrCandidate(candidate, { amount = 0 } = {}) {
  const source = String(candidate?.source || 'unknown').slice(0, 40);
  const raw = String(candidate?.uri || '').trim();
  const reasons = [];
  const warnings = [];
  if (!raw) {
    return { source, ok: false, uri: '', reasons: ['provider ne koi intent nahi diya'], warnings, info: {} };
  }
  if (raw.length > MAX_QR_URI_LENGTH) {
    return { source, ok: false, uri: '', reasons: [`intent bahut lamba hai (${raw.length} chars, limit ${MAX_QR_URI_LENGTH}) — QR scan nahi hoga`], warnings, info: {} };
  }
  const normalized = normalizeUpiIntentForQr(raw, { expectedAmount: amount });
  warnings.push(...normalized.repairs.map((r) => `auto-fix: ${r}`));
  if (!/^upi:\/\/pay\?/i.test(normalized.uri)) {
    reasons.push(/^https?:\/\//i.test(raw)
      ? 'intent ek web page ka link hai, UPI intent nahi — QR isse nahi banta'
      : 'intent `upi://pay?...` shape me nahi hai');
    return { source, ok: false, uri: '', reasons, warnings, info: {} };
  }
  const check = validateUpiIntentForQr(normalized.uri, { amount, requireAmount: true });
  warnings.push(...(check.warnings || []));
  if (!check.valid) {
    reasons.push(...(check.problems || ['QR valid nahi hai']));
    return { source, ok: false, uri: '', reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], info: check.info || {} };
  }
  const expectedPaise = exactPaise(amount);
  if (expectedPaise === null || expectedPaise <= 0) {
    return { source, ok: false, uri: '', reasons: ['bill ka amount hi valid nahi — QR ka amount match nahi kar sakte'], warnings, info: check.info || {} };
  }
  if (exactPaise(check.info?.amount) !== expectedPaise) {
    return {
      source, ok: false, uri: '',
      reasons: [`QR ka amount ₹${check.info?.amount ?? '?'} hai par bill ₹${Number(amount).toFixed(2)} — galat paisa kat jata`],
      warnings, info: check.info || {}
    };
  }
  return { source, ok: true, uri: check.info?.uri || normalized.uri, reasons: [], warnings: [...new Set(warnings)], info: check.info || {} };
}

/**
 * Saare candidates try karo, pehla valid jeeta hai.
 * @param {Array<{source: string, uri: string}>} candidates
 * @returns {{ ok: boolean, uri: string, source: string, attempted: Array, reasons: string[], warnings: string[] }}
 */
export function planQrGeneration(candidates, { amount = 0 } = {}) {
  const attempted = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const result = checkQrCandidate(candidate, { amount });
    // Wahi intent dobara — dubara try karne ka matlab nahi (par reason rakho).
    const key = String(candidate?.uri || '').trim();
    if (key && seen.has(key)) {
      attempted.push({ ...result, ok: false, reasons: ['wahi intent pehle bhi aaya tha (duplicate)'] });
      continue;
    }
    if (key) seen.add(key);
    attempted.push(result);
    if (result.ok) {
      return {
        ok: true,
        uri: result.uri,
        source: result.source,
        amount: Number(amount),
        attempted,
        reasons: [],
        warnings: [...new Set(result.warnings)]
      };
    }
  }
  const reasons = [];
  for (const item of attempted) {
    for (const reason of item.reasons) reasons.push(item.source === 'provider' ? reason : `${item.source}: ${reason}`);
  }
  if (!attempted.length) reasons.push('QR ke liye koi source hi nahi mila (Swiggy ka intent, payment page — dono khaali).');
  return {
    ok: false,
    uri: '',
    source: '',
    amount: Number(amount),
    attempted,
    reasons: [...new Set(reasons)].slice(0, 6),
    warnings: [...new Set(attempted.flatMap((a) => a.warnings || []))]
  };
}

/** App me dikhane ke liye chhota sach. */
export function describeQrPlan(plan) {
  if (plan?.ok) {
    const bits = [`QR taiyaar (${plan.source})`, `₹${Number(plan.amount || 0).toFixed(2)}`];
    if (plan.warnings?.length) bits.push(`${plan.warnings.length} auto-fix`);
    return bits.join(' · ');
  }
  const first = plan?.reasons?.[0] || 'QR ke liye koi valid source nahi mila.';
  return `QR nahi ban paya — ${first}`;
}

/**
 * Renderer ke liye: data URL sach me QR hai ya nahi (jhoothi image nahi bhejni).
 * QR library ka output hamesha `data:image/png;base64,` hota hai aur khaali
 * nahi hota; ye check usi par.
 */
export function isRenderableQrImage(dataUrl) {
  const text = String(dataUrl || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(text)) return false;
  const base64 = text.slice(text.indexOf(',') + 1);
  if (base64.length < 200) return false; // itni chhoti PNG me QR nahi hota
  try {
    const head = Buffer.from(base64.slice(0, 8), 'base64');
    // PNG signature 89 50 4E 47
    return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  } catch {
    return false;
  }
}
