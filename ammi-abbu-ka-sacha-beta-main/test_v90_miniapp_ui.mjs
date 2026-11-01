// DOM tests use fake Telegram/provider responses. They do NOT verify a real
// Telegram device, Swiggy login, order, payment, tracking, or recipient SMS.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

const account = { key: 'a', name: 'Test account', phone: '9123456789', active: true, ordersCount: 0 };
const address = { name: 'Demo receiver', mobile: '9234567890', address: 'Demo road ' + 'Long building name '.repeat(22) };
const quote = { total: 150.25, fetchedAt: '2026-10-31T00:00:00Z', itemTotal: 125, deliveryFee: 20, packingCharges: 0, taxes: 5.25, discount: 0 };
const cart = { restaurantId: '123', restaurantName: 'Demo restaurant', forSomeoneElse: true, quote, items: [{ lineKey: 'line', name: 'Meal', price: 125, qty: 1 }] };
const normalState = () => ({ ok: true, user: { name: 'Test', isBoss: false }, accounts: [account], activeAccount: account, selectedAddress: address, cart: structuredClone(cart), checkout: null, checkoutEnabled: true });

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
async function waitFor(fn, message = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
}
function harness({ initData = 'signed-offline-data', responder } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  const external = [];
  window.scrollTo = () => {};
  window.confirm = () => { throw new Error('Browser confirm must not be used inside Telegram'); };
  window.open = url => { external.push(url); };
  window.Telegram = { WebApp: { initData, ready() {}, expand() {}, openLink: url => external.push(url) } };
  window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    calls.push(call);
    return responder ? responder(call) : response(normalState());
  };
  window.eval(script);
  return { window, document: window.document, calls, external, close: () => window.close() };
}

test('preview and missing vault do not show a fake empty account list; retry connects after setup', async () => {
  const preview = harness({ initData: '' });
  try {
    assert.match(preview.document.body.textContent, /Browser preview only/);
    assert.equal(preview.calls.length, 0);
    assert.equal(preview.document.querySelector('form[data-form="send-otp"]'), null);
  } finally { preview.close(); }

  // 31-10-2026: "Server setup needed" dead-end hata. Storage jab tak taiyar ho
  // raha ho, screen retry maangti hai (jhoothi khaali account list nahi) aur
  // retry ke baad app khud chalu ho jati hai.
  let ready = false;
  const app = harness({ responder: call => call.url.endsWith('/bootstrap')
    ? ready ? response(normalState()) : response({ ok: false, code: 'PRO_VAULT_NOT_CONFIGURED', error: 'Mini App vault is not configured.' }, 503)
    : response({ ok: false, error: 'unexpected' }, 500) });
  try {
    await waitFor(() => app.document.querySelector('[data-action="retry-auth"]'), 'storage retry screen');
    assert.match(app.document.body.textContent, /Ek baar retry karein/i);
    assert.match(app.document.body.textContent, /Try again/i);
    assert.doesNotMatch(app.document.body.textContent, /Server setup needed/i);
    assert.equal(app.document.querySelector('form[data-form="send-otp"]'), null);
    assert.equal(app.calls.filter(c => c.url.includes('send-otp')).length, 0);
    ready = true;
    app.document.querySelector('[data-action="retry-auth"]').click();
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'account form after reconnect');
    assert.equal(app.calls.filter(c => c.url.endsWith('/bootstrap')).length, 2);
  } finally { app.close(); }

  // Purana data is key se na khule to UI JHOTH nahi bolti ki sab theek hai —
  // saaf batati hai ki data jaisa hai waisa hai aur owner ko kya karna hai.
  const broken = harness({ responder: () => response({ ok: false, code: 'PRO_VAULT_DECRYPT_FAILED', error: 'Unable to decrypt the Mini App workspace.' }, 503) });
  try {
    await waitFor(() => broken.document.querySelector('[data-action="retry-auth"]'), 'decrypt failure screen');
    assert.match(broken.document.body.textContent, /kuch delete nahi hua/i);
    assert.match(broken.document.body.textContent, /PRO_VAULT_KEY/);
  } finally { broken.close(); }
});

