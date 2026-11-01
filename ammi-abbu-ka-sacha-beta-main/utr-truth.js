/**
 * Boss (31-10-2026, round 25):
 *   "UPI PAYMENT AGAR ME TRACK KARNA CHAHTA ... BAS USSE UTR LUNGA AUR UTR SE
 *    SAB DETAILS NIKAALUNGA — ISNE PAY KIA ABHI YA OLD, YA KISI AUR KO, AUR
 *    KITNA"
 *
 * Yani user ka amount/claim nahi — sirf **UTR**. Us UTR se poori kahani:
 *   • kitna aaya (aur user ne kitna bola tha — dono)
 *   • kab aaya (abhi abhi / aaj / purana) — payment ki asli timestamp se
 *   • kisko aaya (Misbahul Islam / kisi aur ko) — naam + VPA dono se
 *   • kaun bhejne wala (payer ka naam/VPA, jahan provider de)
 *   • status sach me SUCCESS hai ya pending/failed
 *   • ye UTR pehle use ho chuka hai ya nahi (kis ke hisaab me)
 *   • credit hoga / PENDING rahega / reject — aur **kya kya chahiye** us faisle ke liye
 *
 * Faisla khud nahi karta — wahi `evaluateUtrCredit` (round 20 ki policy) chalati
 * hai, taaki do jagah do niyam na ho. Ye module sirf **sach ko padhne layak**
 * banata hai (pure: koi DB/network nahi, isliye har case test hota hai).
 */
import { evaluateUtrCredit, isBossPayee, paymentStatusOk, configuredPayeeName, configuredPayeeVpas } from './upi-credit-policy.js';

export const FRESHNESS = Object.freeze({
  JUST_NOW: 'JUST_NOW',
  RECENT: 'RECENT',
  TODAY: 'TODAY',
  DAYS: 'DAYS',
  OLD: 'OLD',
  UNKNOWN: 'UNKNOWN'
});

/** ₹ text — 1 paisa bhi chhupta nahi. */
export function moneyText(paise) {
  const value = Number(paise) || 0;
  if (!value) return '₹0';
  return `₹${(value / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function minutesText(mins) {
  const raw = Math.max(0, Number(mins) || 0);
  if (raw < 1) return 'abhi abhi';
  const m = Math.round(raw);
  if (m < 60) return `${m} min pehle`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} ghante pehle`;
  const days = Math.round(hours / 24);
  return `${days} din pehle`;
}

/** Payment ki asli timing — "abhi ya old" ka seedha jawab. */
export function describeWhen(atMs, { now = Date.now() } = {}) {
  const at = Number(atMs) || 0;
  if (!at) {
    return {
      at: 0, iso: '', ageMinutes: null, freshness: FRESHNESS.UNKNOWN,
      line: 'payment kab hui — provider ne time nahi diya'
    };
  }
  const ageMinutes = Math.max(0, (now - at) / 60000);
  let freshness = FRESHNESS.JUST_NOW;
  if (ageMinutes > 7 * 24 * 60) freshness = FRESHNESS.OLD;
  else if (ageMinutes > 24 * 60) freshness = FRESHNESS.DAYS;
  else if (ageMinutes > 60) freshness = FRESHNESS.TODAY;
  else if (ageMinutes > 5) freshness = FRESHNESS.RECENT;
  const iso = new Date(at).toISOString();
  const when = at > now + 5 * 60_000 ? 'time future ka hai (ghadiyaan alag ho sakti hain)' : `${minutesText(ageMinutes)} (${new Date(at).toLocaleString('en-IN')})`;
  return { at, iso, ageMinutes: Math.round(ageMinutes), freshness, line: when };
}

/** Payee — paisa humein aaya ya kisi aur ko. */
export function describePayee(payment = {}, { allowedPayeeVpas = [] } = {}) {
  const name = String(payment.payeeName || '').trim();
  const vpa = String(payment.payeeVpa || '').trim();
  const ours = isBossPayee({ name, vpa, allowedVpas: allowedPayeeVpas });
  const target = `${name || vpa || 'payee ka naam nahi mila'}${vpa && name ? ` (${vpa})` : ''}`;
  return {
    name, vpa, isOurs: ours.ok, matchedBy: ours.by || '',
    line: ours.ok
      ? `paisa humein aaya — ${target}`
      : (name || vpa)
        ? `paisa kisi AUR ko gaya — ${target} (humein nahi mila)`
        : 'payee ka naam/VPA provider ne nahi diya — pata nahi kisko gaya',
    expected: { name: configuredPayeeName(), vpas: configuredPayeeVpas() }
  };
}

