import {
  buildSwiggyAndroidClientHeaders, buildSwiggyCartItemsPayload, buildOfoCartFields,
  dapiFetch, fetchAccountAddresses, fetchSwiggyAndroidProfile, getSwiggySessionAuth, isValidIndianDeliveryCoordinates,
  parseDapiCartPayload, resolveSharedOfoAddress, saveAddressToAccount,
  swiggyCartGet, swiggyCartUpdate, applySwiggyCartCoupon, verifySwiggySessionLive, withSwiggyAccountLock,
  checkRealSwiggyPaymentAndExtractTracking, detectOfoFromPlaceResponse, normalizeSwiggyOrderId,
  extractSwiggyProvidedTrackingUrl, extractSwiggyDeliveryOtp, isZeroSmsTestSandboxActive,
  extractDeepLinkFromReferrerOrUrl, fetchLiveGroupCart, resolveSwiggyLink, callSwiggyFoodMcpTool,
  fetchSwiggyTrackingLinkFast
} from './swiggy-cart.js';
import { scanRecipientSmsEvidence } from './tracking-truth.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { activateAllEventOffers } from './event-offers.js';
import { getDb } from './store.js';
import crypto from 'node:crypto';
import { sameCartItems, sameDeliveryRecipient, exactPaise } from './swiggy-cart-integrity.js';
import { executeSingleSwiggyPlacement } from './swiggy-placement-journal.js';
import { planQrGeneration } from './qr-generation-plan.js';
export { sameCartItems, sameDeliveryRecipient } from './swiggy-cart-integrity.js';

const bootFetch = globalThis.fetch;

function unavailable(message) {
  const e = new Error(message);
  e.statusCode = 502;
  return e;
}
function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function coords(address) {
  if (!isValidIndianDeliveryCoordinates(address?.lat, address?.lng)) {
    const e = new Error('Select an address with a verified map location first.');
    e.statusCode = 400;
    throw e;
  }
  return { lat: String(address.lat), lng: String(address.lng) };
}

function imageUrl(id) {
  const value = String(id || '');
  return /^[\w./-]{1,300}$/.test(value)
    ? 'https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_300,h_300,c_fill/' + value
    : '';
}

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 18) return;
  visit(node);
  if (Array.isArray(node)) node.forEach(n => walk(n, visit, depth + 1));
  else Object.values(node).forEach(n => walk(n, visit, depth + 1));
}

function successCode(value) { return value === 0 || value === '0'; }

function optionalBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

async function discovery(account, route, lat, lng) {
  try {
    const auth = await getSwiggySessionAuth(account);
    if (!auth || (!auth.jwtTid && !auth.token)) return null;
    const response = await fetch(`https://disc.swiggy.com/api/v1/${route}`, {
      headers: buildSwiggyAndroidClientHeaders(account, {
        tid: auth.jwtTid, token: auth.token, sid: auth.sid, deviceId: auth.deviceId, userId: auth.userId, lat, lng
      }),
      signal: AbortSignal.timeout(6000)
    });
    const payload = await response.json().catch(() => null);
    return response.ok && successCode(payload?.statusCode) && payload?.data ? payload : null;
  } catch { return null; }
}

function searchRestaurants(json) {
  const result = [];
  const seen = new Set();
  walk(json?.data, (node) => {
    const info = node?.restaurant?.info || node?.info;
    if (!info || !info.id || !info.name || seen.has(String(info.id))) return;
    if (!info.sla && !Array.isArray(info.cuisines)) return;
    seen.add(String(info.id));
    const avail = info.availability || {};
    const open = info.isOpen ?? avail.opened;
    result.push({
      id: String(info.id), name: String(info.name), image: imageUrl(info.cloudinaryImageId),
      rating: String(info.avgRatingString || info.avgRating || ''),
      ratings: String(info.totalRatingsString || ''),
      cuisines: Array.isArray(info.cuisines) ? info.cuisines.join(', ') : '',
      area: String(info.areaName || info.locality || ''),
      distance: String(info.sla?.lastMileTravelString || ''),
      time: String(info.sla?.slaString || ''),
      isOpen: optionalBoolean(open),
      opens: String(avail.nextOpenTimeMessage || '')
    });
  });
  return result.slice(0, 100);
}

function dishInfo(info) {
  if (!info?.id || !info?.name || !/^\d+$/.test(String(info.id)) || !Number.isSafeInteger(Number(info.id))) return null;
  const pricePaise = Number(info.finalPrice ?? info.price ?? info.defaultPrice ?? 0);
  const variants = info.variantsV2?.variantGroups || info.variants_v2?.variant_groups || info.variants?.variantGroups || [];
  const addons = info.addons || [];
  const customizable = (Array.isArray(variants) && variants.length > 0) || (Array.isArray(addons) && addons.length > 0);
  const stock = optionalBoolean(info.inStock);
  const veg = optionalBoolean(info.isVeg);
  return {
    id: String(info.id), name: String(info.name),
    price: Number.isFinite(pricePaise) && pricePaise > 0 ? Math.round(pricePaise) / 100 : null,
    description: String(info.description || ''), image: imageUrl(info.imageId || info.cloudinaryImageId),
    inStock: stock, isVeg: veg, customizable,
    offer_ids: Array.isArray(info.offerIds) ? info.offerIds : [],
    item_offer_cart_meta: String(info.itemOfferCartMeta || '')
  };
}

function parseMenu(json, restaurantId) {
  let info = null;
  const categories = [];
  const names = new Set();
  const cards = json?.data?.cards || [];
  for (const card of cards) {
    const candidate = card?.card?.card?.info;
    if (candidate?.name && (candidate.id || candidate.cuisines)) { info = candidate; break; }
  }
  walk(cards, (node) => {
    if (!Array.isArray(node.itemCards)) return;
    const items = node.itemCards.map(it => dishInfo(it?.card?.info || it?.info)).filter(Boolean);
    if (!items.length) return;
    const title = String(node.title || 'Menu');
    if (names.has(title)) return;
    names.add(title);
    categories.push({ title, items });
  });
  if (!info || !categories.length) throw unavailable('Swiggy did not return a usable restaurant menu.');
  const opened = info.isOpen ?? info.availability?.opened;
  return {
    restaurant: {
      id: String(info.id || restaurantId), name: String(info.name),
      area: String(info.areaName || info.locality || ''),
      rating: String(info.avgRatingString || info.avgRating || ''),
      ratings: String(info.totalRatingsString || ''),
      time: String(info.sla?.slaString || ''),
      isOpen: optionalBoolean(opened),
      opens: String(info.availability?.nextOpenTimeMessage || ''), image: imageUrl(info.cloudinaryImageId)
    }, categories
  };
}

// Short links are followed without credentials and only to these Swiggy hosts.
// This avoids exposing account cookies to redirects or using a link as SSRF.
/**
 * Round 34: address confirm kitni der maanya jaye. 10 minute me user ka wahi
 * address/phone/street phir se badalna nahi hota; isse bill ke 2 Swiggy call
 * bach jate hain. Har confirm ke baad fingerprint (naam+phone+street+pin) match
 * hona zaroori hai — andaza nahi.
 */
const ADDRESS_CONFIRM_TTL_MS = Math.max(60_000, Math.min(Number(process.env.PRO_ADDRESS_CONFIRM_TTL_MS) || 10 * 60_000, 60 * 60_000));
export function addressFingerprint(address = {}) {
  const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [norm(address.name), norm(address.mobile), norm(address.flat_no), norm(address.address || address.area), norm(address.pin || address.pincode)].join('|');
}

const SHARE_HOSTS = new Set(['swig.gy', 'swiggy.onelink.me', 'www.swiggy.com', 'swiggy.com', 'm.swiggy.com']);
function shareUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw badRequest('Paste a valid Swiggy share link.'); }
  if (url.protocol !== 'https:' || !SHARE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443')) {
    throw badRequest('Only HTTPS Swiggy share links are accepted.');
  }
  return url;
}

