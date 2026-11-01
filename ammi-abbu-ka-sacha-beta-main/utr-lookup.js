/**
 * Boss (31-10-2026, round 23):
 *   "YE UTR SE PAYMENT DETAILES KE LIYE JO KRNA HAI WO KAR AND BAS USER KO BOL
 *    SEND HOW MUCH MONEY YOU WANT THAT WILL BE FETCHED AND ADDED UPON
 *    SUBMITTING UTR"
 *
 * Yani: user sirf itna batata hai ki **kitna paisa bhejna hai** aur **UTR**
 * daalta hai. Us UTR ki **asli payment details** (kitna aaya, kisko aaya, safal
 * hui ya nahi) server khud fetch karta hai — aur jitna aaya utna hi credit
 * hota hai. User ka claim amount se credit nahi hota.
 *
 * Provider ka shape har jagah alag hota hai, isliye `parseUtrLookup` har aam
 * shape kholta hai (nested data/result/payment/txn, rupees ya paise, status
 * string ya boolean). Kuch samajh na aaye to `found: false` + asli wajah —
 * jhootha "verified" kabhi nahi.
 */

export const LOOKUP_TIMEOUT_MS = 8000;

/** Provider URL — dono naam chalti hain (purana verify + naya lookup). */
export function utrLookupUrl() {
  return String(process.env.UPI_UTR_LOOKUP_URL || process.env.UPI_UTR_VERIFY_URL || '').trim();
}

export function utrLookupConfigured() {
  return Boolean(utrLookupUrl());
}

const SUCCESS_RE = /^(?:true|1|yes|y|success|successful|successful\.?|completed|complete|credited|paid|settled|received|txn[_-]?success)$/i;
const FAILED_RE = /^(?:false|0|no|n|failed|failure|declined|reversed|reversal|cancelled|canceled|expired|refunded|pending|processing)$/i;

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    // A debit/negative value must never become a positive credit after cleanup.
    const cleaned = value.trim().replace(/[₹,\s]/g, '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Thoda gehra kholo: `{data:{payment:{…}}}`, `{result:{txn:…}}` waghaira. */
function candidates(json) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.slice(0, 3).forEach((v) => walk(v, depth + 1)); return; }
    out.push(node);
    for (const key of ['data', 'result', 'payment', 'transaction', 'txn', 'transactionDetail', 'body', 'response']) {
      if (node[key] && typeof node[key] === 'object') walk(node[key], depth + 1);
    }
    if (Array.isArray(node.transactions)) walk(node.transactions[0], depth + 1);
    if (Array.isArray(node.payments)) walk(node.payments[0], depth + 1);
  };
  walk(json, 0);
  return out;
}

/**
 * Provider ka jawab → ek saaf payment record.
 * @returns {{found:boolean, reason:string, payment:object|null}}
 */
export function parseUtrLookup(json, { expectUtr = '', source = 'lookup' } = {}) {
  if (!json || typeof json !== 'object') return { found: false, reason: 'provider ne JSON nahi diya', payment: null };
  const expect = text(expectUtr).toUpperCase().replace(/[^A-Z0-9]/g, '');
  let best = null;
  for (const node of candidates(json)) {
    const utr = text(node.utr || node.UTR || node.rrn || node.refNo || node.reference || node.bankRRN || node.txnId || node.transactionId).toUpperCase().replace(/[^A-Z0-9]/g, '');
    // A lookup must return the requested reference; do not attach a generic
    // amount/status response to a UTR merely because we asked about it.
    if (expect && (!utr || utr !== expect)) continue;
    const rawAmount = node.amountPaise ?? node.amount_paise ?? node.amountInPaise ?? node.amount
      ?? node.amountRupees ?? node.transferredAmount ?? node.txnAmount ?? node.paidAmount;
    const amountNumber = money(rawAmount);
    const paidInPaise = node.amountPaise !== undefined || node.amount_paise !== undefined || node.amountInPaise !== undefined;
    let amountPaise = null;
    if (amountNumber !== null && amountNumber > 0) {
      // "1500" with amountPaise = ₹15; "15" with amount/amountRupees = ₹15.
      const paise = paidInPaise ? amountNumber : amountNumber * 100;
      if (Number.isSafeInteger(Math.round(paise)) && Math.abs(paise - Math.round(paise)) < 1e-7) amountPaise = Math.round(paise);
    }
    const statusRaw = text(node.paymentStatus || node.txnStatus || node.transactionStatus || node.status || node.state);
    const paymentFlag = node.success ?? node.isSuccess ?? node.paid;
    let status = '';
    if (FAILED_RE.test(statusRaw.trim())) status = statusRaw.trim().toUpperCase();
    else if (SUCCESS_RE.test(statusRaw.trim())) status = 'SUCCESS';
    else if (!statusRaw.trim() && typeof paymentFlag === 'boolean') status = paymentFlag ? 'SUCCESS' : 'FAILED';
    // Amount alone is not proof that the transaction succeeded. A provider
    // without a clear status must stay pending for admin review.
    const payeeName = text(node.payeeName || node.payee_name || node.payee || node.beneficiary || node.beneficiaryName || node.receiverName || node.creditedTo || node.to);
    const payeeVpa = text(node.payeeVpa || node.payee_vpa || node.vpa || node.toVpa || node.creditedVpa || node.beneficiaryVpa);
    const payerName = text(node.payerName || node.payer || node.remitterName || node.senderName || node.from);
    const payerVpa = text(node.payerVpa || node.payer_vpa || node.fromVpa || node.remitterVpa || node.senderVpa || node.debitedFromVpa);
    const at = text(node.paidAt || node.at || node.timestamp || node.txnTime || node.transactionTime || node.date);
    const atMs = Date.parse(at) || 0;
    const candidate = {
      utr: utr || expect,
      amountPaise: amountPaise || 0,
      payeeName,
      payeeVpa,
      payerName,
      payerVpa,
      status: status || 'UNKNOWN',
      at: atMs || 0,
      ref: text(node.ref || node.reference || node.rrn || node.providerRef || node.transactionId || node.txnId).slice(0, 60),
      source
    };
    // Sabse kaam ka record: amount + success wala.
    if (!best || (candidate.amountPaise > 0 ? 2 : 0) + (candidate.status === 'SUCCESS' ? 1 : 0) >
      (best.amountPaise > 0 ? 2 : 0) + (best.status === 'SUCCESS' ? 1 : 0)) best = candidate;
  }
  if (!best) {
    const msg = text(json.message || json.error || json.reason || json.detail);
    return { found: false, reason: msg ? `provider: ${msg.slice(0, 140)}` : 'is UTR ka payment provider ke paas nahi mila', payment: null };
  }
  if (!best.amountPaise) {
    return { found: false, reason: 'provider ne amount nahi diya — bina amount ke credit nahi hota', payment: best };
  }
  return { found: true, reason: '', payment: best };
}

