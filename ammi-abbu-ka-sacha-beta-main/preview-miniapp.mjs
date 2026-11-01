/**
 * Local visual/interaction QA only. Serves the production HTML/CSS/JS with
 * isolated demo responses; it never calls Swiggy or places an order. The
 * preview is visibly labelled and refuses real checkout/UPI actions.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

// A scannable *text* marker for the payment layout, not a payment QR.
let DEMO_QR = '';
try {
  const QR = (await import('qrcode')).default;
  DEMO_QR = await QR.toDataURL('DEMO ONLY - NOT A PAYMENT QR', { margin: 1, width: 320 });
} catch { /* the payment scene also works without a demo image */ }

const now = new Date();
const demoAddress = {
  id: 'demo-home', ref: 'demo-home', annotation: 'Home', name: 'Ammi', mobile: '9000000003',
  address: '42 Lake Road, Green Park, Pune'
};
const demoRestaurants = [
  { id: 'demo-1', name: 'The Curry House', area: 'Green Park', rating: '4.4', ratings: '1K+ ratings', time: '30–40 mins', distance: '1.8 km', cuisines: 'Indian, North Indian', isOpen: true },
  { id: 'demo-2', name: 'The Curry House', area: 'Lake Road', rating: '4.2', ratings: '500+ ratings', time: '35–45 mins', distance: '3 km', cuisines: 'Indian, North Indian', isOpen: true },
  { id: 'demo-3', name: 'Green Leaf Kitchen', area: 'Green Park', rating: '4.5', ratings: '900+ ratings', time: '25–35 mins', distance: '2 km', cuisines: 'Vegetarian, Indian', isOpen: true }
];
const demoCategories = [
  { title: 'Popular dishes', items: [
    { id: 'demo-dish-1', name: 'Paneer tikka bowl', price: 189, isVeg: true, inStock: true, customizable: false, description: 'Spiced paneer with rice and vegetables.' },
    { id: 'demo-dish-2', name: 'Butter chicken', price: 229, isVeg: false, inStock: true, customizable: false, description: 'Chicken in a mild, creamy tomato gravy.' },
    { id: 'demo-dish-3', name: 'Masala naan', price: 65, isVeg: true, inStock: true, customizable: false, description: 'Freshly baked flatbread.' }
  ] },
  { title: 'Sides', items: [
    { id: 'demo-dish-4', name: 'Mint raita', price: 49, isVeg: true, inStock: true, customizable: false, description: 'Yogurt with mint and spices.' }
  ] }
];
const demoState = {
  ok: true,
  user: { id: '9000', name: 'Demo', firstName: 'Demo', isBoss: true },
  accounts: [
    { key: 'demo-account-1', name: 'Ammi', phoneMasked: '90••••0001', active: true, status: 'USED', used: true, fresh: false, night: true, breakfast: true, selectable: true, isLoggedIn: true, owner: 'self', offerTracks: [
      { label: 'Late night (9PM–6AM)', emoji: '🌙', status: 'CLAIMED', verified: true },
      { label: 'Breakfast (7AM–11AM)', emoji: '☀️', status: 'ALREADY_CLAIMED', verified: true },
      { label: 'Extra ₹50 offer', emoji: '💸', status: 'FAILED', verified: false },
      { label: 'Weekend offer', emoji: '🎉', status: 'NOT_CLAIMED', verified: false },
      { label: 'Karwa Chauth', emoji: '🪔', status: 'NOT_CLAIMED', verified: false }
    ] },
    { key: 'demo-account-2', name: 'Abbu', phoneMasked: '90••••0002', active: false, status: 'READY', used: false, fresh: true, night: false, breakfast: false, selectable: true, isLoggedIn: true, owner: 'self', offerTracks: [] }
  ],
  activeAccount: { key: 'demo-account-1', name: 'Ammi', phoneMasked: '90••••0001' },
  selectedAddress: demoAddress,
  checkout: null,
  checkoutEnabled: true,
  ordersDetailAllowed: true,
  cart: {
    restaurantId: 'demo-1', restaurantName: 'The Curry House', restaurantArea: 'Green Park',
    restaurantTime: '30–40 mins', restaurantRating: '4.4',
    items: [{ id: 'demo-dish-1', lineKey: 'demo-line-1', name: 'Paneer tikka bowl', price: 189, qty: 2, isVeg: true }],
    quote: { itemTotal: 378, deliveryFee: 28, deliverySaved: 28, taxes: 42, total: 398, coupon: '', couponCode: '', discount: 0, freeCash: 50, offerNote: '2 Free Cash claim active.', offerTracks: [{ key: 'lateNight', label: 'Night', status: 'CLAIMED', verified: true }, { key: 'breakfast', label: 'Breakfast', status: 'CLAIMED', verified: true }], fetchedAt: now.toISOString() }
  },
  coupons: [
    { code: 'DEMO50', title: '₹50 OFF', description: 'Example offer for this preview.' },
    { code: 'DEMO20', title: '20% OFF', description: 'Example discount on selected dishes.' },
    { code: 'WELCOME', title: '₹25 OFF', description: 'Example welcome offer.' }
  ],
  orders: [
    { id: 'DEMO-1001', status: 'Delivered', restaurant: 'Green Leaf Kitchen', amount: 249, placedAt: now.toISOString(), items: [{ name: 'Veg thali', qty: 1, price: 249 }] },
    { id: 'DEMO-1002', status: 'On the way', restaurant: 'The Curry House', amount: 448, placedAt: now.toISOString(), items: [{ name: 'Paneer tikka bowl', qty: 2, price: 189 }] }
  ],
  orderFee: { exempt: true },
  identities: { cloud: true, total: 2, live: 2, expired: 0, workspaceCount: 1, line: 'Demo backup status only.', accounts: [] },
  durability: { cloud: true, wallets: 0, utrs: 0, line: 'Demo backup status only.' }
};

