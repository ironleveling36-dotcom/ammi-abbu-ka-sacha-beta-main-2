/**
 * Boss (31-10-2026, round 21):
 *   "NO SMS RECEIVED AND NO TRACKING IS AVAILABLE"
 *
 * Do sawal, dono ka jawab **sirf Swiggy ke data se**:
 *   1. Tracking link mila ya nahi — aur nahi mila to kyun (kaunse route try hue).
 *   2. Recipient ke phone par Swiggy ka SMS gaya ya nahi — proof hai ya nahi.
 *
 * Ye module pure hai (koi network/DB nahi). Jhootha "SMS bhej diya" kabhi nahi
 * bolta: jahan Swiggy ne flag diya hai wahan SENT, jahan saaf mana kiya hai
 * wahan NOT_SENT, warna UNKNOWN + asli wajah.
 */

export const SMS_STATES = Object.freeze({ SENT: 'SENT', NOT_SENT: 'NOT_SENT', UNKNOWN: 'UNKNOWN' });

const SMS_KEY_RE = /(?:^|_)(?:sms|notify|notification|comms|whatsapp|message_sent|msg_sent)(?:_|$)/i;
const TRUE_RE = /^(?:true|1|yes|y|sent|success|delivered|triggered|done)$/i;
const FALSE_RE = /^(?:false|0|no|n|not_sent|failed|failure|pending|blocked|skipped|disabled)$/i;
const SENT_STATUS_RE = /(?:SMS[_-]?SENT|SENT_TO_RECIPIENT|RECIPIENT[_-]?NOTIFIED|NOTIFICATION[_-]?SENT|DELIVERED)/i;
const NOT_SENT_STATUS_RE = /(?:SMS[_-]?FAILED|SMS[_-]?NOT[_-]?SENT|NOTIFICATION[_-]?FAILED|SMS[_-]?BLOCKED|SMS[_-]?PENDING)/i;

function maskPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return '';
  return `${digits.slice(0, 2)}••••${digits.slice(-4)}`;
}

/**
 * Swiggy ke order payloads me recipient-SMS ka asli proof dhundo.
 * Sirf clearly naam wali keys dekhi jati hain (sms/notify/notification/comms),
 * aur har value ka source path bhi rakha jata hai — boss khud verify kar sake.
 */
