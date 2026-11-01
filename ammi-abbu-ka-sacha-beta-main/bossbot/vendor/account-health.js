/**
 * account-health.js — "Swiggy ID suspend ho gayi to kya hoga?"
 *
 * Asli dikkat (Boss, 26-10-2026: "shayad account suspend ho gaya tha"):
 * Swiggy kabhi-kabhi ek ID ko block/suspend kar deta hai. Us ID ka session
 * bilkul theek dikhta hai (login, order list, cart — sab 200), par
 * **order place / payment par** Swiggy "account blocked / suspended" bolta hai.
 * Pehle bot ise aam error samajh kar wahi ID dobara-dobara try karta tha aur
 * customer ka order atak jata tha.
 *
 * Ab:
 *   1. Har failure classify hoti hai — SUSPENDED / SESSION_EXPIRED / WAF /
 *      RATE_LIMIT / TRANSIENT. Sirf asli suspension par ID quarantine hoti hai.
 *   2. Suspended ID rotation me kabhi pick nahi hoti (⛔), 6 ghante (config)
 *      ke liye, taaki user ka order turant kisi healthy ID par chala jaye.
 *   3. Quarantine khatam hone par ID ek baar phir try hoti hai (jhoothi
 *      suspension se ID hamesha ke liye band na ho).
 *   4. Session expiry ko suspension nahi kaha jata — wo alag problem hai
 *      (re-login se theek hoti hai).
 */
import { getDb, saveDb } from './store.js';

/** Default quarantine: 6 hours. Config: ACCOUNT_SUSPEND_QUARANTINE_MS. */
export const SUSPENSION_QUARANTINE_MS = Math.max(
  60_000,
  Number(process.env.ACCOUNT_SUSPEND_QUARANTINE_MS) || 6 * 60 * 60 * 1000
);

/**
 * Swiggy ke asli suspension messages. Ye patterns jaan-boojh kar tight hain:
 * "session expired" / WAF / "try again" kabhi suspension nahi hain.
 */
