import { Markup } from 'telegraf';
import { getDb, saveDb, getDraft, clearDraft, getActiveUserOrder } from './store.js';
import { getStoredSwiggyTrackingUrl } from './swiggy-cart.js';

/**
 * 4-Topic Progressive Progression System for Ammi & Abbu:
 *   Topic 1: 🛒 Submit Link (Cart + Address link input)
 *   Topic 2: 🧾 Bill & Confirmation (Live bill review & 1-tap customer approval)
 *   Topic 3: 💳 Payment & QR (Personalised UPI QR / direct Swiggy payment)
 *   Topic 4: 🛵 Live Tracking (Swiggy tracking link, delivery OTP, rider status)
 *
 * Each topic button unlocks ONLY when the previous level passes.
 * Finishing all topics returns cleanly to Start (Topic 1).
 */

export const TOPIC_LEVELS = {
  1: { id: 1, name: 'Submit Link', icon: '🛒', shortName: '1. Link' },
  2: { id: 2, name: 'Bill & Confirm', icon: '🧾', shortName: '2. Bill' },
  3: { id: 3, name: 'Payment & QR', icon: '💳', shortName: '3. Pay' },
  4: { id: 4, name: 'Live Tracking', icon: '🛵', shortName: '4. Track' }
};

export function getOrderCurrentTopic(order) {
  if (!order) return 1;

  // Level 4: Tracking (Payment completed or accepted with live tracking)
  if (['COMPLETED', 'ACCEPTED'].includes(order.status)) {
    return 4;
  }

  // Level 3: Payment (Bill approved by customer, payment QR/link ready)
  if (
    order.status === 'PAYMENT_PENDING' ||
    order.paymentSentToUser ||
    order.pendingSwiggyUpiUri ||
    order.realUpiIntentUri ||
    order.customerPaymentMessageId
  ) {
    return 3;
  }

  // Level 2: Bill & Confirmation (Order created, finding offers, awaiting customer approval)
  if (
    order.status === 'APPROVAL_PENDING' ||
    order.cardStage === 'AUTO_SELECTING' ||
    order.cardStage === 'BILL_READY' ||
    order.status === 'PENDING'
  ) {
    return 2;
  }

  return 1;
}

export function buildTopicNavKeyboardRows(currentTopic = 1, orderId = 'draft') {
  const t = Math.max(1, Math.min(4, Number(currentTopic) || 1));
  const safeId = String(orderId || 'draft').replace(/[^a-zA-Z0-9_-]/g, '_');

  const btn1 = {
    text: t === 1 ? '▶ 1. 🛒 Link' : '✓ 1. Link',
    callback_data: `topic_nav_1_${safeId}`,
    style: t === 1 ? 'success' : 'primary'
  };

  const btn2 = {
    text: t < 2 ? '🔒 2. Bill' : (t === 2 ? '▶ 2. 🧾 Bill' : '✓ 2. Bill'),
    callback_data: `topic_nav_2_${safeId}`,
    style: t === 2 ? 'success' : 'primary'
  };

  const btn3 = {
    text: t < 3 ? '🔒 3. Pay' : (t === 3 ? '▶ 3. 💳 Pay' : '✓ 3. Paid'),
    callback_data: `topic_nav_3_${safeId}`,
    style: t === 3 ? 'success' : 'primary'
  };

  const btn4 = {
    text: t < 4 ? '🔒 4. Track' : '▶ 4. 🛵 Track',
    callback_data: `topic_nav_4_${safeId}`,
    style: t === 4 ? 'success' : 'primary'
  };

  const prevTopic = Math.max(1, t - 1);
  const nextTopic = Math.min(4, t + 1);

  const slidePrevBtn = {
    text: t > 1 ? '◀ Previous' : '• Start',
    callback_data: `topic_nav_${prevTopic}_${safeId}`,
    style: 'primary'
  };

  const slideIndicatorBtn = {
    text: `Topic ${t} of 4`,
    callback_data: `topic_nav_${t}_${safeId}`,
    style: 'primary'
  };

  const slideNextBtn = {
    text: t < 4 ? (t < nextTopic && t >= currentTopic ? '🔒 Next ▶' : 'Next ▶') : '✓ Done',
    callback_data: `topic_nav_${nextTopic}_${safeId}`,
    style: 'primary'
  };

  return [
    [btn1, btn2],
    [btn3, btn4],
    [slidePrevBtn, slideIndicatorBtn, slideNextBtn]
  ];
}

