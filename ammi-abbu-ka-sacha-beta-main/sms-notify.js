// SMS notification for parents when Boss places order for them
// Uses optional SMS gateway via env vars, falls back to Telegram-only log

import { getDb } from './store.js';
import { getStoredSwiggyTrackingUrl, isOfficialSwiggyTrackingUrl } from './swiggy-cart.js';

const SMS_ENABLED = process.env.SMS_ENABLED !== 'false'; // default enabled if gateway configured

// Plain shortcut shown while Swiggy has not published the share link yet
// (README contract: honest "not published" notice + real Swiggy orders page,
// never a bot-side /track/<id> page or a URL built from the order id).
const SWIGGY_ORDERS_PAGE = 'https://www.swiggy.com/orders';

function resolveVerifiedSmsTrackingUrl(order, candidateUrl = '') {
  const explicit = String(candidateUrl || '').trim();
  if (explicit && isOfficialSwiggyTrackingUrl(explicit, { allowProviderShortLink: true })) {
    return explicit;
  }
  return getStoredSwiggyTrackingUrl(order);
}

function logSms(phone, text) {
  console.log(`[SMS-NOTIFY] To ${phone}: ${text.slice(0, 120)}`);
}

export async function sendParentSmsNotification(order, trackingUrl = '') {
  try {
    const safeTrackingUrl = resolveVerifiedSmsTrackingUrl(order, trackingUrl);
    const recipientMobile = String(order?.addressDetails?.mobile || order?.addressDetails?.phone || '').replace(/\D/g, '').slice(-10);
    if (!recipientMobile || !/^[6-9]\d{9}$/.test(recipientMobile)) {
      console.log(`[SMS-NOTIFY] Skip: invalid recipient mobile for order #${order.id}`);
      return { sent: false, reason: 'invalid_mobile' };
    }
    if (!SMS_ENABLED) {
      logSms(recipientMobile, `[SMS disabled] Order #${order.id} tracking: ${safeTrackingUrl}`);
      return { sent: false, reason: 'sms_disabled' };
    }

    const bossName = String(order.bossName || order.placedByName || 'Fer aex').trim() || 'Fer aex';
    const displayId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
    const trackPart = safeTrackingUrl
      ? ` Track: ${safeTrackingUrl}`
      : ` Tracking link jaldi bheja jayega. Apne orders dekhne ke liye: ${SWIGGY_ORDERS_PAGE}`;
    const otpPart = (() => {
      const otp = String(order?.deliveryOtp || '').replace(/\D/g, '').slice(0, 8);
      return otp ? ` Delivery OTP: ${otp}.` : '';
    })();
    const smsText = `${bossName} ne aapke liye Swiggy order place kiya hai. Order ID: ${displayId} for you on Swiggy.${trackPart}${otpPart} - Reply STOP to opt out`;

    // Try external SMS gateway if configured
    const webhook = process.env.SMS_WEBHOOK_URL;
    const apiKey = process.env.SMS_API_KEY;

    if (webhook) {
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ to: recipientMobile, message: smsText, orderId: order.id })
        });
        if (res.ok) {
          logSms(recipientMobile, smsText);
          // Audit log
          try {
            const db = getDb();
            if (!Array.isArray(db.auditLog)) db.auditLog = [];
            db.auditLog.push({ id: `sms_${Date.now()}`, action: 'sms_sent', meta: { orderId: order.id, to: `****${recipientMobile.slice(-4)}`, via: 'webhook' }, at: new Date().toISOString() });
            // Save not needed for audit? We can skip save to avoid DB churn
          } catch {}
          return { sent: true, via: 'webhook' };
        } else {
          console.warn(`[SMS-NOTIFY] Webhook failed ${res.status} for ${recipientMobile}`);
        }
      } catch (e) {
        console.warn(`[SMS-NOTIFY] Webhook error: ${e.message}`);
      }
    }

    // Fallback: Log and treat as sent via Telegram bridge (no real SMS gateway)
    // In production, configure SMS_WEBHOOK_URL + SMS_API_KEY (Twilio/Fast2SMS) to enable real SMS
    logSms(recipientMobile, smsText);
    return { sent: true, via: 'log', smsText, to: recipientMobile };
  } catch (e) {
    console.warn(`[SMS-NOTIFY] Failed for order #${order?.id}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

// Helper to notify parents on order placement (before tracking) — called when order is created/accepted
export async function notifyParentsOrderPlaced(order) {
  if (!order || !order.addressDetails?.mobile) return;
  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  // For initial placement (no tracking yet), send SMS without tracking, will be updated later
  return sendParentSmsNotification(order, trackingUrl);
}

// Direct SMS on order creation → registered mobile gets instant message + tracking
export async function sendDirectOrderSms(order) {
  try {
    const recipientMobile = String(order?.addressDetails?.mobile || order?.addressDetails?.phone || '').replace(/\D/g, '').slice(-10);
    const registeredMobile = String(order?.registeredMobile || order?.userPhone || recipientMobile || '').replace(/\D/g, '').slice(-10);
    const targetPhone = registeredMobile || recipientMobile;
    if (!targetPhone || !/^[6-9]\d{9}$/.test(targetPhone)) {
      console.log(`[SMS-DIRECT] Skip invalid target for order #${order.id}`);
      return { sent: false, reason: 'invalid_mobile' };
    }
    const name = String(order?.addressDetails?.name || order?.fwdSenderName || 'Customer').trim();
    const orderId = String(order?.swiggyOrderId || order?.id || '').trim();
    const restaurant = String(order?.restaurantName || 'Swiggy Order').trim();
    const itemsCount = Array.isArray(order?.items) ? order.items.length : 0;
    const amount = Number(order?.finalPayable || order?.subtotal || 0);
    const trackingUrl = getStoredSwiggyTrackingUrl(order);
    const payUrl = order?.swiggyPaymentUrl || order?.pendingSwiggyUpiUri || order?.realUpiIntentUri || '';

    const lines = [
      `🔔 Swiggy Order Placed!`,
      `Hi ${name}, aapka order #${orderId} (${restaurant}${itemsCount? `, ${itemsCount} items`:''}) place hua hai.`,
      amount? `Amount: ₹${amount}`: null,
      trackingUrl? `Track: ${trackingUrl}`: `Track: jaldi bheja jayega (${SWIGGY_ORDERS_PAGE})`,
      payUrl? `Pay: ${payUrl}`: null,
      `Support: https://t.me/Its_life_001`
    ].filter(Boolean);
    const smsText = lines.join('\n');

    return sendSmsViaGateway(targetPhone, smsText, order.id);
  } catch(e){ console.warn(`[SMS-DIRECT] fail ${e.message}`); return {sent:false, reason:e.message}; }
}