export function scanRecipientSmsEvidence(...sources) {
  const found = [];
  const walk = (node, path, depth) => {
    if (node === null || node === undefined || depth > 8) return;
    if (typeof node === 'string') {
      if (SENT_STATUS_RE.test(node)) found.push({ state: SMS_STATES.SENT, path, value: node.slice(0, 80) });
      else if (NOT_SENT_STATUS_RE.test(node)) found.push({ state: SMS_STATES.NOT_SENT, path, value: node.slice(0, 80) });
      return;
    }
    if (typeof node === 'boolean') {
      if (SMS_KEY_RE.test(path)) found.push({ state: node ? SMS_STATES.SENT : SMS_STATES.NOT_SENT, path, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 40).forEach((value, index) => walk(value, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
        const raw = String(value);
        if (SMS_KEY_RE.test(key)) {
          if (TRUE_RE.test(raw.trim())) found.push({ state: SMS_STATES.SENT, path: keyPath, value: raw.slice(0, 80) });
          else if (FALSE_RE.test(raw.trim())) found.push({ state: SMS_STATES.NOT_SENT, path: keyPath, value: raw.slice(0, 80) });
          else if (SENT_STATUS_RE.test(raw)) found.push({ state: SMS_STATES.SENT, path: keyPath, value: raw.slice(0, 80) });
          else if (NOT_SENT_STATUS_RE.test(raw)) found.push({ state: SMS_STATES.NOT_SENT, path: keyPath, value: raw.slice(0, 80) });
        } else if (typeof value === 'string' && (SENT_STATUS_RE.test(value) || NOT_SENT_STATUS_RE.test(value))) {
          found.push({ state: SENT_STATUS_RE.test(value) ? SMS_STATES.SENT : SMS_STATES.NOT_SENT, path: keyPath, value: value.slice(0, 80) });
        }
      } else {
        walk(value, keyPath, depth + 1);
      }
    }
  };
  for (const source of sources) walk(source, '', 0);
  // SENT ka proof NOT_SENT se upar — Swiggy kai jagah same baat do baar likhta hai.
  const sent = found.find((f) => f.state === SMS_STATES.SENT);
  if (sent) return { state: SMS_STATES.SENT, evidence: `${sent.path} = ${sent.value}`, all: found.slice(0, 5) };
  const notSent = found.find((f) => f.state === SMS_STATES.NOT_SENT);
  if (notSent) return { state: SMS_STATES.NOT_SENT, evidence: `${notSent.path} = ${notSent.value}`, all: found.slice(0, 5) };
  return { state: SMS_STATES.UNKNOWN, evidence: '', all: [] };
}

/**
 * SMS ka poora sach — proof + asli wajah. `receiverPhone` wo number hai jo
 * Swiggy ko delivery ke liye diya gaya (order ka, account ka nahi).
 */
export function describeSmsTruth({
  sms = null,
  receiverPhone = '',
  accountPhone = '',
  ofoRequested = false,
  ofoConfirmed = false,
  orderStatus = ''
} = {}) {
  const receiverMasked = maskPhone(receiverPhone);
  const accountMasked = maskPhone(accountPhone);
  const samePhone = Boolean(receiverMasked && accountMasked && receiverMasked === accountMasked);
  const state = sms?.state || SMS_STATES.UNKNOWN;
  const evidence = String(sms?.evidence || '');
  const base = { state, receiverMasked, accountMasked, samePhone, ofoRequested: ofoRequested === true, ofoConfirmed: ofoConfirmed === true };

  if (state === SMS_STATES.SENT) {
    return {
      ...base,
      line: `Swiggy ne recipient SMS bhej diya — proof: ${evidence}${receiverMasked ? ` (number ${receiverMasked})` : ''}.`,
      advice: 'SMS na dikhe to phone ka spam/promotion folder dekhein — Swiggy ka SMS wahan ja sakta hai.'
    };
  }
  if (state === SMS_STATES.NOT_SENT) {
    return {
      ...base,
      line: `Swiggy ke data me SMS nahi gaya likha hai — proof: ${evidence}.`,
      advice: samePhone
        ? `Receiver ka number (${receiverMasked}) account ka hi number hai — is haalat me Swiggy alag SMS nahi bhejta. Tracking isi app me hai.`
        : 'Tracking app ke andar hi dikhega — SMS par depend na karein. Chahiye to boss Swiggy app se dobara bhejwa sakte hain.'
    };
  }

  // UNKNOWN — jhooth nahi. Asli wajah batao.
  let line;
  let advice;
  if (!receiverMasked) {
    line = 'Swiggy ne is order ke receiver ka number hi wapas nahi diya — isliye SMS ka koi proof nahi hai.';
    advice = 'Address confirm karke dobara bill banayein; receiver ka number diya bina order jaata hai to SMS bhi nahi ja sakta.';
  } else if (samePhone) {
    line = `Receiver ka number (${receiverMasked}) isi account ka hai — Swiggy is haalat me alag recipient SMS nahi bhejta (OTP/sms account wale phone par hi jaata hai).`;
    advice = 'Tracking app ke andar Refresh se dekhein — SMS ka intezaar na karein.';
  } else if (!ofoRequested) {
    line = `Ye order "someone else" ke roop me nahi gaya (receiver ${receiverMasked}), isliye Swiggy recipient SMS ka wada nahi karta.`;
    advice = 'Agli baar "Order for someone else" chalu rakhein — tab Swiggy receiver ko SMS bhejta hai.';
  } else if (!ofoConfirmed) {
    line = `OFO fields bheje gaye the par Swiggy ne place-response me OFO confirm nahi kiya — SMS/Swiggy ka link isi wajah se nahi aaya ho sakta.`;
    advice = 'Tracking app ke andar se lo; SMS Swiggy ke bharose hai, hum uska jhootha dawa nahi karte.';
  } else {
    line = `OFO confirm hua tha (receiver ${receiverMasked}) par Swiggy ne SMS ka koi flag nahi diya — SMS gaya ya nahi, Swiggy ke data me likha hi nahi hai.`;
    advice = 'Tracking link app me hi hai — usi se status dekhein. SMS ke liye boss Swiggy app se check kar sakta hai.';
  }
  return { ...base, line, advice };
}

/**
 * Tracking ka sach — link mila ya nahi, kis route se, aur nahi mila to kya try hua.
 */
export function describeTrackingTruth({ trackingUrl = '', via = '', tried = [], orderStatus = '', restricted = false, attempts = 0 } = {}) {
  const link = /^https:\/\//i.test(String(trackingUrl || '')) ? String(trackingUrl) : '';
  if (link) {
    const how = via === 'WEB_PAGE_SHARE'
      ? 'Swiggy ke order page se'
      : via === 'ORDER_DETAILS'
        ? 'Swiggy order/details se'
        : via === 'FYI_CTA'
          ? 'Swiggy trackV4 ke cta_link se'
          : via === 'SHARE_DEEP'
            ? 'Swiggy response ke share field se'
            : via === 'CHECKOUT'
              ? 'payment confirm ke waqt'
              : 'Swiggy se';
    return {
      ok: true,
      line: `Tracking link mil gaya (${how})${attempts > 1 ? ` · ${attempts} try` : ''}.`,
      link,
      // `reason` app me note ki jagah dikhta hai — link milne par bhi kuch
      // honest likhna chahiye, khaali nahi.
      reason: `Tracking link mil gaya (${how}).`
    };
  }
  const triedList = (tried || []).filter(Boolean).slice(0, 4);
  const why = triedList.length
    ? `Swiggy ne ${triedList.join(', ')} me koi tracking link nahi diya`
    : 'Swiggy ne abhi tak koi tracking link nahi diya';
  const status = String(orderStatus || '').trim();
  return {
    ok: false,
    line: `${why}${status ? ` (order status: ${status})` : ''}.`,
    link: '',
    reason: restricted
      ? 'Link na aane par bhi status yahan refresh se aata rahega — OTP/address sirf operator ke paas hai.'
      : 'Thodi der me phir Refresh karein — Swiggy payment ke 1-2 second baad link deta hai, aur restaurant accept karne par pakka deta hai.'
  };
}

/** App/order card ke liye ek hi jagah poora sach. */
export function buildOrderTruthReport({ tracking = null, sms = null, receiverPhone = '', accountPhone = '', ofoRequested = false, ofoConfirmed = false, orderStatus = '', restricted = false, via = '', tried = [], attempts = 0 } = {}) {
  const trackingTruth = describeTrackingTruth({
    trackingUrl: tracking?.trackingUrl || '', via: via || tracking?.via || '', tried, orderStatus, restricted, attempts
  });
  const smsTruth = describeSmsTruth({ sms: sms || tracking?.sms || null, receiverPhone, accountPhone, ofoRequested, ofoConfirmed, orderStatus });
  return { tracking: trackingTruth, sms: smsTruth };
}
