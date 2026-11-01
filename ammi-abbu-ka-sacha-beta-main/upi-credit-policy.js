/**
 * Boss (31-10-2026, round 20):
 *   "JAB CHOTA AMOUNT DAAL KAR RANDOM KOI BHI UTR DAALTA WO ADD HO JATA ...
 *    AISA KARNA CHAHIE KI UTR PAR JITNA AMOUNT JAYE AGAR WO MISBAHUL ISLAM HO
 *    UTNA ADD HOJAYE"
 *
 * Yani: credit ka faisla **user ke claim se nahi**, asli paisa aane ke sabooot se
 * hoga —
 *   • UTR ka payment record hona chahiye (bank/UPI statement ya provider API)
 *   • paisa **Misbahul Islam** ke account me aaya ho (naam ya VPA match)
 *   • payment SUCCESS ho (failed/pending/reversal nahi)
 *   • jitna paisa aaya, utna hi judega — kam bhi nahi, zyada bhi nahi
 *   • ek UTR ek hi baar (global ledger)
 *
 * Sabooot na ho to credit **nahi** hota — claim PENDING rehta hai (boss ke paas).
 * Ye module pure hai: koi DB/network nahi, isliye har case test hota hai.
 */

/** Boss ka asli payee (naam + UPI). Env se badla ja sakta hai. */
export const DEFAULT_PAYEE = Object.freeze({ name: 'MISBAHUL ISLAM', vpa: 'mius@ybl' });

export const CREDIT_ACTIONS = Object.freeze({ CREDIT: 'CREDIT', PENDING: 'PENDING', REJECT: 'REJECT' });

const SUCCESS_WORDS = new Set(['SUCCESS', 'SUCCESSFUL', 'CREDITED', 'COMPLETED', 'PAID', 'SETTLED', 'RECEIVED']);
const FAILED_WORDS = new Set(['FAILED', 'FAILURE', 'PENDING', 'REVERSED', 'REVERSAL', 'DECLINED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REFUNDED']);

