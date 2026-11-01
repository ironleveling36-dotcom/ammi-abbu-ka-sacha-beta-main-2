import puppeteer from 'puppeteer-core';
import { getDb } from './store.js';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function parseCartFromPage(page) {
  let cartData = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cartData = await page.evaluate(async () => {
        let scrapedItems = [];
        let scrapedRestName = null;
        let scrapedSubtotal = 0;
        let scrapedTotal = 0;
        let scrapedCoupon = null;
        let scrapedDiscount = 0;
        let scrapedAddress = null;

        try {
          const res = await fetch('https://www.swiggy.com/dapi/cart');
          const json = await res.json();
          if (json?.data) {
            const d = json.data;
            // 1. Restaurant Name
            if (d.cartMeta?.restaurant_details?.name) {
              scrapedRestName = d.cartMeta.restaurant_details.name;
            } else if (d.cart?.restaurant?.name) {
              scrapedRestName = d.cart.restaurant.name;
            }

            // 2. Items from cartItems object or cart.items
            if (d.cartItems && typeof d.cartItems === 'object') {
              for (const group of Object.values(d.cartItems)) {
                if (group.items && Array.isArray(group.items)) {
                  for (const it of group.items) {
                    scrapedItems.push({
                      name: it.name,
                      qty: it.quantity || group.quantity || 1,
                      price: Math.round((it.final_price || it.total || it.price || 0) / 100)
                    });
                  }
                }
              }
            } else if (d.cart?.items && Array.isArray(d.cart.items)) {
              for (const it of d.cart.items) {
                scrapedItems.push({
                  name: it.name,
                  qty: it.quantity || 1,
                  price: Math.round((it.finalPrice || it.price || 0) / 100)
                });
              }
            }

            // 3. Totals
            if (d.cartMeta?.order_total) {
              scrapedTotal = d.cartMeta.order_total;
            } else if (d.cartMeta?.cart_total) {
              scrapedTotal = d.cartMeta.cart_total;
            } else if (d.cart?.bill?.total) {
              scrapedTotal = Math.round(d.cart.bill.total / 100);
            }

            if (d.cartMeta?.total_without_coupon_discount) {
              scrapedSubtotal = d.cartMeta.total_without_coupon_discount;
            } else if (d.cart?.bill?.subTotal) {
              scrapedSubtotal = Math.round(d.cart.bill.subTotal / 100);
            }

            // 4. Address from cartMeta
            if (d.cartMeta?.addresses && Array.isArray(d.cartMeta.addresses)) {
              const selectedAddr = d.cartMeta.addresses.find(a => a.selected) || d.cartMeta.addresses.find(a => a.default) || d.cartMeta.addresses[0];
              if (selectedAddr) {
                const tag = selectedAddr.annotation ? `[${selectedAddr.annotation}] ` : '';
                scrapedAddress = `${tag}${selectedAddr.flat_no && selectedAddr.flat_no !== 'None' ? selectedAddr.flat_no + ', ' : ''}${selectedAddr.address}`;
              }
            }
          }
        } catch (e) {}

        return {
          restaurantName: scrapedRestName,
          items: scrapedItems,
          subtotal: scrapedSubtotal || scrapedTotal,
          finalPayable: scrapedTotal,
          address: scrapedAddress,
          couponCode: scrapedCoupon,
          discountAmount: scrapedDiscount
        };
      });
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return cartData;
}

(async () => {
  const db = getDb();
  const acc = db.config.accounts.abbu;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--no-sandbox']
  });

  const page = await browser.newPage();
  const cookiePairs = acc.cookies.split(';').map(s => s.trim()).filter(Boolean);
  await page.setCookie(...cookiePairs.map(p => {
    const [name, ...val] = p.split('=');
    return { name, value: val.join('='), domain: '.swiggy.com', path: '/' };
  })).catch(() => {});

  await page.goto('https://www.swiggy.com/', { waitUntil: 'load' });
  for (let i = 0; i < 15; i++) {
    const pageCookies = await page.cookies();
    const waf = pageCookies.find(c => c.name === 'aws-waf-token');
    if (waf && waf.value.length > 50) break;
    await new Promise(r => setTimeout(r, 600));
  }
  await new Promise(r => setTimeout(r, 3000));

  const result = await parseCartFromPage(page);
  console.log('PARSED CART RESULT:\n', JSON.stringify(result, null, 2));

  await browser.close();
})();
