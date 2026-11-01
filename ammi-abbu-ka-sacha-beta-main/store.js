import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  pullAccountsFromCloudVault,
  pushAccountsToCloudVaultNow,
  scheduleCloudVaultSync,
  markCloudVaultHydrated
} from './vault-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use persistent disk on Render (/app/data), fallback to local ./data
// Supports env override: DATA_DIR, DB_FILE for flexibility
const isRender = process.env.RENDER === 'true' || process.env.RENDER_SERVICE_NAME;
const DEFAULT_DATA_DIR = isRender ? '/app/data' : path.join(__dirname, 'data');

export const getDataDir = () => process.env.DATA_DIR || DEFAULT_DATA_DIR;
export const getDbFile = () => process.env.DB_FILE || path.join(getDataDir(), 'db.json');
export const getAccountsJsonFile = () => process.env.ACCOUNTS_JSON_FILE || path.join(__dirname, 'accounts.json');

const defaultData = {
  config: {
    totalSlots: 9,
    slotsLeft: 5,
    bossIds: [6484999726],
    // No hard-coded payment VPA: `swiggy@icici` is NOT a real account (Swiggy's
    // merchant handle is `upiswiggy@icici`), so every QR built from it scanned as
    // INVALID. Boss must set his own with /setupi before a personal QR is used.
    bossUpiId: '',
    familyMembers: {},
    accounts: {},
    deletedAccounts: {}
  },
  sessionVault: {},
  orders: {},
  drafts: {},
  bossState: null,
  userStates: {}
};