test('OTP request and verification stay inside the app and only reflect provider responses', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(normalState());
    if (call.url.endsWith('/accounts/send-otp')) return response({ ok: true, message: 'Swiggy accepted the OTP request.' });
    if (call.url.endsWith('/accounts/verify-otp')) return response(normalState());
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]'), 'OTP form');
    app.document.querySelector('input[name="phone"]').value = '9234567890';
    app.document.querySelector('form[data-form="send-otp"]').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('form[data-form="verify-otp"]'), 'verification form');
    assert.equal(app.calls.find(c => c.url.endsWith('/accounts/send-otp')).body.phone, '9234567890');
    app.document.querySelector('input[name="otp"]').value = '123456';
    app.document.querySelector('form[data-form="verify-otp"]').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('form[data-form="send-otp"]') && app.document.querySelector('#toast').textContent.includes('Account added.'), 'verification response');
    assert(app.calls.some(c => c.url.endsWith('/accounts/verify-otp')));
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

test('coupon APPLY seedha asli cart sync karta hai — koi code type nahi, koi confirm nahi', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(normalState());
    if (call.url.includes('/coupons')) return response({ ok: true, coupons: [
      { code: 'TRYNEW', title: '70% off', description: 'above ₹199', applicable: true, source: 'promo' }
    ], note: 'APPLY dabaiye.' });
    if (call.url.endsWith('/cart/sync')) return response({ ok: true, cart: structuredClone(cart), selectedAddress: address });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'connected navigation');
    app.document.querySelector('[data-tab="cart"]').click();
    // 31-10-2026 (round 8): boss — "code enter karne ka option nahi, sirf apply".
    await waitFor(() => app.document.querySelector('[data-action="toggle-coupon"]'), 'coupon row');
    app.document.querySelector('[data-action="toggle-coupon"]').click();
    await waitFor(() => app.document.querySelector('[data-action="coupon-pick"]'), 'coupon APPLY button');
    assert.equal(app.document.querySelector('input[name="coupon"]'), null, 'code type karne ka box nahi');
    app.document.querySelector('[data-action="coupon-pick"]').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/cart/sync')), 'sync call');
    // Coupon ab bottom sheet hai (khud role="dialog"), par extra CONFIRM nahi aana chahiye —
    // confirm dialog ka apna class hai.
    assert.equal(app.document.querySelector('.confirm-dialog, .confirm-overlay'), null, 'extra confirm nahi');
    const syncCalls = app.calls.filter(c => c.url.endsWith('/cart/sync'));
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].body.confirmReplaceSwiggyCart, true);
    assert.equal(syncCalls[0].body.coupon, 'TRYNEW');
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

