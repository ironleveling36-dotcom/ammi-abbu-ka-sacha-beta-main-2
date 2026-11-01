/**
 * Auto "Export & Logout" the moment a Swiggy order is DELIVERED.
 *
 * Boss ki shart:
 *   "AUTO LOGOUT AND EXPORT BHI NA HOTA AFTER ORDER IS DELIVERED"
 *
 * Manual button (`⇧ Export & Logout`) already exists — but it must also happen
 * by itself, per order, the second Swiggy says the order is delivered:
 *   1. the exact 7-field session JSON goes to the Boss as a `.json` file,
 *   2. the account is logged out + removed from the bot vault,
 *   3. exactly once per order, and never while that ID still has another
 *      running order (that would kill a live delivery).
 *
 * Pure logic + injected side effects => unit-testable without Telegram.
 */
import { buildPortableSessionJson, buildPortableSessionJsonCaption } from './account-views.js';

/** Telegram hard limit for one message (HTML parse mode included). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Keep a safety margin so entity escaping can never push us over. */
export const EXPORT_INLINE_SAFE_LIMIT = 3000;

/**
 * Everything the "Export & Logout" flow must send, pre-computed & measured.
 * The old code always pasted the whole session into an inline <pre>, which blew
 * past 4096 chars ("400: Bad Request: message is too long") and — because it
 * threw — skipped the logout entirely. Now the inline block is optional and its
 * size is decided here.
 */