// Strips markdown code fences and outer noise from pasted JSON / Cookie strings
function unwrapRawSessionString(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim();
  s = s.replace(/^```(?:json|js|txt)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (/^cookie\s*:/i.test(s)) {
    s = s.replace(/^cookie\s*:\s*/i, '').trim();
  }
  return s;
}

function isCookieEditorArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.some(c => c && typeof c === 'object' && typeof c.name === 'string' && c.value !== undefined && !c.tid && !c.token && !c.phone && !c.mobile)
  );
}

// Normalizes ANY single Swiggy session object/cookie string from ANY bot or browser extension into canonical fields
export function normalizeSwiggySessionPayload(rawInput) {
  if (!rawInput) return null;
  let item = typeof rawInput === 'string' ? unwrapRawSessionString(rawInput) : rawInput;

  if (typeof item === 'string') {
    try {
      item = JSON.parse(item);
    } catch {
      if (item.includes('=') && (item.includes('_session_tid') || item.includes('tid=') || item.includes('token='))) {
        item = { cookies: item };
      } else if (item.includes('.') && item.length > 60 && !item.includes(' ')) {
        item = { tid: item };
      } else if (/^[0-9a-fA-F]{40,}$/.test(item)) {
        item = { _session_tid: item };
      } else {
        return null;
      }
    }
  }

  if (isCookieEditorArray(item)) {
    const cookiePairs = item
      .filter(c => c && c.name && c.value !== undefined)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    const getC = (n) => item.find(c => c && c.name === n)?.value || '';
    item = {
      _session_tid: getC('_session_tid'),
      tid: getC('tid'),
      sid: getC('_sid') || getC('sid'),
      deviceId: getC('_device_id') || getC('deviceId') || getC('_swuid'),
      token: getC('token'),
      cookies: cookiePairs
    };
  }

  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  // Unwrap nested containers `{ session: {...} }`, `{ data: {...} }`, `{ account: {...} }`, `{ user: {...} }`
  const inner =
    (item.session && typeof item.session === 'object' && !Array.isArray(item.session) ? item.session : null) ||
    (item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? item.data : null) ||
    (item.account && typeof item.account === 'object' && !Array.isArray(item.account) ? item.account : null) ||
    (item.auth && typeof item.auth === 'object' && !Array.isArray(item.auth) ? item.auth : null) ||
    null;
  const src = inner ? { ...item, ...inner } : { ...item };
  const hdr = (src.headers && typeof src.headers === 'object') ? src.headers : {};

  // Normalize cookies whether string, Cookie-Editor array, or `{ key: value }` object map
  let rawCookieStr = '';
  const rawC = src.cookies ?? src.cookie ?? src.cookie_string ?? src.cookieString ?? hdr.Cookie ?? hdr.cookie ?? '';
  if (typeof rawC === 'string') {
    rawCookieStr = unwrapRawSessionString(rawC);
  } else if (Array.isArray(rawC)) {
    rawCookieStr = rawC
      .filter(c => c && (c.name || c.key) && c.value !== undefined)
      .map(c => `${c.name || c.key}=${c.value}`)
      .join('; ');
  } else if (rawC && typeof rawC === 'object') {
    rawCookieStr = Object.entries(rawC)
      .filter(([k, v]) => k && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  let sessionTid = String(
    src._session_tid ||
    src.session_tid ||
    src.sessionTid ||
    src.session_id ||
    src.sessionId ||
    (typeof src.session === 'string' ? src.session : '') ||
    hdr._session_tid ||
    ''
  ).trim();

  let rawTid = String(src.tid || src.jwt_tid || src.jwtTid || src.jwt || hdr.tid || '').trim();
  // Critical fix: other bots often store the hex `_session_tid` directly inside `tid`!
  if (rawTid && !rawTid.includes('.') && !sessionTid) {
    sessionTid = rawTid;
  }

  let token = String(
    src.token ||
    src.auth_token ||
    src.authToken ||
    src.access_token ||
    src.accessToken ||
    src.swiggy_token ||
    hdr.token ||
    ''
  ).trim();

  let sid = String(src.sid || src._sid || src.session_sid || hdr.sid || '').trim();
  let deviceId = String(
    src.deviceId ||
    src.device_id ||
    src._device_id ||
    src.swuid ||
    src._swuid ||
    src.uuid ||
    hdr.deviceId ||
    hdr['device-id'] ||
    hdr.swuid ||
    ''
  ).trim();

  let customerId = String(
    src.customerId ||
    src.customer_id ||
    src.userId ||
    src.user_id ||
    src.userid ||
    hdr.userid ||
    hdr['user-id'] ||
    (typeof src.id === 'number' || /^\d{5,15}$/.test(String(src.id || '')) ? src.id : '') ||
    ''
  ).trim();
  if (customerId === '0' || customerId === '-1') customerId = '';

  const rawPhone = String(
    src.phone ||
    src.mobile ||
    src.phone_number ||
    src.mobile_number ||
    src.phoneNumber ||
    src.mobileNumber ||
    src.number ||
    src.msisdn ||
    ''
  ).trim();
  const cleanPhone = rawPhone ? rawPhone.replace(/[^0-9]/g, '').slice(-10) : '';
  const name = String(src.swiggyName || src.name || src.full_name || src.user_name || src.username || '').trim();

  const normalized = {
    account: typeof src.account === 'string' ? src.account : '',
    name,
    swiggyName: String(src.swiggyName || '').trim(),
    phone: cleanPhone,
    mobile: cleanPhone,
    customerId,
    _session_tid: sessionTid,
    tid: rawTid,
    token,
    sid,
    deviceId,
    cookies: rawCookieStr,
    ...(typeof src.totalOrdersCount === 'number' ? { totalOrdersCount: src.totalOrdersCount } : {}),
    ...(typeof src.isZeroOrderAccount === 'boolean' ? { isZeroOrderAccount: src.isZeroOrderAccount } : {}),
    ...(typeof src.ordersVerifiedLive === 'boolean' ? { ordersVerifiedLive: src.ordersVerifiedLive } : {})
  };

  normalized.cookies = cleanEssentialSwiggyCookies(rawCookieStr, normalized);
  const getFromMap = (cookieKey) => {
    const m = normalized.cookies.match(new RegExp(`(?:^|;\\s*)${cookieKey}=([^;]+)`));
    return m ? m[1].trim() : '';
  };

  if (!normalized._session_tid) normalized._session_tid = getFromMap('_session_tid');
  if (!normalized.tid || (!normalized.tid.includes('.') && getFromMap('tid').includes('.'))) {
    normalized.tid = getFromMap('tid') || normalized.tid;
  }
  if (!normalized.token) normalized.token = getFromMap('token');
  if (!normalized.sid) normalized.sid = getFromMap('_sid') || getFromMap('sid');
  if (!normalized.deviceId) normalized.deviceId = getFromMap('_device_id') || getFromMap('_swuid');

  if (!normalized.customerId && normalized.tid && normalized.tid.includes('.')) {
    try {
      const payload = JSON.parse(Buffer.from(normalized.tid.split('.')[1], 'base64').toString('utf8'));
      if (payload?.user_id && String(payload.user_id) !== '0' && String(payload.user_id) !== '-1') {
        normalized.customerId = String(payload.user_id);
      }
    } catch {}
  }

  const hasAnyAuth = Boolean(normalized._session_tid || normalized.tid || normalized.token || normalized.cookies);
  return hasAnyAuth ? normalized : null;
}

// Extracts 1 or MANY normalized Swiggy session objects from single JSON, Cookie-Editor array, or multi-account `accounts.json` / `db.json`!
export function extractSwiggyAccountsListFromInput(rawInput) {
  if (!rawInput) return [];
  let parsed = typeof rawInput === 'string' ? unwrapRawSessionString(rawInput) : rawInput;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      const single = normalizeSwiggySessionPayload(parsed);
      return single ? [single] : [];
    }
  }

  if (isCookieEditorArray(parsed)) {
    const single = normalizeSwiggySessionPayload(parsed);
    return single ? [single] : [];
  }

  if (Array.isArray(parsed)) {
    return parsed.map(x => normalizeSwiggySessionPayload(x)).filter(Boolean);
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.cookies) && isCookieEditorArray(parsed.cookies)) {
      const single = normalizeSwiggySessionPayload(parsed);
      return single ? [single] : [];
    }
    const multiMap =
      (parsed.config?.accounts && typeof parsed.config.accounts === 'object' ? parsed.config.accounts : null) ||
      (parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : null);
    if (multiMap) {
      const arr = Array.isArray(multiMap)
        ? multiMap
        : Object.entries(multiMap).map(([k, v]) => (v && typeof v === 'object' ? { account: k, ...v } : null));
      return arr.map(x => normalizeSwiggySessionPayload(x)).filter(Boolean);
    }
    if (Array.isArray(parsed.data)) {
      return parsed.data.map(x => normalizeSwiggySessionPayload(x)).filter(Boolean);
    }
    const single = normalizeSwiggySessionPayload(parsed);
    return single ? [single] : [];
  }
  return [];
}

// Strips only transient/analytics bloat while preserving 100% of Swiggy auth cookies (_session_tid, tid, token, _sid, _device_id, __SW, _swuid, _is_logged_in)
export function cleanEssentialSwiggyCookies(cookieStr = '', fallback = {}) {
  const dropPrefixes = [
    'aws-waf-token=',
    '_ga=',
    '_ga_',
    '_gid=',
    '_gat',
    '_gcl_',
    'AMP_TOKEN=',
    'fontsLoaded=',
    'userLocation='
  ];
  const map = new Map();

  if (typeof cookieStr === 'string' && cookieStr.trim()) {
    for (const part of cookieStr.split(';')) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      if (dropPrefixes.some(p => trimmed.startsWith(p))) continue;
      const eqIdx = trimmed.indexOf('=');
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (!k || v === '') continue;
      map.set(k, v);
    }
  }

  const fbSessionTid = fallback._session_tid || fallback.session_tid || fallback.sessionTid || '';
  if (fbSessionTid && !map.has('_session_tid')) map.set('_session_tid', fbSessionTid);
  if (fallback.tid && !fallback.tid.includes('.') && !map.has('_session_tid')) {
    map.set('_session_tid', fallback.tid);
  }
  if (fallback.tid && fallback.tid.includes('.') && !map.has('tid')) {
    map.set('tid', fallback.tid);
  } else if (fallback.tid && !map.has('tid')) {
    map.set('tid', fallback.tid);
  }
  const fbSid = fallback.sid || fallback._sid || '';
  if (fbSid && !map.has('_sid')) map.set('_sid', fbSid);
  const fbDev = fallback.deviceId || fallback.device_id || fallback._device_id || fallback.swuid || '';
  if (fbDev && !map.has('_device_id')) map.set('_device_id', fbDev);
  const fbTok = fallback.token || fallback.auth_token || fallback.access_token || '';
  if (fbTok && !map.has('token')) map.set('token', fbTok);
  if ((map.has('_session_tid') || map.has('tid') || map.has('token')) && !map.has('_is_logged_in')) {
    map.set('_is_logged_in', '1');
  }

  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function isAccountLoggedInSession(acc) {
  if (!acc || !acc.isLoggedIn || acc.isLoggedOut || acc.sessionExpired) return false;
  // If tid is a JWT with an expired exp and no _session_tid cookie, it is expired!
  if (acc.tid && typeof acc.tid === 'string' && acc.tid.includes('.')) {
    try {
      const parts = acc.tid.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        if (payload?.exp && (Number(payload.exp) * 1000) <= Date.now()) {
          const hasSessTid = Boolean(acc._session_tid || (typeof acc.cookies === 'string' && acc.cookies.includes('_session_tid=')));
          if (!hasSessTid) return false;
        }
      }
    } catch {}
  }
  return Boolean(acc.cookies || acc.tid || acc.token);
}

function normalizeTenDigitPhone(raw = '') {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return digits.slice(2);
  if (digits.length > 10) {
    const tail = digits.slice(-10);
    if (/^[6-9]/.test(tail)) return tail;
  }
  return digits.length === 10 ? digits : '';
}

function isExplicitDifferentPhoneCloneKey(key = '', cleanPhone = '') {
  const m = String(key || '').match(/^acc_(\d{10})$/);
  return Boolean(m && cleanPhone && m[1] !== cleanPhone);
}

export function findAccountKeyByPhone(accounts = {}, phone = '', excludeKey = null) {
  const cleanPhone = normalizeTenDigitPhone(phone);
  if (!cleanPhone || !accounts || typeof accounts !== 'object') return null;
  for (const [k, a] of Object.entries(accounts)) {
    if (!a || k === excludeKey) continue;
    if (isExplicitDifferentPhoneCloneKey(k, cleanPhone)) continue;
    const accPhone = normalizeTenDigitPhone(a.phone || a.mobile || String(k).replace(/^acc_/, ''));
    if (accPhone === cleanPhone) return k;
  }
  return null;
}

function isAccountTombstoned(deletedAccounts = {}, key = '', cleanPhone = '') {
  if (!deletedAccounts || typeof deletedAccounts !== 'object') return false;
  if (key && deletedAccounts[key]) return true;
  if (cleanPhone && !isExplicitDifferentPhoneCloneKey(key, cleanPhone)) {
    if (deletedAccounts[`acc_${cleanPhone}`] || deletedAccounts[cleanPhone]) return true;
  }
  return false;
}

function consolidateDuplicatePhoneSlots(db, winningKey, cleanPhone) {
  if (!cleanPhone || !winningKey || isExplicitDifferentPhoneCloneKey(winningKey, cleanPhone)) return;
  const accounts = db?.config?.accounts || {};
  const winner = accounts[winningKey];
  if (!winner) return;

  for (const [k, other] of Object.entries(accounts)) {
    if (k === winningKey || !other) continue;
    if (isExplicitDifferentPhoneCloneKey(k, cleanPhone)) continue;
    const otherPhone = normalizeTenDigitPhone(other.phone || other.mobile || String(k).replace(/^acc_/, ''));
    if (otherPhone !== cleanPhone) continue;

    // Preserve useful cached metadata / custom label when merging a duplicate slot into winningKey
    if ((!winner.name || winner.name === winningKey || /^Swiggy\s+\d|^User\s*\(/i.test(winner.name)) && other.name && !/^Swiggy\s+\d|^User\s*\(/i.test(other.name)) {
      winner.name = other.name;
    }
    if (!winner.offers && other.offers) winner.offers = other.offers;
    if (!winner.preferredOfferValue && other.preferredOfferValue) winner.preferredOfferValue = other.preferredOfferValue;
    if (winner.totalOrdersCount === undefined && other.totalOrdersCount !== undefined) {
      winner.totalOrdersCount = other.totalOrdersCount;
      winner.isZeroOrderAccount = other.isZeroOrderAccount;
    }
    if (!String(winner.cookies || '').includes('_session_tid=') && String(other.cookies || '').includes('_session_tid=')) {
      winner.cookies = cleanEssentialSwiggyCookies(`${other.cookies}; ${winner.cookies || ''}`, winner);
    }

    if (db.config.activeOrderAccount === k) {
      db.config.activeOrderAccount = winningKey;
    }
    for (const ord of Object.values(db.orders || {})) {
      if (ord && ord.selectedAccount === k) ord.selectedAccount = winningKey;
    }
    delete accounts[k];
  }
}

export function buildCloudVaultSnapshot(data = null) {
  const src = data || getDb();
  const accountsOut = {};
  for (const [k, a] of Object.entries(src?.config?.accounts || {})) {
    if (!a || (!a.cookies && !a.tid && !a.token && !a.isLoggedIn)) continue;
    accountsOut[k] = { ...a };
  }
  // Orders are persisted too (2026-10-22: Render deploys wiped the local
  // in-memory order list → auto-tracking died on restart, Export & Logout
  // lost its "1+ orders" proof, and the boss had to re-scan everything).
  const ordersOut = {};
  for (const [k, o] of Object.entries(src?.orders || {})) {
    if (!o || !o.id) continue;
    ordersOut[k] = { ...o };
  }
  return {
    version: 16,
    updatedAt: new Date().toISOString(),
    accounts: accountsOut,
    deletedAccounts: { ...(src?.config?.deletedAccounts || {}) },
    sessionVault: { ...(src?.sessionVault || {}) },
    orders: ordersOut,
    // Shared WAF token (encrypted at rest by the vault transport) so a fresh
    // Render deploy starts WARM — no cold-start challenge storm on scans.
    waf: (src?.waf && typeof src.waf.token === 'string' && src.waf.token.length > 50)
      ? { token: src.waf.token, acquiredAt: src.waf.acquiredAt || 0, source: src.waf.source || '' }
      : null
  };
}

export async function syncCloudVaultNow(data = null) {
  return pushAccountsToCloudVaultNow(buildCloudVaultSnapshot(data));
}

export async function hydrateAccountsFromCloudVault() {
  try {
    const remote = await pullAccountsFromCloudVault();
    markCloudVaultHydrated();
    if (!remote || typeof remote !== 'object') return { restored: 0, total: 0 };

    let restored = 0;
    let mutated = false;
    const db = getDb();
    if (!db.config.accounts) db.config.accounts = {};
    if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
    if (!db.sessionVault) db.sessionVault = {};

    for (const [delKey, delVal] of Object.entries(remote.deletedAccounts || {})) {
      if (!delVal) continue;
      if (!db.config.deletedAccounts[delKey]) {
        db.config.deletedAccounts[delKey] = true;
        mutated = true;
      }
      // If a stale locally-seeded `accounts.json` entry matched a remote deletion tombstone (and wasn't just freshly logged in within 60s), remove it!
      const staleAcc = db.config.accounts[delKey];
      if (staleAcc) {
        const savedMs = staleAcc.savedAt ? Date.parse(staleAcc.savedAt) : 0;
        const recentlyLoggedIn = Number.isFinite(savedMs) && (Date.now() - savedMs < 60_000) && staleAcc.freshlyAuthenticated === true;
        if (!recentlyLoggedIn) {
          delete db.config.accounts[delKey];
          mutated = true;
        }
      }
    }

    for (const [vKey, vVal] of Object.entries(remote.sessionVault || {})) {
      if (!vVal || db.sessionVault[vKey]) continue;
      const vPhone = normalizeTenDigitPhone(vVal.phone || vVal.mobile || vKey);
      if (isAccountTombstoned(db.config.deletedAccounts, vVal.account || vKey, vPhone)) continue;
      db.sessionVault[vKey] = vVal;
      mutated = true;
    }

    // Restore order history that lived on the previous instance's disk.
    // Local (live) orders always win; we only fill what is missing and merge
    // a few critical fields the local copy might be missing (tracking link
    // found by the other instance, etc.).
    if (!db.orders) db.orders = {};
    for (const [oKey, oVal] of Object.entries(remote.orders || {})) {
      if (!oVal || !oVal.id) continue;
      if (!db.orders[oKey]) {
        db.orders[oKey] = oVal;
        mutated = true;
        continue;
      }
      const local = db.orders[oKey];
      let merged = false;
      for (const f of ['swiggyOrderId', 'pendingSwiggyOrderId', 'trackingLink', 'trackingLinkSource', 'deliveryOtp', 'selectedAccount', 'liveOrderStatus']) {
        if (oVal[f] && !local[f]) { local[f] = oVal[f]; merged = true; }
      }
      if (merged) mutated = true;
    }

    // Shared WAF token: a newer vault copy wins, so a fresh instance
    // hydrates a warm token before Chromium even has a chance to run.
    const remoteWaf = remote.waf || null;
    if (remoteWaf && typeof remoteWaf.token === 'string' && remoteWaf.token.length > 50) {
      const localAcq = Number(db.waf?.acquiredAt) || 0;
      const remAcq = Number(remoteWaf.acquiredAt) || 0;
      if (remAcq >= localAcq) {
        db.waf = { ...(db.waf || {}), token: remoteWaf.token, acquiredAt: remAcq, source: remoteWaf.source || 'vault' };
        mutated = true;
      }
    }

    for (const [k, remAcc] of Object.entries(remote.accounts || {})) {
      if (!remAcc || remAcc.isLoggedIn === false) continue;
      const remPhone = normalizeTenDigitPhone(remAcc.phone || remAcc.mobile || String(k).replace(/^acc_/, ''));
      if (isAccountTombstoned(db.config.deletedAccounts, k, remPhone)) continue;
      const existingSamePhoneKey = remPhone ? findAccountKeyByPhone(db.config.accounts, remPhone, k) : null;
      if (existingSamePhoneKey && isAccountLoggedInSession(db.config.accounts[existingSamePhoneKey])) continue;

      const cur = db.config.accounts[k];
      // Never resurrect an account that was explicitly logged out or marked expired locally
      if (cur && (cur.isLoggedOut || cur.sessionExpired || cur.isLoggedIn === false)) {
        continue;
      }

      if (!cur) {
        const cleanC = cleanEssentialSwiggyCookies(remAcc.cookies || '', remAcc);
        db.config.accounts[k] = {
          ...remAcc,
          id: k,
          cookies: cleanC || remAcc.cookies || '',
          isLoggedIn: true
        };
        restored++;
        mutated = true;
      }
    }

    if (mutated) {
      saveDb(db);
      syncAccountsJsonMirror(db, { skipCloudPush: true });
      if (restored > 0) {
        console.log(`[CloudVault] Restored ${restored} saved Swiggy JSON account(s) from persistent vault!`);
      }
    }
    return {
      restored,
      total: Object.values(db.config.accounts).filter(a => isAccountLoggedInSession(a)).length
    };
  } catch (e) {
    console.warn('[CloudVault] Hydrate note:', e.message);
    return { restored: 0, total: 0 };
  }
}

export function syncAccountsJsonMirror(data, { skipCloudPush = false } = {}) {
  try {
    const accounts = data?.config?.accounts || {};
    const mirrorList = Object.entries(accounts)
      .filter(([, a]) => a && a.isLoggedIn && (a.cookies || a.tid || a.token))
      .map(([k, a]) => {
        const cleanC = cleanEssentialSwiggyCookies(a.cookies, a);
        const sessMatch = cleanC.match(/(?:^|;\s*)_session_tid=([^;]+)/);
        const sessionTidVal = sessMatch ? sessMatch[1].trim() : (a._session_tid || '');
        return {
          account: k,
          name: a.name || k,
          phone: a.phone || a.mobile || '',
          mobile: a.mobile || a.phone || '',
          customerId: a.customerId || '',
          ...(sessionTidVal ? { _session_tid: sessionTidVal } : {}),
          token: a.token || '',
          tid: a.tid || '',
          sid: a.sid || '',
          deviceId: a.deviceId || '',
          cookies: cleanC,
          isLoggedIn: true,
          ...(a.isZeroOrderAccount !== undefined ? { isZeroOrderAccount: a.isZeroOrderAccount } : {}),
          ...(a.totalOrdersCount !== undefined ? { totalOrdersCount: a.totalOrdersCount } : {}),
          savedAt: a.savedAt || new Date().toISOString()
        };
      });
    // compact: pretty-print se ~35% chhoti file + tez write
    fs.writeFileSync(getAccountsJsonFile(), JSON.stringify(mirrorList), 'utf-8');
    if (!skipCloudPush) {
      scheduleCloudVaultSync(() => buildCloudVaultSnapshot(getDb()));
    }
  } catch (e) {}
}

// ── DB I/O FAST PATH ────────────────────────────────────────────────────────
// PEHLE: har `getDb()` disk se poora db.json padhta tha + har order/account ka
// JSON.stringify banata tha; har `saveDb()` phir disk dobara padhta tha aur
// poora file pretty-print karke likhta tha. 10 orders + 19 IDs par ek update me
// yeh sau baar hota tha => event loop block => "hawa nikal jaati hai".
// AB: file ka newest text memory me rehta hai (signature se validated), baselines
// sirf zaroorat par bante hain, aur write compact hota hai.
const dbIo = {
  file: '',
  text: '',            // newest serialized state (memory truth, disk se naya)
  sig: '',             // file signature jab humne aakhri baar padha/likha
  writeSeq: 0,         // har save par +1 (concurrent-writer detect)
  dirty: false,
  flushTimer: null,
  stats: { reads: 0, diskReads: 0, parses: 0, saves: 0, merges: 0, writes: 0, lastGetMs: 0, lastSaveMs: 0, totalGetMs: 0 }
};

const DB_PRETTY = process.env.DB_PRETTY === '1';
// Render par async (coalesced) write default ON: ek tick ke kai saves ek hi disk
// write ban jaate hain. Tests/dev me sync rehta hai (predictable files).
const DB_ASYNC_WRITE = process.env.DB_ASYNC_WRITE === '1'
  || (process.env.DB_ASYNC_WRITE !== '0' && (process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_NAME)));

function dbFileSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return '';
  }
}

let ensureDbDone = false;
function ensureDb() {
  if (ensureDbDone && dbIo.file === getDbFile()) return;
  const dir = getDataDir();
  const dbPath = getDbFile();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
  dbIo.file = dbPath;
  dbIo.sig = dbFileSig(dbPath);
  ensureDbDone = true;
}

/** Newest DB text: memory (jo abhi likha gaya) ya disk (jo kisi aur ne likha). */
function newestDbText() {
  const file = getDbFile();
  const sig = dbFileSig(file);
  const externalChange = Boolean(sig) && sig !== dbIo.sig;
  if (dbIo.file === file && dbIo.text && !externalChange) {
    dbIo.stats.reads += 1;
    return dbIo.text;
  }
  const text = fs.readFileSync(file, 'utf-8');
  dbIo.stats.diskReads += 1;
  dbIo.sig = sig;
  dbIo.text = text;
  dbIo.file = file;
  return text;
}

/** Baseline maps (caller ke read ke waqt ka sach) — sirf save ke waqt bante hain. */
function buildBaselines(pristineText) {
  const base = JSON.parse(pristineText);
  const toMap = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = JSON.stringify(v);
    return out;
  };
  return {
    orders: toMap(base.orders),
    accounts: toMap(base.config?.accounts),
    deleted: toMap(base.config?.deletedAccounts),
    vault: toMap(base.sessionVault),
    drafts: toMap(base.drafts),
    proAccountGrants: toMap(base.config?.proAccountGrants),
    proAccountGrantsRaw: base.config?.proAccountGrants
  };
}

export function getDbIoStats() {
  return {
    dbSizeKb: Math.round(Buffer.byteLength(dbIo.text || '', 'utf8') / 1024),
    ...dbIo.stats,
    avgGetDbMs: dbIo.stats.reads ? Math.round((dbIo.stats.totalGetMs / dbIo.stats.reads) * 100) / 100 : 0,
    asyncWrite: DB_ASYNC_WRITE,
    dirty: dbIo.dirty
  };
}

let accountsSeeded = false;
function seedAccountsFromJson(data) {
  if (accountsSeeded) return;
  try {
    const accFile = getAccountsJsonFile();
    if (fs.existsSync(accFile)) {
      const raw = fs.readFileSync(accFile, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        if (!data.config.accounts) data.config.accounts = {};
        if (!data.config.deletedAccounts) data.config.deletedAccounts = {};
        for (const item of list) {
          if (item && (item.tid || item.token || item.cookies || item.phone)) {
            const phone = item.phone || item.mobile || '';
            const cleanPhone = normalizeTenDigitPhone(phone);
            const preferredKey = item.account && String(item.account).trim();
            const key = preferredKey || (cleanPhone ? `acc_${cleanPhone}` : 'acc_' + Date.now());
            // Never resurrect explicitly deleted, logged-out, or already-present phone accounts!
            if (isAccountTombstoned(data.config.deletedAccounts, key, cleanPhone)) continue;
            if (item.isLoggedOut || item.sessionExpired || item.isLoggedIn === false) continue;
            if (data.config.accounts[key] && (data.config.accounts[key].isLoggedIn === false || data.config.accounts[key].isLoggedOut || data.config.accounts[key].sessionExpired)) continue;
            const existingSamePhoneKey = cleanPhone ? findAccountKeyByPhone(data.config.accounts, cleanPhone, key) : null;
            if (existingSamePhoneKey) continue;

            if (!data.config.accounts[key] && item.isLoggedIn !== false) {
              const cookieStr = cleanEssentialSwiggyCookies(
                item.cookies || (item.tid ? `tid=${item.tid}; _sid=${item.sid || ''}; _device_id=${item.deviceId || ''}; token=${item.token || item.tid}; _is_logged_in=1` : ''),
                item
              );
              data.config.accounts[key] = {
                id: key,
                name: item.name || (cleanPhone ? `User (${cleanPhone})` : 'Swiggy User'),
                phone: cleanPhone || '',
                mobile: cleanPhone || '',
                customerId: item.customerId || '',
                ...(item._session_tid ? { _session_tid: item._session_tid } : {}),
                token: item.token || item.tid || '',
                tid: item.tid || '',
                sid: item.sid || '',
                deviceId: item.deviceId || '',
                cookies: cookieStr,
                ...(item.isZeroOrderAccount !== undefined ? { isZeroOrderAccount: item.isZeroOrderAccount } : {}),
                ...(item.totalOrdersCount !== undefined ? { totalOrdersCount: item.totalOrdersCount } : {}),
                isLoggedIn: Boolean(item.isLoggedIn !== false && (cookieStr || item.tid || item.token)),
                savedAt: item.savedAt || new Date().toISOString()
              };
            }
          }
        }
      }
    }
    accountsSeeded = true;
  } catch (e) {
    console.warn('seedAccountsFromJson note:', e.message);
  }
}

export function getDb() {
  ensureDb();
  const t0 = Date.now();
  try {
    const raw = newestDbText();
    dbIo.stats.parses += 1;
    const data = JSON.parse(raw);
    if (!data.config) data.config = { ...defaultData.config };
    if (!data.config.bossIds) {
      data.config.bossIds = data.config.bossId ? [data.config.bossId] : [6484999726];
    }
    if (!data.config.familyMembers) {
      data.config.familyMembers = {};
    }
    if (!data.config.accounts) {
      data.config.accounts = {};
    }
    if (!data.config.deletedAccounts) {
      data.config.deletedAccounts = {};
    }
    // A stored placeholder from older versions is not a real payment handle —
    // drop it so no QR is ever built from it again.
    if (data.config.bossUpiId && /^swiggy[a-z0-9.\-_]*@/i.test(String(data.config.bossUpiId).trim())) {
      data.config.bossUpiId = '';
    }
    if (!data.sessionVault) {
      data.sessionVault = {};
    }
    seedAccountsFromJson(data);
    delete data.config.depositAmount;
    // Baseline (concurrent-writer protection ke liye) ab LAZY hai: sirf save ke
    // waqt banta hai. Pehle har getDb par ~40 JSON.stringify chalte the.
    Object.defineProperty(data, '__pristineText', { value: raw, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(data, '__readSeq', { value: dbIo.writeSeq, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(data, '__baseCache', { value: null, enumerable: false, configurable: true, writable: true });
    dbIo.stats.totalGetMs += Date.now() - t0;
    dbIo.stats.lastGetMs = Date.now() - t0;
    return data;
  } catch (err) {
    console.error('Error reading db:', err);
    return defaultData;
  }
}

/** save ke waqt: caller ke read-point ka baseline (cached). */
function baselinesFor(data) {
  if (data.__baseCache) return data.__baseCache;
  // Baseline hi nahi (test/fiber ne db ko JSON-clone kiya, ya object scratch se
  // bana): purana behaviour = khaali baseline. Isse disk ke naye tombstones
  // phir bhi lagte hain — logged-out ID wapas zinda nahi hoti.
  if (!data.__pristineText) {
    const empty = { orders: {}, accounts: {}, deleted: {}, vault: {}, drafts: {}, proAccountGrants: {} };
    try { Object.defineProperty(data, '__baseCache', { value: empty, enumerable: false, configurable: true, writable: true }); } catch {}
    return empty;
  }
  try {
    const built = buildBaselines(data.__pristineText);
    data.__baseCache = built;
    return built;
  } catch {
    return null;
  }
}

export function saveDb(data) {
  ensureDb();
  const tSave = Date.now();
  dbIo.stats.saves += 1;
  if (data?.config) {
    if (typeof data.config.totalSlots === 'number') {
      data.config.totalSlots = Math.max(0, data.config.totalSlots);
    } else {
      data.config.totalSlots = 9;
    }
    if (typeof data.config.slotsLeft === 'number') {
      data.config.slotsLeft = Math.max(0, Math.min(data.config.totalSlots, data.config.slotsLeft));
    } else {
      data.config.slotsLeft = data.config.totalSlots;
    }
  }

  // Always stamp the Swiggy account phone/name onto every order that was placed
  // from a saved account — the Boss dashboard must always be able to answer
  // "is order ko kis phone se place kiya gaya?" without re-reading the account.
  try {
    const accounts = data?.config?.accounts || {};
    for (const order of Object.values(data?.orders || {})) {
      if (!order || typeof order !== 'object') continue;
      const accKey = order.selectedAccount;
      if (!accKey) continue;
      const acc = accounts[accKey];
      if (!acc) continue;
      const phone = String(acc.phone || acc.mobile || '').replace(/^\+?91/, '').replace(/\D/g, '').slice(-10);
      if (phone && order.selectedAccountPhone !== phone) order.selectedAccountPhone = phone;
      const accName = String(acc.name || acc.swiggyName || '').trim();
      if (accName && !order.selectedAccountName) order.selectedAccountName = accName;
      if (phone && !order.orderAccount) order.orderAccount = phone;
    }
  } catch {}

  // ── Concurrent-safe merge: sirf tab jab kisi NE aur likha ho ────────────────
  // Pehle har save par disk dobara padha+parse hota tha (chahe kuch badla hi na
  // ho). Ab: agar hamare read ke baad koi aur writer nahi aaya, merge skip.
  try {
    mergeConcurrentWriters(data);
  } catch {}

  let text;
  try {
    text = DB_PRETTY ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  } catch (err) {
    console.error('[store] serialize failed:', err?.message || err);
    return false;
  }

  dbIo.file = getDbFile();
  dbIo.text = text;
  dbIo.writeSeq += 1;
  dbIo.stats.lastSaveMs = Date.now() - tSave;

  // Is object ka naya baseline = jo abhi likhne ja raha hai.
  try {
    Object.defineProperty(data, '__pristineText', { value: text, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(data, '__readSeq', { value: dbIo.writeSeq, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(data, '__baseCache', { value: null, enumerable: false, configurable: true, writable: true });
  } catch {}

  if (DB_ASYNC_WRITE) {
    dbIo.dirty = true;
    scheduleDbFlush();
    return true;
  }
  return writeDbTextSync(text);
}

/** Persist money/order mutations before allowing an external placement. */
export function saveDbDurable(data) {
  if (!saveDb(data)) return false;
  if (dbIo.dirty && !flushDbSync()) return false;
  try {
    const file = getDbFile();
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return true;
  } catch (err) {
    console.error('[store] durable save failed:', err?.message || err);
    return false;
  }
}

/** Atomic disk write (tmp + rename) — partial file kabhi nahi. */
function writeDbTextSync(text) {
  const dbFile = getDbFile();
  const tmpFile = `${dbFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, text, 'utf-8');
    fs.renameSync(tmpFile, dbFile);
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    try {
      fs.writeFileSync(dbFile, text, 'utf-8');
    } catch (e2) {
      console.error('[store] DB write failed:', e2?.message || e2);
      return false;
    }
  }
  dbIo.sig = dbFileSig(dbFile);
  dbIo.dirty = false;
  dbIo.stats.writes += 1;
  return true;
}