/** Naam ko compare karne layak banao: sirf a-z, ek space. */
export function normalizePersonName(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Misbahul Islam ke naam ki common spelling variations. */
const PAYEE_ALIASES = [
  'MISBAHUL ISLAM', 'MISBAHULISLAM', 'MISBAH UL ISLAM', 'MD MISBAHUL ISLAM',
  'MOHAMMAD MISBAHUL ISLAM', 'MOHAMMED MISBAHUL ISLAM', 'MISBAHUL', 'MISBAHUL ISLAM KHAN'
];

export function configuredPayeeName() {
  const env = String(process.env.UPI_PAYEE_NAME || '').trim();
  return env || DEFAULT_PAYEE.name;
}

export function configuredPayeeVpas() {
  const env = String(process.env.UPI_PAYEE_VPA || '').trim();
  const list = [DEFAULT_PAYEE.vpa, 'mius@ybl'];
  if (env) list.push(env);
  return [...new Set(list.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
}

/**
 * Payee Misbahul Islam hai ya nahi.
 * Naam ke tokens match karo (spelling ka farq chalta hai), ya VPA exact ho.
 */
export function isBossPayee({ name = '', vpa = '', allowedVpas = [] } = {}) {
  const vpaNorm = String(vpa || '').trim().toLowerCase();
  const allowed = [...configuredPayeeVpas(), ...allowedVpas.map(value => String(value || '').trim().toLowerCase())];
  if (vpaNorm) {
    // A supplied VPA is stronger evidence than a display name. Never let a
    // matching name override a contradictory recipient VPA.
    return allowed.includes(vpaNorm)
      ? { ok: true, by: 'vpa', reason: `payment boss ke UPI (${vpaNorm}) par aayi` }
      : { ok: false, by: '', reason: `payment kisi aur UPI (${vpaNorm}) par gayi` };
  }
  const normalized = normalizePersonName(name);
  if (!normalized) return { ok: false, by: '', reason: 'payment me payee ka naam nahi mila' };
  const target = normalizePersonName(configuredPayeeName());
  const aliases = [target, ...PAYEE_ALIASES].map(normalizePersonName);
  const compact = normalized.replace(/\s+/g, '');
  for (const alias of aliases) {
    if (!alias) continue;
    if (normalized === alias) return { ok: true, by: 'name', reason: `payee "${normalized}" boss ka naam hai` };
    const aliasCompact = alias.replace(/\s+/g, '');
    if (compact === aliasCompact) return { ok: true, by: 'name', reason: `payee "${normalized}" boss ka naam hai` };
    // Token match: "MR MISBAHUL ISLAM" / "MISBAHUL I" jaisa bhi chal jaye,
    // par dono naam ke asli words hone chahiye.
    const tokens = normalized.split(' ');
    const aliasTokens = alias.split(' ');
    if (aliasTokens.length >= 2 && aliasTokens.every((t) => tokens.includes(t))) {
      return { ok: true, by: 'name', reason: `payee "${normalized}" boss ka naam hai` };
    }
  }
  return { ok: false, by: '', reason: `payee "${normalized}" boss (${configuredPayeeName()}) nahi hai` };
}

/** Provider/statement ka status sach me success hai? */
export function paymentStatusOk(status) {
  const s = String(status || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return { ok: false, reason: 'payment ka status nahi mila' };
  if (FAILED_WORDS.has(s)) return { ok: false, reason: `payment ka status ${s} hai` };
  if (SUCCESS_WORDS.has(s)) return { ok: true, reason: '' };
  // Do not treat e.g. UNSUCCESSFUL as success just because it contains SUCCESS.
  if (['TXNSUCCESS', 'TRANSACTIONSUCCESS', 'PAYMENTSUCCESS'].includes(s)) return { ok: true, reason: '' };
  return { ok: false, reason: `payment ka status ${s} samajh nahi aaya` };
}

function normalizeUtr(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function toPaise(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Credit ka faisla.
 *
 * @param {object} args
 * @param {{utr:string, claimedPaise:number, userId:string}} args.claim
 * @param {{amountPaise:number, createdAt?:number}} [args.intent]
 * @param {{utr:string, amountPaise:number, payeeName?:string, payeeVpa?:string, status?:string, at?:number, source?:string, ref?:string}} [args.payment]
 * @param {object|Map} [args.usedUtrs]  ledger (config.usedUtrs)
 * @param {number} [args.autoMaxPaise]  is amount tak hi verified credit (0 = no cap)
 * @returns {{action:'CREDIT'|'PENDING'|'REJECT', code:string, creditedPaise:number, reason:string, reasons:string[], verifiedBy:string, payment:object|null}}
 */
export function evaluateUtrCredit({
  claim = {}, intent = null, payment = null, usedUtrs = {}, autoMaxPaise = 0, now = Date.now(), allowedPayeeVpas = []
} = {}) {
  const reasons = [];
  const utr = normalizeUtr(claim.utr);
  const claimPaise = toPaise(claim.claimedPaise);
  const deny = (code, reason) => ({
    action: CREDIT_ACTIONS.REJECT, code, creditedPaise: 0, reason,
    reasons: reasons.concat(reason), verifiedBy: '', payment: payment || null
  });
  const hold = (code, reason) => ({
    action: CREDIT_ACTIONS.PENDING, code, creditedPaise: 0, reason,
    reasons: reasons.concat(reason), verifiedBy: '', payment: payment || null
  });

  if (!utr) return deny('UTR_REQUIRED', 'UTR ke bina credit nahi hota');

  // 1. Ek UTR, ek credit — poore system me.
  const ledger = usedUtrs instanceof Map
    ? usedUtrs
    : new Map(Object.entries(usedUtrs && typeof usedUtrs === 'object' ? usedUtrs : {}).map(([k, v]) => [normalizeUtr(k), v]));
  const already = ledger.get(utr);
  if (already) {
    return deny('UTR_ALREADY_USED', `ye UTR pehle use ho chuka hai (${String(already?.userId || already?.user || 'kisi aur')} ke hisaab me) — ek UTR sirf ek baar`);
  }

  // 2. Sabooot hi nahi → credit bilkul nahi (random UTR yahin rukta hai).
  if (!payment || typeof payment !== 'object') {
    return hold('UTR_NOT_VERIFIED', 'is UTR ka paisa bank/UPI statement me nahi mila — verify hone tak balance nahi judega');
  }

  const paymentUtr = normalizeUtr(payment.utr);
  if (!paymentUtr) return hold('UTR_NOT_RETURNED', 'payment ka UTR nahi mila — admin check karega');
  if (paymentUtr !== utr) {
    return deny('UTR_MISMATCH', 'statement ka UTR aapke UTR se match nahi karta');
  }

  // 3. Payment sach me safal hona chahiye.
  const status = paymentStatusOk(payment.status);
  if (!status.ok) {
    reasons.push(status.reason);
    const statusWord = String(payment.status || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!statusWord || statusWord === 'PENDING' || !FAILED_WORDS.has(statusWord)) {
      return hold('PAYMENT_STATUS_UNAVAILABLE', status.reason);
    }
    return deny('PAYMENT_NOT_SUCCESSFUL', status.reason);
  }

  // Missing details are not proof of a bad payment: send them for review.
  const payeeName = payment.payeeName || payment.name || '';
  const payeeVpa = payment.payeeVpa || payment.vpa || '';
  if (!String(payeeName).trim() && !String(payeeVpa).trim()) {
    return hold('PAYEE_NOT_RETURNED', 'payment ka payee nahi mila — admin check karega');
  }
  const payee = isBossPayee({ name: payeeName, vpa: payeeVpa, allowedVpas: allowedPayeeVpas });
  if (!payee.ok) {
    reasons.push(payee.reason);
    return deny('PAYEE_MISMATCH', payee.reason);
  }

  // 5. Amount sach me kitna aaya — wahi judega.
  const receivedPaise = toPaise(payment.amountPaise ?? payment.amountReceivedPaise ?? payment.amount);
  if (!receivedPaise) {
    return hold('AMOUNT_NOT_RETURNED', 'payment me amount nahi mila — admin check karega');
  }
  if (receivedPaise < 100) {
    return deny('AMOUNT_TOO_LOW', `sirf ₹${(receivedPaise / 100).toFixed(2)} aaye hain — ₹1 se kam credit nahi hota`);
  }

  // 6. Payment top-up QR banne se pehle ka ho to wo is top-up ke liye nahi hai.
  if (intent?.createdAt && payment.at) {
    const intentAt = Number(intent.createdAt);
    const paidAt = Number(payment.at);
    if (Number.isFinite(intentAt) && Number.isFinite(paidAt) && paidAt < intentAt - 10 * 60_000) {
      return hold('PAYMENT_BEFORE_INTENT', 'ye payment top-up QR banne se pehle ka hai — naya QR bana kar paisa bhejein');
    }
  }

  // 7. Verified. Credit = asli aaya hua amount (claim amount nahi).
  let creditedPaise = receivedPaise;
  const note = [];
  if (intent && toPaise(intent.amountPaise) && receivedPaise > toPaise(intent.amountPaise)) {
    note.push(`₹${(receivedPaise / 100).toFixed(2)} aaye, top-up ₹${(toPaise(intent.amountPaise) / 100).toFixed(2)} ka tha — poora asli paisa juda`);
  }
  if (intent && toPaise(intent.amountPaise) && receivedPaise < toPaise(intent.amountPaise)) {
    note.push(`top-up ₹${(toPaise(intent.amountPaise) / 100).toFixed(2)} ka tha par aaye ₹${(receivedPaise / 100).toFixed(2)} — utna hi juda`);
  }
  if (claimPaise && claimPaise !== receivedPaise) {
    note.push('claim ka amount nahi, bank ka asli amount juda');
  }
  // Verified hone ke baad bhi bada amount boss ki nazar se nahi bachta.
  if (autoMaxPaise > 0 && creditedPaise > autoMaxPaise) {
    return hold('NEEDS_BOSS_APPROVAL',
      `₹${(receivedPaise / 100).toFixed(2)} aaye hain — ₹${(autoMaxPaise / 100).toFixed(2)} se zyada, isliye boss approve karega (paisa aaya hua hai, claim safe hai)`);
  }

  return {
    action: CREDIT_ACTIONS.CREDIT,
    code: 'CREDIT_VERIFIED',
    creditedPaise,
    reason: [
      `UTR ${utr} verified — ${payee.reason}`,
      `aaye ₹${(receivedPaise / 100).toFixed(2)}`,
      ...note
    ].join(' · '),
    reasons: [],
    verifiedBy: String(payment.source || payment.verifiedBy || 'statement'),
    overpaidPaise: intent && toPaise(intent.amountPaise) ? Math.max(0, receivedPaise - toPaise(intent.amountPaise)) : 0,
    payment: payment || null
  };
}

/**
 * Statement / SMS text se payment entries nikaalo.
 * Har line me UTR + amount + (naam). Debit/failed lines chhod do.
 */
export function parseStatementText(text, { at = Date.now() } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (line.length < 10) continue;
    // Debit/failed/reversal line kabhi credit nahi.
    if (/\b(debit|dr|debited|withdraw|withdrawn|failed|failure|reversed|reversal|refund|cancelled|canceled)\b/i.test(line)) continue;
    const utrMatch = line.match(/\b(\d{12})\b/) || line.match(/\b([A-Z]{2,6}\d{9,20})\b/);
    if (!utrMatch) continue;
    const utr = normalizeUtr(utrMatch[1]);
    if (seen.has(utr)) continue;
    const amountMatch = line.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i) || line.match(/([\d,]+\.\d{2})\s*(?:rs|inr)?/i);
    if (!amountMatch) continue;
    const rupees = Number(String(amountMatch[1]).replace(/,/g, ''));
    if (!Number.isFinite(rupees) || rupees <= 0) continue;
    const nameGuess = line.match(/(?:from|by|payer|sender|remitter)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,40})/i)
      || line.match(/\b(MISBAHUL(?:\s+[A-Z]+){0,3})\b/i)
      // Statement format: `UPI/CR/<utr>/<NAAM>/₹15.00`
      || line.match(new RegExp(`${utrMatch[1]}\\s*[\\/|]\\s*([A-Za-z][A-Za-z .]{2,40})`, 'i'))
      // `UPI/CR/…/<NAAM>` jahan naam UTR ke baad kisi bhi jagah ho.
      || line.match(/\bUPI\/(?:CR|CREDIT)\/[^A-Za-z]*([A-Za-z][A-Za-z .]{2,40})/i);
    seen.add(utr);
    out.push({
      utr,
      amountPaise: Math.round(rupees * 100),
      payeeName: nameGuess ? String(nameGuess[1]).trim().slice(0, 60) : '',
      payeeVpa: (line.match(/\b[a-z0-9.\-_]{2,}@[a-z]{2,}\b/i) || [])[0] || '',
      status: 'SUCCESS',
      at,
      source: 'statement',
      raw: line.slice(0, 200)
    });
  }
  return out;
}

/** User ko dikhane ke liye ek line — sach, dhamki nahi. */
export function describeCreditDecision(decision) {
  if (!decision) return '';
  if (decision.action === CREDIT_ACTIONS.CREDIT) return `₹${(decision.creditedPaise / 100).toFixed(2)} jud gaya — ${decision.reason}`;
  if (decision.action === CREDIT_ACTIONS.PENDING) return `Verify hone tak balance nahi judega — ${decision.reason}`;
  return `Credit nahi hua — ${decision.reason}`;
}