test('checkout uses an in-app consent dialog, preserves full details, and only submits after approval', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) {
      const state = normalState();
      state.accounts.push({ key: 'other', name: 'Other', phone: '9234567890', active: false });
      return response(state);
    }
    if (call.url.endsWith('/checkout')) return response({ ok: true, checkout: { status: 'OUTCOME_UNKNOWN', accountPhone: account.phone, message: 'An order may exist; do not retry.' } });
    if (call.url.endsWith('/addresses')) return response({ ok: true, addresses: [], note: 'No saved addresses (offline).' });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'connected navigation');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="checkout-start"]'), 'checkout button');
    app.document.querySelector('[data-action="checkout-start"]').click();
    await waitFor(() => app.document.querySelector('[role="dialog"]'), 'consent dialog');
    let dialog = app.document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /₹150\.25/);
    assert(dialog.textContent.includes(address.address), 'full address must not be truncated');
    assert.match(dialog.textContent, /dobara order na karein/i);
    assert.equal(app.calls.filter(c => c.url.endsWith('/checkout')).length, 0);
    assert.equal(app.document.activeElement.textContent, 'Cancel');
    dialog.querySelector('.confirm-actions button').click();
    await waitFor(() => !app.document.querySelector('[role="dialog"]'), 'dialog close');
    assert.equal(app.calls.filter(c => c.url.endsWith('/checkout')).length, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    app.document.querySelector('[data-action="checkout-start"]').click();
    await waitFor(() => app.document.querySelector('[role="dialog"]'), 'second consent dialog');
    dialog = app.document.querySelector('[role="dialog"]');
    const confirm = dialog.querySelectorAll('.confirm-actions button')[1];
    confirm.click(); confirm.click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/checkout')), 'one checkout request');
    const checkoutCalls = app.calls.filter(c => c.url.endsWith('/checkout'));
    assert.equal(checkoutCalls.length, 1);
    assert.equal(checkoutCalls[0].body.confirmCheckout, true);
    assert.equal(checkoutCalls[0].body.expectedTotal, 150.25);
    // Round 35: locked draft ki line badal gayi (boss: "original account check"
    // hatado) — ab seedha cancel ka raasta batati hai.
    await waitFor(() => app.document.body.textContent.includes('Neeche diye button se cancel karein'), 'locked draft');
    assert(app.document.querySelector('[data-action="qty"]').disabled);
    app.document.querySelector('[data-tab="address"]').click();
    await waitFor(() => app.document.body.textContent.includes('No saved addresses (offline).'), 'address response');
    assert.match(app.document.body.textContent, /Receiver changes are locked/);
    assert(app.document.querySelector('[data-action="contact-edit"]').disabled);
    assert(app.document.querySelector('form[data-form="address-link"] button').disabled);
    app.document.querySelector('[data-tab="accounts"]').click();
    assert.match(app.document.body.textContent, /Account switching locked/i);
    assert(app.document.querySelector('[data-action="account-select"]').disabled);
    assert(app.document.querySelector('[data-action="account-remove"]').disabled);
    assert.deepEqual(app.external, []);
  } finally { app.close(); }
});

// Boss (round 35): "CHECKOUT NEEDS CHECKING KA CARD ... CHECK THIS ORDER AND
// CHECK ORIGINAL ACCOUNT BLAH BAKH ... ISKO HATADO CANCEL KARDU". Uncertain
// checkout par ab sirf ek saaf raasta — cancel, cart wapas, naya order.
test('uncertain checkout par sirf cancel ka raasta — koi check-order button nahi', async () => {
  const state = normalState();
  state.activeAccount = { ...account, key: 'b', name: 'Other selected account' };
  state.checkout = { status: 'OUTCOME_UNKNOWN', accountPhone: account.phone, orderId: '123456789012', message: 'An order may exist; do not retry.' };
  const app = harness({ responder: call => {
    if (call.url.endsWith('/bootstrap')) return response(state);
    if (call.url.endsWith('/checkout/cancel')) return response({ ok: true, checkout: null, cart: normalState().cart, message: 'Checkout band. Paisa nahi kata.' });
    return response({ ok: false, error: 'unexpected' }, 500);
  } });
  try {
    await waitFor(() => app.document.querySelector('[data-tab="cart"]:not([disabled])'), 'connected navigation');
    app.document.querySelector('[data-tab="cart"]').click();
    await waitFor(() => app.document.querySelector('[data-action="checkout-cancel"]'), 'cancel button');
    // Boss ne jo hataane kaha wo bilkul nahi hai.
    assert.equal(app.document.querySelector('[data-action="checkout-orders"]'), null, 'original account orders button nahi');
    assert.equal(app.document.querySelector('[data-action="checkout-status"]'), null, 'check-this-order button nahi');
    assert.match(app.document.body.textContent, /Checkout band karein/);
    assert.match(app.document.body.textContent, /Order cancel karein/);
    // Cancel → API call, checkout clear, cart wapas.
    app.document.querySelector('[data-action="checkout-cancel"]').click();
    let confirmBtn = null;
    await waitFor(() => {
      confirmBtn = app.document.querySelector('.confirm-dialog .button.danger, .confirm-dialog .button.primary');
      return Boolean(confirmBtn);
    }, 'cancel confirm dialog');
    confirmBtn.click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/checkout/cancel')), 'cancel api');
    await waitFor(() => app.document.querySelector('.pay-bar .pay-now'), 'cart unlocked after cancel');
    assert.equal(app.document.querySelector('[data-action="checkout-cancel"]'), null, 'cancel card chala gaya');
    assert.equal(app.external.length, 0);
  } finally { app.close(); }
});