function scheduleDbFlush() {
  if (dbIo.flushTimer) return;
  dbIo.flushTimer = setImmediate(() => {
    dbIo.flushTimer = null;
    flushDbSync();
  });
  if (typeof dbIo.flushTimer?.unref === 'function') dbIo.flushTimer.unref();
}

/** Pending write turant disk par (SIGTERM / shutdown / external read se pehle). */
export function flushDbSync() {
  if (!dbIo.dirty) return false;
  const text = dbIo.text;
  if (!text) return false;
  // Kisi DOOSRE process ne beech me likha ho to uske naye keys bacha lo.
  try {
    const file = getDbFile();
    const sig = dbFileSig(file);
    if (sig && sig !== dbIo.sig) {
      const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const mine = JSON.parse(text);
      const merged = additiveMerge(mine, disk);
      const mergedText = DB_PRETTY ? JSON.stringify(merged, null, 2) : JSON.stringify(merged);
      dbIo.text = mergedText;
      return writeDbTextSync(mergedText);
    }
  } catch {}
  return writeDbTextSync(text);
}

/**
 * Doosre process (bossbot) ke naye orders/accounts kabhi na udein — additive
 * merge: jo disk par hai par humare paas nahi, woh add; tombstones ka aadar.
 */
function additiveMerge(mine, disk) {
  const push = (target, source, skipTombstone = null) => {
    for (const [k, v] of Object.entries(source || {})) {
      if (Object.prototype.hasOwnProperty.call(target, k)) continue;
      if (skipTombstone && Object.prototype.hasOwnProperty.call(skipTombstone, k)) continue;
      target[k] = v;
    }
  };
  try {
    mine.orders = mine.orders || {};
    push(mine.orders, disk.orders);
    mine.drafts = mine.drafts || {};
    push(mine.drafts, disk.drafts);
    mine.sessionVault = mine.sessionVault || {};
    push(mine.sessionVault, disk.sessionVault);
    mine.config = mine.config || {};
    mine.config.accounts = mine.config.accounts || {};
    mine.config.deletedAccounts = mine.config.deletedAccounts || {};
    push(mine.config.accounts, disk.config?.accounts, mine.config.deletedAccounts);
    push(mine.config.deletedAccounts, disk.config?.deletedAccounts);
  } catch {}
  return mine;
}