export async function expandProShareLink(raw) {
  let current = shareUrl(raw).toString();
  for (let i = 0; i < 4; i++) {
    const deep = extractDeepLinkFromReferrerOrUrl(current);
    if (deep && (/\/ofo\/address\/|\/gc\//i.test(deep))) return deep;
    const url = shareUrl(current);
    if (url.hostname === 'www.swiggy.com' || url.hostname === 'swiggy.com') return current;
    let response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(4500), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
    } catch { return current; }
    const location = response.headers.get('location');
    if (!location) return current;
    const resolved = new URL(location, current).toString();
    const resolvedDeep = extractDeepLinkFromReferrerOrUrl(resolved);
    if (resolvedDeep && (/\/ofo\/address\/|\/gc\//i.test(resolvedDeep))) return resolvedDeep;
    try { current = shareUrl(resolved).toString(); } catch { return current; }
  }
  return current;
}

/**
 * Boss (31-10-2026): "CART KO BHI PARSE NAHI KAR PAA RAHA SALA."
 *
 * Swiggy group cart link sirf ek shakal me nahi aata. Yahan sabse pehle koi
 * network call ke bina, plain text se hi cart id nikaal lete hain:
 *   1. https://www.swiggy.com/gc/<x>/<slug>-<cartId>      (web share — purana)
 *   2. https://www.swiggy.com/gc/<cartId>                 (chhota web link)
 *   3. ...?sharedCartId= / ?groupCartId= / ?shared_cart_id= (query wale)
 *   4. swiggy://gc?... / swiggy://share?text=<encoded url>  (app deep link)
 *   5. swig.gy / swiggy.onelink.me short link  → resolveGroupCartLink expand karta hai
 * Kuch bhi match na ho to `null` — jhootha cart id kabhi nahi.
 */
const GROUP_CART_QUERY_KEYS = ['sharedCartId', 'shared_cart_id', 'groupCartId', 'group_cart_id', 'groupcartid', 'cartId', 'cart_id', 'sharedCart', 'shared_cart'];
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
export function extractGroupCartRef(raw) {
  const original = String(raw || '').trim();
  if (!original || original.length > 4000) return null;
  // URL-encoded ya swiggy://share?text=... ke andar chhupa hua link bhi kholte hain.
  const variants = [original, safeDecode(original)];
  const deep = (() => { try { return new URL(original).searchParams.get('text') || ''; } catch { return ''; } })();
  if (deep) variants.push(safeDecode(deep));
  const text = variants.join('\n');

  // 1 & 2: /gc/ path — trailing number hi group cart id hai (jaise pehle tha).
  const pathMatch = text.match(/\/gc\/([A-Za-z0-9_-]{1,40})(?:\/(?:[^/?#\s]*-)?(\d{1,20}))?/i);
  if (pathMatch) {
    const cartId = pathMatch[2] || (/^\d{1,20}$/.test(pathMatch[1]) ? pathMatch[1] : '');
    if (cartId) return { cartId, restaurantId: pathMatch[2] ? pathMatch[1] : '', shape: 'gc-path' };
  }
  // 3 & 4: query / deep-link parameters.
  for (const key of GROUP_CART_QUERY_KEYS) {
    const match = text.match(new RegExp(`[?&#;]${key}=([A-Za-z0-9_-]{1,40})`, 'i'));
    if (match && /\d/.test(match[1])) {
      const restaurantMatch = text.match(/[?&#;](?:restaurantId|restaurant_id)=(\d{1,20})/i);
      return { cartId: match[1], restaurantId: restaurantMatch ? restaurantMatch[1] : '', shape: 'gc-query' };
    }
  }
  return null;
}

/**
 * Sirf Swiggy ke host ya bare text (bina host) se seedha parse karte hain —
 * kisi doosre host ka `/gc/1/x-2` jaisa text jhootha cart id na ban jaye.
 */
function groupCartTextAllowed(text) {
  const value = String(text || '').trim();
  if (/^swiggy:\/\//i.test(value)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  try { return SHARE_HOSTS.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
}

/** Link ko samajhne ki ek hi jagah — short link pehle expand hota hai. */
export async function resolveGroupCartLink(raw) {
  const direct = groupCartTextAllowed(raw) ? extractGroupCartRef(raw) : null;
  if (direct) return { ...direct, expanded: String(raw).trim() };
  let expanded = '';
  try {
    expanded = await expandProShareLink(raw);
  } catch (err) {
    // shareUrl ka apna saaf message (http / doosra host) — wahi dikhao.
    throw badRequest(`${err?.message || 'Link padha nahi ja saka.'} Swiggy ka group cart link paste karein (swiggy.com/gc/... ya app ka Share link).`);
  }
  const ref = extractGroupCartRef(expanded);
  if (ref) return { ...ref, expanded };
  // Akhri raasta: bot ka battle-tested resolver. Ye AppsFlyer ke HTML page,
  // swiggy://webviewV2?group_cart_id=… aur af_dp/deep_link_value wale share
  // link bhi padh leta hai — inhi par "cart parse nahi hua" hota tha.
  const vendor = await resolveSwiggyLink(String(raw).trim()).catch(() => null);
  if (vendor?.groupCartId) {
    return {
      cartId: String(vendor.groupCartId),
      restaurantId: String(vendor.restaurantId || ''),
      hostName: String(vendor.hostName || ''),
      shape: 'vendor-resolve',
      expanded: String(vendor.url || expanded)
    };
  }
  throw badRequest(`Is link me group cart ki ID nahi mili. Chahiye: swiggy.com/gc/<id>, ?sharedCartId=<id>, swiggy:// deep link, ya app ka Share link. Mila: ${String(raw).slice(0, 120)}`);
}

// Compare the item IDs, quantities AND selected add-ons/variants, not just
// the number of items. Otherwise a customized group-cart meal could silently
// become a different meal while the Mini App claims the bill was verified.


function checkoutLockKey(account) {
  const phone = normalizeIndianMobileNumber(account.phone || account.mobile || '');
  const customerId = String(account.customerId || account.userId || '').trim();
  // The same Swiggy account can be present in the boss vault and a private
  // workspace. Coordinate with the bot's existing per-account lock, without
  // ever borrowing the boss account or returning it to the user.
  const shared = Object.entries(getDb().config?.accounts || {}).find(([, candidate]) =>
    (phone && normalizeIndianMobileNumber(candidate?.phone || candidate?.mobile || '') === phone) ||
    (customerId && String(candidate?.customerId || candidate?.userId || '').trim() === customerId)
  );
  const fallback = customerId || phone || crypto.createHash('sha256').update(String(account.token || account.tid || '')).digest('hex').slice(0, 20);
  return shared?.[0] || `pro:${fallback}`;
}

// Extract only values actually returned by the provider. Never manufacture a
// merchant UPI URI, order ID or transaction reference.
function placementDetails(json) {
  const data = json?.data?.order_data || json?.data?.orderData || json?.data || {};
  const findIntent = (value, depth = 0) => {
    if (depth > 15 || !value) return '';
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^upi:\/\/pay\?/i.test(text)) return text;
      if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try { return findIntent(JSON.parse(text), depth + 1); } catch {}
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const child of Object.values(value)) {
      const found = findIntent(child, depth + 1);
      if (found) return found;
    }
    return '';
  };
  // Boss (31-10-2026, round 12): "QR NAHI AYA". Swiggy kabhi intent ko
  // `app_redirection_info` se bahar (payment_fallbacks / HTML-escaped text /
  // nested order_data) bhejta hai. Sirf structured field dekhna hi QR na aane
  // ki wajah thi — ab poore jawab me text-scan bhi hota hai (jaisa bot karta hai).
  const findIntentInText = (value) => {
    let text = '';
    try { text = JSON.stringify(value); } catch { return ''; }
    const matches = String(text).match(/upi:\/\/pay\?[^"'\\\s<]+/g) || [];
    for (const raw of matches) {
      const decoded = raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (/[?&]pa=/.test(decoded)) return decoded;
    }
    return '';
  };
  const findHttpPaymentLink = (value) => {
    let text = '';
    try { text = JSON.stringify(value); } catch { return ''; }
    const matches = String(text).match(/https:\/\/[^"'\\\s<]+/g) || [];
    const link = matches.find(u => /(?:^|\/)(?:payments?|upi|pay)\b/i.test(u) && !/swiggy\.com\/(?:orders|ofo\/track)/i.test(u));
    return link ? String(link).replace(/\\u0026/g, '&').replace(/\\\//g, '/') : '';
  };
  let redirect = data.app_redirection_info || data.appRedirectionInfo || null;
  if (typeof redirect === 'string') { try { redirect = JSON.parse(redirect); } catch { redirect = null; } }
  const paymentFallbacks = json?.data?.payment_fallbacks || data.payment_fallbacks || json?.data?.order_data?.payment_fallbacks || null;
  return {
    orderId: normalizeSwiggyOrderId(data.order_id || data.orderId || ''),
    upiIntentUrl: findIntent(json) || findIntentInText(json),
    paymentFallbacks,
    paymentPageUrl: findHttpPaymentLink(paymentFallbacks) || '' ,
    paymentTxnId: String(data.targeted_marketplace_payment_reference_id ||
      data.payment_info_v2?.payment_transactions?.[0]?.marketplace_reference_id ||
      redirect?.upiRedirect?.upiIntentRedirect?.transactionId || '').slice(0, 200)
  };
}

/**
 * Boss (31-10-2026, round 15): "qr nahi aata".
 * Kabhi Swiggy place-response me intent nahi bhejta par uske **apne** payment
 * page (payment_fallbacks ka URL) par UPI link hota hai. Wahi page se intent
 * nikaalne ki koshish — sirf Swiggy ke apne jawab se, apna QR kabhi nahi
 * banate. Fail ho to chup-chaap `''` (jhooth nahi).
 */
async function recoverUpiIntentFromPaymentPage(account, url, { timeoutMs = 4000 } = {}) {
  if (!/^https:\/\//i.test(String(url || ''))) return '';
  try {
    const cookies = String(account?.cookies || account?.cookie || '').trim();
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(cookies ? { cookie: cookies } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!text) return '';
    const unescaped = text
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');
    const match = unescaped.match(/upi:\/\/pay\?[^"'\s<]+/i);
    return match ? match[0] : '';
  } catch {
    return '';
  }
}

function attemptedPlacementError(message, code, orderId = '') {
  const err = unavailable(message);
  err.code = code;
  err.diag = { code, placementAttempted: true, placedOrderId: normalizeSwiggyOrderId(orderId) };
  return err;
}

export const proProvider = {
  async verifySession(account) {
    const live = await verifySwiggySessionLive(account);
    if (!live?.valid) return { valid: false };
    // A successful guest cart response is not proof of an authenticated user.
    // Require an actual non-guest customer ID returned by Swiggy's profile.
    let profile = await fetchSwiggyAndroidProfile(account, { timeoutMs: 6500 }).catch(() => null);
    if (!profile?.customerId) {
      const web = await dapiFetch(account, 'profile/info', { timeoutMs: 6500 }).catch(() => null);
      const info = web?.status === 200 && successCode(web?.json?.statusCode) ? web.json.data : null;
      if (info?.customer_id) profile = { customerId: String(info.customer_id), name: info.name || '', phone: info.mobile || info.phone || '' };
    }
    const id = String(profile?.customerId || '');
    if (!id || id === '0' || id === '-1') return { valid: false };
    return { ...live, valid: true, customerId: id, name: profile.name || live.name || '', phone: profile.phone || live.phone || '' };
  },
  addresses: fetchAccountAddresses,
  async resolveAddress(account, link) {
    const original = shareUrl(link);
    if (original.hostname === 'swig.gy') throw badRequest('This is not a Swiggy address link.');
    const expanded = await expandProShareLink(link);
    const match = expanded.match(/\/ofo\/address\/([^/?#]+)\/([^/?#&]+)/i);
    const short = original.hostname === 'swiggy.onelink.me' ? original.pathname.match(/^\/[^/]+\/([^/?#]+)/) : null;
    const token = match?.[2] || short?.[1];
    if (!token) throw badRequest('Could not find an address in this link. Please check and try again.');
    const name = match ? decodeURIComponent(match[1]) : null;
    // Boss (31-10-2026): "ADDRESS FETCH NA HORAHA". Mini App ke naye logins
    // Android token sessions hote hain jinme web cookie (`_session_tid`) nahi
    // hoti, isliye /dapi/social/getAddress unke saath 401 deta hai — link
    // kharab nahi hota. Pehle user ke apne session se try karo, phir server ke
    // apne web sessions se (address link sirf padhne ke liye hai aur wahi
    // content user ne khud bheja hai), phir share page se.
    let found = await resolveSharedOfoAddress(token, name, account);
    if (!found && account) found = await resolveSharedOfoAddress(token, name, null);
    if (!found || !found.address || !isValidIndianDeliveryCoordinates(found.lat, found.lng)) {
      const err = unavailable('Address link se pura address nahi mila. Neeche diya step follow karein aur dobara try karein — link expire maan kar naya address banane ki zaroorat nahi.');
      err.code = 'ADDRESS_INCOMPLETE';
      throw err;
    }
    return {
      // The legacy resolver uses the placeholder "Customer" when the link did
      // not return a name. Do not present that placeholder as an autofill.
      name: String(found.name || '').trim() === 'Customer' ? '' : String(found.name || ''), mobile: normalizeIndianMobileNumber(found.mobile) || '',
      address: String(found.address), area: String(found.area || ''), city: String(found.city || ''),
      flat_no: String(found.flat_no || ''), landmark: String(found.landmark || ''),
      lat: String(found.lat), lng: String(found.lng), annotation: String(found.annotation || 'OTHER')
    };
  },
  async search(account, address, query) {
    const { lat, lng } = coords(address);
    const path = `restaurants/search/v3?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&str=${encodeURIComponent(query)}&submitAction=ENTER&selectedPLTab=RESTAURANT`;
    let payload = await discovery(account, path, lat, lng);
    if (!payload) {
      const response = await dapiFetch(account, path, { lat, lng, timeoutMs: 8000 });
      if (response?.status === 200 && successCode(response?.json?.statusCode) && response.json.data) payload = response.json;
    }
    if (!payload) throw unavailable('Could not fetch restaurant search from Swiggy. Check the account session and try again.');
    return searchRestaurants(payload);
  },
  async menu(account, address, restaurantId) {
    const { lat, lng } = coords(address);
    const path = `menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&restaurantId=${encodeURIComponent(restaurantId)}`;
    let payload = await discovery(account, path, lat, lng);
    if (!Array.isArray(payload?.data?.cards)) {
      const response = await dapiFetch(account, path, { lat, lng, timeoutMs: 8000 });
      if (response?.status === 200 && successCode(response?.json?.statusCode)) payload = response.json;
    }
    if (!payload) throw unavailable('Swiggy menu could not be loaded.');
    return parseMenu(payload, restaurantId);
  },
  async groupCart(account, address, link) {
    // Group cart padhna address ke pin par depend nahi karta — lat/lng sirf
    // request headers ke liye hote hain. Address bhara na ho to bhi cart khule.
    let lat = '';
    let lng = '';
    try { ({ lat, lng } = coords(address)); } catch { /* default headers */ }
    const ref = await resolveGroupCartLink(link);
    const auth = await getSwiggySessionAuth(account);
    if (!auth?.jwtTid || !auth?.userId) throw unavailable('The selected Swiggy session could not be verified.');
    const normalizeItems = live => (live?.items || [])
      .filter(it => it && it.menu_item_id && Number(it.qty ?? it.quantity) > 0)
      .map(it => ({
        id: String(it.menu_item_id),
        menu_item_id: Number(it.menu_item_id),
        name: String(it.name || 'Item'),
        qty: Number(it.qty ?? it.quantity) || 1,
        price: it.price === null || it.price === undefined || !Number.isFinite(Number(it.price)) ? null : Number(it.price),
        lineTotal: it.lineTotal === null || it.lineTotal === undefined || !Number.isFinite(Number(it.lineTotal)) ? null : Number(it.lineTotal),
        // Vendor parser sirf `true` se veg confirm karta hai; `false` ka matlab
        // "veg nahi bataya" ho sakta hai — jhootha non-veg mark nahi lagate.
        isVeg: it.isVeg === true ? true : null,
        inStock: it.inStock === false ? false : true,
        variants: Array.isArray(it.variants) ? it.variants : [],
        addons: Array.isArray(it.addons) ? it.addons : [],
        offer_ids: Array.isArray(it.offer_ids) ? it.offer_ids : [],
        item_offer_cart_meta: String(it.item_offer_cart_meta || '')
      }));
    const cartShape = (live, items) => ({
      restaurantId: String(live?.restaurantId || ref.restaurantId || ref.cartId),
      restaurantName: String(live?.restaurantName || 'Restaurant'),
      restaurantArea: String(live?.areaName || ''),
      groupCartId: String(live?.groupCartId || ref.cartId),
      items
    });
    // (1) Bot ka proven engine: chkout `shared_cart/join` (ephemeral reader user
    // id) + read-only GET. Isse doosre customer ka group cart bhi khulta hai aur
    // "USER_ALREADY_PART_OF_GROUP_CART" (statusCode 86) nahi aata — yahi wajah
    // thi ki mini app "cart fetch nahi hua" bolta tha.
    const live = await fetchLiveGroupCart(ref.cartId, ref.restaurantId || null, ref.hostName || null, account, lat, lng).catch(() => null);
    const liveItems = normalizeItems(live);
    if (liveItems.length) return cartShape(live, liveItems);
    if (live?.status === 'EXPIRED') {
      const e = unavailable('Ye group cart ab band ho chuka hai (Swiggy ne "no longer exists" kaha). Host se naya group cart link maangein.');
      e.code = 'GROUP_CART_EXPIRED';
      throw e;
    }
    if (live?.status === 'PLACED') {
      const e = unavailable('Is group cart ka order pehle hi place ho chuka hai. Naya group cart banwaiye.');
      e.code = 'GROUP_CART_PLACED';
      throw e;
    }
    // (2) Seedha read-only GET (purana raasta) — engine sirf join ke bina bhi
    // kaam kare to yahan se sach milta hai.
    const response = await fetch(`https://chkout.swiggy.com/api/v1/shared_cart?group_cart_id=${encodeURIComponent(ref.cartId)}`, {
      headers: buildSwiggyAndroidClientHeaders(account, { tid: auth.jwtTid, token: auth.token, sid: auth.sid, deviceId: auth.deviceId, userId: auth.userId, lat: lat || '17.385044', lng: lng || '78.486671' }),
      signal: AbortSignal.timeout(8000)
    });
    const json = await response.json().catch(() => null);
    const data = json?.data;
    const items = [];
    for (const participant of Object.values(data?.user_cart_map || {})) {
      for (const it of participant?.user_cart || []) {
        if (!it.menu_item_id || !(Number(it.quantity) > 0)) continue;
        const qty = Number(it.quantity);
        const raw = Number(it.subtotal ?? Number(it.base_price || 0) * qty);
        items.push({
          id: String(it.menu_item_id), menu_item_id: Number(it.menu_item_id), name: String(it.name || 'Item'), qty,
          price: Number.isFinite(raw) ? Math.round(raw / qty) / 100 : null,
          lineTotal: Number.isFinite(raw) ? Math.round(raw) / 100 : null,
          isVeg: it.is_veg === 1 || it.is_veg === '1' || it.isVeg === 1 ? true : null,
          is_veg: it.is_veg,
          inStock: it.in_stock === 0 ? false : true,
          variants: Array.isArray(it.variants) ? it.variants : [], addons: Array.isArray(it.addons) ? it.addons : [],
          offer_ids: Array.isArray(it.offer_ids) ? it.offer_ids : [], item_offer_cart_meta: String(it.item_offer_cart_meta || '')
        });
      }
    }
    if (items.length) {
      return cartShape({
        restaurantId: String(data?.restaurant_details?.restaurant_id || ref.restaurantId || ref.cartId),
        restaurantName: String(data?.restaurant_details?.restaurant_name || 'Restaurant'),
        areaName: String(data?.restaurant_details?.area_name || '')
      }, items);
    }
    // Asli wajah — HTTP + Swiggy ka apna statusCode/statusMessage, chhupata nahi.
    const statusCode = json?.statusCode;
    const statusMessage = String(json?.statusMessage || (json?.errorCodes || []).join(', ') || '').slice(0, 180);
    const engineNote = String(live?.statusMessage || '').slice(0, 180);
    const e = unavailable(`Swiggy ne is group cart par item nahi diye (HTTP ${response.status}${statusCode !== undefined && statusCode !== null ? `, statusCode ${statusCode}` : ''}${statusMessage ? `: ${statusMessage}` : ''}${!statusMessage && engineNote ? `: ${engineNote}` : ''}). Mitti me cart band ho sakta hai ya link ka cart id galat hai — host se taaza link maangein.`);
    e.code = statusCode === 88 ? 'GROUP_CART_EXPIRED' : statusCode === 86 ? 'GROUP_CART_BUSY' : 'GROUP_CART_FETCH_FAILED';
    throw e;
  },

  /**
   * Boss (31-10-2026): "MUJHE OPTION DETA HAI COUPON CHOOSE KARNE KA." Coupon
   * page ke liye asli list — Swiggy ke apne coupon tool se. Jo code Swiggy ne
   * nahi diya wo hum banate nahi; list khaali aaye to saaf bata dete hain.
   */
  /**
   * Boss (31-10-2026, round 8): "COUPON AVAILABLE NAHI HAI MAT BOLO — WO HAMESHA
   * HOTA HAI. OPTION DO, CODE TYPE KARNE KA NAHI — SIRF APPLY."
   *
   * Pehle Swiggy ke apne coupon tool se asli list. Uske baad wahi promo codes jo
   * bot ka apna engine hamesha test karta hai (SNACKIT/TRYNEW/STEALDEAL/
   * SWIGGYIT/WELCOME50). Ye "guaranteed discount" ka dawa nahi hai — APPLY par
   * asli bill aata hai aur tabhi discount dikhta hai jab Swiggy deta hai.
   */
  async coupons(account, address, restaurantId) {
    const rid = String(restaurantId || '').trim();
    if (!/^\d{1,20}$/.test(rid)) throw badRequest('Pehle cart ya restaurant kholein — restaurant id chahiye.');
    const addressId = String(address?.id || address?.addressId || '').trim();
    const found = new Map();
    const push = (code, title, description, meta = {}) => {
      const key = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,28}$/.test(key)) return;
      const previous = found.get(key);
      if (previous?.source === 'swiggy' && meta.source !== 'swiggy') return;
      found.set(key, {
        code: key,
        title: String(title || key).slice(0, 90),
        description: String(description || '').slice(0, 200),
        applicable: meta.applicable === false ? false : true,
        reason: String(meta.reason || '').slice(0, 140),
        source: meta.source === 'swiggy' ? 'swiggy' : 'promo'
      });
    };
    let discovery = false;
    // Address ke coords na hon to bhi coupon list khaali nahi dikhegi —
    // sirf lat/lng wale sources chhoot jayenge (MCP + promo chalenge).
    let lat = '', lng = '';
    try { ({ lat, lng } = coords(address || {})); } catch { lat = ''; lng = ''; }
    // Boss (31-10-2026, round 14): coupon page wahi list dikhaye jo bill engine
    // use karta hai — MCP coupons, auto-suggested, /offers/payment,
    // /offers/restaurant. Pehle sirf MCP + 5 promo the.
    const [mcp, mcpCart, offersPay, offersRest] = await Promise.all([
      callSwiggyFoodMcpTool(account, 'fetch_food_coupons', { restaurantId: rid, ...(addressId ? { addressId } : {}) }, 6000).catch(() => null),
      callSwiggyFoodMcpTool(account, 'get_food_cart', { addressId }, 4000).catch(() => null),
      lat && lng
        ? dapiFetch(account, `offers/payment?lat=${lat}&lng=${lng}&restaurantId=${rid}&restaurant_id=${rid}&sourcePage=cart&source_page=cart&page_type=PAYMENT_OFFERS_PAGE`, { lat, lng, timeoutMs: 4000 }).catch(() => null)
        : Promise.resolve(null),
      lat && lng
        ? dapiFetch(account, `offers/restaurant?lat=${lat}&lng=${lng}&restaurantId=${rid}`, { lat, lng, timeoutMs: 4000 }).catch(() => null)
        : Promise.resolve(null)
    ]);
    const list = Array.isArray(mcp?.structured?.coupons) ? mcp.structured.coupons : [];
    for (const cp of list) {
      push(cp?.coupon_code || cp?.couponCode || cp?.code || '', cp?.title || cp?.header || cp?.coupon_code, cp?.description || cp?.subtitle || '', {
        applicable: cp?.is_applicable !== false && cp?.applicable !== false,
        reason: cp?.ineligible_reason || cp?.reason || '',
        source: 'swiggy'
      });
    }
    discovery = Boolean(mcp?.ok) || list.length > 0;
    const suggested = mcpCart?.structured?.offers?.coupon_applied || mcpCart?.structured?.coupon_code || mcpCart?.structured?.data?.coupon_code || '';
    if (suggested) {
      push(suggested, 'Swiggy ka best suggested coupon', 'Swiggy khud is bill ke liye ye suggest karta hai', { source: 'swiggy' });
      discovery = true;
    }
    for (const [blob, label] of [[offersPay?.json, 'Payment page offer'], [offersRest?.json, 'Restaurant offer']]) {
      if (!blob) continue;
      let text = '';
      try { text = JSON.stringify(blob); } catch { continue; }
      for (const m of text.matchAll(/"coupon_?code"\s*:\s*"([A-Za-z0-9_]{3,25})"/g)) {
        push(m[1], label, 'Swiggy ke live offer se', { source: 'swiggy' });
        discovery = true;
      }
    }
    // Bot ka engine inhe har order par test karta hai — isliye list kabhi
    // khaali nahi dikhti aur user ko "coupon nahi hai" nahi bolna padta.
    for (const code of ['SNACKIT', 'TRYNEW', 'STEALDEAL', 'SWIGGYIT', 'WELCOME50', 'FLAT150', 'MEALDEAL', 'DELULU4FOOD']) {
      push(code, code === 'SNACKIT' ? 'Snackit offer' : 'Swiggy promo code', 'Swiggy ke promo code — APPLY karke asli bill dekhein', { source: 'promo' });
    }
    const all = [...found.values()];
    const rank = c => (c.source === 'swiggy' ? 0 : 10) + (c.applicable === false ? 5 : 0);
    const coupons = all.sort((a, b) => rank(a) - rank(b)).slice(0, 24);
    return {
      restaurantId: rid,
      coupons,
      discovery,
      note: 'APPLY dabaiye — Swiggy par asli bill aayega. Discount tabhi dikhega jab Swiggy deta hai; jo code lagta nahi uski asli wajah dikh jayegi.'
    };
  },

  /**
   * Bot wala ASLI offer engine (boss 31-10-2026, round 14):
   *   "na delivery fee off ho raha, na ₹50 off wala coupon lag raha."
   *
   * Pehle Mini App ka bill sirf cart push + 3 coupon try karta tha. Bot ke
   * engine me ye sab hota hai — ab bilkul wahi rasta, isi order me:
   *   1. ₹50-off (event) offers claim — free cash bill me aata hai
   *   2. Swiggy One Lite (+₹1) auto-add — delivery FREE (sirf jab total kam ho)
   *   3. Poori coupon discovery: MCP coupons + auto-suggested + /offers/payment
   *      + /offers/restaurant + promo codes
   *   4. Har coupon ka ASLI bill compare — sabse kam total wala hi rehta hai
   *
   * Har step time-bounded hai (koi stall nahi) aur jo na ho sake uska sach
   * `engine` field me jaata hai — jhootha "sab lag gaya" nahi.
   */
  async quoteCart(account, address, cart, coupon, options = {}) {
    let engineAddressReused = false;
    const { lat, lng } = coords(address);
    if (!address.name || !normalizeIndianMobileNumber(address.mobile)) throw badRequest('Confirm the receiver name and 10-digit mobile number first.');
    const requestedCoupon = String(coupon || '').trim().toUpperCase();
    const autoCoupon = options.autoCoupon !== false && cart.autoCoupon !== false;
    // Round 33 (boss): "BILL CALCULATE HONE ME BAHUT TIME LAG RAHA HAI".
    // Ab bill do kadam me aata hai:
    //   phase 'fast' → sirf asli bill (address + cart + readback) — 4 calls.
    //   phase 'full' → uske baad offers/One Lite/coupon trials — bill sudhar
    //                  jata hai, par user ko pehla number turant dikh jata hai.
    // Dono me total SIRF Swiggy ka hota hai; andaaza kabhi nahi.
    // Default poora bill — sirf Mini App ka pehla sync `phase: 'fast'` maangta hai.
    const phase = options.phase === 'fast' ? 'fast' : 'full';
    const fast = phase === 'fast' && !requestedCoupon;
    // The chat handoff asks for a first, genuine bill without waiting for the
    // optional offer/One Lite search. It still saves and reads back the exact
    // address, cart and payable amount under the same account lock.
    const quickBill = cart.quickBill === true && !requestedCoupon;
    const budget = {
      // Boss ko speed chahiye par offers bhi — dono: discovery 2.5s, trials 9s.
      trialBudgetMs: Math.max(2_000, Math.min(Number(process.env.PRO_COUPON_BUDGET_MS) || 7_000, 15_000)),
      maxTrials: Math.max(1, Math.min(Number(process.env.PRO_COUPON_TRIALS) || 6, 10))
    };
    return withSwiggyAccountLock(checkoutLockKey(account), async () => {
      // ── Round 34 (boss): "MAKE THE CHECK OUT FASTER" ──────────────────────
      // Bill ke raste me sabse mehnga hissa address tha: har baar saveAddress
      // (POST) + addresses (GET) + readback. Ab:
      //   (a) agar wahi address pichhle kuch minute me confirm ho chuka hai
      //       (ws.cart.confirmedAddress), to dono call bach jate hain — par
      //       sirf tab jab naam/phone/street BLKUL wahi ho (andaza nahi);
      //   (b) warna ek hi GET me list laa kar saveAddress ko dete hain, aur
      //       agar wahi saved address reuse hua to dobara GET nahi.
      const addressDigest = addressFingerprint(address);
      const prior = cart.confirmedAddress && Number(cart.confirmedAddress.savedAt || 0) > Date.now() - ADDRESS_CONFIRM_TTL_MS
        && cart.confirmedAddress.fingerprint === addressDigest ? cart.confirmedAddress : null;
      let confirmedAddress = null;
      let addressId = '';
      if (prior && prior.id && sameDeliveryRecipient(address, prior)) {
        confirmedAddress = prior;
        addressId = String(prior.id);
        engineAddressReused = true;
      } else {
        const listed = await fetchAccountAddresses(account).catch(() => null);
        const saved = await saveAddressToAccount(account, address, Array.isArray(listed) ? listed : null);
        if (!saved?.addressId || !saved?.addressDetails) throw unavailable(saved?.error || 'Swiggy did not confirm the delivery address.');
        addressId = String(saved.addressId);
        if (Array.isArray(listed) && saved.createdNew !== true) {
          // Wahi purana saved address — list pehle hi aa chuki hai, readback done.
          const reused = listed.find(a => String(a.id || '') === addressId);
          if (reused && sameDeliveryRecipient(address, { ...reused, mobile: reused.mobile || reused.phone || '' })) {
            confirmedAddress = { ...reused, id: addressId, mobile: normalizeIndianMobileNumber(reused.mobile || reused.phone || '') };
          }
        }
        if (!confirmedAddress) {
          const savedList = await fetchAccountAddresses(account);
          confirmedAddress = savedList.find(a => String(a.id || '') === String(addressId));
        }
        if (!confirmedAddress || !sameDeliveryRecipient(address, confirmedAddress)) {
          throw unavailable('Swiggy did not read back the same receiver, street and location. No bill or order was created.');
        }
      }
      const itemsPayload = buildSwiggyCartItemsPayload(cart.items);
      const ofoFields = cart.forSomeoneElse ? buildOfoCartFields({ addressDetails: address }) : {};
      const engine = { offersClaimed: 0, offersNote: '', oneLite: 'not_tried', couponTrials: [], couponsSeen: 0, notes: [] };
      let lastReadback = null;
      let unconfirmedCartWrite = false;
      let cartInitialized = false;
      const pushTimeout = fast ? Math.max(4_000, Math.min(Number(process.env.PRO_FAST_BILL_TIMEOUT_MS) || 6_000, 15_000)) : 7_000;
      const acceptCart = (out) => {
        if (!successCode(out?.json?.statusCode)) {
          const msg = String(out?.json?.statusMessage || '').slice(0, 120) || `HTTP ${out?.status || '?'}`;
          throw unavailable(`Swiggy ne cart update reject kiya (${msg}).`);
        }
        const data = out?.json?.data;
        const meta = data?.cartMeta || data;
        const parsed = data ? parseDapiCartPayload(data) : null;
        if (!parsed || !meta || !Array.isArray(parsed.items)) throw unavailable('Swiggy did not confirm the cart. Refresh in Swiggy before trying again.');
        const boundAddress = String(meta.address_id || meta.delivery_address?.id || data.address_id || data.delivery_address?.id || '');
        if (!sameCartItems(cart.items, parsed.items) || boundAddress !== addressId) {
          throw unavailable('Swiggy returned different items or address. No bill is being shown; check the Swiggy cart.');
        }
        const total = Number(meta.order_total);
        if (exactPaise(total) === null || total <= 0) throw unavailable('Swiggy did not return a valid payable amount.');
        lastReadback = {
          parsed, meta, total,
          coupon: String(parsed?.couponCode || '').toUpperCase(),
          couponReason: String(out?.json?.statusMessage || parsed?.couponReason || '').slice(0, 140),
          originalTotal: Number(parsed?.itemTotal || meta.item_total || 0) + Number(parsed?.packingCharges || 0) + Number(parsed?.taxesAndCharges || 0)
        };
        return lastReadback;
      };
      const readCart = async (timeoutMs = 5000) => acceptCart(await swiggyCartGet(account, { lat, lng, timeoutMs }));
      const couponSettled = (snapshot, code) => code
        ? snapshot.coupon === code && Number(snapshot.parsed?.discountAmount || 0) > 0
        : !snapshot.coupon;
      const push = async ({ couponCode = '', subscriptionItems = [], timeoutMs = pushTimeout, clearCoupon = false } = {}) => {
        // Only the first write replaces the cart. Coupon/free-cash retries keep
        // the same cart, so they do not flush the reward that just landed.
        unconfirmedCartWrite = true;
        const code = String(couponCode || '').trim().toUpperCase();
        const out = await swiggyCartUpdate(account, {
          restaurantId: cart.restaurantId,
          address_id: addressId,
          couponCode: code,
          cartItems: itemsPayload,
          mealItems: [],
          subscriptionItems,
          ...ofoFields
        }, { lat, lng, flushFirst: !cartInitialized, timeoutMs });
        cartInitialized = true;
        if (!successCode(out?.json?.statusCode)) {
          const msg = String(out?.json?.statusMessage || '').slice(0, 120) || `HTTP ${out?.status || '?'}`;
          throw unavailable(`Swiggy ne cart update reject kiya (${msg}).`);
        }
        const data = out?.json?.data;
        const meta = data?.cartMeta || data;
        const parsed = data ? parseDapiCartPayload(data) : null;
        const usable = Boolean(successCode(out?.json?.statusCode) && parsed && meta &&
          Array.isArray(parsed.items) && parsed.items.length && exactPaise(Number(meta.order_total)) !== null);
        let snapshot = usable ? acceptCart(out) : await readCart(Math.min(timeoutMs, 6000));
        const needsApply = code && !couponSettled(snapshot, code);
        const needsRemove = !code && (clearCoupon || (!requestedCoupon && !autoCoupon)) && snapshot.coupon;
        if (needsApply || needsRemove) {
          // The bulk cart endpoint sometimes ignores couponCode. Use Swiggy's
          // dedicated apply/remove endpoint, then verify the resulting cart.
          let applied = null;
          try {
            applied = await applySwiggyCartCoupon(account, { couponCode: code, addressId, lat, lng, timeoutMs: Math.min(2500, timeoutMs) });
          } catch { applied = null; }
          if (successCode(applied?.json?.statusCode) && applied?.json?.data) {
            try { snapshot = acceptCart(applied); } catch { snapshot = await readCart(4000); }
          } else {
            snapshot = await readCart(4000);
          }
          if (code && !couponSettled(snapshot, code) && code === requestedCoupon) {
            const mcp = await callSwiggyFoodMcpTool(account, 'apply_food_coupon', { couponCode: code, addressId }, 2000).catch(() => null);
            if (mcp?.ok) snapshot = await readCart(4000);
          }
          if (needsApply && !couponSettled(snapshot, code)) {
            snapshot.couponReason = String(applied?.json?.statusMessage || snapshot.couponReason || 'Swiggy ne is cart par ye coupon accept nahi kiya.').slice(0, 140);
          }
        }
        unconfirmedCartWrite = false;
        return snapshot;
      };

      // ── Step 0: ₹50-off / free-cash / night offers claim (bot ka same call) ─
      // Boss (round 35): "FREE CASH ABHI BHI NAHI LAG RAHA". Pichhle round me
      // claim sirf doosre (full) phase me chalta tha, isliye pehle bill me free
      // cash nahi aata tha. Ab full bill = pehla bill, aur usme claim ka jawab
      // PEHLE liya jata hai (bounded), taaki free cash/night cash usi bill me ho.
      // Claim fail ho to bill phir bhi aata hai — bas sach likha jata hai.
      const claimEnabled = !(quickBill || fast || cart.skipOfferClaim === true || options.skipOfferClaim === true);
      // Bill ko sirf Night + Breakfast free cash chahiye. Fixed/event ladders
      // yahan nahi chalate — woh Tools/Claim ka kaam hai. Isse bill fast hai.
      const claimPromise = claimEnabled ? activateAllEventOffers(account, {
        offerKeys: ['lateNight', 'breakfast'],
        requestTimeoutMs: 1500,
        maxRetries: 0,
        deadlineAt: Date.now() + 6500,
        parallelOffers: true,
        currentWindowOnly: true
      }).catch(err => ({ success: false, reason: String(err?.message || err).slice(0, 120) })) : Promise.resolve(null);

      // ── Step 1: plain cart + One Lite (delivery free) ─────────────────────
      let subscriptionItems = Array.isArray(cart.activeSubscriptionItems) ? cart.activeSubscriptionItems : [];
      // Claim ka jawab pehle — free cash/night cash tabhi bill me aata hai.
      const claimResult = claimEnabled ? await claimPromise : null;
      const claimSummary = claimResult?.summary || {};
      const activeClaims = Number(claimSummary.claimed || 0) + Number(claimSummary.alreadyActive || 0);
      const claimNote = (() => {
        if (!claimEnabled) return '';
        if (!claimResult) return 'Free Cash check pending.';
        if (claimResult.success === false) return 'Free Cash claim nahi hua.';
        if (activeClaims > 0) return `${activeClaims} Free Cash claim active.`;
        if (Number(claimSummary.preLocked || 0) > 0) return 'Free Cash pre-booked.';
        return 'Free Cash is bill par active nahi hua.';
      })();
      const offerTracks = ['lateNight', 'breakfast'].map(key => {
        const rec = claimResult?.offers?.[key];
        return { key, label: key === 'lateNight' ? 'Night' : 'Breakfast', status: String(rec?.status || ''), verified: rec?.verified === true, alreadyActive: rec?.alreadyActive === true };
      });
      let base = await push({ couponCode: requestedCoupon, subscriptionItems });
      const deliveryFee = Number(base.parsed?.deliveryFee || 0);
      if (!quickBill && !fast && cart.autoOneLite !== false && deliveryFee > 1 && Number(base.parsed?.swiggyOneMembershipFee || 0) === 0) {
        const planIds = [...new Set([
          String(base.parsed?.eligibleSuperPlan?.planId || '').trim(),
          '773'
        ].filter(Boolean))];
        let bestOne = null;
        for (const planId of planIds) {
          const sub = [{ plan_id: planId, quantity: 1 }];
          let attempt = null;
          try { attempt = await push({ couponCode: requestedCoupon, subscriptionItems: sub }); } catch { continue; }
          const oneFee = Number(attempt.parsed?.swiggyOneMembershipFee || 0);
          const deliveryNow = Number(attempt.parsed?.deliveryFee || 0);
          // Sirf tab rakho jab total SACH me kam ho (fee delivery saving se kam).
          if (oneFee > 0 && attempt.total < base.total - 0.005) {
            bestOne = { attempt, sub, planId };
            break;
          }
          if (deliveryNow > 0 && oneFee === 0) engine.notes.push(`plan ${planId} ne delivery free nahi ki`);
        }
        if (bestOne) {
          base = bestOne.attempt;
          subscriptionItems = bestOne.sub;
          engine.oneLite = 'applied';
        } else {
          engine.oneLite = deliveryFee > 1 ? 'not_profitable' : 'not_needed';
          // Revert: agar pichla attempt cart me One fee chhod gaya ho.
          if (Number(base.parsed?.swiggyOneMembershipFee || 0) === 0 && subscriptionItems.length) {
            try { base = await push({ couponCode: requestedCoupon }); } catch {}
          }
        }
      } else if (deliveryFee <= 1) {
        engine.oneLite = 'not_needed';
      }

      // ── Step 2: poori coupon discovery (bot ke 5 engine) ──────────────────
      const found = new Map();
      const add = (code, title = '', description = '', priority = 50, applicable = true) => {
        const c = String(code || '').trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,28}$/.test(c)) return;
        if (['NOT', 'NONE', 'NULL', 'UNDEFINED', 'NOFOMO'].includes(c)) return;
        const prev = found.get(c);
        if (prev && prev.priority <= priority) return;
        found.set(c, {
          code: c,
          title: String(title || c).slice(0, 90),
          description: String(description || '').slice(0, 200),
          priority, applicable: applicable !== false, source: 'swiggy'
        });
      };
      if (requestedCoupon) add(requestedCoupon, requestedCoupon, 'Aapne chuna', 1);
      if (base.coupon) add(base.coupon, base.coupon, 'Bill me laga hua', 2);
      if (base.parsed?.suggestedCouponCode) add(base.parsed.suggestedCouponCode, base.parsed.suggestedCouponCode, 'Swiggy ka best suggested', 3);

      const estCartVal = Math.round(Number(base.parsed?.itemTotal || 250));
      const [mcpCoupons, mcpCart, offersPay, offersRest] = (quickBill || fast || (!autoCoupon && !requestedCoupon)) ? [null, null, null, null] : await Promise.all([
        callSwiggyFoodMcpTool(account, 'fetch_food_coupons', { restaurantId: String(cart.restaurantId), addressId }, 1800).catch(() => null),
        callSwiggyFoodMcpTool(account, 'get_food_cart', { addressId }, 1600).catch(() => null),
        dapiFetch(account, `offers/payment?lat=${lat}&lng=${lng}&restaurantId=${cart.restaurantId}&cart_value=${estCartVal}&restaurant_id=${cart.restaurantId}&sourcePage=cart&source_page=cart&page_type=PAYMENT_OFFERS_PAGE`, { lat, lng, timeoutMs: 1800 }).catch(() => null),
        dapiFetch(account, `offers/restaurant?lat=${lat}&lng=${lng}&restaurantId=${cart.restaurantId}`, { lat, lng, timeoutMs: 1600 }).catch(() => null)
      ]);
      const ineligible = new Set();
      for (const cp of (Array.isArray(mcpCoupons?.structured?.coupons) ? mcpCoupons.structured.coupons : [])) {
        const code = cp?.coupon_code || cp?.couponCode || cp?.code || '';
        const applicable = cp?.is_applicable !== false && cp?.applicable !== false;
        add(code, cp?.title || cp?.header || code, cp?.description || cp?.subtitle || '', applicable ? 5 : 25, applicable);
        if (!applicable && code) ineligible.add(String(code).toUpperCase());
      }
      for (const blob of [mcpCoupons?.structured, mcpCart?.structured, offersPay?.json, offersRest?.json]) {
        if (!blob) continue;
        let text = '';
        try { text = JSON.stringify(blob); } catch { continue; }
        for (const m of text.matchAll(/"coupon_?code"\s*:\s*"([A-Za-z0-9_]{3,25})"/g)) add(m[1], m[1], 'Swiggy live offer', 10);
      }
      const mcpSuggested = mcpCart?.structured?.offers?.coupon_applied || mcpCart?.structured?.coupon_code || mcpCart?.structured?.data?.coupon_code || '';
      if (mcpSuggested) add(mcpSuggested, mcpSuggested, 'Swiggy auto-suggested', 3);
      if (!quickBill && autoCoupon) {
        for (const code of ['SNACKIT', 'TRYNEW', 'STEALDEAL', 'SWIGGYIT', 'WELCOME50', 'FLAT150', 'MEALDEAL', 'DELULU4FOOD']) {
          add(code, code, 'Swiggy promo code', 35);
        }
      } else if (fast) {
        engine.notes.push('Pehla bill: offers, One Lite aur coupon check bache hue hain — agle kadam me.');
      } else {
        engine.notes.push('Quick bill: extra offers and One Lite were not checked.');
      }
      engine.couponsSeen = found.size;
      engine.couponOptions = [...found.values()].sort((a, b) => a.priority - b.priority).slice(0, 24).map(c => ({
        code: c.code, title: c.title || c.code, description: c.description || '', applicable: c.applicable !== false,
        reason: c.applicable === false ? 'Is cart par eligible nahi.' : '', source: 'swiggy'
      }));

      // ── Step 3: har coupon ka asli bill — sabse kam total jeetta hai ──────
      let best = base;
      // User ne khud koi code chuna ho to wahi chalta hai — auto use nahi
      // badalta (user ka faisla upar hai). Auto mode me hi sabse kam bill dhoondte hain.
      const candidates = (requestedCoupon || !autoCoupon || quickBill || fast ? [] : [...found.values()])
        .filter(c => c.applicable !== false || c.code === base.coupon)
        .filter(c => !ineligible.has(c.code) || c.code === base.coupon)
        .filter(c => c.code !== base.coupon)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, budget.maxTrials);
      const startedAt = Date.now();
      for (const cand of candidates) {
        if (Date.now() - startedAt > budget.trialBudgetMs) { engine.notes.push('coupon trial budget khatam'); break; }
        let attempt = null;
        try {
          attempt = await push({ couponCode: cand.code, subscriptionItems, timeoutMs: Math.max(1500, Math.min(5000, budget.trialBudgetMs - (Date.now() - startedAt))) });
        } catch (err) {
          engine.couponTrials.push({ code: cand.code, ok: false, reason: String(err?.message || err).slice(0, 100) });
          continue;
        }
        const applied = attempt.coupon === cand.code && Number(attempt.parsed?.discountAmount || 0) > 0;
        engine.couponTrials.push({
          code: cand.code, ok: applied,
          discount: applied ? Number(attempt.parsed.discountAmount) : 0,
          total: attempt.total,
          reason: applied ? '' : (attempt.couponReason || 'Swiggy ne discount nahi diya.')
        });
        if (attempt.total < best.total - 0.005) best = attempt;
      }

      // ── Step 4: claim ka sach + free cash bill me aaya ya nahi ───────────
      engine.offersClaimed = Number(claimSummary.claimed || 0);
      engine.offersNote = claimNote;
      engine.offerTracks = offerTracks;
      // Reward credit can arrive just after the claim read-back. Re-price once
      // without flushing; available wallet balance is not an applied reward.
      const rewardAlready = Number(best.parsed?.campaignFreeCash || 0) + Number(best.parsed?.swiggyMoneyApplied || 0);
      if (!fast && !quickBill && rewardAlready <= 0 && activeClaims > 0) {
        try {
          const again = await push({ couponCode: best.coupon, subscriptionItems, timeoutMs: 5000 });
          const rewardNow = Number(again.parsed?.campaignFreeCash || 0) + Number(again.parsed?.swiggyMoneyApplied || 0);
          if (rewardNow > 0 && again.total <= best.total + 0.005) best = again;
        } catch {}
      }

      // Trials may leave a different coupon/subscription in the real cart, or
      // time out after a write. Settle the chosen configuration and use its
      // latest readback; if that fails, return no bill rather than an old one.
      if (unconfirmedCartWrite || lastReadback !== best) {
        const chosen = best;
        best = await push({ couponCode: chosen.coupon, subscriptionItems, clearCoupon: !chosen.coupon });
        if (Math.abs(best.total - chosen.total) > 0.005 || best.coupon !== chosen.coupon) {
          engine.notes.push('Swiggy returned a different final bill; latest readback shown.');
        }
      }
      const { parsed, meta, total } = best;
      const returnedNumber = (...values) => {
        const raw = values.find(v => v !== undefined && v !== null && v !== '');
        return raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
      };
      // ── Round 33: bill ka hisaab sirf sach se ────────────────────────────
      // Boss: "BILL SAHI SE CALCULATE NAHI HO RAHA". Do galtiyan thi:
      //  (1) "available" Swiggy Money ko discount maan liya jata tha — jabki
      //      Swiggy ne kuch kaata hi nahi. Ab sirf jo SACH ME kata wahi line me.
      //  (2) campaign free cash trade discount ke andar hi Swiggy ke total me
      //      shamil hota hai — alag line se bill dobara kam lagta tha.
      const walletReallyDeducted = Math.max(
        0,
        Number(parsed?.swiggyMoneyApplied || 0),
        Number(meta?.swiggy_money ?? meta?.swiggyMoney ?? 0) || 0
      );
      const tradeTotal = Math.max(0, Number(parsed?.tradeDiscountTotal ?? 0));
      const campaignCash = Math.max(0, Number(parsed?.campaignFreeCash ?? 0));
      // Campaign free cash do jagah se aata hai — kabhi trade discount ke andar
      // (trade_discount_total me juda hua), kabhi sirf reward field me. Ek hi
      // baar ginenge, warna bill dobara kam lagta hai.
      // Split the trade discount: campaign Free Cash gets its own visible line,
      // merchant discount gets the remainder. Count the reward exactly once.
      const merchantDiscount = Math.max(0, tradeTotal - Math.min(campaignCash, tradeTotal));
      const freeCashShown = campaignCash + walletReallyDeducted;
      engine.freeCash = walletReallyDeducted;
      engine.campaignFreeCash = campaignCash;
      engine.freeCashAvailable = Math.max(0, Number(parsed?.freeCashBalance || 0));
      engine.deliveryFee = Number(parsed?.deliveryFee || 0);
      engine.phase = phase;
      engine.addressReused = engineAddressReused;
      engine.offerClaim = claimResult ? (claimSummary || {}) : null;
      engine.offerNote = claimNote;
      return {
        address: confirmedAddress,
        addressFingerprint: addressDigest,
        // Bill turant mila, par offers/One Lite/coupon ka check bacha hai —
        // app ise dikha kar peeche se sudhaar leta hai (jhooth nahi: likha hai).
        optimizePending: fast && !quickBill,
        bill: {
          // Boss (31-10-2026, round 9): "BILL SUMMARY ME ITNA AYEGA" — wahi
          // lines jo Swiggy dikhata hai: Coupon, Extra Discount (Free Cash),
          // Swiggy One Lite Membership, FREE delivery (kitna bacha),
          // Packing, GST & Other, Total Savings, To Pay.
          itemTotal: returnedNumber(parsed?.itemTotal, meta.item_total, meta.cart_subtotal),
          deliveryFee: returnedNumber(parsed?.deliveryFee, meta.positiveDeliveryChargesExclusive, meta.delivery_charges),
          deliverySaved: parsed?.freeDeliveryDiscount ?? null,
          deliveryFree: Number(parsed?.deliveryFee ?? 0) <= 0,
          deliveryDistance: String(meta?.delivery_distance || meta?.delivery_distance_in_km || parsed?.deliveryDistance || '').slice(0, 40),
          packingCharges: returnedNumber(parsed?.packingCharges, meta.total_packing_charges, meta.restaurant_packing_charges),
          taxes: returnedNumber(parsed?.taxesAndCharges, meta.taxesAndCharges, meta.total_tax),
          discount: parsed?.couponCode ? returnedNumber(parsed.discountAmount, meta.coupon_discount_total, meta.coupon_discount_effective) : null,
          coupon: String(parsed?.couponCode || ''),
          couponCode: String(parsed?.couponCode || ''),
          autoCoupon: Boolean(best.coupon) && !requestedCoupon,
          couponTried: engine.couponTrials.map(t => t.code).slice(0, 12),
          // Ek hi baar: campaign free cash (agar trade discount me nahi hai) +
          // sirf jo Swiggy ne sach me kaata. Balance hona discount nahi hai.
          freeCash: freeCashShown > 0 ? freeCashShown : null,
          freeCashWallet: walletReallyDeducted > 0 ? walletReallyDeducted : null,
          freeCashAvailable: Math.max(0, Number(parsed?.freeCashBalance || 0)),
          // Poora trade discount (restaurant + campaign free cash) — ye Swiggy
          // ke order_total ke andar pehle se hai, isliye ek hi line me.
          tradeDiscount: merchantDiscount > 0 ? merchantDiscount : null,
          oneMembershipFee: parsed?.swiggyOneMembershipFee ?? null,
          oneApplied: parsed?.swiggyOneApplied === true,
          totalSavings: parsed?.totalSavings ?? null,
          subscriptionItems,
          engine,
          offerNote: claimNote,
          offerTracks,
          couponReason: requestedCoupon && best.coupon !== requestedCoupon ? (best.couponReason || 'Swiggy ne ye coupon accept nahi kiya.') : '',
          total
        },
        // Sending OFO fields is not proof that Swiggy accepted OFO placement.
        ofoConfirmed: false
      };
    });
  },
  async checkout(account, address, cart, placementKey) {
    const { lat, lng } = coords(address);
    if (process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1' ||
        (globalThis.fetch === bootFetch && isZeroSmsTestSandboxActive())) {
      throw badRequest('Order placement is blocked in this environment; no simulated order or QR was created.');
    }
    const expected = Number(cart?.quote?.total);
    // Coupon code jo bill ke waqt APPROVE hua tha — billBreakdown `coupon` ko
    // clear kar deta hai jab discount item total me pehle se ho, isliye asli
    // code alag field me rakhte hain.
    const approvedCoupon = String(cart?.quote?.couponCode ?? cart?.quote?.coupon ?? '').trim().toUpperCase();
    if (!address?.id || !address?.name || !normalizeIndianMobileNumber(address?.mobile) ||
        !Array.isArray(cart?.items) || !cart.items.length || exactPaise(expected) === null || expected <= 0) {
      throw badRequest('Confirm the recipient and refresh the Swiggy bill before checkout.');
    }
    return withSwiggyAccountLock(checkoutLockKey(account), async () => {
      const [auth, liveCart, savedAddresses] = await Promise.all([
        getSwiggySessionAuth(account, false),
        swiggyCartGet(account, { lat, lng, timeoutMs: 8000 }),
        fetchAccountAddresses(account)
      ]);
      if (!auth?.userId || !auth?.jwtTid) throw unavailable('Swiggy session could not be verified. No order was placed.');
      const actualAddress = savedAddresses.find(a => String(a.id || '') === String(address.id));
      if (!actualAddress || !sameDeliveryRecipient(address, actualAddress)) {
        throw unavailable('Swiggy did not confirm the same receiver and delivery location. No order was placed.');
      }
      const accountPhone = normalizeIndianMobileNumber(account?.phone || account?.mobile || '');
      const receiverPhone = normalizeIndianMobileNumber(actualAddress.mobile || '');
      if ((!accountPhone || accountPhone !== receiverPhone) && !cart.forSomeoneElse) {
        throw badRequest('The receiver differs from this account. Select “Order for someone else” and review a fresh bill. No order was placed.');
      }
      const data = liveCart?.json?.data;
      const meta = data?.cartMeta || data;
      const parsed = data ? parseDapiCartPayload(data) : null;
      const liveTotal = Number(meta?.order_total);
      const addressId = String(meta?.address_id || meta?.delivery_address?.id || data?.address_id || data?.delivery_address?.id || '');
      const cartId = String(meta?.originalCartId || meta?.cartId || meta?.cart_id || '');
      const coupon = String(parsed?.couponCode || '').toUpperCase();
      // Boss (31-10-2026, round 10): pehle yahan ek hi generic message aata tha
      // ("cart, recipient/OFO, coupon or amount could not be confirmed") aur
      // user ko pata hi nahi chalta tha kya badla. Ab har check alag hai aur
      // uski asli wajah + dono numbers message me aate hain.
      const problems = [];
      const fail = (code, message, extra = {}) => problems.push({ code, message, ...extra });
      if (!successCode(liveCart?.json?.statusCode) || !data) {
        fail('CART_FETCH', `Swiggy ne cart nahi diya (HTTP ${liveCart?.status || '?'}${liveCart?.json?.statusCode !== undefined ? `, statusCode ${liveCart.json.statusCode}` : ''}).`);
      } else if (!parsed) {
        fail('CART_PARSE', 'Swiggy ka cart jawab samajh nahi aaya (items parse nahi hue).');
      } else {
        // Item IDs and quantities alone are insufficient: an add-on or variant
        // can change while the total stays the same. The quote used this same
        // strict readback, so checkout must fail closed on any mismatch.
        if (!sameCartItems(cart.items, parsed.items)) fail('CART_ITEMS', 'Swiggy ke cart me items, variants ya add-ons badal gaye.');
        if (parsed.restaurantId && String(parsed.restaurantId) !== String(cart.restaurantId)) {
          fail('RESTAURANT', `Restaurant badal gaya — bill ${cart.restaurantId}, Swiggy ${parsed.restaurantId}.`);
        }
      }
      if (!addressId || addressId !== String(address.id)) fail('ADDRESS', `Delivery address Swiggy cart par confirm nahi hua (bill ${address.id}, Swiggy ${addressId || 'missing'}).`);
      if (exactPaise(liveTotal) === null) fail('AMOUNT_MISSING', 'Swiggy ne payable amount nahi diya.');
      else if (exactPaise(liveTotal) !== exactPaise(expected)) {
        fail('AMOUNT', `Bill ka amount badal gaya — aapne ₹${expected} dekh kar Pay dabaya, Swiggy ab ₹${liveTotal} keh raha hai.`);
      }
      if (coupon !== approvedCoupon) {
        fail('COUPON', `Coupon badal gaya — bill me "${approvedCoupon || 'koi coupon nahi'}", Swiggy par "${coupon || 'koi coupon nahi'}".`);
      }
      if (!cartId) fail('CART_ID', 'Swiggy ne cart id nahi di (order place karne ke liye zaroori hai).');
      if (problems.length) {
        const err = unavailable(`${problems.map((p, i) => `${i + 1}. ${p.message}`).join(' ')} Order place nahi hua — naya bill dekh kar dobara Pay dabaiye.`);
        err.diag = { code: problems[0].code, problems, placementAttempted: false };
        // Recoverable: bill/coupon badla hai par items/address wahi hain. Tab
        // naya bill bhej dete hain taaki app use dikha kar dobara confirm kare
        // (dead-end loop nahi).
        const hardStop = problems.some(p => ['CART_FETCH', 'CART_PARSE', 'CART_ID', 'CART_ITEMS', 'RESTAURANT', 'ADDRESS'].includes(p.code));
        // Code hamesha set — app isi se decide karta hai ki retry safe hai ya
        // nahi (aur "outcome unknown" ka darr dikhana hai ya nahi).
        err.code = hardStop ? problems[0].code : 'BILL_CHANGED';
        if (!hardStop && parsed) {
          err.diag.freshBill = {
            itemTotal: parsed.itemTotal, deliveryFee: parsed.deliveryFee, deliverySaved: parsed.freeDeliveryDiscount,
            packingCharges: parsed.packingCharges, taxes: parsed.taxesAndCharges,
            discount: parsed.discountAmount, coupon: String(parsed.couponCode || ''), couponCode: String(parsed.couponCode || ''),
            freeCash: parsed.swiggyMoneyApplied, tradeDiscount: parsed.tradeDiscountTotal,
            oneMembershipFee: parsed.swiggyOneMembershipFee, oneApplied: parsed.swiggyOneApplied === true,
            totalSavings: parsed.totalSavings, total: liveTotal
          };
        }
        throw err;
      }
      const recipient = cart.forSomeoneElse ? buildOfoCartFields({ addressDetails: actualAddress }) : {};
      const body = {
        address_id: addressId, lat, lng, payment_cod_method: 'UPIIntent',
        ...recipient,
        order_total: liveTotal, bill_total: liveTotal, cart_total: liveTotal,
        cart_total_shown_to_coupon: meta.cart_total_shown_to_coupon ?? liveTotal,
        total_without_coupon_discount: meta.total_without_coupon_discount ?? liveTotal,
        original_order_total: meta.original_order_total ?? liveTotal,
        transaction_amount: liveTotal, updated_amount: liveTotal, amount: liveTotal,
        cartId, cart_id: cartId, originalCartId: cartId,
        upi_transaction_info: { intent_app: 'com.google.android.apps.nbu.paisa.user', intent_app_display_name: 'Google Pay' }
      };
      const headers = buildSwiggyAndroidClientHeaders(account, {
        tid: liveCart?.json?.tid || auth.jwtTid, token: auth.token, sid: auth.sid,
        deviceId: auth.deviceId, userId: auth.userId, lat, lng,
        extraHeaders: { paymentamount: String(liveTotal), cartid: cartId, cartaddressid: addressId, addressid: addressId }
      });
      const result = await executeSingleSwiggyPlacement(placementKey, async () => {
        const response = await fetch('https://chkout.swiggy.com/api/v2/order/place', {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000)
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { placeRes: response, json };
      });
      const details = placementDetails(result?.json);
      // Place-response me intent nahi mila → Swiggy ke apne payment page se
      // ek baar maango (sirf tab jab order place ho gaya ho).
      if (!details.upiIntentUrl && details.orderId && /^https:\/\//i.test(String(details.paymentPageUrl || ''))) {
        const recovered = await recoverUpiIntentFromPaymentPage(account, details.paymentPageUrl);
        if (recovered) {
          details.pageIntent = recovered;
        }
      }
      // Boss (31-10-2026, round 15): "qr nahi aata direct ye ajata". Swiggy ka
      // intent kabhi `&amp;`/`\u0026` escaped aata hai, kabhi `amount` ke naam
      // se, kabhi duplicate param ke saath — inhe "invalid" maan kar QR na
      // dena hi galat tha. Pehle saaf karo, phir strict check.
      // Boss (31-10-2026, round 18): "QR generation ke har possibility".
      // Har source ek hi plan se guzarta hai — pehla valid jeetta hai, jo
      // reject hua uski wajah `diag` me jaati hai (jhootha QR kabhi nahi).
      const qrPlan = planQrGeneration([
        ...(details.upiIntentUrl ? [{ source: 'provider', uri: details.upiIntentUrl }] : []),
        ...(details.pageIntent ? [{ source: 'payment_page', uri: details.pageIntent }] : [])
      ], { amount: expected });
      const qrUri = qrPlan.ok ? qrPlan.uri : '';
      if (!result?.placeRes?.ok || !successCode(result?.json?.statusCode) || !details.orderId) {
        throw attemptedPlacementError(
          'Swiggy did not return a verifiable order ID and matching UPI payment. An order may exist; check My Orders on this account. Do not retry.',
          'SWIGGY_PLACEMENT_RESPONSE_UNCERTAIN', details.orderId
        );
      }
      if (!qrPlan.ok) {
        // Order BAN gaya hai — "rejected" kehna jhooth hota. Bas QR nahi mila.
        // Wajah bhi asli: har source ka asli reject reason (fixed line nahi).
        const reasons = (qrPlan.reasons || []).slice(0, 3);
        const intentProblem = `Swiggy ka QR bhejne layak nahi tha: ${reasons.join(' · ') || 'wajah nahi mili'}`;
        const err = unavailable(`${intentProblem} Order #${details.orderId} Swiggy par bana hua hai — dobara order na karein.`);
        err.code = 'SWIGGY_PLACED_NO_UPI_INTENT';
        err.diag = {
          code: 'SWIGGY_PLACED_NO_UPI_INTENT', placementAttempted: true, placedOrderId: details.orderId,
          qrMissing: true, intentProblem,
          intentProblems: reasons,
          intentAttempts: (qrPlan.attempted || []).map((a) => ({ source: a.source, ok: a.ok, reasons: (a.reasons || []).slice(0, 2) })),
          intentWarnings: (qrPlan.warnings || []).slice(0, 5),
          // Jo pehla candidate aaya uska asli amount (kuch na ho to null).
          intentAmount: (qrPlan.attempted || []).map((a) => a?.info?.amount).find((v) => Number.isFinite(v)) ?? null,
          billAmount: expected,
          // Agli baar bina guess kiye pata chale ki Swiggy ne kya bheja tha.
          intentRaw: String(details.upiIntentUrl || details.pageIntent || '').slice(0, 400),
          paymentFallbacks: details.paymentFallbacks || null,
          paymentPageUrl: details.paymentPageUrl || '', paymentTxnId: details.paymentTxnId || ''
        };
        throw err;
      }
      // Boss (31-10-2026, round 11): Swiggy ka cart readback OFO flag deta hi
      // nahi, isliye pehle har OFO order "flag nahi mila" par ruk jaata tha.
      // Ab order nahi rukta; OFO ka sach sirf place-response se aata hai aur
      // wahi (jhooth bina) app ko dikhta hai.
      const ofoProof = detectOfoFromPlaceResponse(result.json);
      return {
        ...details,
        // QR me wahi string jaye jo plan ne saaf karke valid kaha.
        upiIntentUrl: qrUri,
        intentSource: qrPlan.source,
        intentRepairs: qrPlan.warnings || [],
        intentAttempts: (qrPlan.attempted || []).map((a) => ({ source: a.source, ok: a.ok, reasons: (a.reasons || []).slice(0, 2) })),
        amount: expected,
        ofoConfirmed: ofoProof.ofo === true,
        ofoRequested: cart.forSomeoneElse === true,
        ofoNote: cart.forSomeoneElse
          ? (ofoProof.ofo === true
            ? 'Swiggy ne OFO flag place-response me diya.'
            : 'Swiggy ne place-response me OFO flag nahi diya — order normal order ki tarah gaya, khana usi address par jayega.')
          : ''
      };
    });
  },
  async checkPayment(account, checkout) {
    return checkRealSwiggyPaymentAndExtractTracking({
      account,
      order: {
        pendingSwiggyOrderId: checkout.orderId,
        pendingSwiggyPaasId: checkout.paymentTxnId,
        finalPayable: checkout.amount,
        restaurantName: checkout.restaurantName
      }
    });
  },
  async tracking(account, rawId) {
    const id = normalizeSwiggyOrderId(rawId);
    if (!id) throw badRequest('Invalid Swiggy order ID.');
    // Boss (31-10-2026, round 21): "NO TRACKING IS AVAILABLE". Pehle sirf do
    // one-shot DAPI call thi — Swiggy ka link aksar `order/details`, mobile-web
    // UA ya order page ke `__NEXT_DATA__` me hota hai. Ab wahi poora rasta:
    // trackV4 (dono headers) → order/details → order page scrape, 3 rounds.
    let deep = { url: '', via: '', tried: [], attempts: 0, payload: null };
    try {
      deep = await fetchSwiggyTrackingLinkFast(account, id, { budgetMs: 9000, attempts: 3 });
    } catch { deep = { url: '', via: '', tried: [], attempts: 0, payload: null }; }
    const [track, delivery] = await Promise.all([
      dapiFetch(account, `order/trackV4?order_id=${encodeURIComponent(id)}&type=full&version=V2`, { timeoutMs: 8000 }).catch(() => null),
      dapiFetch(account, `order/trackV2/de?order_id=${encodeURIComponent(id)}`, { timeoutMs: 8000 }).catch(() => null)
    ]);
    const validData = response => {
      if (response?.status !== 200 || !successCode(response?.json?.statusCode) || !response?.json?.data) return null;
      const value = response.json.data;
      const returnedId = String(value.order_id || value.orderId || '');
      return returnedId && returnedId !== id ? null : value;
    };
    const t = validData(track), d = validData(delivery);
    // SMS ka proof — Swiggy ke saare payloads me (deep search bhi shamil).
    const sms = scanRecipientSmsEvidence(t, d, deep.payload, track?.json, delivery?.json);
    const directUrl = extractSwiggyProvidedTrackingUrl(t, d) || '';
    const trackingUrl = deep.url || directUrl;
    const via = deep.url ? (deep.via || 'FYI_CTA') : (directUrl ? 'FYI_CTA' : '');
    if (!t && !d && !deep.url) {
      // Tracking ka kuch bhi na mile to bhi jhooth nahi: asli reason + kya try hua.
      const err = unavailable('Swiggy ne is order ka tracking nahi diya (trackV4, order/details aur order page — teeno khaali).');
      err.code = 'TRACKING_NOT_PUBLISHED';
      err.tried = (deep.tried || []).slice(0, 4);
      throw err;
    }
    return {
      orderId: id,
      status: String(t?.order_status_details?.status_message || t?.order_status || deep?.payload?.order_status || ''),
      eta: String(t?.sla_time || t?.order_status_details?.eta || deep?.payload?.sla_time || ''),
      trackingUrl,
      via,
      tried: (deep.tried || []).slice(0, 4),
      attempts: Number(deep.attempts || 0),
      sms,
      deliveryOtp: extractSwiggyDeliveryOtp(t, { delivery: d }) || '',
      deliveryPartner: { name: String(d?.name || ''), phone: String(d?.mobile || '') }
    };
  },
  async orders(account) {
    const result = await dapiFetch(account, 'order/all', { timeoutMs: 10000 });
    const list = result?.json?.data?.orders;
    if (result?.status !== 200 || !successCode(result?.json?.statusCode) || !Array.isArray(list)) throw unavailable('Swiggy order history could not be fetched.');
    return list.slice(0, 30).map(o => ({
      id: String(o.order_id || ''), restaurant: String(o.restaurant_name || ''),
      status: String(o.order_status || o.order_delivery_status || o.post_status || 'Status unavailable'),
      placedAt: String(o.order_time || ''), amount: o.order_total === undefined || o.order_total === null ? null : Number(o.order_total),
      items: (Array.isArray(o.order_items) ? o.order_items : []).map(i => ({ name: String(i.name || ''), qty: Number(i.quantity || 1) })),
      address: String(o.delivery_address?.address || o.delivery_address?.area || '')
    })).filter(o => o.id);
  }
};