/** Payer (jisne bheja) — provider de to. */
export function describePayer(payment = {}) {
  const name = String(payment.payerName || '').trim();
  const vpa = String(payment.payerVpa || '').trim();
  return {
    name, vpa,
    line: name || vpa ? `bhejne wala: ${name || vpa}${vpa && name ? ` (${vpa})` : ''}` : 'bhejne wale ka naam provider ne nahi diya'
  };
}

function statusLabel(status) {
  const ok = paymentStatusOk(status);
  if (ok.ok) return { ok: true, line: `payment SUCCESS (${String(status || '').toUpperCase()})` };
  const raw = String(status || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (raw === 'PENDING' || raw === 'PROCESSING' || raw === 'INITIATED') {
    return { ok: false, line: `payment abhi ${raw} hai — paisa pahuncha nahi, credit tab hoga jab SUCCESS ho` };
  }
  if (!raw) return { ok: false, line: 'payment ka status nahi mila' };
  return { ok: false, line: `payment ${raw} hai — credit nahi hota` };
}

/**
 * UTR ki poori sachchai.
 * @param {{utr?:string, payment?:object|null, lookup?:object|null, usedUtr?:object|null,
 *          intent?:object|null, claimedPaise?:number, now?:number, autoMaxPaise?:number}} input
 */
export function describeUtrPayment({
  utr = '', payment = null, lookup = null, usedUtr = null, intent = null,
  claimedPaise = 0, now = Date.now(), autoMaxPaise = 0, allowedPayeeVpas = []
} = {}) {
  const cleanUtr = String(utr || payment?.utr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const paidPaise = Math.max(0, Math.round(Number(payment?.amountPaise) || 0));
  const askedPaise = Math.max(0, Math.round(Number(claimedPaise || intent?.amountPaise) || 0));
  const when = describeWhen(payment?.at, { now });
  const payee = describePayee(payment || {}, { allowedPayeeVpas });
  const payer = describePayer(payment || {});
  const status = statusLabel(payment?.status);
  const duplicate = usedUtr
    ? {
      used: true,
      by: String(usedUtr.userId || usedUtr.user || ''),
      at: String(usedUtr.at || ''),
      status: String(usedUtr.status || ''),
      line: `ye UTR pehle use ho chuka hai${usedUtr.userId ? ` (user ${usedUtr.userId})` : ''}${usedUtr.at ? ` — ${String(usedUtr.at).slice(0, 16).replace('T', ' ')}` : ''}`
    }
    : { used: false, by: '', at: '', status: '', line: 'ye UTR pehle use nahi hua' };

  const decision = evaluateUtrCredit({
    claim: { utr: cleanUtr, claimedPaise: askedPaise || paidPaise, userId: usedUtr?.userId || '' },
    intent: intent || null,
    payment,
    usedUtrs: usedUtr && cleanUtr ? { [cleanUtr]: usedUtr } : {},
    autoMaxPaise: Math.max(0, Math.round(Number(autoMaxPaise) || 0)),
    allowedPayeeVpas,
    now
  });

  // Faisle ke liye kya kya chahiye — jo provider ne nahi diya, wo saaf likho.
  const missing = [];
  if (!cleanUtr) missing.push({ key: 'utr', line: 'UTR hi nahi mila' });
  if (!payment) missing.push({ key: 'payment', line: 'provider se payment record nahi mila — UTR dobara check karein ya bank statement upload karein' });
  if (payment && !paidPaise) missing.push({ key: 'amount', line: 'amount nahi mila — bina amount ke credit nahi hota' });
  if (payment && !(payee.name || payee.vpa)) missing.push({ key: 'payee', line: 'payee ka naam/VPA nahi mila — pata nahi paisa humein aaya ya kisi aur ko' });
  if (payment && !when.at) missing.push({ key: 'time', line: 'payment ka time nahi mila — "abhi ya old" ka jawab nahi de sakte' });
  if (payment && !payer.name && !payer.vpa) missing.push({ key: 'payer', line: 'bhejne wale ka naam/VPA nahi mila — kaun bheja ye pata nahi' });
  if (!lookup?.configured) missing.push({ key: 'provider', line: 'UTR payment provider set nahi hai (UPI_UTR_LOOKUP_URL) — details khud fetch nahi ho sakti' });

  const checklist = [
    { key: 'utr', label: 'UTR', ok: Boolean(cleanUtr), value: cleanUtr || '—' },
    { key: 'found', label: 'Payment mila', ok: Boolean(payment), value: payment ? 'haan' : 'nahi' },
    { key: 'amount', label: 'Kitna aaya', ok: paidPaise > 0, value: paidPaise > 0 ? moneyText(paidPaise) : '—' },
    { key: 'asked', label: 'User ne bola tha', ok: askedPaise > 0, value: askedPaise > 0 ? moneyText(askedPaise) : '—' },
    { key: 'when', label: 'Kab aaya', ok: Boolean(when.at), value: when.at ? when.line : '—' },
    { key: 'payee', label: 'Kisko aaya', ok: payee.isOurs, value: payee.line },
    { key: 'payer', label: 'Kaun bheja', ok: Boolean(payer.name || payer.vpa), value: payer.line },
    { key: 'status', label: 'Status', ok: status.ok, value: status.line },
    { key: 'duplicate', label: 'Pehle use hua', ok: !duplicate.used, value: duplicate.line }
  ];

  const verdict = {
    action: decision.action,
    code: decision.code,
    creditedPaise: Number(decision.creditedPaise) || 0,
    line: decision.action === 'CREDIT'
      ? `${moneyText(decision.creditedPaise)} judega — ${decision.reason}`
      : decision.reason
  };

  const summaryLine = [
    `UTR ${cleanUtr || '—'}:`,
    payment ? `${moneyText(paidPaise)} ${payee.isOurs ? 'humein aaya' : 'kisi ko gaya'}` : 'payment nahi mili',
    when.at ? when.line : 'time nahi mila',
    verdict.action === 'CREDIT' ? `credit ${moneyText(verdict.creditedPaise)}` : (verdict.action === 'PENDING' ? 'PENDING' : 'REJECT')
  ].join(' · ');

  const bossLine = [
    `UTR ${cleanUtr || '—'}`,
    payment ? `se ${moneyText(paidPaise)}` : 'ki payment nahi mili',
    payment ? `· ${payee.line}` : '',
    payment ? `· ${when.line}` : '',
    payment ? `· ${status.line}` : '',
    payment ? `· ${payer.line}` : '',
    `· ${verdict.line}`,
    missing.length ? `· chahiye: ${missing.map((m) => m.line).join('; ')}` : ''
  ].filter(Boolean).join(' ');

  return {
    utr: cleanUtr,
    found: Boolean(payment),
    configured: lookup?.configured !== false,
    source: String(payment?.source || ''),
    ref: String(payment?.ref || ''),
    amountPaise: paidPaise,
    amountLine: payment ? (paidPaise ? `${moneyText(paidPaise)} aaya` : 'amount nahi mila') : 'payment nahi mili',
    askedPaise,
    askedLine: askedPaise ? `user ne ${moneyText(askedPaise)} bhejne ko bola tha` : 'user ne amount nahi bataya',
    paidAt: when.iso,
    ageMinutes: when.ageMinutes,
    freshness: when.freshness,
    whenLine: when.line,
    payee, payer,
    payeeLine: payee.line,
    payerLine: payer.line,
    status: String(payment?.status || '').toUpperCase(),
    statusLine: status.line,
    duplicate,
    verdict,
    checklist,
    missing,
    summaryLine,
    bossLine
  };
}

/** App/boss card ke liye chhota row set (UI heavy object na khaye). */
export function utrTruthRows(truth) {
  if (!truth) return [];
  return (truth.checklist || []).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    ok: row.ok
  }));
}