/**
 * Purane concurrent-writer protection ka naya, LAZY version. Sirf tab chalta
 * hai jab hamare read ke baad koi aur writer (fiber/process) aaya ho.
 */
function purgeTombstonedAccounts(data) {
  try {
    if (!data?.config?.accounts || typeof data.config.accounts !== 'object' || !data.config.deletedAccounts) return 0;
    let purged = 0;
    for (const [ak, aVal] of Object.entries(data.config.accounts)) {
      const phone = normalizeTenDigitPhone(aVal?.phone || aVal?.mobile || String(ak).replace(/^acc_/, ''));
      if (isAccountTombstoned(data.config.deletedAccounts, ak, phone)) {
        delete data.config.accounts[ak];
        purged += 1;
      }
    }
    return purged;
  } catch {
    return 0;
  }
}

function mergeConcurrentWriters(data) {
  // Tombstone purge HAMESHA chalta hai — ek purana fiber (jiske paas baseline
  // nahi hai) bhi logged-out ID ko wapas zinda nahi kar sakta.
  purgeTombstonedAccounts(data);
  const base = baselinesFor(data);
  if (!base) return false;
  const fileChanged = dbFileSig(getDbFile()) !== dbIo.sig;
  const wroteSinceRead = data.__readSeq !== dbIo.writeSeq;
  if (!wroteSinceRead && !fileChanged) return false;

  let liveDisk;
  try {
    liveDisk = JSON.parse(dbIo.text || fs.readFileSync(getDbFile(), 'utf-8'));
  } catch {
    return false;
  }
  dbIo.stats.merges += 1;

  if (typeof data.drafts === 'object' && data.drafts !== null) {
    const diskDrafts = liveDisk?.drafts || {};
    for (const uid of Object.keys(data.drafts)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.drafts, uid);
      const presentOnDisk = Object.prototype.hasOwnProperty.call(diskDrafts, uid);
      if (existedAtRead && !presentOnDisk && JSON.stringify(data.drafts[uid]) === base.drafts[uid]) {
        delete data.drafts[uid];
      }
    }
    for (const [uid, diskDraft] of Object.entries(diskDrafts)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.drafts, uid);
      const presentInCaller = Object.prototype.hasOwnProperty.call(data.drafts, uid);
      if (!existedAtRead && !presentInCaller) {
        data.drafts[uid] = diskDraft;
      } else if (existedAtRead && presentInCaller && JSON.stringify(data.drafts[uid]) === base.drafts[uid]) {
        data.drafts[uid] = diskDraft;
      }
    }
  }

  // Mini App shared-ID access overrides are security decisions, not
  // last-writer-wins config. Missing means the default shared access; '!' is
  // an explicit deny. A stale writer must never erase a deny, and conflicting
  // or malformed decisions must fail closed.
  if (data.config && typeof data.config === 'object') {
    const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
    const invalid = value => value !== undefined && !isObject(value);
    const malformed = [data.config.proAccountGrants, liveDisk?.config?.proAccountGrants, base.proAccountGrantsRaw].find(invalid);
    if (malformed !== undefined) {
      // Never turn an unreadable decision map into the permissive default.
      // Preserve the bad data for operator recovery and deny shared access.
      data.config.proAccountGrants = malformed;
    } else {
      const caller = data.config.proAccountGrants || {};
      const disk = liveDisk?.config?.proAccountGrants || {};
      const baseRows = base.proAccountGrants || {};
      const haveBaseline = typeof data.__pristineText === 'string';
      const merged = {};
      for (const uid of new Set([...Object.keys(caller), ...Object.keys(disk), ...Object.keys(baseRows)])) {
        if (!/^\d{1,20}$/.test(uid)) continue;
        let prior;
        try { prior = Object.hasOwn(baseRows, uid) ? JSON.parse(baseRows[uid]) : undefined; }
        catch { prior = '!'; }
        if ([prior, caller[uid], disk[uid]].some(invalid)) {
          // Preserve a malformed user row rather than erasing possible denials.
          merged[uid] = [prior, caller[uid], disk[uid]].find(invalid);
          continue;
        }
        prior ||= {};
        const local = caller[uid] || {};
        const live = disk[uid] || {};
        const row = {};
        for (const key of new Set([...Object.keys(prior), ...Object.keys(local), ...Object.keys(live)])) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
          const before = prior[key], wanted = local[key], current = live[key];
          let value;
          if (!haveBaseline) value = wanted === current ? current : '!';
          else if (wanted === before) value = current;
          else if (current === before || wanted === current) value = wanted;
          else value = '!'; // Divergent changes deny rather than falling back to shared-by-default.
          if (value === '!') row[key] = value;
          else if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) row[key] = value;
          else if (value !== undefined) row[key] = '!';
        }
        if (Object.keys(row).length) merged[uid] = row;
      }
      data.config.proAccountGrants = merged;
    }
  }

  if (typeof data.orders === 'object' && data.orders !== null) {
    const diskOrders = liveDisk?.orders || {};
    for (const [oid, diskOrder] of Object.entries(diskOrders)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.orders, oid);
      const presentInCaller = Object.prototype.hasOwnProperty.call(data.orders, oid);
      if (!existedAtRead && !presentInCaller) {
        data.orders[oid] = diskOrder;
      } else if (existedAtRead && presentInCaller && JSON.stringify(data.orders[oid]) === base.orders[oid]) {
        data.orders[oid] = diskOrder;
      }
    }
  }

  if (data.config && typeof data.config.deletedAccounts === 'object') {
    const diskDeleted = liveDisk?.config?.deletedAccounts || {};
    for (const [dk, dVal] of Object.entries(diskDeleted)) {
      if (!dVal) continue;
      const existedDelAtRead = Object.prototype.hasOwnProperty.call(base.deleted, dk);
      const presentDelInCaller = Object.prototype.hasOwnProperty.call(data.config.deletedAccounts, dk);
      if (!existedDelAtRead || presentDelInCaller) {
        data.config.deletedAccounts[dk] = dVal;
        if (data.config.accounts && Object.prototype.hasOwnProperty.call(data.config.accounts, dk)) {
          delete data.config.accounts[dk];
        }
      }
    }
  }

  if (data.config && typeof data.config.accounts === 'object' && data.config.accounts !== null) {
    const diskAccounts = liveDisk?.config?.accounts || {};
    const callerDeleted = data.config.deletedAccounts || {};
    for (const ak of Object.keys(data.config.accounts)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.accounts, ak);
      const presentOnDisk = Object.prototype.hasOwnProperty.call(diskAccounts, ak);
      if (existedAtRead && !presentOnDisk) {
        delete data.config.accounts[ak];
      }
    }
    for (const [ak, diskAcc] of Object.entries(diskAccounts)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.accounts, ak);
      const presentInCaller = Object.prototype.hasOwnProperty.call(data.config.accounts, ak);
      const diskPhone = normalizeTenDigitPhone(diskAcc?.phone || diskAcc?.mobile || String(ak).replace(/^acc_/, ''));
      if (!existedAtRead && !presentInCaller && !isAccountTombstoned(callerDeleted, ak, diskPhone)) {
        data.config.accounts[ak] = diskAcc;
      } else if (existedAtRead && presentInCaller && JSON.stringify(data.config.accounts[ak]) === base.accounts[ak]) {
        data.config.accounts[ak] = diskAcc;
      }
    }
  }

  // FINAL UNCONDITIONAL SAFETY: Purge any account from caller accounts that is tombstoned!
  purgeTombstonedAccounts(data);

  if (typeof data.sessionVault === 'object' && data.sessionVault !== null) {
    const diskVault = liveDisk?.sessionVault || {};
    for (const vk of Object.keys(data.sessionVault)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.vault, vk);
      const presentOnDisk = Object.prototype.hasOwnProperty.call(diskVault, vk);
      if (existedAtRead && !presentOnDisk && JSON.stringify(data.sessionVault[vk]) === base.vault[vk]) {
        delete data.sessionVault[vk];
      }
    }
    for (const [vk, diskV] of Object.entries(diskVault)) {
      const existedAtRead = Object.prototype.hasOwnProperty.call(base.vault, vk);
      const presentInCaller = Object.prototype.hasOwnProperty.call(data.sessionVault, vk);
      if (!existedAtRead && !presentInCaller) {
        data.sessionVault[vk] = diskV;
      } else if (existedAtRead && presentInCaller && JSON.stringify(data.sessionVault[vk]) === base.vault[vk]) {
        data.sessionVault[vk] = diskV;
      }
    }
  }
  return true;
}

