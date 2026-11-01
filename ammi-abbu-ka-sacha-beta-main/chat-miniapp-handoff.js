// Chat -> Mini App link handoff. Links belong to the authenticated Telegram
// user; no Swiggy session or arbitrary URL is sent to the browser.
import crypto from 'node:crypto';
import { extractSharedUrls } from './link-utils.js';
import { getDb, saveDbDurable } from './store.js';
import { sealProHandoff, openProHandoff } from './swiggy-pro-store.js';

const SHARE_HOSTS = new Set(['swig.gy', 'swiggy.onelink.me', 'www.swiggy.com', 'swiggy.com', 'm.swiggy.com']);

export function safeSwiggyShareUrl(value) {
  try {
    const input = String(value || '').trim();
    if (!input || input.length > 2000) return '';
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password ||
        (url.port && url.port !== '443') || !SHARE_HOSTS.has(url.hostname.toLowerCase())) return '';
    return url.toString();
  } catch { return ''; }
}

/** Some OneLink URLs are opaque; never guess which of the two links they are. */
export function classifyChatShareUrl(raw) {
  const safe = safeSwiggyShareUrl(raw);
  if (!safe) return '';
  const url = new URL(safe);
  const target = `${url.pathname}${url.search}`.toLowerCase();
  if (/\/ofo\/track|\/tracking?\//.test(target)) return '';
  if (/\/address\b|\/ofo\/address\/|jgkq|y313q1wv/.test(target)) return 'address';
  if (/\/gc\/|group[_-]?cart|shared[_-]?cart|\/cart\b|restaurant_id/.test(target)) return 'cart';
  if ((url.hostname === 'swig.gy' || url.hostname === 'swiggy.onelink.me') && url.pathname.length > 1) return 'ambiguous';
  return '';
}

export function parseChatShareLinks(text) {
  const result = { cart: '', address: '', ambiguous: [], unsupported: [], duplicates: [] };
  for (const raw of extractSharedUrls(text)) {
    const url = safeSwiggyShareUrl(raw);
    const kind = classifyChatShareUrl(raw);
    if (kind === 'cart') {
      if (result.cart && result.cart !== url) result.duplicates.push('cart');
      else result.cart = url;
    } else if (kind === 'address') {
      if (result.address && result.address !== url) result.duplicates.push('address');
      else result.address = url;
    } else if (kind === 'ambiguous') result.ambiguous.push(url);
    else if (!kind) result.unsupported.push(raw);
  }
  return result;
}

export function readChatHandoff(userId, db = getDb()) {
  const entry = db?.drafts?.[String(userId)]?.miniAppLinks;
  if (!entry || typeof entry !== 'object') return null;
  const links = openProHandoff(userId, entry.encrypted);
  return { id: String(entry.id || ''), updatedAt: String(entry.updatedAt || ''), startedAt: String(entry.startedAt || ''), ...links };
}

/** Store only link data under this user's existing draft without clearing it. */
export function saveChatHandoffLinks(userId, { cart, address } = {}) {
  const id = String(userId || '');
  if (!/^\d{1,20}$/.test(id)) throw new Error('Invalid Telegram user');
  if (cart && !safeSwiggyShareUrl(cart)) throw new Error('Invalid cart link');
  if (address && !safeSwiggyShareUrl(address)) throw new Error('Invalid address link');
  const db = getDb();
  db.drafts ||= {};
  const draft = db.drafts[id] || {};
  const previous = readChatHandoff(id, db);
  // Once the previous handoff started, don't silently mix its link with a new
  // order. The encrypted workspace keeps the old handoff for recovery.
  const base = previous?.startedAt ? {} : (previous || {});
  const next = {
    id: crypto.randomUUID(),
    cartUrl: cart ? safeSwiggyShareUrl(cart) : String(base.cartUrl || ''),
    addressUrl: address ? safeSwiggyShareUrl(address) : String(base.addressUrl || ''),
    updatedAt: new Date().toISOString()
  };
  if (next.cartUrl && next.cartUrl === next.addressUrl) throw new Error('Cart aur address ke alag links bhejein.');
  db.drafts[id] = { ...draft, miniAppLinks: {
    id: next.id, updatedAt: next.updatedAt,
    encrypted: sealProHandoff(id, { cartUrl: next.cartUrl, addressUrl: next.addressUrl })
  } };
  if (!saveDbDurable(db)) throw new Error('Links save nahi hue. Admin se baat karein.');
  return next;
}

/** Called only after the encrypted workspace durably stores this handoff. */
export function markChatHandoffStarted(userId, handoffId) {
  const db = getDb();
  const entry = db?.drafts?.[String(userId)]?.miniAppLinks;
  if (!entry || entry.id !== handoffId) return false;
  entry.startedAt ||= new Date().toISOString();
  return saveDbDurable(db);
}