/**
 * UTR ki asli payment details fetch karo.
 * POST pehle (JSON), phir GET fallback — jo chal jaye.
 */
export async function fetchUtrPaymentDetails(utr, {
  fetchImpl = globalThis.fetch, timeoutMs = LOOKUP_TIMEOUT_MS, url = '', userId = ''
} = {}) {
  const target = String(url || utrLookupUrl()).trim();
  const cleanUtr = text(utr).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleanUtr) return { configured: Boolean(target), found: false, payment: null, reason: 'UTR khaali hai', tried: [] };
  if (!target) {
    return {
      configured: false, found: false, payment: null, tried: [],
      reason: 'koi UTR payment provider set nahi hai (UPI_UTR_LOOKUP_URL / UPI_UTR_VERIFY_URL)'
    };
  }
  if (typeof fetchImpl !== 'function') return { configured: true, found: false, payment: null, reason: 'network layer missing', tried: [] };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.UPI_UTR_VERIFY_TOKEN) headers.Authorization = `Bearer ${process.env.UPI_UTR_VERIFY_TOKEN}`;
  const tried = [];
  const attempts = [
    {
      name: 'POST',
      run: () => fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify({ utr: cleanUtr, userId: String(userId || '') }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    },
    {
      name: 'GET',
      run: () => fetchImpl(`${target}${target.includes('?') ? '&' : '?'}utr=${encodeURIComponent(cleanUtr)}`, {
        method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs)
      })
    }
  ];
  let lastReason = '';
  for (const attempt of attempts) {
    tried.push(attempt.name);
    try {
      const res = await attempt.run();
      if (!res || typeof res !== 'object') { lastReason = `${attempt.name}: koi jawab nahi`; continue; }
      if (res.status === 404 || res.status === 405 || res.status === 501) { lastReason = `${attempt.name}: HTTP ${res.status}`; continue; }
      const json = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
      if (!json) { lastReason = `${attempt.name}: JSON nahi mila`; continue; }
      if (!res.ok) {
        const msg = text(json.message || json.error || json.reason);
        lastReason = `${attempt.name}: HTTP ${res.status}${msg ? ` — ${msg.slice(0, 100)}` : ''}`;
        continue;
      }
      const parsed = parseUtrLookup(json, { expectUtr: cleanUtr });
      if (parsed.found) return { configured: true, found: true, payment: parsed.payment, reason: '', tried, raw: json };
      lastReason = `${attempt.name}: ${parsed.reason}`;
      // Provider ne saaf kaha "nahi mila" — dobara doosre method se poochhna bekaar nahi, par
      // reason yaad rakhte hain.
    } catch (err) {
      lastReason = `${attempt.name}: ${String(err?.message || err).slice(0, 120)}`;
    }
  }
  return { configured: true, found: false, payment: null, reason: lastReason || 'provider se payment details nahi mili', tried };
}

/** App/claim message ke liye ek line. */
export function describeLookup(result, { utr = '' } = {}) {
  if (!result) return '';
  if (result.found) {
    return `UTR ${utr} ki payment mil gayi — ₹${(result.payment.amountPaise / 100).toFixed(2)} aaya` +
      `${result.payment.payeeName || result.payment.payeeVpa ? ` (${result.payment.payeeName || result.payment.payeeVpa})` : ''}.`;
  }
  if (!result.configured) return 'Abhi UTR se payment details fetch set nahi hai — UTR verify ke liye rakha gaya hai.';
  return `UTR ${utr} ki payment nahi mili — ${result.reason}`;
}