export function formatTopicProgressBarText(currentTopic = 1) {
  const t = Math.max(1, Math.min(4, Number(currentTopic) || 1));
  const meta = TOPIC_LEVELS[t] || TOPIC_LEVELS[1];

  const s1 = t >= 1 ? (t === 1 ? '🟢' : '✓') : '🔒';
  const s2 = t >= 2 ? (t === 2 ? '🟢' : '✓') : '🔒';
  const s3 = t >= 3 ? (t === 3 ? '🟢' : '✓') : '🔒';
  const s4 = t >= 4 ? '🟢' : '🔒';

  return (
    `📍 <b>Topic ${t} of 4: ${meta.icon} ${meta.name}</b>\n` +
    `<code>[${s1} 1. Link] ➔ [${s2} 2. Bill] ➔ [${s3} 3. Pay] ➔ [${s4} 4. Track]</code>\n\n`
  );
}

export async function handleTopicNavClick(ctx, targetTopicNum, orderIdArg, { getUserScreenFn, formatUserOrderCardFn } = {}) {
  const userId = ctx.from.id;
  const targetTopic = parseInt(targetTopicNum, 10);
  const db = getDb();

  let order = null;
  if (orderIdArg && orderIdArg !== 'draft') {
    order = db.orders?.[orderIdArg] || Object.values(db.orders || {}).find(o => String(o.id) === String(orderIdArg));
  }
  if (!order) {
    order = getActiveUserOrder(userId);
  }

  const currentTopic = getOrderCurrentTopic(order);

  // If clicked a locked topic, show alert explaining why it's locked
  if (targetTopic > currentTopic) {
    const neededStep = targetTopic === 2
      ? 'Cart aur Address link submit karein'
      : (targetTopic === 3
        ? 'bill check karke "Approve bill" dabayein'
        : 'payment complete karein');
    return ctx.answerCbQuery(`🔒 Topic ${targetTopic} locked hai! Pehle ${neededStep}.`, { show_alert: true }).catch(() => {});
  }

  // If clicking an unlocked / active topic
  if (targetTopic === 1) {
    await ctx.answerCbQuery('✓ Topic 1: Link Submission').catch(() => {});
    if (!order && getUserScreenFn) {
      const scr = getUserScreenFn(userId, ctx.from);
      try { await ctx.editMessageText(scr.text, { parse_mode: 'HTML', ...scr.keyboard }); } catch {}
    } else if (order) {
      await ctx.reply(
        `✓ <b>Topic 1: Submitted Links (Order #${order.id})</b>\n\n` +
        `• <b>Cart:</b> <code>${String(order.cart || '').slice(0, 48)}</code>\n` +
        `• <b>Address:</b> ${order.address || 'Address attached'}\n` +
        `• <b>Status:</b> Submitted and verified ✓`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return;
  }

  if (targetTopic === 2) {
    await ctx.answerCbQuery('✓ Topic 2: Bill & Confirmation').catch(() => {});
    if (order && formatUserOrderCardFn) {
      const card = formatUserOrderCardFn(order);
      try { await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }); } catch {}
    }
    return;
  }

  if (targetTopic === 3) {
    await ctx.answerCbQuery('✓ Topic 3: Payment & QR').catch(() => {});
    if (order && formatUserOrderCardFn) {
      const card = formatUserOrderCardFn(order);
      try { await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }); } catch {}
    }
    return;
  }

  if (targetTopic === 4) {
    await ctx.answerCbQuery('✓ Topic 4: Live Tracking').catch(() => {});
    if (order && formatUserOrderCardFn) {
      const card = formatUserOrderCardFn(order);
      try { await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }); } catch {}
    }
    return;
  }
}

export function resetOrderTopicsToStart(userId) {
  clearDraft(userId);
  const db = getDb();
  const idNum = Number(userId);
  const userOrders = Object.values(db.orders || {}).filter(o => Number(o.userId) === idNum);
  for (const o of userOrders) {
    if (['PENDING', 'ACCEPTED'].includes(o.status)) {
      o.status = 'COMPLETED';
      o.topicsFinished = true;
    }
  }
  saveDb(db);
}