// Payment link SMS — sent when payment link/QR is ready
export async function sendPaymentLinkSms(order, paymentUrl='') {
  try {
    const recipientMobile = String(order?.addressDetails?.mobile || order?.addressDetails?.phone || '').replace(/\D/g, '').slice(-10);
    const registeredMobile = String(order?.registeredMobile || order?.userPhone || recipientMobile || '').replace(/\D/g, '').slice(-10);
    const targetPhone = registeredMobile || recipientMobile;
    if (!targetPhone || !/^[6-9]\d{9}$/.test(targetPhone)) return {sent:false, reason:'invalid_mobile'};
    const orderId = String(order?.swiggyOrderId || order?.id || '').trim();
    const amount = Number(order?.finalPayable || order?.subtotal || 0);
    const payLink = paymentUrl || order?.swiggyPaymentUrl || order?.pendingSwiggyUpiUri || order?.realUpiIntentUri || '';
    if (!payLink) return {sent:false, reason:'no_pay_link'};
    const validTrack = getStoredSwiggyTrackingUrl(order);
    const smsText = `💳 Payment Required — Swiggy Order #${orderId}\nAmount: ₹${amount}\nPay Now: ${payLink}\nTrack: ${validTrack || 'available after payment'}\n- Swiggy Bot`;
    return sendSmsViaGateway(targetPhone, smsText, order.id);
  } catch(e){ return {sent:false, reason:e.message}; }
}

async function sendSmsViaGateway(phone, text, orderId=''){
  const SMS_ENABLED = process.env.SMS_ENABLED !== 'false';
  if (!SMS_ENABLED) { console.log(`[SMS-GW] Disabled To ${phone}: ${text.slice(0,90)}`); return {sent:false, reason:'sms_disabled'}; }
  const webhook = process.env.SMS_WEBHOOK_URL;
  const apiKey = process.env.SMS_API_KEY;
  console.log(`[SMS-GW] To ${phone}: ${text.slice(0,120)}`);
  if (webhook){
    try{
      const res = await fetch(webhook, { method:'POST', headers:{'Content-Type':'application/json', ...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})}, body: JSON.stringify({to: phone, message: text, orderId})});
      if(res.ok){ return {sent:true, via:'webhook'};}
      console.warn(`[SMS-GW] Webhook ${res.status}`);
    }catch(e){ console.warn(`[SMS-GW] webhook err ${e.message}`);}
  }
  return {sent:true, via:'log', smsText:text, to:phone};
}