function sceneState(scene) {
  const state = JSON.parse(JSON.stringify(demoState));
  // Demo bill ka clock har request par taaza — preview me Pay Now ke bagal
  // wala 2-minute countdown chalta hua dikhe.
  if (state.cart?.quote) state.cart.quote.fetchedAt = new Date().toISOString();
  if (scene === 'empty') { state.cart = null; state.selectedAddress = null; }
  if (scene === 'blocked') {
    state.checkoutEnabled = false;
    state.checkoutBlockReason = 'Demo checkout is disabled for this preview.';
  }
  if (scene === 'stress') {
    state.accounts[0].name = 'An exceptionally long account name for layout testing';
    state.activeAccount.name = state.accounts[0].name;
    state.selectedAddress.address = 'Very long building and delivery instructions, near the old market, across the road, ' + 'long-address-'.repeat(8);
    state.cart.restaurantName = 'A very long restaurant and kitchen name for layout testing';
    state.cart.items[0].name = 'An exceptionally long dish name with a lot of detail that needs to wrap neatly';
    state.coupons[0].code = 'VERYLONGDEMOOFFERCODE';
    state.orders[0].restaurant = 'A very long restaurant and kitchen name for layout testing';
  }
  if (scene === 'paypending') {
    state.checkout = {
      status: 'PAYMENT_PENDING', orderId: 'DEMO-1001', amount: 448,
      qrDataUrl: DEMO_QR, upiIntentUrl: 'upi://pay?pa=preview@invalid&pn=Preview&am=448&cu=INR',
      paymentVerified: false, message: 'Demo payment screen — no payment can be made.', tracking: null, sms: null
    };
  }
  if (scene === 'share') {
    // Swiggy ka asli share link jaisa — preview me sirf dikhane ke liye.
    state.orders[0].trackingUrl = 'https://www.swiggy.com/ofo/track/DEMO-TOKEN-9F2A';
  }
  if (scene === 'cancel') {
    // Round 35: uncertain checkout — ab sirf cancel ka raasta.
    state.checkout = {
      status: 'OUTCOME_UNKNOWN', orderId: 'DEMO-1001', amount: 448,
      accountPhone: '90••••0001', message: 'The response was lost. Ek order ban gaya ho sakta hai.'
    };
  }
  if (scene === 'billloading') {
    // Bill abhi aa raha hai — curved circular loader.
    state.cart.quote = null;
    state.cart.optimizePending = false;
  }
  if (scene.startsWith('handoff-')) {
    const stage = scene.slice('handoff-'.length).toUpperCase();
    state.chatHandoff = {
      activeId: 'demo-handoff', stage, pendingId: '', address: demoAddress,
      cartFetched: stage === 'CART' || stage === 'BILL'
    };
  }
  return state;
}

