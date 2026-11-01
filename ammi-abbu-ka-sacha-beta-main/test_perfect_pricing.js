import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const db = getDb();
  const acc = db.config.accounts.abbu;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
  await page.setCookie(...cookiePairs.map(p => {
    const [name, ...val] = p.split('=');
    return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
  })).catch(() => {});

  await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 600));
  }
  await new Promise(r => setTimeout(r, 2500));

  await page.goto('https://www.swiggy.com/checkout', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 3000));

  const pricingAnalysis = await page.evaluate(async () => {
    let cartRes = null;
    try {
      const r = await fetch('https://www.swiggy.com/dapi/cart');
      cartRes = await r.json();
    } catch (e) {}

    const cm = cartRes?.data?.cartMeta || {};

    // 1. Check coupon details
    let appliedCoupon = cm.coupon_code || null;
    let couponDiscount = cm.coupon_discount_total || cm.discount_total || 0;

    // 2. Check Free Cash / Swiggy Money
    let userFc = cm.user_swiggy_money || 0;
    let appliedFc = cm.swiggy_money || 0;

    // 3. Check Swiggy One & Free Delivery
    let freeDeliveryDiscount = cm.free_delivery_discount || cm.deliveryChargeStrikeOffAmount || 0;
    let swiggyOneApplied = Boolean(cm.swiggyOneBenefitsApplicable || cm.fullCouponLessFreeDeliveryApplied || cm.swiggyOneInfo?.presentationInfo?.is_super);
    let swiggyOneTrialAvailable = Boolean(cm.swiggyOneInfo?.presentationInfo?.plan_details || cm.croutonList?.some(c => c.type?.includes('ONE') || c.data?.text?.includes('1')));

    // 4. Try applying available coupon if not applied
    let triedCoupons = [];
    if (!appliedCoupon) {
      try {
        const offRes = await fetch(`https://www.swiggy.com/dapi/offers/payment?lat=26.8658609&lng=80.9307755&restaurantId=${cm.restaurant_details?.id || '803172'}&cart_val=${cm.order_total || 634}`);
        const offJson = await offRes.json();
        const availableCards = offJson?.data?.cards || [];
        for (const card of availableCards) {
          if (card.cardType === 'couponCard' && card.data?.couponCode) {
            triedCoupons.push(card.data.couponCode);
          }
        }
      } catch (e) {}

      // Common top Swiggy codes fallback
      const commonCodes = ['STEALDEAL', 'SWIGGYIT', 'WELCOME50', 'TRYNEW', 'FEAST50'];
      for (const code of [...new Set([...triedCoupons, ...commonCodes])].slice(0, 5)) {
        try {
          const appRes = await fetch('https://www.swiggy.com/dapi/cart/apply-coupon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ couponCode: code })
          });
          const appJson = await appRes.json();
          if (appJson.statusCode === 0) {
            appliedCoupon = code;
            break;
          }
        } catch (e) {}
      }
    }

    // 5. Try applying Swiggy Money / Free Cash if available and not applied
    if (userFc > 0 && appliedFc === 0) {
      try {
        const fcRes = await fetch('https://www.swiggy.com/dapi/cart/apply-swiggy-money', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apply: true })
        });
        const fcJson = await fcRes.json();
      } catch (e) {}
    }

    // Re-fetch updated cart
    try {
      const r2 = await fetch('https://www.swiggy.com/dapi/cart');
      const updated = await r2.json();
      if (updated?.data?.cartMeta) {
        Object.assign(cm, updated.data.cartMeta);
      }
    } catch (e) {}

    // Extract exact item details
    const items = [];
    if (cartRes?.data?.cartItems) {
      for (const [id, grp] of Object.entries(cartRes.data.cartItems)) {
        for (const it of grp.items || []) {
          items.push({
            name: it.name,
            qty: it.quantity || grp.quantity || 1,
            price: Math.round((it.final_price || it.total || it.price || 0) / 100)
          });
        }
      }
    }

    return {
      restaurantName: cm.restaurant_details?.name || 'Swiggy Restaurant',
      restaurantId: cm.restaurant_details?.id,
      items,
      itemTotal: cm.cart_subtotal || cm.total_without_coupon_discount || 0,
      deliveryFee: cm.positiveDeliveryChargesExclusive || 0,
      freeDeliveryDiscount: cm.free_delivery_discount || cm.deliveryChargeStrikeOffAmount || 0,
      swiggyOneApplied,
      swiggyOneSavings: cm.swiggyOneExclusiveDiscount || cm.free_delivery_discount || 0,
      couponCode: cm.coupon_code || appliedCoupon,
      couponDiscount: cm.coupon_discount_total || cm.discount_total || 0,
      freeCashBalance: cm.user_swiggy_money || 0,
      freeCashApplied: cm.swiggy_money || 0,
      gstAndCharges: cm.taxes || (cm.taxesAndCharges?.gstAndChargesPresentationInfo ? parseFloat(cm.taxesAndCharges.gstAndChargesPresentationInfo) : 0),
      orderTotal: cm.order_total || cm.cart_total,
      finalPayable: cm.order_total || cm.cart_total,
      savings: (cm.free_delivery_discount || 0) + (cm.coupon_discount_total || 0) + (cm.swiggy_money || 0)
    };
  });

  console.log('PRICING ANALYSIS RESULT:', JSON.stringify(pricingAnalysis, null, 2));

  await browser.close();
})();
