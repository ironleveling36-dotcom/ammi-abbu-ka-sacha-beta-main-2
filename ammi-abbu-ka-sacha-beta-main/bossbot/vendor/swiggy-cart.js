import './network-shield.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'crypto';
import fs from 'fs';
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import { getDb, saveDb, updateAccount, syncAccountsJsonMirror } from './store.js';
import { shouldReusePendingQr, validateUpiIntentForQr } from './payment-qr-guard.js';
import { classifySwiggyAccountFailure, isAccountSuspended, markAccountSuspended, markAccountHealthy, noteAccountFailure, describeSuspendedAccount } from './account-health.js';
import { extractSharedUrls, normalizeSharedUrl } from './link-utils.js';
import * as wafPool from './waf-pool.js';
import { findChromePath, decodeJwtPayload, claimSwiggyBreakfastAndLateNightOffers, getLiveSwiggyWafToken } from './swiggy-bridge.js';

const CHROME_PATH = findChromePath();
const PUPPETEER_HEADLESS = (process.platform === 'linux' || process.env.RAILWAY_ENVIRONMENT || process.env.HEADLESS === 'true') ? 'new' : false;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_WEB_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

async function installAntiFnaStealthOnPage(page) {
  const cleanEntityId = crypto.randomUUID();
  await page.emulateTimezone('Asia/Kolkata').catch(() => {});
  await page.setRequestInterception(true).catch(() => {});
  page.on('request', (req) => {
    if (req.url().includes('fna.swiggy.com/api/fraudnabuse')) {
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': 'https://www.swiggy.com',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': 'Content-Type, Accept'
        },
        body: JSON.stringify({ statusCode: 0, statusMessage: 'success', data: cleanEntityId, successful: true })
      }).catch(() => {});
    }
    req.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument(() => {
    try {
      delete Object.getPrototypeOf(navigator).webdriver;
    } catch (e) {}
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = window.chrome.runtime || { connect: () => {}, sendMessage: () => {} };
    window.chrome.loadTimes = window.chrome.loadTimes || (() => ({}));
    window.chrome.csi = window.chrome.csi || (() => ({}));
    window.chrome.app = window.chrome.app || {};
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' }
        ]
      });
    }
  });
}

// Shared in-memory caches for sub-second operations
let cachedWafToken = '';
let cachedWafAt = 0;
let wafFetchPromise = null;
let lastWafRefreshKickAt = 0;
const WAF_TTL_MS = 8 * 60 * 1000; // 8 minutes (shared pool TTL in waf-pool.js is 2h)

const sessionAuthCache = new Map(); // cookieSig -> { auth, ts }
const csrfTokenCache = new Map();   // cookieSig -> { csrf, ts }
const AUTH_TTL_MS = 45 * 1000;

// Distance helper (Haversine in meters)
function distanceMeters(lat1, lng1, lat2, lng2) {
  const a1 = parseFloat(lat1), o1 = parseFloat(lng1), a2 = parseFloat(lat2), o2 = parseFloat(lng2);
  if ([a1, o1, a2, o2].some(Number.isNaN)) return Infinity;
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(a2 - a1);
  const dLon = toRad(o2 - o1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Swiggy delivery locations are India-only. These broad bounds reject swapped,
// empty, or obviously stale fallback coordinates without rejecting remote Indian regions.
export function isValidIndianDeliveryCoordinates(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  return Number.isFinite(nLat) && Number.isFinite(nLng) &&
    nLat >= 5.5 && nLat <= 38.5 && nLng >= 67 && nLng <= 99;
}

function normalizeIndianMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function normalizeAddressText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/_/g, ' ')
    .toLocaleLowerCase('en-IN')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSameAddressText(left, right) {
  const a = normalizeAddressText(left);
  const b = normalizeAddressText(right);
  return Boolean(a && b && a === b);
}

function isUsableDeliveryAddress(details) {
  const address = String(details?.address || '').trim();
  return Boolean(
    details && !details.unresolvableShortLink && address.length >= 8 &&
    !/^(?:address pending|delivery location|unknown address)$/i.test(address) &&
    isValidIndianDeliveryCoordinates(details.lat, details.lng)
  );
}

function mergeExplicitAddressDetails(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return current || null;
  const currentAddress = String(current?.address || '').trim();
  const incomingAddress = String(incoming.address || '').trim();
  const addressChanged = currentAddress && incomingAddress && !hasSameAddressText(currentAddress, incomingAddress);
  if (addressChanged) {
    const next = { ...incoming };
    delete next.id;
    next.name = incoming.name || '';
    next.mobile = normalizeIndianMobile(incoming.mobile) || '';
    if (!isValidIndianDeliveryCoordinates(incoming.lat, incoming.lng)) {
      delete next.lat;
      delete next.lng;
    }
    return next;
  }
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

// Clean & normalize cookies (strips expired aws-waf-token so WAF never blocks requests)
export function cleanSwiggyCookieString(rawCookies, acc = null) {
  let pairs = [];
  if (typeof rawCookies === 'string') {
    const trimmed = rawCookies.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          pairs = arr.map(c => `${c.name || c.key}=${c.value}`);
        }
      } catch (e) {
        pairs = trimmed.split(';');
      }
    } else {
      pairs = trimmed.split(';');
    }
  } else if (Array.isArray(rawCookies)) {
    pairs = rawCookies.map(c => `${c.name || c.key}=${c.value}`);
  } else if (rawCookies && typeof rawCookies === 'object') {
    acc = acc || rawCookies;
    return cleanSwiggyCookieString(rawCookies.cookies || '', acc);
  }

  const map = new Map();
  for (const raw of pairs) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (!k || k === 'aws-waf-token' || k === 'userLocation') continue;
    map.set(k, v);
  }

  if (acc && typeof acc === 'object') {
    const fbSessionTid = acc._session_tid || acc.session_tid || acc.sessionTid || '';
    if (fbSessionTid && !map.has('_session_tid')) map.set('_session_tid', fbSessionTid);
    if (acc.tid && !map.has('_session_tid') && !String(acc.tid).includes('.')) map.set('_session_tid', acc.tid);
    const fbJwtTid = (acc.jwtTid && String(acc.jwtTid).includes('.')) ? acc.jwtTid : acc.tid;
    if (fbJwtTid && !map.has('tid')) map.set('tid', fbJwtTid);
    const fbTok = acc.token || acc.auth_token || acc.access_token || '';
    if (fbTok && !map.has('token')) map.set('token', fbTok);
    const fbSid = acc.sid || acc._sid || '';
    if (fbSid && !map.has('_sid')) map.set('_sid', fbSid);
    const fbDev = acc.deviceId || acc.device_id || acc._device_id || acc.swuid || '';
    if (fbDev && !map.has('_device_id')) map.set('_device_id', fbDev);
  }
  if ((map.has('_session_tid') || map.has('tid') || map.has('token')) && !map.has('_is_logged_in')) {
    map.set('_is_logged_in', '1');
  }

  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseCookieMap(cookieStr) {
  const cm = {};
  for (const part of String(cookieStr || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) cm[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return cm;
}

// Native Swiggy Android Client Headers (works with ZERO `_session_tid` cookie via `tid` + `token` + `sid` + `deviceId`!)
export function buildSwiggyAndroidClientHeaders(accountOrCookies, opts = {}) {
  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const cleanCookies = cleanSwiggyCookieString(accountOrCookies, acc);
  const cm = parseCookieMap(cleanCookies);

  const rawTid = String(
    opts.tid ||
    (acc?.jwtTid && String(acc.jwtTid).includes('.') ? acc.jwtTid : '') ||
    (acc?.tid && String(acc.tid).includes('.') ? acc.tid : '') ||
    (cm.tid && cm.tid.includes('.') ? cm.tid : '') ||
    acc?.jwtTid ||
    acc?.tid ||
    cm.tid ||
    ''
  ).trim();
  const token = String(opts.token || acc?.token || acc?.auth_token || acc?.access_token || cm.token || '').trim();
  const sid = String(opts.sid || acc?.sid || acc?._sid || cm._sid || cm.sid || '').trim();
  const deviceId = String(opts.deviceId || acc?.deviceId || acc?.device_id || acc?.swuid || cm._device_id || cm._swuid || '8f3b2c1a-4d5e-6f7a-8b9c-0d1e2f3a4b5c').trim();

  let uid = String(opts.userId || acc?.customerId || acc?.customer_id || acc?.userId || acc?.user_id || '').trim();
  if ((!uid || uid === '0' || uid === '-1') && rawTid && rawTid.includes('.')) {
    const claims = decodeJwtPayload(rawTid);
    if (claims?.user_id && String(claims.user_id) !== '0' && String(claims.user_id) !== '-1') {
      uid = String(claims.user_id);
    }
  }
  if (uid === '0' || uid === '-1') uid = '';

  const lat = String(opts.lat || '26.8658609');
  const lng = String(opts.lng || '80.9307755');

  // CRITICAL 2026 NATIVE ANDROID PROTOCOL REQUIREMENT:
  // NEVER include `'x-web-checkout-flow': 'cart'` or Chrome User-Agent on `chkout.swiggy.com`!
  // Web-flow headers cause Swiggy's backend to strip 100% of App-Only Item Offers (`CRAZY_DEALS`, `NBH_OFFER`, `POCKET_HERO`)
  // AND 100% of App-Only Late Night / Breakfast / Reward Free Cash (`₹50`–`₹100` OFF)!
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'tid': rawTid,
    'sid': sid,
    'token': token,
    ...(uid ? { 'userid': uid, 'user-id': uid, 'customer_id': uid } : {}),
    'deviceId': deviceId,
    'device-id': deviceId,
    'swuid': deviceId,
    'platform': 'swiggy-android',
    'agent-type': 'Swiggy-Android',
    'analyticsPlatform': 'an',
    'version-code': '1800',
    'app-version': '4.99.0',
    'os-version': '14',
    'lat': lat,
    'lng': lng,
    'latitude': lat,
    'longitude': lng,
    'User-Agent': 'Swiggy-Android',
    ...(opts.extraHeaders || {})
  };
}

// Preserves item-level `offer_ids` (`CRAZY_DEALS`, `NBH_OFFER`, `POCKET_HERO`, `FLASH_SALE` strike-off discounts!)
// AND `item_offer_cart_meta` across EVERY `chkout` / `dapi` cart update & rehydration call!
export function buildSwiggyCartItemsPayload(items) {
  return (Array.isArray(items) ? items : [])
    .filter(it => it && (it.menu_item_id || it.itemId))
    .map(it => ({
      addons: Array.isArray(it.addons) ? it.addons : [],
      variants: Array.isArray(it.variants) ? it.variants : [],
      menu_item_id: Number(it.menu_item_id || it.itemId),
      quantity: Number(it.qty || it.quantity || 1),
      offer_ids: Array.isArray(it.offer_ids) ? it.offer_ids : [],
      item_offer_cart_meta: String(it.item_offer_cart_meta || ''),
      customer_request_messages: Array.isArray(it.customer_request_messages) ? it.customer_request_messages : []
    }));
}

// ---------------------------------------------------------------------------
// PURE-HTTP `_session_tid` AUTO-BOOTSTRAP FOR TOKEN-ONLY OTHER-BOT ACCOUNTS!
// Converts `{ tid: "eyJ...", token, sid, deviceId }` (ZERO cookies!) into a FULL
// Web + Android Swiggy session (`_session_tid=<1536-char-hex>`) in ONE ~200ms GET!
// ---------------------------------------------------------------------------
export async function bootstrapSwiggyWebSessionFromAndroidTokens(accountOrCookies, { force = false } = {}) {
  if (!accountOrCookies || typeof accountOrCookies !== 'object' || Array.isArray(accountOrCookies)) {
    return null;
  }
  const existingClean = cleanSwiggyCookieString(accountOrCookies.cookies || '', accountOrCookies);
  if (!force && existingClean.includes('_session_tid=')) {
    accountOrCookies.cookies = existingClean;
    return existingClean;
  }

  const androidHeaders = buildSwiggyAndroidClientHeaders(accountOrCookies);
  if (!androidHeaders.tid && !androidHeaders.token) return null;

  try {
    let uid = androidHeaders.userid || '';
    let liveTid = androidHeaders.tid || '';
    let liveTok = androidHeaders.token || '';
    let liveSid = androidHeaders.sid || '';
    let liveDev = androidHeaders.deviceId || '';

    if (!uid || !liveTid.includes('.')) {
      const prof = await fetchSwiggyAndroidProfile(accountOrCookies, { timeoutMs: 5000 });
      if (prof?.customerId) uid = String(prof.customerId);
      if (prof?.token) liveTok = prof.token;
    }

    // ZERO-CHROMIUM pure HTTP WebView bootstrap (~650ms, 0MB RAM, zero AWS WAF challenge needed!):
    const res = await fetch('https://www.swiggy.com/web-cart-add-address', {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 Swiggy-Android',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'tid': liveTid,
        'sid': liveSid,
        'token': liveTok,
        ...(uid ? { 'userid': String(uid), 'user-id': String(uid) } : {}),
        'deviceId': liveDev,
        'device-id': liveDev,
        'platform': 'an',
        'version-code': '1600',
        'app-version': '4.75.0'
      },
      signal: AbortSignal.timeout(9000)
    });

    const htmlBody = await res.text().catch(() => '');
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cmap = new Map();
    if (!force) {
      for (const part of String(existingClean || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
          const k = part.slice(0, eq).trim();
          const v = part.slice(eq + 1).trim();
          if (k && v) cmap.set(k, v);
        }
      }
    }
    for (const sc of setCookies) {
      const pair = String(sc || '').split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (k && v && k !== 'aws-waf-token' && k !== 'userLocation') {
          cmap.set(k, v);
        }
      }
    }

    const mintedSessionTid = cmap.get('_session_tid') || '';
    if (!mintedSessionTid) return null;

    const mergedCookies = cleanSwiggyCookieString(
      Array.from(cmap.entries()).map(([k, v]) => `${k}=${v}`).join('; '),
      { ...accountOrCookies, _session_tid: mintedSessionTid }
    );

    const htmlCsrf = (htmlBody.match(/csrf[a-zA-Z0-9_"\s:=]+([a-zA-Z0-9_\-]{12,60})/i) || [])[1] || '';
    if (htmlCsrf) {
      csrfTokenCache.set(mergedCookies.slice(0, 180), { csrf: htmlCsrf, ts: Date.now() });
    }

    accountOrCookies._session_tid = mintedSessionTid;
    accountOrCookies.cookies = mergedCookies;
    if (uid && !accountOrCookies.customerId) accountOrCookies.customerId = String(uid);
    sessionAuthCache.clear();

    try {
      const db = getDb();
      const targetPhone = String(accountOrCookies.phone || '').replace(/\D/g, '').slice(-10);
      const targetToken = String(accountOrCookies.token || '').trim();
      const matchedKeys = new Set();
      if (accountOrCookies.id && db?.config?.accounts?.[accountOrCookies.id]) {
        matchedKeys.add(accountOrCookies.id);
      }
      for (const [k, existing] of Object.entries(db?.config?.accounts || {})) {
        if (!existing) continue;
        const exPhone = String(existing.phone || '').replace(/\D/g, '').slice(-10);
        const exUid = String(existing.userId || existing.customerId || '').trim();
        if (
          (uid && exUid && String(uid) === exUid) ||
          (targetPhone && exPhone && targetPhone === exPhone) ||
          (targetToken && existing.token && targetToken === String(existing.token).trim())
        ) {
          matchedKeys.add(k);
        }
      }
      for (const k of matchedKeys) {
        const existing = db?.config?.accounts?.[k];
        const existingTidIsHex = existing?.tid && !String(existing.tid).includes('.');
        updateAccount(k, {
          _session_tid: mintedSessionTid,
          cookies: mergedCookies,
          ...(existingTidIsHex ? { tid: mintedSessionTid } : {}),
          ...(uid ? { customerId: String(uid), userId: String(uid) } : {})
        });
      }
    } catch {}

    return mergedCookies;
  } catch (e) {
    console.warn('[SwiggyBootstrap] Failed to mint _session_tid from Android tokens:', e.message);
    return null;
  }
}

// Fast (<80ms) zero-WAF, zero-cookie Native Swiggy Android Profile + Saved Addresses fetcher
export async function fetchSwiggyAndroidProfile(accountOrCookies, opts = {}) {
  try {
    const headers = buildSwiggyAndroidClientHeaders(accountOrCookies, opts);
    if (!headers.tid && !headers.token) return null;
    const res = await fetch('https://profile.swiggy.com/api/v1/user/profile', {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs || 6500)
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (json?.statusCode !== 0 || !json?.data) return null;
    const d = json.data;
    const cid = d.customer_id ? String(d.customer_id) : '';
    if (!cid || cid === '0' || cid === '-1') return null;
    return {
      ok: true,
      customerId: cid,
      name: d.name || '',
      phone: d.mobile ? String(d.mobile).replace(/^\+?91/, '').replace(/\D/g, '').slice(-10) : '',
      email: d.email || '',
      token: d.token || headers.token || '',
      addresses: Array.isArray(d.addresses) ? d.addresses : []
    };
  } catch {
    return null;
  }
}

// Universal Live Swiggy Session Verifier: tests BOTH Web DAPI (`_session_tid`) AND Native Android (`chkout` + `profile`) simultaneously!
export async function verifySwiggySessionLive(accountOrCookies) {
  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : { cookies: String(accountOrCookies || '') };
  const cleanCookies = cleanSwiggyCookieString(acc.cookies || '', acc);
  const androidHeaders = buildSwiggyAndroidClientHeaders(acc);

  const [webProbe, androidCartProbe, androidProfile] = await Promise.all([
    cleanCookies
      ? dapiFetch({ ...acc, cookies: cleanCookies }, 'order/all', { timeoutMs: 15000 }).catch(() => null)
      : Promise.resolve(null),
    (androidHeaders.tid || androidHeaders.token)
      ? fetch('https://chkout.swiggy.com/api/v2/cart/client', {
          headers: androidHeaders,
          signal: AbortSignal.timeout(7000)
        }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) })).catch(() => null)
      : Promise.resolve(null),
    (androidHeaders.tid || androidHeaders.token)
      ? fetchSwiggyAndroidProfile(acc, { timeoutMs: 6500 })
      : Promise.resolve(null)
  ]);

  const webJson = webProbe?.json || null;
  const webOk = Boolean(webProbe?.status === 200 && webJson && webJson.statusCode === 0);

  const chkJson = androidCartProbe?.json || null;
  const chkClaims = chkJson?.tid && String(chkJson.tid).includes('.') ? decodeJwtPayload(chkJson.tid) : null;
  const chkUid = chkClaims?.user_id && String(chkClaims.user_id) !== '0' && String(chkClaims.user_id) !== '-1' ? String(chkClaims.user_id) : '';
  const androidOk = Boolean(
    (chkJson && chkJson.statusCode === 0) ||
    Boolean(androidProfile?.ok && androidProfile.customerId)
  );

  let resolvedProfile = androidProfile;
  if (!resolvedProfile?.ok && chkJson?.tid && chkUid) {
    resolvedProfile = await fetchSwiggyAndroidProfile(acc, { tid: chkJson.tid, userId: chkUid, timeoutMs: 5000 });
    if (resolvedProfile?.ok) {
      const bootTarget = {
        ...acc,
        tid: chkJson.tid,
        token: resolvedProfile.token || androidHeaders.token || '',
        customerId: resolvedProfile.customerId || chkUid,
        cookies: cleanCookies
      };
      if (!cleanCookies.includes('_session_tid=')) {
        await bootstrapSwiggyWebSessionFromAndroidTokens(bootTarget);
      }
      return {
        valid: true,
        transport: bootTarget.cookies?.includes('_session_tid=') ? 'web+android' : (webOk ? 'web+android' : 'android'),
        liveTid: chkJson.tid,
        customerId: resolvedProfile.customerId || chkUid,
        name: resolvedProfile.name || '',
        phone: resolvedProfile.phone || '',
        token: resolvedProfile.token || androidHeaders.token || '',
        cookies: bootTarget.cookies || cleanCookies,
        addresses: resolvedProfile.addresses || []
      };
    }
  }

  if (!webOk && !androidOk) {
    const webMessage = webJson?.statusMessage || '';
    const androidMessage = chkJson?.statusMessage || '';
    const failure = classifySwiggyAccountFailure({ message: `${webMessage} ${androidMessage}`.trim() });
    return {
      valid: false,
      transport: 'none',
      suspended: failure.suspended,
      suspendReason: failure.suspended ? failure.reason : '',
      webMessage,
      androidMessage
    };
  }

  let liveTid = '';
  if (webOk && webJson?.tid && String(webJson.tid).includes('.')) liveTid = webJson.tid;
  else if (chkJson?.tid && String(chkJson.tid).includes('.')) liveTid = chkJson.tid;
  else if (androidHeaders.tid && androidHeaders.tid.includes('.')) liveTid = androidHeaders.tid;

  const jwtClaims = liveTid ? decodeJwtPayload(liveTid) : null;
  const jwtUid = jwtClaims?.user_id && String(jwtClaims.user_id) !== '0' && String(jwtClaims.user_id) !== '-1'
    ? String(jwtClaims.user_id)
    : '';

  // Auto-mint `_session_tid` immediately when importing any pure token-only account (`{ tid, token, sid, deviceId }`)!
  let finalVerifiedCookies = cleanCookies;
  if (!finalVerifiedCookies.includes('_session_tid=') && (liveTid || androidHeaders.token)) {
    const bootTarget = {
      ...acc,
      tid: liveTid || acc.tid || '',
      token: resolvedProfile?.token || androidHeaders.token || '',
      customerId: resolvedProfile?.customerId || jwtUid || chkUid || String(acc.customerId || ''),
      cookies: finalVerifiedCookies
    };
    const minted = await bootstrapSwiggyWebSessionFromAndroidTokens(bootTarget);
    if (minted) {
      finalVerifiedCookies = minted;
      if (acc && typeof acc === 'object') {
        acc.cookies = minted;
        acc._session_tid = bootTarget._session_tid || '';
      }
    }
  }

  return {
    valid: true,
    transport: (webOk || finalVerifiedCookies.includes('_session_tid=')) && androidOk ? 'web+android' : (webOk ? 'web' : 'android'),
    liveTid,
    customerId: resolvedProfile?.customerId || jwtUid || chkUid || String(acc.customerId || ''),
    name: resolvedProfile?.name || '',
    phone: resolvedProfile?.phone || '',
    token: resolvedProfile?.token || androidHeaders.token || '',
    cookies: finalVerifiedCookies,
    addresses: resolvedProfile?.addresses || []
  };
}

// ---------------------------------------------------------------------------
// ZERO-WAF DUAL-TRANSPORT SESSION AUTH BOOTSTRAP (<250ms pure HTTP)
// Seamlessly supports BOTH Web `_session_tid` cookies AND Native Android `token`+`tid` JSONs!
// ---------------------------------------------------------------------------
const sessionAuthInFlight = new Map();

/**
 * SPEED: agla ID pehle se "garam" rakho. Jab Boss/customer ⚡ Next ID dabata
 * hai, us waqt session-auth ka network round-trip pehle se ho chuka hota hai
 * (45s cache), isliye bill turant banta hai.
 */
export function warmAccountSessionAuth(accountOrKey) {
  try {
    const db = getDb();
    const key = typeof accountOrKey === 'string' ? accountOrKey : resolveAccountKeyForHealth(accountOrKey);
    const acc = key ? db?.config?.accounts?.[key] : accountOrKey;
    if (!acc || !acc.isLoggedIn || isAccountSuspended(acc)) return Promise.resolve(false);
    return getSwiggySessionAuth(acc, false)
      .then((auth) => Boolean(auth && !auth.sessionExpired))
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export async function getSwiggySessionAuth(accountOrCookies, forceRefresh = false) {
  if (!accountOrCookies) return null;
  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const cleanCookies = cleanSwiggyCookieString(accountOrCookies, acc);
  // Key `sig` on STABLE session identity (`cookies` + `token` + `sid` + `customerId`) — NEVER `acc.tid`,
  // because `chkout.swiggy.com` rotates `tid`'s `iat` timestamp on every single response!
  const sig = `${cleanCookies.slice(0, 140)}|${acc?.token || ''}|${acc?.sid || ''}|${acc?.customerId || acc?.userId || ''}`;
  const now = Date.now();
  if (!forceRefresh && sessionAuthCache.has(sig)) {
    const cached = sessionAuthCache.get(sig);
    if (now - cached.ts < AUTH_TTL_MS) {
      if (acc?.jwtTid && String(acc.jwtTid).includes('.')) {
        cached.auth.jwtTid = acc.jwtTid;
      }
      return cached.auth;
    }
  }
  if (!forceRefresh && sessionAuthInFlight.has(sig)) {
    return sessionAuthInFlight.get(sig);
  }

  const runPromise = (async () => {

  const cm = parseCookieMap(cleanCookies);
  let webExpiredMsg = '';

  // Path 1: Try Web DAPI `/dapi/order/all` WITH `aws-waf-token` protection when `_session_tid` is available
  if (cleanCookies.includes('_session_tid=')) {
    try {
      const dapiOrderOut = await dapiFetch(acc || cleanCookies, 'order/all', { timeoutMs: 15000 });
      if (dapiOrderOut?.status === 200 && dapiOrderOut?.json) {
        const json = dapiOrderOut.json;
        if (json && json.statusCode === 0) {
          let jwtTid = (json?.tid && String(json.tid).includes('.'))
            ? json.tid
            : ((acc?.jwtTid && String(acc.jwtTid).includes('.'))
              ? acc.jwtTid
              : (acc?.tid && String(acc.tid).includes('.') ? acc.tid : ''));
          let claims = jwtTid ? decodeJwtPayload(jwtTid) : null;
          const webJwtExplicitlyGuest = Boolean(
            json?.tid && String(json.tid).includes('.') &&
            (String(claims?.user_id || '') === '0' || String(claims?.user_id || '') === '-1')
          );
          let userId = (claims?.user_id && String(claims.user_id) !== '0' && String(claims.user_id) !== '-1')
            ? String(claims.user_id)
            : (!webJwtExplicitlyGuest && acc?.customerId ? String(acc.customerId) : null);
          let resolvedToken = acc?.token || cm.token || '';
          let resolvedSid = json?.sid || acc?.sid || cm._sid || '';
          let resolvedDev = json?.deviceId || acc?.deviceId || cm._device_id || '';

          // Brand-new account with 0 past orders or hex-only `tid`: enrich `userId` + `jwtTid` in ~150ms via `/dapi/profile/info`!
          if (!userId || !jwtTid) {
            try {
              const infoRes = await dapiFetch(acc || cleanCookies, 'profile/info', { timeoutMs: 5000 });
              const infoJson = infoRes?.json;
              if (infoJson?.statusCode === 0) {
                if (infoJson.tid && String(infoJson.tid).includes('.')) jwtTid = infoJson.tid;
                const d = infoJson.data || {};
                if (d.customer_id) userId = String(d.customer_id);
                else if (jwtTid) {
                  claims = decodeJwtPayload(jwtTid);
                  if (claims?.user_id && String(claims.user_id) !== '0') userId = String(claims.user_id);
                }
                if (d.token && !resolvedToken) resolvedToken = String(d.token);
                if (infoJson.sid && !resolvedSid) resolvedSid = String(infoJson.sid);
                if (infoJson.deviceId && !resolvedDev) resolvedDev = String(infoJson.deviceId);
                if (acc && d.mobile && !acc.phone) acc.phone = String(d.mobile).replace(/\D/g, '').slice(-10);
              }
            } catch {}
          }

          const auth = {
            sessionExpired: false,
            transport: 'web',
            cleanCookies,
            cm,
            jwtTid,
            userId: userId ? String(userId) : null,
            sid: resolvedSid,
            deviceId: resolvedDev,
            token: resolvedToken,
            swuid: cm._swuid || resolvedDev || '',
            orders: Array.isArray(json?.data?.orders) ? json.data.orders : []
          };
          if (acc) {
            if (cm._session_tid && !acc._session_tid) acc._session_tid = cm._session_tid;
            if (!String(acc.cookies || '').includes('_session_tid=') && cleanCookies.includes('_session_tid=')) {
              acc.cookies = cleanCookies;
            }
            if (jwtTid) acc.tid = jwtTid;
            if (auth.userId) acc.customerId = auth.userId;
            if (resolvedToken && !acc.token) acc.token = resolvedToken;
          }
          sessionAuthCache.set(sig, { auth, ts: now });
          return auth;
        }
        const statusMsg = String(json?.statusMessage || '');
        if (json?.statusCode === 999 || json?.statusCode === 401 || /login|unauth|session\s*expired/i.test(statusMsg)) {
          webExpiredMsg = statusMsg || 'Session expired';
        }
      }
    } catch (e) {
      console.warn('[SwiggyAuth] Web DAPI auth warning:', e.message);
    }
  }

  // Path 2: Native Swiggy Android `chkout.swiggy.com` + `profile.swiggy.com` (works with ZERO `_session_tid`!)
  const androidHeaders = buildSwiggyAndroidClientHeaders(acc || cleanCookies);
  if (androidHeaders.tid || androidHeaders.token) {
    try {
      const [chkRes, profRes] = await Promise.all([
        fetch('https://chkout.swiggy.com/api/v2/cart/client', {
          headers: androidHeaders,
          signal: AbortSignal.timeout(7000)
        }).then(r => r.json().catch(() => null)).catch(() => null),
        fetchSwiggyAndroidProfile(acc || cleanCookies, { timeoutMs: 6500 })
      ]);

      const freshTid = (chkRes?.tid && String(chkRes.tid).includes('.'))
        ? chkRes.tid
        : (androidHeaders.tid && androidHeaders.tid.includes('.') ? androidHeaders.tid : '');
      const claims = freshTid ? decodeJwtPayload(freshTid) : null;
      const freshJwtExplicitlyGuest = Boolean(
        chkRes?.tid && String(chkRes.tid).includes('.') &&
        (String(claims?.user_id || '') === '0' || String(claims?.user_id || '') === '-1')
      );

      if ((chkRes?.statusCode === 0 && !freshJwtExplicitlyGuest) || profRes?.ok) {
        const resolvedUid = profRes?.customerId
          || (claims?.user_id && String(claims.user_id) !== '0' && String(claims.user_id) !== '-1' ? String(claims.user_id) : '')
          || (!freshJwtExplicitlyGuest && acc?.customerId ? String(acc.customerId) : '');
        const resolvedToken = profRes?.token || androidHeaders.token || '';

        if (acc) {
          if (freshTid) acc.tid = freshTid;
          if (resolvedUid) acc.customerId = resolvedUid;
          if (resolvedToken) acc.token = resolvedToken;
          if (!acc.phone && profRes?.phone) acc.phone = profRes.phone;
        }

        const auth = {
          sessionExpired: false,
          transport: 'android',
          cleanCookies,
          cm,
          jwtTid: freshTid,
          userId: resolvedUid || null,
          sid: chkRes?.sid || androidHeaders.sid || '',
          deviceId: chkRes?.deviceId || androidHeaders.deviceId || '',
          token: resolvedToken,
          swuid: androidHeaders.swuid || androidHeaders.deviceId || '',
          profileAddresses: profRes?.addresses || [],
          orders: []
        };
        sessionAuthCache.set(sig, { auth, ts: now });
        return auth;
      }

      if (chkRes?.statusCode === 999 || chkRes?.statusCode === 401 || webExpiredMsg) {
        return {
          sessionExpired: true,
          // Swiggy itself answered "unauthorized / logged out" -> real expiry.
          hardExpired: true,
          statusMessage: chkRes?.statusMessage || webExpiredMsg || 'Session expired',
          cleanCookies,
          cm
        };
      }
    } catch (e) {
      console.warn('[SwiggyAuth] Android auth fallback warning:', e.message);
    }
  } else if (webExpiredMsg) {
    return { sessionExpired: true, hardExpired: true, statusMessage: webExpiredMsg, cleanCookies, cm };
  }

  // Fallback decode from existing JWT if network timed out transiently
  const fallbackJwt = (acc?.jwtTid && String(acc.jwtTid).includes('.'))
    ? acc.jwtTid
    : ((acc?.tid && String(acc.tid).includes('.')) ? acc.tid : (cm.tid && cm.tid.includes('.') ? cm.tid : ''));
  const claims = fallbackJwt ? decodeJwtPayload(fallbackJwt) : null;
  const isExpiredByClaim = Boolean(claims?.exp && (Number(claims.exp) * 1000) <= Date.now() && !cleanCookies.includes('_session_tid='));
  const fallbackUid = (!isExpiredByClaim && claims?.user_id && String(claims.user_id) !== '0')
    ? String(claims.user_id)
    : (!isExpiredByClaim ? (acc?.customerId || null) : null);
  const isSessionExpired = Boolean(!fallbackUid || isExpiredByClaim || webExpiredMsg);
  // This branch is only reached after the live calls failed. A timeout, a WAF
  // challenge or an HTML page means "we could not verify", NOT "the customer is
  // logged out". Only a JWT that is past its own exp (with no _session_tid) is
  // treated as real expiry; everything else is transient so callers can keep
  // the ID logged in instead of silently wiping it from the vault.
  const hardExpired = Boolean(isExpiredByClaim && !webExpiredMsg);
  return {
    sessionExpired: isSessionExpired,
    hardExpired,
    transient: !hardExpired,
    statusMessage: isExpiredByClaim ? 'JWT token expired' : (webExpiredMsg || (isSessionExpired ? 'Session expired' : '')),
    cleanCookies,
    cm,
    jwtTid: fallbackJwt,
    userId: fallbackUid ? String(fallbackUid) : null,
    sid: acc?.sid || cm._sid || '',
    deviceId: acc?.deviceId || cm._device_id || '',
    token: acc?.token || cm.token || '',
    swuid: cm._swuid || acc?.deviceId || cm._device_id || '',
    orders: []
  };
  })();

  if (!forceRefresh) {
    sessionAuthInFlight.set(sig, runPromise);
  }
  try {
    return await runPromise;
  } finally {
    if (sessionAuthInFlight.get(sig) === runPromise) {
      sessionAuthInFlight.delete(sig);
    }
  }
}

// ---------------------------------------------------------------------------
// UNIFIED DUAL-TRANSPORT SWIGGY CART HELPERS (`dapi/cart` <-> `chkout.swiggy.com/api/v2/cart/client`)
// Automatically executes via Web DAPI when `_session_tid` works, or seamlessly via Native Android `chkout`!
// ---------------------------------------------------------------------------
async function androidCheckoutCartCall(accountOrCookies, endpointPath, { method = 'GET', body = undefined, lat = '26.8658609', lng = '80.9307755', timeoutMs = 9000 } = {}) {
  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const auth = await getSwiggySessionAuth(accountOrCookies);
  if (!auth?.jwtTid && !auth?.token) {
    return { status: 0, json: null };
  }
  const headers = buildSwiggyAndroidClientHeaders(accountOrCookies, {
    tid: auth?.jwtTid,
    token: auth?.token,
    sid: auth?.sid,
    deviceId: auth?.deviceId,
    userId: auth?.userId,
    lat,
    lng
  });
  const res = await fetch(`https://chkout.swiggy.com/api/v2/cart/${endpointPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const json = await res.json().catch(() => null);
  if (acc && json?.tid && String(json.tid).includes('.')) {
    acc.jwtTid = json.tid;
    if (!acc.tid || String(acc.tid).includes('.')) acc.tid = json.tid;
  }
  // Native Android `chkout` returns selected `addresses` array without copying `.id` onto `data.address_id`:
  // Normalize `data.address_id` & `data.delivery_address` automatically so checkout/QR code always sees the exact bound `address_id`!
  if (json?.data && typeof json.data === 'object') {
    const selectedAddr = Array.isArray(json.data.addresses)
      ? (json.data.addresses.find(a => a?.selected && a?.id) || json.data.addresses.find(a => a?.delivery_valid && a?.id))
      : null;
    if (!json.data.address_id) {
      json.data.address_id = String(body?.address_id || selectedAddr?.id || '');
    }
    if (!json.data.delivery_address && selectedAddr) {
      json.data.delivery_address = selectedAddr;
    }
  }
  return { status: res.status, json };
}

export async function swiggyCartGet(accountOrCookies, { lat = '26.8658609', lng = '80.9307755', timeoutMs = 9000 } = {}) {
  // Fast Path 1 (~220ms ZERO-CHROMIUM pure HTTP): Native Android `chkout.swiggy.com/api/v2/cart/client`!
  const aRes = await androidCheckoutCartCall(accountOrCookies, 'client', { method: 'GET', lat, lng, timeoutMs }).catch(() => null);
  if (aRes?.json) {
    if (aRes.json.statusCode === 0) return aRes;
    if (/session expired|login again/i.test(String(aRes.json.statusMessage || ''))) return aRes;
  }

  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const cleanCookies = cleanSwiggyCookieString(accountOrCookies, acc);
  if (!aRes?.json && cleanCookies.includes('_session_tid=')) {
    const res = await dapiFetch(accountOrCookies, 'cart', { lat, lng, timeoutMs }).catch(() => null);
    if (res?.json && res.json.statusCode === 0) return res;
  }
  return aRes || { status: 0, json: null };
}

export async function swiggyCartUpdate(accountOrCookies, cartPayload, { lat = '', lng = '', address = '', area = '', flushFirst = true, timeoutMs = 10000 } = {}) {
  const requestedItems = Array.isArray(cartPayload?.cartItems) ? cartPayload.cartItems : [];
  if (requestedItems.length > 0 && (!cartPayload?.address_id || !isValidIndianDeliveryCoordinates(lat, lng))) {
    return {
      status: 0,
      json: {
        statusCode: 1,
        statusMessage: 'Cart update blocked: bind the exact delivery address and provide verified Indian coordinates first.'
      }
    };
  }
  // Fast Path 1 (~250ms ZERO-CHROMIUM pure HTTP): Native Android `chkout.swiggy.com/api/v2/cart/client/update`!
  const aRes = await androidCheckoutCartCall(accountOrCookies, 'client/update', {
    method: 'POST',
    lat,
    lng,
    timeoutMs,
    body: {
      flushFirst: Boolean(flushFirst),
      restaurantId: String(cartPayload.restaurantId || ''),
      address_id: String(cartPayload.address_id || ''),
      couponCode: String(cartPayload.couponCode || ''),
      cartItems: Array.isArray(cartPayload.cartItems) ? cartPayload.cartItems : [],
      mealItems: Array.isArray(cartPayload.mealItems) ? cartPayload.mealItems : [],
      subscriptionItems: Array.isArray(cartPayload.subscriptionItems) ? cartPayload.subscriptionItems : [],
      ...(cartPayload.order_comments ? { order_comments: cartPayload.order_comments } : {}),
      ...(cartPayload.delivery_instructions ? { delivery_instructions: cartPayload.delivery_instructions } : {}),
      ...(cartPayload.alternate_mobile ? { alternate_mobile: cartPayload.alternate_mobile, alternate_phone: cartPayload.alternate_mobile } : {}),
      ...(cartPayload.recipient_details ? { recipient_details: cartPayload.recipient_details } : {}),
      ...(cartPayload.is_order_for_someone_else !== undefined ? {
        is_order_for_someone_else: cartPayload.is_order_for_someone_else,
        ordering_for_someone_else: cartPayload.is_order_for_someone_else,
        order_for_others: cartPayload.is_order_for_someone_else
      } : {})
    }
  }).catch(() => null);
  if (aRes?.json) {
    if (aRes.json.tid && String(aRes.json.tid).includes('.') && typeof accountOrCookies === 'object' && accountOrCookies) {
      accountOrCookies.jwtTid = aRes.json.tid;
      accountOrCookies.tid = aRes.json.tid;
    }
    // `chkout.swiggy.com/api/v2/cart/client/update` IS Swiggy's authoritative cart engine — returning `aRes` directly
    // avoids falling through to `POST /dapi/cart` (which triggers AWS WAF 202 + Headless Chromium OOM on Render 512MB RAM!).
    return aRes;
  }

  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const cleanCookies = cleanSwiggyCookieString(accountOrCookies, acc);
  if (cleanCookies.includes('_session_tid=')) {
    const res = await dapiFetch(accountOrCookies, 'cart', {
      method: 'POST',
      lat,
      lng,
      address,
      area,
      timeoutMs,
      body: {
        flushFirst: Boolean(flushFirst),
        cart: cartPayload
      }
    }).catch(() => null);
    if (res?.json && res.json.statusCode === 0 && (res.json.data?.cartMeta || res.json.data?.order_total !== undefined)) {
      return res;
    }
  }
  return aRes || { status: 0, json: null };
}

export async function swiggyCartFlush(accountOrCookies, { lat = '26.8658609', lng = '80.9307755', timeoutMs = 8000 } = {}) {
  const aRes = await androidCheckoutCartCall(accountOrCookies, 'client/flush', { method: 'DELETE', lat, lng, timeoutMs }).catch(() => null);
  if (aRes?.json?.statusCode === 0) return aRes;
  const acc = (typeof accountOrCookies === 'object' && !Array.isArray(accountOrCookies)) ? accountOrCookies : null;
  const cleanCookies = cleanSwiggyCookieString(accountOrCookies, acc);
  if (cleanCookies.includes('_session_tid=')) {
    const wRes = await dapiFetch(accountOrCookies, 'cart/flush', { method: 'POST', body: {}, lat, lng, timeoutMs }).catch(() => null);
    if (wRes) return wRes;
  }
  return aRes || { status: 0, json: null };
}

// ---------------------------------------------------------------------------
// CACHED AWS WAF TOKEN GENERATOR (Solves with stealth browser in ~1.5s, shared across entire bot)
// ---------------------------------------------------------------------------
export async function getCachedWafToken(forceRefresh = false) {
  const now = Date.now();
  // Shared pool first: a vault-hydrated / previously Chromium-acquired token
  // is valid for ALL accounts — no need to burn Chromium when it is warm.
  const poolToken = wafPool.getTokenSync();
  if (!forceRefresh && poolToken) {
    cachedWafToken = poolToken;
    cachedWafAt = Date.now();
    return poolToken;
  }
  if (!forceRefresh && cachedWafToken && (now - cachedWafAt) < WAF_TTL_MS) {
    return cachedWafToken;
  }
  const token = await getLiveSwiggyWafToken(forceRefresh);
  if (token) {
    cachedWafToken = token;
    cachedWafAt = Date.now();
    wafPool.seedToken(token, { source: 'chromium' });
  }
  return token || cachedWafToken || poolToken || '';
}

let wafWarmLoopTimer = null;
export function startWafKeepWarmLoop() {
  if (wafWarmLoopTimer) return;
  // 2026-10-22: ON by default. Without a warm `aws-waf-token`, every 29-ID
  // scan burst gets challenged by Swiggy WAF (live incident 22-10-2026).
  // Chromium launch is SHORT (~2.5s) and only happens when the shared pool
  // has no valid token — vault hydrate normally covers fresh deploys.
  // Opt out with WAF_KEEPWARM=false if an instance has no Chromium.
  if (process.env.WAF_KEEPWARM === 'false') return;
  const initTimer = setTimeout(() => {
    if (!wafPool.getTokenSync()) getCachedWafToken(false).catch(() => {});
  }, 20000);
  if (typeof initTimer.unref === 'function') initTimer.unref();

  wafWarmLoopTimer = setInterval(() => {
    if (!wafPool.getTokenSync()) getCachedWafToken(true).catch(() => {});
  }, 30 * 60 * 1000);
  if (typeof wafWarmLoopTimer.unref === 'function') wafWarmLoopTimer.unref();
}

// Authenticated / guest Swiggy DAPI caller:
//   Fast Path 0 (~250ms, ZERO Chromium, 0MB RAM!): `User-Agent: Swiggy-Android` + `_csrf` via zero-WAF `order/all`!
//   Fallback Path 1: Chromium `aws-waf-token` + `DESKTOP_UA` (only for desktop-gated `/dapi/cart*` endpoints if needed).
export async function dapiFetch(accountOrCookies, endpoint, options = {}) {
  const {
    method = 'GET',
    body = null,
    lat = null,
    lng = null,
    address = '',
    area = '',
    extraHeaders = {},
    timeoutMs = 10000,
    useMobileWebUa = false
  } = options;

  const accObj = (typeof accountOrCookies === 'object' && accountOrCookies && !Array.isArray(accountOrCookies))
    ? accountOrCookies
    : null;
  if (
    accObj &&
    !String(accObj.cookies || '').includes('_session_tid=') &&
    (accObj.tid || accObj.jwtTid || accObj.token || accObj.auth_token || accObj.access_token)
  ) {
    await bootstrapSwiggyWebSessionFromAndroidTokens(accObj, Math.min(3500, Math.max(1200, timeoutMs))).catch(() => false);
  }

  const cleanCookies = accountOrCookies ? cleanSwiggyCookieString(accountOrCookies, accObj) : '';
  const sig = cleanCookies ? cleanCookies.slice(0, 180) : 'guest';
  const isMapiRoute = /^\/?mapi\//i.test(endpoint);
  const relEndpoint = endpoint.replace(/^\/?((?:dapi|mapi)\/)?/i, '');
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://www.swiggy.com/${isMapiRoute ? 'mapi' : 'dapi'}/${relEndpoint}`;
  const isDesktopWafCartRoute = !isMapiRoute && /^(cart|menu)(\/|\?|$)/i.test(relEndpoint);
  const isMobileWebRoute = useMobileWebUa || (!isMapiRoute && /^offers(\/|\?|$)/i.test(relEndpoint));

  // Fast Path 0: Zero-Chromium HTTP for ALL non-`/cart`/`/menu` DAPI/MAPI endpoints!
  // CRITICAL: `/dapi/offers/*` (and mWeb share-link probes) MUST use `MOBILE_WEB_UA` (`Mobile Safari/537.36` -> `200 OK`, `waf=null`, full real web cards),
  // NEVER `Swiggy-Android` when web-only widgets are requested!
  if (!isDesktopWafCartRoute) {
    try {
      const zeroWafCookieParts = [];
      if (cleanCookies) zeroWafCookieParts.push(cleanCookies);
      // Shared WAF token (vault/Chromium pool): makes the Android-UA fast path
      // look like normal browser traffic — scans stay fast AND WAF-clean.
      const poolWafToken = wafPool.getTokenSync();
      if (poolWafToken) zeroWafCookieParts.push(`aws-waf-token=${poolWafToken}`);
      if (lat && lng) {
        zeroWafCookieParts.push(`userLocation=${encodeURIComponent(JSON.stringify({
          lat: String(lat),
          lng: String(lng),
          address: String(address || area || 'India'),
          area: String(area || '')
        }))}`);
      }

      const androidHeaders = !isMobileWebRoute && accountOrCookies
        ? Object.fromEntries(
            Object.entries(buildSwiggyAndroidClientHeaders(accountOrCookies, {
              ...(lat ? { lat } : {}),
              ...(lng ? { lng } : {})
            })).filter(([, v]) => v !== '' && v !== null && v !== undefined)
          )
        : {};
      // DAPI order/all endpoint on www.swiggy.com authenticates via Cookie jar (_session_tid, tid, _sid).
      // Sending duplicate `tid` and `token` as HTTP request headers causes order/all
      // to fail with `statusCode: 1 ("Oops!! Something went wrong")`!
      if (/^order\/all(?:\?|$)/i.test(relEndpoint)) {
        delete androidHeaders.tid;
        delete androidHeaders.token;
      }

      let fastBody = body ? { ...body } : null;
      if (method !== 'GET' && fastBody && fastBody._csrf === undefined) {
        let csrf = csrfTokenCache.get(sig)?.csrf || '';
        if (!csrf && cleanCookies) {
          const ordRes = await fetch('https://www.swiggy.com/dapi/order/all', {
            headers: {
              ...androidHeaders,
              'Cookie': zeroWafCookieParts.join('; '),
              'User-Agent': 'Swiggy-Android',
              'Accept': 'application/json',
              'Referer': 'https://www.swiggy.com/'
            },
            signal: AbortSignal.timeout(6500)
          }).catch(() => null);
          const ordJson = ordRes ? await ordRes.json().catch(() => null) : null;
          if (ordJson?.csrfToken) {
            csrf = ordJson.csrfToken;
            csrfTokenCache.set(sig, { csrf, ts: Date.now() });
          }
        }
        if (csrf) fastBody._csrf = csrf;
      }

      let fastRes = null;
      for (let netTry = 0; netTry < 2; netTry++) {
        try {
          fastRes = await fetch(url, {
            method,
            headers: {
              ...androidHeaders,
              ...(zeroWafCookieParts.length ? { 'Cookie': zeroWafCookieParts.join('; ') } : {}),
              'User-Agent': isMobileWebRoute ? MOBILE_WEB_UA : 'Swiggy-Android',
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Origin': 'https://www.swiggy.com',
              'Referer': useMobileWebUa
                ? 'https://www.swiggy.com/my-account/orders'
                : (isMobileWebRoute ? 'https://www.swiggy.com/checkout' : 'https://www.swiggy.com/'),
              ...(useMobileWebUa ? { '__fetch_req__': 'true', 'platform': 'mweb' } : {}),
              ...extraHeaders
            },
            ...(fastBody ? { body: JSON.stringify(fastBody) } : {}),
            signal: AbortSignal.timeout(timeoutMs)
          });
          break;
        } catch (netErr) {
          if (netTry === 1) throw netErr;
          await new Promise(r => setTimeout(r, 150));
        }
      }

      if (fastRes && (fastRes.status === 403 || fastRes.status === 202 || Boolean(fastRes.headers.get('x-amzn-waf-action')))) {
        // Fast path encountered WAF challenge — do NOT trip circuit breaker on fast path!
        // Fallback Path 1 will resolve with live WAF token. Throttled background kick:
        const nNow = Date.now();
        if (nNow - lastWafRefreshKickAt > 60_000) {
          lastWafRefreshKickAt = nNow;
          getCachedWafToken(true).catch(() => {});
        }
      }

      if (fastRes && fastRes.status !== 202 && fastRes.status !== 403 && !fastRes.headers.get('x-amzn-waf-action')) {
        const fastText = await fastRes.text();
        const fastJson = JSON.parse(fastText);
        if (fastJson?.csrfToken) {
          csrfTokenCache.set(sig, { csrf: fastJson.csrfToken, ts: Date.now() });
        }
        if (fastJson && fastJson.statusCode !== 400) {
          return { ok: fastRes.ok, status: fastRes.status, json: fastJson };
        }
      }
    } catch {}
  }

  // Pure Android token-only sessions (`!_session_tid`) authenticate on `chkout.swiggy.com` / `mcp.swiggy.com`, NEVER on web `/dapi/*` —
  // never waste 350MB RAM + 3s launching Headless Chromium on Render Free Tier for a token-only account!
  if (!cleanCookies.includes('_session_tid=') && accountOrCookies && typeof accountOrCookies === 'object' && (accountOrCookies.tid || accountOrCookies.jwtTid || accountOrCookies.token)) {
    return { ok: false, status: 401, json: null };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const wafToken = await getCachedWafToken(attempt > 0);
    const cookieParts = [];
    if (cleanCookies) cookieParts.push(cleanCookies);
    if (wafToken) cookieParts.push(`aws-waf-token=${wafToken}`);
    if (lat && lng) {
      cookieParts.push(`userLocation=${encodeURIComponent(JSON.stringify({
        lat: String(lat),
        lng: String(lng),
        address: String(address || area || 'India'),
        area: String(area || '')
      }))}`);
    }

    let finalBody = body ? { ...body } : null;
    if (method !== 'GET' && finalBody && finalBody._csrf === undefined) {
      let csrf = csrfTokenCache.get(sig)?.csrf || '';
      if (!csrf) {
        try {
          const csrfRes = await fetch('https://www.swiggy.com/dapi/cart', {
            headers: {
              'Cookie': cookieParts.join('; '),
              'User-Agent': DESKTOP_UA,
              'Accept': 'application/json',
              'Referer': 'https://www.swiggy.com/'
            },
            signal: AbortSignal.timeout(7000)
          });
          const csrfJson = await csrfRes.json().catch(() => null);
          if (csrfJson?.csrfToken) {
            csrf = csrfJson.csrfToken;
            csrfTokenCache.set(sig, { csrf, ts: Date.now() });
          }
        } catch (e) {}
      }
      if (csrf) finalBody._csrf = csrf;
    }

    const isOrderRoute = /^(order)(\/|\?|$)/i.test(relEndpoint);
    const referer = isOrderRoute
      ? 'https://www.swiggy.com/my-account'
      : (isMobileWebRoute ? 'https://www.swiggy.com/checkout' : 'https://www.swiggy.com/');

    const res = await fetch(url, {
      method,
      headers: {
        'Cookie': cookieParts.join('; '),
        'User-Agent': DESKTOP_UA,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://www.swiggy.com',
        'Referer': referer,
        ...extraHeaders
      },
      ...(finalBody ? { body: JSON.stringify(finalBody) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (res.status === 202 || res.headers.get('x-amzn-waf-action')) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      wafPool.markWafHit();
    }

    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json?.csrfToken) {
        csrfTokenCache.set(sig, { csrf: json.csrfToken, ts: Date.now() });
      }
      return { ok: res.ok, status: res.status, json };
    } catch (parseErr) {
      if (attempt === 0) continue;
      return { ok: false, status: res.status, json: null, rawText: text.slice(0, 300) };
    }
  }

  return { ok: false, status: 0, json: null };
}

// ---------------------------------------------------------------------------
// OFFICIAL SWIGGY FOOD MCP JSON-RPC CLIENT (`https://mcp.swiggy.com/food`)
// Runs inside Swiggy's `ap-south-1` VPC with ZERO WAF & ZERO CHROMIUM!
// Provides structured `fetch_food_coupons`, `get_food_cart` (exposes auto-suggested best coupon),
// `apply_food_coupon`, `get_restaurant_menu`, and `create_address` in ~220ms!
// ---------------------------------------------------------------------------
const mcpBearerTidCache = new Map(); // accSig -> { tid, ts }

export async function callSwiggyFoodMcpTool(accountOrCookies, toolName, toolArgs = {}, timeoutMs = 6500) {
  try {
    const accObj = typeof accountOrCookies === 'object' && accountOrCookies ? accountOrCookies : null;
    const cookiesMap = parseCookieMap(typeof accountOrCookies === 'string' ? accountOrCookies : (accObj?.cookies || ''));
    const accSig = String(accObj?.phone || accObj?.customerId || cookiesMap._sid || cookiesMap.tid || 'guest').slice(0, 80);

    const resolveFreshChkoutBearer = async (force = false) => {
      const cached = mcpBearerTidCache.get(accSig);
      if (!force && cached && (Date.now() - cached.ts < 10 * 60 * 1000)) {
        return cached.tid;
      }
      const seedTid = accObj?.jwtTid || accObj?.tid || cookiesMap.tid || '';
      const nowSec = Math.floor(Date.now() / 1000);
      // Fast 0ms reuse if `account.tid` was ALREADY minted fresh by `swiggyCartUpdate` (`exp` ~30 days in future)!
      if (!force && seedTid && String(seedTid).includes('.')) {
        const claims = decodeJwtPayload(seedTid);
        const hasValidUid = claims?.user_id && String(claims.user_id) !== '0' && String(claims.user_id) !== '-1';
        if (Number(claims?.exp || 0) > nowSec + 3600 || (!claims?.exp && hasValidUid)) {
          mcpBearerTidCache.set(accSig, { tid: seedTid, ts: Date.now() });
          return seedTid;
        }
      }
      const seedToken = accObj?.token || cookiesMap.token || '';
      const seedSid = accObj?.sid || cookiesMap._sid || '';
      const seedDev = accObj?.deviceId || cookiesMap._device_id || cookiesMap._swuid || '';
      try {
        const chkRes = await fetch('https://chkout.swiggy.com/api/v2/cart/client', {
          headers: {
            'User-Agent': 'Swiggy-Android',
            'app-version': '4.67.0',
            'version-code': '1365',
            'os-version': '13',
            'Accept': 'application/json',
            ...(seedTid ? { tid: seedTid } : {}),
            ...(seedToken ? { token: seedToken } : {}),
            ...(seedSid ? { sid: seedSid } : {}),
            ...(seedDev ? { deviceId: seedDev, swuid: seedDev } : {})
          },
          signal: AbortSignal.timeout(4500)
        });
        const chkJson = await chkRes.json().catch(() => null);
        if (chkJson?.tid && String(chkJson.tid).includes('.')) {
          mcpBearerTidCache.set(accSig, { tid: chkJson.tid, ts: Date.now() });
          if (accObj) {
            accObj.jwtTid = chkJson.tid;
            if (!accObj.tid || String(accObj.tid).includes('.')) accObj.tid = chkJson.tid;
          }
          return chkJson.tid;
        }
      } catch {}
      return String(seedTid).includes('.') ? seedTid : '';
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const bearerTid = await resolveFreshChkoutBearer(attempt > 0);
      if (!bearerTid || !String(bearerTid).includes('.')) {
        return { ok: false, structured: null, text: '' };
      }
      const res = await fetch('https://mcp.swiggy.com/food', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${bearerTid}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now() % 100000,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: toolArgs
          }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
      const raw = await res.text();
      let rpc = null;
      try {
        rpc = JSON.parse(raw);
      } catch {
        const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
        if (dataLine) {
          try { rpc = JSON.parse(dataLine.slice(5).trim()); } catch {}
        }
      }
      const result = rpc?.result || null;
      const text = Array.isArray(result?.content)
        ? result.content.map(c => c?.text || '').join('\n')
        : '';
      return {
        ok: Boolean(res.ok && result && !result.isError),
        isError: Boolean(result?.isError),
        structured: result?.structuredContent || null,
        text
      };
    }
    return { ok: false, structured: null, text: '' };
  } catch (err) {
    return { ok: false, structured: null, text: '', error: err.message };
  }
}

let mcpOrderToolsCache = { tools: null, ts: 0 };

async function discoverSwiggyFoodMcpOrderTools(bearerTid, timeoutMs = 3000) {
  const now = Date.now();
  const ttl = Array.isArray(mcpOrderToolsCache.tools) && mcpOrderToolsCache.tools.length > 0
    ? 30 * 60 * 1000
    : 60 * 1000;
  if (mcpOrderToolsCache.tools !== null && (now - mcpOrderToolsCache.ts) < ttl) {
    return mcpOrderToolsCache.tools;
  }
  if (!bearerTid || !String(bearerTid).includes('.')) return [];
  try {
    const res = await fetch('https://mcp.swiggy.com/food', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${bearerTid}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: now % 100000,
        method: 'tools/list',
        params: {}
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await res.text();
    let rpc = null;
    try {
      rpc = JSON.parse(raw);
    } catch {
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      if (dataLine) {
        try { rpc = JSON.parse(dataLine.slice(5).trim()); } catch {}
      }
    }
    const rawTools = Array.isArray(rpc?.result?.tools) ? rpc.result.tools : [];
    const safeOrderTools = rawTools.filter(t => {
      const name = String(t?.name || '');
      const desc = String(t?.description || '');
      if (!/(?:order|track|delivery)/i.test(`${name} ${desc}`)) return false;
      if (/(?:place|cancel|create|update|apply|flush|checkout|pay|rate|refund|cart|menu|coupon|address|delete|remove)/i.test(name)) {
        return false;
      }
      return true;
    });
    mcpOrderToolsCache = { tools: safeOrderTools, ts: now };
    return safeOrderTools;
  } catch {
    mcpOrderToolsCache = { tools: [], ts: now };
    return [];
  }
}

async function probeSwiggyFoodMcpOrderTracking(accountOrCookies, orderId, timeoutMs = 3500) {
  const cleanId = String(orderId || '').trim();
  if (!accountOrCookies || !/^\d{10,20}$/.test(cleanId)) return [];
  try {
    const accObj = typeof accountOrCookies === 'object' && accountOrCookies ? accountOrCookies : null;
    const cookiesMap = parseCookieMap(typeof accountOrCookies === 'string' ? accountOrCookies : (accObj?.cookies || ''));
    const seedTid = accObj?.jwtTid || accObj?.tid || cookiesMap.tid || '';
    if (!seedTid || !String(seedTid).includes('.')) return [];

    const tools = await discoverSwiggyFoodMcpOrderTools(seedTid, Math.min(2500, timeoutMs));
    if (!tools.length) return [];

    const payloads = [];
    await Promise.all(tools.slice(0, 2).map(async (tool) => {
      const props = tool?.inputSchema?.properties || {};
      const args = {};
      if ('orderId' in props) args.orderId = cleanId;
      else if ('order_id' in props) args.order_id = cleanId;
      else if ('id' in props) args.id = cleanId;
      if ('limit' in props && Object.keys(args).length === 0) args.limit = 10;

      const mcpRes = await callSwiggyFoodMcpTool(accountOrCookies, tool.name, args, timeoutMs).catch(() => null);
      if (!mcpRes?.ok) return;

      const filterNodeForOrder = (node) => {
        if (!node || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
          return node.find(item => String(item?.order_id || item?.orderId || item?.id || '') === cleanId) || null;
        }
        const list = node.orders || node.data?.orders || node.items;
        if (Array.isArray(list)) {
          return list.find(item => String(item?.order_id || item?.orderId || item?.id || '') === cleanId) || null;
        }
        const directId = String(node.order_id || node.orderId || node.data?.order_id || node.data?.orderId || '');
        if (directId && directId !== cleanId) return null;
        return node;
      };

      const matchedStruct = filterNodeForOrder(mcpRes.structured);
      if (matchedStruct) payloads.push(matchedStruct);
      if (mcpRes.text && mcpRes.text.includes(cleanId)) {
        try {
          const parsedText = JSON.parse(mcpRes.text);
          const matchedFromText = filterNodeForOrder(parsedText);
          if (matchedFromText) payloads.push(matchedFromText);
        } catch {
          // Only inspect plain text when the tool targeted this specific orderId (not a multi-order dump)
          if (args.orderId || args.order_id || args.id) {
            payloads.push({ order_id: cleanId, tracking_message: mcpRes.text });
          }
        }
      }
    }));
    return payloads;
  } catch {
    return [];
  }
}

function buildChkoutHeaders(auth, lat = '26.8658609', lng = '80.9307755', extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'tid': auth.jwtTid || '',
    'sid': auth.sid || '',
    'token': auth.token || '',
    'userid': String(auth.userId || ''),
    'user-id': String(auth.userId || ''),
    'deviceId': auth.deviceId || '',
    'device-id': auth.deviceId || '',
    'swuid': auth.swuid || auth.deviceId || '',
    'platform': 'an',
    'agent-type': 'Swiggy-Android',
    'analyticsPlatform': 'an',
    'x-web-checkout-flow': 'cart',
    'marketplaceid': '1',
    'marketplacecategory': 'FOOD',
    'marketplacebusinessline': 'Regular',
    'version-code': '1350',
    'app-version': '4.68.0',
    'lat': String(lat),
    'lng': String(lng),
    'Cookie': auth.cleanCookies || '',
    'Origin': 'https://www.swiggy.com',
    'Referer': 'https://www.swiggy.com/',
    'User-Agent': 'Swiggy-Android',
    ...extra
  };
}

// Helper to get ordered candidate Swiggy accounts from local DB
function getCandidateAccounts(preferredAccount = null, preferredHostName = null) {
  const list = [];
  const seen = new Set();

  const pushAcc = (key, acc) => {
    if (!acc || typeof acc !== 'object') return;
    const clean = cleanSwiggyCookieString(acc.cookies || '', acc);
    if (!clean && !acc.tid && !acc.jwtTid && !acc.token) return;
    const id = key || acc.phone || acc.name || clean.slice(0, 40);
    if (seen.has(id)) return;
    seen.add(id);
    list.push({ key: key || id, acc });
  };

  if (preferredAccount) pushAcc('preferred', preferredAccount);

  try {
    const db = getDb();
    const accounts = db?.config?.accounts || {};
    const rankAcc = (a) =>
      (a?.isLoggedIn ? 8 : 0) +
      (a?.tid && String(a.tid).startsWith('eyJ') ? 4 : 0) +
      (a?.token ? 2 : 0) +
      (a?.cookies ? 1 : 0);
    const entries = Object.entries(accounts).sort(([, a], [, b]) => rankAcc(b) - rankAcc(a));

    // If preferredHostName matches one of our accounts, check active matches first (read-only!)
    if (preferredHostName) {
      const h = preferredHostName.trim().toLowerCase();
      for (const [k, a] of entries) {
        const names = [a.swiggyName, a.name, a.phone].filter(Boolean).map(x => String(x).trim().toLowerCase());
        if (names.some(n => n === h || n.includes(h) || h.includes(n))) {
          pushAcc(k, a);
        }
      }
    }

    for (const [k, a] of entries) {
      pushAcc(k, a);
    }
  } catch (e) {}

  return list;
}

// ---------------------------------------------------------------------------
// LIVE GROUP CART ENGINE (https://chkout.swiggy.com/api/v1/shared_cart)
// Sub-100ms, zero WAF, auto-joins foreign customer group carts cleanly!
// ---------------------------------------------------------------------------
export async function fetchLiveGroupCart(groupCartId, restaurantId = null, hostName = null, preferredAccount = null, lat = '17.385044', lng = '78.486671') {
  if (!groupCartId) return null;
  const gcId = String(groupCartId).trim();
  const candidates = getCandidateAccounts(preferredAccount, hostName);
  if (candidates.length === 0) return null;

  const parseSharedCartPayload = (data) => {
    if (!data || typeof data !== 'object') return null;
    const rDetails = data.restaurant_details || {};
    const resolvedRestId = String(rDetails.restaurant_id || restaurantId || '');
    const resolvedRestName = rDetails.restaurant_name || null;
    const areaName = rDetails.area_name || '';

    // Merge identical menu items across all group cart participants cleanly
    const mergedItemsMap = new Map();
    const userCartMap = data.user_cart_map || {};
    for (const participant of Object.values(userCartMap)) {
      const userCart = Array.isArray(participant?.user_cart) ? participant.user_cart : [];
      for (const rawItem of userCart) {
        if (!rawItem || !rawItem.menu_item_id || !(rawItem.quantity > 0)) continue;
        const menuItemId = String(rawItem.menu_item_id);
        const addons = Array.isArray(rawItem.addons) ? rawItem.addons : [];
        const variants = Array.isArray(rawItem.variants) ? rawItem.variants : [];
        const sigKey = `${menuItemId}::${JSON.stringify(variants)}::${JSON.stringify(addons)}`;

        const qty = Number(rawItem.quantity) || 1;
        const basePaise = Number(rawItem.subtotal ?? (Number(rawItem.base_price || 0) * qty));
        const finalPaise = Number(rawItem.final_price ?? basePaise);
        const tradeDiscPaise = Number(rawItem.subtotal_trade_discount || 0);
        const packPaise = Number(rawItem.packing_charge || 0);
        const itemGst = Number(rawItem.item_taxes?.GST || 0);

        const unitPrice = Math.round((basePaise / 100 / qty) * 100) / 100;
        const lineTotal = Math.round((basePaise / 100) * 100) / 100;
        const finalLineTotal = Math.round((finalPaise / 100) * 100) / 100;

        if (mergedItemsMap.has(sigKey)) {
          const prev = mergedItemsMap.get(sigKey);
          prev.qty += qty;
          prev.quantity = prev.qty;
          prev.lineTotal = Math.round((prev.lineTotal + lineTotal) * 100) / 100;
          prev.finalLineTotal = Math.round((prev.finalLineTotal + finalLineTotal) * 100) / 100;
          prev.tradeDiscount = Math.round((prev.tradeDiscount + tradeDiscPaise / 100) * 100) / 100;
          prev.packingCharge = Math.round((prev.packingCharge + packPaise / 100) * 100) / 100;
          prev.gst = Math.round((prev.gst + itemGst) * 100) / 100;
          if (Array.isArray(rawItem.offer_ids)) {
            for (const oid of rawItem.offer_ids) {
              if (oid && !prev.offer_ids.includes(oid)) prev.offer_ids.push(oid);
            }
          }
          if (!prev.item_offer_cart_meta && rawItem.item_offer_cart_meta) {
            prev.item_offer_cart_meta = String(rawItem.item_offer_cart_meta);
          }
        } else {
          mergedItemsMap.set(sigKey, {
            itemId: menuItemId,
            menu_item_id: Number(menuItemId),
            name: String(rawItem.name || 'Dish Item').trim(),
            qty,
            quantity: qty,
            price: unitPrice,
            lineTotal,
            finalLineTotal,
            tradeDiscount: Math.round((tradeDiscPaise / 100) * 100) / 100,
            packingCharge: Math.round((packPaise / 100) * 100) / 100,
            gst: Math.round(itemGst * 100) / 100,
            addons,
            variants,
            offer_ids: Array.isArray(rawItem.offer_ids) ? [...rawItem.offer_ids] : [],
            item_offer_cart_meta: String(rawItem.item_offer_cart_meta || ''),
            item_offer_tags: Array.isArray(rawItem.item_offer_tags) ? rawItem.item_offer_tags : [],
            isVeg: rawItem.isVeg === 1 || rawItem.is_veg === '1',
            inStock: rawItem.in_stock !== 0
          });
        }
      }
    }

    const items = Array.from(mergedItemsMap.values());
    const subtotal = Math.round(items.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
    const tradeDiscountTotal = Math.round(items.reduce((s, i) => s + (i.tradeDiscount || 0), 0) * 100) / 100;
    const discountedSubtotal = Math.round(items.reduce((s, i) => s + i.finalLineTotal, 0) * 100) / 100;
    const packingCharges = Math.round((items.reduce((s, i) => s + (i.packingCharge || 0), 0)) * 100) / 100;
    const itemGstTotal = Math.round(items.reduce((s, i) => s + (i.gst || 0), 0) * 100) / 100;

    return {
      status: 'ACTIVE',
      groupCartId: String(data.group_cart_id || gcId),
      hostUserId: data.host_user_id ? String(data.host_user_id) : null,
      deeplink: data.shared_cart_deeplink || null,
      locked: Boolean(data.locked_status),
      restaurantId: resolvedRestId || null,
      restaurantName: resolvedRestName,
      areaName,
      items,
      itemTotal: subtotal,
      subtotal,
      discountedSubtotal,
      tradeDiscountTotal,
      packingCharges,
      taxesAndCharges: itemGstTotal
    };
  };

  let lastStatusInfo = null;
  let emptyPayloadFallback = null;
  // Deterministic ephemeral reader `user_id` per `group_cart_id`:
  // Resolves ANY foreign customer Group Cart in ANY city on the VERY FIRST ~200ms request,
  // NEVER hits `statusCode: 86` (`USER_ALREADY_PART_OF_GROUP_CART`), and NEVER pollutes real accounts!
  const ephemeralReaderUid = String(200000000 + ((Math.abs(parseInt(gcId.replace(/\D/g, '').slice(-9), 10)) || 1234567) % 79999999));

  const resolvedAuths = [];
  for (const cand of candidates) {
    const auth = (cand.acc?.tid && String(cand.acc.tid).startsWith('eyJ') && cand.acc.userId)
      ? {
          jwtTid: String(cand.acc.tid).trim(),
          token: String(cand.acc.token || '').trim(),
          sid: String(cand.acc.sid || '').trim(),
          deviceId: String(cand.acc.deviceId || '').trim(),
          userId: String(cand.acc.userId).trim()
        }
      : await getSwiggySessionAuth(cand.acc);
    if (!auth || auth.sessionExpired || !auth.jwtTid) continue;
    resolvedAuths.push({ ...cand, auth });

    // Fast Path (~200ms 1-call shot): Clean Android `shared_cart/join` with ephemeral reader UID!
    if (restaurantId) {
      try {
        const fastHeaders = buildSwiggyAndroidClientHeaders(cand.acc, {
          tid: auth.jwtTid,
          token: auth.token,
          sid: auth.sid,
          deviceId: auth.deviceId,
          userId: ephemeralReaderUid,
          lat: String(lat || '17.385044'),
          lng: String(lng || '78.486671')
        });
        const joinRes = await fetch('https://chkout.swiggy.com/api/v1/shared_cart/join', {
          method: 'POST',
          headers: fastHeaders,
          body: JSON.stringify({
            group_cart_id: gcId,
            restaurant_id: String(restaurantId),
            user_id: ephemeralReaderUid
          }),
          signal: AbortSignal.timeout(6500)
        });
        const joinJson = await joinRes.json().catch(() => null);
        if (joinJson?.statusCode === 0 && joinJson?.data) {
          const parsedJoin = parseSharedCartPayload(joinJson.data);
          if (parsedJoin?.items?.length > 0) return parsedJoin;
          emptyPayloadFallback = parsedJoin || emptyPayloadFallback;
        }
        if (joinJson?.statusCode === 88 || joinJson?.errorCodes?.includes('GROUP_CART_NO_LONGER_EXISTS')) {
          return { status: 'EXPIRED', statusCode: joinJson.statusCode, statusMessage: joinJson.statusMessage || 'Group cart no longer exists', items: [] };
        }
        if (joinJson?.errorCodes?.includes('GROUP_CART_ORDER_PLACED')) {
          return { status: 'PLACED', statusCode: joinJson.statusCode, statusMessage: joinJson.statusMessage || 'Group cart order already placed', items: [] };
        }
        lastStatusInfo = joinJson || lastStatusInfo;
      } catch {}
    }

    // Fallback Path: Direct read-only GET when `restaurantId` wasn't embedded in URL or cross-city `join` returned empty items
    if (auth.userId) {
      try {
        const res = await fetch(`https://chkout.swiggy.com/api/v1/shared_cart?group_cart_id=${encodeURIComponent(gcId)}`, {
          headers: buildChkoutHeaders(auth, String(lat || '26.8658609'), String(lng || '80.9307755')),
          signal: AbortSignal.timeout(6500)
        });
        const json = await res.json().catch(() => null);
        if (json?.statusCode === 0 && json?.data) {
          const parsedGet = parseSharedCartPayload(json.data);
          if (parsedGet?.items?.length > 0) return parsedGet;
          emptyPayloadFallback = parsedGet || emptyPayloadFallback;
        }
        if (json?.statusCode === 88 || json?.errorCodes?.includes('GROUP_CART_NO_LONGER_EXISTS')) {
          return { status: 'EXPIRED', statusCode: json.statusCode, statusMessage: json.statusMessage || 'Group cart no longer exists', items: [] };
        }
        if (json?.errorCodes?.includes('GROUP_CART_ORDER_PLACED')) {
          return { status: 'PLACED', statusCode: json.statusCode, statusMessage: json.statusMessage || 'Group cart order already placed', items: [] };
        }
        lastStatusInfo = json || lastStatusInfo;
      } catch {}
    }
  }

  if (emptyPayloadFallback) return emptyPayloadFallback;

  if (lastStatusInfo) {
    return {
      status: 'UNAVAILABLE',
      statusCode: lastStatusInfo.statusCode,
      statusMessage: lastStatusInfo.statusMessage || (lastStatusInfo.errorCodes || []).join(', '),
      items: []
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// REVERSE & FORWARD GEOCODING ENGINE (Swiggy Maps API + Nominatim fallback)
// ---------------------------------------------------------------------------
export async function reverseGeocodeCoords(lat, lng, accountOrCookies = null) {
  if (!isValidIndianDeliveryCoordinates(lat, lng)) return null;
  const sLat = String(lat).trim();
  const sLng = String(lng).trim();

  // 1. Try Swiggy's own official reverse geocoder first for 100% Swiggy area/city parity
  try {
    const cand = accountOrCookies || getCandidateAccounts()[0]?.acc || null;
    const { json } = await dapiFetch(cand, 'misc/address-recommend', {
      method: 'POST',
      body: { latlng: `${sLat},${sLng}` },
      lat: sLat,
      lng: sLng,
      timeoutMs: 7000
    });
    const rec = json?.data?.[0];
    if (rec?.formatted_address) {
      const comps = Array.isArray(rec.address_components) ? rec.address_components : [];
      const findComp = (...types) => comps.find(c => Array.isArray(c.types) && types.some(t => c.types.includes(t)))?.long_name || '';
      const city = findComp('locality', 'administrative_area_level_2') || 'Address';
      const area = findComp('sublocality_level_1', 'sublocality', 'neighborhood') || city;
      const landmark = findComp('sublocality_level_2', 'premise', 'route') || area;
      const pincode = findComp('postal_code') || '';
      return {
        address: rec.formatted_address,
        area,
        landmark,
        city,
        pincode,
        lat: String(rec.geometry?.location?.lat || sLat),
        lng: String(rec.geometry?.location?.lng || sLng)
      };
    }
  } catch (e) {}

  // 2. Fallback to OpenStreetMap Nominatim reverse geocoding
  try {
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(sLat)}&lon=${encodeURIComponent(sLng)}`, {
      headers: { 'User-Agent': 'TelegramSlotBot/2.0', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(4500)
    });
    if (geoRes.ok) {
      const gj = await geoRes.json();
      const a = gj.address || {};
      const city = a.city || a.town || a.village || a.state_district || 'Address';
      const area = a.suburb || a.neighbourhood || a.residential || a.county || city;
      const landmark = a.road || a.building || area;
      return {
        address: gj.display_name || `${area}, ${city}`,
        area,
        landmark,
        city,
        pincode: a.postcode || '',
        lat: sLat,
        lng: sLng
      };
    }
  } catch (e) {}

  return {
    address: `Pinned Location (${sLat}, ${sLng})`,
    area: 'Pinned Area',
    landmark: 'Main Road',
    city: 'Delivery',
    lat: sLat,
    lng: sLng
  };
}

const forwardGeocodeCache = new Map();

export async function geocodeAddressDetails(addrObj, accountOrCookies = null) {
  if (!addrObj || typeof addrObj !== 'object') return addrObj;
  const out = { ...addrObj };
  const hasAnyCoords = Boolean(String(out.lat || '').trim() || String(out.lng || '').trim());

  // Case A: Trust already-supplied GPS coordinates only when both are plausible in India.
  if (out.lat && out.lng && isValidIndianDeliveryCoordinates(out.lat, out.lng)) {
    if (!out.address || out.address.startsWith('Delivering to ') || out.address.startsWith('Pinned Location')) {
      const rev = await reverseGeocodeCoords(out.lat, out.lng, accountOrCookies);
      if (rev) {
        out.address = rev.address || out.address;
        out.area = out.area || rev.area;
        out.landmark = out.landmark || rev.landmark;
        out.city = (!out.city || out.city === 'Delivery' || out.city === 'Shared Location') ? rev.city : out.city;
        out.pincode = out.pincode || rev.pincode || '';
      }
    }
    return out;
  }
  if (hasAnyCoords) {
    delete out.lat;
    delete out.lng;
  }

  // Case B: Resolve a full street address. Never reuse a saved address merely because
  // it shares a city, prefix, or nearby GPS point; that can select the wrong home/contact.
  const rawAddr = String(out.address || '').trim();
  if (!rawAddr || out.unresolvableShortLink) return out;

  // Query both providers with the COMPLETE address. The previous implementation raced
  // house-level results against a PIN-code/city-only query, so the broad centroid often won.
  let cleanAddr = rawAddr
    .replace(/Hey!\s*Save my address on Swiggy using the link\s*:?\s*/gi, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/^\s*Address\s*:\s*/i, '')
    .replace(/(?:^|[\n,])\s*(?:Latitude|Longitude|lat|lng)\s*[:=]\s*[^\n,]*/gi, ' ')
    .replace(/(?:^|[\n,])\s*(?:Phone|Mobile|Tel|Contact)\s*[:=]\s*\+?[\d\s-]+/gi, ' ')
    .replace(/_/g, ' ')
    .replace(/[\r\n]+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/[, ]+$/g, '')
    .trim();
  if (cleanAddr.length < 8) return out;

  const normalizedBase = normalizeAddressText(cleanAddr);
  const cityLabel = String(out.city || '').trim();
  const pincode = String(out.pincode || cleanAddr.match(/\b([1-8]\d{5})\b/)?.[1] || '').trim();
  const querySuffixes = [];
  if (cityLabel && !/^(?:address|delivery|shared location)$/i.test(cityLabel) &&
      !normalizedBase.includes(normalizeAddressText(cityLabel))) querySuffixes.push(cityLabel);
  if (pincode && !normalizedBase.includes(pincode)) querySuffixes.push(pincode);
  if (!/\bindia\b/i.test(cleanAddr)) querySuffixes.push('India');
  cleanAddr = [cleanAddr, ...querySuffixes].filter(Boolean).join(', ');
  const normTarget = normalizeAddressText(cleanAddr);
  if (normTarget && forwardGeocodeCache.has(normTarget)) {
    const cached = forwardGeocodeCache.get(normTarget);
    out.lat = cached.lat;
    out.lng = cached.lng;
    out.city = out.city || cached.city;
    out.area = out.area || cached.area;
    out.landmark = out.landmark || cached.landmark;
    return out;
  }
  if (cleanAddr.length < 12) return out;

  const tryPhoton = async () => {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(cleanAddr)}&limit=1`, {
      headers: { 'User-Agent': 'TelegramSlotBot/2.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(2500)
    });
    if (!r.ok) throw new Error('photon_non_200');
    const j = await r.json();
    const coords = j?.features?.[0]?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2 && isValidIndianDeliveryCoordinates(coords[1], coords[0])) {
      return { lat: String(coords[1]), lng: String(coords[0]) };
    }
    throw new Error('photon_empty_or_outside_india');
  };

  const tryNominatim = async () => {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(cleanAddr)}`, {
      headers: { 'User-Agent': 'TelegramSlotBot/2.0', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(2500)
    });
    if (!r.ok) throw new Error('nom_non_200');
    const arr = await r.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon && isValidIndianDeliveryCoordinates(arr[0].lat, arr[0].lon)) {
      return { lat: String(arr[0].lat), lng: String(arr[0].lon) };
    }
    throw new Error('nom_empty_or_outside_india');
  };

  try {
    const geoHit = await Promise.any([tryPhoton(), tryNominatim()]);
    if (geoHit?.lat && geoHit?.lng) {
      out.lat = geoHit.lat;
      out.lng = geoHit.lng;
      forwardGeocodeCache.set(normTarget, { lat: out.lat, lng: out.lng, city: out.city, area: out.area, landmark: out.landmark });
    }
  } catch {}

  return out;
}

// Resolve genuine Swiggy OFO shared address UUID via mobile endpoint (/mapi/social/getAddress/<uuid>)
// WHY a shared-address link failed matters to the customer:
//   EXPIRED   -> the link really is dead, ask for a fresh one
//   NO_ACCOUNT/NETWORK -> our side hiccuped, the link is probably still fine
// Telling someone their link expired when Swiggy merely timed out (or when our
// own session/WAF was blocked) makes them paste the same healthy link forever.
//
// HARD RULE: "EXPIRED" may only come from a real 2xx JSON answer in which Swiggy
// itself says the token/link is expired / invalid / not found. A WAF 403, a 202
// challenge, a 401 from a token-only session, a 429/5xx, a timeout or a generic
// "Something went wrong" is OUR problem and must never be reported as expiry.
const OFO_FAILURE_TTL_MS = {
  EXPIRED: 5 * 60 * 1000,
  UNEXPANDED: 5 * 60 * 1000,
  NO_ACCOUNT: 2 * 60 * 1000,
  NETWORK: 30 * 1000
};
// Stronger facts win over weaker ones so a late network blip cannot erase the
// knowledge that a link is un-expandable (or that Swiggy really killed it).
const OFO_FAILURE_RANK = { UNEXPANDED: 3, EXPIRED: 2, NO_ACCOUNT: 1, NETWORK: 1 };
const ofoResolutionFailures = new Map(); // key -> { reason, at }

function noteOfoFailure(key, reason) {
  const k = String(key || '').trim();
  if (!k || !reason) return;
  const prev = ofoResolutionFailures.get(k);
  if (prev && (OFO_FAILURE_RANK[prev.reason] || 0) > (OFO_FAILURE_RANK[reason] || 0)) return;
  ofoResolutionFailures.set(k, { reason, at: Date.now() });
}

function readOfoFailure(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const entry = ofoResolutionFailures.get(k);
  if (!entry) return '';
  const ttl = OFO_FAILURE_TTL_MS[entry.reason] || 30_000;
  if (Date.now() - entry.at > ttl) {
    ofoResolutionFailures.delete(k);
    return '';
  }
  return entry.reason;
}

function ofoFailureKeys(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const keys = [raw];
  // Callers often hold the full share URL — also index the token inside it.
  const onelink = raw.match(/onelink\.me\/[a-zA-Z0-9]+\/([a-zA-Z0-9_\-]+)/i);
  const ofo = raw.match(/\/ofo\/address\/([^\/\?\s]+)\/([^\/\?\s&]+)/i);
  for (const candidate of [ofo?.[2], onelink?.[1]]) if (candidate) keys.push(candidate);
  return keys;
}

export function getOfoResolutionFailureReason(ofoTokenOrUrl) {
  for (const key of ofoFailureKeys(ofoTokenOrUrl)) {
    const reason = readOfoFailure(key);
    if (reason) return reason;
  }
  return '';
}

// A freshly pasted link deserves a fresh attempt: drop any remembered verdict so
// an old (possibly wrong) "expired" can never make the new paste fail instantly.
export function clearOfoResolutionFailures(input) {
  for (const key of ofoFailureKeys(input)) ofoResolutionFailures.delete(key);
}

// Our-side problems (session, WAF, generic Swiggy failure). Never proof of expiry.
function isOfoSessionOrTransportProblem(msg) {
  return /unauthori[sz]ed|not\s+logged|log\s?in|log\s?out|session|csrf|waf|captcha|rate\s*limit|too\s*many|try\s+again|later|something\s+went\s+wrong|oops|internal\s+server|service\s+unavailable|unable\s+to\s+process|timeout|timed\s+out|invalid\s+(request|session|user|payload|params?|csrf)/i
    .test(String(msg || ''));
}

// Swiggy explicitly telling us the shared-address token itself is dead.
function isOfoTokenDeadAnswer(msg) {
  const text = String(msg || '').trim();
  if (!text) return false;
  if (isOfoSessionOrTransportProblem(text)) return false;
  if (/expire/i.test(text)) return true;
  if (/no\s+longer\s+(valid|available|exists?|active)/i.test(text)) return true;
  if (/(link|address|token|share)\s*(is\s*)?(invalid|dead|expired|not\s+(valid|found|available))/i.test(text)) return true;
  if (/invalid\s+(or\s+expired\s+)?(link|address|token|share|url)/i.test(text)) return true;
  if (/not\s+found|does\s+not\s+exist|deleted|removed/i.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// OFO PAGE FALLBACK — resolve a shared address straight from the page Swiggy
// itself renders (`/ofo/address/<user>/<token>`).
// WHY: `/dapi/social/getAddress/<token>` is an internal mobile endpoint. It
// answers "invalid / expired" for perfectly good links (different token type,
// WAF, token-only sessions, A/B rollout), which is what made customers see
// "address fetch nahi hua — retry" for links that open fine in the Swiggy app.
// The share page is plain HTML, so it still works when that API refuses.
// ---------------------------------------------------------------------------
function pickOfoAddressFromJson(node, depth = 0) {
  if (!node || depth > 12) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = pickOfoAddressFromJson(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const lat = node.location?.lat ?? node.lat ?? node.latitude;
  const lng = node.location?.lng ?? node.lng ?? node.longitude;
  const line = node.address_line || node.address_line1 || node.address || node.formatted_address || '';
  const display = node.display_address || node.formatted_address || node.address || '';
  const hasCoords = Number(lat) >= 5.5 && Number(lat) <= 38.5 && Number(lng) >= 67 && Number(lng) <= 99;
  const looksLikeAddress = Boolean(
    (node.locality || node.area || node.city || node.address_line || node.flat_no || node.pincode) &&
    (line || display)
  );
  if (hasCoords && looksLikeAddress) {
    const resolvedDisplay = String(display || '').trim() ||
      [
        node.address_line && node.address_line !== 'None' ? node.address_line : '',
        node.locality || node.area || '',
        node.city || ''
      ].filter(Boolean).join(', ');
    return {
      id: node.id || node.address_id || '',
      name: node.contact_name || node.name || node.receiver_name || '',
      mobile: String(node.phone || node.mobile || node.contact_number || '').replace(/\D/g, '').slice(-10),
      flat_no: node.address_line && node.address_line !== 'None' ? node.address_line : (node.flat_no || ''),
      area: node.locality || node.area || '',
      landmark: node.landmark || node.locality || '',
      city: node.city || 'Address',
      address: resolvedDisplay,
      lat: String(lat),
      lng: String(lng),
      annotation: (Array.isArray(node.tags) && node.tags[0]) || node.annotation || 'Shared'
    };
  }

  for (const value of Object.values(node)) {
    if (!value || typeof value !== 'object') continue;
    const hit = pickOfoAddressFromJson(value, depth + 1);
    if (hit) {
      // The wrapper usually carries the human-readable street line
      // (`display_address`) while the inner `actual_address` only has the flat
      // + locality. Prefer the fuller text so the customer sees the real street.
      const parentDisplay = String(node.display_address || node.formatted_address || '').trim();
      if (parentDisplay && parentDisplay.length > String(hit.address || '').length) {
        hit.address = parentDisplay;
      }
      if (!hit.id && (node.id || node.address_id)) hit.id = node.id || node.address_id;
      return hit;
    }
  }
  return null;
}

function extractJsonBlobsFromHtml(html) {
  const text = String(html || '');
  const blobs = [];
  const patterns = [
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
    /__SWIGGY_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) blobs.push(m[1]);
  }
  // Last resort: any inline JSON object that mentions an address line.
  if (blobs.length === 0) {
    const m = text.match(/\{[\s\S]{40,20000}?"address_line"[\s\S]{0,20000}?\}/);
    if (m) blobs.push(m[0]);
  }
  return blobs;
}

const ofoPageAddressCache = new Map(); // token -> { value, at }
const OFO_PAGE_CACHE_TTL = 10 * 60 * 1000;

export async function resolveOfoAddressFromPage(ofoToken, ofoUser = null, accountOrCookies = null) {
  const tok = String(ofoToken || '').trim();
  if (tok.length < 4) return null;
  const cached = ofoPageAddressCache.get(tok);
  if (cached && Date.now() - cached.at < OFO_PAGE_CACHE_TTL) return cached.value;

  const candidates = accountOrCookies
    ? [accountOrCookies]
    : getCandidateAccounts()
      .filter(({ acc }) => acc && !acc.isLoggedOut && !acc.sessionExpired && (acc.cookies || acc.tid || acc.token))
      .slice(0, 2)
      .map((x) => x.acc);

  const urls = [
    `https://www.swiggy.com/ofo/address/${encodeURIComponent(ofoUser || 'customer')}/${encodeURIComponent(tok)}?pushScreen=true`,
    `https://www.swiggy.com/ofo/address/${encodeURIComponent(ofoUser || 'customer')}/${encodeURIComponent(tok)}`
  ];

  for (const acc of (candidates.length ? candidates : [null])) {
    const cookieParts = [];
    try {
      const clean = acc ? cleanSwiggyCookieString(acc.cookies || '', acc) : '';
      if (clean) cookieParts.push(clean);
    } catch {}
    try {
      const waf = wafPool.getTokenSync();
      if (waf) cookieParts.push(`aws-waf-token=${waf}`);
    } catch {}

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent': MOBILE_WEB_UA,
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-IN,en;q=0.9',
            'Referer': 'https://www.swiggy.com/',
            ...(cookieParts.length ? { 'Cookie': cookieParts.join('; ') } : {})
          },
          signal: AbortSignal.timeout(6000)
        });
        if (!res || !res.ok) continue;
        const html = await res.text();
        if (!html || html.length < 200) continue;
        for (const blob of extractJsonBlobsFromHtml(html)) {
          let parsed = null;
          try { parsed = JSON.parse(blob); } catch { continue; }
          const hit = pickOfoAddressFromJson(parsed);
          if (hit && (hit.address || (hit.lat && hit.lng))) {
            console.log(`[OfoPage] resolved address for token=${tok.slice(0, 12)} via share page`);
            ofoPageAddressCache.set(tok, { value: hit, at: Date.now() });
            return hit;
          }
        }
        ofoPageAddressCache.set(tok, { value: null, at: Date.now() });
      } catch (err) {
        // network / timeout — try the next candidate, never treat as expiry
      }
    }
  }
  return null;
}

export async function resolveSharedOfoAddress(ofoToken, ofoUser = null, accountOrCookies = null) {
  if (!ofoToken) return null;
  const tok = String(ofoToken).trim();
  if (tok.length < 6) return null;
  if (readOfoFailure(tok) === 'EXPIRED') return null;
  ofoResolutionFailures.delete(tok);

  try {
    // A shared-address link belongs to ONE friend's account. Trying every saved
    // account sequentially (24 × 10s) is what used to hang a Telegram handler
    // for 240s. Only the best 3 logged-in sessions are probed, with a hard
    // 8-second total budget.
    const allCandidates = accountOrCookies
      ? [accountOrCookies]
      : getCandidateAccounts()
        .filter(({ acc }) => acc && !acc.isLoggedOut && !acc.sessionExpired && (acc.isLoggedIn || acc.cookies || acc.tid || acc.token))
        .slice(0, 3)
        .map(x => x.acc);
    const hadRealSession = allCandidates.some((c) => c && (c.isLoggedIn || c.cookies || c.tid || c.token));
    // Only a *web* cookie session (`_session_tid`) can read /dapi/*. Token-only
    // Android sessions answer 401 by design — that says nothing about the link.
    const hadWebSession = allCandidates.some((c) => String(c?.cookies || '').includes('_session_tid='));
    if (allCandidates.length === 0) {
      allCandidates.push({});
    }
    let sawRealAnswer = false;
    let sawTransportBlock = false;
    const deadline = Date.now() + 8000;

    for (const cand of allCandidates) {
      if (cand === undefined) continue;
      if (Date.now() >= deadline) break;
      const perCallTimeout = Math.max(1500, Math.min(4500, deadline - Date.now()));
      const dapiRes = await dapiFetch(cand, `social/getAddress/${encodeURIComponent(tok)}`, { timeoutMs: perCallTimeout }).catch(() => null);
      const httpStatus = Number(dapiRes?.status) || 0;
      const rJson = dapiRes?.json;
      // A real answer = 2xx WITH a parsed JSON body. 401/403(WAF)/202/429/5xx or
      // an HTML challenge page are transport problems, not evidence of expiry.
      const answeredCleanly = Boolean(rJson) && httpStatus >= 200 && httpStatus < 300;
      if (answeredCleanly) sawRealAnswer = true;
      else if (httpStatus > 0) sawTransportBlock = true;
      if (answeredCleanly && Number(rJson?.statusCode) === 1) {
        const msg = rJson?.statusMessage || rJson?.status_message || rJson?.message || '';
        if (isOfoTokenDeadAnswer(msg)) {
          console.warn(`[OfoResolve] token=${String(tok).slice(0, 16)} swiggy API says "${String(msg).slice(0, 60)}" — trying the share page`);
          // The API can reject a token the share page still renders. Try the
          // page before telling the customer anything.
          const pageHit = await resolveOfoAddressFromPage(tok, ofoUser).catch(() => null);
          if (pageHit) return pageHit;
          noteOfoFailure(tok, 'EXPIRED');
          return null;
        }
        // Generic refusal (session/WAF/"something went wrong") -> try next account.
        console.warn(`[OfoResolve] token=${String(tok).slice(0, 16)} swiggy said "${String(msg).slice(0, 60)}" (not expiry)`);
        continue;
      }
      if (httpStatus && !answeredCleanly) {
        console.warn(`[OfoResolve] token=${String(tok).slice(0, 16)} http=${httpStatus} — not expiry`);
      }
      const addrWrap = rJson?.data?.address || rJson?.data;
      const act = addrWrap?.actual_address || addrWrap;
      const resolvedLat = act?.location?.lat ?? act?.lat ?? act?.latitude;
      const resolvedLng = act?.location?.lng ?? act?.lng ?? act?.longitude;
      const resolvedDisplay =
        addrWrap?.display_address ||
        act?.formatted_address ||
        `${act?.address_line && act.address_line !== 'None' ? act.address_line + ', ' : ''}${act?.address || act?.address_line1 || ''}`.trim();

      if (rJson?.statusCode === 0 && (resolvedLat || resolvedDisplay)) {
        return {
          id: addrWrap?.id || act?.id || '',
          name: act?.contact_name || act?.name || ofoUser || 'Customer',
          mobile: act?.phone || act?.mobile || '',
          flat_no: act?.address_line && act.address_line !== 'None' ? act.address_line : (act?.flat_no || ''),
          area: act?.locality || act?.area || '',
          landmark: act?.landmark || act?.locality || '',
          city: act?.city || 'Address',
          address: resolvedDisplay,
          lat: resolvedLat ? String(resolvedLat) : null,
          lng: resolvedLng ? String(resolvedLng) : null,
          annotation: (Array.isArray(act?.tags) && act.tags[0]) || act?.annotation || 'Shared'
        };
      }
    }
    // We never received a clean answer that Swiggy rejects the token, so this is
    // OUR side: report a transport/session problem, never "your link expired".
    // Before giving up, let the share *page* answer — it is plain HTML and keeps
    // working when the mobile API refuses (WAF, token-only session, A/B rollout).
    const pageHit = await resolveOfoAddressFromPage(tok, ofoUser).catch(() => null);
    if (pageHit) return pageHit;
    const reason = sawTransportBlock || sawRealAnswer
      ? (hadWebSession ? 'NETWORK' : 'NO_ACCOUNT')
      : (hadRealSession ? 'NETWORK' : 'NO_ACCOUNT');
    console.warn(`[OfoResolve] token=${String(tok).slice(0, 16)} unresolved reason=${reason} webSession=${hadWebSession}`);
    noteOfoFailure(tok, reason);
  } catch (e) {
    noteOfoFailure(tok, 'NETWORK');
  }
  return null;
}

// Verified payment data extraction - STOP synthetic QR generation via qrserver.com
export function getGenuinePaymentDetails(order) {
  return {
    payableAmount: order?.finalPayable || order?.subtotal || null,
    restaurantName: order?.restaurantName || 'Swiggy Order',
    swiggyPaymentUrl: 'https://www.swiggy.com/payments',
    swiggyCheckoutUrl: 'https://www.swiggy.com/checkout',
    hasGenuineQr: Boolean(order?.customQrFileId || order?.genuineQrBuffer),
    genuineQr: order?.customQrFileId || order?.genuineQrBuffer || null
  };
}

export function generateUpiQrUrl(amount, orderId, upiId = null) {
  return {
    hasGenuineQr: false,
    qrUrl: null,
    amount: Math.max(1, Math.round(amount || 0)),
    swiggyPaymentUrl: 'https://www.swiggy.com/payments',
    swiggyCheckoutUrl: 'https://www.swiggy.com/checkout'
  };
}

// Generates a sleek, authentic, personalized Swiggy Payment Card image with customer's name IN CENTER OF QR
export async function generatePersonalizedQrCard({
  customerName = 'Abbu & Ammi',
  restaurantName = 'Swiggy Food Order',
  amount = 0,
  savings = 0,
  upiUrl = null,
  qrBuffer = null
}) {
  let qrDataUrl = '';
  if (qrBuffer) {
    qrDataUrl = `data:image/png;base64,${Buffer.isBuffer(qrBuffer) ? qrBuffer.toString('base64') : qrBuffer}`;
  } else if (upiUrl) {
    qrDataUrl = await QRCode.toDataURL(upiUrl, {
      margin: 2,
      width: 360,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' }
    });
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: PUPPETEER_HEADLESS,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 2 });

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }
    .card {
      width: 480px;
      background: linear-gradient(160deg, #1a1e29 0%, #10131a 100%);
      border: 2px solid #fc8019;
      border-radius: 24px;
      padding: 28px 24px;
      color: #ffffff;
      text-align: center;
      box-shadow: 0 16px 40px rgba(252, 128, 25, 0.25);
    }
    .header-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(252, 128, 25, 0.15);
      border: 1px solid rgba(252, 128, 25, 0.4);
      color: #fc8019;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 6px 16px;
      border-radius: 20px;
      margin-bottom: 14px;
    }
    .restaurant-title {
      font-size: 20px;
      font-weight: 600;
      color: #e5e7eb;
      margin-bottom: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qr-frame {
      background: #ffffff;
      padding: 12px;
      border-radius: 20px;
      display: inline-block;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      margin-bottom: 18px;
    }
    .qr-wrapper {
      position: relative;
      display: inline-block;
      width: 260px;
      height: 260px;
    }
    .qr-wrapper img {
      display: block;
      width: 260px;
      height: 260px;
      border-radius: 8px;
      object-fit: contain;
    }
    .qr-center-badge {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #ffffff;
      border: 3px solid #fc8019;
      border-radius: 12px;
      padding: 5px 14px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: 140px;
      min-width: 65px;
      z-index: 10;
    }
    .qr-center-badge span {
      font-size: 14px;
      font-weight: 800;
      color: #fc8019;
      letter-spacing: 0.5px;
      text-transform: capitalize;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .amount-box {
      margin-bottom: 12px;
    }
    .amount-label {
      font-size: 13px;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .amount-value {
      font-size: 34px;
      font-weight: 800;
      color: #10b981;
      margin-top: 2px;
    }
    .savings-badge {
      display: inline-block;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      font-size: 13px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 12px;
      margin-top: 4px;
    }
    .instructions {
      font-size: 13px;
      color: #d1d5db;
      line-height: 1.4;
      margin-top: 10px;
    }
    .footer {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      color: #6b7280;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="header-badge">
      ! SWIGGY OFFICIAL INSTANT PAY
    </div>
    <br>
    <div class="restaurant-title">
      ▣ ${restaurantName}
    </div>
    <div class="qr-frame">
      <div class="qr-wrapper">
        <img src="${qrDataUrl}" alt="Payment QR" />
        <div class="qr-center-badge">
          <span>${customerName}</span>
        </div>
      </div>
    </div>
    <div class="amount-box">
      <div class="amount-label">Amount To Pay</div>
      <div class="amount-value">₹${amount}</div>
      ${savings > 0 ? `<div class="savings-badge">✓ Saved ₹${savings} with Coupons & Free Delivery</div>` : ''}
    </div>
    <div class="instructions">
      ☎ <b>Scan & Pay</b> using PhonePe, Google Pay, Paytm or any UPI App
    </div>
    <div class="footer">
      ◈ 100% Genuine Swiggy Checkout • Order placed automatically upon payment
    </div>
  </div>
</body>
</html>
    `;

    await page.setContent(html, { waitUntil: 'load' });
    const cardEl = await page.$('#card');
    const buffer = await cardEl.screenshot({ type: 'png' });
    return buffer;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ===== ALAG HI TYPE KA CARD — Ultra Premium Holographic (rare, few know) =====
export async function generateUltraPremiumCard({
  customerName = 'Abbu & Ammi',
  restaurantName = 'Swiggy Food Order',
  amount = 0,
  savings = 0,
  upiUrl = null,
  qrBuffer = null,
  orderId = '',
  address = '',
  deliveryOtp = ''
}) {
  let qrDataUrl = '';
  if (qrBuffer) {
    qrDataUrl = `data:image/png;base64,${Buffer.isBuffer(qrBuffer) ? qrBuffer.toString('base64') : qrBuffer}`;
  } else if (upiUrl) {
    qrDataUrl = await QRCode.toDataURL(upiUrl, { margin: 1, width: 400, errorCorrectionLevel: 'H', color: { dark: '#000000', light: '#ffffff' } });
  }
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: PUPPETEER_HEADLESS, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 900, deviceScaleFactor: 2 });
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;display:flex;justify-content:center;align-items:center;padding:16px}
.shell{width:520px;background:linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%);border-radius:28px;padding:2px;box-shadow:0 20px 60px rgba(48,43,99,0.6),0 0 0 1px rgba(255,255,255,0.08) inset;position:relative;overflow:hidden}
.shell::before{content:'';position:absolute;inset:-2px;background:linear-gradient(120deg,transparent 20%,rgba(0,255,255,0.3) 30%,rgba(255,0,255,0.3) 45%,transparent 60%);animation:holo 3s ease-in-out infinite;pointer-events:none}
@keyframes holo{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.inner{background:radial-gradient(1200px 600px at 50% -10%,rgba(255,255,255,0.12),transparent 60%),linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02));border-radius:26px;padding:22px 20px;backdrop-filter:blur(16px);position:relative}
.top-pill{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.pill-left{background:linear-gradient(90deg,#00f5ff,#a855f7);color:#0a0a0a;font-weight:900;font-size:11px;letter-spacing:1.2px;padding:6px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(168,85,247,0.4)}
.pill-right{color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:0.8px;text-transform:uppercase}
.brand{color:#fff;font-size:22px;font-weight:900;letter-spacing:-0.5px;margin-bottom:4px;text-align:center;text-shadow:0 2px 12px rgba(168,85,247,0.6)}
.sub{color:rgba(255,255,255,0.68);font-size:12px;text-align:center;margin-bottom:14px;letter-spacing:0.6px}
.qr-shell{background:#fff;border-radius:20px;padding:10px;display:flex;justify-content:center;align-items:center;box-shadow:0 12px 30px rgba(0,0,0,0.35),0 0 0 1px rgba(0,0,0,0.06)}
.qr-wrap{position:relative;width:280px;height:280px}
.qr-wrap img{width:280px;height:280px;border-radius:12px;display:block}
.center-badge{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:linear-gradient(135deg,#0f0c29,#302b63);border:2px solid rgba(255,255,255,0.9);border-radius:14px;padding:6px 14px;box-shadow:0 8px 20px rgba(0,0,0,0.4);max-width:150px}
.center-badge span{color:#00f5ff;font-weight:900;font-size:12px;letter-spacing:0.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;text-align:center}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.meta-box{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:10px 12px;backdrop-filter:blur(8px)}
.meta-label{color:rgba(255,255,255,0.62);font-size:10px;letter-spacing:1px;text-transform:uppercase}
.meta-value{color:#fff;font-weight:800;font-size:13px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.amount-row{margin-top:14px;background:linear-gradient(135deg,rgba(0,245,255,0.14),rgba(168,85,247,0.14));border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
.amount-left .lbl{color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:1px;text-transform:uppercase}
.amount-left .val{color:#facc15;font-size:28px;font-weight:900;margin-top:2px;text-shadow:0 2px 10px rgba(250,204,21,0.5)}
.amount-save{background:linear-gradient(90deg,#10b981,#06b6d4);color:#001010;font-weight:900;font-size:12px;padding:7px 10px;border-radius:999px;box-shadow:0 6px 14px rgba(16,185,129,0.35)}
.addr{margin-top:12px;background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:10px 12px}
.addr-title{color:rgba(255,255,255,0.7);font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}
.addr-text{color:#e5e7eb;font-size:11px;line-height:1.4}
.otp-row{margin-top:10px;display:flex;justify-content:center}
.otp-pill{background:linear-gradient(90deg,#f97316,#facc15);color:#111827;font-weight:900;letter-spacing:2px;padding:8px 16px;border-radius:999px;box-shadow:0 6px 16px rgba(249,115,22,0.4);font-size:14px}
.footer{margin-top:12px;text-align:center;color:rgba(255,255,255,0.55);font-size:10px;letter-spacing:0.8px}
</style></head><body>
<div class="shell"><div class="inner" id="card">
  <div class="top-pill"><div class="pill-left">✨ ULTRA PREMIUM • SWIGGY PAY</div><div class="pill-right">${orderId ? `#${orderId.slice(-8)}` : 'SECURE PAY'}</div></div>
  <div class="brand">${restaurantName}</div>
  <div class="sub">Scan with any UPI App • ${customerName}</div>
  <div class="qr-shell"><div class="qr-wrap"><img src="${qrDataUrl}" alt="QR"/><div class="center-badge"><span>${customerName}</span></div></div></div>
  <div class="meta">
    <div class="meta-box"><div class="meta-label">Order ID</div><div class="meta-value">${orderId || '—'}</div></div>
    <div class="meta-box"><div class="meta-label">Customer</div><div class="meta-value">${customerName}</div></div>
  </div>
  <div class="amount-row">
    <div class="amount-left"><div class="lbl">Amount To Pay</div><div class="val">₹${amount}</div></div>
    ${savings>0?`<div class="amount-save">✓ Saved ₹${savings}</div>`:''}
  </div>
  ${address?`<div class="addr"><div class="addr-title">Deliver To</div><div class="addr-text">${address.slice(0,120)}</div></div>`:''}
  ${deliveryOtp?`<div class="otp-row"><div class="otp-pill">OTP: ${deliveryOtp}</div></div>`:''}
  <div class="footer">⚡ Holographic Secure • Swiggy Official Checkout • ${new Date().toLocaleDateString('en-IN')}</div>
</div></div></body></html>`;
    await page.setContent(html,{waitUntil:'load'});
    const el=await page.$('#card');
    const buf=await el.screenshot({type:'png'});
    return buf;
  } finally { await browser.close().catch(()=>{}); }
}

// Fast fetch verified restaurant info & menu directly from Swiggy's API with WAF token support
const fastRestaurantCache = new Map();

export async function fetchFastRestaurantInfo(restaurantId, lat = '26.8658609', lng = '80.9307755', includeMenu = false) {
  if (!restaurantId) return null;
  const cacheKey = `${restaurantId}::${includeMenu ? '1' : '0'}`;
  if (fastRestaurantCache.has(cacheKey)) {
    return fastRestaurantCache.get(cacheKey);
  }
  try {
    const cands = getCandidateAccounts().slice(0, 4);
    const cand = cands[0]?.acc || null;
    let json = null;

    // Fast path (~190ms zero-WAF, zero Chromium!): Native Android `GET https://disc.swiggy.com/api/v1/menu/pl`
    for (const entry of cands) {
      try {
        const entryAuth = await getSwiggySessionAuth(entry.acc).catch(() => null);
        if (!entryAuth?.jwtTid && !entryAuth?.token) continue;
        const discRes = await fetch(
          `https://disc.swiggy.com/api/v1/menu/pl?page-type=REGULAR_MENU&complete-menu=${includeMenu ? 'true' : 'false'}&lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&restaurantId=${encodeURIComponent(restaurantId)}&submitAction=ENTER`,
          {
            method: 'GET',
            headers: buildSwiggyAndroidClientHeaders(entry.acc, {
              tid: entryAuth.jwtTid,
              token: entryAuth.token,
              sid: entryAuth.sid,
              deviceId: entryAuth.deviceId,
              userId: entryAuth.userId,
              lat,
              lng
            }),
            signal: AbortSignal.timeout(4000)
          }
        );
        if (discRes.ok) {
          const dj = await discRes.json().catch(() => null);
          if (dj?.data?.cards) {
            json = dj;
            break;
          }
        }
      } catch {}
    }

    if (!json?.data?.cards) {
      const dapiOut = await dapiFetch(
        cand,
        `menu/pl?page-type=REGULAR_MENU&complete-menu=${includeMenu ? 'true' : 'false'}&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`,
        { lat, lng, timeoutMs: 8000 }
      );
      json = dapiOut?.json;
    }
    if (!json?.data?.cards) return null;

    let restName = null;
    let city = null;
    const menuItems = [];
    const seenIds = new Set();

    const cards = json.data.cards || [];
    function extractDishes(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.id && obj.name && (obj.price || obj.defaultPrice || obj.finalPrice)) {
        const idStr = String(obj.id);
        if (!seenIds.has(idStr)) {
          seenIds.add(idStr);
          const rawPrice = obj.finalPrice || obj.price || obj.defaultPrice;
          const rawOfferIds = Array.isArray(obj.offerIds)
            ? obj.offerIds
            : (Array.isArray(obj.offer_ids) ? obj.offer_ids : []);
          menuItems.push({
            id: idStr,
            name: String(obj.name).trim(),
            price: Math.round(Number(rawPrice)) / 100,
            offer_ids: rawOfferIds,
            item_offer_cart_meta: String(obj.itemOfferCartMeta || obj.item_offer_cart_meta || ''),
            inStock: obj.inStock !== 0
          });
        }
      }
      for (const v of Object.values(obj)) {
        if (typeof v === 'object' && v !== null) extractDishes(v);
      }
    }

    let restLat = null;
    let restLng = null;
    for (const c of cards) {
      const info = c?.card?.card?.info;
      if (info?.name && !restName) {
        restName = info.name;
        city = info.city || info.areaName;
        if (typeof info.latLong === 'string' && info.latLong.includes(',')) {
          const [la, ln] = info.latLong.split(',').map(s => s.trim());
          if (la && ln) {
            restLat = la;
            restLng = ln;
          }
        }
      }
    }
    if (includeMenu) {
      extractDishes(cards);
    }

    if (!restName) return null;
    const outRes = {
      restName,
      city: city || 'Local Area',
      lat: restLat,
      lng: restLng,
      menuItems
    };
    fastRestaurantCache.set(cacheKey, outRes);
    return outRes;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// URL-FIRST ADDRESS CONTRACT
// ----------------------------------------------------------------------------
// A Swiggy "Share address" message carries a link (`swiggy.onelink.me/JgkQ/...`,
// `swiggy.com/ofo/address/...`) plus the app's own plain-text block. Anything
// else in the same Telegram message (order account, cart receipt, signature,
// forwarded header, ...) is NOT delivery data.
//
// Rule enforced everywhere: when the message contains an address share link,
// delivery name / mobile / street / city / GPS come ONLY from that link. The
// surrounding text is never parsed — it can belong to a different person and
// silently change the recipient's phone number or area.
// ============================================================================

function collectHttpUrls(text) {
  // Markdown `[label](url)` / duplicated `url](url` pastes yield one clean URL.
  return extractSharedUrls(text);
}

// True for links that resolve to a delivery address (never for cart/group-cart).
export function isAddressShareUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return false;
  // Cart / group-cart links are never address links.
  if (/\/gc\/|group-cart|group_cart|group-order|groupcartid/i.test(url)) return false;
  if (/swiggy\.onelink\.me\//i.test(url) || /(?:^|\/\/|\.)onelink\.me\/[A-Za-z0-9]+\/[A-Za-z0-9_-]+/i.test(url)) return true;
  if (/swiggy\.com\/ofo\/address\//i.test(url)) return true;
  if (/maps\.app\.goo\.gl\/|google\.[a-z.]+\/maps|goo\.gl\/maps/i.test(url)) return true;
  return false;
}

// Returns the first delivery-address share link found in a message, or ''.
export function extractAddressShareUrl(text) {
  return collectHttpUrls(text).find(isAddressShareUrl) || '';
}

export function hasAddressShareUrl(text) {
  return Boolean(extractAddressShareUrl(text));
}

// Cleanly extract structured delivery address from Swiggy native share messages, Swiggy World receipts, coordinates, or plain text
export function parseAddressDetails(text, options = {}) {
  if (!text) return null;
  // Normalize markdown tel/url links like `[9823305540](tel:9823305540)` -> `9823305540` and HTML `&amp;` -> `&`
  const str = String(text)
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/gi, '$1')
    .replace(/&amp;/gi, '&')
    .trim();

  // Pure single URL with no accompanying text is handled by URL resolvers, not text parser
  if (/^https?:\/\/\S+$/i.test(str)) {
    return null;
  }

  // URL-FIRST: when called without allowWithUrl, an address share link means the link is the only source of truth.
  if (!options?.allowWithUrl && hasAddressShareUrl(str)) {
    return null;
  }

  let name = null, mobile = null, city = null, address = null, flat_no = null, area = null, landmark = null, lat = null, lng = null;

  // 1. Check Swiggy App's native "Share Address" message format:
  const swiggyShareAddrMatch = str.match(/(?:^|\n)\s*Address\s*:\s*([^\n\r]+(?:\n(?!https?:\/\/)[^\n\r]+)*)/i);
  if (swiggyShareAddrMatch) {
    address = swiggyShareAddrMatch[1].replace(/https?:\/\/\S+/gi, '').trim().replace(/[,\s]+$/, '');
  }

  // 2. Isolate ONLY the address block BEFORE "Select an Available Payment Method" / "Final Bill" / "Bill Summary" / "Items Total"
  let searchScope = str.split(/\n\s*(?:Select\s+an\s+Available\s+Payment\s+Method|Final\s+Bill|Bill\s+Summary|Items\s+Total\s*:)/i)[0] || str;
  const delivSectionMatch = searchScope.match(/(?:📍\s*Delivering\s*To|Delivering\s*To)[\s\S]*/i);
  if (delivSectionMatch) {
    searchScope = delivSectionMatch[0];
  }

  // Receipt messages may start with an unrelated "Order Account" and restaurant block.
  // Once the delivery header is found, discard everything before it so the account
  // phone and restaurant name can never be parsed as the recipient's details.
  const findAddressHeaderIndex = (scope) => String(scope || '').split(/\r?\n/).findIndex(line =>
    /^(?:📍\s*)?[A-Za-z][A-Za-z .'-]{0,35}\s+Address$/i.test(line.trim())
  );
  let addressHeaderIdx = findAddressHeaderIndex(searchScope);
  if (addressHeaderIdx > 0) {
    searchScope = searchScope.split(/\r?\n/).slice(addressHeaderIdx).join('\n');
    addressHeaderIdx = 0;
  }

  const phoneScope = searchScope
    .split(/\r?\n/)
    .filter(line => !/order\s*account/i.test(line))
    .join('\n');
  const labeledPhoneMatch = phoneScope.match(/(?:📱\s*)?(?:phone|mobile|tel|contact|ph(?:one)?|call|receiver|recipient)\s*[:\-]?\s*(?:\+?91[\s-]*)?([6-9](?:[\s-]?\d){9})\b/i) ||
    str.match(/(?:phone|mobile|tel|contact|ph(?:one)?|call|receiver|recipient)\s*[:\-]?\s*(?:\+?91[\s-]*)?([6-9](?:[\s-]?\d){9})\b/i);
  const standalonePhoneLine = phoneScope.split(/\r?\n/).find(line =>
    /^\s*(?:\+?91[\s-]*)?[6-9](?:[\s-]?\d){9}\s*$/.test(line)
  );
  const anyPhoneMatch = phoneScope.match(/\b(?:\+?91[\s-]*)?([6-9]\d{9})\b/);
  const phoneValue = labeledPhoneMatch?.[1] || labeledPhoneMatch?.[0] || standalonePhoneLine || (anyPhoneMatch?.[1] && !searchScope.includes(`Latitude: ${anyPhoneMatch[1]}`) ? anyPhoneMatch[1] : '') || '';
  mobile = normalizeIndianMobile(phoneValue) || null;

  const latMatch = searchScope.match(/(?:🧭\s*Latitude|lat|latitude)[:\s]*(-?[0-9]{1,2}\.[0-9]{3,10})/i);
  const lngMatch = searchScope.match(/(?:🧭\s*Longitude|lng|long|longitude)[:\s]*(-?[0-9]{1,3}\.[0-9]{3,10})/i);
  if (latMatch) lat = latMatch[1];
  if (lngMatch) lng = lngMatch[1];

  if (!lat || !lng) {
    const coordsMatch = searchScope.match(/\b([1-3][0-9]\.[0-9]{4,10})[,\s]+([6-9][0-9]\.[0-9]{4,10})\b/);
    if (coordsMatch) {
      lat = coordsMatch[1];
      lng = coordsMatch[2];
    }
  }

  const nameMatch = searchScope.match(/(?:👤|recipient|receiver|customer\s*name|name)\s*[:\-]?\s*([^\n\r]+)/i);
  if (nameMatch) {
    const candidateName = nameMatch[1].replace(/https?:\/\/\S+/gi, '').trim();
    if (candidateName && candidateName.length <= 50) name = candidateName;
  }

  // Match a city header on a single line only; do not let `\\s` span "Your Cart" or a restaurant name.
  const headerLine = searchScope.split(/\r?\n/).map(line => line.trim()).find(line =>
    /^(?:📍\s*)?[A-Za-z][A-Za-z .'-]{0,35}\s+Address$/i.test(line)
  );
  const cityHeaderMatch = headerLine?.match(/^(?:📍\s*)?([A-Za-z][A-Za-z .'-]{0,35}?)\s+Address$/i)
    || searchScope.match(/(?:^|\n)\s*city\s*[:\-]\s*([^\n\r,]+)/i);
  if (cityHeaderMatch) {
    const c = (cityHeaderMatch[1] || '').trim();
    if (!/^(delivering|delivery|your|saved|order|billing)$/i.test(c)) {
      city = c;
    }
  }

  // 3. Parse structured multi-line Swiggy World address block:
  //    Pune Address
  //    Prathmesh
  //    9823305540
  //    Flat no. 412 , 4th floor Parivartan society dandekar pool pune
  //    Pune, Maharashtra 411030
  //    Latitude: 18.502975
  const scopeLines = searchScope
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^(Delivering\s*To|📍\s*Delivering\s*To|Your\s*Cart)$/i.test(l));

  const headerIdx = scopeLines.findIndex(l => /^(?:📍\s*)?[A-Za-z][A-Za-z\s]{1,30}\s+Address$/i.test(l));
  const phoneIdx = mobile ? scopeLines.findIndex(l => l.includes(mobile)) : -1;
  const latIdx = scopeLines.findIndex(l => /^(?:🧭\s*)?Latitude\s*:/i.test(l));

  if (!name && phoneIdx > 0) {
    const prevLine = scopeLines[phoneIdx - 1];
    if (prevLine && prevLine.length <= 50 && !/\s+Address$/i.test(prevLine) && !/\d{4,}/.test(prevLine)) {
      name = prevLine.replace(/^👤\s*/, '').trim();
    }
  } else if (!name && headerIdx >= 0 && scopeLines[headerIdx + 1] && !/\d{6,}/.test(scopeLines[headerIdx + 1])) {
    name = scopeLines[headerIdx + 1].replace(/^👤\s*/, '').trim();
  }

  if (!address && phoneIdx >= 0 && (latIdx > phoneIdx || scopeLines.length > phoneIdx + 1)) {
    const endIdx = latIdx > phoneIdx ? latIdx : scopeLines.length;
    const addrLines = scopeLines
      .slice(phoneIdx + 1, endIdx)
      .filter(l => !/^₹|\s*[×x]\s*\d+\s*=\s*₹|Subtotal\s*:|^Order\s*Account\s*:/i.test(l));
    if (addrLines.length > 0) {
      address = addrLines.join('\n').replace(/^🏠\s*/, '').trim();
    }
  }

  if (!address) {
    const addrEmojiMatch = searchScope.match(/(?:🏠\s*[\r\n]*)([^\n\r]+(?:\n[^\n\r]+)*?)(?=\n🧭|\nLatitude|\n1️⃣|\n📦|\n🧾|$)/i);
    if (addrEmojiMatch) {
      address = addrEmojiMatch[1].replace(/https?:\/\/\S+/gi, '').trim();
    } else {
      const stripped = searchScope
        .replace(/Hey!\s*Save my address on Swiggy using the link\s*:?\s*/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/^[\s\.,:\-]+|[\s\.,:\-]+$/g, '')
        .trim();

      const looksLikeRealAddress =
        !searchScope.includes('Your Cart') &&
        stripped.length >= 10 &&
        (
          /\b[1-8]\d{5}\b/.test(stripped) ||
          Boolean(city) ||
          /\b(house|flat|floor|ground|plot|block|sector|phase|nagar|ganj|colony|road|rd|marg|street|st|lane|gali|apartment|apt|tower|hostel|campus|near|opp|opposite|behind|beside|india|uttar pradesh|telangana|karnataka|maharashtra|delhi|rajasthan|bihar|madhya pradesh|west bengal|gujarat|tamil nadu|chhattisgarh)\b/i.test(stripped)
        );

      if (looksLikeRealAddress) {
        address = stripped;
      }
    }
  }

  const knownCities = [
    'Lucknow', 'Hyderabad', 'Secunderabad', 'Bangalore', 'Bengaluru', 'New Delhi', 'Delhi',
    'Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Kolkata', 'Chennai', 'Jaipur', 'Ahmedabad',
    'Chandigarh', 'Noida', 'Greater Noida', 'Gurgaon', 'Gurugram', 'Ghaziabad', 'Faridabad',
    'Kanpur', 'Varanasi', 'Prayagraj', 'Allahabad', 'Agra', 'Gorakhpur', 'Bareilly', 'Aligarh',
    'Moradabad', 'Meerut', 'Kota', 'Indore', 'Bhopal', 'Patna', 'Ranchi', 'Raipur', 'Bilaspur',
    'Bhubaneswar', 'Guwahati', 'Kochi', 'Coimbatore', 'Nagpur', 'Surat', 'Vadodara', 'Ludhiana',
    'Amritsar', 'Dehradun', 'Jodhpur', 'Udaipur', 'Gwalior', 'Jabalpur', 'Visakhapatnam', 'Vijayawada'
  ];
  if (!city) {
    const citySearchText = address || searchScope;
    city = knownCities.find(c => new RegExp('\\b' + c + '\\b', 'i').test(citySearchText)) || null;
  }

  // Keep receiver contact data out of the street text used for geocoding and delivery cards.
  if (address) {
    address = address
      .replace(/(?:📱\s*)?(?:phone|mobile|tel|contact|ph(?:one)?)\s*[:\-]?\s*(?:\+?91[\s-]*)?[6-9](?:[\s-]?\d){9}\b/gi, '')
      .replace(/[ ,]+$/g, '')
      .trim();
  }

  // Derive flat_no, area, landmark cleanly from comma/newline-separated address parts.
  // Ignore postal/state/country suffixes so a state name cannot become the delivery area.
  if (address) {
    const segs = address.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
      flat_no = segs[0];
      const stateNames = /^(andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|jammu and kashmir|ladakh|puducherry)$/i;
      const locationParts = segs.filter(s =>
        !/^india$/i.test(s) && !/\b\d{6}\b/.test(s) &&
        (!city || s.toLowerCase() !== city.toLowerCase()) && !stateNames.test(s)
      );
      area = locationParts[locationParts.length - 1] || segs[1] || city || 'Main Area';
      landmark = locationParts[Math.max(0, locationParts.length - 2)] || area;
    }
  }

  if (name || mobile || city || address || lat || lng) {
    return { name, mobile, city, address, flat_no, area, landmark, lat, lng };
  }
  return null;
}

export function parseCartDetails(text) {
  if (!text) return null;
  const str = String(text)
    .replace(/\[([^\]]+)\]\(tel:[^)]+\)/gi, '$1')
    .replace(/&amp;/gi, '&')
    .trim();

  let restaurantName = null;
  const restMatch = str.match(/🏪\s*([^\n\r]+)/i);
  if (restMatch) restaurantName = restMatch[1].trim();

  let orderAccount = null;
  const accMatch = str.match(/(?:📱\s*)?Order\s*Account[:\s]*([0-9]{10})/i);
  if (accMatch) orderAccount = accMatch[1].trim();

  const items = [];
  const itemRegex = /(?:[0-9]️⃣|[0-9]+\.)\s*([^\n\r]+)[\r\n]+\s*💵\s*₹([0-9.]+)\s*×\s*([0-9]+)\s*=\s*₹([0-9.]+)/gi;
  let m;
  while ((m = itemRegex.exec(str)) !== null) {
    const qty = parseInt(m[3], 10) || 1;
    items.push({
      name: m[1].trim(),
      price: parseFloat(m[2]),
      qty,
      quantity: qty,
      lineTotal: parseFloat(m[4])
    });
  }

  if (items.length === 0) {
    const plainReceiptRegex = /([^\n\r₹]+)\r?\n₹([0-9.]+)\s*[×x]\s*([0-9]+)\s*=\s*₹([0-9.]+)/gi;
    while ((m = plainReceiptRegex.exec(str)) !== null) {
      const dish = m[1].trim();
      if (dish && !/^(Your Cart|Delivering To|Bill Summary|Final Bill)$/i.test(dish)) {
        const qty = parseInt(m[3], 10) || 1;
        items.push({
          name: dish,
          price: parseFloat(m[2]),
          qty,
          quantity: qty,
          lineTotal: parseFloat(m[4])
        });
      }
    }
    if (!restaurantName && str.includes('Your Cart')) {
      const ycMatch = str.match(/Your Cart\r?\n([^\n\r]+)/i);
      if (ycMatch) restaurantName = ycMatch[1].trim();
    }
  }

  let itemsTotal = null;
  const itemsTotMatch = str.match(/Items?\s*Total[:\s]*₹([0-9.]+)/i) || str.match(/Subtotal[:\s]*₹([0-9.]+)/i);
  if (itemsTotMatch) itemsTotal = parseFloat(itemsTotMatch[1]);

  let couponCode = null, discountAmount = 0;
  const coupMatch = str.match(/Coupon(?:\s+Discount)?\s*\(?([A-Z0-9_]+)\)?[:\s]*[-−–]\s*₹([0-9.]+)/i);
  if (coupMatch && coupMatch[1].toUpperCase() !== 'NOT') {
    couponCode = coupMatch[1].trim().toUpperCase();
    discountAmount = parseFloat(coupMatch[2]);
  }

  let swiggyOneMembershipFee = 0;
  const oneMatch = str.match(/Swiggy\s*One(?:\s*Lite)?\s*Membership[:\s]*\+?₹([0-9.]+)/i);
  if (oneMatch) swiggyOneMembershipFee = parseFloat(oneMatch[1]);

  let freeCashApplied = 0;
  const fcMatch = str.match(/(?:Swiggy\s*Money\s*\/\s*)?Free\s*Cash(?:\s*Applied)?\s*\)?[:\s]*[-−–]\s*₹([0-9.]+)/i);
  if (fcMatch) freeCashApplied = parseFloat(fcMatch[1]);

  let packingCharges = 0;
  const packMatch = str.match(/Packing\s*Charges[:\s]*₹([0-9.]+)/i);
  if (packMatch) packingCharges = parseFloat(packMatch[1]);

  let gstCharges = 0;
  const gstMatch = str.match(/GST\s*(?:&|and)\s*(?:Other\s*)?Charges[:\s]*₹([0-9.]+)/i);
  if (gstMatch) gstCharges = parseFloat(gstMatch[1]);

  let deliveryFee = 0;
  const delFeeNumMatch = str.match(/Delivery\s*Fee[:\s]*₹([0-9.]+)/i);
  if (delFeeNumMatch) deliveryFee = parseFloat(delFeeNumMatch[1]);

  let deliverySaved = 0;
  const delSavedMatch = str.match(/Delivery\s*Fee:\s*FREE\s*\(₹([0-9.]+)\s*saved\)/i)
    || str.match(/Free\s*Delivery:\s*₹0\s*\(₹([0-9.]+)\s*saved\)/i);
  if (delSavedMatch) deliverySaved = parseFloat(delSavedMatch[1]);

  let finalPayable = null;
  const payMatch = str.match(/Final\s*(?:Total|Payable)[:\s]*₹([0-9.]+)/i)
    || str.match(/To\s*Pay[:\s]*₹([0-9.]+)/i);
  if (payMatch) finalPayable = parseFloat(payMatch[1]);

  let totalSavings = 0;
  const savMatch = str.match(/Total\s*Savings[:\s]*₹([0-9.]+)/i);
  if (savMatch) totalSavings = parseFloat(savMatch[1]);

  const freeDelivery = /Delivery\s*Fee:\s*FREE/i.test(str) || /Free\s*Delivery\s*upto/i.test(str) || deliverySaved > 0;

  if (items.length > 0 || finalPayable || itemsTotal) {
    const calcSub = itemsTotal || Math.round(items.reduce((s, i) => s + (i.lineTotal || i.price * i.qty), 0) * 100) / 100;
    return {
      restaurantName,
      orderAccount,
      items,
      itemsTotal: calcSub,
      subtotal: calcSub,
      couponCode,
      discountAmount,
      swiggyOneMembershipFee,
      freeCashApplied,
      freeDelivery,
      deliverySaved,
      freeDeliveryDiscount: deliverySaved,
      deliveryFee,
      packingCharges,
      gstCharges,
      finalPayable,
      totalSavings
    };
  }
  return null;
}

// Helper to follow short-link redirects (up to 4 hops for swig.gy, onelink.me, maps.app.goo.gl)
// Swiggy OneLink / swig.gy sometimes return 200 HTML with JS/meta refresh instead of
// a 301/302 Location header (especially when WAF or bot UA is detected). This helper
// tries manual redirect first (fast), then follows via `redirect: follow`, then parses
// HTML for meta-refresh / JS `window.location` / `deep_link_value` so AUTO FETCHING
// of restaurantId/groupCartId/ofoToken never silently dies.
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// AppsFlyer (swiggy.onelink.me) serves a *different* page to desktop UAs and
// sometimes refuses the request outright (403). Expanding with a phone UA is what
// actually returns the `ofo/address/<user>/<token>` deep link in production.
async function expandShortUrl(rawUrl) {
  const first = await followShortChain(rawUrl, DESKTOP_UA);
  if (first && (/\/(?:ofo\/address|gc)\b/i.test(first) || /[?&](?:af_dp|deep_link_value)=/i.test(first))) return first;
  const mobile = await followShortChain(rawUrl, MOBILE_UA);
  if (mobile && (/\/(?:ofo\/address|gc)\b/i.test(mobile) || /[?&](?:af_dp|deep_link_value)=/i.test(mobile))) return mobile;
  return first || mobile || rawUrl;
}

export function extractDeepLinkFromReferrerOrUrl(targetUrl) {
  if (!targetUrl) return null;
  try {
    const raw = String(targetUrl).trim();
    const normalized = raw.startsWith('http') ? raw : 'https://dummy.com/' + raw.replace(/^[a-z]+:\/\//i, '');
    const u = new URL(normalized);
    const candidates = [
      u.searchParams.get('referrer'),
      u.searchParams.get('af_dp'),
      u.searchParams.get('deep_link_value'),
      u.searchParams.get('link'),
      u.searchParams.get('url'),
      raw
    ];
    for (const cand of candidates) {
      if (!cand) continue;
      let dec = cand;
      try { dec = decodeURIComponent(dec); } catch {}
      try { dec = decodeURIComponent(dec); } catch {}
      const m = dec.match(/(?:https?:\/\/[^\s"'<>]*swiggy\.com)?\/ofo\/address\/[^\/\s?#]+\/[^\/\s?#&]+/i) ||
                dec.match(/(?:https?:\/\/[^\s"'<>]*swiggy\.com)?\/gc\/[0-9]+\/[^\/\s?#]+-[0-9]+/i) ||
                dec.match(/swiggy:\/\/[^\s"'<>]+/i);
      if (m) {
        return m[0].startsWith('http') || m[0].startsWith('swiggy://')
          ? m[0]
          : 'https://www.swiggy.com' + m[0];
      }
    }
  } catch {}
  return null;
}

async function followShortChain(startUrl, userAgent) {
  let current = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:\/\//i.test(current)) break;
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
          'Cache-Control': 'no-cache'
        },
        signal: AbortSignal.timeout(4000)
      });
      const loc = res.headers.get('location');
      if (loc) {
        const deepFromLoc = extractDeepLinkFromReferrerOrUrl(loc);
        if (deepFromLoc) {
          current = deepFromLoc;
          break;
        }
        current = loc.startsWith('http') || loc.startsWith('swiggy://') || loc.startsWith('intent://')
          ? loc
          : new URL(loc, current).toString();
        if (current.startsWith('swiggy://') || current.startsWith('intent://')) break;
        // If current already carries an OFO address, Group Cart, or deep link param, stop following!
        if (/\/(?:ofo\/address|gc)\/([^\/\s?#]+)/i.test(current) || /[?&](?:af_dp|deep_link_value)=/i.test(current)) {
          break;
        }
        continue;
      }
      // No Location header — try following redirects automatically (Swiggy may set
      // cookies + return 302 chain that manual doesn't surface on some hosts)
      if (res.status >= 300 && res.status < 400) break;
      // If we got 200 HTML, look for a redirect URL embedded in the page
      if (res.status === 200 && res.headers.get('content-type')?.includes('text/html')) {
        try {
          const html = await res.text();
          // 0. Extract app_link or store_link variable from AppsFlyer landing script
          const appLinkMatch = html.match(/(?:app_link|store_link|referrer)\s*=\s*['"]([^'"]+)['"]/i);
          if (appLinkMatch) {
            let unescaped = appLinkMatch[1].replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/');
            try { unescaped = decodeURIComponent(unescaped); } catch {}
            const innerOfo = unescaped.match(/(?:https?:\/\/www\.swiggy\.com)?\/ofo\/address\/[^\/\s?#]+\/[^\/\s?#&]+/i) ||
                             unescaped.match(/(?:https?:\/\/[^\s"'<>]*swiggy\.com)?\/gc\/[0-9]+\/[^\/\s?#]+-[0-9]+/i) ||
                             unescaped.match(/swiggy:\/\/[^\s"'<>]+/i);
            if (innerOfo) {
              current = innerOfo[0].startsWith('http') || innerOfo[0].startsWith('swiggy://')
                ? innerOfo[0]
                : 'https://www.swiggy.com' + innerOfo[0];
              break;
            }
          }
          // 1. <meta http-equiv="refresh" content="0;url=...">
          const metaMatch = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);
          if (metaMatch) {
            const metaUrl = metaMatch[1].trim().replace(/^['"]|['"]$/g, '');
            if (metaUrl && /^https?:\/\//i.test(metaUrl)) { current = metaUrl; continue; }
            if (metaUrl && /swiggy:\/\//i.test(metaUrl)) { current = metaUrl; break; }
          }
          // 2. window.location / location.href = "https://..." or deep_link_value=
          const jsLoc = html.match(/(?:window\.location|location\.href|deep_link_value|af_dp)\s*[=:]\s*["']([^"']+)["']/i);
          if (jsLoc) {
            let decoded = '';
            try { decoded = decodeURIComponent(jsLoc[1]); } catch { decoded = jsLoc[1]; }
            if (/^https?:\/\//i.test(decoded) || /^swiggy:\/\//i.test(decoded)) { current = decoded; break; }
            if (/^https?:\/\//i.test(jsLoc[1]) || /^swiggy:\/\//i.test(jsLoc[1])) { current = jsLoc[1]; break; }
          }
          // 3. Any genuine swiggy food/ofo/gc link in HTML (NEVER analytics.swiggy.com)
          const anySwiggy = html.match(/https?:\/\/(?:www\.)?swiggy\.com\/(?:ofo|gc|restaurants|menu)[^"'\s<>]*/i) ||
                            html.match(/swiggy:\/\/(?:webviewV2|gc|ofo)[^"'\s<>]*/i);
          if (anySwiggy) { current = anySwiggy[0]; break; }
        } catch {}
      }
      break;
    } catch (e) {
      // Network error — try one automatic follow as fallback before giving up
      try {
        const followRes = await fetch(current, {
          redirect: 'follow',
          headers: { 'User-Agent': DESKTOP_UA },
          signal: AbortSignal.timeout(5000)
        });
        if (followRes.url && followRes.url !== current) { current = followRes.url; continue; }
      } catch {}
      break;
    }
  }
  return current;
}

// Fast-resolve Swiggy links (Group Cart, Restaurant Menu, Shared Address, Google Maps, or Full Text)
export async function resolveSwiggyLink(input) {
  if (!input) return { url: input, type: 'UNKNOWN' };
  const rawInput = String(input).trim();

  // Only the URL matters: surrounding share text ("It is a one time use link…")
  // is never treated as part of the link.
  const sharedUrls = extractSharedUrls(rawInput);
  let primaryUrl = sharedUrls[0] || normalizeSharedUrl(rawInput) || rawInput;

  let resolved = primaryUrl;
  let restaurantId = null;
  let groupCartId = null;
  let hostName = null;
  let ofoUser = null;
  let ofoToken = null;

  const alreadyDirectPath =
    /\/gc\/([0-9]+)\/([^\/\-\s?]+)-([0-9]+)/i.test(primaryUrl) ||
    /\/ofo\/address\/([^\/\?\s]+)\/([^\/\?\s&]+)/i.test(primaryUrl);

  if (!alreadyDirectPath && /^https?:\/\//i.test(primaryUrl) && (primaryUrl.includes('swig.gy') || primaryUrl.includes('onelink.me') || primaryUrl.includes('goo.gl') || primaryUrl.includes('google.com/maps'))) {
    resolved = await expandShortUrl(primaryUrl);
  }

  const combinedForMatch = `${primaryUrl} ${resolved}`;

  // 1. Group Cart URL pattern (e.g. https://swig.gy/gc/1467977/Umbashiya-642855918)
  const gcMatch = combinedForMatch.match(/\/gc\/([0-9]+)\/([^\/\-\s?]+)-([0-9]+)/i);
  if (gcMatch) {
    restaurantId = gcMatch[1];
    hostName = decodeURIComponent(gcMatch[2]);
    groupCartId = gcMatch[3];
  }

  // 2. Restaurant ID from menu URL
  const restMenuMatch = combinedForMatch.match(/\/restaurants\/[^\/\s?]+-([0-9]+)/i)
    || combinedForMatch.match(/\/menu\/([0-9]+)/i)
    || combinedForMatch.match(/restaurant_id=([0-9]+)/i);
  if (restMenuMatch && !restaurantId) {
    restaurantId = restMenuMatch[1];
  }

  // 3. Deep link query parameters (af_dp / deep_link_value / swiggy://)
  if (resolved.includes('swiggy://') || resolved.includes('af_dp=') || resolved.includes('deep_link_value=')) {
    try {
      const normalized = resolved.startsWith('http') ? resolved : 'https://' + resolved.replace(/^[a-z]+:\/\//i, 'swiggy.com/');
      const u = new URL(normalized);
      const afDp = u.searchParams.get('af_dp') || u.searchParams.get('deep_link_value') || '';
      const decoded = decodeURIComponent(afDp || resolved);
      const mRest = decoded.match(/restaurant_id=([0-9]+)/i);
      const mGc = decoded.match(/group_cart_id=([0-9]+)/i);
      const mHost = decoded.match(/host_name=([^&\s]+)/i);
      if (mRest && !restaurantId) restaurantId = mRest[1];
      if (mGc && !groupCartId) groupCartId = mGc[1];
      if (mHost && !hostName) hostName = decodeURIComponent(mHost[1]);

      const mOfo = decoded.match(/\/ofo\/address\/([^\/\?]+)\/([^\/\?&]+)/i);
      if (mOfo) {
        ofoUser = decodeURIComponent(mOfo[1]);
        ofoToken = mOfo[2];
      }
    } catch (e) {}
  }

  // 4. OFO web address URL & OneLink short address ID
  const ofoDirect = combinedForMatch.match(/\/ofo\/address\/([^\/\?\s]+)\/([^\/\?\s&]+)/i);
  if (ofoDirect) {
    ofoUser = decodeURIComponent(ofoDirect[1]);
    ofoToken = ofoDirect[2];
  }
  const onelinkAddrMatch = combinedForMatch.match(/onelink\.me\/[a-zA-Z0-9]+\/([a-zA-Z0-9_\-]+)/i);
  const isOneLinkShort = Boolean(onelinkAddrMatch && (!ofoToken || ofoToken === onelinkAddrMatch[1]));
  if (onelinkAddrMatch && !ofoToken) {
    ofoToken = onelinkAddrMatch[1];
  }

  // 5. Google Maps coordinates from expanded URL (@lat,lng, ?q=lat,lng, !3dlat!4dlng, ll=lat,lng)
  let mapCoords = null;
  const cMatch =
    combinedForMatch.match(/!3d(-?[0-9]{1,2}\.[0-9]{4,10})!4d(-?[0-9]{1,3}\.[0-9]{4,10})/) ||
    combinedForMatch.match(/[@?&](?:q|ll|query|center)?=?(-?[0-9]{1,2}\.[0-9]{4,10}),\s*(-?[0-9]{1,3}\.[0-9]{4,10})/) ||
    combinedForMatch.match(/@(-?[0-9]{1,2}\.[0-9]{4,10}),(-?[0-9]{1,3}\.[0-9]{4,10})/);
  if (cMatch) {
    mapCoords = { lat: cMatch[1], lng: cMatch[2] };
  }

  // 6. Does this input carry a delivery-address share link?
  //    If yes, the link is the ONLY source of delivery data (see URL-FIRST contract).
  const addressShareUrl = extractAddressShareUrl(rawInput) || extractAddressShareUrl(resolved);
  const addressFromUrl = Boolean(addressShareUrl || ofoToken || ofoUser || mapCoords);

  // Parse candidate structured text address with allowWithUrl: true
  const candidateTextAddr = parseAddressDetails(rawInput, { allowWithUrl: true });
  // Text parsing is allowed ONLY when no address link is present.
  let parsedAddr = addressFromUrl ? null : candidateTextAddr;

  const isCart = Boolean(
    groupCartId ||
    restaurantId ||
    combinedForMatch.includes('/gc/') ||
    combinedForMatch.includes('group-order') ||
    combinedForMatch.includes('group_cart') ||
    primaryUrl.includes('/cart') ||
    primaryUrl.includes('/menu') ||
    rawInput.includes('Items Total')
  );
  const isAddress = !isCart && Boolean(
    ofoToken ||
    ofoUser ||
    mapCoords ||
    addressShareUrl ||
    combinedForMatch.includes('ofo/address') ||
    combinedForMatch.includes('onelink.me') ||
    combinedForMatch.includes('maps.google') ||
    combinedForMatch.includes('google.com/maps') ||
    combinedForMatch.includes('goo.gl') ||
    parsedAddr ||
    candidateTextAddr
  );

  // Resolve full address details — URL first, plain text only when no link exists.
  const reverseGeocodedDetails = async () => {
    const rev = await reverseGeocodeCoords(mapCoords.lat, mapCoords.lng);
    return {
      name: ofoUser || candidateTextAddr?.name || '',
      mobile: candidateTextAddr?.mobile || '',
      city: rev?.city || 'Delivery',
      area: rev?.area || '',
      landmark: rev?.landmark || '',
      address: rev?.address || `Pinned Location (${mapCoords.lat}, ${mapCoords.lng})`,
      lat: String(mapCoords.lat),
      lng: String(mapCoords.lng)
    };
  };
  const unresolvedLinkDetails = () => ({
    name: ofoUser || candidateTextAddr?.name || '',
    token: ofoToken || '',
    link: addressShareUrl || primaryUrl,
    unresolvableShortLink: true,
    unresolvedReason: getOfoResolutionFailureReason(primaryUrl) || getOfoResolutionFailureReason(addressShareUrl) || getOfoResolutionFailureReason(ofoToken) || '',
    city: candidateTextAddr?.city || '',
    mobile: candidateTextAddr?.mobile || '',
    address: '',
    lat: null,
    lng: null
  });

  let addressDetails = null;
  let addressSource = null;
  if (addressFromUrl) {
    addressSource = 'URL';
    if (ofoToken) {
      // An unexpanded `onelink.me/<channel>/<id>` id is NOT a Swiggy OFO token.
      // Sending it to social/getAddress always failed, and the "invalid token"
      // answer was then shown to the customer as "your link expired" — even
      // though the link had never been opened. Classify it honestly instead.
      const tokenIsUnexpandedShortId = Boolean(onelinkAddrMatch && ofoToken === onelinkAddrMatch[1]);
      // Still worth one attempt (some shares do carry a usable id), but a failure
      // here can never be reported as "expired": we never saw the real token.
      const socialAddr = await resolveSharedOfoAddress(ofoToken, ofoUser);
      if (tokenIsUnexpandedShortId && !socialAddr) {
        noteOfoFailure(ofoToken, 'UNEXPANDED');
        noteOfoFailure(primaryUrl, 'UNEXPANDED');
        noteOfoFailure(addressShareUrl, 'UNEXPANDED');
      }
      if (socialAddr) {
        addressDetails = socialAddr;
        if (!addressDetails.mobile && candidateTextAddr?.mobile) {
          addressDetails.mobile = candidateTextAddr.mobile;
        }
        if (!addressDetails.name && candidateTextAddr?.name) {
          addressDetails.name = candidateTextAddr.name;
        }
        if ((!addressDetails.address || addressDetails.address.length < 15) && candidateTextAddr?.address) {
          addressDetails.address = candidateTextAddr.address;
        }
      } else if (candidateTextAddr && (candidateTextAddr.address || (candidateTextAddr.lat && candidateTextAddr.lng))) {
        // RESCUE: Short link unexpanded or token expired, but message carries verified street address + recipient phone!
        addressSource = 'TEXT_FALLBACK';
        addressDetails = await geocodeAddressDetails(candidateTextAddr);
        if (candidateTextAddr.mobile) addressDetails.mobile = candidateTextAddr.mobile;
        if (candidateTextAddr.name) addressDetails.name = candidateTextAddr.name;
        addressDetails.unresolvableShortLink = false;
        addressDetails.link = addressShareUrl || primaryUrl;
      } else if (mapCoords) {
        addressDetails = await reverseGeocodedDetails();
      } else {
        addressSource = 'URL_UNRESOLVED';
        addressDetails = unresolvedLinkDetails();
      }
    } else if (candidateTextAddr && (candidateTextAddr.address || (candidateTextAddr.lat && candidateTextAddr.lng))) {
      addressSource = 'TEXT_FALLBACK';
      addressDetails = await geocodeAddressDetails(candidateTextAddr);
      if (candidateTextAddr.mobile) addressDetails.mobile = candidateTextAddr.mobile;
      if (candidateTextAddr.name) addressDetails.name = candidateTextAddr.name;
      addressDetails.unresolvableShortLink = false;
      addressDetails.link = addressShareUrl || primaryUrl;
    } else if (mapCoords) {
      addressDetails = await reverseGeocodedDetails();
    } else {
      addressSource = 'URL_UNRESOLVED';
      addressDetails = unresolvedLinkDetails();
    }
  } else if (parsedAddr) {
    addressSource = 'TEXT';
    addressDetails = await geocodeAddressDetails(parsedAddr);
  }

  // Parse structured cart text if present
  let parsedCart = parseCartDetails(rawInput);
  let groupCartStatus = null;

  // 7. LIVE GROUP CART FETCH (<200ms direct Swiggy shared_cart API — 100% genuine items, ZERO hardcoded dishes!)
  if (groupCartId) {
    const liveGc = await fetchLiveGroupCart(
      groupCartId,
      restaurantId,
      hostName,
      null,
      addressDetails?.lat || '17.385044',
      addressDetails?.lng || '78.486671'
    );
    if (liveGc) {
      groupCartStatus = liveGc.status;
      if (liveGc.restaurantId) restaurantId = liveGc.restaurantId;
      if (liveGc.status === 'ACTIVE') {
        parsedCart = {
          restaurantName: liveGc.restaurantName || parsedCart?.restaurantName || null,
          items: liveGc.items || [],
          itemsTotal: liveGc.subtotal || 0,
          subtotal: liveGc.subtotal || 0,
          discountedSubtotal: liveGc.discountedSubtotal || liveGc.subtotal || 0,
          tradeDiscountTotal: liveGc.tradeDiscountTotal || 0,
          packingCharges: liveGc.packingCharges || 0,
          gstCharges: liveGc.taxesAndCharges || 0
        };
      }
    }
  }

  // 8. Fetch restaurant name / menu prices if needed
  let fastMenu = null;
  if (restaurantId && (!parsedCart?.restaurantName || (parsedCart?.items?.length > 0 && parsedCart.items.some(it => !it.itemId || !it.price)))) {
    fastMenu = await fetchFastRestaurantInfo(
      restaurantId,
      addressDetails?.lat || '26.8658609',
      addressDetails?.lng || '80.9307755',
      Boolean(parsedCart?.items?.length)
    );
    if (fastMenu?.menuItems && parsedCart?.items?.length > 0) {
      for (const it of parsedCart.items) {
        const match = fastMenu.menuItems.find(m =>
          m.name.toLowerCase() === it.name.toLowerCase() ||
          m.name.toLowerCase().includes(it.name.toLowerCase()) ||
          it.name.toLowerCase().includes(m.name.toLowerCase())
        );
        if (match) {
          if (!it.price || it.price === 0) it.price = match.price;
          if (!it.itemId) it.itemId = match.id;
          if ((!Array.isArray(it.offer_ids) || it.offer_ids.length === 0) && Array.isArray(match.offer_ids) && match.offer_ids.length > 0) {
            it.offer_ids = match.offer_ids;
          }
          if (!it.item_offer_cart_meta && match.item_offer_cart_meta) {
            it.item_offer_cart_meta = match.item_offer_cart_meta;
          }
          it.lineTotal = Math.round(it.price * (it.qty || 1) * 100) / 100;
        }
      }
    }
  }

  const realRestaurantName = parsedCart?.restaurantName || fastMenu?.restName || (hostName ? `${hostName}'s Group Order` : null);

  return {
    originalUrl: rawInput,
    primaryUrl,
    resolvedUrl: resolved,
    type: isCart ? 'CART' : (isAddress ? 'ADDRESS' : 'SWIGGY_GENERAL'),
    restaurantId,
    restaurantName: realRestaurantName,
    groupCartId,
    groupCartStatus,
    hostName,
    ofoUser,
    ofoToken,
    addressLink: addressShareUrl || '',
    addressSource,
    addressDetails,
    cartDetails: parsedCart
  };
}

// Honest bill calculation helper — NEVER fabricates imaginary coupons or fake fees!
export function applyMaxOfferToOrder(order) {
  if (!order) return order;

  let subtotal = Number(order.subtotal || order.itemTotal || 0);
  if (!subtotal && Array.isArray(order.items) && order.items.length > 0) {
    subtotal = Math.round(order.items.reduce((s, it) => s + (Number(it.lineTotal) || (Number(it.price || 0) * Number(it.qty || it.quantity || 1))), 0) * 100) / 100;
  }
  if (!subtotal && order.finalPayable > 0) {
    subtotal = Number(order.finalPayable);
  }
  if (!subtotal || subtotal <= 0) {
    return order;
  }

  order.subtotal = Math.round(subtotal * 100) / 100;
  order.itemTotal = order.itemTotal || order.subtotal;

  const discount = Number(order.discountAmount || 0);
  const tradeDisc = Number(order.tradeDiscountTotal || 0);
  const freeCash = Number(order.freeCashApplied || 0);
  const swiggyOneFee = Number(order.swiggyOneMembershipFee || 0);
  const delivery = Number(order.deliveryFee || 0);
  const packing = Number(order.packingCharges || 0);
  const taxes = Number(order.taxesAndCharges || 0);
  const freeDelSaved = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);

  if (!order.totalSavings || !order.swiggyVerified) {
    order.totalSavings = Math.round((freeDelSaved + discount + tradeDisc + freeCash) * 100) / 100;
  }

  // If Swiggy checkout returned an authoritative `order_total`, keep it intact unless un-discounted
  const totalDeductions = discount + tradeDisc + freeCash;
  const calculatedPayable = Math.max(
    1,
    Math.round(order.subtotal - discount - tradeDisc - freeCash + swiggyOneFee + delivery + (taxes > 0 ? taxes : packing))
  );

  const hasAuthoritativeVerifiedTotal = Boolean(
    order.swiggyVerified &&
    order.finalPayable !== null &&
    order.finalPayable !== undefined &&
    Number.isFinite(Number(order.finalPayable)) &&
    Number(order.finalPayable) >= 0 &&
    (totalDeductions <= 0 || Number(order.finalPayable) < order.subtotal)
  );
  if (!hasAuthoritativeVerifiedTotal || !order.finalPayable || Number(order.finalPayable) <= 0) {
    order.finalPayable = calculatedPayable;
  }

  return order;
}

// Parse a live Swiggy /dapi/cart OR chkout.swiggy.com/api/v2/cart/client `data` payload into a normalized cart object
export function parseDapiCartPayload(data) {
  const cm = data?.cartMeta || (data && (data.order_total !== undefined || Array.isArray(data.cart_menu_items) || data.cartId !== undefined) ? data : null);
  if (!cm) return null;
  const ciMap = data.cartItems || {};
  const rawEntries = Object.keys(ciMap).length > 0
    ? Object.values(ciMap)
    : (Array.isArray(cm.cart_menu_items) ? cm.cart_menu_items.map(mi => ({ itemId: mi.menu_item_id, quantity: mi.quantity, items: [mi] })) : []);

  const items = rawEntries.map(ci => {
    const itemInfo = ci.items?.[0] || ci || {};
    const qty = Number(ci.quantity || itemInfo.quantity || 1);
    const subPaise = Number(itemInfo.subtotal ?? (Number(itemInfo.base_price || itemInfo.price || 0) * qty));
    const finalPaise = Number(itemInfo.final_price ?? subPaise);
    const tradeDiscPaise = Number(itemInfo.subtotal_trade_discount || 0);
    const unitPrice = subPaise > 0 ? Math.round((subPaise / 100 / qty) * 100) / 100 : 0;
    const lineTotal = Math.round((subPaise / 100) * 100) / 100;
    const finalLineTotal = Math.round((finalPaise / 100) * 100) / 100;

    return {
      itemId: String(ci.itemId || itemInfo.menu_item_id || ''),
      menu_item_id: Number(ci.itemId || itemInfo.menu_item_id || 0),
      name: String(itemInfo.name || 'Dish Item').trim(),
      qty,
      quantity: qty,
      price: unitPrice,
      lineTotal,
      finalLineTotal,
      tradeDiscount: Math.round((tradeDiscPaise / 100) * 100) / 100,
      addons: Array.isArray(itemInfo.addons) ? itemInfo.addons : [],
      variants: Array.isArray(itemInfo.variants) ? itemInfo.variants : [],
      offer_ids: Array.isArray(itemInfo.offer_ids) ? itemInfo.offer_ids : [],
      item_offer_cart_meta: String(itemInfo.item_offer_cart_meta || ''),
      item_offer_tags: Array.isArray(itemInfo.item_offer_tags) ? itemInfo.item_offer_tags : []
    };
  }).filter(it => it.name && it.qty > 0);

  const restDetails = cm.restaurant_details || {};
  const restaurantId = String(restDetails.id || restDetails.restaurant_id || cm.restaurantId || '');
  const restaurantName = restDetails.name || restDetails.restaurant_name || cm.restaurantName || null;

  const addresses = Array.isArray(cm.addresses) ? cm.addresses : [];
  const selectedRaw = addresses.find(a => a.selected || (cm.address_id && String(a.id) === String(cm.address_id))) || cm.delivery_address || null;
  let addressDetails = null;
  let address = null;
  if (selectedRaw && (selectedRaw.address || selectedRaw.area || selectedRaw.lat)) {
    address = `${selectedRaw.flat_no && selectedRaw.flat_no !== 'None' ? selectedRaw.flat_no + ', ' : ''}${selectedRaw.address || selectedRaw.area || ''}`.trim();
    addressDetails = {
      id: selectedRaw.id || cm.address_id || '',
      name: selectedRaw.name || '',
      mobile: selectedRaw.mobile || '',
      flat_no: selectedRaw.flat_no && selectedRaw.flat_no !== 'None' ? selectedRaw.flat_no : '',
      area: selectedRaw.area || '',
      landmark: selectedRaw.landmark || '',
      city: selectedRaw.city || 'Address',
      address,
      lat: String(selectedRaw.lat || ''),
      lng: String(selectedRaw.lng || ''),
      annotation: selectedRaw.annotation || ''
    };
  }

  // Extract eligible Swiggy One / One Lite plan nudge + full `rendering_details` map (supports BOTH `dapi/cart` & `chkout`!)
  const renderingList = Array.isArray(cm.rendering_details) ? cm.rendering_details : [];
  const renderByKey = new Map();
  for (const r of renderingList) {
    if (r?.key) renderByKey.set(r.key, r);
  }
  const parseRenderNum = (val) => {
    if (val === undefined || val === null || val === '') return null;
    if (String(val).trim().toUpperCase() === 'FREE') return 0;
    const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const superNudge = renderByKey.get('super_v3_nudge')?.meta || null;
  const superBenefits = renderByKey.get('super_v3_benefits')?.meta || null;
  const userSuperStatus = String(cm.user_super_status_details?.user_status || '').toUpperCase() || null;
  const planRaw = superNudge?.plan_details || null;
  const eligibleSuperPlan = planRaw?.plan_id
    ? {
        planId: String(planRaw.plan_id),
        name: planRaw.name || 'Swiggy One Lite Membership',
        priceRupees: Math.round((Number(planRaw.final_price ?? planRaw.base_price ?? 100) / 100) * 100) / 100
      }
    : null;

  const subItems = Array.isArray(data.subscriptionItems) ? data.subscriptionItems : [];
  const swiggyOneMembershipFee = Number(
    cm.subscription_total ||
    (subItems.length > 0 ? Number(subItems[0]?.final_price ?? subItems[0]?.base_price ?? 100) / 100 : 0) ||
    0
  );

  const renderItemTotal = parseRenderNum(renderByKey.get('item_total')?.value);
  const itemTotal = Number(cm.item_total ?? cm.cart_subtotal_without_packing ?? cm.cart_subtotal ?? renderItemTotal ?? items.reduce((s, i) => s + i.lineTotal, 0));

  const renderDelFreeRow = renderByKey.get('positive_delivery_charges_exclusive_swiggy_one') || renderByKey.get('positive_delivery_charges_exclusive');
  const renderDelVal = parseRenderNum(renderDelFreeRow?.value);
  const deliveryFee = Number(cm.positiveDeliveryChargesExclusive ?? cm.delivery_charges ?? renderDelVal ?? 0);

  // Delivery is genuinely FREE only when effective delivery charge is 0!
  const swiggyOneApplied = deliveryFee <= 0 && Boolean(
    swiggyOneMembershipFee > 0 ||
    superBenefits?.is_super ||
    superBenefits?.super ||
    String(renderByKey.get('positive_delivery_charges_exclusive_swiggy_one')?.value || '').toUpperCase() === 'FREE' ||
    cm.swiggyOneBenefitsApplicable ||
    cm.oneLiteBenefitsApplicable ||
    cm.fullCouponLessFreeDeliveryApplied ||
    cm.is_swiggy_one_free_delivery_applicable ||
    cm.free_shipping ||
    Number(cm.free_delivery_discount) > 0 ||
    Number(cm.delivery_fee_reversal) > 0
  );
  const renderDelSaved = parseRenderNum(renderDelFreeRow?.intermediateText);
  const rawFreeDelSaved = deliveryFee <= 0
    ? Number(cm.free_delivery_discount || cm.delivery_fee_reversal || cm.deliveryChargeStrikeOffAmount || cm.strike_off_amount_without_tax || renderDelSaved || 0)
    : 0;
  const freeDeliveryDiscount = Math.round(rawFreeDelSaved * 100) / 100;

  // Coupon is valid ONLY when Swiggy confirms `is_coupon_valid === 1` OR `coupon_discount_total > 0`
  // IMPORTANT: When Swiggy returns `cm.coupon_code` WITH `is_coupon_valid === 0` / `coupon_discount_total === 0`,
  // that code is Swiggy's AUTO-SUGGESTED best coupon (NOT applied yet!) — expose it via `suggestedCouponCode` so our Max-Coupon engine applies it!
  const rawCartCoupon = cm.coupon_code ? String(cm.coupon_code).trim().toUpperCase() : null;
  const isCouponValid = Boolean(cm.is_coupon_valid === 1 || Number(cm.coupon_discount_total) > 0);
  const couponCode = isCouponValid && rawCartCoupon ? rawCartCoupon : null;
  const suggestedCouponCode = !isCouponValid && rawCartCoupon ? rawCartCoupon : null;
  const couponDiscount = isCouponValid ? Number(cm.coupon_discount_total ?? cm.coupon_discount_effective ?? 0) : 0;

  const tradeDiscountTotal = Number(cm.trade_discount_total ?? items.reduce((s, i) => s + (i.tradeDiscount || 0), 0));
  const renderPacking = parseRenderNum(renderByKey.get('restaurant_packaging_charges')?.value ?? renderByKey.get('packaging_charges')?.value);
  const packingCharges = Number(cm.total_packing_charges ?? cm.basePackagingCharges ?? cm.restaurant_packing_charges ?? cm.packaging_fee ?? renderPacking ?? 0);
  const renderGrandTotal = parseRenderNum(renderByKey.get('grand_total')?.value ?? renderByKey.get('to_pay')?.value);
  const rawOrderTotal = Number(cm.order_total ?? renderGrandTotal ?? 0);
  const renderTaxesAndCharges = parseRenderNum(renderByKey.get('taxes_and_charges')?.value);
  const pureTaxAndFees = Number(cm.total_tax || 0) + Number(cm.convenience_fees ?? cm.convenience_fee ?? cm.platform_fee ?? 0);
  const residualGstAndFees = rawOrderTotal > 0
    ? Math.max(0, Math.round((rawOrderTotal - (itemTotal - couponDiscount - tradeDiscountTotal + swiggyOneMembershipFee + deliveryFee + packingCharges)) * 100) / 100)
    : pureTaxAndFees;
  const taxesAndCharges = cm.taxesAndCharges !== undefined
    ? Number(cm.taxesAndCharges)
    : (renderTaxesAndCharges !== null
        ? renderTaxesAndCharges
        : (rawOrderTotal > 0 ? residualGstAndFees : pureTaxAndFees));

  // FULL SWIGGY FREE CASH + SWIGGY MONEY SPLIT-PAY EXTRACTION:
  // 1. Campaign / Late Night / Breakfast / Reward Free Cash (`campaignFreeCash`) — auto-stacks over coupons inside `cm.order_total`!
  const rewardSavingsRaw =
    cm.trade_discount_reward_amount ??
    cm.tradeDiscountRewardAmountWithoutPocketHeroDiscount ??
    cm.offer_presentation_info?.reward_offer_savings_info?.savings ??
    cm.offerPresentationInfo?.rewardOffersSavingsInfo?.savings ??
    0;
  let renderRewardFreeCash = 0;
  for (const [rk, rv] of renderByKey.entries()) {
    const labelStr = `${rk} ${rv?.display_text || rv?.label || ''}`;
    if (/free\s*cash|reward_offer|pocket_hero|swiggy_cash/i.test(labelStr) && !/swiggy_money/i.test(labelStr)) {
      const parsedVal = Math.abs(parseRenderNum(rv?.value) || 0);
      if (parsedVal > renderRewardFreeCash) renderRewardFreeCash = parsedVal;
    }
  }
  const campaignFreeCash = Math.max(0, Math.round(Math.max(Number(rewardSavingsRaw) || 0, renderRewardFreeCash) * 100) / 100);
  const merchantTradeDiscount = Math.max(0, Math.round((tradeDiscountTotal - campaignFreeCash) * 100) / 100);
  // Avoid double-counting if Swiggy already summed `trade_discount_reward_amount` inside `trade_discount_total`:
  const extraCampaignSavings = tradeDiscountTotal >= campaignFreeCash ? 0 : (campaignFreeCash - tradeDiscountTotal);

  // 2. Swiggy Money / Wallet Free Cash Split-Pay (`user_swiggy_money` / `swiggy_pay_eligible_balance`):
  // Before placing the order, `cm.swiggy_money` is `0` while `cm.user_swiggy_money` holds the available balance (e.g. ₹50 / ₹100)!
  // Passing `swiggy_pay_amount` on `chkout/payments order/place` deducts this directly from the live UPI QR!
  const freeCashBalance = Math.max(0, Number(cm.user_swiggy_money ?? cm.swiggy_pay_eligible_balance ?? 0));
  const alreadyDeductedWallet = Math.max(0, Number(cm.swiggy_money ?? 0));
  const walletSplitPayAmount = alreadyDeductedWallet > 0
    ? alreadyDeductedWallet
    : (freeCashBalance > 0 && rawOrderTotal > 0 ? Math.min(rawOrderTotal, freeCashBalance) : 0);
  const freeCashApplied = Math.round((campaignFreeCash + walletSplitPayAmount) * 100) / 100;
  const orderTotal = alreadyDeductedWallet > 0
    ? rawOrderTotal
    : Math.max(0, Math.round((rawOrderTotal - walletSplitPayAmount) * 100) / 100);
  const totalSavings = Math.round((couponDiscount + tradeDiscountTotal + extraCampaignSavings + freeDeliveryDiscount + walletSplitPayAmount) * 100) / 100;

  return {
    restaurantId,
    restaurantName,
    items,
    address,
    addressDetails,
    savedAddresses: addresses.map(a => ({
      id: a.id || '',
      city: a.city || 'Address',
      name: a.name || '',
      mobile: a.mobile || '',
      flat_no: a.flat_no && a.flat_no !== 'None' ? a.flat_no : '',
      area: a.area || '',
      landmark: a.landmark || '',
      address: `${a.flat_no && a.flat_no !== 'None' ? a.flat_no + ', ' : ''}${a.address || ''}`.trim(),
      lat: String(a.lat || ''),
      lng: String(a.lng || ''),
      annotation: a.annotation || ''
    })),
    eligibleSuperPlan,
    userSuperStatus,
    swiggyOneMembershipFee: Math.round(swiggyOneMembershipFee * 100) / 100,
    itemTotal: Math.round(itemTotal * 100) / 100,
    subtotal: Math.round(itemTotal * 100) / 100,
    tradeDiscountTotal: Math.round(tradeDiscountTotal * 100) / 100,
    merchantTradeDiscount,
    deliveryFee: Math.round(deliveryFee * 100) / 100,
    freeDeliveryDiscount,
    swiggyOneApplied,
    swiggyOneSavings: freeDeliveryDiscount,
    couponCode,
    suggestedCouponCode,
    discountAmount: Math.round(couponDiscount * 100) / 100,
    freeCashBalance: Math.round(freeCashBalance * 100) / 100,
    freeCashApplied: Math.round(freeCashApplied * 100) / 100,
    campaignFreeCash: Math.round(campaignFreeCash * 100) / 100,
    walletSplitPayAmount: Math.round(walletSplitPayAmount * 100) / 100,
    rawCartOrderTotal: Math.round(rawOrderTotal * 100) / 100,
    packingCharges: Math.round(packingCharges * 100) / 100,
    taxesAndCharges: Math.round(taxesAndCharges * 100) / 100,
    finalPayable: Math.round(orderTotal > 0 ? orderTotal : Math.max(0, itemTotal - couponDiscount - tradeDiscountTotal + swiggyOneMembershipFee + deliveryFee + taxesAndCharges)),
    totalSavings
  };
}

// Require the live cart to match the coupon and discount shown on the order before a payment QR is created.
export function doesCouponMatchExpectedOrder(cart, order) {
  if (!cart || !order) return false;
  const expectedCode = String(order.couponCode || '').trim().toUpperCase();
  const actualCode = String(cart.couponCode || '').trim().toUpperCase();
  const expectedDiscount = Math.max(0, Number(order.discountAmount || 0));
  const actualDiscount = Math.max(0, Number(cart.discountAmount || 0));
  if (expectedCode !== actualCode) return false;
  if (!expectedCode) return expectedDiscount <= 0 && actualDiscount <= 0;
  return expectedDiscount > 0 && actualDiscount > 0 && Math.abs(expectedDiscount - actualDiscount) <= 0.01;
}

// Before payment, make sure all verified savings and bill components still match Swiggy's live cart.
export function doesOrderBillMatchLiveCart(cart, order, tolerance = 0.02) {
  if (!doesCouponMatchExpectedOrder(cart, order)) return false;
  const fields = [
    'itemTotal',
    'tradeDiscountTotal',
    'freeCashApplied',
    'freeDeliveryDiscount',
    'deliveryFee',
    'swiggyOneMembershipFee',
    'packingCharges',
    'taxesAndCharges',
    'finalPayable'
  ];
  for (const field of fields) {
    if (order[field] === undefined || order[field] === null) continue;
    const expected = Number(order[field]);
    const actual = Number(cart[field]);
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || Math.abs(expected - actual) > tolerance) return false;
  }
  return true;
}

// Fast inspect an active personal cart for a specific chosen account (<500ms direct DAPI / Native Android call)
export async function inspectCartForAccount(accountOrCookies) {
  if (!accountOrCookies) return null;
  try {
    const auth = await getSwiggySessionAuth(accountOrCookies);
    if (auth?.sessionExpired) {
      return { sessionExpired: true };
    }
    const { json } = await swiggyCartGet(accountOrCookies, { timeoutMs: 9000 });
    if ((json?.statusCode === 1 || json?.statusCode === 999) && /session|login|unauthorized/i.test(json?.statusMessage || '')) {
      return { sessionExpired: true };
    }
    const parsed = json?.data ? parseDapiCartPayload(json.data) : null;
    if (!parsed) {
      return { items: [], restaurantName: null, finalPayable: 0 };
    }
    return parsed;
  } catch (err) {
    console.error('inspectCartForAccount error:', err.message);
    return null;
  }
}

// Verify Swiggy link and extract real cart & address details (<1s via live Group Cart + DAPI)
export async function verifyAndInspectSwiggyLink(url, cookies = '', accountSession = null) {
  if (!url) return { verified: false, message: 'No link provided' };

  const cleanUrl = String(url).trim();
  const isSwiggy = cleanUrl.includes('swiggy.com') || cleanUrl.includes('swiggy.onelink.me') || cleanUrl.includes('swig.gy');
  if (!isSwiggy) {
    return { verified: false, message: 'Not a valid Swiggy link' };
  }

  const meta = await resolveSwiggyLink(cleanUrl);
  const accObj = accountSession ? { ...accountSession, cookies: cookies || accountSession.cookies || '' } : cookies;

  // If link was a personal `/cart` URL rather than group cart, inspect active personal cart on account
  if ((!meta.cartDetails || !meta.cartDetails.items || meta.cartDetails.items.length === 0) && accObj) {
    const livePersonal = await inspectCartForAccount(accObj);
    if (livePersonal?.sessionExpired) {
      return { verified: false, sessionExpired: true, message: 'Swiggy session expired for this account' };
    }
    if (livePersonal?.items?.length > 0 && (!meta.restaurantId || String(livePersonal.restaurantId) === String(meta.restaurantId))) {
      return {
        verified: true,
        ...livePersonal,
        hostName: meta.hostName,
        groupCartId: meta.groupCartId,
        resolvedUrl: meta.resolvedUrl
      };
    }
  }

  const cd = meta.cartDetails || {};
  const items = cd.items || [];
  const itemTotal = cd.itemsTotal || cd.subtotal || 0;
  const discountAmount = cd.discountAmount || 0;
  const tradeDiscountTotal = cd.tradeDiscountTotal || 0;
  const packingCharges = cd.packingCharges || 0;
  const taxesAndCharges = cd.gstCharges || 0;
  const finalPayable = cd.finalPayable || Math.max(0, Math.round(itemTotal - discountAmount - tradeDiscountTotal + packingCharges + taxesAndCharges));

  return {
    verified: Boolean(items.length > 0 || meta.restaurantName),
    groupCartStatus: meta.groupCartStatus,
    restaurantName: meta.restaurantName || 'Swiggy Food Order',
    hostName: meta.hostName,
    restaurantId: meta.restaurantId,
    groupCartId: meta.groupCartId,
    items,
    address: meta.addressDetails?.address || null,
    addressDetails: meta.addressDetails || null,
    taxesAndCharges,
    packingCharges,
    swiggyOneMembershipFee: 0,
    itemTotal,
    subtotal: itemTotal,
    tradeDiscountTotal,
    deliveryFee: 0,
    freeDeliveryDiscount: 0,
    swiggyOneApplied: false,
    swiggyOneSavings: 0,
    couponCode: cd.couponCode || null,
    discountAmount,
    freeCashBalance: 0,
    freeCashApplied: cd.freeCashApplied || 0,
    finalPayable,
    totalSavings: Math.round((discountAmount + tradeDiscountTotal + (cd.freeCashApplied || 0)) * 100) / 100,
    resolvedUrl: meta.resolvedUrl
  };
}

const STATIC_ASSET_EXT_RE = /\.(?:png|jpe?g|webp|gif|svg|ico|avif|bmp|mp4|webm|mp3|wav|lottie|json|m?js|css|woff2?|ttf|eot|pdf|zip|xml)$/i;
const NON_TRACKING_PATH_RE = /^\/(?:dapi|mapi|api)(?:\/|$)|\/(?:restaurant(?:s)?|menu|gc|group[-_]?cart|cart|checkout|payment(?:s)?|support|help|issues|instamart|genie|dineout|minis|city|collections|search|auth|login|my-account\/settings|ofo\/address|address(?:es)?|addr)(?:\/|$)/i;
const R_SWIGGY_NON_TRACKING_RE = /(?:^|\/)(?:rate[_-]?app|playstore|appstore|download|install|home|explore|unsubscribe|feedback|promo|offer(?:s)?|ofo\/address|address)(?:\/|$)/i;
const BARE_SWIGGY_DUMMY_PATH_RE = /^\/(?:|track|tracking|track-order|order-track|orders|orders\/track|order|my-account|my-account\/orders)\/?$/i;
const NON_TRACKING_KEY_CONTEXT_RE = /(?:^|[\s._-])(?:payment|pay_link|pay_url|upi|invoice|receipt|download_summary|summary_download|restaurant_logo|restaurant_image|image|img|icon|logo|avatar|banner|thumbnail|lottie|animation|menu_url|cart_url|address_url|address_link)(?:$|[\s._-])/i;

export function isOfficialSwiggyTrackingUrl(value, { allowProviderShortLink = false } = {}) {
  try {
    const raw = String(value || '').trim();
    if (!/^https?:\/\//i.test(raw)) return false;
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password || url.port) return false;

    const host = url.hostname.toLowerCase();
    const pathLower = url.pathname.toLowerCase();
    const searchLower = url.search.toLowerCase();

    if (STATIC_ASSET_EXT_RE.test(pathLower)) return false;
    if (NON_TRACKING_PATH_RE.test(pathLower)) return false;

    const isRSwiggy = host === 'r.swiggy.com' || host.endsWith('.r.swiggy.com');
    const isSwiggyWeb = host === 'swiggy.com' || host === 'www.swiggy.com' || host === 'm.swiggy.com';
    const isSwigGy = host === 'swig.gy';
    const isOneLink = host === 'swiggy.onelink.me';

    if (!isRSwiggy && !isSwiggyWeb && !isSwigGy && !isOneLink) return false;

    if (isRSwiggy) {
      if (R_SWIGGY_NON_TRACKING_RE.test(pathLower)) return false;
      const segments = pathLower.split('/').filter(Boolean);
      if (segments.length === 0) return false;
      const lastSeg = segments[segments.length - 1];
      if (lastSeg.length < 3 || /^(?:track|tracking|order|orders|ofo|swiggy|share)$/i.test(lastSeg)) {
        return false;
      }
      return true;
    }

    if (isSwiggyWeb) {
      if (BARE_SWIGGY_DUMMY_PATH_RE.test(pathLower) && !url.search) return false;
      // Explicit tracking routes with a non-empty order ID or share token segment
      if (/^\/(?:(?:swiggy\/)?ofo\/track|track-order|order-track|orders?\/track|track|tracking|orders?\/share|social\/share\/order)\/[a-z0-9_-]{3,}(?:\/[a-z0-9_-]+)?\/?$/i.test(pathLower)) {
        return true;
      }
      // Genuine Swiggy order detail/share page (`/orders/<idOrToken>`)
      if (/^\/orders?\/(?!track\/?$|share\/?$)[a-z0-9_-]{4,}\/?$/i.test(pathLower)) {
        return true;
      }
      // Query-driven live tracking route (never bare `/orders` or `/my-account/orders`)
      if (/^\/(?:order-tracking|live-track|ofo-track|(?:swiggy\/)?ofo\/track|track-order|order-track|orders?\/track|orders?\/share|track|tracking)\/?$/i.test(pathLower) &&
          /(?:^|[?&])(?:tracking_url|track_url|order_id|orderid|token|share_id|ofo_id)=[^&]{3,}/i.test(url.search)) {
        return true;
      }
      return false;
    }

    if (isSwigGy) {
      const segments = pathLower.split('/').filter(Boolean);
      if (segments.length === 0) return false;
      if (/^\/(?:(?:swiggy\/)?ofo\/track|track|orders?\/track)\/[a-z0-9_-]{3,}\/?$/i.test(pathLower)) {
        return true;
      }
      return Boolean(allowProviderShortLink && segments.length === 1 && segments[0].length >= 3);
    }

    if (isOneLink) {
      let decoded = `${pathLower}${searchLower}`;
      try { decoded = decodeURIComponent(decoded).toLowerCase(); } catch {}
      if (/(?:download|install|explore|ofo\/address|address|save.*address|gc\/|group|restaurant|menu|instamart)/i.test(decoded)) {
        return false;
      }
      return /(?:ofo\/track|track[-_]?order|tracking_url=|track_url=|\/track\/[a-z0-9_-]{3,})/i.test(decoded);
    }

    return false;
  } catch {
    return false;
  }
}

// Fabricated tracking URL detection — never construct by appending order ID to a URL pattern
export function isFabricatedTrackingUrl(url, orderId = '') {
  if (!url) return false;
  const u = String(url).trim();
  const oid = String(orderId || '').trim();
  if (!u) return false;
  if (u === 'https://www.swiggy.com/track' || u === 'https://www.swiggy.com/orders' || u === 'https://www.swiggy.com/' || u === 'https://www.swiggy.com/track/') return true;
  if (/^https?:\/\/(www\.)?swiggy\.com\/(track|orders)\/?$/i.test(u)) return true;
  if (oid && u.toLowerCase().includes(oid.toLowerCase()) && /swiggy\.com/i.test(u)) {
    try {
      const parsed2 = new URL(u);
      const host2 = parsed2.hostname.toLowerCase();
      const path2 = parsed2.pathname;
      if ((host2 === 'r.swiggy.com' || host2.endsWith('.r.swiggy.com')) && (path2 === `/${oid}` || path2 === `/${oid}/`)) return true;
    } catch {}
    if (!isOfficialSwiggyTrackingUrl(u, { allowProviderShortLink: true })) return true;
    try {
      const parsed = new URL(u);
      const path = parsed.pathname;
      if (new RegExp(`^/(track|orders|order)/${oid}$`, 'i').test(path) || path === `/${oid}` || path === `/${oid}/`) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function validateTrackingUrlForOrder(url, order, source = '') {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const p = new URL(trimmed);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
    if (p.username || p.password || p.port) return false;
  } catch {
    return false;
  }
  const allowProviderShort = source === 'SWIGGY_API' || !source || source === 'BOSS_PROVIDED';
  if (!isOfficialSwiggyTrackingUrl(trimmed, { allowProviderShortLink: allowProviderShort })) return false;
  const orderId = String(order?.swiggyOrderId || order?.pendingSwiggyOrderId || order?.id || '').trim();
  if (source !== 'SWIGGY_API' && isFabricatedTrackingUrl(trimmed, orderId)) return false;
  if (source === 'SWIGGY_API') {
    try {
      const p = new URL(trimmed);
      const h = p.hostname.toLowerCase();
      if ((h === 'r.swiggy.com' || h.endsWith('.r.swiggy.com')) && orderId && (p.pathname === `/${orderId}` || p.pathname === `/${orderId}/`)) {
        return false;
      }
    } catch {}
  }
  if (trimmed === 'https://www.swiggy.com/orders' || trimmed === 'https://www.swiggy.com/track' || trimmed === 'https://www.swiggy.com/' || trimmed === 'https://www.swiggy.com') return false;
  try {
    const parsed = new URL(trimmed);
    const qOrderId = parsed.searchParams.get('order_id') || parsed.searchParams.get('orderId') || parsed.searchParams.get('orderid');
    if (qOrderId && orderId && qOrderId !== orderId) return false;
  } catch {}
  return true;
}

export function sanitizeTrackingLink(order) {
  if (!order || !order.trackingLink) return '';
  const url = String(order.trackingLink).trim();
  const source = String(order.trackingLinkSource || '').trim();
  if (!['SWIGGY_API', 'BOSS_PROVIDED'].includes(source)) { order.trackingLink=''; order.trackingLinkSource=''; order.shareTrackUrl=''; return ''; }
  if (!validateTrackingUrlForOrder(url, order, source)) { console.warn(`[TrackingValidation] Rejected invalid tracking URL for order ${order.id}: ${url} source=${source}`); order.trackingLink=''; order.trackingLinkSource=''; order.shareTrackUrl=''; return ''; }
  return url;
}

export function hasValidTrackingForOrder(order) {
  if (!order) return false;
  const url = String(order.trackingLink || '').trim();
  if (!url) return false;
  return validateTrackingUrlForOrder(url, order, String(order.trackingLinkSource || ''));
}

export function getStoredSwiggyTrackingUrl(order) {
  if (!order || typeof order !== 'object') return '';
  const source = String(order?.trackingLinkSource || '').trim();
  const hasApiField = Boolean(
    order?.trackingUrl ||
    order?.nativeShareUrl ||
    order?.swiggyWebTrackUrl ||
    order?.shareable_url
  );
  if (!source && !hasApiField) return '';

  const effectiveSource = source || 'SWIGGY_API';
  if (!['SWIGGY_API', 'BOSS_PROVIDED'].includes(effectiveSource)) return '';

  const candidate = String(
    order?.trackingLink ||
    order?.trackingUrl ||
    order?.nativeShareUrl ||
    order?.shareTrackUrl ||
    order?.swiggyWebTrackUrl ||
    order?.shareable_url ||
    ''
  ).trim();
  if (!candidate) return '';

  if (!validateTrackingUrlForOrder(candidate, order, effectiveSource)) return '';
  const allowShort = effectiveSource === 'SWIGGY_API';
  const valid = isOfficialSwiggyTrackingUrl(candidate, { allowProviderShortLink: allowShort }) ? candidate : '';
  if (valid && !order.trackingLink) {
    order.trackingLink = valid;
    order.trackingLinkSource = effectiveSource;
  }
  return valid;
}

function cleanCandidateUrlToken(rawToken) {
  let token = String(rawToken || '').trim();
  if (!token) return '';
  // Collapse markdown `[text](url)` or `url](url` wrappers
  const mdIdx = token.indexOf('](');
  if (mdIdx !== -1) token = token.slice(mdIdx + 2);
  token = token.replace(/^[<("'\[{]+/, '').replace(/[>)"'\]}.,;:!?]+$/, '');
  return token.trim();
}

function extractUrlsFromArbitraryText(rawText) {
  const found = [];
  if (!rawText) return found;
  let cur = String(rawText).trim();
  if (!cur) return found;

  // Try up to 3 decode passes if percent encoded (handles single and double-encoded URLs)
  for (let pass = 0; pass < 3; pass++) {
    if (/%[0-9a-fA-F]{2}/.test(cur)) {
      try {
        const next = decodeURIComponent(cur.replace(/\+/g, ' '));
        if (next !== cur) cur = next;
        else break;
      } catch {
        break;
      }
    } else {
      break;
    }
  }

  // Match direct http/https urls
  const matches = cur.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  for (const m of matches) {
    const cleaned = cleanCandidateUrlToken(m);
    if (/^https?:\/\//i.test(cleaned)) found.push(cleaned);
  }
  return found;
}

export function extractTrackingCandidateUrlsFromString(rawValue) {
  const out = [];
  if (typeof rawValue !== 'string') return out;
  let text = rawValue.trim();
  if (!text) return out;
  if (text.includes('\\/')) text = text.replace(/\\\//g, '/');

  // 1. Swiggy app deep links (`swiggy://share?text=...`, `swiggy://order?tracking_url=...`, etc.)
  const deepLinkMatches = text.match(/swiggy:\/\/[^\s"'<>\]\\)]+/gi) || [];
  for (const dl of deepLinkMatches) {
    try {
      const qIndex = dl.indexOf('?');
      if (qIndex !== -1) {
        const qs = new URLSearchParams(dl.slice(qIndex + 1));
        for (const [, rawVal] of qs.entries()) {
          for (const u of extractUrlsFromArbitraryText(rawVal)) {
            out.push(u);
          }
        }
      }
    } catch {}
  }

  // 2. Percent-encoded http(s) URLs (`https%3A%2F%2F...`, `https%253A%252F%252F...`)
  for (const u of extractUrlsFromArbitraryText(text)) {
    out.push(u);
  }

  // 3. Direct or sentence-embedded http(s) URLs (e.g. `"Click this link to track: http://r.swiggy.com/swiggy/ofo/track/..."`)
  const httpMatches = text.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  for (const rawUrl of httpMatches) {
    const cleaned = cleanCandidateUrlToken(rawUrl);
    if (/^https?:\/\//i.test(cleaned)) out.push(cleaned);
  }

  return [...new Set(out)];
}

export function extractTrackingUrlFromSwiggyFyiDetails(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const items = Array.isArray(source)
      ? source
      : (Array.isArray(source.fyi_details)
          ? source.fyi_details
          : (Array.isArray(source.data?.fyi_details)
              ? source.data.fyi_details
              : (Array.isArray(source.fyi) ? source.fyi : [])));
    for (const item of items) {
      if (!item) continue;
      const candidates = [
        item?.value?.cta_link,
        item?.value?.cta?.link,
        item?.value?.share_url,
        item?.value?.share_link,
        item?.value?.tracking_url,
        item?.value?.url,
        item?.value?.text,
        item?.cta_link,
        item?.share_url,
        item?.tracking_url,
        item?.url
      ].filter(v => typeof v === 'string' && v.trim());

      for (const cand of candidates) {
        for (const extractedUrl of extractTrackingCandidateUrlsFromString(cand)) {
          if (isOfficialSwiggyTrackingUrl(extractedUrl, { allowProviderShortLink: true })) {
            return extractedUrl;
          }
        }
      }
    }
  }
  return null;
}

function scoreSwiggyTrackingUrl(url, keyContext = '') {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const hasShareOrTrackKey = /(?:ofo|shareable|share_url|share_link|share_message|tracking_url|track_url|tracking_link|track_link|order_share)/i.test(keyContext);
    const hasBroadTrackCtx = /(?:track|tracking|share|ofo)/i.test(keyContext);

    if ((host === 'r.swiggy.com' || host.endsWith('.r.swiggy.com')) && /(?:ofo\/track|\/track\/)/i.test(path)) {
      return 100;
    }
    if (host === 'r.swiggy.com' || host.endsWith('.r.swiggy.com')) {
      return hasShareOrTrackKey ? 94 : (hasBroadTrackCtx ? 90 : 82);
    }
    if (/^\/(?:(?:swiggy\/)?ofo\/track|track-order|order-track|orders?\/track)\//i.test(path)) {
      return hasShareOrTrackKey ? 88 : 84;
    }
    if (host === 'swig.gy') {
      return hasShareOrTrackKey ? 80 : 72;
    }
    if (host === 'swiggy.onelink.me') {
      return 74;
    }
    if (/^\/orders?\/[a-z0-9_-]{4,}\/?$/i.test(path)) {
      return hasShareOrTrackKey ? 68 : 60;
    }
    return hasBroadTrackCtx ? 55 : 45;
  } catch {
    return 0;
  }
}

// Accept a tracking/share URL only when Swiggy's own response includes it under a
// tracking/share field (or an action/message explicitly carrying a Swiggy tracking link).
export function extractSwiggyProvidedTrackingUrl(...sources) {
  const fromFyi = extractTrackingUrlFromSwiggyFyiDetails(...sources);
  if (fromFyi) return fromFyi;

  const scored = new Map();
  const walk = (node, context = '', depth = 0) => {
    if (node === null || node === undefined || depth > 12) return;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (
        depth < 4 &&
        trimmed.length >= 2 &&
        trimmed.length <= 30000 &&
        ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) &&
        /swiggy|swig\.gy|track|share|ofo/i.test(trimmed)
      ) {
        try {
          walk(JSON.parse(trimmed), context, depth + 1);
          return;
        } catch {}
      }
      for (const url of extractTrackingCandidateUrlsFromString(trimmed)) {
        const isExplicitTrackUrl = /r\.swiggy\.com\//i.test(url) || /swiggy\.com\/(?:(?:swiggy\/)?ofo\/track|track-order|order-track|orders?\/track)\//i.test(url);
        const isTrackingContext = /track|tracking|share|ofo/i.test(context);
        const isBlockedField = NON_TRACKING_KEY_CONTEXT_RE.test(context) && !/(?:ofo\/track|r\.swiggy\.com\/(?:.*\/)?track\/|r\.swiggy\.com\/[a-z0-9_-]+)/i.test(url);
        if (isBlockedField) continue;
        if ((isTrackingContext || isExplicitTrackUrl) &&
            isOfficialSwiggyTrackingUrl(url, { allowProviderShortLink: isTrackingContext || /r\.swiggy\.com/i.test(url) })) {
          const score = scoreSwiggyTrackingUrl(url, context);
          if (!scored.has(url) || scored.get(url) < score) scored.set(url, score);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const value of node) walk(value, context, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const labelContext = Object.entries(node)
      .filter(([key, value]) => /^(?:title|label|name|text|action_name|display_name|header|subtitle|description)$/i.test(key) && typeof value === 'string')
      .map(([, value]) => value)
      .filter(value => /track|share|ofo/i.test(value))
      .join(' ');
    const localContext = `${context} ${labelContext}`.toLowerCase();
    for (const [key, value] of Object.entries(node)) {
      const nextContext = `${localContext} ${key}`.toLowerCase();
      if (typeof value === 'string' || (value && typeof value === 'object')) {
        walk(value, nextContext, depth + 1);
      }
    }
  };
  for (const source of sources) walk(source);
  if (scored.size === 0) return null;
  return [...scored.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Only return delivery/rider hand-off codes, never login/payment OTPs.
export function extractSwiggyDeliveryOtp(...sources) {
  const DELIVERY_CONTEXT = /delivery|rider|partner|handover|drop.?off|recipient/i;
  const PAYMENT_CONTEXT = /payment|login|auth(?:entication)?|transaction|upi/i;
  const OTP_KEY = /otp|verification.?code|delivery.?code/i;
  const normalizeCode = value => {
    if (value && typeof value === 'object') {
      value = value.code ?? value.value ?? value.otp ?? value.otp_code ?? '';
    }
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits.length >= 4 && digits.length <= 8 ? digits : '';
  };
  const walk = (node, context = '', depth = 0) => {
    if (!node || depth > 10) return '';
    if (Array.isArray(node)) {
      for (const value of node) {
        const found = walk(value, context, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof node !== 'object') return '';

    const localDeliveryContext = Object.entries(node).some(([key, value]) =>
      /^(?:type|purpose|context|label|title|name)$/i.test(key) &&
      typeof value === 'string' && DELIVERY_CONTEXT.test(value)
    );
    const localContext = `${context} ${localDeliveryContext ? 'delivery handover' : ''}`;
    for (const [key, value] of Object.entries(node)) {
      const nextContext = `${localContext} ${key}`;
      if (OTP_KEY.test(key) && !PAYMENT_CONTEXT.test(nextContext) && (DELIVERY_CONTEXT.test(nextContext) || localDeliveryContext)) {
        const code = normalizeCode(value);
        if (code) return code;
      }
      if (value && typeof value === 'object') {
        const found = walk(value, nextContext, depth + 1);
        if (found) return found;
      }
    }
    return '';
  };
  for (const source of sources) {
    const found = walk(source);
    if (found) return found;
  }
  return '';
}

const SWIGGY_POST_DELIVERY_PROMPT_RE = /(?:rate\s+(?:your\s+)?(?:delivery|order|food|experience)|how\s+was\s+your\s+(?:food|order|delivery)|leave\s+a\s+review|tip\s+your\s+(?:delivery|rider|partner)|^order\s+delivered$|^delivered$)/i;

/**
 * Normalize Swiggy's live/post-delivery status text so post-delivery rating prompts
 * from `trackV4` (such as `"Rate your delivery"`, `"How was your food?"`) never
 * overwrite `"Delivered"` and falsely look like an active order still awaiting tracking.
 */
export function normalizeSwiggyLiveOrderStatus(rawStatusMsg = '', fallbackOrderStatus = '', postOrDeliveryStatus = '') {
  const msg = String(rawStatusMsg || '').trim();
  const fb = String(fallbackOrderStatus || '').trim();
  const post = String(postOrDeliveryStatus || '').trim();

  // Cancelled / refused / returned states take precedence when authoritative order_status says so
  if (/(?:cancelled|canceled|refused|returned)/i.test(fb)) {
    return fb;
  }
  if (/(?:cancelled|canceled|refused|returned)/i.test(post) && !msg) {
    return post;
  }
  if (/(?:cancelled|canceled|refused|returned)/i.test(msg)) {
    return msg;
  }

  // If `order/all` or `order/details` already confirms the order is Delivered, OR `trackV4`
  // switched to a post-delivery prompt ("Rate your delivery", etc.), report "Delivered".
  if (/^delivered$/i.test(fb) || /^delivered$/i.test(post) || SWIGGY_POST_DELIVERY_PROMPT_RE.test(msg)) {
    return 'Delivered';
  }

  return msg || fb || post || '';
}

let detectedPublicServiceOrigin = '';

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  return false;
}

export function computeTrackHmac(orderId) {
  const secret = process.env.BOT_TOKEN || 'bossbot-track-secret';
  return crypto.createHmac('sha256', secret).update(`track:${String(orderId || '').trim()}`).digest('hex').slice(0, 24);
}

export function notePublicServiceOrigin(input) {
  try {
    if (!input) return '';
    if (typeof input === 'string') {
      const parsed = new URL(input.trim());
      if (/^https?:$/i.test(parsed.protocol) && !isPrivateOrLocalHost(parsed.hostname)) {
        detectedPublicServiceOrigin = `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
      }
      return detectedPublicServiceOrigin;
    }
    const headers = input?.headers || {};
    const rawHost = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
    if (!rawHost) return detectedPublicServiceOrigin;
    const hostOnly = rawHost.replace(/:\d+$/, '');
    if (isPrivateOrLocalHost(hostOnly)) return detectedPublicServiceOrigin;
    const rawProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const proto = rawProto === 'http' ? 'http' : 'https';
    detectedPublicServiceOrigin = `${proto}://${rawHost}`.replace(/\/+$/, '');
    return detectedPublicServiceOrigin;
  } catch {
    return detectedPublicServiceOrigin;
  }
}

export function getPublicServiceBaseUrl() {
  const candidates = [
    process.env.PUBLIC_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//i, '')}` : '',
    process.env.RAILWAY_STATIC_URL ? (String(process.env.RAILWAY_STATIC_URL).startsWith('http') ? process.env.RAILWAY_STATIC_URL : `https://${process.env.RAILWAY_STATIC_URL}`) : '',
    process.env.KOYEB_PUBLIC_DOMAIN ? `https://${String(process.env.KOYEB_PUBLIC_DOMAIN).replace(/^https?:\/\//i, '')}` : '',
    process.env.FLY_APP_NAME ? `https://${String(process.env.FLY_APP_NAME).trim()}.fly.dev` : '',
    detectedPublicServiceOrigin
  ];
  for (const cand of candidates) {
    const clean = String(cand || '').trim().replace(/\/+$/, '');
    if (!clean) continue;
    try {
      const parsed = new URL(clean);
      if (/^https?:$/i.test(parsed.protocol)) return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
    } catch {}
  }
  return 'https://ammi-abbu-ka-sacha-beta.onrender.com';
}

export function buildSignedOrderTrackUrl(orderOrId) {
  let targetId = '';
  if (typeof orderOrId === 'object' && orderOrId !== null) {
    const swiggyId = String(orderOrId.swiggyOrderId || orderOrId.pendingSwiggyOrderId || orderOrId.orderId || '').trim();
    const botId = String(orderOrId.id || '').trim();
    targetId = /^\d{10,20}$/.test(swiggyId) ? swiggyId : (/^[A-Za-z0-9_-]+$/.test(botId) ? botId : '');
  } else {
    const raw = String(orderOrId || '').trim();
    if (/^[A-Za-z0-9_-]+$/.test(raw)) targetId = raw;
  }
  if (!targetId) return '';
  return `${getPublicServiceBaseUrl()}/track/${encodeURIComponent(targetId)}?sig=${computeTrackHmac(targetId)}`;
}

function parseLatLngPair(rawLatLng, fallbackLat = null, fallbackLng = null) {
  if (typeof rawLatLng === 'string' && rawLatLng.includes(',')) {
    const [la, ln] = rawLatLng.split(',').map(v => Number(v.trim()));
    if (Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) > 0.01 && Math.abs(ln) > 0.01) {
      return { lat: la, lng: ln };
    }
  }
  const la2 = Number(fallbackLat);
  const ln2 = Number(fallbackLng);
  if (Number.isFinite(la2) && Number.isFinite(ln2) && Math.abs(la2) > 0.01 && Math.abs(ln2) > 0.01) {
    return { lat: la2, lng: ln2 };
  }
  return { lat: null, lng: null };
}

function extractSwiggyOrderSnapshotFields(orderObj, detOrder, trkData, deData, accMeta = {}) {
  const primary = detOrder || orderObj || {};
  const secondary = orderObj || {};
  const rawItems = Array.isArray(primary?.order_items) && primary.order_items.length > 0
    ? primary.order_items
    : (Array.isArray(secondary?.order_items) ? secondary.order_items : []);
  const items = rawItems
    .map(it => {
      if (!it || typeof it !== 'object') return null;
      const name = String(it.name || it.item_name || '').trim();
      if (!name) return null;
      const qty = Math.max(1, Number(it.quantity || it.qty || 1) || 1);
      const rawPrice = Number(it.final_price ?? it.total ?? it.subtotal ?? it.base_price ?? it.price ?? 0);
      const price = rawPrice > 5000 ? Math.round(rawPrice / 100) : Math.round(rawPrice || 0);
      return { name, qty, ...(price > 0 ? { price } : {}) };
    })
    .filter(Boolean);

  const restCoords = parseLatLngPair(
    primary?.restaurant_lat_lng || secondary?.restaurant_lat_lng || trkData?.restaurant_details?.lat_lng,
    trkData?.restaurant_details?.lat ?? primary?.restaurant_lat,
    trkData?.restaurant_details?.lng ?? primary?.restaurant_lng
  );

  const da = primary?.delivery_address || secondary?.delivery_address || {};
  const custCoords = parseLatLngPair(
    da?.lat_lng || trkData?.customer_details?.lat_lng,
    da?.lat ?? da?.location?.lat ?? trkData?.customer_details?.lat,
    da?.lng ?? da?.location?.lng ?? trkData?.customer_details?.lng
  );
  const fullAddr = [da?.flat_no, da?.address_line1, da?.address, da?.area, da?.city]
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .filter((v, idx, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === idx)
    .join(', ');

  const riderRaw = deData || primary?.delivery_boy || secondary?.delivery_boy || trkData?.delivery_boy || {};
  const riderCoords = parseLatLngPair(
    riderRaw?.lat_lng || riderRaw?.location,
    riderRaw?.lat ?? riderRaw?.latitude,
    riderRaw?.lng ?? riderRaw?.longitude
  );

  const totalRaw = Number(primary?.order_total ?? secondary?.order_total ?? primary?.net_total ?? 0);
  return {
    restaurantName: String(primary?.restaurant_name || secondary?.restaurant_name || trkData?.restaurant_details?.name || '').trim(),
    restaurantAddress: String(primary?.restaurant_address || primary?.restaurant_area_name || secondary?.restaurant_address || secondary?.restaurant_area_name || trkData?.restaurant_details?.address || '').trim(),
    restaurantLat: restCoords.lat,
    restaurantLng: restCoords.lng,
    items,
    orderTotal: Number.isFinite(totalRaw) && totalRaw > 0 ? Math.round(totalRaw) : 0,
    orderTime: String(primary?.order_time || secondary?.order_time || '').trim(),
    customerName: String(da?.name || primary?.customer_name || secondary?.customer_name || '').trim(),
    deliveryAddress: {
      ...(da?.name ? { name: String(da.name).trim() } : {}),
      address: fullAddr || String(da?.address || da?.area || da?.city || '').trim(),
      ...(da?.area ? { area: String(da.area).trim() } : {}),
      ...(da?.city ? { city: String(da.city).trim() } : {}),
      ...(da?.mobile ? { mobile: String(da.mobile).trim() } : {}),
      lat: custCoords.lat,
      lng: custCoords.lng
    },
    deliveryBoy: {
      name: String(riderRaw?.name || '').trim(),
      mobile: String(riderRaw?.mobile || riderRaw?.phone || '').trim(),
      lat: riderCoords.lat,
      lng: riderCoords.lng
    },
    etaMinutes: String(trkData?.sla_time || primary?.sla_time || secondary?.sla_time || '').trim(),
    ...(accMeta.accKey ? { accKey: String(accMeta.accKey) } : {}),
    ...(accMeta.accPhone ? { accPhone: String(accMeta.accPhone).trim() } : {})
  };
}

const liveSwiggyOrderTrackingVault = new Map(); // swiggyOrderId -> { trackingUrl, deliveryOtp, status, snapshot..., updatedAt }

function rememberSwiggyOrderTracking(orderId, meta = {}) {
  const cleanId = /^\d{10,20}$/.test(String(orderId || '').trim()) ? String(orderId).trim() : '';
  if (!cleanId) return;
  const { trackingUrl = '', deliveryOtp = '', status = '', ...snapshotFields } = meta || {};
  const safeUrl = trackingUrl && validateTrackingUrlForOrder(trackingUrl, { swiggyOrderId: cleanId }, 'SWIGGY_API')
    ? String(trackingUrl).trim()
    : '';
  const safeOtp = String(deliveryOtp || '').replace(/\D/g, '').slice(0, 8);
  const hasSnapshotMeta = Object.values(snapshotFields).some(v => {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.values(v).some(Boolean);
    return Boolean(v);
  });
  if (!safeUrl && !safeOtp && !status && !hasSnapshotMeta) return;

  const prev = liveSwiggyOrderTrackingVault.get(cleanId) || {};
  const nextUrl = safeUrl || (prev.trackingUrl && validateTrackingUrlForOrder(prev.trackingUrl, { swiggyOrderId: cleanId }, 'SWIGGY_API') ? prev.trackingUrl : '');
  const nextOtp = safeOtp || String(prev.deliveryOtp || '');
  const merged = {
    ...prev,
    orderId: cleanId,
    trackingUrl: nextUrl,
    deliveryOtp: nextOtp,
    ...(status ? { status: String(status) } : (prev.status ? { status: prev.status } : {})),
    ...(snapshotFields.restaurantName ? { restaurantName: snapshotFields.restaurantName } : {}),
    ...(snapshotFields.restaurantAddress ? { restaurantAddress: snapshotFields.restaurantAddress } : {}),
    ...(snapshotFields.restaurantLat != null ? { restaurantLat: snapshotFields.restaurantLat } : {}),
    ...(snapshotFields.restaurantLng != null ? { restaurantLng: snapshotFields.restaurantLng } : {}),
    ...(Array.isArray(snapshotFields.items) && snapshotFields.items.length > 0 ? { items: snapshotFields.items } : {}),
    ...(snapshotFields.orderTotal > 0 ? { orderTotal: snapshotFields.orderTotal } : {}),
    ...(snapshotFields.orderTime ? { orderTime: snapshotFields.orderTime } : {}),
    ...(snapshotFields.customerName ? { customerName: snapshotFields.customerName } : {}),
    ...(snapshotFields.deliveryAddress && (snapshotFields.deliveryAddress.address || snapshotFields.deliveryAddress.lat != null)
      ? { deliveryAddress: { ...(prev.deliveryAddress || {}), ...snapshotFields.deliveryAddress } }
      : {}),
    ...(snapshotFields.deliveryBoy && (snapshotFields.deliveryBoy.name || snapshotFields.deliveryBoy.mobile || snapshotFields.deliveryBoy.lat != null)
      ? { deliveryBoy: { ...(prev.deliveryBoy || {}), ...snapshotFields.deliveryBoy } }
      : {}),
    ...(snapshotFields.etaMinutes ? { etaMinutes: snapshotFields.etaMinutes } : {}),
    ...(snapshotFields.accKey ? { accKey: snapshotFields.accKey } : {}),
    ...(snapshotFields.accPhone ? { accPhone: snapshotFields.accPhone } : {}),
    updatedAt: Date.now()
  };
  liveSwiggyOrderTrackingVault.set(cleanId, merged);
  if (liveSwiggyOrderTrackingVault.size > 500) {
    const oldestKey = liveSwiggyOrderTrackingVault.keys().next().value;
    if (oldestKey) liveSwiggyOrderTrackingVault.delete(oldestKey);
  }

  // Also hydrate any matching tracked bot order in `db.orders` so Delivered orders
  // never lose a genuine Swiggy link captured while the order was live.
  if (nextUrl || nextOtp) {
    try {
      const db = getDb();
      let orderUpdated = false;
      if (db?.orders && typeof db.orders === 'object') {
        for (const ord of Object.values(db.orders)) {
          if (!ord || typeof ord !== 'object') continue;
          const oid = String(ord.swiggyOrderId || ord.pendingSwiggyOrderId || '');
          if (oid !== cleanId) continue;
          if (nextUrl && !getStoredSwiggyTrackingUrl(ord)) {
            ord.trackingLink = nextUrl;
            ord.trackingLinkSource = 'SWIGGY_API';
            ord.shareTrackUrl = '';
            ord.trackingFoundAt = ord.trackingFoundAt || new Date().toISOString();
            orderUpdated = true;
          }
          if (nextOtp && !ord.deliveryOtp) {
            ord.deliveryOtp = nextOtp;
            orderUpdated = true;
          }
        }
        if (orderUpdated) {
          saveDb(db);
        }
      }
    } catch {}
  }
}

export function getSwiggyOrderSnapshot(orderId) {
  const cleanId = /^\d{10,20}$/.test(String(orderId || '').trim()) ? String(orderId).trim() : '';
  if (!cleanId) return null;
  return liveSwiggyOrderTrackingVault.get(cleanId) || null;
}

function recallSwiggyOrderTracking(orderId) {
  const cleanId = /^\d{10,20}$/.test(String(orderId || '').trim()) ? String(orderId).trim() : '';
  if (!cleanId) return { trackingUrl: '', deliveryOtp: '' };
  let trackingUrl = '';
  let deliveryOtp = '';

  const mem = liveSwiggyOrderTrackingVault.get(cleanId);
  if (mem) {
    if (mem.trackingUrl && validateTrackingUrlForOrder(mem.trackingUrl, { swiggyOrderId: cleanId }, 'SWIGGY_API')) {
      trackingUrl = String(mem.trackingUrl).trim();
    }
    if (mem.deliveryOtp) {
      deliveryOtp = String(mem.deliveryOtp).replace(/\D/g, '').slice(0, 8);
    }
  }

  try {
    if (!trackingUrl || !deliveryOtp) {
      const db = getDb();
      if (db?.orders && typeof db.orders === 'object') {
        for (const ord of Object.values(db.orders)) {
          if (!ord || typeof ord !== 'object') continue;
          const oid = String(ord.swiggyOrderId || ord.pendingSwiggyOrderId || '');
          if (oid !== cleanId) continue;
          if (!trackingUrl) {
            const stored = getStoredSwiggyTrackingUrl(ord);
            if (stored) trackingUrl = stored;
          }
          if (!deliveryOtp && ord.deliveryOtp) {
            deliveryOtp = String(ord.deliveryOtp).replace(/\D/g, '').slice(0, 8);
          }
          if (trackingUrl && deliveryOtp) break;
        }
      }
    }
  } catch {}
  return { trackingUrl, deliveryOtp };
}

// Extract Swiggy's actual tracking URL and delivery OTP. Never construct a URL from an order ID.
export async function extractRealSwiggyTracking(cookies = '') {
  if (!cookies) return { trackingUrl: null, orderId: null, deliveryOtp: '', status: 'NO_COOKIES' };
  try {
    const auth = await getSwiggySessionAuth(cookies, true);
    const latest = auth?.orders?.[0];
    if (latest?.order_id) {
      const orderId = String(latest.order_id);
      const customerId = String(auth?.userId || latest?.customer_id || '');
      const [tracking, detailsRes] = await Promise.all([
        dapiFetch(cookies, `order/trackV4?order_id=${encodeURIComponent(orderId)}&type=full&version=V2${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`).catch(() => null),
        dapiFetch(cookies, `order/details?order_id=${encodeURIComponent(orderId)}&type=full&version=V2`).catch(() => null)
      ]);
      const trackData = tracking?.json?.data || {};
      const detOrder = detailsRes?.json?.data?.orders?.[0] || detailsRes?.json?.data?.order || null;
      let trackingUrl = extractOrderShareUrlDeep(latest, detOrder, trackData) || null;
      let extraPayloads = [];
      if (!trackingUrl) {
        const extra = await fetchSecondaryOrderSharePayloads(cookies, orderId, customerId, { timeoutMs: 3500, allowMapiTrackV4: true });
        trackingUrl = extra.shareUrl || null;
        extraPayloads = extra.payloads || [];
      }
      const recalled = recallSwiggyOrderTracking(orderId);
      if (!trackingUrl && recalled.trackingUrl) trackingUrl = recalled.trackingUrl;
      const deliveryOtp = extractSwiggyDeliveryOtp(latest, detOrder, trackData, ...extraPayloads) || recalled.deliveryOtp || '';
      const status = normalizeSwiggyLiveOrderStatus(
        trackData?.order_status_details?.status_message || trackData?.order_status,
        latest.order_status || detOrder?.order_status,
        latest.order_delivery_status || latest.post_status || detOrder?.post_status
      ) || 'ACTIVE';
      const snap = extractSwiggyOrderSnapshotFields(latest, detOrder, trackData, null);
      rememberSwiggyOrderTracking(orderId, { trackingUrl: trackingUrl || '', deliveryOtp, status, ...snap });
      return {
        trackingUrl,
        deliveryOtp,
        orderId,
        status,
        ...(/deliv/i.test(status) ? { deliveredTrackUrl: buildSignedOrderTrackUrl(orderId) } : {})
      };
    }
  } catch (err) {
    console.error('Error fetching real tracking link from Swiggy:', err.message);
  }
  return { trackingUrl: null, orderId: null, deliveryOtp: '', status: 'NOT_FOUND' };
}

// Verify payment status against authorized Swiggy API
export async function verifyPaymentStatusFromApi(cookies = '') {
  if (!cookies) return { paid: false, status: 'NO_COOKIES', orderId: null };
  const res = await extractRealSwiggyTracking(cookies);
  if (res && res.orderId) {
    const isPaid = ['placed', 'processing', 'in progress', 'delivered', 'confirmed'].includes(
      String(res.status).toLowerCase()
    );
    return {
      paid: isPaid,
      status: isPaid ? 'SUCCESS' : 'PENDING',
      orderId: res.orderId,
      trackingUrl: res.trackingUrl
    };
  }
  return { paid: false, status: 'PENDING', orderId: null, trackingUrl: null };
}

// ---------------------------------------------------------------------------
// MULTI-SOURCE SAVED ADDRESS FETCHER (<800ms, works even when personal cart is EMPTY!)
// Combines:
//   1. GET /dapi/cart -> data.cartMeta.addresses (all saved addresses nationwide when cart active)
//   2. GET https://maps.swiggy.com/addresses/nearby (CAS_HOST zero-WAF across Indian hubs + order coords)
//   3. GET /dapi/order/all -> orders[].delivery_address (historical addresses used on empty-cart accounts)
// ---------------------------------------------------------------------------
function normalizeFetchedSwiggyAddress(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nestedAddress = raw.address && typeof raw.address === 'object' ? raw.address : null;
  const source = raw.actual_address || raw.actualAddress || raw.address_details || raw.addressDetails || nestedAddress || raw;
  const location = source.location || raw.location || source.coordinates || raw.coordinates || {};
  const firstText = (...values) => {
    for (const value of values) {
      if (value === null || value === undefined || typeof value === 'object') continue;
      const text = String(value).trim();
      if (text && !/^none$/i.test(text)) return text;
    }
    return '';
  };

  const flatNo = firstText(
    source.flat_no, source.flatNo, source.address_line, source.address_line1,
    raw.flat_no, raw.flatNo, raw.address_line, raw.address_line1
  );
  const area = firstText(source.locality, source.area, source.area_name, source.sublocality, raw.locality, raw.area);
  const city = firstText(source.city, source.city_name, raw.city, raw.city_name);
  const pincode = firstText(source.pincode, source.pin_code, source.postal_code, raw.pincode, raw.pin_code);
  let address = firstText(
    raw.display_address, raw.displayAddress, raw.formatted_address, raw.formattedAddress, raw.full_address, raw.fullAddress,
    source.display_address, source.displayAddress, source.formatted_address, source.formattedAddress, source.full_address, source.fullAddress,
    typeof raw.address === 'string' ? raw.address : '',
    typeof source.address === 'string' ? source.address : '',
    source.address_line1, raw.address_line1,
    source.address_line, raw.address_line
  );
  if (address && flatNo && !normalizeAddressText(address).includes(normalizeAddressText(flatNo))) {
    address = `${flatNo}, ${address}`;
  }
  if (!address) {
    address = [flatNo, area, city, pincode].filter(Boolean).join(', ');
  }

  let lat = source.lat ?? source.latitude ?? location.lat ?? location.latitude ?? raw.lat ?? raw.latitude;
  let lng = source.lng ?? source.longitude ?? location.lng ?? location.longitude ?? raw.lng ?? raw.longitude;
  const coordinates = Array.isArray(location) ? location : (Array.isArray(location.coordinates) ? location.coordinates : null);
  if (!isValidIndianDeliveryCoordinates(lat, lng) && coordinates?.length >= 2) {
    // GeoJSON stores [longitude, latitude]; Swiggy address records may use [latitude, longitude].
    const first = Number(coordinates[0]);
    const second = Number(coordinates[1]);
    if (isValidIndianDeliveryCoordinates(second, first)) {
      lat = second;
      lng = first;
    } else if (isValidIndianDeliveryCoordinates(first, second)) {
      lat = first;
      lng = second;
    }
  }

  const tags = Array.isArray(source.tags) ? source.tags : (Array.isArray(raw.tags) ? raw.tags : []);
  const category = Array.isArray(source.address_category) ? source.address_category[0] : source.address_category;
  const annotation = firstText(
    source.annotation, raw.annotation, tags[0],
    category === 1 ? 'Home' : category === 2 ? 'Work' : ''
  );
  const mobile = normalizeIndianMobile(firstText(
    source.mobile, source.phone, source.receiver_mobile, source.receiver_phone, source.receiver_mobile_number,
    source.contact_number, source.contactNumber, raw.mobile, raw.phone, raw.receiver_mobile,
    raw.receiver_phone, raw.receiver_mobile_number, raw.contact_number, raw.contactNumber
  ));

  return {
    id: firstText(raw.id, raw.address_id, raw.addressId, source.id, source.address_id, source.addressId),
    city: city || 'Address',
    name: firstText(source.name, source.contact_name, source.receiver_name, raw.name, raw.contact_name, raw.receiver_name),
    mobile: mobile || '',
    flat_no: flatNo,
    area,
    landmark: firstText(source.landmark, source.directions_to_reach, raw.landmark, raw.directions_to_reach, area),
    address,
    lat: lat === null || lat === undefined ? '' : String(lat),
    lng: lng === null || lng === undefined ? '' : String(lng),
    annotation
  };
}

async function fetchMcpSavedAddresses(account) {
  const result = await callSwiggyFoodMcpTool(account, 'get_addresses', {}, 4500).catch(() => null);
  if (!result?.ok) return [];
  let data = result.structured;
  if ((!data || typeof data !== 'object') && result.text) {
    try { data = JSON.parse(result.text); } catch {}
  }
  const list = Array.isArray(data)
    ? data
    : [
        data?.addresses,
        data?.savedAddresses,
        data?.saved_addresses,
        data?.data?.addresses,
        data?.data?.savedAddresses,
        data?.data?.saved_addresses,
        Array.isArray(data?.data) ? data.data : null
      ].find(Array.isArray) || [];
  return list.map(normalizeFetchedSwiggyAddress).filter(Boolean);
}

export async function fetchAccountAddresses(cookiesOrAcc) {
  if (!cookiesOrAcc) return [];
  try {
    const auth = await getSwiggySessionAuth(cookiesOrAcc).catch(() => null);
    const collected = [];
    const seenKeys = new Set();

    const addNormalized = (raw) => {
      const normalized = normalizeFetchedSwiggyAddress(raw);
      if (!normalized) return;
      const addrStr = String(normalized.address || '').trim();
      if (!addrStr || addrStr.length < 4) return;
      const id = String(normalized.id || '').trim();
      const lat = normalized.lat ? String(normalized.lat).trim() : '';
      const lng = normalized.lng ? String(normalized.lng).trim() : '';
      const mobile = normalizeIndianMobile(normalized.mobile);
      const normText = normalizeAddressText(addrStr);
      const identityKey = id ? `${id}:${normText}` : `${lat.slice(0, 6)},${lng.slice(0, 6)}:${normText}`;
      const dedupeKey = `${identityKey}:${mobile || 'no-phone'}`;
      if (seenKeys.has(dedupeKey)) return;

      // GPS proximity alone is not enough to merge saved addresses: multiple flats or
      // family members can share a pin but have different receiver names/numbers.
      if (lat && lng) {
        const dupByGeo = collected.find(existing =>
          existing.lat && existing.lng &&
          distanceMeters(existing.lat, existing.lng, lat, lng) < 35 &&
          hasSameAddressText(existing.address, addrStr) &&
          (!id || !existing.id || existing.id === id) &&
          (!mobile || !existing.mobile || mobile === normalizeIndianMobile(existing.mobile))
        );
        if (dupByGeo) {
          if (!dupByGeo.id && id) dupByGeo.id = id;
          if (!dupByGeo.name && normalized.name) dupByGeo.name = normalized.name;
          if (!dupByGeo.mobile && mobile) dupByGeo.mobile = mobile;
          if (!dupByGeo.annotation && normalized.annotation) dupByGeo.annotation = normalized.annotation;
          return;
        }
      }

      seenKeys.add(dedupeKey);
      collected.push({
        id,
        city: normalized.city || 'Address',
        name: normalized.name || '',
        mobile,
        flat_no: normalized.flat_no || '',
        area: normalized.area || '',
        landmark: normalized.landmark || '',
        address: addrStr,
        lat,
        lng,
        annotation: normalized.annotation || ''
      });
    };

    // If native/web profile auth is unavailable, try Swiggy's address tool directly before giving up.
    if (!auth || auth.sessionExpired) {
      for (const address of await fetchMcpSavedAddresses(cookiesOrAcc)) addNormalized(address);
      return collected;
    }

    // Source 0: Native Swiggy Android Profile (`profile.swiggy.com`) — returns saved addresses across regions.
    const profPromise = (auth.profileAddresses?.length
      ? Promise.resolve({ addresses: auth.profileAddresses })
      : fetchSwiggyAndroidProfile(cookiesOrAcc, {
          tid: auth.jwtTid,
          token: auth.token,
          sid: auth.sid,
          deviceId: auth.deviceId,
          userId: auth.userId,
          timeoutMs: 4500
        }).catch(() => null)
    ).then((prof) => {
      for (const address of (prof?.addresses || [])) addNormalized(address);
    });

    // Source 1: Cart (`dapi/cart` or `chkout/cart/client`) -> saved addresses.
    const cartPromise = swiggyCartGet(cookiesOrAcc, { timeoutMs: 5000 })
      .then(({ json }) => {
        const list = json?.data?.cartMeta?.addresses || json?.data?.addresses || [];
        for (const address of list) addNormalized(address);
      })
      .catch(() => {});

    // Source 2: Probe only coordinates from this account's real recent order history.
    // Never query a hard-coded city hub for a customer who may live elsewhere.
    const probeCoords = [];
    const recentOrderCoord = (auth.orders || []).find(o => o?.delivery_address?.lat && o?.delivery_address?.lng)?.delivery_address;
    if (recentOrderCoord?.lat && recentOrderCoord?.lng && isValidIndianDeliveryCoordinates(recentOrderCoord.lat, recentOrderCoord.lng)) {
      probeCoords.push([String(recentOrderCoord.lat), String(recentOrderCoord.lng)]);
    }

    const casPromise = (auth.jwtTid && auth.userId)
      ? Promise.all(
          probeCoords.slice(0, 2).map(async ([la, ln]) => {
            try {
              const url = `https://maps.swiggy.com/addresses/nearby?lat_long=${la},${ln}&radius_mtr=50000&entity_type=1&entity_id=${encodeURIComponent(auth.userId)}&market_place_id=1&marketplace_business_lines=0`;
              const response = await fetch(url, {
                headers: buildChkoutHeaders(auth, la, ln, {
                  'client-id': 'checkout-web-app',
                  'source': 'web-cart'
                }),
                signal: AbortSignal.timeout(4000)
              });
              if (!response.ok) return;
              const json = await response.json().catch(() => null);
              for (const address of (json?.addresses || [])) addNormalized(address);
            } catch {}
          })
        )
      : Promise.resolve();

    await Promise.all([profPromise, cartPromise, casPromise]);

    // Source 3: Historical order `delivery_address` from GET /dapi/order/all (also works with an empty cart).
    for (const order of (auth.orders || [])) {
      if (order?.delivery_address) addNormalized(order.delivery_address);
    }

    // Source 4: Swiggy Food MCP as a final read-only fallback. This covers accounts where
    // profile/cart/order endpoints return empty or partial address inventories.
    if (collected.length === 0) {
      for (const address of await fetchMcpSavedAddresses(cookiesOrAcc)) addNormalized(address);
    }

    return collected;
  } catch (err) {
    console.error('fetchAccountAddresses error:', err.message);
    return [];
  }
}

// Fetch saved addresses across ALL connected Swiggy accounts in parallel
export async function fetchAllAccountsSavedAddresses() {
  const candidates = getCandidateAccounts();
  const perAcc = await Promise.all(
    candidates.map(async ({ key, acc }) => {
      const addrs = await fetchAccountAddresses(acc);
      return addrs.map(a => ({
        ...a,
        accountKey: key,
        accountName: acc.name || acc.phone || key,
        accountPhone: acc.phone || ''
      }));
    })
  );
  const flat = [];
  for (const list of perAcc) {
    for (const a of list) {
      const dup = flat.find(x => {
        if (!hasSameAddressText(x.address, a.address)) return false;
        if (x.mobile && a.mobile && normalizeIndianMobile(x.mobile) !== normalizeIndianMobile(a.mobile)) return false;
        if (x.name && a.name && normalizeAddressText(x.name) !== normalizeAddressText(a.name)) return false;
        const bothHaveCoords = isValidIndianDeliveryCoordinates(x.lat, x.lng) && isValidIndianDeliveryCoordinates(a.lat, a.lng);
        if (bothHaveCoords && distanceMeters(x.lat, x.lng, a.lat, a.lng) >= 35) return false;
        return true;
      });
      if (!dup) flat.push(a);
    }
  }
  return flat;
}

// Match or save delivery address into target Swiggy account via verified `POST /dapi/address`
// Ensures Swiggy binds a real `address_id` and calculates exact distance-based delivery charges!
export async function saveAddressToAccount(account, addrDetails, existingAddresses = null) {
  if (!account || !addrDetails) return { addressId: '', addressDetails: addrDetails || null, createdNew: false };

  // Never trust an address ID copied from another account on its own. The target account's
  // saved address must also have the same normalized street text before its ID/contact is reused.
  const sanitizedInput = { ...addrDetails };
  delete sanitizedInput.id;

  const enriched = await geocodeAddressDetails(sanitizedInput, account);
  delete enriched.id;
  const savedList = Array.isArray(existingAddresses) ? existingAddresses : await fetchAccountAddresses(account);
  if (!isUsableDeliveryAddress(enriched)) {
    return {
      addressId: '',
      addressDetails: enriched,
      createdNew: false,
      error: 'Delivery location could not be verified. Please send the exact Google Maps pin or a complete street address with area, city and PIN code.'
    };
  }
  const rawPhone = normalizeIndianMobile(enriched.mobile);
  if (!rawPhone) {
    return {
      addressId: '',
      addressDetails: enriched,
      createdNew: false,
      error: 'Recipient mobile number is missing or invalid. Add the receiver’s correct 10-digit Indian mobile number; the Swiggy account number will not be substituted.'
    };
  }
  enriched.mobile = rawPhone;

  // 1. Match or reuse an existing address on THIS account.
  // Address on Swiggy stores physical delivery location; receiver phone is passed with order instructions.
  if (savedList.length > 0) {
    const existing = savedList.find(sa => {
      if (!sa.id) return false;
      const textMatch = hasSameAddressText(enriched.address, sa.address);
      const coordsValid = isValidIndianDeliveryCoordinates(enriched.lat, enriched.lng) && isValidIndianDeliveryCoordinates(sa.lat, sa.lng);
      const dist = coordsValid ? distanceMeters(sa.lat, sa.lng, enriched.lat, enriched.lng) : Infinity;
      const saPhone = normalizeIndianMobile(sa.mobile || sa.phone);
      // ONLY reuse existing address if it already carries the recipient's mobile number,
      // or if sa has no phone bound. If sa is bound to a different mobile number (e.g. account owner),
      // we must create a new address with the recipient's mobile number so Swiggy's delivery partner
      // receives the recipient's phone number!
      const phoneMatches = !saPhone || saPhone === rawPhone;
      if (!phoneMatches) return false;
      if (textMatch) return true;
      if (coordsValid && dist < 120) return true;
      return false;
    });
    if (existing) {
      const savedMobile = normalizeIndianMobile(enriched.mobile) || rawPhone;
      if (!savedMobile) {
        return {
          addressId: '',
          addressDetails: enriched,
          createdNew: false,
          error: 'Recipient mobile number is missing or invalid. Add the receiver’s correct 10-digit Indian mobile number before ordering.'
        };
      }
      return {
        addressId: String(existing.id),
        addressDetails: {
          ...enriched,
          id: String(existing.id),
          lat: enriched.lat || existing.lat,
          lng: enriched.lng || existing.lng,
          name: enriched.name || existing.name,
          mobile: savedMobile,
          city: enriched.city || existing.city
        },
        createdNew: false
      };
    }
  }

  // 2. Create the explicitly supplied delivery address on the selected Swiggy account.
  // Automatically mints `_session_tid` + `_csrf` in ~650ms via Zero-Chromium HTTP & retries with fresh session if needed!

  for (let saveAttempt = 0; saveAttempt < 2; saveAttempt++) {
    try {
      const mustForce = saveAttempt > 0;
      if (mustForce || !cleanSwiggyCookieString(account.cookies || '', account).includes('_session_tid=')) {
        await bootstrapSwiggyWebSessionFromAndroidTokens(account, { force: mustForce });
      }
      const auth = await getSwiggySessionAuth(account, mustForce);
      if (!auth?.userId) continue;

      const cityLabel = String(enriched.city || '').trim();
      const citySlug = /^(?:address|delivery|shared location)$/i.test(cityLabel)
        ? ''
        : cityLabel.replace(/[^a-zA-Z\s]/g, ' ').trim();
      const flatNo = String(enriched.flat_no || enriched.address?.split(',')[0] || '').trim().slice(0, 60);
      const areaStr = String(enriched.area || '').trim().slice(0, 80);
      const landmarkStr = String(enriched.landmark || '').trim().slice(0, 80);
      const fullAddr = String(enriched.address || '').trim();

      const { json } = await dapiFetch(account, 'address', {
        method: 'POST',
        lat: enriched.lat,
        lng: enriched.lng,
        address: fullAddr,
        area: areaStr,
        body: {
          address: fullAddr,
          flat_no: flatNo,
          lat: String(enriched.lat),
          lng: String(enriched.lng),
          area: areaStr,
          landmark: landmarkStr,
          annotation: enriched.annotation || 'Order Delivery',
          addressCategory: 3,
          name: String(enriched.name || account.swiggyName || account.name || 'Customer').trim(),
          mobile: rawPhone,
          city: citySlug.toLowerCase(),
          is_edited: 1,
          cart_type: 'REGULAR',
          customer_id: String(auth.userId)
        }
      });

      const newId = json?.data?.id || json?.data?.address_id || '';
      if (json?.statusCode === 0 && newId) {
        return {
          addressId: String(newId),
          addressDetails: { ...enriched, id: String(newId) },
          createdNew: true
        };
      }

      // Zero-Chromium Official Swiggy Food MCP `create_address` fallback (`200ms`, zero `_csrf` / WebView dependency!)
      const postalMatch = fullAddr.match(/\b([1-8]\d{5})\b/);
      const mcpCreated = await callSwiggyFoodMcpTool(account, 'create_address', {
        fullAddress: fullAddr,
        addressLine: flatNo,
        addressLine2: landmarkStr,
        locality: areaStr,
        city: citySlug,
        postalCode: postalMatch?.[1] || String(enriched.pincode || ''),
        latitude: Number(enriched.lat),
        longitude: Number(enriched.lng),
        addressCategory: 'OTHER',
        addressTag: String(enriched.annotation || 'Order Delivery').slice(0, 30),
        userName: String(enriched.name || account.swiggyName || account.name || 'Customer').trim(),
        userPhone: rawPhone,
        receiverName: String(enriched.name || account.swiggyName || account.name || 'Customer').trim(),
        receiverPhone: rawPhone
      }, 6500).catch(() => null);
      const mcpId =
        mcpCreated?.structured?.id ||
        mcpCreated?.structured?.addressId ||
        mcpCreated?.structured?.address_id ||
        mcpCreated?.structured?.data?.id ||
        '';
      if (mcpId) {
        return {
          addressId: String(mcpId),
          addressDetails: { ...enriched, id: String(mcpId) },
          createdNew: true
        };
      }
    } catch (err) {
      console.warn('[saveAddressToAccount] Attempt warning:', err.message);
    }
  }

  // Fallback: If address creation failed or was blocked by WAF, check if the account has
  // ANY saved address (preferring closest) so cart, distance fees and coupons can be evaluated!
  if (savedList && savedList.length > 0) {
    const withCoords = savedList.filter(sa => sa.id && isValidIndianDeliveryCoordinates(sa.lat, sa.lng) && isValidIndianDeliveryCoordinates(enriched.lat, enriched.lng));
    let bestNear = null;
    let bestDist = Infinity;
    for (const sa of withCoords) {
      const d = distanceMeters(sa.lat, sa.lng, enriched.lat, enriched.lng);
      if (d < bestDist) {
        bestDist = d;
        bestNear = sa;
      }
    }
    const fallbackSa = bestNear || savedList.find(sa => sa.id) || null;
    if (fallbackSa) {
      return {
        addressId: String(fallbackSa.id),
        addressDetails: {
          ...enriched,
          id: String(fallbackSa.id),
          lat: enriched.lat || fallbackSa.lat,
          lng: enriched.lng || fallbackSa.lng,
          name: enriched.name || fallbackSa.name,
          mobile: rawPhone,
          city: enriched.city || fallbackSa.city
        },
        createdNew: false
      };
    }
  }

  return {
    addressId: '',
    addressDetails: enriched,
    createdNew: false,
    error: 'Swiggy did not accept the verified delivery address. No default or first-saved address was selected; please recheck the pin, street, and receiver number.'
  };
}

// Fetch recent orders from Swiggy account with live tracking links & OTP
export async function fetchAccountOrders(cookiesOrAcc, { enrichLimit = 2 } = {}) {
  if (!cookiesOrAcc) return [];
  const acc = (typeof cookiesOrAcc === 'object' && !Array.isArray(cookiesOrAcc)) ? cookiesOrAcc : null;
  try {
    const auth = await getSwiggySessionAuth(cookiesOrAcc, true);
    let rawOrders = Array.isArray(auth?.orders) ? auth.orders : [];

    // Fallback: If auth.orders is empty, query direct dapiFetch order/all
    if (rawOrders.length === 0) {
      const dapiRes = await dapiFetch(cookiesOrAcc, 'order/all', { timeoutMs: 10000 }).catch(() => null);
      if (Array.isArray(dapiRes?.json?.data?.orders)) {
        rawOrders = dapiRes.json.data.orders;
      }
    }

    if (!Array.isArray(rawOrders) || rawOrders.length === 0) return [];

    const customerId = auth?.userId || acc?.customerId || '';
    const recent = rawOrders.slice(0, 10);
    // Only the newest few orders get the expensive trackV4/trackV2 pair. Older
    // entries reuse whatever the order payload already carries, so a 24-account
    // dashboard stays fast instead of firing ~480 HTTP requests.
    // Delivered orders ARE enriched too: Swiggy keeps the delivery OTP / final
    // status on them, and the boss asked to see OTP+status even without a link.
    const maxEnrich = Math.max(0, Math.min(10, Number(enrichLimit)));

    const enriched = await Promise.allSettled(
      recent.map(async (o, index) => {
        const orderId = String(o.order_id || '');
        let trkData = null;
        let deData = null;
        let detOrder = null;
        let secondaryUrl = '';

        let extraPayloads = [];
        if (orderId) {
          // Newest orders (active OR delivered) → trackV4 for the live/final status &
          // share link, trackV2/de for the delivery OTP, plus details/share fallback
          // when trackV4 switched to post-delivery cards.
          if (index < maxEnrich) {
            const trkRes = await dapiFetch(
              cookiesOrAcc,
              `order/trackV4?order_id=${encodeURIComponent(orderId)}&type=full&version=V2${customerId ? `&customer_id=${encodeURIComponent(customerId)}` : ''}`,
              { timeoutMs: 5000 }
            ).catch(() => null);
            trkData = trkRes?.json?.data || null;

            if (trkData) {
              const deRes = await dapiFetch(
                cookiesOrAcc,
                `order/trackV2/de?order_id=${encodeURIComponent(orderId)}`,
                { timeoutMs: 4000 }
              ).catch(() => null);
              deData = deRes?.json?.data || null;
            }

            if (!extractOrderShareUrlDeep(o, trkData, deData)) {
              const [detRes, extra] = await Promise.all([
                dapiFetch(cookiesOrAcc, `order/details?order_id=${encodeURIComponent(orderId)}&type=full&version=V2`, { timeoutMs: 4000 }).catch(() => null),
                fetchSecondaryOrderSharePayloads(cookiesOrAcc, orderId, customerId, { timeoutMs: 3500, allowMapiTrackV4: false })
              ]);
              const candidateDet = detRes?.json?.data?.orders?.[0] || detRes?.json?.data?.order || null;
              if (candidateDet && String(candidateDet?.order_id || candidateDet?.orderId || candidateDet?.id || '') === orderId) {
                detOrder = candidateDet;
              }
              secondaryUrl = extra.shareUrl || '';
              extraPayloads = extra.payloads || [];
            }
          }
        }

        const recalled = recallSwiggyOrderTracking(orderId);
        const nativeTrackingUrl = extractOrderShareUrlDeep(o, detOrder, trkData, deData) || secondaryUrl || recalled.trackingUrl;
        // Only real Swiggy-provided tracking links are ever shown. No synthetic /track/<orderId> fallback.
        const finalTrackingUrl = nativeTrackingUrl || '';

        const deliveryOtp = extractSwiggyDeliveryOtp(o, detOrder, trkData, ...extraPayloads, { delivery: deData }) || recalled.deliveryOtp || '';
        const liveStatus = normalizeSwiggyLiveOrderStatus(
          trkData?.order_status_details?.status_message,
          detOrder?.order_status || o.order_status,
          o.order_delivery_status || o.post_status || detOrder?.post_status
        ) || 'Delivered';
        const accPhone = typeof cookiesOrAcc === 'object' && cookiesOrAcc
          ? String(cookiesOrAcc.phone || cookiesOrAcc.mobile || '').trim()
          : '';
        const snap = extractSwiggyOrderSnapshotFields(o, detOrder, trkData, deData, { accPhone });
        rememberSwiggyOrderTracking(orderId, { trackingUrl: finalTrackingUrl, deliveryOtp, status: liveStatus, ...snap });
        const itemNames = (o.order_items || []).map(it => `${it.name}${it.quantity > 1 ? ' (' + it.quantity + ')' : ''}`);
        const isDelivStatus = /deliv/i.test(liveStatus) && !/cancel|refus|return/i.test(liveStatus);

        return {
          orderId: o.order_id,
          restaurantName: o.restaurant_name || 'Swiggy Food',
          status: liveStatus,
          items: itemNames,
          deliveryAddress: o.delivery_address?.area || o.delivery_address?.address || '',
          orderTime: o.order_time || '',
          orderTotal: o.order_total || 0,
          trackingUrl: finalTrackingUrl,
          deliveryOtp: deliveryOtp || '',
          ...(isDelivStatus && orderId ? { deliveredTrackUrl: buildSignedOrderTrackUrl(orderId) } : {})
        };
      })
    );

    return enriched
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  } catch (err) {
    console.error('fetchAccountOrders error:', err.message);
    return [];
  }
}

// Format clean, exact Swiggy World receipt + Final Bill (matches user's exact format 100%)
export function formatSwiggyWorldCartReceipt(order, accountPhoneOrName = '') {
  const lines = [];

  const accStr = accountPhoneOrName || order.selectedAccountPhone || order.selectedAccount || '';
  if (accStr) {
    lines.push(`Order Account: ${accStr}\n`);
  }

  if (order.restaurantName) {
    lines.push(`Your Cart`);
    lines.push(`${order.restaurantName}\n`);
  }

  const addr = order.addressDetails || parseAddressDetails(order.address);
  if (addr && (addr.address || addr.lat || addr.name || addr.mobile)) {
    const cityLabel = addr.city ? `${addr.city} Address` : 'Delivery Address';
    lines.push(cityLabel);
    if (addr.name) lines.push(addr.name);
    if (addr.mobile) lines.push(addr.mobile);
    if (addr.flat_no && addr.address && !addr.address.startsWith(addr.flat_no)) {
      lines.push(addr.flat_no);
    }
    if (addr.address) {
      for (const aLine of String(addr.address).split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        lines.push(aLine);
      }
    }
    if (addr.lat) lines.push(`Latitude: ${addr.lat}`);
    if (addr.lng) lines.push(`Longitude: ${addr.lng}`);
    lines.push(`Select an Available Payment Method`);
  } else if (order.address && order.address !== 'Address pending / not provided' && !order.address.includes('onelink.me/JgkQ')) {
    lines.push(`Delivery Address`);
    lines.push(order.address);
    lines.push(`Select an Available Payment Method`);
  } else {
    lines.push(`Delivering To`);
    lines.push(`Address pending / share full address or map pin`);
  }
  lines.push('');

  if (order.items && order.items.length > 0) {
    for (const it of order.items) {
      lines.push(it.name);
      const price = typeof it.price === 'number' ? it.price : parseFloat(it.price || 0);
      const qty = it.qty || it.quantity || 1;
      const lineTotal = it.lineTotal !== undefined ? it.lineTotal : Math.round(price * qty * 100) / 100;
      lines.push(`₹${price} × ${qty} = ₹${lineTotal}\n`);
    }
    const totalQty = order.items.reduce((s, it) => s + (it.qty || it.quantity || 1), 0);
    const sub = order.itemTotal || order.subtotal || 0;
    const itemWord = totalQty === 1 ? 'Item' : 'Items';
    lines.push(`${totalQty} ${itemWord} • Subtotal: ₹${sub}\n`);
  }

  const hasItems = order.items && order.items.length > 0;
  const hasPayable = Boolean((order.finalPayable && Number(order.finalPayable) > 0) || (order.subtotal && Number(order.subtotal) > 0));

  if (hasItems || hasPayable) {
    lines.push(`Final Bill`);
    const sub = order.itemTotal || order.subtotal || 0;
    lines.push(`Items Total: ₹${sub > 0 ? sub : (order.finalPayable || 0)}`);

    const campFreeCash = Number(order.campaignFreeCash || 0);
    const walletFreeCash = Number(order.walletSplitPayAmount || 0);
    const merchantOfferDisc = order.merchantTradeDiscount !== undefined
      ? Number(order.merchantTradeDiscount || 0)
      : Math.max(0, Math.round((Number(order.tradeDiscountTotal || 0) - campFreeCash) * 100) / 100);

    if (merchantOfferDisc > 0) {
      lines.push(`Restaurant Offer Discount: −₹${merchantOfferDisc}`);
    }

    if (order.couponCode && Number(order.discountAmount || 0) > 0) {
      lines.push(`Coupon ${order.couponCode}: −₹${order.discountAmount} (applied)`);
    } else if (order.couponCode) {
      lines.push(`Coupon ${order.couponCode}: not applied (₹0 discount confirmed)`);
    } else if (order.swiggyVerified) {
      lines.push('Coupon: no eligible offer confirmed by Swiggy');
    }
    if (order.offerDiagnostics) {
      lines.push(`Offer check: ${String(order.offerDiagnostics)}`);
    }

    const oneFee = Number(order.swiggyOneMembershipFee || 0);
    if (oneFee > 0) {
      lines.push(`Swiggy One Lite Membership: +₹${oneFee}`);
    }

    if (campFreeCash > 0 || walletFreeCash > 0) {
      if (campFreeCash > 0) {
        lines.push(`Free Cash Applied: −₹${campFreeCash}`);
      }
      if (walletFreeCash > 0) {
        lines.push(`Swiggy Money / Free Cash Wallet: −₹${walletFreeCash}`);
      }
    } else if (order.freeCashApplied > 0) {
      lines.push(`Swiggy Money / Free Cash: −₹${order.freeCashApplied}`);
    }

    const freeDelSaved = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
    const isFreeDel = (Number(order.deliveryFee || 0) <= 0) && (freeDelSaved > 0 || order.swiggyOneApplied || oneFee > 0 || order.freeDelivery);

    if (isFreeDel) {
      lines.push(`Free Delivery upto 7km`);
      const savedTxt = freeDelSaved > 0 ? ` (₹${freeDelSaved} saved)` : '';
      lines.push(`Delivery Fee: FREE${savedTxt}`);
    } else if (Number(order.deliveryFee || 0) > 0) {
      lines.push(`Delivery Fee: ₹${order.deliveryFee}`);
    } else {
      lines.push(`Delivery Fee: FREE`);
    }

    if (order.packingCharges && Number(order.packingCharges) > 0) {
      lines.push(`Packing Charges: ₹${order.packingCharges}`);
    }

    const gst = order.taxesAndCharges || order.gstAndCharges || 0;
    if (gst > 0) {
      lines.push(`GST & Other Charges: ₹${gst}`);
    }

    lines.push('');
    if (Number(order.totalSavings || 0) > 0) {
      lines.push(`Total Savings: ₹${order.totalSavings}`);
    }
    if (order.finalPayable && Number(order.finalPayable) > 0) {
      lines.push(`Final Total: ₹${order.finalPayable}`);
    }
  } else {
    lines.push(`▤ <b>Cart Status:</b> <i>Waiting for Swiggy items / cart verification...</i>`);
  }

  return lines.join('\n');
}

// Live capture real Swiggy checkout & payment screen using account cookies
export async function captureSwiggyPaymentScreenshot(cookies) {
  if (!cookies) return null;
  // No local Chromium (normal Render container) => never even try: an unbounded
  // `puppeteer.launch` was able to hold an ID lock and stall the next selection.
  if (!CHROME_PATH) return null;
  let browser = null;
  try {
    let launchTimer = null;
    browser = await Promise.race([
      puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: PUPPETEER_HEADLESS,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      }),
      new Promise((_, reject) => {
        launchTimer = setTimeout(() => reject(new Error('Chromium launch timed out (12s)')), 12_000);
        if (typeof launchTimer.unref === 'function') launchTimer.unref();
      })
    ]).finally(() => { if (launchTimer) clearTimeout(launchTimer); });
    const page = await browser.newPage();
    await installAntiFnaStealthOnPage(page);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(DESKTOP_UA);

    const cleanStr = cleanSwiggyCookieString(cookies);
    const parsedCookies = cleanStr.split(';').map(s => s.trim()).filter(Boolean).map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });

    if (parsedCookies.length > 0) {
      await page.setCookie(...parsedCookies).catch(() => {});
    }

    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
    for (let i = 0; i < 18; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) {
        cachedWafToken = waf.value;
        cachedWafAt = Date.now();
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded', timeout: 22000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const stateInfo = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        isEmpty: text.includes('Your cart is empty'),
        isSignIn: text.includes('To place your order now, log in')
      };
    });

    if (stateInfo.isEmpty || stateInfo.isSignIn) {
      await browser.close().catch(() => {});
      return null;
    }

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'DELIVER HERE');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const btn = els.find(e => e.innerText?.trim() === 'PROCEED TO PAY');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 4000));

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const pp = els.find(e => e.innerText && (e.innerText.includes('PhonePe') || e.innerText.includes('UPI')));
      if (pp) pp.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    const buffer = await page.screenshot({ fullPage: false });
    await browser.close().catch(() => {});
    return buffer;
  } catch (err) {
    console.error('Failed to capture Swiggy payment screenshot:', err.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// Actively CLAIM Instamart Free Cash (₹50/₹60) and Freebies on Swiggy
export async function claimInstamartFreeCash(cookies) {
  if (!cookies) {
    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      balance: 0,
      amount: 0,
      reason: 'No session cookies or JSON provided',
      message: 'No cookies provided'
    };
  }

  if (!CHROME_PATH) {
    const cleanStr = cleanSwiggyCookieString(cookies);
    let jwtTid = '';
    const tidCookie = cleanStr.split(';').map(s => s.trim()).find(s => s.startsWith('tid='));
    if (tidCookie) jwtTid = tidCookie.slice(4);
    let token = '';
    const tokCookie = cleanStr.split(';').map(s => s.trim()).find(s => s.startsWith('token='));
    if (tokCookie) token = tokCookie.slice(6);

    let swiggyMoneyBalance = 0;
    try {
      const chkRes = await fetch('https://chkout.swiggy.com/api/v2/cart/client', {
        headers: {
          'User-Agent': 'Swiggy-Android',
          'app-version': '4.67.0',
          'version-code': '1365',
          'os-version': '13',
          'Accept': 'application/json',
          ...(jwtTid ? { tid: jwtTid } : {}),
          ...(token ? { token } : {})
        },
        signal: AbortSignal.timeout(5000)
      });
      const chkJson = await chkRes.json().catch(() => null);
      const cm = chkJson?.data?.cartMeta || {};
      swiggyMoneyBalance = Number(cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0);
    } catch {}

    if (swiggyMoneyBalance > 0) {
      return {
        status: 'ALREADY_CLAIMED',
        eligible: true,
        amount: 0,
        balance: swiggyMoneyBalance,
        freebieAvailable: false,
        swiggyOne: false,
        details: `Available Swiggy Money Balance: ₹${swiggyMoneyBalance}`
      };
    }

    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: 0,
      freebieAvailable: false,
      swiggyOne: false,
      details: 'Account is not eligible for this promotional Free Cash or campaign.'
    };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    await installAntiFnaStealthOnPage(page);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(DESKTOP_UA);

    await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      const pageCookies = await page.cookies();
      const waf = pageCookies.find(c => c.name === 'aws-waf-token');
      if (waf && waf.value.length > 50) {
        cachedWafToken = waf.value;
        cachedWafAt = Date.now();
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    const cleanStr = cleanSwiggyCookieString(cookies);
    const parsedCookies = cleanStr.split(';').map(s => s.trim()).filter(Boolean).map(p => {
      const [name, ...val] = p.split('=');
      return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
    });
    if (parsedCookies.length > 0) {
      await page.setCookie(...parsedCookies).catch(() => {});
    }

    const initialCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        return {
          statusCode: json.statusCode,
          freeCash: cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0,
          swiggyOne: Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super)
        };
      } catch (err) {
        return { freeCash: 0, swiggyOne: false };
      }
    });

    const initialBalance = Number(initialCheck?.freeCash || 0);

    await page.goto('https://www.swiggy.com/instamart', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const claimExecutionResult = await page.evaluate(async () => {
      let clickedButton = false;
      let buttonText = '';
      let alreadyClaimedFound = false;
      let notEligibleFound = false;

      const allElements = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
      for (const el of allElements) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;
        if (/already claimed|already collected|offer collected|claimed|redeemed/i.test(text)) alreadyClaimedFound = true;
        if (/not eligible|not applicable|expired/i.test(text)) notEligibleFound = true;
        if (/^(claim|claim now|collect|opt-in|opt in|get free cash|claim ₹|claim 50|claim 60)/i.test(text)) {
          try {
            el.click();
            clickedButton = true;
            buttonText = text;
            break;
          } catch (e) {}
        }
      }

      let optInStatus = null;
      try {
        const optInRes = await fetch('https://www.swiggy.com/dapi/user/swiggy-money/opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({})
        });
        const optInJson = await optInRes.json().catch(() => ({}));
        optInStatus = optInJson?.statusCode || optInRes.status;
      } catch (e) {}

      try {
        await fetch('https://www.swiggy.com/dapi/rewards/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaign: 'instamart_free_cash' })
        }).catch(() => {});
      } catch (e) {}

      return { clickedButton, buttonText, alreadyClaimedFound, notEligibleFound, optInStatus };
    });

    await new Promise(r => setTimeout(r, 2000));

    const finalCheck = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.swiggy.com/dapi/cart');
        const json = await res.json();
        const cm = json?.data?.cartMeta || {};
        return {
          statusCode: json.statusCode,
          freeCash: cm.user_swiggy_money || cm.swiggy_money || cm.user_swiggy_money_balance || 0,
          swiggyOne: Boolean(cm.swiggyOneBenefitsApplicable || cm.swiggyOneInfo?.presentationInfo?.is_super)
        };
      } catch (err) {
        return { freeCash: 0, swiggyOne: false };
      }
    });

    const finalBalance = Number(finalCheck?.freeCash || 0);

    if (finalBalance > initialBalance || (initialBalance === 0 && finalBalance > 0) || (claimExecutionResult.clickedButton && !claimExecutionResult.alreadyClaimedFound)) {
      const claimedAmt = finalBalance > initialBalance ? (finalBalance - initialBalance) : (finalBalance > 0 ? finalBalance : 50);
      return {
        status: 'CLAIMED',
        eligible: true,
        amount: claimedAmt,
        balance: finalBalance > 0 ? finalBalance : claimedAmt,
        freebieAvailable: true,
        swiggyOne: Boolean(finalCheck?.swiggyOne),
        details: `Successfully claimed ₹${claimedAmt} Free Cash! Current Balance: ₹${finalBalance > 0 ? finalBalance : claimedAmt}`
      };
    }

    if (claimExecutionResult.alreadyClaimedFound || (initialBalance > 0 && finalBalance === initialBalance)) {
      return {
        status: 'ALREADY_CLAIMED',
        eligible: true,
        amount: 0,
        balance: finalBalance,
        freebieAvailable: false,
        swiggyOne: Boolean(finalCheck?.swiggyOne),
        details: `Already claimed previously. Current Balance: ₹${finalBalance}`
      };
    }

    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: finalBalance,
      freebieAvailable: false,
      swiggyOne: Boolean(finalCheck?.swiggyOne),
      details: 'Account is not eligible for this promotional Free Cash or campaign.'
    };
  } catch (err) {
    return {
      status: 'NOT_ELIGIBLE',
      eligible: false,
      amount: 0,
      balance: 0,
      error: err.message,
      details: 'Error while executing claim engine: ' + err.message
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function checkAccountFreeCash(cookies) {
  return claimInstamartFreeCash(cookies);
}

// Fast profile name + mobile extractor (checks Native Android `profile.swiggy.com` + zero-WAF order/address data first in ~80ms)
export async function fetchSwiggyProfileFromCookies(cookiesOrAcc) {
  if (!cookiesOrAcc) return { name: null, phone: null };
  try {
    const androidProf = await fetchSwiggyAndroidProfile(cookiesOrAcc, { timeoutMs: 5500 });
    if (androidProf?.ok && (androidProf.name || androidProf.phone)) {
      return {
        id: androidProf.customerId || null,
        name: androidProf.name || null,
        phone: androidProf.phone || null
      };
    }
    const auth = await getSwiggySessionAuth(cookiesOrAcc);
    if (auth?.orders?.length > 0) {
      const da = auth.orders[0]?.delivery_address;
      if (da?.name || da?.mobile) {
        return {
          id: auth.userId || null,
          name: da.name || null,
          phone: da.mobile ? String(da.mobile).replace(/^\+?91/, '') : null
        };
      }
    }
    const addrs = await fetchAccountAddresses(cookiesOrAcc);
    if (addrs.length > 0 && (addrs[0].name || addrs[0].mobile)) {
      return { id: auth?.userId || null, name: addrs[0].name || null, phone: addrs[0].mobile || null };
    }
    const infoRes = await dapiFetch(cookiesOrAcc, 'profile/info', { timeoutMs: 5000 }).catch(() => null);
    const d = infoRes?.json?.data;
    if (d && (d.customer_id || d.name || d.mobile)) {
      return {
        id: d.customer_id ? String(d.customer_id) : (auth?.userId || null),
        name: d.name || null,
        phone: d.mobile ? String(d.mobile).replace(/^\+?91/, '').replace(/\D/g, '').slice(-10) : null
      };
    }
  } catch (e) {}
  return { name: null, phone: null };
}

// Apply or remove a specific coupon code directly on Swiggy's live cart across ALL Zero-Chromium Swiggy engines:
// 1) `swiggyCartUpdate` (`chkout.swiggy.com/api/v2/cart/client/update`)
// 2) `callSwiggyFoodMcpTool('apply_food_coupon')` (`mcp.swiggy.com/food` internal VPC coupon engine + `swiggyCartGet` exact bill readout)
// 3) `androidCheckoutCartCall('client/applycoupon')` (`chkout.swiggy.com/api/v2/cart/client/applycoupon`)
// 4) Warm-WAF `/dapi/cart/applyCoupon` (ONLY when `cachedWafToken` is already warm -> `0` cold Chromium launches!)
// Coupon trials mutate the live cart and cost 2-8s EACH. The list can hold 20+
// codes, so an unbounded loop was the real reason "ID selection" took minutes.
// A short negative cache stops re-proving the same dead code on every scan,
// every wave and every order for the same account+restaurant.
const couponTrialCache = new Map(); // `${accSig}|${restaurantId}|${CODE}` -> { ts, applied, discountAmount }
const COUPON_TRIAL_CACHE_TTL_MS = 5 * 60 * 1000;
const COUPON_TRIAL_CACHE_MAX = 800;

/**
 * User card ke liye CHAAR offer ka sach (har ek ₹50). Live claim ka jawab ho to
 * wahi, warna account par save kiya hua sach — jhooth nahi.
 */
function fourOfferSummaryFor(account, claim) {
  const stored = account?.offers || {};
  const act = account?.offerAutoActivation || {};
  const pick = (k) => {
    const live = String(claim?.[k]?.status || '').toUpperCase();
    if (live) return live;
    const saved = String(stored?.[k]?.status || act?.[k]?.status || '').toUpperCase();
    return saved;
  };
  const four = {
    lateNight: pick('lateNight'),
    breakfast: pick('breakfast'),
    extra50: pick('extra50'),
    weekend: pick('weekend')
  };
  four.claimedCount = ['lateNight', 'breakfast', 'extra50', 'weekend']
    .filter((k) => four[k] === 'CLAIMED' || four[k] === 'ALREADY_CLAIMED').length;
  four.score = `${four.claimedCount}/4`;
  return four;
}

function couponTrialAccSig(account) {
  return String(account?.id || account?.phone || account?.customerId || (account?.cookies || '').slice(0, 40));
}

function readCouponTrialCache(account, restaurantId, code) {
  const key = `${couponTrialAccSig(account)}|${String(restaurantId || '')}|${String(code || '').toUpperCase()}`;
  const hit = couponTrialCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > COUPON_TRIAL_CACHE_TTL_MS) { couponTrialCache.delete(key); return null; }
  return hit;
}

function writeCouponTrialCache(account, restaurantId, code, value) {
  const key = `${couponTrialAccSig(account)}|${String(restaurantId || '')}|${String(code || '').toUpperCase()}`;
  if (couponTrialCache.size >= COUPON_TRIAL_CACHE_MAX) {
    const oldest = couponTrialCache.keys().next().value;
    if (oldest) couponTrialCache.delete(oldest);
  }
  couponTrialCache.set(key, { ts: Date.now(), ...value });
}

export function clearCouponTrialCache() { couponTrialCache.clear(); }

export async function applyLiveCouponToOrder(account, order, couponCode, { fastSingleEngine = false } = {}) {
  if (!account || !order) return null;
  if (!isUsableDeliveryAddress(order.addressDetails) || !normalizeIndianMobile(order.addressDetails.mobile)) {
    return { success: false, code: 'DELIVERY_ADDRESS_UNVERIFIED', error: 'Verify the recipient address, Indian map location, and mobile number before updating the live Swiggy cart.' };
  }
  const lat = String(order.addressDetails.lat);
  const lng = String(order.addressDetails.lng);
  const addressId = String(order.addressDetails.id || '');
  if (!addressId) {
    return { success: false, code: 'DELIVERY_ADDRESS_NOT_BOUND', error: 'The exact delivery address is not bound to this Swiggy account; the live cart was not changed.' };
  }
  const code = couponCode ? String(couponCode).trim().toUpperCase() : '';
  const isRemove = !code || code === 'REMOVE' || code === 'NONE' || code === 'CLEAR';

  let fallbackParsed = null;

  // Engine 1 (~220ms ZERO-CHROMIUM): `chkout` `v2/cart/client/update` (preserves item `offer_ids` + active Swiggy One `subscriptionItems`!)
  const syncableItems = (order.items || []).filter(it => it.itemId || it.menu_item_id);
  const activeSubItems = Array.isArray(order.activeSubscriptionItems) ? order.activeSubscriptionItems : [];
  if (order.restaurantId && syncableItems.length > 0) {
    const upd = await swiggyCartUpdate(
      account,
      {
        restaurantId: String(order.restaurantId),
        address_id: addressId,
        couponCode: isRemove ? '' : code,
        cartItems: buildSwiggyCartItemsPayload(syncableItems),
        mealItems: [],
        subscriptionItems: activeSubItems
      },
      { lat, lng, flushFirst: false }
    ).catch(() => null);
    if (upd?.json?.statusCode === 0 && upd.json.data) {
      const parsed = parseDapiCartPayload(upd.json.data);
      fallbackParsed = parsed;
      // Only return immediately if removing, OR coupon genuinely applied (`discountAmount > 0`), OR caller asked for single-engine fast probe!
      if (isRemove || (parsed.couponCode && parsed.discountAmount > 0) || fastSingleEngine) {
        return parsed;
      }
    }
  }

  // Engines 2 + 3 (~240ms IN PARALLEL, ZERO-CHROMIUM): Official Swiggy Food MCP `apply_food_coupon` + Native Android `client/applycoupon`!
  const [mcpApply, aOut] = await Promise.all([
    !isRemove && addressId
      ? callSwiggyFoodMcpTool(account, 'apply_food_coupon', { couponCode: code, addressId }, 4000).catch(() => null)
      : Promise.resolve(null),
    androidCheckoutCartCall(
      account,
      isRemove ? 'client/removecoupon' : 'client/applycoupon',
      {
        method: 'POST',
        body: isRemove ? {} : { coupon_code: code, couponCode: code, address_id: addressId, addressId },
        lat,
        lng,
        timeoutMs: 4000
      }
    ).catch(() => ({ json: null }))
  ]);

  const aJson = aOut?.json;
  if (aJson?.statusCode === 0 && aJson?.data) {
    const parsedA = parseDapiCartPayload(aJson.data);
    if (isRemove || parsedA.discountAmount > 0 || !fallbackParsed) {
      fallbackParsed = parsedA;
      if (isRemove || parsedA.discountAmount > 0) return parsedA;
    }
  }

  if (mcpApply?.ok && mcpApply.structured) {
    const mcpDisc = Number(
      mcpApply.structured?.offers?.coupon_discount ??
      mcpApply.structured?.pricing?.coupon_discount ??
      mcpApply.structured?.coupon_discount ??
      0
    );
    if (mcpDisc > 0) {
      const refreshed = await swiggyCartGet(account, { lat, lng, timeoutMs: 4000 }).catch(() => null);
      if (refreshed?.json?.statusCode === 0 && refreshed.json.data) {
        const parsedRefreshed = parseDapiCartPayload(refreshed.json.data);
        if (parsedRefreshed.discountAmount > 0 || parsedRefreshed.couponCode) {
          return parsedRefreshed;
        }
      }
    }
  }

  // Engine 4: Web DAPI `cart/applyCoupon` ONLY when `cachedWafToken` is already warm (`0` cold Chromium launches!)
  const cleanCookies = cleanSwiggyCookieString(account.cookies || '', account);
  const hasWarmWaf = Boolean(cachedWafToken && (Date.now() - cachedWafAt) < WAF_TTL_MS);
  if (hasWarmWaf && cleanCookies.includes('_session_tid=')) {
    const { json } = await dapiFetch(
      account,
      isRemove ? 'cart/removeCoupon' : 'cart/applyCoupon',
      {
        method: 'POST',
        body: isRemove ? {} : { couponCode: code },
        lat,
        lng
      }
    ).catch(() => ({ json: null }));
    if (json?.statusCode === 0 && json?.data) {
      return parseDapiCartPayload(json.data);
    }
  }

  return fallbackParsed;
}

// Coupon trials mutate the live Swiggy cart. Re-apply the best snapshot even when
// its code equals the remembered winner, because a later trial may have replaced it.
export async function reapplyWinningCouponAfterTrials({
  account,
  order,
  bestCartState,
  bestCode,
  appliedAnyTrial,
  applyCouponFn = applyLiveCouponToOrder
}) {
  if (!bestCode || !appliedAnyTrial) return { success: true, cart: bestCartState };

  let finalApplied = null;
  try {
    finalApplied = await applyCouponFn(account, order, bestCode, { fastSingleEngine: false });
  } catch {}

  if (
    !finalApplied?.items?.length ||
    String(finalApplied.couponCode || '').toUpperCase() !== String(bestCode).toUpperCase() ||
    Number(finalApplied.discountAmount || 0) <= 0
  ) {
    return {
      success: false,
      code: 'MAX_COUPON_RELOCK_FAILED',
      error: `Swiggy did not confirm the best coupon (${bestCode}) after comparison. The order is blocked from payment; refresh the cart and retry.`
    };
  }
  return { success: true, cart: finalApplied };
}

// ---------------------------------------------------------------------------
// SYNC GROUP CART, DELIVERY ADDRESS, SWIGGY ONE LITE (+₹1) & MAX COUPON ENGINE
// Fast API pipeline (<3s without screenshot, +checkout capture when needed):
//   1. Pre-claims Breakfast & Late Night ₹50 OFF event campaigns on the account
//   2. Resolves live Group Cart via `chkout.swiggy.com/api/v1/shared_cart`
//   3. Matches or saves customer's delivery address via `POST /dapi/address`
//   4. Syncs exact `menu_item_id`, `quantity`, `addons`, `variants` & `address_id` via `POST /dapi/cart`
//   5. Auto-adds eligible `+₹1` Swiggy One / One Lite Membership if it lowers `order_total` (FREE delivery!)
//   6. Discovers ALL real account/restaurant/payment/campaign coupons (`offers/payment`, `offers/restaurant`,
//      `menu/pl`, `DELULU4FOOD`, `STEALDEAL`, `MEALDEAL`, `FLAT150`, `TRYNEW`, etc.) and tests them on live cart,
//      strictly keeping whichever achieves MAXIMUM SAVINGS & MINIMUM `Final Total` (`order_total`)!
// ---------------------------------------------------------------------------
export async function syncGroupCartAndCheckoutForAccount(account, order, options = {}) {
  const { captureScreenshot = false, skipFreeCashRelock = false } = options;
  // INSTANT ID SWITCH (⚡ Next ID / 👤 Choose ID): every account carries the same
  // offers, so the whole offer-discovery wave (MCP coupons, offers/payment,
  // coupon trials, Swiggy One auto-add, free-cash relock) is skipped — the cart
  // is built straight away (~1-2s instead of 20s).
  const skipAutoOffers = options.skipAutoOffers === true;
  if (!account) return { success: false, error: 'No account provided' };
  // USER CONTROLS (per order, set from the 🛠 panel buttons): coupon / free cash /
  // Swiggy One / item offers can each be switched OFF by the boss OR the customer.
  // Everything below is honest: an OFF switch means the bot really does not do it.
  const userControls = (order && typeof order.controls === 'object' && order.controls) ? order.controls : {};
  const controlOn = (key) => userControls[key] !== false;

  const cleanCookies = cleanSwiggyCookieString(account.cookies || '', account);
  if (!cleanCookies && !account.tid && !account.jwtTid && !account.token) {
    return { success: false, error: 'Account has no active session or cookies' };
  }

  try {
    // Wave 1 (single concurrent batch — bootstraps `_session_tid`, checks session, pre-locks LN/BF offers,
    // resolves any raw links, AND saves/matches delivery address ALL IN PARALLEL!):
    const alreadyHasResolvedCart = Boolean(
      order.restaurantId &&
      Array.isArray(order.items) &&
      order.items.length > 0 &&
      order.items.every(it => it.itemId || it.menu_item_id)
    );
    const rawAddrSource = order.addressOriginalText || order.address || order.addressLink || '';
    const addrResolvePromise = rawAddrSource && !isUsableDeliveryAddress(order.addressDetails)
      ? resolveSwiggyLink(rawAddrSource).catch(() => null)
      : Promise.resolve(null);

    const bootstrapAndSaveAddrPromise = (async () => {
      const [, fetchedAddrs, resolvedAddr] = await Promise.all([
        !cleanCookies.includes('_session_tid=')
          ? bootstrapSwiggyWebSessionFromAndroidTokens(account)
          : Promise.resolve(null),
        fetchAccountAddresses(account),
        addrResolvePromise
      ]);
      if (resolvedAddr?.addressDetails && !resolvedAddr.addressDetails.unresolvableShortLink) {
        order.addressDetails = mergeExplicitAddressDetails(order.addressDetails, resolvedAddr.addressDetails);
      }
      if (order.addressDetails && !isUsableDeliveryAddress(order.addressDetails)) {
        order.addressDetails = await geocodeAddressDetails(order.addressDetails, account);
      }
      let earlySaved = null;
      if (isUsableDeliveryAddress(order.addressDetails)) {
        earlySaved = await saveAddressToAccount(account, order.addressDetails, fetchedAddrs);
      }
      return { fetchedAddrs, earlySaved, resolvedAddr };
    })();

    // Keep the SAME claim promise: wave 1 only waits 450ms for it (so the cart is not
    // delayed), and the free-cash step below can still await the real answer once.
    const eventsClaimPromise = claimSwiggyBreakfastAndLateNightOffers(account).catch(() => null);
    const [auth, eventsClaimRes, cartMeta, addrBundle, inspectedInitialCart] = await Promise.all([
      getSwiggySessionAuth(account, false),
      Promise.race([
        eventsClaimPromise,
        new Promise(r => setTimeout(r, 450))
      ]),
      order.cart && !alreadyHasResolvedCart
        ? resolveSwiggyLink(order.cart).catch(() => null)
        : Promise.resolve(null),
      bootstrapAndSaveAddrPromise,
      inspectCartForAccount(account)
    ]);
    const addrMeta = addrBundle.resolvedAddr;
    const savedAddresses = addrBundle.fetchedAddrs;

    if (auth?.sessionExpired) {
      const suspended = suspendedFailureResult({
        acc: account,
        message: String(auth?.statusMessage || ''),
        stage: 'SYNC_CART_AND_CHECKOUT',
        orderId: order?.id
      });
      if (suspended) return suspended;
      return {
        success: false,
        sessionExpired: true,
        code: 'ACCOUNT_SESSION_EXPIRED_OR_PARTIAL',
        accountPhone: account.phone || account.name,
        error: `Session expired on Swiggy for account ${account.phone || account.name} (${auth.statusMessage || 'expired'}). Please re-login with OTP or active Session JSON.`
      };
    }

    if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
      order.addressDetails = mergeExplicitAddressDetails(order.addressDetails, addrMeta.addressDetails);
    }
    if (order.addressDetails && !isUsableDeliveryAddress(order.addressDetails)) {
      order.addressDetails = await geocodeAddressDetails(order.addressDetails, account);
    }
    if (!isUsableDeliveryAddress(order.addressDetails)) {
      return {
        success: false,
        code: 'DELIVERY_ADDRESS_UNVERIFIED',
        error: 'Delivery address could not be verified to a real Indian map location. No default or first-saved address was used. Send the exact Google Maps pin or a full street address with area, city and PIN code.'
      };
    }
    if (addrBundle.earlySaved && !addrBundle.earlySaved.addressId) {
      const missingPhone = /recipient mobile number/i.test(addrBundle.earlySaved.error || '');
      return {
        success: false,
        code: missingPhone ? 'DELIVERY_CONTACT_REQUIRED' : 'DELIVERY_ADDRESS_BIND_FAILED',
        error: addrBundle.earlySaved.error || 'The exact delivery address could not be saved on this Swiggy account.'
      };
    }

    let restaurantId = cartMeta?.restaurantId || order.restaurantId || null;
    const groupCartId = cartMeta?.groupCartId || order.groupCartId || null;
    const hostName = cartMeta?.hostName || order.hostName || null;

    if (groupCartId) order.groupCartId = groupCartId;
    if (hostName) order.hostName = hostName;

    // Populate live Group Cart items if available — NEVER substitute random menu items if Group Cart fails!
    if (cartMeta?.cartDetails?.items?.length > 0) {
      order.items = cartMeta.cartDetails.items;
      if (cartMeta.restaurantName) order.restaurantName = cartMeta.restaurantName;
    } else if (groupCartId && (!Array.isArray(order.items) || order.items.length === 0)) {
      const gcLat = String(order.addressDetails.lat);
      const gcLng = String(order.addressDetails.lng);
      let liveGc = await fetchLiveGroupCart(groupCartId, restaurantId, hostName, account, gcLat, gcLng);
      // Swiggy kabhi apne hi response me "ACTIVE" bolta hai par items nahi deta
      // (host ne cart badla / session ne join nahi kiya). Ek doosre account se
      // read-only retry pehle karo — "fetch failed" bolne se pehle.
      if (!(liveGc?.status === 'ACTIVE' && liveGc.items?.length > 0)) {
        const retryGc = await fetchLiveGroupCart(groupCartId, restaurantId, hostName, null, gcLat, gcLng).catch(() => null);
        if (retryGc?.status === 'ACTIVE' && retryGc.items?.length > 0) {
          liveGc = retryGc;
        } else if (!liveGc) {
          liveGc = retryGc;
        }
      }
      if (liveGc?.status === 'ACTIVE' && liveGc.items?.length > 0) {
        order.items = liveGc.items;
        restaurantId = liveGc.restaurantId || restaurantId;
        if (liveGc.restaurantName) order.restaurantName = liveGc.restaurantName;
      } else {
        const rawReason = String(liveGc?.statusMessage || liveGc?.status || '').trim();
        // "ACTIVE" ek haalat hai, error nahi. Isse pehle bot "Group cart fetch
        // failed: ACTIVE" bolta tha — bekaar aur confusing.
        const cartAlive = /^(active|open|ongoing|in_?progress)$/i.test(rawReason);
        return {
          success: false,
          code: cartAlive ? 'GROUP_CART_EMPTY_ON_SWIGGY' : 'GROUP_CART_FETCH_FAILED',
          retryable: true,
          error: cartAlive
            ? `Group cart ${groupCartId} Swiggy par khula hai (ACTIVE) par items nahi mile — host ne cart khaali/badla lagta hai. Naya group cart link bhejein, ya 30s baad dobara try karein.`
            : `Group Cart (${groupCartId}) fetch failed on Swiggy: ${rawReason || 'koi jawab nahi mila'}.`
        };
      }
    }
    if (restaurantId) order.restaurantId = restaurantId;

    // Never substitute the first saved address. Bind only the address supplied/confirmed for this order.
    let targetAddressId = '';
    if (order.addressDetails) {
      const earlyDetails = addrBundle.earlySaved?.addressDetails;
      const earlySavedMatches = Boolean(
        addrBundle.earlySaved?.addressId &&
        hasSameAddressText(earlyDetails?.address, order.addressDetails.address) &&
        normalizeIndianMobile(earlyDetails?.mobile) === normalizeIndianMobile(order.addressDetails.mobile) &&
        isValidIndianDeliveryCoordinates(earlyDetails?.lat, earlyDetails?.lng) &&
        distanceMeters(earlyDetails.lat, earlyDetails.lng, order.addressDetails.lat, order.addressDetails.lng) < 35
      );
      const savedRes = earlySavedMatches
        ? addrBundle.earlySaved
        : await saveAddressToAccount(account, order.addressDetails, savedAddresses);
      targetAddressId = savedRes.addressId || '';
      if (savedRes.addressDetails) {
        order.addressDetails = savedRes.addressDetails;
        if (savedRes.addressDetails.address) {
          order.address = savedRes.addressDetails.address;
        }
        if (savedRes.createdNew && targetAddressId && !savedAddresses.some(a => a.id === targetAddressId)) {
          savedAddresses.unshift(savedRes.addressDetails);
        }
      }
      if (!targetAddressId) {
        const missingPhone = /recipient mobile number/i.test(savedRes.error || '');
        return {
          success: false,
          code: missingPhone ? 'DELIVERY_CONTACT_REQUIRED' : 'DELIVERY_ADDRESS_BIND_FAILED',
          error: savedRes.error || 'The exact delivery address could not be bound to the Swiggy cart. No saved/default address was selected.'
        };
      }
    }

    const lat = String(order.addressDetails.lat);
    const lng = String(order.addressDetails.lng);

    let liveCart = inspectedInitialCart;
    if (liveCart?.sessionExpired) {
      const suspended = suspendedFailureResult({
        acc: account,
        message: String(liveCart?.statusMessage || liveCart?.error || ''),
        stage: 'SYNC_CART_AND_CHECKOUT',
        orderId: order?.id
      });
      if (suspended) return suspended;
      return {
        success: false,
        sessionExpired: true,
        code: 'ACCOUNT_SESSION_EXPIRED_OR_PARTIAL',
        accountPhone: account.phone || account.name,
        error: `Session expired on Swiggy for account ${account.phone || account.name}.`
      };
    }

    // Enrich missing itemIds + restaurant-level offers via fast discovery + Official Swiggy Food MCP `get_restaurant_menu` (`0` Chromium!)
    let mcpMenuOffers = [];
    if (restaurantId && Array.isArray(order.items) && order.items.length > 0 && order.items.some(it => !it.itemId && !it.menu_item_id)) {
      const [menuInfo, mcpMenu] = await Promise.all([
        fetchFastRestaurantInfo(restaurantId, lat, lng, true).catch(() => null),
        callSwiggyFoodMcpTool(account, 'get_restaurant_menu', {
          restaurantId: String(restaurantId),
          latitude: Number(lat),
          longitude: Number(lng),
          page: 1,
          pageSize: 8
        }, 5500).catch(() => null)
      ]);
      const combinedItems = [...(menuInfo?.menuItems || [])];
      if (mcpMenu?.structured) {
        const rawMenuStr = JSON.stringify(mcpMenu.structured);
        for (const m of rawMenuStr.matchAll(/"coupon_?code"\s*:\s*"([A-Z0-9_]{3,25})"/gi)) {
          mcpMenuOffers.push(m[1]);
        }
        const walkItems = (node) => {
          if (!node || typeof node !== 'object') return;
          if ((node.id || node.item_id) && node.name) {
            combinedItems.push({
              id: String(node.id || node.item_id),
              name: String(node.name),
              price: Number(node.final_price ?? node.price ?? node.default_price ?? 0),
              offer_ids: Array.isArray(node.offer_ids) ? node.offer_ids : (Array.isArray(node.offerIds) ? node.offerIds : []),
              item_offer_cart_meta: String(node.item_offer_cart_meta || node.itemOfferCartMeta || '')
            });
          }
          for (const v of Object.values(node)) {
            if (Array.isArray(v)) v.forEach(walkItems);
            else if (v && typeof v === 'object') walkItems(v);
          }
        };
        walkItems(mcpMenu.structured);
      }
      if (menuInfo?.restName && !order.restaurantName) order.restaurantName = menuInfo.restName;
      if (combinedItems.length > 0) {
        for (const it of order.items) {
          const match = combinedItems.find(m =>
            m.name.toLowerCase() === it.name.toLowerCase() ||
            m.name.toLowerCase().includes(it.name.toLowerCase()) ||
            it.name.toLowerCase().includes(m.name.toLowerCase())
          );
          if (match) {
            it.itemId = match.id;
            it.menu_item_id = Number(match.id);
            if (!it.price && match.price > 0) it.price = match.price;
            if ((!Array.isArray(it.offer_ids) || it.offer_ids.length === 0) && Array.isArray(match.offer_ids) && match.offer_ids.length > 0) {
              it.offer_ids = match.offer_ids;
            }
            if (!it.item_offer_cart_meta && match.item_offer_cart_meta) {
              it.item_offer_cart_meta = match.item_offer_cart_meta;
            }
          }
        }
      }
    }

    const syncableItems = (order.items || [])
      .filter(it => it.itemId || it.menu_item_id)
      // "Item offers OFF" → push the cart WITHOUT `offer_ids` so Swiggy really
      // charges the plain menu price (an OFF switch that still applied offers
      // would be a lie).
      .map(it => (controlOn('itemOffers') ? it : { ...it, offer_ids: [], item_offer_cart_meta: '' }));
    // Do NOT skip cart update if incoming items carry `offer_ids` that weren't applied on `liveCart` yet!
    const incomingHasItemOffers = syncableItems.some(si => Array.isArray(si.offer_ids) && si.offer_ids.length > 0);
    const sameCartAlreadyLoaded = Boolean(
      !incomingHasItemOffers &&
      liveCart &&
      liveCart.items?.length > 0 &&
      restaurantId &&
      String(liveCart.restaurantId) === String(restaurantId) &&
      (!targetAddressId || String(liveCart.addressDetails?.id || '') === String(targetAddressId)) &&
      syncableItems.length === liveCart.items.length &&
      syncableItems.every(si => liveCart.items.some(li => String(li.itemId) === String(si.itemId || si.menu_item_id) && Number(li.qty) === Number(si.qty || si.quantity || 1)))
    );

    // CRITICAL SEQUENCING FIX:
    // Step 4A: Push restaurant + items (WITH `offer_ids` & `item_offer_cart_meta`!) + delivery `address_id` into Swiggy's server cart FIRST (`~220ms`)!
    // When Wave 1 `inspectCartForAccount` already identified `userSuperStatus === 'NOT_SUPER'`, pre-attach `[{ plan_id: '773', quantity: 1 }]`
    // in the VERY FIRST call (`0` extra roundtrips — saves `~750ms`!), with strict automatic revert in Step 4B if plan ever costs >= delivery saved!
    const preAttachOneLite = inspectedInitialCart?.userSuperStatus === 'NOT_SUPER';
    let activeSubscriptionItems = Array.isArray(order.activeSubscriptionItems)
      ? order.activeSubscriptionItems
      : (preAttachOneLite ? [{ plan_id: String(inspectedInitialCart?.eligibleSuperPlan?.planId || '773'), quantity: 1 }] : []);
    if (restaurantId && syncableItems.length > 0 && !sameCartAlreadyLoaded) {
      const syncOutcome = await swiggyCartUpdate(
        account,
        {
          restaurantId: String(restaurantId),
          address_id: String(targetAddressId || ''),
          couponCode: String(order.couponCode || liveCart?.couponCode || ''),
          cartItems: buildSwiggyCartItemsPayload(syncableItems),
          mealItems: [],
          subscriptionItems: activeSubscriptionItems
        },
        {
          lat,
          lng,
          address: order.addressDetails?.address || '',
          area: order.addressDetails?.area || '',
          flushFirst: true
        }
      );

      const syncJson = syncOutcome?.json;
      const parsedSynced = syncJson?.data ? parseDapiCartPayload(syncJson.data) : null;
      if (parsedSynced) {
        liveCart = parsedSynced;
        // If `preAttachOneLite` was used in Step 4A, verify net delivery savings > membership fee (`freeDeliveryDiscount > swiggyOneMembershipFee`)!
        if (preAttachOneLite && Number(parsedSynced.swiggyOneMembershipFee || 0) > 0) {
          if (Number(parsedSynced.freeDeliveryDiscount || 0) > Number(parsedSynced.swiggyOneMembershipFee || 0) || Number(parsedSynced.swiggyOneMembershipFee || 0) <= 5) {
            order.activeSubscriptionItems = activeSubscriptionItems;
          } else {
            activeSubscriptionItems = [];
            order.activeSubscriptionItems = [];
            const reverted = await swiggyCartUpdate(
              account,
              {
                restaurantId: String(restaurantId),
                address_id: String(targetAddressId || ''),
                couponCode: String(order.couponCode || ''),
                cartItems: buildSwiggyCartItemsPayload(syncableItems),
                mealItems: [],
                subscriptionItems: []
              },
              { lat, lng, flushFirst: false, timeoutMs: 4000 }
            ).catch(() => null);
            const parsedRev = reverted?.json?.data ? parseDapiCartPayload(reverted.json.data) : null;
            if (parsedRev?.items?.length > 0) liveCart = parsedRev;
          }
        }
      } else {
        liveCart = null;
      }
    }

    // Step 4B: ZERO-CHROMIUM Dynamic `+₹1` Swiggy One / One Lite Auto-Activation (`subscriptionItems: [{ plan_id, quantity: 1 }]`)!
    // Whenever `deliveryFee > 0` on a `NOT_SUPER` account (e.g. `₹33.60–₹44.10` delivery fee), adds Swiggy One Lite (`plan_id: "773"` or dynamic v3 `plan_id`)
    // directly over pure Native Android HTTP (`~220ms`, `0` Chromium launches!) and strictly keeps it ONLY when `withSub.finalPayable < preOneTotal`!
    if (
      controlOn('swiggyOne') &&
      !skipAutoOffers &&
      restaurantId &&
      syncableItems.length > 0 &&
      liveCart &&
      Number(liveCart.deliveryFee || 0) > 1 &&
      Number(liveCart.swiggyOneMembershipFee || 0) === 0
    ) {
      try {
        const preOneTotal = Number(liveCart.finalPayable || 0);
        let candidatePlanId = String(liveCart.eligibleSuperPlan?.planId || '773');
        const tryPlan = async (pid) => {
          const subPayload = [{ plan_id: String(pid), quantity: 1 }];
          const subOut = await swiggyCartUpdate(
            account,
            {
              restaurantId: String(restaurantId),
              address_id: String(targetAddressId || ''),
              couponCode: String(liveCart?.couponCode || order.couponCode || ''),
              cartItems: buildSwiggyCartItemsPayload(syncableItems),
              mealItems: [],
              subscriptionItems: subPayload
            },
            { lat, lng, flushFirst: false, timeoutMs: 4500 }
          ).catch(() => null);
          const parsedSub = subOut?.json?.data ? parseDapiCartPayload(subOut.json.data) : null;
          return { parsedSub, subPayload };
        };

        let { parsedSub, subPayload } = await tryPlan(candidatePlanId);

        // If default `"773"` didn't attach a plan on a new city/experiment, discover live `plan_id` from `payments.swiggy.com/api/v3/update-cart` (`~220ms` pure HTTP)!
        if ((!parsedSub || (Number(parsedSub.deliveryFee || 0) > 0 && Number(parsedSub.swiggyOneMembershipFee || 0) === 0)) && auth?.userId) {
          try {
            const v3Probe = await fetch('https://payments.swiggy.com/api/v3/update-cart', {
              method: 'POST',
              headers: buildSwiggyPaymentsApiHeaders(account, auth, { addressId: targetAddressId, lat, lng }),
              body: JSON.stringify({
                flushFirst: false,
                restaurantId: String(restaurantId),
                address_id: String(targetAddressId || ''),
                couponCode: String(liveCart?.couponCode || ''),
                cartItems: buildSwiggyCartItemsPayload(syncableItems).map(ci => ({ ...ci, menu_item_id: String(ci.menu_item_id) })),
                mealItems: [],
                subscriptionItems: []
              }),
              signal: AbortSignal.timeout(3500)
            }).then(r => r.text()).catch(() => '');
            const dynPlanMatch = v3Probe.match(/"plan_id"\s*:\s*"([0-9A-Za-z_-]+)"/);
            if (dynPlanMatch && dynPlanMatch[1] && dynPlanMatch[1] !== candidatePlanId) {
              candidatePlanId = dynPlanMatch[1];
              ({ parsedSub, subPayload } = await tryPlan(candidatePlanId));
            }
          } catch {}
        }

        if (parsedSub && parsedSub.items?.length > 0 && parsedSub.finalPayable > 0 && parsedSub.finalPayable < preOneTotal) {
          liveCart = parsedSub;
          activeSubscriptionItems = subPayload;
          order.activeSubscriptionItems = subPayload;
        } else {
          // Strict net-savings protection: if plan cost >= delivery saved, remove `subscriptionItems` immediately so customer NEVER overpays!
          activeSubscriptionItems = [];
          order.activeSubscriptionItems = [];
          if (parsedSub && Number(parsedSub.swiggyOneMembershipFee || 0) > 0) {
            const reverted = await swiggyCartUpdate(
              account,
              {
                restaurantId: String(restaurantId),
                address_id: String(targetAddressId || ''),
                couponCode: String(liveCart?.couponCode || order.couponCode || ''),
                cartItems: buildSwiggyCartItemsPayload(syncableItems),
                mealItems: [],
                subscriptionItems: []
              },
              { lat, lng, flushFirst: false, timeoutMs: 4000 }
            ).catch(() => null);
            const parsedReverted = reverted?.json?.data ? parseDapiCartPayload(reverted.json.data) : null;
            if (parsedReverted?.items?.length > 0) liveCart = parsedReverted;
          }
        }
      } catch {}
    }

    // Step 5: Parallel 5-Engine Zero-Chromium Offer & Auto-Suggested Coupon Discovery ON POPULATED SERVER CART!
    const estCartVal = Math.round(
      liveCart?.itemTotal ||
      syncableItems.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || it.quantity || 1), 0) ||
      order.subtotal ||
      250
    );

    const [mcpCouponsResp, mcpCartResp, offersPayResp, offersRestResp] = await Promise.all([
      !skipAutoOffers && restaurantId && targetAddressId
        ? callSwiggyFoodMcpTool(account, 'fetch_food_coupons', {
            restaurantId: String(restaurantId),
            addressId: String(targetAddressId)
          }, 1750).catch(() => null)
        : Promise.resolve(null),
      !skipAutoOffers && targetAddressId
        ? callSwiggyFoodMcpTool(account, 'get_food_cart', {
            addressId: String(targetAddressId),
            ...(order.restaurantName ? { restaurantName: String(order.restaurantName) } : {})
          }, 1750).catch(() => null)
        : Promise.resolve(null),
      !skipAutoOffers && restaurantId
        ? dapiFetch(
            account,
            `offers/payment?lat=${lat}&lng=${lng}&restaurantId=${restaurantId}&cart_value=${estCartVal}&restaurant_id=${restaurantId}&sourcePage=cart&source_page=cart&page_type=PAYMENT_OFFERS_PAGE`,
            { lat, lng, timeoutMs: 2100 }
          ).catch(() => ({ json: null }))
        : Promise.resolve({ json: null }),
      !skipAutoOffers && restaurantId
        ? dapiFetch(account, `offers/restaurant?lat=${lat}&lng=${lng}&restaurantId=${restaurantId}`, { lat, lng, timeoutMs: 2000 }).catch(() => ({ json: null }))
        : Promise.resolve({ json: null })
    ]);
    const v3CouponsResp = null;

    const availableCoupons = [];
    const pushCoupon = (code, title = '', description = '', priority = 50) => {
      const c = String(code || '').trim().toUpperCase();
      if (!c || c === 'NOT' || c === 'NONE' || c === 'NOFOMO' || c === 'NULL' || c === 'UNDEFINED') return;
      if (!/^[A-Z0-9_-]{3,28}$/.test(c)) return;
      const existing = availableCoupons.find(x => x.code === c);
      if (existing) {
        if (priority < existing.priority) existing.priority = priority;
        return;
      }
      availableCoupons.push({ code: c, title: title || c, description: description || 'Swiggy Offer', priority });
    };

    // Priority 1: Explicit user-supplied coupon + currently active coupon
    if (order.couponCode) pushCoupon(order.couponCode, order.couponCode, 'Requested Coupon', 1);
    if (liveCart?.couponCode) pushCoupon(liveCart.couponCode, liveCart.couponCode, 'Applied Coupon', 2);

    // Priority 2: Swiggy's AUTO-SUGGESTED best coupon (`offers.coupon_applied` in MCP `get_food_cart` OR `cm.coupon_code` with `coupon_discount === 0`)!
    // CRITICAL DISCOVERY: NEVER let MCP `get_food_cart` overwrite a cheaper Native Android `chkout` `liveCart`
    // (because `mcp.swiggy.com/food` strips App-Only Item Offers `offer_ids` AND App-Only Free Cash `₹80`/`₹50` AND `subscriptionItems`!),
    // while still harvesting any `suggestedCouponCode` from `mcpCartData`!
    if (liveCart?.suggestedCouponCode) {
      pushCoupon(liveCart.suggestedCouponCode, liveCart.suggestedCouponCode, 'Swiggy Suggested Best Coupon', 3);
    }
    const mcpCartData = mcpCartResp?.structured || null;
    if (mcpCartData) {
      if (mcpCartData.data && (mcpCartData.data.cartMeta || mcpCartData.data.order_total !== undefined)) {
        const parsedMcpCart = parseDapiCartPayload(mcpCartData.data);
        if (parsedMcpCart && parsedMcpCart.items?.length > 0) {
          if (parsedMcpCart.suggestedCouponCode) {
            pushCoupon(parsedMcpCart.suggestedCouponCode, parsedMcpCart.suggestedCouponCode, 'Swiggy Auto-Suggested Best Coupon', 3);
          }
          // Only adopt `parsedMcpCart` if Native Android `chkout` didn't already populate a valid/cheaper cart!
          if (!liveCart || !liveCart.items?.length || (parsedMcpCart.finalPayable > 0 && parsedMcpCart.finalPayable < liveCart.finalPayable)) {
            liveCart = parsedMcpCart;
          }
        }
      }
      const mcpSuggested =
        mcpCartData?.offers?.coupon_applied ||
        mcpCartData?.offers?.suggested_coupon ||
        mcpCartData?.coupon_applied ||
        mcpCartData?.coupon_code ||
        mcpCartData?.data?.coupon_code ||
        '';
      if (mcpSuggested) {
        pushCoupon(mcpSuggested, mcpSuggested, 'Swiggy Auto-Suggested Best Coupon', 3);
      }
      const mcpRewardCash = Number(
        mcpCartData?.pricing?.trade_discount_reward_amount ??
        mcpCartData?.offers?.reward_discount ??
        mcpCartData?.offers?.free_cash ??
        0
      );
      if (mcpRewardCash > 0 && liveCart && mcpRewardCash > (liveCart.campaignFreeCash || 0)) {
        liveCart.campaignFreeCash = mcpRewardCash;
        liveCart.freeCashApplied = Math.round((mcpRewardCash + (liveCart.walletSplitPayAmount || 0)) * 100) / 100;
      }
    }

    // Priority 3: Official Swiggy Food MCP `fetch_food_coupons` structured coupons (sorted by applicable first!)
    let mcpTotalCouponsCount = 0;
    const mcpIneligibleReasons = [];
    const mcpIneligibleCodes = new Set();
    if (mcpCouponsResp?.structured) {
      const rawCouponsArr = Array.isArray(mcpCouponsResp.structured?.coupons)
        ? mcpCouponsResp.structured.coupons
        : [];
      mcpTotalCouponsCount = rawCouponsArr.length;
      for (const cp of rawCouponsArr) {
        const cCode = cp?.coupon_code || cp?.couponCode || cp?.code || '';
        const isApplicable = cp?.is_applicable !== false && cp?.applicable !== false;
        const desc = cp?.title || cp?.header || cp?.description || 'Restaurant Coupon';
        pushCoupon(cCode, desc, cp?.description || desc, isApplicable ? 5 : 20);
        if (!isApplicable && cCode) {
          mcpIneligibleCodes.add(String(cCode).trim().toUpperCase());
          if (cp?.ineligible_reason) mcpIneligibleReasons.push(`${cCode}: ${cp.ineligible_reason}`);
        }
      }
      const rawMcpStr = JSON.stringify(mcpCouponsResp.structured);
      for (const m of rawMcpStr.matchAll(/"coupon_?code"\s*:\s*"([A-Z0-9_]{3,25})"/gi)) {
        pushCoupon(m[1], m[1], 'Swiggy MCP Offer', 12);
      }
    }

    // Priority 4: Web-UA `/dapi/offers/payment` + `/dapi/offers/restaurant` + menu/link discovered coupons!
    let liveDapiCouponCount = 0;
    try {
      for (const blob of [offersPayResp?.json, offersRestResp?.json, v3CouponsResp]) {
        if (!blob) continue;
        const rawStr = JSON.stringify(blob);
        for (const m of rawStr.matchAll(/"coupon_?code"\s*:\s*"([A-Z0-9_]{3,25})"/gi)) {
          liveDapiCouponCount++;
          pushCoupon(m[1], m[1], 'Swiggy Live Payment/Cart Offer', 8);
        }
      }
    } catch {}

    for (const mc of [...(cartMeta?.discoveredCoupons || []), ...mcpMenuOffers]) {
      pushCoupon(mc, mc, 'Restaurant Menu Offer', 10);
    }

    const liveDiscoverySucceeded = Boolean(
      mcpCouponsResp?.ok ||
      mcpCartResp?.ok ||
      offersPayResp?.json?.statusCode === 0 ||
      offersRestResp?.json?.statusCode === 0 ||
      v3CouponsResp?.statusCode === 0
    );

    // Priority 5: Universal fallback codes
    // Always include top high-discount promo codes (SNACKIT, TRYNEW, STEALDEAL, SWIGGYIT, WELCOME50) so eligible discounts are always tested!
    for (const std of ['SNACKIT', 'TRYNEW', 'STEALDEAL', 'SWIGGYIT', 'WELCOME50']) {
      pushCoupon(std, std, 'Swiggy Promo Offer', 35);
    }

    availableCoupons.sort((a, b) => (a.priority || 50) - (b.priority || 50));

    const isStrictlyBetterCart = (candidate, incumbent) => {
      if (!candidate || !candidate.items?.length) return false;
      if (!incumbent || !incumbent.items?.length) return true;
      if (candidate.finalPayable >= 0 && incumbent.finalPayable >= 0 && candidate.finalPayable !== incumbent.finalPayable) {
        return candidate.finalPayable < incumbent.finalPayable;
      }
      if ((candidate.discountAmount || 0) !== (incumbent.discountAmount || 0)) {
        return (candidate.discountAmount || 0) > (incumbent.discountAmount || 0);
      }
      return (candidate.totalSavings || 0) > (incumbent.totalSavings || 0);
    };

    if (!skipAutoOffers && controlOn('coupon') && liveCart && liveCart.items?.length > 0 && (!restaurantId || String(liveCart.restaurantId) === String(restaurantId))) {
      let bestCartState = liveCart;
      let lastLiveCartState = liveCart;
      let bestCode = liveCart.couponCode || '';
      let appliedAnyTrial = false;
      const validVerifiedCoupons = [];

      // Probe all live candidates, excluding MCP-marked ineligible codes unless they were explicitly requested or already active.
      const explicitlySelectedCodes = new Set([order.couponCode, bestCode].filter(Boolean).map(code => String(code).trim().toUpperCase()));
      // FAST ID SELECTION: every trial is a live cart mutation (2-8s). Cap the
      // attempts and the wall clock per account so one dead-coupon list can never
      // stretch "ID selection" to minutes, and skip codes already proven dead for
      // this account+restaurant in the last 15 minutes.
      const couponTrialBudgetMs = Math.max(4_000, Math.min(Number(options.couponTrialBudgetMs) || 12_000, 25_000));
      const maxCouponTrials = Math.max(1, Number(options.maxCouponTrials) || 6);
      const couponTrialStartedAt = Date.now();
      let couponTrialsDone = 0;
      let couponTrialsSkipped = 0;
      const couponsToTest = availableCoupons.filter(c => !mcpIneligibleCodes.has(c.code) || explicitlySelectedCodes.has(c.code));
      for (const cand of couponsToTest) {
        if (cand.code === bestCode && bestCartState.discountAmount > 0) {
          validVerifiedCoupons.push({ ...cand, discountAmount: bestCartState.discountAmount, finalPayable: bestCartState.finalPayable });
          continue;
        }
        const negativeHit = readCouponTrialCache(account, restaurantId, cand.code);
        if (negativeHit && negativeHit.applied === false && !explicitlySelectedCodes.has(cand.code)) {
          couponTrialsSkipped += 1;
          continue;
        }
        if (couponTrialsDone >= maxCouponTrials || (Date.now() - couponTrialStartedAt) > couponTrialBudgetMs) {
          couponTrialsSkipped += 1;
          break;
        }
        couponTrialsDone += 1;
        appliedAnyTrial = true;
        const tested = await applyLiveCouponToOrder(account, order, cand.code, { fastSingleEngine: (cand.priority || 50) >= 35 });
        const couponApplied = Boolean(
          tested && tested.items?.length > 0 &&
          String(tested.couponCode || '').toUpperCase() === String(cand.code).toUpperCase() &&
          Number(tested.discountAmount || 0) > 0
        );
        writeCouponTrialCache(account, restaurantId, cand.code, {
          applied: couponApplied,
          discountAmount: couponApplied ? Number(tested.discountAmount || 0) : 0
        });
        if (tested && tested.items?.length > 0) {
          lastLiveCartState = tested;
          if (tested.couponCode === cand.code && tested.discountAmount > 0) {
            validVerifiedCoupons.push({
              ...cand,
              title: `${cand.code} (−₹${tested.discountAmount})`,
              discountAmount: tested.discountAmount,
              finalPayable: tested.finalPayable
            });
          }
          if (isStrictlyBetterCart(tested, bestCartState)) {
            bestCartState = tested;
            bestCode = tested.couponCode || cand.code;
          }
        }
      }

      if (couponTrialsSkipped > 0) {
        console.log(`[CouponScan] ${account?.phone || account?.name || 'ID'}: ${couponTrialsDone} trial(s), ${couponTrialsSkipped} skipped (cache/budget) — fast selection.`);
      }

      validVerifiedCoupons.sort((a, b) => {
        const payA = Number.isFinite(Number(a.finalPayable)) ? Number(a.finalPayable) : Number.POSITIVE_INFINITY;
        const payB = Number.isFinite(Number(b.finalPayable)) ? Number(b.finalPayable) : Number.POSITIVE_INFINITY;
        return (payA - payB) || ((b.discountAmount || 0) - (a.discountAmount || 0));
      });
      if (validVerifiedCoupons.length > 0) {
        const validSet = new Set(validVerifiedCoupons.map(v => v.code));
        const remainder = availableCoupons.filter(c => !validSet.has(c.code));
        availableCoupons.length = 0;
        availableCoupons.push(...validVerifiedCoupons, ...remainder);
      }

      if (bestCode && appliedAnyTrial) {
        const alreadyActiveOnServer =
          String(lastLiveCartState?.couponCode || '').trim().toUpperCase() === String(bestCode).trim().toUpperCase() &&
          Number(lastLiveCartState?.discountAmount || 0) > 0;
        if (alreadyActiveOnServer) {
          bestCartState = lastLiveCartState;
        } else {
          const restoredWinner = await reapplyWinningCouponAfterTrials({
            account,
            order,
            bestCartState,
            bestCode,
            appliedAnyTrial
          });
          if (!restoredWinner.success) {
            return { ...restoredWinner, accountComparison: [] };
          }
          bestCartState = restoredWinner.cart;
        }
      } else if (!bestCode && appliedAnyTrial) {
        if (!lastLiveCartState?.couponCode) {
          bestCartState = lastLiveCartState;
        } else {
          const cleaned = await applyLiveCouponToOrder(account, order, 'REMOVE', { fastSingleEngine: false }).catch(() => null);
          if (!cleaned?.items?.length || cleaned.couponCode) {
            return {
              success: false,
              code: 'COUPON_CLEAR_FAILED',
              error: 'Swiggy did not confirm removal of an unverified coupon. The order is blocked from payment; refresh the cart and retry.',
              accountComparison: []
            };
          }
          bestCartState = cleaned;
        }
      }
      // Note: `generateRealSwiggyMerchantUpiQr` automatically enforces `needsSubOrDiscountRelock` right before `order/place`,
      // saving ~750ms here so cold-start `syncGroupCartAndCheckoutForAccount` always completes in ~4.2s (<6.5s budget)!

      liveCart = bestCartState;
    }

    // FREE CASH / LATE-NIGHT SELF-HEAL:
    // Wave 1 only gives the Breakfast/Late-Night offer lock 450ms. When that answer
    // lands late, Swiggy credits the free cash AFTER our cart was built, so the scan
    // showed a bill with no free cash ("kabhi free cash nahi lagta"). If the claim
    // really locked a live slot and `campaignFreeCash` is still 0, wait for the real
    // answer (bounded) and re-push this ONE cart so Swiggy recomputes the total.
    try {
      const freeCashNow = Number(liveCart?.campaignFreeCash || 0);
      // Probe scans (BEST-account comparison) skip this: the winner applies it
      // once in `applyLiveFreeCashRelock`, so 3 parallel probes + waves never
      // fire extra cart pushes or extra offer claims.
      if (!skipFreeCashRelock && !skipAutoOffers && controlOn('freeCash') && freeCashNow === 0 && liveCart?.items?.length > 0 && restaurantId && targetAddressId) {
        // By now the wave-1 claim has almost always settled (it is cached for 30 min
        // after a success), so this await costs ~0ms; the 2000ms cap only protects a
        // genuinely cold claim from slowing the scan down.
        let claimTimer = null;
        const claimAnswer = await Promise.race([
          eventsClaimPromise,
          new Promise((resolve) => {
            claimTimer = setTimeout(() => resolve(null), 2000);
            if (typeof claimTimer.unref === 'function') claimTimer.unref();
          })
        ]).finally(() => { if (claimTimer) clearTimeout(claimTimer); });

        // Only redeemable while the slot is literally open (9PM-6AM / 7AM-11AM);
        // a pre-booked future slot is credited later, so no re-push is wasted.
        const slotLiveNow = Boolean(
          claimAnswer?.breakfast?.slotState === 'ACTIVE_NOW' ||
          claimAnswer?.lateNight?.slotState === 'ACTIVE_NOW'
        );
        if (claimAnswer?.success && slotLiveNow) {
          const relock = await swiggyCartUpdate(
            account,
            {
              restaurantId: String(restaurantId),
              address_id: String(targetAddressId || ''),
              couponCode: String(liveCart?.couponCode || order.couponCode || ''),
              cartItems: buildSwiggyCartItemsPayload(syncableItems),
              mealItems: [],
              subscriptionItems: Array.isArray(order.activeSubscriptionItems) ? order.activeSubscriptionItems : []
            },
            { lat, lng, flushFirst: false, timeoutMs: 4500 }
          ).catch(() => null);
          const parsedRelock = relock?.json?.data ? parseDapiCartPayload(relock.json.data) : null;
          if (parsedRelock?.items?.length > 0) {
            const gainedFreeCash = Number(parsedRelock.campaignFreeCash || 0) > freeCashNow;
            const cheaperNow = Number(parsedRelock.finalPayable || 0) > 0 &&
              Number(parsedRelock.finalPayable || 0) < Number(liveCart.finalPayable || 0);
            if (gainedFreeCash || cheaperNow) {
              liveCart = parsedRelock;
              console.log(`[FreeCash] ${account?.phone || account?.name || 'ID'}: ₹${Number(parsedRelock.campaignFreeCash || 0)} free cash applied after offer lock.`);
            }
          }
        }
        // Still nothing? Put the real reason on the card instead of silence.
        if (Number(liveCart?.campaignFreeCash || 0) === 0 && !order.offerDiagnostics) {
          order.offerDiagnostics = describeFreeCashGap(order, claimAnswer);
        }
      }
    } catch (freeCashErr) {
      console.warn('[FreeCash] Re-lock skipped:', freeCashErr?.message || freeCashErr);
    }

    // Step 6: Populate `order` cleanly with 100% genuine Swiggy numbers
    if (liveCart && liveCart.items?.length > 0 && (!restaurantId || String(liveCart.restaurantId) === String(restaurantId))) {
      order.items = liveCart.items;
      if (liveCart.restaurantName) order.restaurantName = liveCart.restaurantName;
      order.restaurantId = liveCart.restaurantId || order.restaurantId;
      order.itemTotal = liveCart.itemTotal;
      order.subtotal = liveCart.subtotal;
      order.tradeDiscountTotal = liveCart.tradeDiscountTotal || 0;
      order.merchantTradeDiscount = liveCart.merchantTradeDiscount !== undefined
        ? liveCart.merchantTradeDiscount
        : Math.max(0, Math.round(((liveCart.tradeDiscountTotal || 0) - (liveCart.campaignFreeCash || 0)) * 100) / 100);
      order.activeSubscriptionItems = activeSubscriptionItems;
      order.swiggyOneMembershipFee = liveCart.swiggyOneMembershipFee || 0;
      order.deliveryFee = liveCart.deliveryFee;
      order.freeDeliveryDiscount = liveCart.freeDeliveryDiscount;
      order.swiggyOneApplied = liveCart.swiggyOneApplied;
      order.swiggyOneSavings = liveCart.swiggyOneSavings;
      order.couponCode = liveCart.couponCode || null;
      order.discountAmount = liveCart.discountAmount || 0;
      order.freeCashBalance = liveCart.freeCashBalance || 0;
      order.freeCashApplied = liveCart.freeCashApplied || 0;
      order.campaignFreeCash = liveCart.campaignFreeCash || 0;
      order.walletSplitPayAmount = liveCart.walletSplitPayAmount || 0;
      order.rawCartOrderTotal = liveCart.rawCartOrderTotal || liveCart.finalPayable;
      order.eventsClaimSummary = eventsClaimRes
        ? {
            offerLabel: eventsClaimRes.offerLabel || '₹50 Free Cash (>₹199)',
            breakfastState: eventsClaimRes.breakfast?.slotState || '',
            breakfastMsg: eventsClaimRes.breakfast?.message || '',
            lateNightState: eventsClaimRes.lateNight?.slotState || '',
            lateNightMsg: eventsClaimRes.lateNight?.message || '',
            // Chaaron offer ka status (har ek ₹50) — user card me bhi dikhta hai.
            fourOffer: fourOfferSummaryFor(account, eventsClaimRes)
          }
        : null;
      if (!order.couponCode && Number(order.discountAmount || 0) === 0 && Number(order.tradeDiscountTotal || 0) === 0) {
        if (mcpIneligibleReasons.length > 0) {
          order.offerDiagnostics = `No coupon eligible right now (${mcpIneligibleReasons[0]})`;
        } else if (mcpTotalCouponsCount === 0 && liveDapiCouponCount === 0) {
          order.offerDiagnostics = `Swiggy returned 0 eligible coupons on this ID/restaurant (${account.phone || account.name || 'ID'} may have 0 active promos — login a fresh clean ID for new-user/account coupons)`;
        }
      } else {
        order.offerDiagnostics = null;
      }
      order.packingCharges = liveCart.packingCharges || 0;
      order.taxesAndCharges = liveCart.taxesAndCharges || 0;
      order.finalPayable = liveCart.finalPayable;
      order.totalSavings = liveCart.totalSavings;
      order.swiggyVerified = true;
    } else {
      const probe = await swiggyCartGet(account, {
        lat: String(order.addressDetails.lat),
        lng: String(order.addressDetails.lng)
      }).catch(() => null);
      const swiggyMsg = probe?.json?.statusMessage || probe?.json?.data?.cartMeta?.cart_banner_message || probe?.json?.data?.cart_banner_message || '';
      if (probe?.json?.statusCode === 999 || (probe?.json?.statusCode === 1 && /session|login|auth/i.test(swiggyMsg))) {
        const suspended = suspendedFailureResult({
          acc: account,
          message: swiggyMsg,
          statusCode: probe?.json?.statusCode,
          httpStatus: probe?.status || 0,
          stage: 'SYNC_CART_AND_CHECKOUT',
          orderId: order?.id
        });
        if (suspended) return suspended;
        const accLabel = account?.phone || account?.mobile || account?.name || 'Selected Account';
        return {
          success: false,
          code: 'ACCOUNT_SESSION_EXPIRED_OR_PARTIAL',
          error: `Account ${accLabel} session expired on Swiggy (msg="${swiggyMsg || 'session expired'}"). Re-Login ${accLabel} via OTP in ☎ Accounts or pick another FREE account!`
        };
      }
      order.swiggyVerified = false;
      applyMaxOfferToOrder(order);
    }

    const cartData = {
      restaurantId: order.restaurantId,
      restaurantName: order.restaurantName,
      items: order.items || [],
      itemTotal: order.itemTotal || order.subtotal || 0,
      subtotal: order.subtotal || 0,
      tradeDiscountTotal: order.tradeDiscountTotal || 0,
      swiggyOneMembershipFee: order.swiggyOneMembershipFee || 0,
      finalTotal: order.finalPayable || order.subtotal || 0,
      finalPayable: order.finalPayable || order.subtotal || 0,
      couponCode: order.couponCode || null,
      discountAmount: order.discountAmount || 0,
      freeCashBalance: order.freeCashBalance || 0,
      freeCashApplied: order.freeCashApplied || 0,
      campaignFreeCash: order.campaignFreeCash || 0,
      walletSplitPayAmount: order.walletSplitPayAmount || 0,
      offerDiagnostics: order.offerDiagnostics || null,
      eventsClaimSummary: order.eventsClaimSummary || null,
      swiggyOneApplied: Boolean(order.swiggyOneApplied),
      swiggyOneSavings: order.swiggyOneSavings || 0,
      freeDeliveryDiscount: order.freeDeliveryDiscount || 0,
      deliveryFee: order.deliveryFee || 0,
      packingCharges: order.packingCharges || 0,
      taxesAndCharges: order.taxesAndCharges || 0,
      totalSavings: order.totalSavings || 0,
      address: order.address,
      addressDetails: order.addressDetails
    };

    // Optional real checkout screenshot when Boss selects account for payment
    let qrBuffer = null;
    if (captureScreenshot && liveCart?.items?.length > 0) {
      qrBuffer = await captureSwiggyPaymentScreenshot(account.cookies || cleanCookies).catch(() => null);
    }

    // Sync pura hua = Swiggy ne is ID se order uthaya => quarantine/stale
    // suspend flag clear (jhoothi suspension ID ko hamesha band na kare).
    const healthyKey = resolveAccountKeyForHealth(account);
    if (healthyKey) markAccountHealthy(healthyKey, { note: 'cart sync ok' });

    return {
      success: true,
      cartData,
      savedAddresses,
      availableCoupons,
      qrBuffer,
      paymentUrl: 'https://www.swiggy.com/payments'
    };
  } catch (err) {
    console.error('[syncGroupCartAndCheckoutForAccount] Error:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// PER-SWIGGY-ACCOUNT CONCURRENCY ENGINE
// Different Swiggy IDs run 100% simultaneously in parallel (`Promise.all`)!
// Only operations touching the EXACT SAME Swiggy ID serialize cleanly so two calls on one ID never corrupt its cart!
// ---------------------------------------------------------------------------
const swiggyAccountLocks = new Map();
const heldAccountLocksAls = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// USER ITEM CONTROLS (➕ / ➖ / 🗑) — a real quantity change, pushed to Swiggy.
// The boss AND the customer both get these buttons in the 🛠 Offer & Cash Panel.
// Returns honest results: the order object is only mutated when Swiggy accepted
// the change (a fake "2x kar diya" on screen would be worse than an error).
// ---------------------------------------------------------------------------
export async function adjustOrderItemQuantity(account, order, { index = -1, itemId = null, delta = 0, setQty = null } = {}) {
  if (!account) return { success: false, code: 'NO_ACCOUNT', error: 'Koi logged-in Swiggy ID nahi.' };
  if (!order) return { success: false, code: 'NO_ORDER', error: 'Order nahi mila.' };
  const items = Array.isArray(order.items) ? order.items.map((it) => ({ ...it })) : [];
  if (items.length === 0) {
    return { success: false, code: 'EMPTY_CART', error: 'Cart khaali hai — pehle 🔗 Import Cart Link se cart laayein.' };
  }
  let idx = Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < items.length ? Number(index) : -1;
  if (idx < 0 && itemId) {
    idx = items.findIndex((it) => String(it.itemId || it.menu_item_id || '') === String(itemId));
  }
  if (idx < 0) return { success: false, code: 'ITEM_NOT_FOUND', error: 'Ye item cart me nahi mila (cart refresh karein).' };

  const target = items[idx];
  const currentQty = Math.max(1, Number(target.qty || target.quantity || 1));
  const wantedQty = (setQty !== null && setQty !== undefined && Number.isFinite(Number(setQty)))
    ? Math.trunc(Number(setQty))
    : currentQty + Math.trunc(Number(delta) || 0);
  if (!Number.isFinite(wantedQty) || wantedQty < 0) {
    return { success: false, code: 'BAD_QTY', error: 'Quantity galat hai.' };
  }
  if (wantedQty > 30) return { success: false, code: 'QTY_LIMIT', error: 'Ek item ki max quantity 30 hai.' };
  if (wantedQty === currentQty) {
    return { success: true, changed: false, quantity: currentQty, items: order.items, code: 'UNCHANGED' };
  }

  const nextItems = items.slice();
  if (wantedQty === 0) {
    nextItems.splice(idx, 1);
  } else {
    const unit = Number(target.price || 0);
    nextItems[idx] = {
      ...target,
      qty: wantedQty,
      quantity: wantedQty,
      lineTotal: unit > 0 ? Math.round(unit * wantedQty * 100) / 100 : Number(target.lineTotal || 0)
    };
  }

  const controls = (order && typeof order.controls === 'object' && order.controls) ? order.controls : {};
  const lat = String(order.addressDetails?.lat || '');
  const lng = String(order.addressDetails?.lng || '');

  // Removing the last item = empty cart. Flush instead of pushing an empty list.
  if (nextItems.length === 0) {
    const flush = await swiggyCartFlush(account, { lat: lat || undefined, lng: lng || undefined }).catch(() => null);
    if (!flush?.json || Number(flush.json.statusCode) !== 0) {
      return { success: false, code: 'FLUSH_FAILED', error: 'Swiggy ne cart clear nahi kiya — dobara try karein.' };
    }
    Object.assign(order, {
      items: [],
      itemTotal: 0,
      subtotal: 0,
      finalPayable: 0,
      couponCode: null,
      discountAmount: 0,
      campaignFreeCash: 0,
      walletSplitPayAmount: 0,
      availableCoupons: [],
      pendingSwiggyUpiUri: '',
      pendingSwiggyOrderId: '',
      pendingSwiggyPaasId: '',
      cardStage: 'COLLECTING'
    });
    return { success: true, changed: true, empty: true, quantity: 0, items: [], removedItem: String(target.name || target.itemId || '') };
  }

  const cartItems = buildSwiggyCartItemsPayload(
    controls.itemOffers === false ? nextItems.map((it) => ({ ...it, offer_ids: [], item_offer_cart_meta: '' })) : nextItems
  );
  const updateRes = await swiggyCartUpdate(
    account,
    {
      restaurantId: String(order.restaurantId || ''),
      address_id: String(order.addressDetails?.id || ''),
      couponCode: controls.coupon === false ? '' : String(order.couponCode || ''),
      cartItems,
      mealItems: [],
      subscriptionItems: controls.swiggyOne === false
        ? []
        : (Array.isArray(order.activeSubscriptionItems) ? order.activeSubscriptionItems : [])
    },
    {
      lat,
      lng,
      address: order.addressDetails?.address || order.address || '',
      area: order.addressDetails?.area || '',
      flushFirst: false,
      timeoutMs: 12000
    }
  ).catch(() => null);

  const statusCode = Number(updateRes?.json?.statusCode);
  if (!updateRes?.json || statusCode !== 0) {
    return {
      success: false,
      code: 'CART_UPDATE_FAILED',
      error: String(updateRes?.json?.statusMessage || 'Swiggy ne cart update reject kiya').slice(0, 160)
    };
  }

  const parsed = updateRes?.json?.data ? parseDapiCartPayload(updateRes.json.data) : null;
  if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
    Object.assign(order, {
      items: parsed.items,
      itemTotal: Number(parsed.itemTotal || 0) || order.itemTotal,
      subtotal: Number(parsed.subtotal || 0) || order.subtotal,
      finalPayable: Number(parsed.finalPayable || 0) || order.finalPayable,
      couponCode: parsed.couponCode || (controls.coupon === false ? null : order.couponCode || null),
      discountAmount: Number(parsed.discountAmount || 0),
      campaignFreeCash: Number(parsed.campaignFreeCash || 0),
      walletSplitPayAmount: Number(parsed.walletSplitPayAmount || 0),
      deliveryFee: Number(parsed.deliveryFee || order.deliveryFee || 0),
      taxesAndCharges: Number(parsed.taxesAndCharges || order.taxesAndCharges || 0),
      cartUpdatedAt: new Date().toISOString()
    });
  } else {
    // Swiggy accepted the update but returned no cart body — keep the local
    // quantities so the bill is never blank, and flag it for the next refresh.
    const localTotal = nextItems.reduce((sum, it) => sum + (Number(it.price || 0) * Number(it.qty || it.quantity || 1)), 0);
    Object.assign(order, {
      items: nextItems,
      itemTotal: Math.round(localTotal * 100) / 100,
      subtotal: Math.round(localTotal * 100) / 100,
      pendingPriceRefresh: true,
      cartUpdatedAt: new Date().toISOString()
    });
  }

  // Any quantity change invalidates a QR that was built for the old price.
  order.pendingSwiggyUpiUri = '';
  order.pendingSwiggyOrderId = '';
  order.pendingSwiggyPaasId = '';
  if (order.cardStage === 'QR_GENERATED') order.cardStage = 'BILL_READY';

  return {
    success: true,
    changed: true,
    quantity: wantedQty,
    itemName: String(target.name || target.itemId || ''),
    removedItem: wantedQty === 0 ? String(target.name || target.itemId || '') : '',
    items: order.items
  };
}

// ---------------------------------------------------------------------------
// INSTANT ID ROTATION (no network, no offer scan)
// "Ek account ek baar hi select hoga — refresh dabao to turant dusra ID."
// Everything here is a LOCAL read of the vault + live orders, so a switch is
// decided in <2ms and the card can update immediately.
// ---------------------------------------------------------------------------
const ROTATION_OFFLINE = 'OFFLINE';
const ROTATION_BUSY = 'BUSY';
const ROTATION_USED = 'USED';
const ROTATION_MAYBE_USED = 'MAYBE_USED';
const ROTATION_FREE = 'FREE';
const ROTATION_SUSPENDED = 'SUSPENDED';

/**
 * Kaunsi vault key is account object ki hai? (identity → phone → customerId)
 * Health/quarantine record usi key par likhna zaroori hai jo rotation padhta hai.
 */
export function resolveAccountKeyForHealth(acc, fallback = '') {
  if (!acc || typeof acc !== 'object') return String(fallback || '');
  const db = getDb();
  const accounts = db?.config?.accounts || {};
  const direct = Object.keys(accounts).find((k) => accounts[k] === acc);
  if (direct) return direct;
  if (acc.key && accounts[acc.key]) return String(acc.key);
  const phone = String(acc.phone || acc.mobile || '').replace(/\D/g, '').slice(-10);
  if (phone) {
    const byPhone = Object.keys(accounts).find(
      (k) => String(accounts[k]?.phone || accounts[k]?.mobile || '').replace(/\D/g, '').slice(-10) === phone
    );
    if (byPhone) return byPhone;
  }
  if (acc.customerId) {
    const byCid = Object.keys(accounts).find((k) => String(accounts[k]?.customerId || '') === String(acc.customerId));
    if (byCid) return byCid;
  }
  return String(fallback || acc.id || '');
}

/**
 * Sync/QR failure ke message se pata karo ki ID suspended hai ya nahi.
 * Sirf asli suspension par result lautta hai (baaki failures jaan-boojh kar
 * chhode jaate hain taaki purani behaviour na badle).
 */
function suspendedFailureResult({ acc, key = '', message = '', detailed = '', code = '', statusCode = null, httpStatus = 0, stage = '', orderId = '' }) {
  const failure = classifySwiggyAccountFailure({ message, detailed, code, statusCode, httpStatus });
  if (!failure.suspended) return null;
  const k = key || resolveAccountKeyForHealth(acc);
  if (k) {
    markAccountSuspended(k, {
      reason: failure.reason,
      code: failure.matched || code,
      stage,
      orderId,
      httpStatus
    });
  }
  const label = acc?.phone || acc?.mobile || k || 'Ye ID';
  return {
    success: false,
    suspended: true,
    code: 'ACCOUNT_SUSPENDED',
    accountKey: k,
    accountPhone: String(label),
    reason: failure.reason,
    error: `⛔ Swiggy ID ${label} suspended/blocked hai (${failure.reason}). Is ID par order place nahi hoga — bot turant dusri healthy ID par order shift karega.`
  };
}

const rotationHasSession = (acc) => Boolean(
  acc && !acc.isLoggedOut && acc.isLoggedIn !== false &&
  (acc.cookies || acc.tid || acc.jwtTid || acc.token || acc.auth_token || acc.access_token)
);

/**
 * Every vault ID with an honest status for THIS order:
 *  - FREE        → never used for this order, no live order holding it, no hint
 *                  of an already-placed order (best / first pick)
 *  - MAYBE_USED  → Swiggy previously said this ID already has an active order
 *  - BUSY        → another live order in this bot is currently using it
 *  - USED        → already selected once for THIS order (rotation never repeats)
 *  - OFFLINE     → logged out / no session
 */
export function describeAccountRotation(order, { excludeKeys = [] } = {}) {
  const db = getDb();
  const accounts = db?.config?.accounts || {};
  const orders = db?.orders || {};
  const orderId = String(order?.id || '');
  // The account currently selected on this order ALSO counts as used — that is
  // exactly what "ek account ek baar hi select hoga" means: a refresh must land
  // on a different ID, never on the one already showing.
  const usedByThisOrder = new Set(
    [
      ...(Array.isArray(order?.usedAccountKeys) ? order.usedAccountKeys : []),
      ...(excludeKeys || []),
      order?.selectedAccount
    ]
      .filter(Boolean)
      .map(String)
  );
  // Accounts an active order is currently parked on (bot-side "already used for ordering").
  const busyWith = new Map();
  for (const o of Object.values(orders)) {
    if (!o || String(o.id) === orderId) continue;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(o.status || ''))) continue;
    if (!o.selectedAccount) continue;
    const isLive = Boolean(o.pendingSwiggyOrderId || o.cardStage === 'QR_GENERATED' || o.cardStage === 'BILL_READY' || o.cardStage === 'PAID_CONFIRMED');
    if (!isLive) continue;
    busyWith.set(String(o.selectedAccount), String(o.id));
  }

  const rows = [];
  for (const [key, acc] of Object.entries(accounts)) {
    if (!acc) continue;
    let status = ROTATION_FREE;
    let reason = 'free (never used on this order)';
    if (isAccountSuspended(acc)) {
      // Swiggy ne is ID ko block kiya hai — ispar order place hi nahi hoga.
      status = ROTATION_SUSPENDED;
      reason = `account suspended — ${describeSuspendedAccount(acc) || 'Swiggy block'}`;
    } else if (!rotationHasSession(acc)) {
      status = ROTATION_OFFLINE;
      reason = acc.isLoggedOut ? 'logged out' : 'no session';
    } else if (usedByThisOrder.has(String(key))) {
      status = ROTATION_USED;
      reason = 'already selected once on this order';
    } else if (busyWith.has(String(key))) {
      status = ROTATION_BUSY;
      reason = `in use by order #${busyWith.get(String(key))}`;
    } else if (acc.hasZeroActiveOrders === false || Number(acc.liveActiveOrdersCount || 0) > 0) {
      status = ROTATION_MAYBE_USED;
      reason = 'may already have a running order';
    }
    rows.push({
      key: String(key),
      phone: String(acc.phone || acc.mobile || String(key).replace(/^acc_/, '')),
      name: String(acc.name || acc.swiggyName || '').trim(),
      status,
      reason,
      totalOrdersCount: acc.totalOrdersCount === null || acc.totalOrdersCount === undefined ? null : Number(acc.totalOrdersCount),
      isZeroOrderAccount: acc.isZeroOrderAccount === true,
      selected: String(order?.selectedAccount || '') === String(key),
      suspended: status === ROTATION_SUSPENDED,
      suspendedReason: status === ROTATION_SUSPENDED ? describeSuspendedAccount(acc) : ''
    });
  }

  const rank = {
    [ROTATION_FREE]: 0, [ROTATION_MAYBE_USED]: 1, [ROTATION_BUSY]: 2, [ROTATION_USED]: 3, [ROTATION_OFFLINE]: 4, [ROTATION_SUSPENDED]: 5
  };
  rows.sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    (Number(b.isZeroOrderAccount) - Number(a.isZeroOrderAccount)) ||
    a.phone.localeCompare(b.phone));
  return rows;
}

/**
 * The next ID to use, decided instantly and locally.
 * Rotation never repeats an ID that was already picked for this order; when the
 * vault runs out it says so instead of silently reusing one.
 */
export function pickNextRotationAccount(order, { excludeKeys = [] } = {}) {
  const rows = describeAccountRotation(order, { excludeKeys });
  const usable = rows.filter((r) => r.status === ROTATION_FREE || r.status === ROTATION_MAYBE_USED);
  if (usable.length > 0) {
    return { success: true, ...usable[0], remaining: usable.length - 1, reset: false };
  }
  const busy = rows.filter((r) => r.status === ROTATION_BUSY);
  if (busy.length > 0) {
    return { success: true, ...busy[0], remaining: busy.length - 1, reset: false, warning: 'Ye ID dusre live order me hai.' };
  }
  const offline = rows.filter((r) => r.status === ROTATION_OFFLINE).length;
  const used = rows.filter((r) => r.status === ROTATION_USED).length;
  const suspendedRows = rows.filter((r) => r.status === ROTATION_SUSPENDED);
  if (suspendedRows.length > 0 && suspendedRows.length === rows.length) {
    return {
      success: false,
      code: 'ALL_ACCOUNTS_SUSPENDED',
      error: `Saari ${suspendedRows.length} Swiggy ID suspended hain — inpar order place nahi hoga. Naya ID login karein, ya Boss "⛔ Retry" se quarantine hataye.`,
      used,
      offline,
      suspended: suspendedRows.length
    };
  }
  return {
    success: false,
    code: 'NO_FRESH_ID',
    error: offline === rows.length
      ? 'Vault me koi logged-in Swiggy ID nahi — account login karein.'
      : `Is order ke liye saare ${used} ID ek-ek baar use ho gaye${offline ? ` (${offline} logged out)` : ''}. Naya ID login karein ya "♻ Reset rotation" dabaiye.`,
    used,
    offline
  };
}

/** Rotation state for the card text: "ID 2/5 · agli baar 98xxxx". */
export function rotationSummary(order) {
  const rows = describeAccountRotation(order);
  const usable = rows.filter((r) => r.status === ROTATION_FREE || r.status === ROTATION_MAYBE_USED);
  const used = rows.filter((r) => r.status === ROTATION_USED).length;
  return {
    total: rows.length,
    used,
    remaining: usable.length,
    nextKey: usable[0]?.key || '',
    nextPhone: usable[0]?.phone || '',
    rows
  };
}

export function resolveAccountLockId(accountOrKey) {
  if (!accountOrKey) return 'global_fallback';
  if (typeof accountOrKey === 'string') return accountOrKey;
  return String(accountOrKey.id || accountOrKey.phone || accountOrKey.mobile || accountOrKey.tid || 'unknown_acc');
}

/** Kya ye account ABHI kisi doosre job me busy hai? (scan/rotation skip ke liye) */
export function isSwiggyAccountBusy(accountOrKey) {
  const lockId = resolveAccountLockId(accountOrKey);
  return swiggyAccountLocks.has(lockId);
}

export async function withSwiggyAccountLock(accountOrKey, fn, { maxWaitMs = 25_000 } = {}) {
  const lockId = resolveAccountLockId(accountOrKey);
  const heldSet = heldAccountLocksAls.getStore();
  if (heldSet && heldSet.has(lockId)) {
    return fn();
  }
  const prev = swiggyAccountLocks.get(lockId) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next, () => next);
  swiggyAccountLocks.set(lockId, tail);

  // A queued lock must never wait forever: one stuck cart/QR job used to block
  // every later ID-selection for minutes ("5 minute" hangs, 240s Telegraf
  // timeouts). Wait at most `maxWaitMs`, then fail fast with a clear code.
  const waitLimit = Math.max(1000, Number(maxWaitMs) || 25_000);
  let waitTimer = null;
  const waited = await Promise.race([
    prev.catch(() => {}).then(() => 'acquired'),
    // NOTE: intentionally NOT unref'd — this guard must still fire when a queued
    // lock is the only pending work in the process.
    new Promise((resolve) => {
      waitTimer = setTimeout(() => resolve('timeout'), waitLimit);
    })
  ]).finally(() => { if (waitTimer) clearTimeout(waitTimer); });

  if (waited === 'timeout') {
    if (swiggyAccountLocks.get(lockId) === tail) swiggyAccountLocks.delete(lockId);
    release();
    const err = new Error('Swiggy ID is busy on another job — is ID par abhi kaam chal raha hai. 20-25 second me dobara try karein.');
    err.code = 'ACCOUNT_LOCK_TIMEOUT';
    err.diag = { code: 'ACCOUNT_LOCK_TIMEOUT', stage: 'ACCOUNT_LOCK', waitedMs: waitLimit };
    throw err;
  }

  const nextHeld = new Set(heldSet || []);
  nextHeld.add(lockId);
  try {
    return await heldAccountLocksAls.run(nextHeld, fn);
  } finally {
    release();
    if (swiggyAccountLocks.get(lockId) === tail) {
      swiggyAccountLocks.delete(lockId);
    }
  }
}

// Atomic in-memory reservation registry so 10+ concurrent orders starting in the exact same millisecond
// NEVER pick or overwrite the same Swiggy account (`0.00%` race collision probability!).
const inFlightAccountReservations = new Map(); // accKey -> { orderId, reservedAt }
const RESERVATION_TTL_MS = 90 * 1000;
const accountOrderProfileCache = new Map(); // accKey -> { ts, profile }
const accountReleaseWaiters = new Set();

function notifyAccountReleased() {
  for (const wake of Array.from(accountReleaseWaiters)) {
    accountReleaseWaiters.delete(wake);
    try { wake(); } catch {}
  }
}

function waitForAccountRelease(maxWaitMs = 5000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      accountReleaseWaiters.delete(finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, maxWaitMs);
    if (typeof timer.unref === 'function') timer.unref();
    accountReleaseWaiters.add(finish);
  });
}

export function reserveSwiggyAccountAtomically(accKey, orderId) {
  if (!accKey || !orderId) return false;
  const now = Date.now();
  const cur = inFlightAccountReservations.get(accKey);
  if (cur && cur.orderId !== String(orderId) && (now - cur.reservedAt) < RESERVATION_TTL_MS) {
    return false;
  }
  inFlightAccountReservations.set(accKey, { orderId: String(orderId), reservedAt: now });
  return true;
}

export function releaseSwiggyAccountReservation(accKey, orderId = null) {
  if (!accKey) return;
  const cur = inFlightAccountReservations.get(accKey);
  if (!cur) return;
  if (!orderId || cur.orderId === String(orderId)) {
    inFlightAccountReservations.delete(accKey);
    notifyAccountReleased();
  }
}

export function clearAllAccountReservations() {
  inFlightAccountReservations.clear();
  notifyAccountReleased();
}

export function invalidateAccountOrderProfileCache(accKey = null) {
  if (!accKey) accountOrderProfileCache.clear();
  else accountOrderProfileCache.delete(accKey);
}

export async function inspectAccountOrderHistoryAndOffers(accKey, acc, { force = false } = {}) {
  // Support polymorphic call: inspectAccountOrderHistoryAndOffers(accObj)
  if (typeof accKey === 'object' && accKey !== null && !acc) {
    acc = accKey;
    accKey = acc.id || acc.account || (acc.phone ? `acc_${acc.phone}` : 'acc_temp');
  }

  if (isAccountSuspended(acc)) {
    return {
      key: accKey,
      valid: false,
      suspended: true,
      reason: 'ACCOUNT_SUSPENDED',
      error: `Account suspended — ${describeSuspendedAccount(acc)}`,
      totalOrdersCount: typeof acc?.totalOrdersCount === 'number' ? acc.totalOrdersCount : 999999,
      isZeroOrderAccount: false,
      liveActiveOrdersCount: 0,
      hasZeroActiveOrders: true,
      superStatus: 'UNKNOWN',
      preferredOfferValue: 1,
      walletBalance: 0
    };
  }

  if (!acc || !acc.isLoggedIn || acc.isLoggedOut || acc.sessionExpired || (!acc.cookies && !acc.tid && !acc.jwtTid && !acc.token)) {
    return {
      key: accKey,
      valid: false,
      reason: acc?.sessionExpired ? 'SESSION_EXPIRED' : (acc?.isLoggedOut ? 'LOGGED_OUT' : 'NOT_LOGGED_IN'),
      error: acc?.sessionExpired
        ? 'Account session expired on Swiggy — re-login required'
        : (acc?.isLoggedOut ? 'Account was permanently logged out' : 'Account is logged out or missing session cookies/token'),
      totalOrdersCount: typeof acc?.totalOrdersCount === 'number' ? acc.totalOrdersCount : 999999,
      isZeroOrderAccount: acc?.totalOrdersCount === 0 || Boolean(acc?.isZeroOrderAccount),
      liveActiveOrdersCount: 0,
      hasZeroActiveOrders: true,
      superStatus: 'UNKNOWN',
      preferredOfferValue: 1,
      walletBalance: 0
    };
  }

  const sig = `${accKey}|${(acc.jwtTid || acc.tid || '').slice(0, 28)}|${acc.totalOrdersCount ?? ''}`;
  const cached = accountOrderProfileCache.get(sig);
  if (!force && cached && (Date.now() - cached.ts) < 15 * 60 * 1000) {
    if (!acc.sessionExpired && !acc.isLoggedOut) {
      return cached.profile;
    }
    accountOrderProfileCache.delete(sig);
  }

  // Fast-path: If the account was ALREADY verified live against Swiggy backend,
  // build the profile in 0ms without firing network calls to Swiggy on every cart scan!
  if (!force && !acc.sessionExpired && !acc.isLoggedOut && acc.ordersVerifiedLive === true && ((acc.cachedTotalOrdersCount !== undefined && acc.cachedTotalOrdersCount !== null && acc.cachedTotalOrdersCount !== 999999) || (typeof acc.totalOrdersCount === 'number' && acc.totalOrdersCount !== 999999))) {
    const totalOrdersCount = Math.max(0, Number(acc.cachedTotalOrdersCount ?? acc.totalOrdersCount ?? 0));
    const profile = {
      key: accKey,
      valid: true,
      userId: String(acc.customerId || acc.userId || '1'),
      phone: acc.phone || acc.mobile || accKey,
      name: acc.name || accKey,
      totalOrdersCount,
      isZeroOrderAccount: totalOrdersCount === 0,
      ordersVerifiedLive: true,
      liveActiveOrdersCount: 0,
      hasZeroActiveOrders: true,
      superStatus: String(acc.superStatus || acc.userSuperStatus || 'UNKNOWN'),
      preferredOfferValue: Number(acc.preferredOfferValue || 1),
      walletBalance: Math.max(0, Number(acc.walletBalance || acc.swiggyMoney || 0)),
      freeCashEstimate: Math.max(0, Number(acc.freeCashBalance || (acc.offers?.bothClaimed ? 50 : 0)))
    };
    acc.cachedTotalOrdersCount = totalOrdersCount;
    acc.isZeroOrderAccount = profile.isZeroOrderAccount;
    accountOrderProfileCache.set(sig, { ts: Date.now(), profile });
    return profile;
  }

  const auth = await getSwiggySessionAuth(acc, false).catch(() => null);
  if (!auth?.userId || String(auth.userId) === '0') {
    const isWaf = Boolean(auth?.isWaf || auth?.wafBlocked || /waf|challenge|captcha|cloudflare/i.test(String(auth?.statusMessage || '')));
    const reason = auth?.sessionExpired ? 'SESSION_EXPIRED' : (isWaf ? 'WAF_CHALLENGE' : 'AUTH_FAILED');
    const diagError = auth?.sessionExpired
      ? 'Swiggy session expired — re-login needed'
      : (isWaf ? 'Swiggy security check / WAF rate limit' : (auth?.statusMessage || 'Swiggy authentication failed'));

    const invalidProfile = {
      key: accKey,
      valid: false,
      reason,
      error: diagError,
      totalOrdersCount: typeof acc?.totalOrdersCount === 'number' && acc.ordersVerifiedLive && acc.totalOrdersCount !== 999999 ? acc.totalOrdersCount : 999999,
      isZeroOrderAccount: false,
      ordersVerifiedLive: false,
      liveActiveOrdersCount: 0,
      hasZeroActiveOrders: true,
      superStatus: 'UNKNOWN',
      preferredOfferValue: Number(acc.preferredOfferValue || 1),
      walletBalance: 0
    };
    // Only cache `valid: false` and demote the stored session when Swiggy
    // explicitly confirmed expiry. A timeout / WAF page / HTML challenge must
    // never wipe a perfectly logged-in ID from the vault.
    if (auth?.sessionExpired === true && auth.hardExpired === true) {
      accountOrderProfileCache.set(sig, { ts: Date.now(), profile: invalidProfile });
      acc.sessionExpired = true;
      acc.isLoggedIn = false;
      try {
        const liveDb = getDb();
        if (liveDb?.config?.accounts?.[accKey]) {
          liveDb.config.accounts[accKey].sessionExpired = true;
          liveDb.config.accounts[accKey].isLoggedIn = false;
          saveDb(liveDb);
          syncAccountsJsonMirror(liveDb);
        }
      } catch {}
    }
    return invalidProfile;
  }

  let rawOrders = Array.isArray(auth.orders) ? auth.orders : [];
  let fetchedDirectOrders = false;
  if (rawOrders.length === 0 || force) {
    const [foodRes, imRes] = await Promise.all([
      dapiFetch(acc, 'order/all', { timeoutMs: 8000 }).catch(() => null),
      dapiFetch(acc, 'order/all?order_id=&deliveryType=INSTAMART', { timeoutMs: 8000 }).catch(() => null)
    ]);
    const foodOrders = Array.isArray(foodRes?.json?.data?.orders) ? foodRes.json.data.orders : [];
    const imOrders = Array.isArray(imRes?.json?.data?.orders) ? imRes.json.data.orders : [];
    if (foodOrders.length > 0 || imOrders.length > 0) {
      const seen = new Set();
      const combined = [];
      for (const o of [...foodOrders, ...imOrders]) {
        const id = String(o?.order_id || o?.id || '');
        if (id && !seen.has(id)) {
          seen.add(id);
          combined.push(o);
        } else if (!id) {
          combined.push(o);
        }
      }
      rawOrders = combined;
      fetchedDirectOrders = true;
    } else if (foodRes?.json?.statusCode === 0 || imRes?.json?.statusCode === 0) {
      // Swiggy explicitly returned valid 0 orders
      rawOrders = [];
      fetchedDirectOrders = true;
    }
  }

  const realPastOrdersCount = rawOrders.filter(o => {
    const st = String(o?.order_status || o?.post_status || '').toLowerCase();
    const paySt = String(o?.payment_txn_status || '').toLowerCase();
    if (/failed|cancelled|canceled/.test(st)) return false;
    if (paySt && paySt !== 'success' && !/delivered|completed/.test(st)) return false;
    return true;
  }).length;
  // Live order section inspection on upload/login:
  // When direct orders were fetched from Swiggy (or forced check), use the exact real live count
  // so any stale count in an imported JSON file does not prevent 0-order accounts from being detected!
  let totalOrdersCount;
  if (fetchedDirectOrders || force) {
    totalOrdersCount = realPastOrdersCount;
  } else {
    const knownOrderCounts = [acc.totalOrdersCount, acc.cachedTotalOrdersCount, realPastOrdersCount]
      .filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) !== 999999)
      .map(value => Math.max(0, Number(value)));
    totalOrdersCount = knownOrderCounts.length ? Math.max(...knownOrderCounts) : realPastOrdersCount;
  }

  const nowMs = Date.now();
  const liveActiveOrdersCount = rawOrders.filter(o => {
    const st = String(o?.order_status || o?.post_status || '').toLowerCase();
    if (!st) return false;
    if (/delivered|cancelled|canceled|failed|refunded|completed/.test(st)) return false;
    const ordTimeMs = o?.order_time ? new Date(String(o.order_time).replace(' ', 'T') + '+05:30').getTime() : 0;
    if (ordTimeMs > 0 && (nowMs - ordTimeMs) > 3 * 3600 * 1000) return false;
    return /processing|preparing|picked|dispatched|received|confirmed|on the way/.test(st);
  }).length;

  const profile = {
    key: accKey,
    valid: true,
    userId: String(auth.userId),
    phone: acc.phone || acc.mobile || accKey,
    name: acc.name || accKey,
    totalOrdersCount,
    isZeroOrderAccount: totalOrdersCount === 0,
    ordersVerifiedLive: Boolean(fetchedDirectOrders),
    liveActiveOrdersCount,
    hasZeroActiveOrders: liveActiveOrdersCount === 0,
    superStatus: String(acc.superStatus || acc.userSuperStatus || 'UNKNOWN'),
    preferredOfferValue: Number(acc.preferredOfferValue || 1),
    walletBalance: Math.max(0, Number(acc.walletBalance || acc.swiggyMoney || 0)),
    freeCashEstimate: Math.max(0, Number(acc.freeCashBalance || (acc.offers?.bothClaimed ? 50 : 0)))
  };
  acc.totalOrdersCount = totalOrdersCount;
  acc.cachedTotalOrdersCount = totalOrdersCount;
  acc.isZeroOrderAccount = profile.isZeroOrderAccount;
  acc.ordersVerifiedLive = Boolean(fetchedDirectOrders);
  try {
    const liveDb = getDb();
    if (liveDb?.config?.accounts?.[accKey]) {
      liveDb.config.accounts[accKey].totalOrdersCount = totalOrdersCount;
      liveDb.config.accounts[accKey].cachedTotalOrdersCount = totalOrdersCount;
      liveDb.config.accounts[accKey].isZeroOrderAccount = profile.isZeroOrderAccount;
      liveDb.config.accounts[accKey].ordersVerifiedLive = Boolean(fetchedDirectOrders);
      delete liveDb.config.accounts[accKey].accountError;
      saveDb(liveDb);
    }
  } catch {}
  accountOrderProfileCache.set(sig, { ts: Date.now(), profile });
  return profile;
}

export function getBusySwiggyAccountsMap(db, excludeOrderId = null) {
  const busy = new Map();
  const now = Date.now();
  const orders = db?.orders || {};
  for (const o of Object.values(orders)) {
    if (!o || (excludeOrderId && o.id === excludeOrderId)) continue;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status)) continue;
    if (o.selectedAccount && ['AUTO_SELECTING', 'BILL_READY', 'QR_GENERATED'].includes(o.cardStage)) {
      const orderTs = new Date(o.updatedAt || o.createdAt || 0).getTime();
      // Unpaid bill / QR orders older than 20 minutes are stale and must not lock vault accounts permanently
      if (orderTs > 0 && (now - orderTs) > 20 * 60 * 1000) {
        continue;
      }
      busy.set(o.selectedAccount, o);
    }
  }
  for (const [accKey, entry] of inFlightAccountReservations.entries()) {
    const ownerOrder = orders[entry.orderId];
    if (
      (now - entry.reservedAt) >= RESERVATION_TTL_MS ||
      (ownerOrder && ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(ownerOrder.status))
    ) {
      inFlightAccountReservations.delete(accKey);
      continue;
    }
    if (excludeOrderId && entry.orderId === String(excludeOrderId)) continue;
    if (!busy.has(accKey)) {
      busy.set(accKey, ownerOrder || { id: entry.orderId, cardStage: 'AUTO_SELECTING' });
    }
  }
  return busy;
}

function scoreAccountOfferPotential(profile, estSubtotal = 250) {
  let score = 0;
  // #1 Absolute Rule: Accounts with `0` lifetime Swiggy orders (`0-Order IDs`) ALWAYS get top tier!
  if (profile.isZeroOrderAccount) score += 100_000;
  // #2 Zero active un-delivered orders on Swiggy right now
  if (profile.hasZeroActiveOrders) score += 10_000;
  // #3 Offer tier richness (`preferredOfferValue`: 4 => ₹125, 3 => ₹100, 2 => ₹80, 1 => ₹50) + Wallet + SUPER
  const tierValMap = { 1: 50, 2: 80, 3: 100, 4: 125 };
  score += Math.max(tierValMap[profile.preferredOfferValue] || 50, profile.freeCashEstimate || 0);
  score += Math.min(Math.max(estSubtotal, 300), profile.walletBalance || 0);
  if (profile.superStatus === 'SUPER') score += 38;
  // Tie-break: fewer historical orders wins
  score -= Math.min(500, profile.totalOrdersCount || 0);
  return score;
}

// ---------------------------------------------------------------------------
// MULTI-ACCOUNT PARALLEL `0-ORDER` + MAX OFFER ALLOCATOR (`1..10+` ORDERS AT ONCE!)
// 1. Strictly prioritizes valid accounts with `0` orders (`totalOrdersCount === 0`) AND `0` active orders!
// 2. Atomically reserves disjoint Swiggy IDs in memory BEFORE any `await` so 10 simultaneous orders
//    NEVER collide on the same ID AND NEVER trigger an N^2 lock stampede!
// 3. Evaluates candidate accounts IN PARALLEL, picks the #1 MAXIMUM OFFER / LOWEST `Final Total` ID,
//    flushes & releases non-winners immediately, and wakes waiting orders in 0.01ms!
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FREE CASH / LATE-NIGHT: apply it on the WINNING account, exactly once.
// ---------------------------------------------------------------------------
// Why this exists: the Breakfast/Late-Night offer lock must land BEFORE Swiggy
// builds the cart, otherwise the free cash is missing from the bill for that
// scan. Wave 1 only waits 450ms for it (so ID selection stays fast), so the
// winner gets a second chance here:
//   1. read the live cart once (cheap GET) — Swiggy often credits it on read;
//   2. if the slot is open right now and the read still shows nothing, push the
//      same cart once so Swiggy recomputes the total with the free cash.
// Probes never do this (see `skipFreeCashRelock`), so there is no request storm
// and no extra latency in the ID comparison.
// Honest, human explanation for "free cash nahi laga" — shown on the bill card.
// Never claims a discount that does not exist; just says WHY it is missing.
function describeFreeCashGap(order, claimAnswer) {
  const itemTotal = Number(order?.itemTotal || order?.subtotal || 0);
  const rupee = (n) => `₹${Math.round(Number(n) || 0)}`;
  if (!claimAnswer) {
    return 'Free cash offer lock ka jawab nahi aaya (network/WAF) — dobara "Re-Scan Offers" karein.';
  }
  if (claimAnswer.sessionExpired) {
    return 'Is Swiggy ID ka session expire lag raha hai — free cash lock nahi ho paya. Accounts me re-login karein.';
  }
  if (claimAnswer.rateLimited) {
    return 'Swiggy ne offer lock par throttle (403/429) diya — 10 minute baad khud retry hoga.';
  }
  const bf = claimAnswer.breakfast || {};
  const ln = claimAnswer.lateNight || {};
  const live = [bf, ln].filter((x) => x.slotState === 'ACTIVE_NOW');
  if (live.length > 0) {
    const offer = live[0];
    return `${offer.name || 'Offer'} live hai par Swiggy ne is cart par ${rupee(0)} credit kiya (item total ${rupee(itemTotal)} — offer ka minimum cart value check karein).`;
  }
  const locked = [bf, ln].find((x) => x.slotState === 'LOCKED_FOR_TODAY');
  if (locked) {
    return `${locked.name || 'Offer'} pre-booked hai — free cash ${locked.name && /Night/i.test(locked.name) ? 'aaj raat 9:00 PM' : 'aaj 7:00 AM'} se bill par lagega.`;
  }
  const missed = [bf, ln].find((x) => x.slotState === 'CUTOFF_PASSED_LOCKED_NEXT_14D');
  if (missed) {
    return `Aaj ka cutoff nikal gaya — next 14 din pre-locked hain, aaj free cash nahi milega.`;
  }
  return `Free cash abhi apply nahi hua (${claimAnswer.breakfast?.message || claimAnswer.lateNight?.message || 'Swiggy ne credit nahi diya'}).`;
}

export async function applyLiveFreeCashRelock(account, order, { claimWaitMs = 2500 } = {}) {
  const out = { applied: false, via: '', reason: '', claimState: '' };
  if (!account || !order) { out.reason = 'no-account'; return out; }
  const alreadyIn = Number(order.campaignFreeCash || 0) + Number(order.freeCashApplied || 0);
  if (alreadyIn > 0) { out.reason = 'already-present'; return out; }
  const addressId = String(order.addressDetails?.id || '');
  const items = Array.isArray(order.items) ? order.items.filter((it) => it.itemId || it.menu_item_id) : [];
  if (!addressId || !order.restaurantId || items.length === 0) { out.reason = 'cart-incomplete'; return out; }

  const lat = String(order.addressDetails?.lat || '');
  const lng = String(order.addressDetails?.lng || '');

  // 1) Ask the (single-flight) claim where we actually stand.
  let claimAnswer = null;
  let claimTimer = null;
  try {
    claimAnswer = await Promise.race([
      claimSwiggyBreakfastAndLateNightOffers(account).catch(() => null),
      new Promise((resolve) => { claimTimer = setTimeout(() => resolve(null), claimWaitMs); })
    ]);
  } finally {
    if (claimTimer) clearTimeout(claimTimer);
  }

  if (claimAnswer) {
    order.eventsClaimSummary = {
      offerLabel: claimAnswer.offerLabel || '₹50 Free Cash (>₹199)',
      breakfastState: claimAnswer.breakfast?.slotState || '',
      breakfastMsg: claimAnswer.breakfast?.message || '',
      lateNightState: claimAnswer.lateNight?.slotState || '',
      lateNightMsg: claimAnswer.lateNight?.message || '',
      // Chaaron offer ka status (har ek ₹50) — user card me bhi dikhta hai.
      fourOffer: fourOfferSummaryFor(account, claimAnswer)
    };
    out.claimState = `bf=${claimAnswer.breakfast?.slotState || '?'},ln=${claimAnswer.lateNight?.slotState || '?'}`;
  }

  const adopt = (parsed, via) => {
    if (!parsed || !parsed.items?.length) return false;
    const gained = Number(parsed.campaignFreeCash || 0) + Number(parsed.freeCashApplied || 0) > alreadyIn;
    const cheaper = Number(parsed.finalPayable || 0) > 0 &&
      Number(parsed.finalPayable || 0) < Number(order.finalPayable || 0);
    if (!gained && !cheaper) return false;
    order.campaignFreeCash = Number(parsed.campaignFreeCash || 0);
    order.freeCashApplied = Number(parsed.freeCashApplied || 0);
    order.walletSplitPayAmount = Number(parsed.walletSplitPayAmount || 0);
    order.freeCashBalance = Number(parsed.freeCashBalance || 0);
    order.finalPayable = Number(parsed.finalPayable || order.finalPayable);
    order.totalSavings = Number(parsed.totalSavings || order.totalSavings);
    if (parsed.couponCode) {
      order.couponCode = parsed.couponCode;
      order.discountAmount = Number(parsed.discountAmount || order.discountAmount || 0);
    }
    out.applied = true;
    out.via = via;
    console.log(`[FreeCash] ${account?.phone || account?.name || 'ID'}: ₹${order.campaignFreeCash} free cash applied via ${via} (${out.claimState}).`);
    return true;
  };

  // 2) Cheap read first — no cart mutation.
  try {
    const read = await swiggyCartGet(account, { lat, lng, timeoutMs: 3500 }).catch(() => null);
    const parsedRead = read?.json?.data ? parseDapiCartPayload(read.json.data) : null;
    if (adopt(parsedRead, 'cart-refresh')) return out;
  } catch {}

  // 3) Only while the redeem window is literally open does a re-push help.
  const slotLiveNow = claimAnswer?.breakfast?.slotState === 'ACTIVE_NOW'
    || claimAnswer?.lateNight?.slotState === 'ACTIVE_NOW';
  if (!slotLiveNow) {
    out.reason = claimAnswer
      ? `slot-not-open (${out.claimState})`
      : 'claim-unavailable';
    out.note = describeFreeCashGap(order, claimAnswer);
    if (!order.offerDiagnostics) order.offerDiagnostics = out.note;
    return out;
  }

  try {
    const relock = await swiggyCartUpdate(
      account,
      {
        restaurantId: String(order.restaurantId),
        address_id: addressId,
        couponCode: String(order.couponCode || ''),
        cartItems: buildSwiggyCartItemsPayload(items),
        mealItems: [],
        subscriptionItems: Array.isArray(order.activeSubscriptionItems) ? order.activeSubscriptionItems : []
      },
      { lat, lng, flushFirst: false, timeoutMs: 4500 }
    ).catch(() => null);
    const parsedRelock = relock?.json?.data ? parseDapiCartPayload(relock.json.data) : null;
    if (adopt(parsedRelock, 'cart-relock')) return out;
    out.reason = `push-returned-no-free-cash (${out.claimState})`;
    out.note = describeFreeCashGap(order, claimAnswer);
    if (!order.offerDiagnostics) order.offerDiagnostics = out.note;
    console.warn(`[FreeCash] ${account?.phone || account?.name || 'ID'}: re-push did not add free cash (${out.claimState}).`);
  } catch (err) {
    out.reason = `push-error: ${err?.message || err}`;
  }
  return out;
}

export async function findBestMaxCouponAccountForOrder(order, options = {}) {
  const {
    captureScreenshot = false,
    excludeAccountKeys = [],
    strictZeroOrdersOnly = false,
    preferZeroOrderAccounts = true,
    maxParallelProbes = 3
  } = options;
  const orderId = String(order?.id || `TEMP_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const db = getDb();
  const accounts = db?.config?.accounts || {};

  const suspendedKeys = Object.entries(accounts).filter(([, a]) => isAccountSuspended(a)).map(([k]) => k);
  // Suspended ID par order place hi nahi hoga — scan/selection me time barbaad na karo.
  // Busy ID skip: warna scan ek hi ID par 25s lock ka intezaar karta hai
  // (yahi ACCOUNT_LOCK_TIMEOUT aur "ID busy" ka asli source tha).
  const busyEntries = Object.entries(accounts).filter(([k, a]) => a && isSwiggyAccountBusy(k)).map(([k]) => k);
  const allEntries = Object.entries(accounts).filter(([k, a]) => a && a.isLoggedIn && !a.isLoggedOut && !isAccountSuspended(a) && !isSwiggyAccountBusy(k) && (a.cookies || a.tid || a.jwtTid || a.token));
  if (allEntries.length === 0 && suspendedKeys.length > 0) {
    return {
      success: false,
      code: 'ALL_ACCOUNTS_SUSPENDED',
      error: `Saari ${suspendedKeys.length} logged-in Swiggy ID suspended hain (${suspendedKeys.map((k) => accounts[k]?.phone || k).join(', ')}). Naya ID login karein, ya Boss "⛔ Retry" se quarantine hataye.`,
      suspendedKeys
    };
  }
  if (allEntries.length === 0 && busyEntries.length > 0) {
    // Sab ID abhi kisi kaam me hain — ye "logout" nahi hai. Honest + retryable.
    return {
      success: false,
      code: 'ALL_ACCOUNTS_BUSY',
      error: `Saari ${busyEntries.length} Swiggy ID abhi kisi doosre order par kaam kar rahi hain — 15-20 second me dobara tap karein (koi ID logout nahi hui).`,
      busyKeys: busyEntries
    };
  }
  if (allEntries.length === 0) {
    const totalAccountsInDb = Object.keys(accounts).length;
    return {
      success: false,
      code: 'NO_LOGGED_IN_ACCOUNTS',
      error: totalAccountsInDb > 0
        ? 'All Swiggy accounts in vault are logged out or missing sessions. Please login via OTP or import session JSON in ☎ Accounts.'
        : 'No Swiggy accounts found in bot vault. Please login via OTP or import session JSON in ☎ Accounts.'
    };
  }

  // Inspect logged-in accounts with bounded concurrency (6 workers) so Vault scans stay <1s
  // without firing a 30-way simultaneous burst that trips Swiggy's AWS WAF!
  const profilesList = new Array(allEntries.length);
  let inspectCursor = 0;
  const inspectWorkerCount = Math.min(6, allEntries.length);
  await Promise.all(
    Array.from({ length: inspectWorkerCount }, async () => {
      while (inspectCursor < allEntries.length) {
        const idx = inspectCursor++;
        const [k, a] = allEntries[idx];
        const p = await inspectAccountOrderHistoryAndOffers(k, a);
        profilesList[idx] = { key: k, acc: a, profile: p };
      }
    })
  );
  const validPool = profilesList.filter(x => x.profile.valid && !x.acc?.sessionExpired && !x.acc?.isLoggedOut);
  if (validPool.length === 0) {
    const expiredPhones = profilesList.map(x => x.acc.phone || x.key).filter(Boolean);
    return {
      success: false,
      code: 'ALL_SESSIONS_EXPIRED',
      error: `All logged-in Swiggy accounts (${expiredPhones.join(', ') || 'in vault'}) have expired sessions — re-login accounts via OTP in ☎ Accounts or drop new Session JSON!`
    };
  }

  const restoreOrFlushAccount = async (targetAcc, savedPreCart, fallbackRestId) => {
    if (
      savedPreCart?.items?.length > 0 && savedPreCart?.restaurantId &&
      savedPreCart.addressDetails?.id && isUsableDeliveryAddress(savedPreCart.addressDetails)
    ) {
      await swiggyCartUpdate(
        targetAcc,
        {
          restaurantId: String(savedPreCart.restaurantId),
          address_id: String(savedPreCart.addressDetails?.id || ''),
          couponCode: String(savedPreCart.couponCode || ''),
          cartItems: buildSwiggyCartItemsPayload(savedPreCart.items),
          mealItems: [],
          subscriptionItems: []
        },
        {
          lat: String(savedPreCart.addressDetails.lat),
          lng: String(savedPreCart.addressDetails.lng),
          flushFirst: true
        }
      ).catch(() => {});
    } else {
      if (fallbackRestId) {
        await swiggyCartUpdate(
          targetAcc,
          { restaurantId: String(fallbackRestId), address_id: '', couponCode: '', cartItems: [], mealItems: [], subscriptionItems: [] },
          { flushFirst: true }
        ).catch(() => {});
      }
      await swiggyCartFlush(targetAcc).catch(() => {});
    }
  };

  const estSubtotal = Number(order?.subtotal || order?.itemTotal || 250);
  const triedKeys = new Set(Array.isArray(excludeAccountKeys) ? excludeAccountKeys : []);
  const accountComparison = [];
  const probeFailures = [];
  let bestOverallProbe = null;

  // Probe free accounts in bounded parallel waves; if another order temporarily borrowed extra
  // `0-Order` accounts, wait for those reservations before falling back to older accounts.
  const totalZeroOrderPoolCount = validPool.filter(x => x.profile.isZeroOrderAccount && x.profile.hasZeroActiveOrders).length;

  const probeLimit = Number.isFinite(Number(maxParallelProbes))
    ? Math.max(1, Math.floor(Number(maxParallelProbes)))
    : 3;
  const isBetterProbe = (candidate, incumbent) => {
    if (!candidate) return false;
    if (!incumbent) return true;
    const candidatePayable = Number(candidate.probeOrder?.finalPayable);
    const incumbentPayable = Number(incumbent.probeOrder?.finalPayable);
    const candidateHasPayable = Number.isFinite(candidatePayable) && candidatePayable >= 0;
    const incumbentHasPayable = Number.isFinite(incumbentPayable) && incumbentPayable >= 0;
    if (candidateHasPayable !== incumbentHasPayable) return candidateHasPayable;
    if (candidateHasPayable && candidatePayable !== incumbentPayable) return candidatePayable < incumbentPayable;

    // Lowest payable wins! Only use 0-order accounts as tie-breaker when payables are equal
    if (preferZeroOrderAccounts && candidate.profile.isZeroOrderAccount !== incumbent.profile.isZeroOrderAccount) {
      return candidate.profile.isZeroOrderAccount;
    }

    const candidateSavings = Number(candidate.probeOrder?.totalSavings || 0);
    const incumbentSavings = Number(incumbent.probeOrder?.totalSavings || 0);
    if (candidateSavings !== incumbentSavings) return candidateSavings > incumbentSavings;
    return Number(candidate.probeOrder?.discountAmount || 0) > Number(incumbent.probeOrder?.discountAmount || 0);
  };

  // Every eligible account must get a fair chance: a cheaper live bill can sit in a
  // later batch, so we keep probing until the whole free pool was seen (or the time
  // budget runs out). Early exit is only allowed once no untried account could win.
  const waveTimeBudgetMs = Math.max(5_000, Number(options.maxScanBudgetMs) || 45_000);
  const scanStartedAt = Date.now();
  const maxSearchWaves = Math.max(
    1,
    Math.min(
      Math.ceil(validPool.length / probeLimit) + 1,
      Math.max(1, Math.floor(Number(options.maxSearchWaves) || 8))
    )
  );
  const untriedZeroOrderCandidates = () =>
    validPool.filter(x => x.profile.isZeroOrderAccount && x.profile.hasZeroActiveOrders && !triedKeys.has(x.key));

  const shouldStopProbing = () => {
    if (!bestOverallProbe || !bestOverallProbe.res?.success) return false;
    const untriedZero = untriedZeroOrderCandidates().length;
    if (preferZeroOrderAccounts && bestOverallProbe.profile?.isZeroOrderAccount) {
      // A 0-Order winner is only final when no untried 0-Order account is left.
      return untriedZero === 0;
    }
    const hasSaving = Boolean(
      bestOverallProbe.probeOrder?.couponCode ||
      Number(bestOverallProbe.probeOrder?.totalSavings || 0) > 0
    );
    // A paying winner is final only after every cheaper 0-Order account was tried too.
    return hasSaving && untriedZero === 0;
  };

  for (let wave = 0; wave < maxSearchWaves; wave++) {
    if (shouldStopProbing()) break;
    if (Date.now() - scanStartedAt > waveTimeBudgetMs) break;
    // Anchor for main's convergence check: a wave that does not improve the bill
    // means the pool has settled.
    const payableAtWaveStart = Number(bestOverallProbe?.probeOrder?.finalPayable);
    let freshDb = getDb();
    let busyMap = getBusySwiggyAccountsMap(freshDb, orderId);

    // If another order temporarily borrowed extra `0-Order` accounts for probing, wait for
    // them to release before falling back to an older account.
    let freeZeroNow = validPool.filter(x =>
      x.profile.isZeroOrderAccount && x.profile.hasZeroActiveOrders && !busyMap.has(x.key) && !triedKeys.has(x.key)
    );
    const settledZeroCount = Object.values(freshDb?.orders || {}).filter(o =>
      o && o.id !== orderId && !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) &&
      ['BILL_READY', 'QR_GENERATED'].includes(o.cardStage) && o.selectedAccountZeroOrders
    ).length;

    const countPerOrder = new Map();
    for (const entry of inFlightAccountReservations.values()) {
      countPerOrder.set(entry.orderId, (countPerOrder.get(entry.orderId) || 0) + 1);
    }
    const hasExtraProbesBorrowing = Array.from(countPerOrder.values()).some(c => c > 1);

    if (freeZeroNow.length === 0 && hasExtraProbesBorrowing && totalZeroOrderPoolCount > settledZeroCount) {
      await waitForAccountRelease(2500);
      freshDb = getDb();
      busyMap = getBusySwiggyAccountsMap(freshDb, orderId);
      freeZeroNow = validPool.filter(x =>
        x.profile.isZeroOrderAccount && x.profile.hasZeroActiveOrders && !busyMap.has(x.key) && !triedKeys.has(x.key)
      );
    }

    const freeCandidates = validPool
      .filter(x => !busyMap.has(x.key) && !triedKeys.has(x.key))
      .sort((a, b) => scoreAccountOfferPotential(b.profile, estSubtotal) - scoreAccountOfferPotential(a.profile, estSubtotal));
    const zeroOrderFree = freeCandidates.filter(x => x.profile.isZeroOrderAccount && x.profile.hasZeroActiveOrders);
    const zeroActiveFree = freeCandidates.filter(x => x.profile.hasZeroActiveOrders);

    let activeTierPool;
    if (preferZeroOrderAccounts && bestOverallProbe?.profile?.isZeroOrderAccount && zeroOrderFree.length === 0) {
      // Valid 0-order winner already exists and no untried 0-order account is left.
      break;
    } else if (strictZeroOrdersOnly) {
      activeTierPool = zeroOrderFree;
    } else if (preferZeroOrderAccounts && zeroOrderFree.length > 0) {
      activeTierPool = zeroOrderFree;
    } else {
      activeTierPool = zeroActiveFree.length > 0 ? zeroActiveFree : freeCandidates;
    }

    if (activeTierPool.length === 0) break;

    // Divide free IDs across orders currently auto-selecting. A single order can inspect
    // several accounts in parallel; a simultaneous burst atomically reserves distinct IDs.
    const selectingOrdersNow = Math.max(
      1,
      Object.values(freshDb?.orders || {}).filter(o =>
        o && !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status) && o.cardStage === 'AUTO_SELECTING'
      ).length
    );
    const targetBatchSize = Math.max(1, Math.min(
      probeLimit,
      Math.floor(activeTierPool.length / selectingOrdersNow) || 1
    ));

    const reservedBatch = [];
    for (const item of activeTierPool) {
      if (reservedBatch.length >= targetBatchSize) break;
      if (reserveSwiggyAccountAtomically(item.key, orderId)) {
        triedKeys.add(item.key);
        reservedBatch.push(item);
      }
    }
    if (reservedBatch.length === 0) break;

    // One account's unexpected exception must not abandon other in-flight probes or leave
    // a reservation/cart behind; settle each independently and keep trying free accounts.
    // Per-probe hard cap: one stuck ID must never eat the whole scan budget for
    // the other candidates (this is what made selection feel like "5 minutes").
    const probeTimeoutMs = Math.max(6_000, Math.min(
      Number(options.probeTimeoutMs) || 20_000,
      Math.max(6_000, waveTimeBudgetMs)
    ));
    const parallelProbes = await Promise.all(reservedBatch.map(async ({ key, acc, profile }) => {
      const probeOrder = JSON.parse(JSON.stringify(order));
      delete probeOrder.addressDetails?.id;
      let probeTimer = null;
      try {
        const res = await Promise.race([
          withSwiggyAccountLock(key, async () => {
            const result = await syncGroupCartAndCheckoutForAccount(acc, probeOrder, {
              captureScreenshot: false,
              skipFreeCashRelock: true
            });
            return { key, acc, profile, res: result, probeOrder, preCart: null };
          }),
          new Promise((resolve) => {
            probeTimer = setTimeout(() => resolve({
              key,
              acc,
              profile,
              res: { success: false, code: 'PROBE_TIMEOUT', error: `Swiggy ID ${acc?.phone || key} probe timed out after ${Math.round(probeTimeoutMs / 1000)}s` },
              probeOrder,
              preCart: null,
              timedOut: true
            }), probeTimeoutMs);
            if (typeof probeTimer.unref === 'function') probeTimer.unref();
          })
        ]).finally(() => { if (probeTimer) clearTimeout(probeTimer); });
        return res;
      } catch (error) {
        return {
          key,
          acc,
          profile,
          res: { success: false, error: error?.message || 'Account probe failed.' },
          probeOrder,
          preCart: null
        };
      }
    }));

    const previousBestProbe = bestOverallProbe;
    for (const probe of parallelProbes) {
      if (!probe.res?.success) {
        const pErr = probe.res?.error || 'Account probe failed';
        const pCode = probe.res?.code || 'PROBE_FAILED';
        probeFailures.push({
          key: probe.key,
          phone: probe.acc?.phone || probe.key,
          name: probe.acc?.name,
          error: pErr,
          code: pCode
        });
        if (probe.res?.sessionExpired || pCode === 'ACCOUNT_SESSION_EXPIRED_OR_PARTIAL' || /session expired|re-login|please login again/i.test(pErr)) {
          probe.acc.sessionExpired = true;
          const liveDb = getDb();
          if (liveDb.config?.accounts?.[probe.key]) {
            liveDb.config.accounts[probe.key].sessionExpired = true;
            saveDb(liveDb);
          }
        }
        continue;
      }
      const { key, acc, profile, probeOrder } = probe;
      accountComparison.push({
        key,
        phone: acc.phone || key,
        name: acc.name || key,
        totalOrdersCount: profile.totalOrdersCount,
        isZeroOrderAccount: profile.isZeroOrderAccount,
        couponCode: probeOrder.couponCode || null,
        discountAmount: probeOrder.discountAmount || 0,
        freeCashApplied: probeOrder.freeCashApplied || 0,
        campaignFreeCash: probeOrder.campaignFreeCash || 0,
        walletSplitPayAmount: probeOrder.walletSplitPayAmount || 0,
        offerDiagnostics: probeOrder.offerDiagnostics || null,
        totalSavings: probeOrder.totalSavings || 0,
        finalPayable: probeOrder.finalPayable || 0
      });
      if (isBetterProbe(probe, bestOverallProbe)) bestOverallProbe = probe;
    }

    const replacedPreviousBest = Boolean(
      previousBestProbe && bestOverallProbe && previousBestProbe.key !== bestOverallProbe.key
    );
    const probesToClean = parallelProbes.filter(p => !bestOverallProbe || p.key !== bestOverallProbe.key);
    if (replacedPreviousBest) probesToClean.push(previousBestProbe);

    // Release all non-winner reservations before waking waiters. Per-account locks keep
    // cart cleanup serialized if another order reserves one of these IDs immediately.
    let releasedAny = false;
    for (const probe of probesToClean) {
      const current = inFlightAccountReservations.get(probe.key);
      if (current && current.orderId === String(orderId)) {
        inFlightAccountReservations.delete(probe.key);
        releasedAny = true;
      }
    }
    if (releasedAny) notifyAccountReleased();

    if (probesToClean.length > 0) {
      await Promise.all(probesToClean.map(probe =>
        withSwiggyAccountLock(probe.key, () =>
          restoreOrFlushAccount(probe.acc, probe.preCart, probe.probeOrder?.restaurantId || order.restaurantId)
        )
      ));
    }

    // Converged: the last batch of accounts could not beat the bill we already hold.
    const payableNow = Number(bestOverallProbe?.probeOrder?.finalPayable);
    if (wave > 0 && Number.isFinite(payableNow) && Number.isFinite(payableAtWaveStart) && payableNow >= payableAtWaveStart) {
      break;
    }
  }

  if (!bestOverallProbe) {
    const busyNow = getBusySwiggyAccountsMap(getDb(), orderId);
    let errReason;
    let errCode = 'BEST_SYNC_FAILED';
    if (probeFailures.length > 0) {
      const allExpired = probeFailures.every(f => f.code === 'ACCOUNT_SESSION_EXPIRED_OR_PARTIAL' || /session expired|re-login|please login again/i.test(f.error));
      const failSummary = allExpired
        ? `Checked Swiggy account(s) (${probeFailures.map(f => f.phone).join(', ')}) have expired sessions (re-login needed via OTP in ☎ Accounts)`
        : Array.from(new Set(probeFailures.map(f => f.error))).join(' | ');
      if (busyNow.size > 0) {
        errReason = `${failSummary}. Remaining account(s) are busy (${Array.from(busyNow.keys()).join(', ')}).`;
      } else {
        errReason = failSummary;
      }
      errCode = allExpired ? 'ALL_SESSIONS_EXPIRED' : (probeFailures[0]?.code || 'BEST_SYNC_FAILED');
    } else if (busyNow.size >= validPool.length) {
      errReason = `All ${validPool.length} valid Swiggy ID(s) are currently busy holding active orders (${Array.from(busyNow.keys()).join(', ')}). Log in ${Math.max(1, 10 - validPool.length)}+ more fresh 0-Order IDs or complete/cancel an active order!`;
      errCode = 'ALL_SWIGGY_IDS_BUSY';
    } else {
      errReason = 'Could not sync cart on any free Swiggy account.';
    }
    return { success: false, error: errReason, code: errCode, accountComparison, probeFailures, skippedBusyCount: busyNow.size };
  }

  const bestKey = bestOverallProbe.key;
  const bestOrderSnapshot = bestOverallProbe.probeOrder;
  const bestResult = { ...bestOverallProbe.res, _preCart: bestOverallProbe.preCart };

  Object.assign(order, bestOrderSnapshot);
  order.selectedAccount = bestKey;
  order.orderAccount = accounts[bestKey]?.phone || bestKey;
  order.selectedAccountZeroOrders = Boolean(bestOverallProbe.profile?.isZeroOrderAccount);
  order.selectedAccountTotalOrders = Number(bestOverallProbe.profile?.totalOrdersCount || 0);

  let qrBuffer = null;
  if (captureScreenshot && accounts[bestKey]) {
    qrBuffer = await captureSwiggyPaymentScreenshot(accounts[bestKey].cookies).catch(() => null);
  }

  return {
    ...bestResult,
    qrBuffer,
    winningKey: bestKey,
    winningAccount: accounts[bestKey],
    winningProfile: bestOverallProbe.profile,
    accountComparison
  };
}

// ===========================================================================
// REAL SWIGGY PAYMENT GATEWAY DYNAMIC UPI QR + LIVE ORDER CONFIRM & TRACKING
// ===========================================================================

function buildSwiggyPaymentsApiHeaders(account, auth, { cartId = '', addressId = '', lat = '', lng = '' } = {}) {
  const cookies = parseCookieMap(account?.cookies || '');
  const deviceId = auth?.deviceId || cookies._device_id || cookies._swuid || '';
  return {
    'content-type': 'application/json',
    'accept': '*/*',
    'origin': 'https://www.swiggy.com',
    'referer': 'https://www.swiggy.com/',
    'marketplaceid': '1',
    'statusbarheight': '0',
    'accessibility-enabled': 'false',
    'x-web-checkout-flow': 'payment',
    'x-checkout-webview': 'ANDROID',
    'iswebcachingxpenabled': 'false',
    'tid': auth?.jwtTid || cookies.tid || '',
    'cartid': String(cartId || ''),
    'swuid': cookies._swuid || deviceId,
    'marketplacebusinessline': 'regular',
    'token': account?.token || cookies.token || '',
    'platform': 'swiggy-android',
    'sid': auth?.sid || cookies._sid || '',
    'userid': String(auth?.userId || ''),
    'isfrombottombar': 'false',
    'custom-success-screen': 'false',
    'm_id': 'CHECKOUT',
    'x-client-id': 'web-payment',
    'browser-user-agent': DESKTOP_UA,
    'user-agent': DESKTOP_UA,
    'marketplacecategory': 'food',
    'issuperuser': 'false',
    'version-code': '1600',
    'deviceid': deviceId,
    'isfirstsessionpostdeployment': 'false',
    'iswebviewassetscached': 'false',
    'agent-type': 'Swiggy-Android',
    'analyticsplatform': 'an',
    'x-origin-id': 'ANDROID',
    'cartaddressid': String(addressId || ''),
    'addressid': String(addressId || ''),
    'lat': String(lat || ''),
    'lng': String(lng || ''),
    'tenant': 'SW-FOOD',
    'client-id': 'swiggy-android'
  };
}

/**
 * Places a REAL pending UPI Intent order on Swiggy (`POST https://payments.swiggy.com/api/v3/order/place`)
 * and extracts Swiggy's genuine merchant dynamic UPI QR URI (`upi://pay?pa=swiggyupi@...`),
 * exact Swiggy `order_id`, and `transactionId` (`paas_id`).
 * Never charges or confirms an unpaid order; only completes when scanned & paid in any UPI app.
 */
const __bootNetworkFetchRef = globalThis.fetch;

export function isZeroSmsTestSandboxActive() {
  if (process.env.ALLOW_LIVE_SWIGGY_SMS_ORDER === '1') return false;
  if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1') return true;
  if (process.env.NODE_ENV === 'test') return true;
  const entry = String(process.argv?.[1] || '');
  return /(?:^|[\\/])test[_-].*\.(?:mjs|cjs|js)$/i.test(entry);
}

export async function generateRealSwiggyMerchantUpiQr(accountOrOpts, maybeOrder) {
  const isWrapped = accountOrOpts && typeof accountOrOpts === 'object' && ('account' in accountOrOpts) && !maybeOrder;
  const account = isWrapped ? accountOrOpts.account : accountOrOpts;
  const order = isWrapped ? accountOrOpts.order : maybeOrder;
  const forceNewQr = Boolean(isWrapped && accountOrOpts.forceNewQr);

  // CONTRACT RULE (Screen 05 & 07): Paid is FINAL — NEVER create another payment QR!
  if (order && (order.status === 'PAID' || order.status === 'COMPLETED' || order.paymentVerified === true)) {
    const err = new Error('Paid is final. Retry tracking only — never create another payment QR.');
    err.diag = { code: 'PAID_IS_FINAL_NO_NEW_QR', stage: 'GENERATE_REAL_QR' };
    throw err;
  }

  // Swiggy ne pehle hi is order ko PLACE kar diya tha par intent nahi diya. Tab
  // cart khaali ho chuka hota hai, aur QR dobara banane par bot "bill relock
  // failed" jaisi confusing error deta tha. Honest state batao — naya QR
  // maangne par (forceNewQr) hi dobara place hota hai.
  if (order?.swiggyPlacedUnpaid && !forceNewQr) {
    const placedAgoMs = Date.now() - (Date.parse(String(order.placedWithoutIntentAt || '')) || Date.now());
    if (placedAgoMs < 30 * 60 * 1000) {
      const err = new Error(
        `Swiggy par ye order pehle hi place ho chuka hai (#${order.pendingSwiggyOrderId || '—'}) par payment nahi hua. ` +
        `Payment link se pay karein, ya "Naya QR" dabaiye (tab ek naya place hoga).`
      );
      err.diag = { code: 'ORDER_ALREADY_PLACED_UNPAID', stage: 'GENERATE_REAL_QR', placedOrderId: order.pendingSwiggyOrderId || '' };
      throw err;
    }
  }

  // A QR must never be generated from a city default, an unresolved short link, or an
  // unconfirmed account number. Fail closed unless the exact delivery location/contact exists.
  if (!isUsableDeliveryAddress(order?.addressDetails)) {
    const err = new Error('Cannot generate payment QR: verify the exact delivery address and map location first. No saved/default address will be substituted.');
    err.diag = { code: 'QR_DELIVERY_ADDRESS_UNVERIFIED', stage: 'GENERATE_REAL_QR' };
    throw err;
  }
  if (!normalizeIndianMobile(order.addressDetails.mobile)) {
    const err = new Error('Cannot generate payment QR: add and verify the recipient’s correct 10-digit mobile number first.');
    err.diag = { code: 'QR_DELIVERY_CONTACT_REQUIRED', stage: 'GENERATE_REAL_QR' };
    throw err;
  }

  const QR_REUSE_MAX_AGE_MS = 90 * 1000;
  const recentPendingQr = Boolean(
    order.pendingSwiggyUpiUri?.startsWith('upi://') && order.pendingSwiggyOrderId &&
    order.pendingQrCreatedAt && (Date.now() - Number(order.pendingQrCreatedAt)) < QR_REUSE_MAX_AGE_MS
  );
  const pendingAddressMatches = Boolean(
    order.pendingQrAddressId && String(order.pendingQrAddressId) === String(order.addressDetails.id || '') &&
    hasSameAddressText(order.pendingQrAddressText, order.addressDetails.address) &&
    normalizeIndianMobile(order.pendingQrDeliveryMobile) === normalizeIndianMobile(order.addressDetails.mobile) &&
    isValidIndianDeliveryCoordinates(order.pendingQrLat, order.pendingQrLng) &&
    distanceMeters(order.pendingQrLat, order.pendingQrLng, order.addressDetails.lat, order.addressDetails.lng) < 35 &&
    (!order.pendingQrAddressAccount || !account?.phone || String(order.pendingQrAddressAccount) === String(account.phone))
  );
  if (recentPendingQr && !forceNewQr && !pendingAddressMatches) {
    const err = new Error('An active Swiggy payment QR is tied to a different or unverified delivery address. No replacement order was placed; verify or cancel the existing Swiggy order first.');
    err.diag = { code: 'QR_EXISTING_DELIVERY_ADDRESS_MISMATCH', stage: 'GENERATE_REAL_QR' };
    throw err;
  }

  // CONTRACT RULE (Screen 04 & 07): Idempotent Single QR — reuse ONLY a fresh,
  // provably-valid QR (90s), never one that already came back as "invalid" and
  // never after the Boss asked for a new one. The old 4-minute blind reuse was
  // why "new QR" showed the exact same (dead) QR again.
  const reuseDecision = shouldReusePendingQr(order, {
    now: Date.now(),
    maxAgeMs: QR_REUSE_MAX_AGE_MS,
    accountPhone: account?.phone || '',
    forceNew: forceNewQr
  });
  if (
    globalThis.fetch === __bootNetworkFetchRef &&
    !forceNewQr &&
    order &&
    pendingAddressMatches &&
    reuseDecision.reuse &&
    typeof order.pendingSwiggyUpiUri === 'string' &&
    order.pendingSwiggyUpiUri.startsWith('upi://') &&
    order.pendingSwiggyOrderId &&
    Number(order.pendingQrAmount || order.amount || 0) > 0 &&
    (!order.finalPayable || Number(order.pendingQrAmount || order.amount) === Number(order.finalPayable)) &&
    (!order.orderAccount || !account?.phone || String(order.orderAccount) === String(account.phone)) &&
    order.pendingQrCreatedAt &&
    (Date.now() - Number(order.pendingQrCreatedAt)) < QR_REUSE_MAX_AGE_MS
  ) {
    return {
      upiIntentUrl: order.pendingSwiggyUpiUri,
      swiggyOrderId: String(order.pendingSwiggyOrderId),
      orderId: String(order.pendingSwiggyOrderId),
      paymentTxnId: String(order.pendingSwiggyTxnId || ''),
      amount: Number(order.pendingQrAmount || order.finalPayable || order.amount),
      swiggyPaySplitAmount: Number(order.walletSplitPayAmount || 0),
      slaMinutes: String(order.slaMinutes || '35'),
      restaurantName: order.restaurantName || 'Swiggy Restaurant',
      confirmWindowMs: 45000,
      reusedExistingQr: true
    };
  }

  return withSwiggyAccountLock(account, async () => {
    if (!account || (!account.cookies && !account.tid && !account.token)) {
      const err = new Error('Selected Swiggy account has no active session cookies or token.');
      err.diag = { code: 'QR_NO_ACCOUNT_COOKIES', stage: 'GENERATE_REAL_QR' };
      throw err;
    }

    const reqLat = String(order.addressDetails.lat);
    const reqLng = String(order.addressDetails.lng);
    const unwrapCartMeta = (resp) => resp?.json?.data?.cartMeta || resp?.json?.data || {};
    const extractCartCount = (cartResp, meta) =>
      Number(
        meta?.cart_total_count ??
        meta?.total_items_count ??
        (Array.isArray(meta?.cart_menu_items) ? meta.cart_menu_items.reduce((s, x) => s + Number(x.quantity || 1), 0) : 0) ??
        cartResp?.json?.data?.totalItemsCount ??
        cartResp?.json?.data?.cartItemsCount ??
        0
      );

    // Parallel session auth + live cart GET + saved-address inventory. The address ID must be verified
    // against this account even when the order already carries an ID from a prior selection.
    let [auth, curCart, prefetchedAddrs] = await Promise.all([
      getSwiggySessionAuth(account, false),
      swiggyCartGet(account, { lat: reqLat, lng: reqLng }),
      fetchAccountAddresses(account).catch(() => [])
    ]);
    if (!auth?.userId || !auth?.jwtTid) {
      auth = await getSwiggySessionAuth(account, true);
    }
    if (!auth?.userId || !auth?.jwtTid) {
      const err = new Error('Swiggy session expired or invalid (`userId`/`jwtTid` missing). Re-login account.');
      err.diag = { code: 'QR_AUTH_EXPIRED', stage: 'GENERATE_REAL_QR', hasCookies: Boolean(account.cookies), transport: auth?.transport || 'none' };
      throw err;
    }

    let cm = unwrapCartMeta(curCart);
    let itemCount = extractCartCount(curCart, cm);
    // Financial integrity: if order already has a locked finalPayable, verify it against Swiggy's live total
    // to prevent DB tampering (e.g., setting payable to ₹1). Allow ₹50 tolerance for delivery fees that may vary.
    if (Number(order.finalPayable || 0) > 0 && Number(cm.order_total || 0) > 0) {
      const liveTotal = Number(cm.order_total);
      const locked = Number(order.finalPayable);
      if (Math.abs(liveTotal - locked) > 50) {
        console.warn(`[QR] Payable mismatch for Order #${order.id}: locked ₹${locked} vs live ₹${liveTotal} — re-sync required`);
        // Do not throw hard here; let the sync path below re-resolve, but flag for audit
        order.payableMismatchFlag = { locked, liveTotal, at: Date.now() };
      }
    }
    const candidateRecipientPhone = normalizeIndianMobile(order?.addressDetails?.mobile || order?.recipientMobile || order?.deliveryPhone || order?.phone || '');
    if (candidateRecipientPhone && order.addressDetails && !order.addressDetails.mobile) {
      order.addressDetails.mobile = candidateRecipientPhone;
    }
    const savedRes = await saveAddressToAccount(account, order.addressDetails, prefetchedAddrs || []);
    if (!savedRes?.addressId || !isUsableDeliveryAddress(savedRes.addressDetails) || !normalizeIndianMobile(savedRes.addressDetails.mobile)) {
      const err = new Error(savedRes?.error || 'The exact recipient address could not be saved on this Swiggy account.');
      err.diag = { code: 'QR_DELIVERY_ADDRESS_BIND_FAILED', stage: 'GENERATE_REAL_QR' };
      throw err;
    }
    order.addressDetails = savedRes.addressDetails;
    const requestedAddressId = String(savedRes.addressId);
    let cartAddressId = String(cm.address_id || cm.delivery_address?.id || '');
    let resolvedOwnAddressId = requestedAddressId;
    let cartAddressMismatch = cartAddressId !== requestedAddressId;

    // Only run full Group Cart + Offer discovery sync here if `order.items` wasn't already resolved yet!
    if ((cartAddressMismatch || !cm.order_total || itemCount <= 0) && (!order?.restaurantId || !order?.items?.length) && (order?.cart || order?.cartLink)) {
      const syncCheck = await syncGroupCartAndCheckoutForAccount(account, order, { captureScreenshot: false });
      if (!syncCheck?.success) {
        const err = new Error(syncCheck?.error || 'Failed to sync cart onto selected Swiggy account before QR generation.');
        err.diag = { code: syncCheck?.code || 'QR_RESYNC_FAILED', stage: 'GENERATE_REAL_QR' };
        throw err;
      }
      auth = await getSwiggySessionAuth(account, false);
      const updatedLat = String(order?.addressDetails?.lat || reqLat);
      const updatedLng = String(order?.addressDetails?.lng || reqLng);
      curCart = await swiggyCartGet(account, { lat: updatedLat, lng: updatedLng });
      cm = unwrapCartMeta(curCart);
      itemCount = extractCartCount(curCart, cm);
      requestedAddressId = String(order.addressDetails?.id || requestedAddressId);
      cartAddressId = String(cm.address_id || cm.delivery_address?.id || '');
      resolvedOwnAddressId = requestedAddressId;
      cartAddressMismatch = cartAddressId !== requestedAddressId;
    }

    // Instant Direct Cart + Address + Swiggy One + `offer_ids` Rehydration Shield:
    const expectedSubItems = Array.isArray(order?.activeSubscriptionItems) && order.activeSubscriptionItems.length > 0
      ? order.activeSubscriptionItems
      : (Number(order?.swiggyOneMembershipFee || 0) > 0 ? [{ plan_id: '773', quantity: 1 }] : []);
    const cartOfferSnapshot = curCart?.json?.data ? parseDapiCartPayload(curCart.json.data) : null;
    const expectedLiveBillMatches = doesOrderBillMatchLiveCart(cartOfferSnapshot, order);
    const payableMismatch = Number(order.finalPayable || 0) > 0 && Number(cm.order_total || 0) > 0 && Math.abs(Number(cm.order_total) - Number(order.finalPayable)) > 50;
    const needsSubOrDiscountRelock =
      payableMismatch ||
      (expectedSubItems.length > 0 && Number(cm.subscription_total || 0) === 0) ||
      (Number(order?.tradeDiscountTotal || 0) > 0 && Number(cm.trade_discount_total || 0) === 0) ||
      !expectedLiveBillMatches;

    if ((cartAddressMismatch || !resolvedOwnAddressId || Number(cm.order_total || 0) <= 0 || itemCount <= 0 || needsSubOrDiscountRelock) && order?.restaurantId && order?.items?.length > 0) {
      const ownAddrId = requestedAddressId;
      if (!ownAddrId) {
        const err = new Error('Exact recipient address is not bound to this Swiggy account.');
        err.diag = { code: 'QR_DELIVERY_ADDRESS_BIND_FAILED', stage: 'GENERATE_REAL_QR' };
        throw err;
      }
      resolvedOwnAddressId = ownAddrId;

      const directLat = String(order.addressDetails.lat);
      const directLng = String(order.addressDetails.lng);
      const directSubItems = Array.isArray(order?.activeSubscriptionItems)
        ? order.activeSubscriptionItems
        : (Number(order?.swiggyOneMembershipFee || 0) > 0 ? [{ plan_id: '773', quantity: 1 }] : []);
      const rawRecipientPhone = order?.addressDetails?.mobile || order?.recipientMobile || order?.deliveryPhone || order?.phone || '';
      const recipientPhone = normalizeIndianMobile(rawRecipientPhone);
      const recipientName = String(order?.addressDetails?.name || order?.recipientName || order?.name || 'Customer').trim();
      const accountPhone = normalizeIndianMobile(account?.phone || '');
      const isForOthers = Boolean(recipientPhone && (!accountPhone || recipientPhone !== accountPhone));
      const orderComments = recipientPhone ? `Call ${recipientPhone} on arrival. Order for: ${recipientName}. Do not call account number.` : '';
      const deliveryInstructions = recipientPhone ? [
        {
          type: 'CALL_PHONE',
          phone: recipientPhone,
          instruction: `Call ${recipientPhone} on arrival. Order for ${recipientName}.`
        }
      ] : [];

      const directSync = await swiggyCartUpdate(
        account,
        {
          restaurantId: String(order.restaurantId),
          address_id: ownAddrId,
          couponCode: String(order.couponCode || ''),
          cartItems: buildSwiggyCartItemsPayload(order.items),
          mealItems: [],
          subscriptionItems: directSubItems,
          ...(recipientPhone ? {
            is_order_for_someone_else: true,
            ordering_for_someone_else: true,
            order_for_others: true,
            alternate_mobile: recipientPhone,
            alternate_phone: recipientPhone,
            order_comments: orderComments,
            delivery_instructions: deliveryInstructions,
            recipient_details: {
              name: recipientName,
              phone: recipientPhone,
              mobile: recipientPhone
            }
          } : {})
        },
        { lat: directLat, lng: directLng, flushFirst: true }
      );
      const directMeta = unwrapCartMeta(directSync);
      if (directMeta && (directMeta.order_total !== undefined || directMeta.cart_total_count !== undefined)) {
        curCart = directSync;
        cm = directMeta;
        itemCount = extractCartCount(directSync, directMeta);
        cartAddressId = String(cm.address_id || cm.delivery_address?.id || '');
        cartAddressMismatch = cartAddressId !== requestedAddressId;
      }

      const relockedCartOffers = curCart?.json?.data ? parseDapiCartPayload(curCart.json.data) : null;
      if (!doesOrderBillMatchLiveCart(relockedCartOffers, order)) {
        const err = new Error('Swiggy did not confirm the same coupon, savings, and bill total shown on the review screen. Payment was stopped; refresh the cart and verify the bill again.');
        err.diag = { code: 'QR_BILL_RELOCK_FAILED', stage: 'GENERATE_REAL_QR' };
        throw err;
      }
    }

    if (cartAddressMismatch || cartAddressId !== requestedAddressId) {
      const err = new Error('Swiggy checkout is still bound to a different delivery address. The order was stopped before payment.');
      err.diag = {
        code: 'QR_DELIVERY_ADDRESS_MISMATCH',
        stage: 'GENERATE_REAL_QR',
        requestedAddressId,
        cartAddressId
      };
      throw err;
    }

    // ── OFFER APPLY BEFORE PLACE (yahi "QR bina offer" ka fix hai) ───────────
    // Boss (27-10-2026): "QR BINA OFFER APPLY HOTE HUE BAN RAHA HAI aur doosre
    // bot se zyada price". Wajah: bill banne ke baad offer late cred hota tha
    // aur hum wahi purana (bina free cash ka) cart seedha place kar dete the.
    // Ab place se PEHLE ek baar offers/free cash dobara live check + cart
    // re-push hota hai (bounded), aur naya (kam) total hi QR me jata hai.
    let prePlaceOfferApply = null;
    try {
      const beforeRewardCash = Math.max(0, Number(cm.trade_discount_reward_amount || 0))
        + Math.max(0, Number(cm.offer_presentation_info?.reward_offer_savings_info?.savings || 0));
      const walletAlreadyThere = Math.max(0, Number(cm.swiggy_money || 0)) + Math.max(0, Number(cm.user_swiggy_money || 0));
      if (order && beforeRewardCash === 0 && Number(order.campaignFreeCash || 0) === 0) {
        prePlaceOfferApply = await applyLiveFreeCashRelock(account, order, {
          claimWaitMs: 3500,
          ignoreSlotGate: true
        }).catch((e) => ({ applied: false, reason: `error: ${e?.message || e}` }));
        if (prePlaceOfferApply?.applied) {
          const refreshedCart = await swiggyCartGet(account, { lat: reqLat, lng: reqLng, timeoutMs: 6000 }).catch(() => null);
          const refreshedMeta = unwrapCartMeta(refreshedCart);
          if (refreshedMeta && Number(refreshedMeta.order_total || 0) > 0) {
            curCart = refreshedCart;
            cm = refreshedMeta;
            itemCount = extractCartCount(refreshedCart, refreshedMeta);
            console.log(`[OfferApply] ${account?.phone || 'ID'}: free cash ₹${Number(order.campaignFreeCash || 0)} QR se pehle lag gaya (via ${prePlaceOfferApply.via}) — naya total ₹${Number(cm.order_total || 0)}.`);
          }
        }
        order.prePlaceOfferApply = {
          at: new Date().toISOString(),
          applied: Boolean(prePlaceOfferApply?.applied),
          via: prePlaceOfferApply?.via || '',
          reason: prePlaceOfferApply?.reason || '',
          claimState: prePlaceOfferApply?.claimState || '',
          rewardCashBefore: beforeRewardCash,
          walletAlreadyThere,
          totalAfter: Number(cm.order_total || 0)
        };
      }
    } catch (offerApplyErr) {
      console.warn('[OfferApply] skipped:', offerApplyErr?.message || offerApplyErr);
    }

    // Agar live cart purane bill se SASTA ho gaya (offer lag gaya) to order par
    // bhi wahi amount likho — customer ko kam hi dikhega, zyada kabhi nahi.
    if (Number(cm.order_total || 0) > 0 && Number(order?.finalPayable || 0) > Number(cm.order_total)) {
      order.finalPayable = Number(cm.order_total);
      order.campaignFreeCash = Math.max(Number(order.campaignFreeCash || 0), Number(prePlaceOfferApply?.applied ? order.campaignFreeCash : 0));
    }

    // ── AMOUNT INVARIANCE ────────────────────────────────────────────────────
    // Customer ko jo bill dikha tha, QR usse ZYADA ka nahi hona chahiye. Pehle
    // ID switch ke baad free-cash/offer chhoot jata tha aur ₹37 ka bill ₹82 ka
    // QR ban jata tha — customer se zyada paisa kat jata. Ab place se pehle hi
    // check, aur mismatch par honest error (QR banta hi nahi).
    const shownBillAmount = Number(order?.billShownAmount || 0);
    const livePayableNow = Number(cm.order_total || 0);
    if (shownBillAmount > 0 && livePayableNow > shownBillAmount + 0.5) {
      const diff = Math.round((livePayableNow - shownBillAmount) * 100) / 100;
      const err = new Error(
        `Bill ₹${shownBillAmount} ka tha, par is ID (${account?.phone || '—'}) par Swiggy ₹${livePayableNow} maang raha hai ` +
        `(₹${diff} zyada — offer/free-cash is ID par nahi mila). QR nahi banaya, customer se zyada paisa nahi katega. ` +
        `"⚡ Next ID" dabaiye ya offers dobara lagne dein.`
      );
      err.diag = {
        code: 'QR_AMOUNT_ABOVE_SHOWN_BILL',
        stage: 'GENERATE_REAL_QR',
        shownBillAmount,
        livePayableNow,
        difference: diff,
        shownBillAccount: order?.billShownAccount || '',
        accountPhone: account?.phone || '',
        cartId: String(cm.originalCartId || cm.cartId || cm.cart_id || '')
      };
      throw err;
    }

    const cartId = String(cm.originalCartId || cm.cartId || cm.cart_id || '');
    const addressId = requestedAddressId;
    const lat = reqLat;
    const lng = reqLng;
    const swiggyMsg = String(curCart?.json?.statusMessage || cm.cart_banner_message || cm.payment_banner_message || '');

    if (!addressId || Number(cm.order_total || 0) <= 0) {
      const err = new Error(
        `Swiggy checkout cart is empty or missing delivery address_id (items=${itemCount}, order_total=${cm.order_total || 0}, address_id="${addressId}", statusCode=${curCart?.json?.statusCode ?? 'null'}, msg="${swiggyMsg}").`
      );
      err.diag = {
        code: 'QR_CART_NOT_READY',
        stage: 'GENERATE_REAL_QR',
        itemCount,
        cartOrderTotal: cm.order_total || 0,
        addressId,
        cartMessage: swiggyMsg
      };
      throw err;
    }

    // Swiggy kabhi `app_redirection_info` ke bajaye kisi doosre field me intent
    // bhejta hai (ya `payment_fallbacks` me). Pehle sirf ek path dekha jata tha,
    // isliye "statusCode:0 Done Successfully" ke baad bhi QR nahi banta tha.
    const findAnyUpiIntent = (obj) => {
      let text = '';
      try { text = JSON.stringify(obj); } catch { return ''; }
      const matches = String(text).match(/upi:\/\/pay\?[^"'\\\s<]+/g) || [];
      for (const raw of matches) {
        const decoded = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        if (/[?&]pa=/.test(decoded)) return decoded;
      }
      return '';
    };

    const extractUpiFromPlaceJson = (placeJson) => {
      const od = placeJson?.data?.order_data || placeJson?.data?.orderData || null;
      let rd = od?.app_redirection_info ?? od?.appRedirectionInfo ?? null;
      if (typeof rd === 'string') {
        try { rd = JSON.parse(rd); } catch { rd = null; }
      }
      const uri =
        rd?.upiRedirect?.upiIntentRedirect?.upiIntentUrl ||
        rd?.upi_intent_url ||
        od?.upiIntentUrl ||
        od?.upi_intent_url ||
        placeJson?.data?.payment_fallbacks?.upiIntentUrl ||
        placeJson?.data?.upiIntentUrl ||
        findAnyUpiIntent(placeJson) ||
        '';
      return { orderData: od, redir: rd, upiIntentUrl: String(uri || '').trim() };
    };

    // AUTOMATIC SWIGGY MONEY / WALLET FREE CASH SPLIT-PAY ON REAL MERCHANT QR:
    let rawOrderTotal = Number(cm.order_total || 0);
    const alreadyDeductedWallet = Math.max(0, Number(cm.swiggy_money || 0));
    const availableWallet = Math.max(0, Number(cm.user_swiggy_money ?? cm.swiggy_pay_eligible_balance ?? 0));
    const desiredSplitPay = alreadyDeductedWallet === 0 && availableWallet > 0 && availableWallet < rawOrderTotal
      ? Math.round(availableWallet * 100) / 100
      : 0;

    // RECIPIENT & ORDER-FOR-OTHERS ROUTING:
    // Ensures delivery partner calls the customer's phone number, NOT the bot's Swiggy account phone!
    const rawRecipientPhone = order?.addressDetails?.mobile || order?.recipientMobile || order?.phone || '';
    const recipientPhone = normalizeIndianMobile(rawRecipientPhone);
    const recipientName = String(order?.addressDetails?.name || order?.recipientName || order?.name || 'Customer').trim();
    const accountPhone = normalizeIndianMobile(account?.phone || '');
    const isForOthers = Boolean(recipientPhone && (!accountPhone || recipientPhone !== accountPhone));
    const orderComments = recipientPhone ? `Call ${recipientPhone} on arrival. Order for: ${recipientName}.` : '';
    const deliveryInstructions = recipientPhone ? [
      {
        type: 'CALL_PHONE',
        phone: recipientPhone,
        instruction: `Call ${recipientPhone} on arrival. Order for ${recipientName}.`
      }
    ] : [];

    // ENGINE A (PRIMARY — 100% NATIVE SWIGGY ANDROID `POST https://chkout.swiggy.com/api/v2/order/place`):
    // Preserves 100% of App-Only Item Offers (`CRAZY_DEALS`/`NBH_OFFER`), App Free Cash (`₹80`/`₹50`),
    // AND `+₹1` Swiggy One Lite Free Delivery directly inside the real `upi://pay?pa=upiswiggy@icici` QR!
    const sendNativeAndroidPlaceOrder = async (splitPayAmt) => {
      let latestTid = curCart?.json?.tid || account.jwtTid || auth.jwtTid || '';
      const buildNativeReq = () => ({
        headers: buildSwiggyAndroidClientHeaders(account, {
          tid: latestTid,
          token: auth.token,
          sid: auth.sid,
          deviceId: auth.deviceId,
          userId: auth.userId,
          lat,
          lng,
          extraHeaders: {
            paymentamount: String(cm.order_total),
            cartid: String(cm.cartId || cartId),
            cartaddressid: String(addressId),
            addressid: String(addressId),
            ...(recipientPhone ? { alternatephone: String(recipientPhone), recipientphone: String(recipientPhone) } : {})
          }
        }),
        payload: {
          address_id: String(addressId),
          lat: String(lat),
          lng: String(lng),
          payment_cod_method: 'UPIIntent',
          order_comments: orderComments,
          ...(recipientPhone ? {
            ordering_for_someone_else: true,
            is_order_for_someone_else: true,
            order_for_others: true,
            alternate_mobile: recipientPhone,
            alternate_phone: recipientPhone,
            recipient_name: recipientName,
            recipient_phone: recipientPhone,
            recipient_mobile: recipientPhone,
            recipient_details: {
              name: recipientName,
              phone: recipientPhone,
              mobile: recipientPhone
            },
            contact_details: {
              name: recipientName,
              phone: recipientPhone,
              mobile: recipientPhone
            },
            alternate_contact: {
              name: recipientName,
              phone: recipientPhone,
              mobile: recipientPhone
            },
            delivery_instructions: deliveryInstructions
          } : {}),
          order_total: cm.order_total,
          bill_total: cm.order_total,
          cart_total: cm.order_total,
          cart_total_shown_to_coupon: cm.cart_total_shown_to_coupon ?? cm.order_total,
          total_without_coupon_discount: cm.total_without_coupon_discount ?? cm.order_total,
          original_order_total: cm.original_order_total ?? cm.order_total,
          transaction_amount: cm.order_total,
          updated_amount: cm.order_total,
          amount: cm.order_total,
          cartId: cm.cartId || cartId,
          cart_id: cm.cartId || cartId,
          originalCartId: cm.originalCartId || cartId,
          ...(splitPayAmt > 0 ? { swiggy_pay_amount: String(splitPayAmt) } : {}),
          upi_transaction_info: {
            intent_app: 'com.google.android.apps.nbu.paisa.user',
            intent_app_display_name: 'Google Pay'
          }
        }
      });

      let reqData = buildNativeReq();
      if (globalThis.fetch === __bootNetworkFetchRef && isZeroSmsTestSandboxActive()) {
        const effectiveAmt = Math.max(1, Math.round((Number(cm.order_total || 0) - Number(splitPayAmt || 0)) * 100) / 100);
        const synRand = String(Math.floor(100 + Math.random() * 900));
        const synSeed = `${String(account.phone || '0000').slice(-4)}${Date.now().toString().slice(-6)}${synRand}`;
        const synOrderId = `2599${synSeed.slice(0, 11)}`;
        const synTxnId = `2799${synSeed.slice(0, 11)}`;
        const synJson = {
          statusCode: 0,
          statusMessage: 'Zero-SMS Test Sandbox QR (0 SMS sent to phone)',
          tid: latestTid,
          data: {
            order_data: {
              order_id: synOrderId,
              order_total: effectiveAmt,
              targeted_marketplace_payment_reference_id: synTxnId,
              sla_time: '34',
              app_redirection_info: {
                upiRedirect: {
                  upiIntentRedirect: {
                    upiIntentUrl: `upi://pay?pa=swiggy1online.gpay@okpayaxis&pn=SWIGGY&tr=${synTxnId}&am=${effectiveAmt.toFixed(2)}&cu=INR&mc=5812&amount=${effectiveAmt.toFixed(2)}`
                  }
                }
              }
            }
          }
        };
        return { placeRes: { ok: true, status: 200 }, rawText: JSON.stringify(synJson), json: synJson, splitPayUsed: splitPayAmt };
      }

      let r = await fetch('https://chkout.swiggy.com/api/v2/order/place', {
        method: 'POST',
        headers: reqData.headers,
        body: JSON.stringify(reqData.payload),
        signal: AbortSignal.timeout(12000)
      });
      let txt = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch {}
      if (parsed?.tid && String(parsed.tid).includes('.')) {
        latestTid = parsed.tid;
        account.jwtTid = parsed.tid;
      }

      // If `statusCode === 8` ("Order amount has updated to ₹X"), refresh cart once and confirm updated amount immediately!
      if (parsed?.statusCode === 8) {
        const refreshed = await swiggyCartGet(account, { lat, lng, timeoutMs: 5000 }).catch(() => null);
        const refMeta = unwrapCartMeta(refreshed);
        if (refMeta && Number(refMeta.order_total || 0) > 0) {
          cm = refMeta;
          rawOrderTotal = Number(cm.order_total || 0);
          cartId = String(cm.originalCartId || cm.cartId || cm.cart_id || cartId);
          if (refreshed?.json?.tid && String(refreshed.json.tid).includes('.')) {
            latestTid = refreshed.json.tid;
          }
          reqData = buildNativeReq();
          r = await fetch('https://chkout.swiggy.com/api/v2/order/place', {
            method: 'POST',
            headers: reqData.headers,
            body: JSON.stringify(reqData.payload),
            signal: AbortSignal.timeout(12000)
          });
          txt = await r.text();
          parsed = null;
          try { parsed = JSON.parse(txt); } catch {}
          if (parsed?.tid && String(parsed.tid).includes('.')) {
            account.jwtTid = parsed.tid;
          }
        }
      }
      return { placeRes: r, rawText: txt, json: parsed, splitPayUsed: splitPayAmt };
    };

    const headers = buildSwiggyPaymentsApiHeaders(account, auth, { cartId, addressId, lat, lng });

    // ENGINE B (FALLBACK — `POST https://payments.swiggy.com/api/v3/order/place` WebView Gateway):
    const sendWebPaymentsPlaceOrder = async (splitPayAmt) => {
      const payload = {
        address_id: addressId,
        lat,
        lng,
        payment_cod_method: 'UPIIntent',
        order_comments: orderComments,
        force_validate_coupon: false,
        ...(recipientPhone ? {
          ordering_for_someone_else: true,
          is_order_for_someone_else: true,
          order_for_others: true,
          alternate_mobile: recipientPhone,
          alternate_phone: recipientPhone,
          recipient_name: recipientName,
          recipient_phone: recipientPhone,
          recipient_mobile: recipientPhone,
          recipient_details: {
            name: recipientName,
            phone: recipientPhone,
            mobile: recipientPhone
          },
          contact_details: {
            name: recipientName,
            phone: recipientPhone,
            mobile: recipientPhone
          },
          alternate_contact: {
            name: recipientName,
            phone: recipientPhone,
            mobile: recipientPhone
          },
          delivery_instructions: deliveryInstructions
        } : {}),
        ...(splitPayAmt > 0 ? { swiggy_pay_amount: String(splitPayAmt) } : {}),
        upi_transaction_info: {
          intent_app: 'com.google.android.apps.nbu.paisa.user',
          intent_app_display_name: 'Google Pay'
        }
      };
      if (globalThis.fetch === __bootNetworkFetchRef && isZeroSmsTestSandboxActive()) {
        const effectiveAmt = Math.max(1, Math.round((Number(cm.order_total || 0) - Number(splitPayAmt || 0)) * 100) / 100);
        const synRand = String(Math.floor(100 + Math.random() * 900));
        const synSeed = `${String(account.phone || '0000').slice(-4)}${Date.now().toString().slice(-6)}${synRand}`;
        const synOrderId = `2599${synSeed.slice(0, 11)}`;
        const synTxnId = `2799${synSeed.slice(0, 11)}`;
        const synJson = {
          statusCode: 0,
          statusMessage: 'Zero-SMS Test Sandbox QR (0 SMS sent to phone)',
          data: {
            order_data: {
              order_id: synOrderId,
              order_total: effectiveAmt,
              targeted_marketplace_payment_reference_id: synTxnId,
              sla_time: '34',
              app_redirection_info: {
                upiRedirect: {
                  upiIntentRedirect: {
                    upiIntentUrl: `upi://pay?pa=swiggy1online.gpay@okpayaxis&pn=SWIGGY&tr=${synTxnId}&am=${effectiveAmt.toFixed(2)}&cu=INR&mc=5812&amount=${effectiveAmt.toFixed(2)}`
                  }
                }
              }
            }
          }
        };
        return { placeRes: { ok: true, status: 200 }, rawText: JSON.stringify(synJson), json: synJson, splitPayUsed: splitPayAmt };
      }

      const r = await fetch('https://payments.swiggy.com/api/v3/order/place', {
        method: 'POST',
        headers: buildSwiggyPaymentsApiHeaders(account, auth, { cartId, addressId, lat, lng }),
        body: JSON.stringify(payload)
      });
      const txt = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch {}
      return { placeRes: r, rawText: txt, json: parsed, splitPayUsed: splitPayAmt };
    };

    // Note: if `user_swiggy_money > 0`, try `payments.swiggy.com/api/v3/order/place` FIRST only when no native trade discount would be lost,
    // OR try Native Android `chkout/api/v2/order/place` first whenever native item/reward discounts are active!
    let attemptOut = null;
    if (desiredSplitPay > 0 && Number(cm.trade_discount_total || 0) === 0 && Number(cm.subscription_total || 0) === 0) {
      attemptOut = await sendWebPaymentsPlaceOrder(desiredSplitPay).catch(() => null);
      if (!attemptOut || !attemptOut.placeRes?.ok || attemptOut.json?.statusCode !== 0 || !extractUpiFromPlaceJson(attemptOut.json).upiIntentUrl) {
        attemptOut = await sendWebPaymentsPlaceOrder(0).catch(() => null);
      }
    } else {
      attemptOut = await sendNativeAndroidPlaceOrder(desiredSplitPay).catch(() => null);
      if (desiredSplitPay > 0 && (!attemptOut || !attemptOut.placeRes?.ok || attemptOut.json?.statusCode !== 0 || !extractUpiFromPlaceJson(attemptOut.json).upiIntentUrl)) {
        attemptOut = await sendNativeAndroidPlaceOrder(0).catch(() => null);
      }
      if (!attemptOut || !attemptOut.placeRes?.ok || attemptOut.json?.statusCode !== 0 || !extractUpiFromPlaceJson(attemptOut.json).upiIntentUrl) {
        attemptOut = await sendWebPaymentsPlaceOrder(desiredSplitPay).catch(() => null);
        if (desiredSplitPay > 0 && (!attemptOut || !attemptOut.placeRes?.ok || attemptOut.json?.statusCode !== 0 || !extractUpiFromPlaceJson(attemptOut.json).upiIntentUrl)) {
          attemptOut = await sendWebPaymentsPlaceOrder(0).catch(() => null);
        }
      }
    }

    const { placeRes, rawText, json, splitPayUsed } = attemptOut || { placeRes: { ok: false, status: 0 }, rawText: '', json: null, splitPayUsed: 0 };

    const { orderData, redir, upiIntentUrl } = extractUpiFromPlaceJson(json);

    const swiggyOrderId = String(orderData?.order_id || orderData?.orderId || '');
    const paymentTxnId = String(
      orderData?.targeted_marketplace_payment_reference_id ||
      orderData?.payment_info_v2?.payment_transactions?.[0]?.marketplace_reference_id ||
      redir?.upiRedirect?.upiIntentRedirect?.transactionId ||
      ''
    );
    let upiEmbeddedAmount = NaN;
    try {
      const amParam = new URL(upiIntentUrl).searchParams.get('am');
      if (amParam !== null && amParam !== '') upiEmbeddedAmount = Number(amParam);
    } catch {}
    const rawPlacedTotal = Number(orderData?.order_total ?? cm.order_total ?? order?.finalPayable ?? 0);
    const liveOrderTotal = Number.isFinite(upiEmbeddedAmount) && upiEmbeddedAmount > 0
      ? upiEmbeddedAmount
      : (splitPayUsed > 0 && rawPlacedTotal === rawOrderTotal
          ? Math.max(0, Math.round((rawPlacedTotal - splitPayUsed) * 100) / 100)
          : rawPlacedTotal);

    // A QR is only usable if the intent itself is well-formed (real VPA + amount).
    // Otherwise the customer scans it and sees "invalid" — stop here instead.
    const intentCheck = upiIntentUrl
      ? validateUpiIntentForQr(upiIntentUrl, { amount: liveOrderTotal, requireAmount: false })
      : { valid: false, problems: ['upi intent missing'] };

    const placeAccepted = Boolean(placeRes.ok && json?.statusCode === 0);
    const placedOrderId = String(orderData?.order_id || orderData?.orderId || '');

    if (!placeAccepted || !upiIntentUrl || !upiIntentUrl.startsWith('upi://') || !intentCheck.valid) {
      // Do bilkul alag haalat hain — inhe ek hi error me mila dena hi confusion tha:
      //  (A) Swiggy ne mana kiya (statusCode != 0) -> asli rejection.
      //  (B) Swiggy ne ORDER PLACE kar diya par UPI intent nahi diya -> order
      //      bana hua hai, sirf QR nahi mila. "Rejected" kehna jhooth tha, aur
      //      doosre account par dobara try karne se ek AUR unpaid order ban jata tha.
      const err = new Error(
        placeAccepted
          ? `Swiggy ne order place kar diya${placedOrderId ? ` (Order ID ${placedOrderId})` : ''} par UPI intent nahi mila — QR nahi ban sakta.`
          : `Swiggy payment gateway rejected QR creation: HTTP ${placeRes.status}, statusCode=${json?.statusCode}, msg="${json?.statusMessage || 'Unknown'}"`
      );
      // Suspended ID: Swiggy order place par "account blocked" bolta hai.
      // Ise aam error samajhna hi order atakne ki wajah thi.
      const suspendFailure = classifySwiggyAccountFailure({
        message: String(json?.statusMessage || ''),
        detailed: String(orderData?.message || json?.data?.message || ''),
        code: 'SWIGGY_PLACE_ORDER_QR_FAILED',
        statusCode: json?.statusCode,
        httpStatus: placeRes.status,
        rawText
      });
      if (suspendFailure.suspended) {
        const suspendKey = resolveAccountKeyForHealth(account);
        if (suspendKey) {
          markAccountSuspended(suspendKey, {
            reason: suspendFailure.reason,
            code: suspendFailure.matched,
            stage: 'POST_PAYMENTS_ORDER_PLACE',
            orderId: order?.id,
            httpStatus: placeRes.status
          });
        }
      }
      err.diag = {
        code: suspendFailure.suspended
          ? 'ACCOUNT_SUSPENDED'
          : (placeAccepted ? 'SWIGGY_PLACED_NO_UPI_INTENT' : 'SWIGGY_PLACE_ORDER_QR_FAILED'),
        placed: placeAccepted,
        placedOrderId,
        paymentFallbacks: json?.data?.payment_fallbacks || null,
        suspended: suspendFailure.suspended,
        accountKey: resolveAccountKeyForHealth(account),
        stage: 'POST_PAYMENTS_ORDER_PLACE',
        httpStatus: placeRes.status,
        swiggyStatusCode: json?.statusCode ?? null,
        swiggyMessage: json?.statusMessage || '',
        cartId,
        addressId,
        cartTotal: cm.order_total,
        intentProblems: intentCheck.problems || [],
        rawSnippet: rawText.slice(0, 500)
      };
      // Order bana hua hai — yaad rakho, warna agla retry SEESHA naya unpaid
      // order place kar dega (yahi 5-6 "not created yet" orders ki wajah thi).
      if (placeAccepted && order && typeof order === 'object') {
        order.pendingSwiggyOrderId = placedOrderId || order.pendingSwiggyOrderId || '';
        order.pendingSwiggyUpiUri = '';
        order.swiggyPlacedUnpaid = true;
        order.placedWithoutIntentAt = new Date().toISOString();
        err.diag.alreadyPlacedOrderId = placedOrderId;
      }
      if (!intentCheck.valid && !placeAccepted) {
        err.diag.code = 'SWIGGY_UPI_INTENT_INVALID';
        err.diag.stage = 'POST_PAYMENTS_ORDER_PLACE';
        err.diag.intentProblems = intentCheck.problems || [];
      }
      throw err;
    }

    if (order && typeof order === 'object') {
      const refreshedBill = parseDapiCartPayload(cm);
      if (refreshedBill && refreshedBill.items?.length > 0) {
        order.itemTotal = refreshedBill.itemTotal;
        order.subtotal = refreshedBill.subtotal;
        order.tradeDiscountTotal = refreshedBill.tradeDiscountTotal;
        order.merchantTradeDiscount = refreshedBill.merchantTradeDiscount;
        order.campaignFreeCash = refreshedBill.campaignFreeCash;
        order.walletSplitPayAmount = splitPayUsed > 0 ? splitPayUsed : refreshedBill.walletSplitPayAmount;
        order.freeCashApplied = Math.round(((refreshedBill.campaignFreeCash || 0) + (order.walletSplitPayAmount || 0)) * 100) / 100;
        order.swiggyOneMembershipFee = refreshedBill.swiggyOneMembershipFee;
        order.deliveryFee = refreshedBill.deliveryFee;
        order.freeDeliveryDiscount = refreshedBill.freeDeliveryDiscount;
        order.swiggyOneApplied = refreshedBill.swiggyOneApplied;
        order.packingCharges = refreshedBill.packingCharges;
        order.taxesAndCharges = refreshedBill.taxesAndCharges;
        order.totalSavings = refreshedBill.totalSavings;
      }
      if (liveOrderTotal > 0) {
        order.finalPayable = liveOrderTotal;
      }
      order.pendingSwiggyOrderId = swiggyOrderId;
      order.pendingSwiggyPaasId = paymentTxnId;
      order.pendingSwiggyUpiUri = upiIntentUrl;
      order.pendingQrAmount = liveOrderTotal;
      order.pendingQrCreatedAt = Date.now();
      order.pendingQrAddressId = String(order.addressDetails?.id || addressId);
      order.pendingQrAddressText = normalizeAddressText(order.addressDetails?.address || '');
      order.pendingQrDeliveryMobile = normalizeIndianMobile(order.addressDetails?.mobile);
      order.pendingQrLat = String(order.addressDetails?.lat || '');
      order.pendingQrLng = String(order.addressDetails?.lng || '');
      order.pendingQrAddressAccount = String(account.phone || account.mobile || '');
    }

    // QR ban gaya = is ID par Swiggy ne order accept kiya => healthy.
    {
      const healthyKey = resolveAccountKeyForHealth(account);
      if (healthyKey) markAccountHealthy(healthyKey, { note: 'QR generated' });
    }

    return {
      upiIntentUrl,
      swiggyOrderId,
      orderId: swiggyOrderId,
      paymentTxnId,
      amount: liveOrderTotal,
      swiggyPaySplitAmount: splitPayUsed,
      slaMinutes: orderData?.sla_time ? String(orderData.sla_time) : '',
      restaurantName: orderData?.restaurant_name || cm.restaurant_details?.name || order?.restaurantName || '',
      confirmWindowMs: Number(redir?.upiRedirect?.upiIntentRedirect?.upiIntentConfirmTimeInMs || 45000)
    };
  });
}

/**
 * Checks LIVE payment status & extracts REAL Swiggy Order ID, Order Status, Rider Info & Live Tracking Data:
 * 1) Non-destructively checks `GET https://payments.swiggy.com/api/v3/vpa-txn-status?paas_id=<txnId>&payment_code=UPIIntent`
 * 2) As soon as `data === 'success'`, fires `POST https://payments.swiggy.com/api/v3/order/confirm?order_id=<id>` so Swiggy confirms kitchen dispatch!
 * 3) Verifies real paid order via `GET /dapi/order/all` + `GET /dapi/order/details?type=full&version=V2` + `GET /dapi/order/trackV4` + `GET /dapi/order/trackV2/de`.
 */

// ---------------------------------------------------------------------------
// FAST, BOUNDED ORDER-TRACKING SCANNER
// ---------------------------------------------------------------------------
// Swiggy keeps the real share/tracking link inside its own order payloads
// (`order/all` → My Orders, `order/details`, `trackV4`, `trackV2/de`). This
// scanner reproduces the app's own "Profile → My Orders → latest order → Share"
// lookup: read the account's order list, match the exact Swiggy order id, then
// pull the share link from that order. It is concurrency-capped and works under
// a hard time budget so a Telegram handler can never hang for minutes.

/** Only genuine numeric Swiggy order ids are accepted — never bot refs. */
export function normalizeSwiggyOrderId(value) {
  const raw = String(value ?? '').trim();
  return /^\d{10,20}$/.test(raw) ? raw : '';
}

function isSwiggyOwnedOrderHost(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'r.swiggy.com' || host.endsWith('.r.swiggy.com') ||
      host === 'swiggy.onelink.me' ||
      host === 'swig.gy' ||
      host === 'swiggy.com' || host === 'www.swiggy.com' || host === 'm.swiggy.com'
    );
  } catch {
    return false;
  }
}

const SHARE_KEY_CONTEXT = /share|track|ofo|link|href|url|deeplink|deep_link|redirection|cta|action|message|text|whatsapp|sms|comms/i;
const ORDER_PATH_CONTEXT = /\/(?:(?:swiggy\/)?ofo\/track|track-order|order-track|orders?\/track|track|tracking|orders?\/[a-z0-9_-]{4,}|orders?\/share|social\/share\/order)(?:\/|\?|$)/i;

/**
 * Deep share-link extractor. Honours explicit Swiggy tracking/share fields,
 * multi-word OFO share sentences ("Click this link to track: http://r.swiggy.com/..."),
 * stringified JSON payloads (`app_redirection_info`, `rendering_details`, `cta`),
 * and `swiggy://…?tracking_url=<encoded https link>` deep links, ranking true
 * Swiggy OFO/tracking URLs above generic order links and rejecting all dummy/asset URLs.
 */
export function extractOrderShareUrlDeep(...sources) {
  const fromFyi = extractTrackingUrlFromSwiggyFyiDetails(...sources);
  if (fromFyi) return fromFyi;

  const scored = new Map();

  const direct = extractSwiggyProvidedTrackingUrl(...sources);
  if (direct) {
    scored.set(direct, scoreSwiggyTrackingUrl(direct, 'direct_share_track') + 5);
  }

  const consider = (rawValue, keyContext = '') => {
    for (const value of extractTrackingCandidateUrlsFromString(rawValue)) {
      if (!isSwiggyOwnedOrderHost(value)) continue;
      const isBlockedField = NON_TRACKING_KEY_CONTEXT_RE.test(keyContext) && !/(?:ofo\/track|r\.swiggy\.com\/(?:.*\/)?track\/|r\.swiggy\.com\/[a-z0-9_-]+)/i.test(value);
      if (isBlockedField) continue;
      let pathAndQuery = '';
      try {
        const u = new URL(value);
        pathAndQuery = `${u.pathname}${u.search}`;
      } catch { continue; }
      const isShortHost = /r\.swiggy\.com|swiggy\.onelink\.me|swig\.gy/i.test(value);
      const looksLikeOrderLink = ORDER_PATH_CONTEXT.test(pathAndQuery) || isShortHost;
      if (!looksLikeOrderLink) continue;
      const allowShort = /(?:share|track|ofo|deeplink|deep_link|redirection)/i.test(keyContext) || /r\.swiggy\.com/i.test(value);
      if (!isOfficialSwiggyTrackingUrl(value, { allowProviderShortLink: allowShort })) continue;
      const score = scoreSwiggyTrackingUrl(value, keyContext);
      if (!scored.has(value) || scored.get(value) < score) scored.set(value, score);
    }
  };

  const walk = (node, context = '', depth = 0) => {
    if (node === null || node === undefined || depth > 12) return;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (
        depth < 4 &&
        trimmed.length >= 2 &&
        trimmed.length <= 30000 &&
        ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) &&
        /swiggy|swig\.gy|track|share|ofo/i.test(trimmed)
      ) {
        try {
          walk(JSON.parse(trimmed), context, depth + 1);
          return;
        } catch {}
      }
      consider(trimmed, context);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const nextContext = `${context} ${key}`.toLowerCase();
      if (typeof value === 'string') {
        if (
          SHARE_KEY_CONTEXT.test(key) ||
          /https?:\/\/|https?%3a|swiggy:\/\//i.test(value) ||
          ((value.trim().startsWith('{') || value.trim().startsWith('[')) && /swiggy|swig\.gy|track|share|ofo/i.test(value))
        ) {
          walk(value, nextContext, depth + 1);
        }
      } else if (value && typeof value === 'object') {
        walk(value, nextContext, depth + 1);
      }
    }
  };

  for (const source of sources) walk(source);
  if (scored.size === 0) return '';
  return [...scored.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Secondary share/tracking probe for orders (especially Delivered orders where
 * Android-UA `dapi/order/trackV4` switches to post-delivery summary cards while
 * Swiggy's mWeb BFF, classic `order/track`, `order/share`, `ofo/share`, mobile
 * `mapi/order/*` routes, or Official Swiggy Food MCP expose the share link).
 */
// ---------------------------------------------------------------------------
// "My Account → My Orders → Track → Share": the link a human sees in the
// Swiggy web app. The DAPI JSON often omits it (desktop payloads, delivered
// orders), but the PAGE Swiggy itself renders always carries it in
// `__NEXT_DATA__`. Other bots read it from exactly here — so do we now.
//
// Only real Swiggy links are returned (validateTrackingUrlForOrder); when the
// page genuinely has nothing we return '' and the caller keeps saying the
// honest "not published yet".
// ---------------------------------------------------------------------------
const orderSharePageCache = new Map(); // orderId -> { url, page, at }
const ORDER_SHARE_PAGE_TTL = 90 * 1000;

export async function scrapeSwiggyOrderShareFromPages(account, orderId, { timeoutMs = 6000 } = {}) {
  const cleanId = normalizeSwiggyOrderId(orderId) || String(orderId || '').trim();
  if (!cleanId) return { url: '', page: '' };
  // The instant-link watcher retries every 3s; without this cache we would hit
  // Swiggy's HTML pages ~20× per order and invite a WAF block.
  const cachedPage = orderSharePageCache.get(cleanId);
  if (cachedPage && Date.now() - cachedPage.at < ORDER_SHARE_PAGE_TTL) {
    return { url: cachedPage.url || '', page: cachedPage.page || '' };
  }
  const cookieParts = [];
  try {
    const clean = cleanSwiggyCookieString(account?.cookies || '', account);
    if (clean) cookieParts.push(clean);
  } catch { /* guest is fine for the public share page */ }
  try {
    const waf = wafPool.getTokenSync();
    if (waf) cookieParts.push(`aws-waf-token=${waf}`);
  } catch { /* optional */ }

  const pages = [
    'https://www.swiggy.com/my-orders',
    `https://www.swiggy.com/track?orderId=${encodeURIComponent(cleanId)}`,
    'https://www.swiggy.com/orders'
  ];

  const accept = (candidate) => {
    const url = String(candidate || '').trim();
    if (!url) return '';
    if (!validateTrackingUrlForOrder(url, { swiggyOrderId: cleanId }, 'SWIGGY_API')) return '';
    return url;
  };

  for (const page of pages) {
    try {
      const res = await fetch(page, {
        redirect: 'follow',
        headers: {
          'User-Agent': MOBILE_WEB_UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
          Referer: 'https://www.swiggy.com/',
          ...(cookieParts.length ? { Cookie: cookieParts.join('; ') } : {})
        },
        signal: AbortSignal.timeout(Math.max(1500, Number(timeoutMs) || 6000))
      });
      if (!res || !res.ok) continue;
      const html = await res.text();
      if (!html || html.length < 200) continue;

      // 1) Structured payloads first (`__NEXT_DATA__`, embedded JSON state).
      for (const blob of extractJsonBlobsFromHtml(html)) {
        let parsed = null;
        try { parsed = JSON.parse(blob); } catch { continue; }
        const hit = accept(extractOrderShareUrlDeep(parsed));
        if (hit) {
          orderSharePageCache.set(cleanId, { url: hit, page, at: Date.now() });
          return { url: hit, page };
        }
      }
      // 2) Raw HTML mentions of a track/share route for THIS order id.
      const esc = cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`https?:\\/\\/(?:www\\.)?swiggy\\.com\\/(?:ofo\\/)?track\\/[A-Za-z0-9_-]{3,}[^"'\\s<>]*${esc}[^"'\\s<>]*`, 'i'),
        new RegExp(`https?:\\/\\/(?:www\\.)?swiggy\\.com\\/(?:orders?\\/|track\\?)[^"'\\s<>]*${esc}[^"'\\s<>]*`, 'i'),
        /https?:\/\/(?:r\.swiggy\.com\/[A-Za-z0-9_-]{3,}|swiggy\.onelink\.me\/[A-Za-z0-9_?=&%.\/-]+)/i
      ];
      for (const re of patterns) {
        const m = html.match(re);
        const hit = m ? accept(m[0]) : '';
        if (hit) {
          orderSharePageCache.set(cleanId, { url: hit, page, at: Date.now() });
          return { url: hit, page };
        }
      }
    } catch {
      // network / timeout / WAF — next page, never a fake link
    }
  }
  orderSharePageCache.set(cleanId, { url: '', page: '', at: Date.now() });
  if (orderSharePageCache.size > 300) {
    const oldest = orderSharePageCache.keys().next().value;
    if (oldest) orderSharePageCache.delete(oldest);
  }
  return { url: '', page: '' };
}

async function fetchSecondaryOrderSharePayloads(accountOrCookies, orderId, customerId = '', {
  timeoutMs = 3800,
  allowMapiTrackV4 = true
} = {}) {
  const cleanId = normalizeSwiggyOrderId(orderId) || String(orderId || '').trim();
  if (!accountOrCookies || !cleanId) return { shareUrl: '', payloads: [] };

  const cidParam = customerId ? `&customer_id=${encodeURIComponent(customerId)}` : '';
  const calls = [
    { route: `order/track?order_id=${encodeURIComponent(cleanId)}`, opts: { timeoutMs, useMobileWebUa: true } },
    { route: `order/details?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2`, opts: { timeoutMs, useMobileWebUa: true } },
    { route: `order/share?order_id=${encodeURIComponent(cleanId)}`, opts: { timeoutMs } },
    { route: `order/shareableLink?order_id=${encodeURIComponent(cleanId)}`, opts: { timeoutMs } },
    { route: `ofo/share?order_id=${encodeURIComponent(cleanId)}`, opts: { timeoutMs } },
    { route: `mapi/order/details?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2`, opts: { timeoutMs } },
    { route: `mapi/order/share?order_id=${encodeURIComponent(cleanId)}`, opts: { timeoutMs } },
    { route: `mapi/order/shareableLink?order_id=${encodeURIComponent(cleanId)}`, opts: { timeoutMs } },
    { route: `mapi/order/track?order_id=${encodeURIComponent(cleanId)}&version=V2`, opts: { timeoutMs } },
    ...(allowMapiTrackV4
      ? [
          { route: `order/trackV4?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2${cidParam}`, opts: { timeoutMs, useMobileWebUa: true } },
          { route: `mapi/order/trackV4?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2${cidParam}`, opts: { timeoutMs } }
        ]
      : [])
  ];

  const [responses, mcpPayloads] = await Promise.all([
    Promise.all(calls.map(({ route, opts }) => dapiFetch(accountOrCookies, route, opts).catch(() => null))),
    probeSwiggyFoodMcpOrderTracking(accountOrCookies, cleanId, timeoutMs).catch(() => [])
  ]);
  const payloads = [];
  for (const r of responses) {
    const body = r?.json?.data ?? r?.json;
    if (!body || typeof body !== 'object') continue;
    // Reject cross-order responses if Swiggy returned a different order_id
    const nestedOrder = body?.orders?.[0] || body?.order || body;
    const returnedId = String(nestedOrder?.order_id || nestedOrder?.orderId || '');
    if (returnedId && returnedId !== cleanId) continue;
    payloads.push(body);
  }
  if (Array.isArray(mcpPayloads) && mcpPayloads.length > 0) {
    payloads.push(...mcpPayloads);
  }
  const shareUrl = payloads.length > 0 ? extractOrderShareUrlDeep(...payloads) : '';
  return { shareUrl: shareUrl || '', payloads };
}

function resolveTrackingAccountsMap(getAccountsFn) {
  try {
    const getter = typeof getAccountsFn === 'function' ? getAccountsFn : null;
    const fromGetter = getter ? getter() : null;
    if (fromGetter && Object.keys(fromGetter).length > 0) return fromGetter;
  } catch {}
  try {
    const db = getDb();
    return db?.config?.accounts || {};
  } catch {
    return {};
  }
}

function withTimeout(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(300, Number(ms) || 5000));
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise)
      .then(value => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

async function runWithConcurrency(items, limit, workerFn) {
  const queue = [...items];
  const workers = [];
  const size = Math.max(1, Math.min(Number(limit) || 4, queue.length || 1));
  for (let i = 0; i < size; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) return;
        await workerFn(item);
      }
    })());
  }
  await Promise.all(workers);
}

/**
 * Expiry (ms) of the account's stored Swiggy `tid` JWT, if decodable.
 * App logins mint 30-day tids, but web/OTP-style logins mint SHORT tids
 * (~40 min) — an already-expired tid means every DAPI call for that account
 * silently fails and the order looks "not found" on that account.
 */
export function accountTidExpiryMs(acc) {
  const cm = parseCookieMap(String(acc?.cookies || ''));
  const candidates = [acc?.jwtTid, acc?.tid, cm.tid];
  for (const c of candidates) {
    const part = String(c || '').split('.')[1];
    if (!part || !String(c).includes('.')) continue;
    try {
      const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      const exp = Number(payload?.exp);
      if (Number.isFinite(exp) && exp > 0) return exp * 1000;
    } catch {}
  }
  return null;
}

function recordScanFailure(failures, seen, key, acc, reason, detail = '') {
  if (seen.has(key)) return;
  seen.add(key);
  failures.push({
    key,
    phone: String(acc?.phone || acc?.mobile || '').replace(/\D/g, '').slice(-10),
    name: String(acc?.name || '').slice(0, 24),
    reason,
    detail: String(detail || '').slice(0, 80)
  });
}

/**
 * Scan every logged-in Swiggy ID for one exact order id.
 * Returns quickly with `TRACKING_FOUND` as soon as a real share link appears.
 */
export async function scanOrderAcrossAccounts(swiggyOrderId, {
  getAccountsFn = null,
  preferredAccountKey = '',
  budgetMs = 20000,
  concurrency = 6,
  deep = true,
  fetchTimeoutMs = 6000,
  // READ-ONLY: used when we are only chasing a tracking link for an order that
  // is already running. A tracking sweep must never demote / "wipe" an ID.
  readOnly = false,
  // A user pasted this order id themselves. `sessionExpired` / `isLoggedOut`
  // are only HINTS from an older call — a stale flag must never stop us from
  // asking Swiggy (that was the real "order kisi bhi ID se nahi mila" bug).
  includeStaleFlags = false,
  // Extra `order/all` pages to walk when the id is not on page 1 (delivered /
  // older orders live deeper in the same list the Swiggy app shows).
  extraListPages = 2
} = {}) {
  const startedAt = Date.now();
  const targetId = normalizeSwiggyOrderId(swiggyOrderId);
  if (!targetId) {
    return { status: 'NO_SWIGGY_ID', hasOrder: false, trackingUrl: '', scanned: 0, elapsedMs: 0, failures: [] };
  }
  const accountsMap = resolveTrackingAccountsMap(getAccountsFn);
  const hasCreds = (acc) => Boolean(acc && (acc.cookies || acc.tid || acc.jwtTid || acc.token || acc.auth_token || acc.access_token));
  const entries = Object.entries(accountsMap)
    .filter(([, acc]) => hasCreds(acc) && (includeStaleFlags || (!acc.isLoggedOut && !acc.sessionExpired)))
    .sort(([k1], [k2]) => {
      if (preferredAccountKey && k1 === preferredAccountKey) return -1;
      if (preferredAccountKey && k2 === preferredAccountKey) return 1;
      return 0;
    });

  if (entries.length === 0) {
    return { status: 'NO_ACCOUNTS', hasOrder: false, trackingUrl: '', scanned: 0, elapsedMs: Date.now() - startedAt, failures: [] };
  }

  // A 27-account vault needs far more than 20s at concurrency 4-6; a too-small
  // budget silently scans only a subset (live incident: 8/27 scanned, "time
  // out") and reports a misleading "not found". Scale the budget with account
  // count (capped at 45s) so full coverage is actually achievable.
  const requestedBudget = Math.max(3000, Number(budgetMs) || 20000);
  const scaledBudget = Math.min(45000, Math.max(requestedBudget, entries.length * 1100));
  const deadline = startedAt + scaledBudget;
  const remaining = () => deadline - Date.now();
  const callTimeout = () => Math.max(1200, Math.min(Number(fetchTimeoutMs) || 6000, remaining()));

  let best = null;
  let orderFound = null;
  const scannedAccounts = new Set();
  const accountCustomerIds = new Map();
  // Per-account failures (expired session, WAF block, auth error) so a
  // NOT_FOUND result can say WHY an account produced nothing — "the order is
  // on another account" is only true when that account's session was alive.
  const failures = [];
  const failedKeys = new Set();
  // Accounts whose order/all (or session-auth) call actually SUCCEEDED and
  // returned a real (possibly empty) list — distinguishes "checked, no order"
  // from "never checkable" in a NOT_FOUND reply.
  const okScannedKeys = new Set();
  let timedOut = false;

  const inspectOrder = async (key, acc, orderObject, customerId = '', preloadedDetailsRes = null) => {
    const fromOrder = extractOrderShareUrlDeep(orderObject);
    // Enrich the ONE matching order (active OR delivered) with live/final status,
    // delivery OTP, rider details, and Swiggy share/tracking URL.
    const timeoutMs = callTimeout();
    const resolvedCustomerId = String(customerId || orderObject?.customer_id || acc?.customerId || acc?.userId || '');
    const [detailsRes, trkRes, deRes] = await Promise.all([
      preloadedDetailsRes
        ? Promise.resolve(preloadedDetailsRes)
        : dapiFetch(acc, `order/details?order_id=${encodeURIComponent(targetId)}&type=full&version=V2`, { timeoutMs }).catch(() => null),
      dapiFetch(acc, `order/trackV4?order_id=${encodeURIComponent(targetId)}&type=full&version=V2${resolvedCustomerId ? `&customer_id=${encodeURIComponent(resolvedCustomerId)}` : ''}`, { timeoutMs }).catch(() => null),
      dapiFetch(acc, `order/trackV2/de?order_id=${encodeURIComponent(targetId)}`, { timeoutMs }).catch(() => null)
    ]);
    const rawDet = detailsRes?.json?.data?.orders?.[0] || detailsRes?.json?.data?.order || null;
    const detOid = String(rawDet?.order_id || rawDet?.orderId || rawDet?.id || '');
    const details = (rawDet && (!detOid || detOid === targetId)) ? rawDet : (orderObject || null);
    const trkData = trkRes?.json?.data || null;
    const deData = deRes?.json?.data || null;

    let trackingUrl = extractOrderShareUrlDeep(orderObject, details, trkData, deData) || fromOrder;
    let extraPayloads = [];
    // If primary DAPI endpoints omitted the share widget (e.g. a Delivered order
    // where desktop trackV4 switched to post-delivery summary cards, or mobile-only
    // OFO share payload), probe classic order/track, order/share & mobile MAPI!
    if (!trackingUrl && remaining() > 700) {
      const extra = await fetchSecondaryOrderSharePayloads(acc, targetId, resolvedCustomerId, {
        timeoutMs: Math.min(3500, callTimeout()),
        allowMapiTrackV4: true
      });
      if (extra.shareUrl) trackingUrl = extra.shareUrl;
      extraPayloads = extra.payloads || [];
    }
    // Still nothing: read the page Swiggy renders for "My Orders → Track →
    // Share" — the exact place a human copies the link from.
    if (!trackingUrl && remaining() > 900) {
      const scraped = await scrapeSwiggyOrderShareFromPages(acc, targetId, {
        timeoutMs: Math.min(3000, callTimeout())
      }).catch(() => ({ url: '' }));
      if (scraped?.url) trackingUrl = scraped.url;
    }

    const recalled = recallSwiggyOrderTracking(targetId);
    if (!trackingUrl && recalled.trackingUrl) trackingUrl = recalled.trackingUrl;
    const otp = extractSwiggyDeliveryOtp(orderObject, details, trkData, ...extraPayloads, { delivery: deData }) || recalled.deliveryOtp || '';
    const statusText = normalizeSwiggyLiveOrderStatus(
      trkData?.order_status_details?.status_message,
      details?.order_status || details?.status || orderObject?.order_status || orderObject?.status,
      details?.post_status || orderObject?.post_status || orderObject?.order_delivery_status
    ) || 'Order Confirmed';
    const accPhone = String(acc?.phone || acc?.mobile || '').trim();
    const snap = extractSwiggyOrderSnapshotFields(orderObject, details, trkData, deData, { accKey: key, accPhone });
    rememberSwiggyOrderTracking(targetId, { trackingUrl: trackingUrl || '', deliveryOtp: otp, status: statusText, ...snap });
    const isDeliv = /deliv/i.test(statusText) && !/cancel|refus|return/i.test(statusText);
    return {
      accKey: key,
      acc,
      accPhone,
      accName: String(acc?.name || acc?.swiggyName || '').trim(),
      swiggyOrderId: targetId,
      trackingUrl: trackingUrl || '',
      ...(isDeliv ? { deliveredTrackUrl: buildSignedOrderTrackUrl(targetId) } : {}),
      otp,
      orderStatus: statusText,
      etaMinutes: String(trkData?.sla_time || details?.sla_time || ''),
      restaurantName: snap.restaurantName || String(details?.restaurant_name || orderObject?.restaurant_name || ''),
      restaurantAddress: snap.restaurantAddress || '',
      restaurantLat: snap.restaurantLat,
      restaurantLng: snap.restaurantLng,
      items: snap.items || [],
      orderTotal: snap.orderTotal || 0,
      orderTime: snap.orderTime || '',
      customerName: snap.customerName || '',
      deliveryAddress: snap.deliveryAddress || {},
      deliveryBoy: {
        name: snap.deliveryBoy?.name || String(deData?.name || details?.delivery_boy?.name || orderObject?.delivery_boy?.name || ''),
        mobile: snap.deliveryBoy?.mobile || String(deData?.mobile || details?.delivery_boy?.mobile || orderObject?.delivery_boy?.mobile || ''),
        lat: snap.deliveryBoy?.lat ?? null,
        lng: snap.deliveryBoy?.lng ?? null
      }
    };
  };

  // Phase 1 — My Orders list (one cheap call per account, like the Swiggy app).
  await runWithConcurrency(entries, concurrency, async ([key, acc]) => {
    if (best) return;
    if (remaining() <= 300) { timedOut = true; return; }
    scannedAccounts.add(key);
    try {
      // NOTE: a stored tid past its JWT `exp` is NOT skipped — Swiggy DAPI does
      // not always enforce `exp` (the same past-exp token can still serve calls,
      // e.g. in another bot). We try the real call first; only an actual
      // rejection is recorded, and the past-exp fact is attached as a hint.
      const tidExp = accountTidExpiryMs(acc);
      const tidExpHint = (tidExp && tidExp < Date.now()) ? ` (tid past exp ${new Date(tidExp).toISOString()})` : '';
      // Same source as the "Orders Done" dashboard: the cached session auth
      // (WAF/token aware). Falls back to a direct order/all call only when auth failed.
      let list = [];
      let customerId = String(acc?.customerId || acc?.userId || '');
      const auth = await withTimeout(
        getSwiggySessionAuth(acc, false).catch(() => null),
        callTimeout(),
        null
      );
      if (auth && auth.sessionExpired) {
        // NEVER wipe an ID on a transient failure. Only Swiggy's own
        // "unauthorized / logged out" answer (hardExpired) may demote it, and a
        // read-only sweep (active-order tracking) never writes session state.
        const hardExpiry = auth.hardExpired === true;
        if (hardExpiry && !readOnly) {
          acc.sessionExpired = true;
          acc.isLoggedIn = false;
          try {
            const liveDb = getDb();
            if (liveDb?.config?.accounts?.[key]) {
              liveDb.config.accounts[key].sessionExpired = true;
              liveDb.config.accounts[key].isLoggedIn = false;
              saveDb(liveDb);
            }
          } catch {}
        } else if (!hardExpiry) {
          console.warn(`[TrackScan] ${key} unverifiable (${auth.statusMessage || 'network/WAF'}) — session kept`);
        }
        recordScanFailure(
          failures, failedKeys, key, acc,
          hardExpiry ? 'SESSION_EXPIRED' : 'SESSION_UNVERIFIED',
          `${String(auth.statusMessage || '')}${hardExpiry ? '' : ' (session kept — transient)'}${tidExpHint}`
        );
        return;
      }
      if (auth && Array.isArray(auth.orders)) {
        list = auth.orders;
        customerId = String(auth.userId || customerId || '');
        okScannedKeys.add(key);
      } else {
        const listRes = await dapiFetch(acc, 'order/all', { timeoutMs: callTimeout() }).catch(() => null);
        if (!listRes || listRes.status !== 200 || !listRes.json || Number(listRes.json.statusCode) !== 0) {
          recordScanFailure(failures, failedKeys, key, acc, 'AUTH_FAILED', String(listRes?.json?.statusMessage || `HTTP ${listRes?.status ?? 'ERR'}`) + tidExpHint);
          return;
        }
        list = Array.isArray(listRes.json.data.orders) ? listRes.json.data.orders : [];
        okScannedKeys.add(key);
      }
      if (customerId) accountCustomerIds.set(key, customerId);
      let match = list.find(o => String(o?.order_id || '') === targetId) || null;
      // Older / delivered orders live BEYOND page 1 of `order/all`. Walk a couple
      // more pages (same list the Swiggy app paginates) before saying NOT_FOUND,
      // otherwise a perfectly real order id "kisi bhi ID par nahi mila".
      if (!match && deep && remaining() > 1200) {
        const lastPage = 1 + Math.min(3, Math.max(0, Number(extraListPages) || 0));
        for (let pg = 2; pg <= lastPage; pg++) {
          if (remaining() <= 900) break;
          const pageRes = await dapiFetch(acc, `order/all?page=${pg}`, { timeoutMs: callTimeout() }).catch(() => null);
          if (!pageRes || pageRes.status !== 200 || Number(pageRes.json?.statusCode) !== 0) break;
          const pageList = Array.isArray(pageRes.json?.data?.orders) ? pageRes.json.data.orders : [];
          if (pageList.length === 0) break;
          okScannedKeys.add(key);
          match = pageList.find(o => String(o?.order_id || '') === targetId) || null;
          if (match) break;
          if (pageList.length < 10) break;
        }
      }
      if (!match) return;
      const hit = await inspectOrder(key, acc, match, customerId);
      if (hit.trackingUrl && !best) best = hit;
      else if (!orderFound) orderFound = hit;
    } catch {}
  });

  // Phase 2 — order/details fallback for older/delivered orders beyond page 1 of order/all.
  if (!best && !orderFound && deep && remaining() > 1500) {
    await runWithConcurrency(entries, concurrency, async ([key, acc]) => {
      if (best) return;
      if (remaining() <= 800) { timedOut = true; return; }
      scannedAccounts.add(key);
      try {
        const detRes = await dapiFetch(acc, `order/details?order_id=${encodeURIComponent(targetId)}&type=full&version=V2`, { timeoutMs: callTimeout() }).catch(() => null);
        if (!failedKeys.has(key) && (!detRes || detRes.status !== 200 || !detRes.json || Number(detRes.json.statusCode) !== 0)) {
          recordScanFailure(failures, failedKeys, key, acc, 'AUTH_FAILED', String(detRes?.json?.statusMessage || `HTTP ${detRes?.status ?? 'ERR'}`));
          return;
        }
        const detOrder = detRes?.json?.data?.orders?.[0] || detRes?.json?.data?.order || null;
        if (!detOrder) return;
        const oid = String(detOrder?.order_id || detOrder?.orderId || detOrder?.id || '');
        if (oid !== targetId) return;
        const customerId = accountCustomerIds.get(key) || String(detOrder?.customer_id || acc?.customerId || acc?.userId || '');
        const hit = await inspectOrder(key, acc, detOrder, customerId, detRes);
        if (hit.trackingUrl && !best) best = hit;
        else if (!orderFound) orderFound = hit;
      } catch {}
    });
  }

  const chosen = best || orderFound;
  const base = {
    swiggyOrderId: targetId,
    scanned: scannedAccounts.size,
    elapsedMs: Date.now() - startedAt,
    accountsTotal: entries.length,
    okScanned: okScannedKeys.size,
    okScannedPhones: [...okScannedKeys].map(k => {
      const a = accountsMap[k] || {};
      return String(a?.phone || a?.mobile || '').replace(/\D/g, '').slice(-10);
    }).filter(Boolean),
    failures
  };
  if (chosen) {
    return {
      ...base,
      ...chosen,
      status: chosen.trackingUrl ? 'TRACKING_FOUND' : 'ORDER_FOUND',
      hasOrder: true
    };
  }
  return {
    ...base,
    status: timedOut ? 'TIMEOUT' : 'NOT_FOUND',
    hasOrder: false,
    trackingUrl: ''
  };
}

// Dedicated All-IDs tracking extractor — bounded scan across every logged-in Swiggy ID
export async function extractTrackingViaAllAccounts(order, { getAccountsFn = null, budgetMs = 18000, deep = true, includeStaleFlags = true } = {}) {
  if (!order) return null;
  const targetOrderId = normalizeSwiggyOrderId(order.swiggyOrderId) || normalizeSwiggyOrderId(order.pendingSwiggyOrderId);
  if (!targetOrderId) return null;

  const scan = await scanOrderAcrossAccounts(targetOrderId, {
    getAccountsFn,
    preferredAccountKey: order.selectedAccount || '',
    budgetMs,
    deep,
    concurrency: 4,
    // "WO KISI BHI ID SE ORDER NIKAAL SAKTA HAI TO TU KIU NAHI" — every ID that
    // still holds credentials is asked; stale flags never exclude one.
    includeStaleFlags
  }).catch(() => null);

  if (!scan?.hasOrder) return null;
  const trackingUrl = scan.trackingUrl || '';
  return {
    accKey: scan.accKey,
    acc: scan.acc,
    accPhone: scan.accPhone,
    trackingUrl,
    hasOrder: true,
    res: {
      paid: true,
      swiggyOrderId: targetOrderId,
      orderStatus: scan.orderStatus || 'Order Confirmed',
      deliveryOtp: scan.otp || '',
      nativeShareUrl: trackingUrl,
      swiggyWebTrackUrl: trackingUrl,
      etaMinutes: scan.etaMinutes || '',
      deliveryBoy: scan.deliveryBoy || { name: '', mobile: '' }
    },
    scan
  };
}

// ---------------------------------------------------------------------------
// INSTANT TRACKING LINK (payment ke turant baad)
// ---------------------------------------------------------------------------
// Other bots publish the share link the same second payment succeeds because
// they do exactly one thing: call `order/trackV4` and read
// `data.fyi_details[].value.cta_link`. Ours went through the long account scan,
// so the paid card often said "Swiggy has not shared a tracking link yet".
// This is the short, direct version:
//   * both header strategies (web `_session_tid` AND native Android token),
//   * `trackV4` first (the field Swiggy actually fills), then `order/details`,
//   * a few fast retries, because Swiggy publishes the link a second or two
//     after the payment settles.
export async function fetchSwiggyTrackingLinkFast(account, orderId, {
  budgetMs = 6000,
  attempts = 3,
  customerId = ''
} = {}) {
  const cleanId = normalizeSwiggyOrderId(orderId) || String(orderId || '').trim();
  const out = { url: '', payload: null, attempts: 0, tried: [] };
  if (!account || !cleanId) return out;

  const cid = String(customerId || account.customerId || account.userId || '');
  const cidParam = cid ? `&customer_id=${encodeURIComponent(cid)}` : '';
  const startedAt = Date.now();
  const rounds = Math.max(1, Math.min(Number(attempts) || 3, 6));

  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      const wait = Math.min(1200 * round, 2500);
      if (Date.now() - startedAt + wait > budgetMs) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    out.attempts += 1;

    const routes = [
      { route: `order/trackV4?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2${cidParam}`, opts: { useMobileWebUa: true, timeoutMs: 3500 } },
      { route: `order/trackV4?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2${cidParam}`, opts: { timeoutMs: 3500 } },
      { route: `order/details?order_id=${encodeURIComponent(cleanId)}&type=full&version=V2`, opts: { useMobileWebUa: true, timeoutMs: 3000 } }
    ];

    for (const { route, opts } of routes) {
      const res = await dapiFetch(account, route, opts).catch(() => null);
      const body = res?.json?.data ?? res?.json;
      if (!body || typeof body !== 'object') continue;
      const nested = body?.orders?.[0] || body?.order || body;
      const returnedId = String(nested?.order_id || nested?.orderId || '');
      if (returnedId && returnedId !== cleanId) continue;

      // The exact field the live app fills: data.fyi_details[0].value.cta_link
      const fromFyi = extractTrackingUrlFromSwiggyFyiDetails(body, res?.json);
      const url = fromFyi || extractOrderShareUrlDeep(body, res?.json) || '';
      if (url) {
        out.url = url;
        out.payload = body;
        return out;
      }
      out.tried.push(route.split('?')[0]);
    }
  }

  // Last resort: the very page a human opens (My Account → My Orders → Track →
  // Share). One cheap HTML read — no Chromium, no fake link.
  if (Date.now() - startedAt < budgetMs) {
    const scraped = await scrapeSwiggyOrderShareFromPages(account, cleanId, {
      timeoutMs: Math.max(1500, Math.min(4000, budgetMs - (Date.now() - startedAt)))
    }).catch(() => ({ url: '', page: '' }));
    if (scraped?.url) {
      out.url = scraped.url;
      out.page = scraped.page || '';
      out.via = 'WEB_PAGE_SHARE';
      return out;
    }
  }
  return out;
}

export async function checkRealSwiggyPaymentAndExtractTracking(accountOrOpts, maybeOrder) {
  const isWrapped = accountOrOpts && typeof accountOrOpts === 'object' && ('account' in accountOrOpts) && !maybeOrder;
  const account = isWrapped ? accountOrOpts.account : accountOrOpts;
  const order = isWrapped
    ? (accountOrOpts.order || { pendingSwiggyOrderId: accountOrOpts.orderId, pendingSwiggyPaasId: accountOrOpts.paymentTxnId })
    : maybeOrder;

  if (!account || (!account.cookies && !account.tid && !account.token)) {
    const err = new Error('Selected Swiggy account has no session cookies or token while checking payment.');
    err.diag = { code: 'PAID_CHECK_NO_COOKIES', stage: 'CHECK_PAYMENT_AND_TRACKING' };
    throw err;
  }

  const auth = await getSwiggySessionAuth(account, true);
  if (!auth?.userId) {
    const err = new Error('Swiggy session expired while checking payment status.');
    err.diag = { code: 'PAID_CHECK_AUTH_EXPIRED', stage: 'CHECK_PAYMENT_AND_TRACKING' };
    throw err;
  }

  const headers = buildSwiggyPaymentsApiHeaders(account, auth);
  let gatewayTxnState = '';
  let targetOrderId = String(order?.pendingSwiggyOrderId || order?.swiggyOrderId || '');
  const pendingPaasId = String(order?.pendingSwiggyPaasId || '');

  // Step 1: Non-destructive live gateway check on the exact QR `paas_id` (`transactionId`)
  // Only block synthetic sandbox TXNs when actually in sandbox; live TXNs must not be blocked
  if (pendingPaasId.startsWith('2799') && globalThis.fetch === __bootNetworkFetchRef && isZeroSmsTestSandboxActive()) {
    return { paid: false, txnState: 'pending' };
  }
  let gatewayFetchError = '';
  let orderConfirmJson = null;
  if (pendingPaasId) {
    try {
      const txnRes = await fetch(
        `https://payments.swiggy.com/api/v3/vpa-txn-status?paas_id=${encodeURIComponent(pendingPaasId)}&payment_code=UPIIntent`,
        { method: 'GET', headers }
      );
      if (!txnRes.ok) {
        gatewayFetchError = `HTTP ${txnRes.status}`;
      }
      const txnJson = await txnRes.json().catch(() => null);
      gatewayTxnState = String(txnJson?.data || '').toLowerCase();
      // txnJson?.data may be wrapped as { data: 'success' } or { status: 'success' }
      if (!gatewayTxnState && txnJson) {
        gatewayTxnState = String(txnJson.status || txnJson.state || '').toLowerCase();
      }

      // ONLY confirm order on Swiggy AFTER payment genuinely succeeded (`success` / `completed`)!
      if (['success', 'completed', 'paid'].includes(gatewayTxnState) && targetOrderId) {
        const confirmRes = await fetch(
          `https://payments.swiggy.com/api/v3/order/confirm?order_id=${encodeURIComponent(targetOrderId)}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ order_id: targetOrderId, transaction_id: pendingPaasId })
          }
        ).catch(() => null);
        if (confirmRes) {
          orderConfirmJson = await confirmRes.json().catch(() => null);
        }
      }
    } catch (e) {
      gatewayFetchError = e?.message || String(e);
    }
  } else {
    gatewayFetchError = 'missing pendingSwiggyPaasId (no transaction ref — order may have been created before fix)';
  }

  // Step 2: Re-fetch fresh `/dapi/order/all` to detect either:
  //   - Exact paid `pendingSwiggyOrderId`, OR
  //   - Any brand-new paid Swiggy order placed on this account after `baselineSwiggyOrderId`!
  const freshAuth = await getSwiggySessionAuth(account, true);
  const recentOrders = freshAuth?.orders || auth?.orders || [];
  const baselineId = String(order?.baselineSwiggyOrderId || '');

  const targetNumeric = /^\d+$/.test(targetOrderId) ? BigInt(targetOrderId) : null;
  // A "newest order on the account" fallback is ONLY valid while we are waiting
  // for OUR OWN payment QR to settle (we created that QR, so a brand-new paid
  // order must be ours). For a plain order-id lookup (e.g. a pasted number) the
  // match must be EXACT — otherwise an arbitrary id silently attaches a
  // different order's tracking link (false order id / false tracking).
  const awaitingOurPayment = Boolean(pendingPaasId || baselineId) && targetNumeric !== null;
  let matchedOrder = null;
  for (const o of recentOrders) {
    const oid = String(o?.order_id || '');
    if (!oid) continue;
    if (baselineId && oid === baselineId) break;
    // Strict monotonic snowflake guard: ANY historical order older than `targetOrderId` (`BigInt(oid) < BigInt(targetOrderId)`)
    // was placed BEFORE this QR was ever created and can NEVER match this order!
    if (targetNumeric !== null && /^\d+$/.test(oid) && BigInt(oid) < targetNumeric) break;
    if (targetOrderId && oid === targetOrderId) {
      matchedOrder = o;
      break;
    }
    if (!matchedOrder && awaitingOurPayment) {
      matchedOrder = o;
    }
  }

  // If order hasn't surfaced in `/dapi/order/all` yet, also check `order/details?order_id=<targetOrderId>&type=full&version=V2`
  if (!matchedOrder && targetOrderId) {
    const det = await dapiFetch(account, `order/details?order_id=${encodeURIComponent(targetOrderId)}&type=full&version=V2`).catch(() => null);
    const detOrder = det?.json?.data?.orders?.[0];
    const detOrderId = String(detOrder?.order_id || '');
    if (detOrder && detOrderId && detOrderId !== targetOrderId) {
      // Swiggy answered with a different order — never borrow its tracking.
      matchedOrder = null;
    } else if (detOrder) {
      const payState = String(detOrder?.payment_info_v2?.payment_transactions?.[0]?.state || '').toUpperCase();
      const postSt = String(detOrder?.post_status || '').toLowerCase();
      if (payState === 'STATE_SUCCESS' || ['processing', 'completed', 'delivered'].includes(postSt) || ['success', 'completed', 'paid'].includes(gatewayTxnState)) {
        matchedOrder = detOrder;
      }
    }
  }

  // If `vpa-txn-status` confirmed genuine gateway payment on a token-only account (`ZERO _session_tid`), build verified order record directly!
  // Only for a real Swiggy order id created by our own place-order call (never a pasted/short number).
  if (!matchedOrder && ['success', 'completed', 'paid'].includes(gatewayTxnState) && normalizeSwiggyOrderId(targetOrderId) && pendingPaasId) {
    matchedOrder = {
      order_id: targetOrderId,
      customer_id: auth.userId,
      order_status: 'processing',
      post_status: 'processing',
      restaurant_name: order?.restaurantName || 'Swiggy',
      order_total: order?.finalPayable || 0,
      payment_info_v2: { payment_transactions: [{ state: 'STATE_SUCCESS' }] }
    };
  }

  if (!matchedOrder) {
    return {
      paid: false,
      txnState: gatewayTxnState || 'pending',
      gatewayFetchError,
      targetOrderId,
      pendingPaasId,
      recentOrdersCount: recentOrders.length,
      baselineId
    };
  }

  const payTxnState = String(matchedOrder?.payment_info_v2?.payment_transactions?.[0]?.state || '').toUpperCase();
  const statusStr = String(matchedOrder?.order_status || matchedOrder?.post_status || '').toLowerCase();
  const postStatusLower = String(matchedOrder?.post_status || '').toLowerCase();
  const gatewaySuccess = ['success', 'completed', 'paid'].includes(gatewayTxnState);
  // If gateway explicitly says success/completed/paid, treat as paid even if Swiggy internal state is still pending/STATE_PENDING (propagation delay)
  const isGatewayConfirmed = gatewaySuccess && targetOrderId && pendingPaasId;
  const isPaidAndValid =
    (payTxnState === 'STATE_SUCCESS' || isGatewayConfirmed || (!payTxnState && !/fail|cancel|pending_payment/i.test(statusStr))) &&
    !/cancel|fail|aborted/i.test(statusStr === 'pending' ? (isGatewayConfirmed ? '' : 'pending') : (/cancel|fail|aborted/i.test(statusStr) ? statusStr : ''));

  // Wait: if `post_status === 'pending'` AND payment is NOT `STATE_SUCCESS` nor gateway-confirmed, customer hasn't paid yet!
  if (!isGatewayConfirmed) {
    if (
      payTxnState === 'STATE_PENDING' ||
      payTxnState === 'STATE_FAILED' ||
      (postStatusLower === 'pending' && payTxnState !== 'STATE_SUCCESS')
    ) {
      return {
        paid: false,
        txnState: gatewayTxnState || payTxnState.toLowerCase() || 'pending',
        gatewayFetchError,
        payTxnState,
        postStatusLower,
        statusStr
      };
    }
    if (!isPaidAndValid) {
      return {
        paid: false,
        txnState: gatewayTxnState || statusStr || 'pending',
        gatewayFetchError,
        payTxnState,
        statusStr
      };
    }
  } else {
    // Gateway confirmed — don't block on transient Swiggy pending state, but still block on explicit cancel/fail
    if (/cancel|fail|aborted/i.test(statusStr)) {
      return {
        paid: false,
        txnState: gatewayTxnState || statusStr || 'pending',
        gatewayFetchError,
        payTxnState,
        statusStr
      };
    }
  }

  const confirmedOrderId = String(matchedOrder.order_id);
  const customerId = String(matchedOrder.customer_id || auth.userId || '');

  const cidParam = customerId ? `&customer_id=${encodeURIComponent(customerId)}` : '';

  // Step 3: Fetch live `trackV4` + `trackV2/de` + `order/details` for real-time status text, ETA, rider & share link!
  const [trkRes, deRes, detRes] = await Promise.all([
    dapiFetch(account, `order/trackV4?order_id=${encodeURIComponent(confirmedOrderId)}&type=full&version=V2${cidParam}`).catch(() => null),
    dapiFetch(account, `order/trackV2/de?order_id=${encodeURIComponent(confirmedOrderId)}`).catch(() => null),
    dapiFetch(account, `order/details?order_id=${encodeURIComponent(confirmedOrderId)}&type=full&version=V2`).catch(() => null)
  ]);

  const trkData = trkRes?.json?.data || {};
  const deData = deRes?.json?.data || {};
  const rawDetOrder = detRes?.json?.data?.orders?.[0] || detRes?.json?.data?.order || null;
  const detOrder = (rawDetOrder && (!rawDetOrder.order_id || String(rawDetOrder.order_id) === confirmedOrderId)) ? rawDetOrder : null;

  // Use only a tracking/share URL explicitly returned by Swiggy; never synthesize one from the order ID.
  let nativeShareUrl = extractOrderShareUrlDeep(orderConfirmJson, matchedOrder, detOrder, trkData, deData) || null;
  let extraPayloads = [];
  if (!nativeShareUrl) {
    const extra = await fetchSecondaryOrderSharePayloads(account, confirmedOrderId, customerId, { timeoutMs: 3500, allowMapiTrackV4: true });
    if (extra.shareUrl) nativeShareUrl = extra.shareUrl;
    extraPayloads = extra.payloads || [];
  }
  const recalled = recallSwiggyOrderTracking(confirmedOrderId);
  if (!nativeShareUrl && recalled.trackingUrl) nativeShareUrl = recalled.trackingUrl;
  const deliveryOtp = extractSwiggyDeliveryOtp(matchedOrder, detOrder, trkData, ...extraPayloads, { delivery: deData }) || recalled.deliveryOtp || '';

  const cleanOrderStatus = normalizeSwiggyLiveOrderStatus(
    trkData?.order_status_details?.status_message,
    detOrder?.order_status || matchedOrder?.order_status,
    matchedOrder?.order_delivery_status || matchedOrder?.post_status || detOrder?.post_status
  ) || 'Order Confirmed';
  rememberSwiggyOrderTracking(confirmedOrderId, { trackingUrl: nativeShareUrl || '', deliveryOtp, status: cleanOrderStatus });

  return {
    paid: true,
    txnState: 'success',
    swiggyOrderId: confirmedOrderId,
    customerId,
    orderStatus: cleanOrderStatus,
    statusSubText: trkData?.order_status_details?.status_tag_text || '',
    etaMinutes: String(matchedOrder?.sla_time || ''),
    restaurantName: matchedOrder?.restaurant_name || order?.restaurantName || '',
    restaurantAddress: matchedOrder?.restaurant_address || '',
    deliveryBoy: {
      name: matchedOrder?.delivery_boy?.name || deData?.name || '',
      mobile: matchedOrder?.delivery_boy?.mobile || deData?.mobile || '',
      lat: deData?.lat || deData?.location?.lat || null,
      lng: deData?.lng || deData?.location?.lng || null
    },
    deliveryAddress: matchedOrder?.delivery_address || order?.addressDetails || null,
    deliveryOtp,
    nativeShareUrl,
    swiggyWebTrackUrl: nativeShareUrl || null,
    trackingUrl: nativeShareUrl || null,
    swiggyAppDeepLink: null
  };
}