function previewBoot(scene) {
  const initial = JSON.stringify(sceneState(scene));
  const restaurants = JSON.stringify(demoRestaurants);
  const categories = JSON.stringify(demoCategories);
  const addresses = JSON.stringify([
    demoAddress,
    { id: 'demo-work', ref: 'demo-work', annotation: 'Work', name: 'Abbu', mobile: '9000000004', address: '18 Market Street, Pune' }
  ]);
  return `<style>
    .preview-notice { position: sticky; top: calc(64px + var(--safe-top, 0px)); z-index: 9; padding: 7px 12px; background: #fff3cf; color: #614613; text-align: center; font: 700 11px/1.3 system-ui, sans-serif; }
    [data-preview-upi] { opacity: .65; cursor: not-allowed; }
  </style><script>
  (() => {
    const STATE = ${initial};
    const RESTAURANTS = ${restaurants};
    const CATEGORIES = ${categories};
    const ADDRESSES = ${addresses};
    window.Telegram = { WebApp: { initData: 'preview=1', ready(){}, expand(){}, colorScheme: 'light', HapticFeedback: {} } };
    const realFetch = window.fetch;
    const copy = value => JSON.parse(JSON.stringify(value));
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => copy(body) });
    const recalculate = () => {
      if (!STATE.cart) return;
      const itemTotal = STATE.cart.items.reduce((n, item) => n + Number(item.price || 0) * Number(item.qty || 0), 0);
      STATE.cart.quote = { itemTotal, deliveryFee: 28, deliverySaved: 28, taxes: 42, total: itemTotal + 70, coupon: '', discount: 0, fetchedAt: new Date().toISOString() };
    };
    window.fetch = async (target, options = {}) => {
      const url = new URL(String(target), window.location.href);
      if (!url.pathname.startsWith('/pro/api/')) return realFetch(target, options);
      const route = url.pathname.slice('/pro/api/'.length);
      let body = {};
      try { body = options.body ? JSON.parse(options.body) : {}; } catch {}
      if (route === 'bootstrap') return json(STATE);
      if (route === 'addresses') return json({ ok: true, addresses: ADDRESSES, note: '' });
      if (route === 'addresses/resolve') return json({ ok: true, address: ADDRESSES[0] });
      if (route === 'addresses/select') { STATE.selectedAddress = ADDRESSES.find(a => a.ref === body.ref) || ADDRESSES[0]; return json(STATE); }
      if (route === 'addresses/confirm' || route === 'addresses/update-contact') { STATE.selectedAddress = { ...STATE.selectedAddress, name: body.name, mobile: body.mobile }; return json(STATE); }
      if (route === 'accounts/select') {
        const picked = STATE.accounts.find(a => a.key === body.key);
        if (!picked) return json({ ok: false, error: 'Demo account not found.' }, 404);
        STATE.accounts.forEach(a => { a.active = a.key === picked.key; });
        STATE.activeAccount = picked;
        return json(STATE);
      }
      if (route === 'chat-handoff/select' && STATE.chatHandoff) {
        const picked = STATE.accounts.find(a => a.key === body.key) || STATE.accounts[0];
        STATE.activeAccount = picked;
        STATE.chatHandoff = { ...STATE.chatHandoff, stage: 'ADDRESS', address: ADDRESSES[0] };
        return json(STATE);
      }
      if (route === 'chat-handoff/confirm-address' && STATE.chatHandoff) {
        STATE.selectedAddress = { ...ADDRESSES[0], name: body.name, mobile: body.mobile };
        STATE.chatHandoff = { ...STATE.chatHandoff, stage: 'CART', cartFetched: true };
        return json(STATE);
      }
      if ((route === 'chat-handoff/bill' || route === 'chat-handoff/offers') && STATE.chatHandoff) {
        STATE.chatHandoff = { ...STATE.chatHandoff, stage: 'BILL' };
        return json(STATE);
      }
      if (route === 'chat-handoff/reselect' && STATE.chatHandoff) { STATE.chatHandoff.stage = 'ACCOUNT'; return json(STATE); }
      if (route === 'chat-handoff/leave') { STATE.chatHandoff = null; return json(STATE); }
      if (route === 'search') {
        const query = String(url.searchParams.get('q') || '').toLowerCase();
        return json({ ok: true, restaurants: RESTAURANTS.filter(r => r.name.toLowerCase().includes(query)) });
      }
      if (route === 'menu') {
        const restaurant = RESTAURANTS.find(r => r.id === url.searchParams.get('id')) || RESTAURANTS[0];
        return json({ ok: true, restaurant, categories: CATEGORIES });
      }
      if (route === 'restaurants/outlets') return json({ ok: true, outlets: RESTAURANTS.filter(r => r.name === 'The Curry House') });
      if (route === 'coupons') return json({ ok: true, coupons: STATE.coupons, note: 'Demo offers only.' });
      if (route === 'cart/quantity') {
        const item = STATE.cart?.items.find(i => i.lineKey === body.lineKey);
        if (item) item.qty = Math.max(0, Number(body.qty) || 0);
        if (STATE.cart) STATE.cart.items = STATE.cart.items.filter(i => i.qty > 0);
        if (STATE.cart && !STATE.cart.items.length) STATE.cart = null; else recalculate();
        return json(STATE);
      }
      if (route === 'cart/add') {
        const dish = CATEGORIES.flatMap(c => c.items).find(i => i.id === body.itemId);
        if (!dish) return json({ ok: false, error: 'Demo dish not found.' }, 404);
        if (!STATE.cart) STATE.cart = { restaurantId: 'demo-1', restaurantName: 'The Curry House', restaurantArea: 'Green Park', items: [] };
        const existing = STATE.cart.items.find(i => i.id === dish.id);
        if (existing) existing.qty += 1; else STATE.cart.items.push({ ...dish, lineKey: dish.id, qty: 1 });
        recalculate(); return json(STATE);
      }
      if (route === 'cart/clear') { STATE.cart = null; return json(STATE); }
      if (route === 'cart/sync') {
        recalculate();
        if (STATE.cart?.quote) {
          const q = STATE.cart.quote;
          const code = String(body.coupon || '').toUpperCase();
          const itemTotal = (STATE.cart.items || []).reduce((n, i) => n + Number(i.price || 0) * Number(i.qty || 0), 0);
          const discount = code === 'DEMO50' ? Math.min(50, itemTotal) : code === 'DEMO20' ? Math.min(100, Math.round(itemTotal * 0.2)) : code === 'WELCOME' ? Math.min(25, itemTotal) : 0;
          const freeCash = itemTotal > 0 ? 50 : 0;
          Object.assign(q, { itemTotal, coupon: discount > 0 ? code : '', couponCode: discount > 0 ? code : '', discount, couponSaving: discount, freeCash, total: Math.max(0, itemTotal + 70 - freeCash - discount), fetchedAt: new Date().toISOString() });
        }
        return json(STATE);
      }
      if (route === 'orders') return json({ ok: true, orders: STATE.orders, detailAllowed: true });
      if (route === 'orders/tracking') {
        const id = url.searchParams.get('id') || '';
        const order = STATE.orders.find(o => o.id === id) || {};
        return json({ ok: true, sms: null, tracking: { orderId: id, status: order.status || '', eta: '', trackingUrl: order.trackingUrl || '', deliveryPartner: {}, note: 'Demo tracking status only.' } });
      }
      if (route === 'checkout/status') return json(STATE);
      if (route === 'boss/account-access') return json({ ok: true, access: { users: [{ id: 'demo-user', name: 'Demo family', allowed: ['demo-account-1'] }], accounts: STATE.accounts } });
      if (route === 'accounts/session') return json({ ok: true, session: { note: 'Demo only. No real session.' } });
      return json({ ok: false, error: 'Demo preview: this action is not connected to Swiggy.' }, 501);
    };
    // Keep payment layouts inspectable without leaving a launchable UPI link
    // or describing the non-payment QR as a real Swiggy payment QR.
    new MutationObserver(() => {
      document.querySelectorAll('a[href^="upi:"]').forEach(link => {
        link.removeAttribute('href');
        link.setAttribute('data-preview-upi', '');
        link.setAttribute('aria-disabled', 'true');
        link.textContent = 'UPI disabled in demo';
      });
      document.querySelectorAll('.payment-qr').forEach(image => { image.alt = 'Demo QR, not a payment'; });
      document.querySelectorAll('.pay-screen:not([data-preview-labelled])').forEach(card => {
        card.setAttribute('data-preview-labelled', '');
        const title = card.querySelector('.title-copy strong');
        const status = card.querySelector('.verify-copy strong');
        const detail = card.querySelector('.verify-copy small');
        if (title) title.textContent = 'Payment layout (demo)';
        if (status) status.textContent = 'Demo only · No live verification';
        if (detail) detail.textContent = 'No Swiggy order or payment is checked here.';
        card.querySelector('.verify-icon')?.classList.remove('spinner');
        const ticks = card.querySelector('.verify-ticks');
        if (ticks) { ticks.style.display = 'none'; ticks.setAttribute('aria-hidden', 'true'); }
      });
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', event => {
      if (event.target.closest('[data-action="checkout-start"], [data-preview-upi], a[href^="upi:"]')) {
        event.preventDefault(); event.stopImmediatePropagation();
        window.__appToast?.('Demo only — no order or payment is made.');
      }
    }, true);
  })();
  </script>`;
}

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://preview');
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (url.pathname === '/pro/style.css') return send(200, TYPES['.css'], fs.readFileSync(path.join(ROOT, 'swiggy-pro.css')));
  if (url.pathname === '/pro/app.js') return send(200, TYPES['.js'], fs.readFileSync(path.join(ROOT, 'swiggy-pro-app.js')));
  if (url.pathname === '/' || url.pathname === '/pro' || url.pathname === '/pro/' || url.pathname === '/swiggy-pro.html') {
    const html = fs.readFileSync(path.join(ROOT, 'swiggy-pro.html'), 'utf8')
      .replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '')
      .replace('<body>', `<body>${previewBoot(url.searchParams.get('scene') || '')}`)
      .replace('<header class="topbar">', '<div class="preview-notice" role="note">DEMO PREVIEW · No real orders or payments</div><header class="topbar">');
    return send(200, TYPES['.html'], html);
  }
  if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok');
  return send(404, 'text/plain', 'not found');
});
server.listen(PORT, HOST, () => console.log(`[preview] mini app demo → http://${HOST}:${PORT} (demo data only)`));