const UNSAFE_ORDER_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__']);
function isSafeOrderKeyStore(k) { const s = String(k||'').trim(); return s && !UNSAFE_ORDER_KEYS.has(s) && !s.startsWith('__'); }

export function upsertOrder(orderId, orderOrPatchFn) {
  if (!isSafeOrderKeyStore(orderId)) { console.warn('[upsertOrder] blocked unsafe key:', orderId); return null; }
  ensureDb();
  const db = getDb();
  if (!db.orders) db.orders = {};
  // Guard prototype pollution via hasOwnProperty
  const existing = Object.prototype.hasOwnProperty.call(db.orders, orderId) ? db.orders[orderId] : null;
  if (typeof orderOrPatchFn === 'function') {
    const updated = orderOrPatchFn(existing, db);
    if (updated === null) {
      delete db.orders[orderId];
    } else if (updated) {
      db.orders[orderId] = updated;
    }
  } else if (orderOrPatchFn === null) {
    delete db.orders[orderId];
  } else if (orderOrPatchFn && typeof orderOrPatchFn === 'object') {
    db.orders[orderId] = { ...(existing || {}), ...orderOrPatchFn };
  }
  saveDb(db);
  return Object.prototype.hasOwnProperty.call(db.orders, orderId) ? db.orders[orderId] : null;
}

export function mutateDb(updater) {
  ensureDb();
  const data = getDb();
  const result = updater(data);
  saveDb(data);
  return { data, result };
}

export const ORDER_STATES = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

