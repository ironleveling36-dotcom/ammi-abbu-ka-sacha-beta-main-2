import { getDb, isBoss, saveDbDurable } from './store.js';
import { readSwiggyPlacement } from './swiggy-placement-journal.js';
import { backupMoneyNow } from './db-durability.js';
import { chargeServiceFee, getWallet, refundServiceFee, rupees, serviceFeePaiseFor, walletBalancePaise } from './user-wallet.js';

export function chatOrderOwner(order) {
  const forwarded = String(order?.fwdSenderUserId || '').trim();
  const fallback = String(order?.userId || order?.userChatId || '').trim();
  // Telegram can hide a forwarded sender. Never mistake the forwarding boss
  // for the customer and silently waive that customer's fee.
  if (order?.isForwardedOrder && !order?.isDirectBossOrder && !forwarded && isBoss(fallback)) return '';
  const owner = forwarded || fallback;
  return /^\d{1,20}$/.test(owner) && owner !== '0' ? owner : '';
}

export function chatPlacementRecord(order) {
  if (!order?.id) return null;
  return readSwiggyPlacement(`chat:${String(order.id).trim()}`) ||
    (order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.swiggyPlacedUnpaid
      ? { state: 'LEGACY_PENDING', orderId: order.pendingSwiggyOrderId || '' }
      : null);
}

/** Synchronous check + debit, on the order OWNER, before any provider work. */
export function reserveChatOrderFee(orderId) {
  const db = getDb();
  const order = db.orders?.[String(orderId || '')];
  if (!order) return null; // normal order-not-found handling remains in the QR flow
  if (['COMPLETED', 'PAID', 'CANCELLED', 'REJECTED'].includes(String(order.status || '').toUpperCase())) {
    const err = new Error('Closed order par naya QR nahi banega.');
    err.code = 'ORDER_CLOSED';
    err.diag = { code: err.code, placementAttempted: false };
    throw err;
  }
  // Existing/uncertain placements are never retried; existing payment details
  // must remain accessible without a new balance gate or a second debit.
  if (chatPlacementRecord(order)) return { existingPlacement: true };
  const userId = chatOrderOwner(order);
  if (!userId) {
    const err = new Error('Order owner identify nahi hua. Admin se baat karein.');
    err.code = 'FEE_OWNER_UNKNOWN';
    err.diag = { code: err.code, placementAttempted: false };
    throw err;
  }
  if (isBoss(userId)) return { userId, admin: true };
  const charge = chargeServiceFee(db, order, userId, { actor: 'order' });
  if (!charge.ok) {
    const err = new Error(charge.code === 'INSUFFICIENT_BALANCE'
      ? `Wallet ₹${rupees(charge.balancePaise)} hai; order fee ₹${rupees(charge.feePaise)}. Bot me Wallet se add karein.`
      : 'Wallet check nahi hua. Admin se baat karein.');
    err.code = charge.code === 'INSUFFICIENT_BALANCE' ? 'WALLET_LOW_BALANCE' : charge.code;
    err.diag = { code: err.code, placementAttempted: false, userId, balancePaise: charge.balancePaise, feePaise: charge.feePaise };
    throw err;
  }
  db.orders[order.id] = order;
  if (!saveDbDurable(db)) {
    const err = new Error('Wallet record save nahi hua; order place nahi hua. Admin se baat karein.');
    err.code = 'WALLET_SAVE_FAILED';
    err.diag = { code: err.code, placementAttempted: false };
    throw err;
  }
  if (charge.code === 'CHARGED') backupMoneyNow().catch(() => {});
  return { userId, chargeCode: charge.code };
}

/** Recheck just before the journal/POST in case an order was cancelled while
 * its bill/account work was in flight. No async gap is allowed before dispatch. */
export function assertChatOrderFeeStillReserved(orderId) {
  const db = getDb();
  const order = db.orders?.[String(orderId || '')];
  const userId = chatOrderOwner(order);
  const fail = (code, message) => {
    const err = new Error(message);
    err.code = code;
    err.diag = { code, placementAttempted: false };
    throw err;
  };
  if (!order || !userId) return fail('FEE_OWNER_UNKNOWN', 'Order owner identify nahi hua.');
  if (['COMPLETED', 'PAID', 'CANCELLED', 'REJECTED'].includes(String(order.status || '').toUpperCase())) {
    return fail('ORDER_CLOSED', 'Order band ho gaya; Swiggy request nahi bheji.');
  }
  if (isBoss(userId) || getWallet(db, userId)?.feeExempt || serviceFeePaiseFor(db) <= 0) return true;
  const net = Number(order.feeChargedPaise || 0) - Number(order.feeRefundedPaise || 0);
  if (net <= 0 || String(order.feeWalletUserId || '') !== userId) {
    return fail('WALLET_LOW_BALANCE', `Wallet ₹${rupees(walletBalancePaise(db, userId))}. Bot me Wallet check karein.`);
  }
  return true;
}

/** A dispatched/uncertain POST is never refunded automatically. */
export function refundChatOrderFeeBeforePlacement(orderId, reservation, err) {
  if (!reservation?.userId || reservation.admin || reservation.existingPlacement || err?.diag?.placementAttempted === true) return null;
  const db = getDb();
  const order = db.orders?.[String(orderId || '')];
  if (!order || chatPlacementRecord(order)) return null;
  const result = refundServiceFee(db, order, reservation.userId, { reason: 'order place nahi hua' });
  if (result.ok) {
    db.orders[order.id] = order;
    if (!saveDbDurable(db)) return { ok: false, code: 'WALLET_SAVE_FAILED' };
    backupMoneyNow().catch(() => {});
  }
  return result;
}
