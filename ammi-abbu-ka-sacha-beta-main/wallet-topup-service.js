import { getDb, saveDbDurable } from './store.js';
import { backupMoneyNow } from './db-durability.js';
import { fetchUtrPaymentDetails } from './utr-lookup.js';
import { recordStatementPayment, settledPendingClaims } from './upi-statement.js';
import { rupees, submitTopupRequestWithLookup, validateUtr } from './user-wallet.js';

const notificationsInFlight = new Map();
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Look up first, then atomically apply to a fresh DB without yielding. */
export async function submitBotWalletTopup(options = {}) {
  const checked = validateUtr(options.utr);
  let lookupResult = null;
  if (checked.ok && options.autoVerify !== false) {
    lookupResult = await fetchUtrPaymentDetails(checked.utr, {
      fetchImpl: options.fetchImpl || globalThis.fetch, userId: options.userId
    }).catch((err) => ({ configured: false, found: false, reason: String(err?.message || err), tried: [] }));
  }
  const db = getDb();
  const result = submitTopupRequestWithLookup(db, { ...options, lookupResult });
  if (result.request) {
    if (!saveDbDurable(db)) {
      const err = new Error('Recharge record save nahi hua. Admin se baat karein; dobara payment na bhejein.');
      err.code = 'WALLET_SAVE_FAILED';
      throw err;
    }
    backupMoneyNow().catch(() => {});
  }
  return result;
}

/** Pending claims remain in the ledger even if Telegram delivery fails. */
export function notifyPendingTopup(telegram, requestId) {
  const key = String(requestId || '');
  if (!key || typeof telegram?.sendMessage !== 'function') return Promise.resolve({ sent: 0 });
  if (notificationsInFlight.has(key)) return notificationsInFlight.get(key);
  const task = notifyPendingTopupInner(telegram, key).finally(() => notificationsInFlight.delete(key));
  notificationsInFlight.set(key, task);
  return task;
}

async function notifyPendingTopupInner(telegram, requestId) {
  const db = getDb();
  const req = db.config?.topupRequests?.[requestId];
  if (!req || req.status !== 'PENDING') return { sent: 0 };
  const ids = [...new Set([...(db.config?.bossIds || []), process.env.BOSS_ID].map(String).filter(id => /^\d+$/.test(id) && id !== '0'))];
  const already = new Set(Array.isArray(req.adminNotifiedTo) ? req.adminNotifiedTo.map(String) : []);
  let sent = 0;
  for (const id of ids) {
    if (already.has(id)) continue;
    try {
      await telegram.sendMessage(id,
        `⏳ <b>Recharge pending</b>\n` +
        `User: ${esc(req.name || req.userId)} · <code>${esc(req.userId)}</code>${req.username ? ` · @${esc(req.username)}` : ''}\n` +
        `UTR: <code>${esc(req.utr)}</code> · claimed ₹${rupees(req.claimedPaise)}\n` +
        `Payment check karein; sirf actual amount approve karein.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: `✅ ₹${rupees(req.claimedPaise)} approve`, callback_data: `boss_utr_ok_${req.id}` },
           { text: '❌ Reject', callback_data: `boss_utr_no_${req.id}` }],
          [{ text: '✏️ Actual amount', callback_data: `boss_utr_amount_${req.id}` }]
        ] } }
      );
      sent += 1;
      // A concurrent approval/fee debit may have changed the DB during send.
      const fresh = getDb();
      const current = fresh.config?.topupRequests?.[requestId];
      if (current) {
        current.adminNotifiedTo = [...new Set([...(current.adminNotifiedTo || []).map(String), id])];
        current.adminNotifiedAt = new Date().toISOString();
        saveDbDurable(fresh);
      }
    } catch (err) {
      console.warn(`[Wallet] Could not notify admin ${id} for ${requestId}:`, err?.message || err);
    }
  }
  return { sent, admins: ids.length };
}

let pendingLookupRetry = null;

// Recheck pending claims against the configured evidence source. Network I/O
// is followed by a fresh DB read; no stale pre-await wallet is ever saved.
export function retryPendingWalletUtrs({ telegram, limit = 5, fetchImpl } = {}) {
  if (pendingLookupRetry) return pendingLookupRetry;
  pendingLookupRetry = (async () => {
    const candidates = Object.values(getDb().config?.topupRequests || {})
      .filter((req) => String(req?.status || '').toUpperCase() === 'PENDING' && validateUtr(req?.utr).ok)
      .slice(0, limit).map((req) => ({ id: req.id, utr: req.utr }));
    let credited = 0;
    for (const candidate of candidates) {
      const lookup = await fetchUtrPaymentDetails(candidate.utr, { fetchImpl: fetchImpl || globalThis.fetch }).catch(() => null);
      if (!lookup?.found || !lookup.payment) continue;
      const db = getDb();
      const current = db.config?.topupRequests?.[candidate.id];
      if (!current || String(current.status).toUpperCase() !== 'PENDING' || current.utr !== candidate.utr) continue;
      const saved = recordStatementPayment(db, lookup.payment, { actor: 'utr-lookup-retry' });
      if (!saved.ok) continue;
      const settled = settledPendingClaims(db, { actor: 'utr-lookup-retry' });
      if (!saveDbDurable(db)) continue;
      await backupMoneyNow({ force: true });
      for (const result of settled.filter((entry) => entry.action === 'CREDIT')) {
        credited += 1;
        if (telegram?.sendMessage) await telegram.sendMessage(result.userId, 'Verified recharge wallet me add ho gaya.').catch(() => {});
      }
    }
    return { credited };
  })().finally(() => { pendingLookupRetry = null; });
  return pendingLookupRetry;
}

/** Retry unsent notifications after transient Telegram errors/restarts. */
export async function retryPendingTopupNotifications(telegram, { limit = 50 } = {}) {
  const db = getDb();
  const ids = [...new Set([...(db.config?.bossIds || []), process.env.BOSS_ID].map(String).filter(id => /^\d+$/.test(id) && id !== '0'))];
  const pending = Object.values(db.config?.topupRequests || {}).filter(r =>
    r?.status === 'PENDING' && ids.some(id => !(r.adminNotifiedTo || []).map(String).includes(id))
  ).slice(0, limit);
  for (const req of pending) await notifyPendingTopup(telegram, req.id);
  return pending.length;
}