export function buildExportPayload(acc, key, { orderCount = 0, prefix = '⇧ Exported' } = {}) {
  const json = buildPortableSessionJson(acc, key);
  const jsonText = JSON.stringify(json, null, 2);
  const compact = JSON.stringify(json);
  const phone = String(json.mobile || acc?.phone || acc?.mobile || String(key || '').replace(/^acc_/, '')).replace(/\D/g, '').slice(-10);
  const fileName = `swiggy_${phone || 'session'}.json`;
  const name = String(acc?.name || key || phone || 'Swiggy Session');
  const header = `<b>${escapeHtml(name)}</b> (<code>${escapeHtml(phone)}</code>) — <b>${Number(orderCount) || 0} orders</b>`;
  const inlineCode = (header.length + jsonText.length + 80) <= TELEGRAM_MESSAGE_LIMIT && jsonText.length <= EXPORT_INLINE_SAFE_LIMIT
    ? jsonText
    : '';
  return {
    json,
    jsonText,
    compact,
    phone,
    fileName,
    header,
    inlineCode,
    caption: buildPortableSessionJsonCaption({ name, phone, prefix }),
    fitsInline: Boolean(inlineCode)
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TERMINAL_STATES = ['CANCELLED', 'REJECTED', 'COMPLETED'];

/** Is this order delivered according to whatever Swiggy last told us? */
export function isOrderDelivered(order) {
  if (!order || typeof order !== 'object') return false;
  const status = String(order.liveOrderStatus || order.swiggyStatus || '');
  // "Out for delivery" is NOT delivered — it must stay live.
  if (/cancel|refus|return/i.test(status)) return false;
  if (/out for delivery|on the way|heading|reached/i.test(status)) return false;
  if (/\bdelivered\b/i.test(status)) return true;
  // `status: 'COMPLETED'` in this bot means "payment confirmed", NOT delivered.
  // Only an explicit delivery timestamp may count.
  return Boolean(order.deliveredAt || order.deliveredOn) && !/cancel|refus|return/i.test(String(order.status || ''));
}

function accountKeysOf(order) {
  const keys = new Set();
  for (const v of [order?.selectedAccount, order?.injectedSession?.accountKey, order?.orderAccountKey]) {
    const s = String(v || '').trim();
    if (s) keys.add(s);
  }
  const phone = String(order?.orderAccount || order?.selectedAccountPhone || order?.injectedSession?.phone || '').replace(/\D/g, '').slice(-10);
  if (phone) keys.add(`acc_${phone}`);
  return [...keys];
}

/** Orders that still need this account alive (any non-terminal order using it). */
export function otherLiveOrdersOnAccount(db, accountKey, excludeOrderId) {
  const accounts = db?.config?.accounts || {};
  if (!accounts[accountKey]) return [];
  const phone = String(accounts[accountKey].phone || accounts[accountKey].mobile || accountKey.replace(/^acc_/, '')).replace(/\D/g, '').slice(-10);
  return Object.values(db?.orders || {}).filter((o) => {
    if (!o || String(o.id) === String(excludeOrderId)) return false;
    if (TERMINAL_STATES.includes(String(o.status || '').toUpperCase())) return false;
    const keys = accountKeysOf(o);
    if (keys.includes(accountKey)) return true;
    return Boolean(phone) && keys.some((k) => k.replace(/^acc_/, '') === phone);
  });
}

/**
 * Decide what to do for a delivered order. Never returns a "fake" export.
 */
export function planDeliveryExport(db, order) {
  if (!order) return { shouldExport: false, reason: 'order not found' };
  if (order.autoExportDoneAt) return { shouldExport: false, reason: 'already auto-exported', accountKey: order.autoExportAccountKey || '' };
  if (!isOrderDelivered(order)) return { shouldExport: false, reason: 'not delivered yet' };

  const accounts = db?.config?.accounts || {};
  const candidate = accountKeysOf(order).find((k) => accounts[k]);
  if (!candidate) return { shouldExport: false, reason: 'account already removed from vault' };

  const acc = accounts[candidate];
  if (!acc.cookies && !acc.tid && !acc.token && !acc._session_tid) {
    return { shouldExport: false, reason: 'account has no session left', accountKey: candidate };
  }

  const busy = otherLiveOrdersOnAccount(db, candidate, order.id);
  if (busy.length > 0) {
    return {
      shouldExport: false,
      reason: `account par ${busy.length} aur order chal raha hai`,
      accountKey: candidate,
      busyOrderIds: busy.map((o) => o.id)
    };
  }

  const json = buildPortableSessionJson(acc, candidate);
  const phone = String(json.mobile || acc.phone || '').replace(/\D/g, '').slice(-10) || 'session';
  return {
    shouldExport: true,
    accountKey: candidate,
    phone,
    fileName: `swiggy_${phone}.json`,
    jsonText: JSON.stringify(json, null, 2),
    json,
    caption: buildPortableSessionJsonCaption({
      name: acc.name || candidate,
      phone,
      orderId: order.swiggyOrderId || order.pendingSwiggyOrderId || order.id,
      prefix: '⇧ AUTO EXPORT (delivered)'
    })
  };
}

/**
 * Side effects live here; everything is injectable so tests never touch Telegram.
 *
 * deps: { getDb, saveDb, sendDocument(chatId, fileName, text, caption), bossChatId,
 *         logoutAccount(key), notifyBoss(text) }
 */
export async function autoExportAccountAfterDelivery(orderRef, deps = {}) {
  const {
    getDb,
    saveDb = () => {},
    sendDocument = async () => {},
    bossChatId = 0,
    logoutAccount = async () => {},
    notifyBoss = async () => {},
    now = () => new Date().toISOString()
  } = deps;
  if (typeof getDb !== 'function') return { exported: false, reason: 'no db' };

  const db = getDb();
  const orders = db?.orders || {};
  const order = (orderRef && typeof orderRef === 'object') ? (orders[orderRef.id] || orderRef) : orders[orderRef];
  const plan = planDeliveryExport(db, order);
  if (!plan.shouldExport) return { exported: false, reason: plan.reason, accountKey: plan.accountKey || '' };

  let exportOk = false;
  let sendError = '';
  try {
    // File first — logout only after the Boss actually has the JSON in hand.
    await sendDocument(bossChatId, plan.fileName, plan.jsonText, plan.caption);
    exportOk = true;
  } catch (err) {
    sendError = String(err?.message || err).slice(0, 160);
  }

  if (!exportOk) {
    // No silent loss: say it out loud and try again on the next sweep.
    try {
      await notifyBoss(`⚠️ <b>Auto export fail</b> (order #${order.id}) — ${sendError || 'Telegram error'}\nAccount <code>${plan.phone}</code> vault me safe hai; dobara try hoga.`);
    } catch { /* ignore */ }
    return { exported: false, reason: `send failed: ${sendError}`, accountKey: plan.accountKey, phone: plan.phone };
  }

  try {
    await logoutAccount(plan.accountKey);
  } catch { /* logout failure must not claim success below */ }

  const freshDb = getDb();
  const stillThere = Boolean(freshDb?.config?.accounts?.[plan.accountKey]);
  const freshOrder = freshDb?.orders?.[order.id];
  if (freshOrder) {
    freshOrder.autoExportDoneAt = now();
    freshOrder.autoExportAccountKey = plan.accountKey;
    freshOrder.autoExportFile = plan.fileName;
  }
  try { saveDb(freshDb); } catch { /* ignore */ }

  try {
    await notifyBoss(
      `<blockquote>⇧ <b>AUTO EXPORT &amp; LOGOUT — DELIVERED</b></blockquote>\n` +
      `▪ <b>Order:</b> <code>#${order.id}</code>${order.swiggyOrderId ? ` (Swiggy <code>${order.swiggyOrderId}</code>)` : ''}\n` +
      `▪ <b>Account:</b> <code>${plan.phone}</code>\n` +
      `▪ <b>File:</b> <code>${plan.fileName}</code>\n` +
      `▪ <b>Bot vault:</b> ${stillThere ? '⚠️ account still present' : '✓ logged out &amp; removed'}`
    );
  } catch { /* ignore */ }

  return {
    exported: true,
    loggedOut: !stillThere,
    accountKey: plan.accountKey,
    phone: plan.phone,
    fileName: plan.fileName
  };
}