const SUSPENSION_PATTERNS = [
  { id: 'account-blocked', re: /\baccount\b[^.?!]{0,40}\b(?:blocked|suspended|banned|disabled|deactivated|restricted|locked)\b/i },
  { id: 'blocked-account', re: /\b(?:blocked|suspended|banned|deactivated|restricted)\b[^.?!]{0,20}\baccount\b/i },
  { id: 'cannot-place', re: /\b(?:you|your account|this account|the account)\b[^.?!]{0,30}\b(?:can ?not|can't|not allowed|not permitted|not eligible|unable)\b[^.?!]{0,20}\b(?:place|placing|order|ordering|checkout)\b/i },
  { id: 'not-allowed-to-order', re: /\bnot\s+(?:allowed|permitted|eligible)\s+to\s+(?:place|order|checkout)\b/i },
  { id: 'suspicious-activity', re: /\bsuspicious\s+(?:activity|login|behaviou?r|transaction)\b/i },
  { id: 'unusual-activity', re: /\bunusual\s+(?:activity|login)\b/i },
  { id: 'fraud-abuse', re: /\b(?:fraud|abuse|policy|terms)\b[^.?!]{0,20}\bviolation\b|\bviolat(?:ion|ed)\b[^.?!]{0,20}\b(?:policy|terms)\b/i },
  { id: 'under-review', re: /\baccount\b[^.?!]{0,25}\bunder\s+(?:review|verification due to)\b/i },
  { id: 'blacklisted', re: /\bblack ?listed\b/i },
  { id: 'ordering-blocked', re: /\b(?:ordering|orders?)\b[^.?!]{0,25}\b(?:blocked|disabled|suspended)\b/i },
  { id: 'too-many-refunds', re: /\btoo many\b[^.?!]{0,25}\b(?:refunds?|cancellations?|failed orders?)\b/i }
];

const SESSION_PATTERNS = [
  /session\s*(?:has\s*)?(?:expired|invalid|timed?\s*out)/i,
  /\blogin again\b/i,
  /\bplease\s+(?:log ?in|login|re-?login)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /\binvalid\s+(?:token|session|credentials?)\b/i,
  /\btoken\s*(?:has\s*)?expired\b/i,
  /\bjwt\b[^.?!]{0,20}\bexpired\b/i
];

const WAF_PATTERNS = [
  /\bwaf\b/i,
  /\b(?:aws)?\s*challenge\b/i,
  /\bcaptcha\b/i,
  /\bcloudflare\b/i,
  /\bbot\s*(?:detection|protection)\b/i,
  /\baccess denied\b/i,
  /\brequest blocked\b/i,
  /\bforbidden\b/i
];

const RATE_PATTERNS = [
  /\btoo many requests?\b/i,
  /\brate\s*limit/i,
  /\bslow down\b/i,
  /\bthrottl/i,
  /\btry (?:again )?(?:after|in) \d+/i
];

/**
 * Ek failure ko classify karo.
 * @returns {{kind:string, suspended:boolean, sessionDead:boolean, retryable:boolean,
 *            waf:boolean, rateLimited:boolean, reason:string, matched:string}}
 */
export function classifySwiggyAccountFailure(input = {}) {
  const message = String(input.message || '');
  const detailed = String(input.detailed || '');
  const code = String(input.code || '');
  const raw = String(input.rawText || '').slice(0, 2000);
  const httpStatus = Number(input.httpStatus || 0);
  const statusCode = input.statusCode === null || input.statusCode === undefined ? null : Number(input.statusCode);
  const haystack = `${message} ${detailed} ${code} ${raw}`.trim();

  const base = {
    kind: 'UNKNOWN',
    suspended: false,
    sessionDead: false,
    retryable: true,
    waf: false,
    rateLimited: false,
    reason: (message || detailed || code || 'Swiggy ne reason nahi bataya').slice(0, 300),
    matched: ''
  };
  if (!haystack && !statusCode && !httpStatus) return base;

  const suspension = SUSPENSION_PATTERNS.find((p) => p.re.test(haystack));
  const waf = WAF_PATTERNS.some((re) => re.test(haystack));
  const rate = RATE_PATTERNS.some((re) => re.test(haystack));
  const session = SESSION_PATTERNS.some((re) => re.test(haystack)) || statusCode === 999;

  // "Request blocked" / captcha WAF page kabhi account suspension nahi hai.
  if (waf && !suspension) {
    return { ...base, kind: 'WAF', waf: true, retryable: true, reason: base.reason, matched: 'waf' };
  }
  if (suspension) {
    return {
      ...base,
      kind: 'SUSPENDED',
      suspended: true,
      sessionDead: false,
      retryable: false,
      reason: `Swiggy account blocked/suspended — "${base.reason}"`,
      matched: suspension.id
    };
  }
  if (session) {
    return {
      ...base,
      kind: 'SESSION_EXPIRED',
      sessionDead: true,
      retryable: false,
      reason: base.reason || 'session expired',
      matched: 'session'
    };
  }
  if (rate) {
    return { ...base, kind: 'RATE_LIMIT', rateLimited: true, retryable: true, reason: base.reason, matched: 'rate-limit' };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { ...base, kind: 'SESSION_EXPIRED', sessionDead: true, retryable: false, reason: base.reason, matched: `http-${httpStatus}` };
  }
  if (httpStatus >= 500) {
    return { ...base, kind: 'TRANSIENT', retryable: true, reason: base.reason, matched: `http-${httpStatus}` };
  }
  return base;
}

/** Kya ye ID abhi suspended/quarantined hai? (quarantine khatam = phir try allowed) */
export function isAccountSuspended(acc, { now = Date.now() } = {}) {
  if (!acc || typeof acc !== 'object') return false;
  const flagged = acc.healthStatus === 'SUSPENDED'
    || acc.suspended === true
    || Boolean(acc.suspendedAt);
  if (!flagged) return false;
  const until = Date.parse(String(acc.suspendedUntil || '')) || 0;
  if (!until) return true;
  return until > now;
}

/** Human reason for the card/panel ("⛔ suspended — <reason>"). */
export function describeSuspendedAccount(acc) {
  if (!acc) return '';
  const until = Date.parse(String(acc.suspendedUntil || '')) || 0;
  const till = until ? new Date(until).toISOString().slice(0, 16).replace('T', ' ') : '';
  const reason = String(acc.suspendReason || 'Swiggy ne account block kiya').slice(0, 160);
  return `${reason}${till ? ` (retry ${till} UTC ke baad)` : ''}`;
}

function pushHealthEvent(db, event) {
  try {
    const list = Array.isArray(db.config.accountHealthEvents) ? db.config.accountHealthEvents : [];
    list.push({ at: new Date().toISOString(), ...event });
    db.config.accountHealthEvents = list.slice(-50);
  } catch {}
}

/**
 * ID ko quarantine karo — rotation me nahi aayegi, aur order dusri ID par jayega.
 * Session ko chhedte nahi: login theek hai, account hi blocked hai.
 */
export function markAccountSuspended(key, {
  reason = '',
  code = '',
  stage = '',
  orderId = '',
  httpStatus = 0,
  ttlMs = SUSPENSION_QUARANTINE_MS,
  now = Date.now()
} = {}) {
  const k = String(key || '');
  if (!k) return null;
  const db = getDb();
  const acc = db?.config?.accounts?.[k];
  if (!acc) return null;
  const wasSuspended = isAccountSuspended(acc, { now });
  acc.healthStatus = 'SUSPENDED';
  acc.suspended = true;
  acc.suspendedAt = acc.suspendedAt && wasSuspended ? acc.suspendedAt : new Date(now).toISOString();
  acc.suspendedUntil = new Date(now + Math.max(60_000, Number(ttlMs) || SUSPENSION_QUARANTINE_MS)).toISOString();
  acc.suspendReason = String(reason || 'Swiggy account blocked').slice(0, 300);
  acc.suspendCode = String(code || '').slice(0, 80);
  acc.suspendStage = String(stage || '').slice(0, 80);
  acc.suspendOrderId = String(orderId || '').slice(0, 40);
  acc.suspendHttpStatus = Number(httpStatus) || 0;
  acc.suspendCount = Number(acc.suspendCount || 0) + 1;
  acc.lastFailureAt = new Date(now).toISOString();
  acc.failureStreak = 0;
  pushHealthEvent(db, {
    type: 'SUSPENDED', key: k, phone: acc.phone || '', reason: acc.suspendReason,
    code: acc.suspendCode, stage: acc.suspendStage, orderId: acc.suspendOrderId,
    until: acc.suspendedUntil
  });
  saveDb(db);
  console.warn(`[AccountHealth] ⛔ ${acc.phone || k} suspended: ${acc.suspendReason} (until ${acc.suspendedUntil})`);
  return acc;
}

/** ID healthy nikli → quarantine clear + streak reset. */
export function markAccountHealthy(key, { note = '' } = {}) {
  const k = String(key || '');
  if (!k) return null;
  const db = getDb();
  const acc = db?.config?.accounts?.[k];
  if (!acc) return null;
  const changed = Boolean(acc.healthStatus || acc.suspended || acc.suspendedAt || Number(acc.failureStreak || 0) > 0);
  acc.healthStatus = 'HEALTHY';
  acc.suspended = false;
  acc.suspendedAt = '';
  acc.suspendedUntil = '';
  acc.suspendReason = '';
  acc.failureStreak = 0;
  acc.lastHealthyAt = new Date().toISOString();
  if (note) acc.lastHealthNote = String(note).slice(0, 160);
  delete acc.sessionExpired;
  if (changed) {
    pushHealthEvent(db, { type: 'HEALTHY', key: k, phone: acc.phone || '', note: String(note || '') });
    saveDb(db);
  }
  return acc;
}

/**
 * Suspension ke alawa baaki failure sirf ginti me jaati hai (session/WAF/network
 * ki wajah se ID ko block nahi karte). 3 baar "order reject" ho to quarantine.
 */
export function noteAccountFailure(key, { kind = 'UNKNOWN', reason = '', code = '', stage = '', orderId = '' } = {}) {
  const k = String(key || '');
  if (!k) return null;
  if (kind === 'SUSPENDED') {
    return markAccountSuspended(k, { reason, code, stage, orderId });
  }
  const db = getDb();
  const acc = db?.config?.accounts?.[k];
  if (!acc) return null;
  acc.failureStreak = Number(acc.failureStreak || 0) + 1;
  acc.lastFailureAt = new Date().toISOString();
  acc.lastFailureKind = String(kind || 'UNKNOWN').slice(0, 40);
  acc.lastFailureReason = String(reason || '').slice(0, 240);
  acc.lastFailureStage = String(stage || '').slice(0, 80);
  saveDb(db);
  return acc;
}

/** Panel/card ke liye ek line: kitni IDs suspended hain. */
export function suspendedAccountsSummary(accounts = null) {
  const src = accounts || getDb()?.config?.accounts || {};
  const rows = Object.entries(src)
    .filter(([, a]) => isAccountSuspended(a))
    .map(([key, a]) => ({
      key,
      phone: String(a.phone || a.mobile || key).replace(/^acc_/, ''),
      reason: describeSuspendedAccount(a),
      until: a.suspendedUntil || ''
    }));
  return {
    count: rows.length,
    rows,
    text: rows.length
      ? `⛔ <b>${rows.length} ID suspended</b> — inhe rotation me nahi chuna jayega:\n` +
        rows.map((r) => `• <code>${r.phone}</code> — ${r.reason}`).join('\n')
      : ''
  };
}