export function canTransitionOrder(currentStatus, targetStatus) {
  if (!currentStatus) return targetStatus === 'PENDING';
  if (currentStatus === targetStatus) return true;
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(currentStatus)) {
    return false;
  }
  if (currentStatus === 'PENDING') {
    return ['ACCEPTED', 'WAITING_CONFIRMATION', 'AMOUNT_CONFIRMED', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'WAITING_CONFIRMATION') {
    return ['AMOUNT_CONFIRMED', 'ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'AMOUNT_CONFIRMED') {
    return ['ACCEPTED', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(targetStatus);
  }
  if (currentStatus === 'ACCEPTED') {
    return ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(targetStatus);
  }
  return true;
}

export function isBoss(userId) {
  const idNum = Number(userId);
  if (!idNum) return false;
  const envBossId = Number(process.env.BOSS_ID || 0);
  if (envBossId && idNum === envBossId) return true;
  const db = getDb();
  return (db.config?.bossIds || []).map(Number).includes(idNum);
}

export function addBoss(userId) {
  const db = getDb();
  const idNum = Number(userId);
  if (!db.config.bossIds.includes(idNum)) {
    db.config.bossIds.push(idNum);
    saveDb(db);
  }
}

export function isServicePaused() {
  const db = getDb();
  return Boolean(db.config?.servicePaused);
}

export function setServicePaused(paused, notice = null) {
  const db = getDb();
  if (!db.config) db.config = {};
  db.config.servicePaused = Boolean(paused);
  if (notice !== null && notice !== undefined) {
    db.config.servicePausedNotice = String(notice).trim();
  }
  saveDb(db);
  return db.config.servicePaused;
}

export function recordKnownUser(from) {
  if (!from || !from.id) return;
  try {
    const db = getDb();
    if (!db.knownUsers) db.knownUsers = {};
    const idStr = String(from.id);
    const existing = db.knownUsers[idStr];
    const username = from.username || '';
    const firstName = from.first_name || '';
    const lastName = from.last_name || '';
    const now = Date.now();
    if (!existing || existing.username !== username || existing.firstName !== firstName || (now - (existing.lastSeen || 0) > 3600000)) {
      db.knownUsers[idStr] = {
        id: from.id,
        username,
        firstName,
        lastName,
        phone: existing?.phone || '',
        lastSeen: now
      };
      saveDb(db);
    }
  } catch (err) {
    console.warn('[recordKnownUser] warning:', err?.message || err);
  }
}

export function recordUserPhone(userId, phone) {
  const p = normalizeTenDigitPhone(phone);
  if (!userId || !p) return false;
  try {
    const db = getDb();
    if (!db.knownUsers) db.knownUsers = {};
    const idStr = String(userId);
    if (!db.knownUsers[idStr]) {
      db.knownUsers[idStr] = { id: Number(userId), phone: p, lastSeen: Date.now() };
    } else {
      db.knownUsers[idStr].phone = p;
      db.knownUsers[idStr].lastSeen = Date.now();
    }
    saveDb(db);
    return true;
  } catch (err) {
    console.warn('[recordUserPhone] warning:', err?.message || err);
    return false;
  }
}

export function getUserLastDeliveryPhone(userId) {
  if (!userId) return '';
  const db = getDb();
  const knownPhone = normalizeTenDigitPhone(db.knownUsers?.[String(userId)]?.phone || '');
  if (knownPhone) return knownPhone;
  const orders = Object.values(db.orders || {})
    .filter(o => o && (String(o.userId) === String(userId) || String(o.chatId) === String(userId)))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  for (const o of orders) {
    const p = normalizeTenDigitPhone(
      o.addressDetails?.mobile ||
      o.recipientMobile ||
      o.phone ||
      (o.addressDetails?.mobileSource !== 'ACCOUNT_FALLBACK' ? o.addressDetails?.mobile : '')
    );
    const accPhone = normalizeTenDigitPhone(o.orderAccount || '');
    if (p && p !== accPhone) {
      return p;
    }
  }
  return '';
}

export function getAllBroadcastUserIds() {
  const db = getDb();
  const ids = new Set();
  if (db.knownUsers) {
    for (const k of Object.keys(db.knownUsers)) {
      const n = Number(k);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  if (db.orders) {
    for (const order of Object.values(db.orders)) {
      if (order?.userId && Number(order.userId) > 0) ids.add(Number(order.userId));
      if (order?.chatId && Number(order.chatId) > 0) ids.add(Number(order.chatId));
      if (order?.fwdSenderUserId && Number(order.fwdSenderUserId) > 0) ids.add(Number(order.fwdSenderUserId));
    }
  }
  if (db.drafts) {
    for (const k of Object.keys(db.drafts)) {
      const n = Number(k);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  if (db.userStates) {
    for (const k of Object.keys(db.userStates)) {
      const n = Number(k);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  return Array.from(ids);
}

export function setFamilyRole(userId, role) {
  const db = getDb();
  db.config.familyMembers[String(userId)] = role;
  saveDb(db);
}

export function getFamilyRole(userId, fallback = 'Parent') {
  const db = getDb();
  return db.config.familyMembers[String(userId)] || fallback;
}

export function getAccounts() {
  const db = getDb();
  return db.config.accounts || defaultData.config.accounts;
}

export function updateAccount(key, updates) {
  const db = getDb();
  if (!db.config.accounts) db.config.accounts = {};
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  if (!db.sessionVault) db.sessionVault = {};

  const merged = { ...(db.config.accounts[key] || {}), id: key, ...updates };
  const phone = normalizeTenDigitPhone(merged.phone || merged.mobile || '');
  if (phone) {
    merged.phone = phone;
    merged.mobile = phone;
  }

  delete db.config.deletedAccounts[key];
  if (phone && !isExplicitDifferentPhoneCloneKey(key, phone)) {
    delete db.config.deletedAccounts[`acc_${phone}`];
    delete db.config.deletedAccounts[phone];
  }

  if (merged.isLoggedIn) {
    delete merged.loggedOutAt;
    delete merged.isLoggedOut;
    merged.sessionExpired = false;
    merged.freshlyAuthenticated = true;
  }

  db.config.accounts[key] = merged;

  if (merged.isLoggedIn && phone) {
    consolidateDuplicatePhoneSlots(db, key, phone);
  }

  if (merged.isLoggedIn && (merged.cookies || merged.tid || merged.token)) {
    const cleanCookies = cleanEssentialSwiggyCookies(merged.cookies || '', merged);
    if (cleanCookies) merged.cookies = cleanCookies;
    const vaultKey = (!isExplicitDifferentPhoneCloneKey(key, phone) && phone) ? phone : key;
    db.sessionVault[vaultKey] = {
      account: key,
      name: merged.name || key,
      swiggyName: merged.swiggyName || '',
      mobile: phone,
      phone,
      customerId: merged.customerId || '',
      token: merged.token || '',
      tid: merged.tid || '',
      sid: merged.sid || '',
      deviceId: merged.deviceId || '',
      cookies: cleanCookies,
      savedAt: merged.savedAt || new Date().toISOString()
    };
  }

  if (merged.isLoggedIn && (!db.config.activeOrderAccount || !isAccountLoggedInSession(db.config.accounts[db.config.activeOrderAccount]))) {
    db.config.activeOrderAccount = key;
  }

  saveDb(db);
  syncAccountsJsonMirror(db);
  return db.config.accounts[key];
}

export function createAccount(key, name, phone = '', address = '') {
  const db = getDb();
  if (!db.config.accounts) db.config.accounts = {};
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  const cleanKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const cleanPhone = normalizeTenDigitPhone(phone);
  delete db.config.deletedAccounts[cleanKey];
  if (cleanPhone && !isExplicitDifferentPhoneCloneKey(cleanKey, cleanPhone)) {
    delete db.config.deletedAccounts[`acc_${cleanPhone}`];
    delete db.config.deletedAccounts[cleanPhone];
  }
  const existing = db.config.accounts[cleanKey] || {};
  db.config.accounts[cleanKey] = {
    ...existing,
    id: cleanKey,
    name: name || existing.name || (cleanKey.charAt(0).toUpperCase() + cleanKey.slice(1)),
    phone: cleanPhone || phone || existing.phone || '',
    mobile: cleanPhone || phone || existing.mobile || existing.phone || '',
    token: existing.token || '',
    address: address || existing.address || '',
    isLoggedIn: isAccountLoggedInSession(existing),
    createdAt: existing.createdAt || new Date().toISOString()
  };
  saveDb(db);
  return db.config.accounts[cleanKey];
}

export function getNextAutoUserName() {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const names = Object.values(accounts).map(a => (a.name || '').trim().toLowerCase());
  let num = 1;
  while (names.some(n => n === `user ${num}` || n.includes(`(user ${num})`))) {
    num++;
  }
  return `User ${num}`;
}

function pickNextActiveAccountKey(accounts, excludeKey = null) {
  for (const [k, a] of Object.entries(accounts || {})) {
    if (k !== excludeKey && isAccountLoggedInSession(a)) return k;
  }
  return null;
}

export function cleanupDiskFilesForAccount(phone, accountKey = '') {
  const cleanPhone = normalizeTenDigitPhone(phone || '') || String(phone || '').replace(/\D/g, '').slice(-10);
  const targets = new Set();
  if (cleanPhone && cleanPhone.length === 10) {
    targets.add(cleanPhone);
  }
  if (accountKey && typeof accountKey === 'string' && accountKey.trim()) {
    targets.add(accountKey.trim());
  }
  if (targets.size === 0) return 0;

  let deletedCount = 0;
  const searchDirs = [
    __dirname,
    path.join(__dirname, 'data'),
    path.join(__dirname, 'scratch')
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }

        // Never delete core codebase, config or database files
        if (file === 'db.json' || file === 'accounts.json' || file === 'package.json' || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          continue;
        }

        const lowerFile = file.toLowerCase();
        let matches = false;
        for (const t of targets) {
          if (lowerFile.includes(t.toLowerCase())) {
            matches = true;
            break;
          }
        }

        if (matches && (lowerFile.endsWith('.json') || lowerFile.endsWith('.txt') || lowerFile.endsWith('.log') || lowerFile.includes('sms') || lowerFile.includes('otp') || lowerFile.includes('session'))) {
          try {
            fs.unlinkSync(fullPath);
            deletedCount++;
            console.log(`[FileClean] Deleted old account file: ${fullPath}`);
          } catch (e) {
            console.warn(`[FileClean] Could not delete ${fullPath}:`, e.message);
          }
        }
      }
    } catch {}
  }
  return deletedCount;
}

export function deleteAccount(key, options = {}) {
  const db = getDb();
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  if (!db.config.accounts) db.config.accounts = {};
  db.config.deletedAccounts[key] = true;

  const acc = db.config?.accounts?.[key];
  const rawPhone = acc ? (acc.phone || acc.mobile || '') : String(key).replace(/^acc_/, '');
  const phone = normalizeTenDigitPhone(rawPhone);
  const isCloneKey = isExplicitDifferentPhoneCloneKey(key, phone);

  const removedKeys = new Set([key]);
  let existed = Boolean(db.config?.accounts?.[key]);
  if (existed) {
    delete db.config.accounts[key];
  }

  // If this is a real account slot (not an explicit test clone `acc_<different_digits>`), also tombstone & remove any duplicate custom/auto slot for the same phone!
  if (phone && !isCloneKey) {
    db.config.deletedAccounts[`acc_${phone}`] = true;
    for (const [sibKey, sibAcc] of Object.entries(db.config.accounts)) {
      if (!sibAcc || isExplicitDifferentPhoneCloneKey(sibKey, phone)) continue;
      const sibPhone = normalizeTenDigitPhone(sibAcc.phone || sibAcc.mobile || String(sibKey).replace(/^acc_/, ''));
      if (sibPhone === phone) {
        db.config.deletedAccounts[sibKey] = true;
        delete db.config.accounts[sibKey];
        removedKeys.add(sibKey);
        existed = true;
      }
    }
  }

  if (options.purgeVault && db.sessionVault) {
    if (phone && !isCloneKey) delete db.sessionVault[phone];
    for (const rk of removedKeys) delete db.sessionVault[rk];
  }

  if (db.config.activeOrderAccount && removedKeys.has(db.config.activeOrderAccount)) {
    const nextKey = pickNextActiveAccountKey(db.config.accounts, null);
    if (nextKey) db.config.activeOrderAccount = nextKey;
    else delete db.config.activeOrderAccount;
  }

  // Automatically delete all old session JSON and SMS/OTP files on disk for this account
  if (options.cleanupFiles !== false) {
    cleanupDiskFilesForAccount(phone, key);
  }

  saveDb(db);
  syncAccountsJsonMirror(db);
  if (!options.skipImmediateCloudPush) {
    syncCloudVaultNow(db).catch(() => {});
  }
  return existed;
}

// An order is still "active" while money/QR/tracking can still happen. Only the
// terminal states close it — otherwise a customer could create a second order
// while the first one sits in APPROVAL_PENDING / PAYMENT_PENDING and pay twice.
// Anything older than 12h is treated as stale so a stuck order never blocks a
// customer forever.
const TERMINAL_ORDER_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'REJECTED']);
const ACTIVE_ORDER_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function getActiveUserOrder(userId) {
  const db = getDb();
  const idNum = Number(userId);
  const now = Date.now();
  const userOrders = Object.values(db.orders || {}).filter(o => o && Number(o.userId) === idNum);

  return userOrders
    .filter(o => !TERMINAL_ORDER_STATUSES.has(String(o.status || '').toUpperCase()))
    .filter(o => {
      // Legacy PENDING/ACCEPTED orders are kept as-is (old behaviour), anything
      // newer also counts while its createdAt is fresh.
      if (['PENDING', 'ACCEPTED'].includes(o.status) && !o.createdAt) return true;
      const created = new Date(o.createdAt || o.updatedAt || 0).getTime();
      return Number.isFinite(created) && created > 0 ? (now - created) <= ACTIVE_ORDER_MAX_AGE_MS : true;
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || undefined;
}

export function getDraft(userId) {
  const db = getDb();
  if (!db.drafts[userId]) {
    db.drafts[userId] = {
      address: null,
      cart: null,
      submitted: false,
      currentOrderId: null
    };
    saveDb(db);
  }
  return db.drafts[userId];
}

export function updateDraft(userId, updates) {
  const db = getDb();
  db.drafts[userId] = { ...(db.drafts[userId] || {}), ...updates };
  saveDb(db);
  return db.drafts[userId];
}

export function clearDraft(userId, { clearMiniAppLinks = false } = {}) {
  const db = getDb();
  const links = db.drafts?.[userId]?.miniAppLinks;
  db.drafts[userId] = {
    address: null,
    cart: null,
    submitted: false,
    currentOrderId: null,
    // Closing an older chat order must not erase newer Mini App handoff links.
    ...(!clearMiniAppLinks && links ? { miniAppLinks: links } : {})
  };
  saveDb(db);
  return db.drafts[userId];
}

// Exports COMPLETE 100% self-contained Swiggy Session JSON (including full essential `cookies` + `_session_tid`)
export function exportSessionJson(key) {
  const db = getDb();
  const acc = db.config.accounts?.[key];
  const fallbackPhone = acc ? String(acc.phone || acc.mobile || '').replace(/[^0-9]/g, '').slice(-10) : String(key).replace(/^acc_/, '');
  const vault = db.sessionVault?.[fallbackPhone] || db.sessionVault?.[key] || null;
  const source = (acc && acc.cookies) ? acc : (vault || acc);

  if (!source || (!source.cookies && !source.tid)) return null;

  const cleanCookies = cleanEssentialSwiggyCookies(source.cookies || '', source);

  let token = source.token || '';
  if (!token && cleanCookies) {
    const m = cleanCookies.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) token = m[1];
  }

  let tid = source.tid || '';
  if ((!tid || !tid.includes('.')) && cleanCookies) {
    const tm = cleanCookies.match(/(?:^|;\s*)tid=([^;]+)/);
    if (tm) tid = tm[1];
  }

  let sid = source.sid || '';
  if (!sid && cleanCookies) {
    const sm = cleanCookies.match(/(?:^|;\s*)_sid=([^;]+)/);
    if (sm) sid = sm[1];
  }

  let deviceId = source.deviceId || '';
  if (!deviceId && cleanCookies) {
    const dm = cleanCookies.match(/(?:^|;\s*)_device_id=([^;]+)/);
    if (dm) deviceId = dm[1];
  }

  let customerId = source.customerId || source.userId || '';
  if (!customerId && tid && tid.includes('.')) {
    try {
      const payload = tid.split('.')[1];
      if (payload) {
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        customerId = decoded.user_id || decoded.sub || '';
      }
    } catch (e) {}
  }

  const phone = source.phone || source.mobile || fallbackPhone || '';

  return {
    account: key,
    name: source.name || key,
    ...(source.swiggyName ? { swiggyName: source.swiggyName } : {}),
    mobile: phone,
    phone,
    customerId,
    token,
    tid,
    sid,
    deviceId,
    cookies: cleanCookies,
    totalOrdersCount: typeof source.totalOrdersCount === 'number' ? source.totalOrdersCount : 0,
    isZeroOrderAccount: source.totalOrdersCount === 0 || Boolean(source.isZeroOrderAccount),
    savedAt: source.savedAt || new Date().toISOString()
  };
}

export function importSessionJson(rawJson, targetKey = null) {
  try {
    const list = extractSwiggyAccountsListFromInput(rawJson);
    if (!list.length) {
      return { success: false, message: 'Invalid session JSON: missing cookies / tid / token' };
    }

    const db = getDb();
    if (!db.config.accounts) db.config.accounts = {};
    if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
    if (!db.sessionVault) db.sessionVault = {};

    const results = [];
    for (let idx = 0; idx < list.length; idx++) {
      const data = list[idx];
      const cleanPhone = data.phone || '';
      const cookieStrPre = cleanEssentialSwiggyCookies(data.cookies || '', data);
      const extractFromCookiePre = (name) => {
        const m = cookieStrPre.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        return m ? m[1] : '';
      };
      const tidPre = data.tid || extractFromCookiePre('tid') || '';
      let customerIdPre = data.customerId || '';
      if (!customerIdPre && tidPre && tidPre.includes('.')) {
        try {
          const payload = tidPre.split('.')[1];
          if (payload) {
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
            if (decoded?.user_id && String(decoded.user_id) !== '0' && String(decoded.user_id) !== '-1') {
              customerIdPre = String(decoded.user_id);
            }
          }
        } catch {}
      }

      const existingByPhoneKey = (!targetKey || list.length > 1) && cleanPhone
        ? findAccountKeyByPhone(db.config.accounts, cleanPhone)
        : null;
      const key = (list.length === 1 && targetKey)
        ? targetKey
        : (existingByPhoneKey || (cleanPhone
          ? `acc_${cleanPhone}`
          : (data.account || (customerIdPre ? `acc_cid_${customerIdPre}` : `acc_${Date.now()}_${idx}`))));

      // Recover full cookies from vault if user pasted an older partial JSON without `_session_tid`
      const vaultBackup = db.sessionVault[cleanPhone] || db.sessionVault[key] || null;
      let rawCookies = data.cookies || '';
      if ((!rawCookies || !rawCookies.includes('_session_tid=')) && vaultBackup?.cookies?.includes('_session_tid=')) {
        rawCookies = `${vaultBackup.cookies}; ${rawCookies}`;
      }

      const cookieStr = cleanEssentialSwiggyCookies(rawCookies, data);
      const extractFromCookie = (name) => {
        const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        return m ? m[1] : '';
      };

      const tid = data.tid || extractFromCookie('tid') || '';
      const sessionTid = extractFromCookie('_session_tid') || data._session_tid || (!tid.includes('.') && tid.length >= 64 ? tid : '');
      const token = data.token || extractFromCookie('token') || tid || '';
      const sid = data.sid || extractFromCookie('_sid') || '';
      const deviceId = data.deviceId || extractFromCookie('_device_id') || '';
      const customerId = customerIdPre;

      delete db.config.deletedAccounts[key];
      if (cleanPhone && !isExplicitDifferentPhoneCloneKey(key, cleanPhone)) {
        delete db.config.deletedAccounts[`acc_${cleanPhone}`];
        delete db.config.deletedAccounts[cleanPhone];
      }
      if (!db.config.accounts[key]) {
        db.config.accounts[key] = { id: key, name: data.name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User') };
      }

      const nextAccountObj = {
        ...db.config.accounts[key],
        id: key,
        mobile: cleanPhone || db.config.accounts[key].mobile || db.config.accounts[key].phone || '',
        phone: cleanPhone || db.config.accounts[key].phone || db.config.accounts[key].mobile || '',
        ...(data.swiggyName ? { swiggyName: data.swiggyName } : {}),
        name: data.name || db.config.accounts[key].name || (cleanPhone ? `Swiggy ${cleanPhone}` : 'Swiggy User'),
        customerId: customerId || db.config.accounts[key].customerId || '',
        ...(sessionTid ? { _session_tid: sessionTid } : {}),
        token: token || db.config.accounts[key].token || '',
        tid: tid || db.config.accounts[key].tid || '',
        sid: sid || db.config.accounts[key].sid || '',
        deviceId: deviceId || db.config.accounts[key].deviceId || '',
        cookies: cookieStr,
        // A count that came from an uploaded `.json` file is NEVER trusted.
        // Only a live Swiggy answer (`ordersVerifiedLive === true`) may set the
        // order count — otherwise the existing (verified) value is kept as-is.
        ...(data.ordersVerifiedLive === true && typeof data.totalOrdersCount === 'number' && data.totalOrdersCount !== 999999 ? {
          totalOrdersCount: data.totalOrdersCount,
          cachedTotalOrdersCount: data.totalOrdersCount,
          ordersVerifiedLive: true,
          orderCountSource: 'LIVE',
          isZeroOrderAccount: data.totalOrdersCount === 0
        } : {}),
        isLoggedIn: true,
        freshlyAuthenticated: true,
        savedAt: new Date().toISOString()
      };
      delete nextAccountObj.loggedOutAt;
      db.config.accounts[key] = nextAccountObj;

      const finalPhone = normalizeTenDigitPhone(db.config.accounts[key].phone) || db.config.accounts[key].phone;
      consolidateDuplicatePhoneSlots(db, key, finalPhone);

      const vaultKey = (!isExplicitDifferentPhoneCloneKey(key, finalPhone) && finalPhone) ? finalPhone : key;
      db.sessionVault[vaultKey] = {
        account: key,
        name: db.config.accounts[key].name,
        swiggyName: db.config.accounts[key].swiggyName || '',
        mobile: finalPhone,
        phone: finalPhone,
        customerId: db.config.accounts[key].customerId,
        token: db.config.accounts[key].token,
        tid: db.config.accounts[key].tid,
        sid: db.config.accounts[key].sid,
        deviceId: db.config.accounts[key].deviceId,
        cookies: cookieStr,
        savedAt: db.config.accounts[key].savedAt
      };

      if (!db.config.activeOrderAccount || !isAccountLoggedInSession(db.config.accounts[db.config.activeOrderAccount])) {
        db.config.activeOrderAccount = key;
      }

      results.push({
        success: true,
        key,
        account: key,
        accountObj: db.config.accounts[key],
        name: db.config.accounts[key].name,
        phone: db.config.accounts[key].phone,
        mobile: db.config.accounts[key].mobile,
        customerId: db.config.accounts[key].customerId,
        token: db.config.accounts[key].token,
        totalOrdersCount: db.config.accounts[key].totalOrdersCount,
        isZeroOrderAccount: db.config.accounts[key].isZeroOrderAccount
      });
    }

    // Single atomic disk write + `accounts.json` mirror + Cloud Vault schedule across ALL imported files!
    saveDb(db);
    syncAccountsJsonMirror(db);

    return {
      ...results[0],
      importedCount: results.length,
      accounts: results
    };
  } catch (err) {
    return { success: false, message: 'Invalid JSON format: ' + err.message };
  }
}

export function getActiveOrderAccountKey() {
  const db = getDb();
  if (db.config?.activeOrderAccount && isAccountLoggedInSession(db.config?.accounts?.[db.config.activeOrderAccount])) {
    return db.config.activeOrderAccount;
  }
  for (const [k, a] of Object.entries(db.config?.accounts || {})) {
    if (isAccountLoggedInSession(a)) return k;
  }
  const first = Object.keys(db.config?.accounts || {})[0];
  return first || null;
}

export function setActiveOrderAccountKey(key) {
  const db = getDb();
  if (!db.config) db.config = {};
  db.config.activeOrderAccount = key;
  saveDb(db);
  return db.config.accounts?.[key] || null;
}

// Permanently logs out and purges account from active pool and tombstones so Cloud Vault never revives it
export function permanentLogoutAccount(key, { purgeVault = true, cleanupFiles = true } = {}) {
  const db = getDb();
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  if (!db.config.accounts) db.config.accounts = {};
  const acc = db.config?.accounts?.[key];
  if (!acc) {
    db.config.deletedAccounts[key] = true;
    saveDb(db);
    syncAccountsJsonMirror(db);
    syncCloudVaultNow(db).catch(() => {});
    return null;
  }

  const rawPhone = acc.phone || acc.mobile || '';
  const phone = normalizeTenDigitPhone(rawPhone) || String(rawPhone).replace(/[^0-9]/g, '').slice(-10);
  const isCloneKey = isExplicitDifferentPhoneCloneKey(key, phone);

  // Tombstone so hydrateAccountsFromCloudVault NEVER re-imports it as logged-in
  db.config.deletedAccounts[key] = true;
  if (phone && !isCloneKey) {
    db.config.deletedAccounts[`acc_${phone}`] = true;
    db.config.deletedAccounts[phone] = true;
  }

  acc.isLoggedIn = false;
  acc.isLoggedOut = true;
  acc.loggedOutAt = new Date().toISOString();
  delete acc.freshlyAuthenticated;
  acc.cookies = '';
  acc.tid = '';
  acc.sid = '';
  acc.token = '';
  acc.jwtTid = '';
  acc._session_tid = '';
  acc.deviceId = '';

  // Delete from active accounts dictionary
  delete db.config.accounts[key];
  if (phone && !isCloneKey) {
    for (const [sibKey, sibAcc] of Object.entries(db.config.accounts || {})) {
      if (!sibAcc || isExplicitDifferentPhoneCloneKey(sibKey, phone)) continue;
      const sibPhone = normalizeTenDigitPhone(sibAcc.phone || sibAcc.mobile || String(sibKey).replace(/^acc_/, ''));
      if (sibPhone === phone) {
        db.config.deletedAccounts[sibKey] = true;
        delete db.config.accounts[sibKey];
      }
    }
  }

  // Purge from sessionVault so old tokens never leak back into future scans
  if (purgeVault && db.sessionVault) {
    if (phone && !isCloneKey) delete db.sessionVault[phone];
    delete db.sessionVault[key];
  }

  if (db.config.activeOrderAccount === key) {
    const nextKey = pickNextActiveAccountKey(db.config.accounts, key);
    if (nextKey) db.config.activeOrderAccount = nextKey;
    else delete db.config.activeOrderAccount;
  }

  // Delete all old session JSON and SMS files on disk
  if (cleanupFiles !== false) {
    cleanupDiskFilesForAccount(phone, key);
  }

  saveDb(db);
  syncAccountsJsonMirror(db);
  syncCloudVaultNow(db).catch(() => {});
  appendAuditEvent('logout', { accountKey: key, phone: phone || '' });
  return acc;
}

// Completely logs out and purges ALL accounts across DB, Session Vault, accounts.json, and Cloud Vault
export function logoutAllAccounts({ purgeVault = true, cleanupFiles = true } = {}) {
  const db = getDb();
  if (!db.config.deletedAccounts) db.config.deletedAccounts = {};
  if (!db.config.accounts) db.config.accounts = {};
  if (!db.sessionVault) db.sessionVault = {};

  const allKeys = new Set([
    ...Object.keys(db.config.accounts || {}),
    ...Object.keys(db.sessionVault || {})
  ]);

  let count = 0;
  for (const k of allKeys) {
    const acc = db.config.accounts[k] || db.sessionVault[k];
    const rawPhone = acc?.phone || acc?.mobile || String(k).replace(/^acc_/, '');
    const phone = normalizeTenDigitPhone(rawPhone);

    db.config.deletedAccounts[k] = true;
    if (phone) {
      db.config.deletedAccounts[`acc_${phone}`] = true;
      db.config.deletedAccounts[phone] = true;
    }
    delete db.config.accounts[k];
    if (purgeVault) {
      delete db.sessionVault[k];
      if (phone) delete db.sessionVault[phone];
    }
    if (cleanupFiles !== false) {
      cleanupDiskFilesForAccount(phone, k);
    }
    count++;
  }

  db.config.accounts = {};
  if (purgeVault) {
    db.sessionVault = {};
  }
  delete db.config.activeOrderAccount;

  // Clear accounts.json mirror
  try {
    fs.writeFileSync(getAccountsJsonFile(), '[]', 'utf-8');
  } catch {}

  saveDb(db);
  syncAccountsJsonMirror(db);
  syncCloudVaultNow(db).catch(() => {});
  appendAuditEvent('logout_all', { count });
  return count;
}


// =========================================================================
// V16 SECURITY, MASKING, OTP 3-STRIKE LOCK & STRUCTURED AUDIT LOG HELPERS
// =========================================================================

export function maskPhoneStars(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 4) return `****${digits.slice(-4)}`;
  return '****0000';
}

export function maskAccountCode(accOrKey = '') {
  if (accOrKey && typeof accOrKey === 'object') {
    const digits = String(accOrKey.phone || accOrKey.mobile || accOrKey.id || '').replace(/\D/g, '');
    if (digits.length >= 4) return `AC-${digits.slice(-4)}`;
  }
  const digits = String(accOrKey || '').replace(/\D/g, '');
  if (digits.length >= 4) return `AC-${digits.slice(-4)}`;
  return `AC-${String(accOrKey || '0000').slice(-4).toUpperCase()}`;
}

export function redactSensitiveText(input = '') {
  return String(input || '')
    .replace(/(_session_tid\s*=\s*)[^;\s"'}]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:_session_tid|session_id|token|tid|jwt|cookies|cookie)["']?\s*:\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2');
}

export function exportSafeRedactedSessionJson(key) {
  const db = getDb();
  const acc = db?.config?.accounts?.[key] || db?.sessionVault?.[String(key || '').replace(/^acc_/, '')];
  if (!acc) return null;
  const payload = {
    account_code: maskAccountCode(acc),
    phone: maskPhoneStars(acc.phone || acc.mobile || key),
    session_id: '[REDACTED]',
    token: '[REDACTED]',
    is_logged_in: Boolean(acc.isLoggedIn),
    previous_orders: Number(acc.totalOrdersCount || 0),
    zero_order_eligible: Boolean(acc.isZeroOrderAccount || Number(acc.totalOrdersCount || 0) === 0),
    saved_at: acc.savedAt || new Date().toISOString()
  };
  return JSON.stringify(payload, null, 2);
}

const otpAttemptTracker = new Map();

export function getOtpLockStatus(phone = '') {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!clean) return { locked: false, failures: 0, remainingAttempts: 3, unlockAt: null };
  const entry = otpAttemptTracker.get(clean);
  if (!entry) return { locked: false, failures: 0, remainingAttempts: 3, unlockAt: null };
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return {
      locked: true,
      failures: entry.failures,
      remainingAttempts: 0,
      unlockAt: new Date(entry.lockedUntil).toISOString(),
      retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    };
  }
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    otpAttemptTracker.delete(clean);
    return { locked: false, failures: 0, remainingAttempts: 3, unlockAt: null };
  }
  return {
    locked: false,
    failures: entry.failures,
    remainingAttempts: Math.max(0, 3 - entry.failures),
    unlockAt: null
  };
}

export function recordOtpAttempt(phone = '', succeeded = false, { lockMs = 15 * 60 * 1000 } = {}) {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!clean) return { locked: false, failures: 0, remainingAttempts: 3 };
  if (succeeded) {
    otpAttemptTracker.delete(clean);
    appendAuditEvent('otp_verified', { phone: maskPhoneStars(clean) });
    return { locked: false, failures: 0, remainingAttempts: 3 };
  }
  const prev = getOtpLockStatus(clean);
  if (prev.locked) return prev;
  const failures = prev.failures + 1;
  const lockedUntil = failures >= 3 ? Date.now() + lockMs : null;
  otpAttemptTracker.set(clean, { failures, lockedUntil });
  if (lockedUntil) {
    appendAuditEvent('otp_locked', { phone: maskPhoneStars(clean), failures });
  } else {
    appendAuditEvent('otp_failed', { phone: maskPhoneStars(clean), failures });
  }
  return getOtpLockStatus(clean);
}

export function resetOtpLock(phone = '') {
  const clean = String(phone || '').replace(/\D/g, '').slice(-10);
  otpAttemptTracker.delete(clean);
}

// --- Robust instant order ID generator (no collisions, no hours delay) ---
let _lastOrderMs = 0;
let _orderSeqInMs = 0;
export function generateOrderId() {
  const now = Date.now();
  if (now === _lastOrderMs) {
    _orderSeqInMs = (_orderSeqInMs + 1) % 100;
  } else {
    _lastOrderMs = now;
    _orderSeqInMs = 0;
  }
  // 6-digit base from timestamp + 2-digit seq/random to guarantee uniqueness in same ms
  const base = String(now).slice(-6);
  const suffix = String(_orderSeqInMs).padStart(2, '0');
  let candidate = `${base}${suffix}`.slice(-6);
  // Ensure not already in DB (extremely rare, but handle burst)
  try {
    const db = getDb();
    let tries = 0;
    while (db.orders && db.orders[candidate] && tries < 5) {
      candidate = String((parseInt(candidate, 10) + 1) % 1000000).padStart(6, '0');
      tries++;
    }
    if (db.orders && db.orders[candidate]) {
      candidate = String(now).slice(-5) + String(Math.floor(Math.random() * 10));
      candidate = candidate.slice(-6);
    }
  } catch {}
  return candidate;
}

export function appendAuditEvent(action, meta = {}) {
  try {
    const db = getDb();
    if (!Array.isArray(db.auditLog)) db.auditLog = [];
    const safeMeta = {};
    for (const [k, v] of Object.entries(meta || {})) {
      if (/cookie|token|tid|secret|password/i.test(k)) {
        safeMeta[k] = '[REDACTED]';
      } else if (/phone|mobile/i.test(k) && v) {
        safeMeta[k] = String(v).startsWith('****') ? String(v) : maskPhoneStars(v);
      } else if (typeof v === 'string') {
        safeMeta[k] = redactSensitiveText(v).slice(0, 240);
      } else {
        safeMeta[k] = v;
      }
    }
    db.auditLog.push({
      id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: String(action || 'event'),
      meta: safeMeta,
      at: new Date().toISOString()
    });
    if (db.auditLog.length > 300) {
      db.auditLog = db.auditLog.slice(-300);
    }
    saveDb(db);
  } catch {}
}

// ── DB HYGIENE (memory/disk blast door) ─────────────────────────────────────
// Orders ke andar jo kuch sirf debug ke liye tha, woh hamesha ke liye pada rehta
// tha aur har getDb()/saveDb() me copy hota tha. 10 orders ke baad memory aur
// disk dono bhar jaate the. Yeh pruner purane bhaari fields saaf karta hai aur
// purane band orders ko chhota kar deta hai (paise/receipt fields chhod kar).
const HEAVY_ORDER_FIELDS = [
  'availableCoupons', 'couponCandidates', 'liveCartSnapshot', 'cartSnapshot',
  'lastCartPayload', 'swiggyRawPayload', 'rawPlaceResponse', 'rawPlaceJson',
  'offerScanHistory', 'freeCashAttempts', 'qrScreenshotBase64', 'checkoutScreenshotBase64'
];

export function pruneDbForPerformance(db = null, { keepOrders = 400, stripAfterMs = 3 * 24 * 60 * 60 * 1000 } = {}) {
  const data = db || getDb();
  let stripped = 0;
  let removed = 0;
  try {
    const now = Date.now();
    const orders = data.orders || {};
    const ids = Object.keys(orders);
    for (const id of ids) {
      const o = orders[id];
      if (!o || typeof o !== 'object') continue;
      const ended = Date.parse(String(o.completedAt || o.paidAt || o.cancelledAt || o.updatedAt || o.createdAt || '')) || 0;
      const finished = ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(o.status || ''));
      if (finished || (ended && now - ended > stripAfterMs)) {
        for (const f of HEAVY_ORDER_FIELDS) {
          if (o[f] !== undefined) {
            delete o[f];
            stripped += 1;
          }
        }
        if (Array.isArray(o.events) && o.events.length > 40) o.events = o.events.slice(-40);
        if (Array.isArray(o.timeline) && o.timeline.length > 40) o.timeline = o.timeline.slice(-40);
      }
    }
    // sabse purane band orders hatao (sirf jab bahut zyada ho gaye ho)
    if (ids.length > keepOrders) {
      const removable = ids
        .filter((id) => ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(orders[id]?.status || '')))
        .sort((a, b) => (Date.parse(String(orders[a]?.createdAt || '')) || 0) - (Date.parse(String(orders[b]?.createdAt || '')) || 0));
      const excess = ids.length - keepOrders;
      for (const id of removable.slice(0, excess)) {
        delete orders[id];
        removed += 1;
      }
    }
    // event/audit lists ko bound karo
    if (Array.isArray(data.auditLog) && data.auditLog.length > 300) data.auditLog = data.auditLog.slice(-300);
    if (Array.isArray(data.config?.accountHealthEvents) && data.config.accountHealthEvents.length > 120) {
      data.config.accountHealthEvents = data.config.accountHealthEvents.slice(-120);
    }
    for (const uid of Object.keys(data.userStates || {})) {
      const st = data.userStates[uid];
      if (st && typeof st === 'object') {
        for (const f of HEAVY_ORDER_FIELDS) delete st[f];
        if (Array.isArray(st.history) && st.history.length > 30) st.history = st.history.slice(-30);
      }
    }
  } catch {}
  // Prune ka asar bhi save hona chahiye — warna memory free hoti dikhti hai,
  // hoti nahi (pehle sirf ek copy mutate ho kar fenki jaati thi).
  if (!db && (stripped > 0 || removed > 0)) {
    try { saveDb(data); } catch {}
  }
  return { stripped, removed };
}

// Async write mode me shutdown par pending write kabhi na ude.
if (DB_ASYNC_WRITE && !globalThis.__dbFlushHooksInstalled) {
  globalThis.__dbFlushHooksInstalled = true;
  const safeFlush = () => { try { flushDbSync(); } catch {} };
  process.on('exit', safeFlush);
  process.once('SIGTERM', safeFlush);
  process.once('SIGINT', safeFlush);
  process.once('beforeExit', safeFlush);
}
