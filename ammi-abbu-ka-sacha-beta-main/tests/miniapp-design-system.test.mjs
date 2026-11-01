// UI regression tests use fake Telegram/provider responses only. They never
// verify or perform a live Swiggy order, payment, SMS, or Telegram device flow.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../swiggy-pro.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../swiggy-pro-app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../swiggy-pro.css', import.meta.url), 'utf8');
const account = { key: 'a', name: 'Ammi', phoneMasked: '90••••0001', active: true, selectable: true, status: 'USED' };
const address = { id: 'home', ref: 'home', name: 'Receiver', mobile: '9123456789', address: 'Test Road, Pune' };
const cart = { restaurantId: 'r', restaurantName: 'A long restaurant name', restaurantArea: 'Pune', items: [{ id: 'i', lineKey: 'line', name: 'Meal', qty: 2, price: 100 }], quote: { itemTotal: 200, deliveryFee: 10, taxes: 5, total: 215, fetchedAt: '2026-11-01T00:00:00Z' } };
const baseState = () => ({ ok: true, user: { name: 'Demo', isBoss: false }, accounts: [account, { key: 'b', name: 'Abbu', active: false, selectable: true, status: 'READY' }], activeAccount: account, selectedAddress: address, cart: structuredClone(cart), checkout: null, checkoutEnabled: true });
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
async function waitFor(fn, label = 'condition') {
  for (let i = 0; i < 300; i++) {
    const result = fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function harness({ bootstrap = baseState(), responder } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/pro', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, 'innerHeight', { value: 844, writable: true, configurable: true });
  const viewport = new window.EventTarget();
  viewport.height = 844; viewport.offsetTop = 0;
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  window.Telegram = { WebApp: { initData: 'offline-signed-demo', ready() {}, expand() {} } };
  window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.endsWith('/bootstrap')) return response(bootstrap);
    const handled = responder && await responder(call);
    if (handled) return handled;
    if (call.url.includes('/coupons')) return response({ ok: true, coupons: [{ code: 'DEMO', title: '10% OFF', description: 'Offline example' }] });
    if (call.url.includes('/menu?')) return response({ ok: true, restaurant: { id: 'r', name: 'Restaurant', area: 'Pune', isOpen: true }, categories: [] });
    if (call.url.endsWith('/addresses')) return response({ ok: true, addresses: [address] });
    if (call.url.includes('/orders')) return response({ ok: true, orders: [] });
    return response({ ok: false, error: 'Unexpected offline request' }, 500);
  };
  window.eval(script);
  return { window, document: window.document, viewport, calls, close: () => window.close() };
}
const nav = (app, tab) => app.document.querySelector(`#bottom-nav [data-tab="${tab}"]`).click();
const key = (app, name, shiftKey = false) => app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));

test('shared shell shows the selected real account and accessible theme state', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    assert.equal(app.document.querySelector('#account-chip-text').textContent, 'Ammi');
    assert.match(app.document.querySelector('#account-chip').getAttribute('aria-label'), /Ammi.*0001/);
    assert.match(app.document.querySelector('#content h1').textContent, /Accounts/);
    assert.ok(app.document.querySelector('.ac-card').compareDocumentPosition(app.document.querySelector('.ac-saved-head')) & app.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(app.document.querySelector('form[data-form="send-otp"]'));
    app.document.querySelector('[data-action="account-mode"][data-mode="json"]').click();
    assert.ok(app.document.querySelector('form[data-form="import"]'));
    const theme = app.document.querySelector('[data-action="theme"]');
    assert.equal(theme.getAttribute('aria-pressed'), 'false');
    theme.click();
    assert.equal(theme.getAttribute('aria-pressed'), 'true');
    assert.equal(theme.getAttribute('aria-label'), 'Switch to light theme');
    assert.equal(app.window.localStorage.getItem('pro-theme'), 'dark');
    theme.click();
    assert.equal(theme.getAttribute('aria-pressed'), 'false');
  } finally { app.close(); }
});

test('the one cart dock uses the current item count and bill, and updates after quantity response', async () => {
  const app = harness({ responder: call => {
    if (call.url.endsWith('/cart/quantity')) {
      const changed = structuredClone(cart); changed.items[0].qty = call.body.qty; changed.quote.total = 315;
      return response({ ok: true, cart: changed });
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.cart-dock'), 'dock');
    assert.equal(app.document.querySelectorAll('#cart-dock .cart-dock').length, 1);
    assert.match(app.document.querySelector('.cart-dock').getAttribute('aria-label'), /2 items.*A long restaurant name.*₹215/);
    nav(app, 'cart');
    await waitFor(() => app.document.querySelector('[data-action="qty"][data-qty="3"]'), 'quantity button');
    assert.equal(app.document.querySelector('#cart-dock .cart-dock'), null);
    app.document.querySelector('[data-action="qty"][data-qty="3"]').click();
    await waitFor(() => app.document.querySelector('.stepper span')?.textContent === '3', 'new quantity');
    nav(app, 'search');
    const dock = await waitFor(() => app.document.querySelector('.cart-dock'), 'updated dock');
    assert.match(dock.textContent, /3 items/);
    assert.match(dock.textContent, /₹315/);
    assert.match(app.document.querySelector('#bottom-nav [data-tab="cart"]').getAttribute('aria-label'), /3 items/);
    assert.equal(app.calls.filter(c => c.url.endsWith('/cart/quantity')).length, 1);
    assert.equal(app.calls.some(c => c.url.endsWith('/checkout')), false);
  } finally { app.close(); }
});

test('cart dock stays hidden during pending or uncertain checkout and for an empty cart', async () => {
  for (const checkout of [{ status: 'PAYMENT_PENDING', amount: 215, paymentVerified: false }, { status: 'OUTCOME_UNKNOWN' }]) {
    const state = baseState(); state.checkout = checkout;
    const app = harness({ bootstrap: state });
    try {
      await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts with checkout');
      assert.equal(app.document.querySelector('#cart-dock .cart-dock'), null);
      nav(app, 'address');
      await waitFor(() => app.document.querySelector('.address-row'), 'address');
      assert.equal(app.document.querySelector('#cart-dock .cart-dock'), null);
    } finally { app.close(); }
  }
  const state = baseState(); state.cart = null;
  const empty = harness({ bootstrap: state });
  try {
    await waitFor(() => empty.document.querySelector('.ac-row.active'), 'empty cart');
    assert.equal(empty.document.querySelector('#cart-dock .cart-dock'), null);
  } finally { empty.close(); }
});

test('coupon sheet retains the cart beneath it, traps focus, and restores a usable trigger on Escape', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'cart');
    await waitFor(() => app.document.querySelector('[data-action="coupon-open"]'), 'coupons');
    app.document.querySelector('[data-action="coupon-open"]').click();
    const sheet = await waitFor(() => app.document.querySelector('.coupon-sheet'), 'coupon dialog');
    assert.ok(app.document.querySelector('.coupon-underlay[inert] .restaurant-cart'));
    assert.ok(app.document.querySelector('#bottom-nav[inert][aria-hidden="true"]'));
    assert.equal(app.document.activeElement.dataset.action, 'coupon-back');
    const buttons = [...sheet.querySelectorAll('button:not([disabled])')];
    buttons.at(-1).focus(); key(app, 'Tab');
    assert.equal(app.document.activeElement, buttons[0]);
    key(app, 'Tab', true);
    assert.equal(app.document.activeElement, buttons.at(-1));
    key(app, 'Escape');
    assert.equal(app.document.querySelector('.coupon-sheet'), null);
    assert.equal(app.document.querySelector('#bottom-nav').hasAttribute('inert'), false);
    assert.ok(['coupon-open', 'toggle-coupon'].includes(app.document.activeElement.dataset.action));
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/sync') || c.url.endsWith('/checkout')), false);
  } finally { app.close(); }
});

test('cancelled confirmations trap focus, restore a repainted trigger, and leave the cart unchanged', async () => {
  let releaseCoupons;
  const pendingCoupons = new Promise(resolve => { releaseCoupons = resolve; });
  const app = harness({ responder: call => call.url.includes('/coupons') ? pendingCoupons : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'cart');
    const trigger = await waitFor(() => app.document.querySelector('[data-action="cart-clear"]'), 'clear cart');
    trigger.focus(); trigger.click();
    const dialog = await waitFor(() => app.document.querySelector('.confirm-dialog'), 'confirmation');
    assert.ok(app.document.querySelector('.app-shell[inert][aria-hidden="true"]'));
    const buttons = [...dialog.querySelectorAll('button')];
    assert.equal(app.document.activeElement, buttons[0]);
    releaseCoupons(response({ ok: true, coupons: [{ code: 'DEMO', title: '10% OFF' }] }));
    await waitFor(() => app.document.querySelector('[data-action="coupon-open"]'), 'background coupon repaint');
    assert.notEqual(app.document.querySelector('[data-action="cart-clear"]'), trigger);
    assert.equal(app.document.activeElement, buttons[0]);
    key(app, 'Tab', true);
    assert.equal(app.document.activeElement, buttons.at(-1));
    key(app, 'Escape');
    await waitFor(() => app.document.activeElement === app.document.querySelector('[data-action="cart-clear"]'), 'confirmation focus restored');
    assert.equal(app.document.querySelector('.confirm-dialog'), null);
    assert.equal(app.document.querySelector('.app-shell').hasAttribute('inert'), false);
    assert.ok(app.document.querySelector('.restaurant-cart'));
    assert.equal(app.calls.some(c => c.url.endsWith('/cart/clear')), false);
  } finally { app.close(); }
});

test('typing and keyboard focus survive an async repaint without copying an address link into the group cart', async () => {
  let releaseAddresses;
  const pending = new Promise(resolve => { releaseAddresses = resolve; });
  const app = harness({ responder: call => call.url.endsWith('/addresses') ? pending : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'address');
    const input = await waitFor(() => app.document.querySelector('form[data-form="address-link"] input[name="url"]'), 'address link');
    input.focus(); input.value = 'https://swiggy.onelink.me/example';
    input.setSelectionRange(10, 10);
    releaseAddresses(response({ ok: true, addresses: [address] }));
    const restored = await waitFor(() => {
      const el = app.document.querySelector('form[data-form="address-link"] input[name="url"]');
      return el !== input && app.document.querySelectorAll('.address-row').length > 1 && el;
    }, 'async address repaint');
    assert.equal(restored.value, 'https://swiggy.onelink.me/example');
    assert.equal(app.document.activeElement, restored);
    assert.equal(restored.selectionStart, 10);
    nav(app, 'cart');
    const group = await waitFor(() => app.document.querySelector('form[data-form="group-cart"] input[name="url"]'), 'group cart');
    assert.equal(group.value, '');
  } finally { app.close(); }
});

test('both edited receiver fields survive a background repaint and submit unchanged', async () => {
  let releaseAddresses;
  const pending = new Promise(resolve => { releaseAddresses = resolve; });
  const app = harness({ responder: call => {
    if (call.url.endsWith('/addresses')) return pending;
    if (call.url.endsWith('/addresses/update-contact')) return response({ ok: true, selectedAddress: { ...address, name: call.body.name, mobile: call.body.mobile } });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'address');
    (await waitFor(() => app.document.querySelector('[data-action="contact-edit"]'), 'selected address')).click();
    const form = app.document.querySelector('form[data-form="contact"]');
    form.querySelector('[name="name"]').value = 'Updated Receiver';
    const mobile = form.querySelector('[name="mobile"]');
    mobile.value = '9876543210'; mobile.focus();
    releaseAddresses(response({ ok: true, addresses: [address] }));
    const updated = await waitFor(() => {
      const current = app.document.querySelector('form[data-form="contact"]');
      return current !== form && app.document.querySelectorAll('.address-row').length > 1 && current;
    }, 'background address repaint');
    assert.equal(updated.querySelector('[name="name"]').value, 'Updated Receiver');
    assert.equal(updated.querySelector('[name="mobile"]').value, '9876543210');
    assert.equal(app.document.activeElement, updated.querySelector('[name="mobile"]'));
    updated.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    const call = await waitFor(() => app.calls.find(c => c.url.endsWith('/addresses/update-contact')), 'contact update');
    assert.deepEqual(call.body, { name: 'Updated Receiver', mobile: '9876543210' });
  } finally { app.close(); }
});

test('a newly resolved address replaces old recipient edits with its own link details', async () => {
  const first = { ...address, address: 'First Road', name: 'First Recipient', mobile: '9111111111' };
  const second = { ...address, address: 'Second Road', name: 'Second Recipient', mobile: '9222222222' };
  let releaseSecond, resolutions = 0;
  const pending = new Promise(resolve => { releaseSecond = resolve; });
  const app = harness({ responder: call => {
    if (call.url.endsWith('/addresses/resolve')) return ++resolutions === 1 ? response({ ok: true, address: first }) : pending;
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'address');
    const submitLink = () => {
      const form = app.document.querySelector('form[data-form="address-link"]');
      form.querySelector('[name="url"]').value = 'https://swiggy.onelink.me/example';
      form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    };
    submitLink();
    const firstForm = await waitFor(() => app.document.querySelector('form[data-form="confirm-address"]'), 'first address');
    firstForm.querySelector('[name="name"]').value = 'Unsaved Old Name';
    firstForm.querySelector('[name="mobile"]').value = '9333333333';
    firstForm.querySelector('[name="name"]').focus();
    submitLink();
    await waitFor(() => resolutions === 2, 'second address request');
    releaseSecond(response({ ok: true, address: second }));
    const next = await waitFor(() => {
      const form = app.document.querySelector('form[data-form="confirm-address"]');
      return form !== firstForm && form?.closest('.card')?.textContent.includes('Second Road') && form;
    }, 'second address');
    assert.equal(next.querySelector('[name="name"]').value, 'Second Recipient');
    assert.equal(next.querySelector('[name="mobile"]').value, '9222222222');
  } finally { app.close(); }
});

test('keyboard-resized viewport hides and restores fixed controls', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    const input = app.document.querySelector('.ac-search input'); input.focus();
    app.viewport.height = 500;
    app.viewport.dispatchEvent(new app.window.Event('resize'));
    assert.equal(app.document.body.classList.contains('keyboard-open'), true);
    app.viewport.height = 844;
    app.viewport.dispatchEvent(new app.window.Event('resize'));
    assert.equal(app.document.body.classList.contains('keyboard-open'), false);
  } finally { app.close(); }
});

test('outlet sheet supports keyboard dismissal and returns focus without requesting a menu', async () => {
  const restaurants = [{ id: '1', name: 'Curry', area: 'One', isOpen: true }, { id: '2', name: 'Curry', area: 'Two', isOpen: true }];
  const app = harness({ responder: call => call.url.includes('/search?') ? response({ ok: true, restaurants }) : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts');
    nav(app, 'search');
    const form = app.document.querySelector('form[data-form="search"]');
    form.querySelector('input').value = 'Curry';
    form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    const row = await waitFor(() => app.document.querySelector('[data-action="restaurant"]'), 'search results');
    row.focus(); row.click();
    await waitFor(() => app.document.querySelector('.sheet-overlay'), 'outlet sheet');
    assert.ok(app.document.activeElement.hasAttribute('data-sheet-close'));
    assert.ok(app.document.querySelector('.app-shell[inert][aria-hidden="true"]'));
    key(app, 'Escape');
    assert.equal(app.document.querySelector('.sheet-overlay'), null);
    assert.equal(app.document.querySelector('.app-shell').hasAttribute('inert'), false);
    assert.equal(app.document.activeElement, row);
    assert.equal(app.calls.some(c => c.url.includes('/menu?')), false);
  } finally { app.close(); }
});

test('chat handoff shows the server stage and still pre-fills the receiver from the link', async () => {
  const state = baseState();
  state.chatHandoff = { activeId: 'draft', stage: 'ADDRESS', address: { ...address } };
  const app = harness({ bootstrap: state });
  try {
    const form = await waitFor(() => app.document.querySelector('form[data-form="handoff-address"]'), 'handoff address');
    assert.equal(form.querySelector('[name="receiver_name"]').value, 'Receiver');
    assert.equal(form.querySelector('[name="receiver_mobile"]').value, '9123456789');
    assert.equal(app.document.querySelector('.handoff-step[aria-current="step"]').textContent.replace(/\s+/g, ' ').trim(), '2Address');
    assert.equal(app.document.querySelector('#bottom-nav [aria-current="page"]'), null);
    nav(app, 'search');
    const resume = await waitFor(() => app.document.querySelector('[data-action="handoff-resume"]'), 'resume handoff');
    assert.match(resume.textContent, /2 items/);
    assert.match(resume.textContent, /₹215/);
    resume.click();
    assert.ok(app.document.querySelector('form[data-form="handoff-address"]'));
  } finally { app.close(); }
});

test('design tokens include safe areas and reduced-motion support without a global motion kill switch', () => {
  assert.match(css, /--tg-content-safe-area-inset-top/);
  assert.match(css, /--tg-safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /\*\s*,\s*\*::before\s*,\s*\*::after\s*\{\s*animation:\s*none\s*!important;\s*transition:\s*none\s*!important/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
});

test('compact account rows select from their background while copy/delete stay independent and used IDs require consent', async () => {
  const bootstrap = baseState();
  bootstrap.accounts[0].offerTracks = [
    { label: 'Late night (9PM–6AM)', emoji: '🌙', status: 'CLAIMED', verified: true },
    { label: 'Breakfast (7AM–11AM)', emoji: '☀️', status: 'NOT_CLAIMED', verified: false }
  ];
  bootstrap.accounts[1] = { key: 'b', name: 'Used ID', active: false, selectable: false, needsConfirm: true, status: 'USED', canRemove: true };
  const app = harness({ bootstrap, responder: call => {
    if (call.url.endsWith('/accounts/session?key=b')) return response({ ok: true, session: { token: 'offline-only' } });
    if (call.url.endsWith('/accounts/select')) {
      if (!call.body.confirmUsed) return response({ ok: false, code: 'ACCOUNT_NEEDS_CONFIRM', error: 'Used ID' }, 409);
      const next = structuredClone(bootstrap); next.accounts[0].active = false; next.accounts[1].active = true; next.activeAccount = next.accounts[1];
      return response(next);
    }
  } });
  try {
    await waitFor(() => app.document.querySelectorAll('[data-account-row]').length === 2, 'account rows');
    const d = app.document;
    assert(d.querySelector('.ac-card').compareDocumentPosition(d.querySelector('.ac-saved-head')) & app.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(d.querySelector('label[for="ac-phone"]').className, 'sr-only');
    assert.equal(d.querySelector('.ac-tags').textContent.includes('9PM'), false);
    assert.equal(d.querySelectorAll('.ac-tags .offer-chip').length, 2);
    d.querySelector('.ac-row.active').click();
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).length, 0, 'already selected row is a no-op');
    Object.defineProperty(app.window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
    d.querySelector('[data-action="account-copy-json"][data-key="b"]').click();
    await waitFor(() => app.calls.some(c => c.url.endsWith('/accounts/session?key=b')), 'copy only');
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).length, 0);
    d.querySelector('[data-account-row]:not(.active)').click();
    await waitFor(() => d.querySelector('.confirm-dialog .button.primary'), 'used-account confirmation');
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).length, 1);
    d.querySelector('.confirm-dialog .button.soft').click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).length, 1, 'cancel does not confirm');
    d.querySelector('[data-account-row]:not(.active) .ac-check').click();
    await waitFor(() => d.querySelector('.confirm-dialog .button.primary'), 'used-account confirmation again');
    d.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => d.querySelector('.ac-row.active [data-key="b"]'), 'account selected');
    assert.equal(app.calls.filter(c => c.url.endsWith('/accounts/select')).at(-1).body.confirmUsed, true);
  } finally { app.close(); }
});

test('selected saved address gets active styling and follows the server selection', async () => {
  const other = { ...address, id: 'work', ref: 'work', name: 'Other Receiver', address: 'Second Road' };
  const app = harness({ responder: call => {
    if (call.url.endsWith('/addresses')) return response({ ok: true, addresses: [address, other] });
    if (call.url.endsWith('/addresses/select')) return response({ ok: true, selectedAddress: other });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'address');
    await waitFor(() => app.document.querySelector('[data-action="address-select"][data-ref="work"]'), 'saved addresses');
    assert.equal(app.document.querySelectorAll('.address-row.active').length, 2, 'current address and matching saved row are active');
    app.document.querySelector('[data-action="address-select"][data-ref="work"]').click();
    await waitFor(() => [...app.document.querySelectorAll('.address-row.active')].some(e => e.textContent.includes('Second Road')), 'new selected address');
    assert.equal(app.document.querySelectorAll('.address-row.active').length, 2);
  } finally { app.close(); }
});

test('menu add and quantity updates keep the same filtered screen and reflect server cart quantities', async () => {
  const bootstrap = baseState(); bootstrap.cart = null;
  const restaurant = { id: 'r', name: 'Noodles', area: 'Pune', isOpen: true };
  const items = [{ id: 'i', name: 'Noodle bowl', price: 100, inStock: true, isVeg: true }, { id: 'j', name: 'Rice', price: 80, inStock: true, isVeg: true }];
  const menu = { ok: true, restaurant, categories: [{ title: 'Menu', items }] };
  const cartWith = qty => qty ? { restaurantId: 'r', restaurantName: 'Noodles', items: [{ id: 'i', lineKey: 'line-i', name: 'Noodle bowl', price: 100, qty }], quote: null } : null;
  const app = harness({ bootstrap, responder: call => {
    if (call.url.includes('/search?')) return response({ ok: true, restaurants: [restaurant] });
    if (call.url.includes('/restaurants/outlets?')) return response({ ok: true, outlets: [restaurant, { id: 'other', name: 'Noodles Express' }] });
    if (call.url.includes('/menu?')) return response(menu);
    if (call.url.endsWith('/cart/add')) return response({ ok: true, cart: cartWith(1) });
    if (call.url.endsWith('/cart/quantity')) return response({ ok: true, cart: cartWith(call.body.qty) });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'search');
    assert.equal(app.calls.filter(c => c.url.includes('/menu?')).length, 0, 'opening Search does not request a menu');
    const form = app.document.querySelector('form[data-form="search"]'); form.querySelector('input').value = 'Noodles'; form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('[data-action="restaurant"]'), 'restaurant');
    app.document.querySelector('[data-action="restaurant"]').click();
    await waitFor(() => app.document.querySelector('[data-action="dish-add"]'), 'menu');
    const input = app.document.querySelector('[data-input="menu-search"]'); input.value = 'noodle'; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); input.focus();
    assert.equal(app.document.querySelectorAll('[data-menu-item]')[1].hidden, true);
    app.document.querySelector('[data-action="dish-add"]').click();
    await waitFor(() => app.document.querySelector('.menu-stepper span')?.textContent === '1', 'one item');
    assert.equal(app.document.querySelector('[data-input="menu-search"]'), input, 'menu DOM is not replaced');
    assert.equal(input.value, 'noodle');
    assert.equal(app.document.querySelectorAll('[data-menu-item]')[1].hidden, true);
    assert.equal(app.calls.find(c => c.url.endsWith('/cart/add')).body.restaurantId, 'r');
    assert.equal(app.document.querySelector('[data-action="menu-outlets"]'), null, 'substring name is not an outlet');
    app.document.querySelector('.menu-stepper [data-qty="2"]').click();
    await waitFor(() => app.document.querySelector('.menu-stepper span')?.textContent === '2', 'two items');
    assert.equal(app.document.querySelector('[data-input="menu-search"]'), input);
    app.document.querySelector('.menu-stepper [data-qty="1"]').click();
    await waitFor(() => app.document.querySelector('.menu-stepper span')?.textContent === '1', 'one item again');
    assert.match(app.document.querySelector('.cart-dock').textContent, /1 item/);
  } finally { app.close(); }
});

test('a stale menu response cannot reopen a restaurant after navigating away and back', async () => {
  const bootstrap = baseState(); bootstrap.cart = null;
  let release;
  const app = harness({ bootstrap, responder: call => {
    if (call.url.includes('/search?')) return response({ ok: true, restaurants: [{ id: 'r', name: 'Solo', isOpen: true }] });
    if (call.url.includes('/menu?')) return new Promise(resolve => { release = () => resolve(response({ ok: true, restaurant: { id: 'r', name: 'Solo', isOpen: true }, categories: [] })); });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'search');
    const form = app.document.querySelector('form[data-form="search"]'); form.querySelector('input').value = 'Solo'; form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('[data-action="restaurant"]'), 'search result');
    app.document.querySelector('[data-action="restaurant"]').click(); await waitFor(() => release, 'pending menu');
    nav(app, 'address'); nav(app, 'search'); release();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(app.document.querySelector('.menu-hero'), null);
    assert(app.document.querySelector('form[data-form="search"]'));
  } finally { app.close(); }
});

test('bill is direct and truthful without removed payment or updating cards', async () => {
  const app = harness();
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'cart');
    await waitFor(() => app.document.querySelector('.bill-card'), 'bill');
    const text = app.document.querySelector('#content').textContent;
    assert.match(text, /Bill Details/); assert.match(text, /215/);
    assert.doesNotMatch(text, /View Detailed Bill|PAY USING UPI|bill updating|Updating/i);
    assert.equal(app.document.querySelector('[data-action="bill-open"]'), null);
    assert(app.document.querySelector('[data-action="checkout-start"]'));
  } finally { app.close(); }
  const noBill = baseState(); noBill.cart.quote = null;
  const other = harness({ bootstrap: noBill });
  try {
    await waitFor(() => other.document.querySelector('.ac-row.active'), 'accounts'); nav(other, 'cart');
    assert.equal(other.document.querySelector('.bill-card'), null);
    assert.doesNotMatch(other.document.querySelector('#content').textContent, /Free Delivery|bill not yet returned/i);
  } finally { other.close(); }
});

test('order detail retains a genuine share link without tracking/refresh or SMS explanations', async () => {
  const link = 'https://www.swiggy.com/track/offline-123';
  const app = harness({ responder: call => {
    if (call.url.endsWith('/orders')) return response({ ok: true, orders: [{ id: '123', restaurant: 'Offline', status: 'Pending', items: [], amount: 215 }] });
    if (call.url.includes('/orders/tracking?')) return response({ ok: true, tracking: { orderId: '123', trackingUrl: link }, sms: { text: 'do not show' } });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'orders');
    await waitFor(() => app.document.querySelector('[data-action="order-detail"]'), 'order'); app.document.querySelector('[data-action="order-detail"]').click();
    await waitFor(() => app.document.querySelector('[data-share-input]')?.value === link, 'real link');
    const details = app.document.querySelector('#content');
    assert.equal(details.querySelector('[data-action="order-tracking"]'), null);
    assert.doesNotMatch(details.textContent, /SMS|Swiggy par tracking khole|Refresh/i);
    assert(details.querySelector('[data-action="share-send"]'));
    let copied = ''; Object.defineProperty(app.window.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } }, configurable: true });
    details.querySelector('[data-action="share-copy"]').click(); await waitFor(() => copied, 'copied'); assert.equal(copied, link);
  } finally { app.close(); }
  const missing = harness({ responder: call => {
    if (call.url.endsWith('/orders')) return response({ ok: true, orders: [{ id: '123', restaurant: 'Offline', status: 'Pending', items: [], amount: 215 }] });
    if (call.url.includes('/orders/tracking?')) return response({ ok: true, tracking: {} });
  } });
  try {
    await waitFor(() => missing.document.querySelector('.ac-row.active'), 'accounts'); nav(missing, 'orders');
    await waitFor(() => missing.document.querySelector('[data-action="order-detail"]'), 'order'); missing.document.querySelector('[data-action="order-detail"]').click();
    await waitFor(() => missing.document.querySelector('.share-card')?.textContent.includes('Link unavailable'), 'honest unavailable state');
    assert.equal(missing.document.querySelector('[data-share-input]'), null);
  } finally { missing.close(); }
});

test('Tools keeps access and concise verified offer outcomes without removed diagnostic cards', async () => {
  const bootstrap = baseState(); bootstrap.user.isBoss = true;
  bootstrap.accounts = [{ ...account, canClaim: true, offerTracks: [
    { label: 'Late night (9PM–6AM)', status: 'CLAIMED', verified: true, message: 'campaign id: secret words' },
    { label: 'Breakfast', status: 'ALREADY_CLAIMED', verified: true },
    { label: 'Weekend', status: 'FAILED', verified: false },
    { label: 'Partial offer', status: 'PARTIAL', verified: true },
    { label: 'Unverified claim', status: 'CLAIMED', verified: false },
    { label: 'Unverified active', status: 'ALREADY_ACTIVE', verified: false },
    { label: 'Pending offer', status: 'PRE_LOCKED', verified: false }
  ] }];
  const app = harness({ bootstrap, responder: call => call.url.endsWith('/boss/account-access') ? response({ ok: true, access: { users: [], accounts: [] } }) : undefined });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'tools');
    await waitFor(() => app.document.querySelector('[data-action="claim-offers"]'), 'claim');
    const text = app.document.querySelector('#content').textContent;
    assert.match(text, /ID access/); assert.match(text, /Already claimed/); assert.match(text, /Claimed/); assert.match(text, /Failed/);
    assert.equal(app.document.querySelector('[data-action="claim-offers"]').textContent.trim(), 'Claim');
    assert.doesNotMatch(text, /campaign id|9PM|Live order \+ SMS|Data Backup|Backup ka asli|Login ID ka data|pehle se active/i);
    for (const label of ['Partial offer', 'Unverified claim', 'Unverified active', 'Pending offer']) {
      const row = [...app.document.querySelectorAll('.offer-row')].find(el => el.textContent.includes(label));
      assert(row, label);
      assert.doesNotMatch(row.textContent, /Claimed|Failed/i);
    }
  } finally { app.close(); }
});

test('outlet chooser appears only for another distinct exact-name result', async () => {
  const bootstrap = baseState(); bootstrap.cart = null;
  const restaurant = { id: 'r', name: 'Noodles', area: 'One', isOpen: true };
  const app = harness({ bootstrap, responder: call => {
    if (call.url.includes('/search?')) return response({ ok: true, restaurants: [restaurant] });
    if (call.url.includes('/menu?')) return response({ ok: true, restaurant, categories: [] });
    if (call.url.includes('/restaurants/outlets?')) return response({ ok: true, outlets: [restaurant, { ...restaurant }, { id: '2', name: 'Noodles Express' }, { id: '3', name: 'NOODLES', area: 'Two', isOpen: true }] });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'search');
    const form = app.document.querySelector('form[data-form="search"]'); form.querySelector('input').value = 'Noodles'; form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('[data-action="restaurant"]'), 'result'); app.document.querySelector('[data-action="restaurant"]').click();
    const button = await waitFor(() => app.document.querySelector('[data-action="menu-outlets"]'), 'verified alternatives');
    assert.match(button.textContent, /2 outlets/);
    button.click();
    const choices = [...app.document.querySelectorAll('[data-sheet-outlet]')];
    assert.deepEqual(choices.map(row => row.dataset.sheetOutlet), ['r', '3']);
  } finally { app.close(); }
});

test('menu shows imported customised quantities without offering an unsupported edit', async () => {
  const bootstrap = baseState();
  bootstrap.cart = { restaurantId: 'r', restaurantName: 'Cafe', items: [{ id: 'i', lineKey: 'custom', name: 'Bowl', qty: 3, price: 100, variants: [{ id: 'option' }] }], quote: null };
  const restaurant = { id: 'r', name: 'Cafe', area: 'One', isOpen: true };
  const app = harness({ bootstrap, responder: call => {
    if (call.url.includes('/search?')) return response({ ok: true, restaurants: [restaurant] });
    if (call.url.includes('/menu?')) return response({ ok: true, restaurant, categories: [{ title: 'Menu', items: [{ id: 'i', name: 'Bowl', price: 100, customizable: true, inStock: true }] }] });
    if (call.url.includes('/restaurants/outlets?')) return response({ ok: true, outlets: [restaurant] });
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'search');
    const form = app.document.querySelector('form[data-form="search"]'); form.querySelector('input').value = 'Cafe'; form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('[data-action="restaurant"]'), 'restaurant'); app.document.querySelector('[data-action="restaurant"]').click();
    const qty = await waitFor(() => app.document.querySelector('.menu-qty-readonly'), 'customised count');
    assert.match(qty.textContent, /3 in cart/);
    assert.equal(app.document.querySelector('[data-action="dish-add"]'), null);
  } finally { app.close(); }
});

test('an older tracking response cannot put a different order link in the share card', async () => {
  const releases = {};
  const app = harness({ responder: call => {
    if (call.url.endsWith('/orders')) return response({ ok: true, orders: [
      { id: '111', restaurant: 'First', status: 'Pending', items: [], amount: 1 },
      { id: '222', restaurant: 'Second', status: 'Pending', items: [], amount: 2 }
    ] });
    if (call.url.includes('/orders/tracking?')) {
      const id = new URL(call.url, 'https://example.test').searchParams.get('id');
      return new Promise(resolve => { releases[id] = () => resolve(response({ ok: true, tracking: { orderId: id, trackingUrl: `https://www.swiggy.com/track/${id}` } })); });
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'orders');
    await waitFor(() => app.document.querySelector('[data-id="111"][data-action="order-detail"]'), 'orders');
    app.document.querySelector('[data-id="111"][data-action="order-detail"]').click(); await waitFor(() => releases['111'], 'first link pending');
    app.document.querySelector('[data-action="orders-back"]').click();
    app.document.querySelector('[data-id="222"][data-action="order-detail"]').click(); await waitFor(() => releases['222'], 'second link pending');
    releases['111'](); await new Promise(r => setTimeout(r, 10));
    assert.notEqual(app.document.querySelector('[data-share-input]')?.value, 'https://www.swiggy.com/track/111');
    releases['222']();
    await waitFor(() => app.document.querySelector('[data-share-input]')?.value === 'https://www.swiggy.com/track/222', 'second link');
  } finally { app.close(); }
});

test('a changed quantity requests fresh consent for automatic bill sync', async () => {
  const bootstrap = baseState(); bootstrap.cart.quote = null;
  const app = harness({ bootstrap, responder: call => {
    if (call.url.endsWith('/cart/quantity')) {
      const changed = structuredClone(bootstrap.cart); changed.items[0].qty = call.body.qty;
      return response({ ok: true, cart: changed });
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'cart');
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'first sync consent');
    app.document.querySelector('.confirm-dialog .button.soft').click();
    await waitFor(() => !app.document.querySelector('.confirm-dialog'), 'consent dismissed');
    app.document.querySelector('[data-action="qty"][data-qty="3"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'new consent for changed quantity');
    assert.equal(app.calls.filter(c => c.url.endsWith('/cart/sync')).length, 0, 'sync never occurs before consent');
    app.document.querySelector('.confirm-dialog .button.soft').click();
  } finally { app.close(); }
});

test('a delayed automatic bill cannot restore an old account and address after switching ID', async () => {
  const bootstrap = baseState(); bootstrap.cart.quote = null;
  let releaseBill;
  const app = harness({ bootstrap, responder: call => {
    if (call.url.endsWith('/cart/sync')) return new Promise(resolve => {
      releaseBill = () => resolve(response({ ok: true, cart: structuredClone(cart), selectedAddress: address }));
    });
    if (call.url.endsWith('/accounts/select')) {
      const next = structuredClone(bootstrap);
      next.accounts[0].active = false; next.accounts[1].active = true; next.activeAccount = next.accounts[1];
      next.selectedAddress = null;
      return response(next);
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'cart');
    await waitFor(() => app.document.querySelector('.confirm-dialog .button.primary'), 'sync consent');
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => releaseBill, 'pending old bill');
    nav(app, 'accounts'); app.document.querySelector('[data-action="account-select"][data-key="b"]').click();
    await waitFor(() => app.document.querySelector('.ac-row.active [data-key="b"]'), 'new ID');
    nav(app, 'cart'); releaseBill();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(app.document.querySelector('#account-chip-text').textContent, 'Abbu');
    assert.equal(app.document.querySelector('.bill-card'), null, 'old quote was not restored');
    assert.match(app.document.querySelector('#content').textContent, /Select Delivery Address/);
    assert.doesNotMatch(app.document.querySelector('#content').textContent, /Test Road, Pune/);
  } finally { app.close(); }
});

test('late meal and coupon responses cannot cross account or address contexts', async () => {
  const bootstrap = baseState();
  let releaseOldMeal, releaseOldCoupons, menuCalls = 0, couponCalls = 0;
  const menu = label => response({ ok: true, restaurant: { id: 'r', name: 'Cafe', isOpen: true }, categories: [{ title: 'Sides', items: [{ id: label, name: label, price: 50, inStock: true }] }] });
  const coupons = code => response({ ok: true, coupons: [{ code, title: '10% OFF', description: 'Offline example' }] });
  const app = harness({ bootstrap, responder: call => {
    if (call.url.includes('/menu?')) {
      if (++menuCalls === 1) return new Promise(resolve => { releaseOldMeal = () => resolve(menu('OLD_MEAL')); });
      return menu('NEW_MEAL');
    }
    if (call.url.includes('/coupons?')) {
      if (++couponCalls === 1) return new Promise(resolve => { releaseOldCoupons = () => resolve(coupons('OLD_COUPON')); });
      return coupons('NEW_COUPON');
    }
    if (call.url.endsWith('/accounts/select')) {
      const next = structuredClone(bootstrap);
      next.accounts[0].active = false; next.accounts[1].active = true; next.activeAccount = next.accounts[1];
      next.selectedAddress = { ...address, id: 'work', address: 'Second Road' };
      return response(next);
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'cart');
    await waitFor(() => releaseOldMeal && releaseOldCoupons, 'old context requests');
    nav(app, 'accounts'); app.document.querySelector('[data-action="account-select"][data-key="b"]').click();
    await waitFor(() => app.document.querySelector('.ac-row.active [data-key="b"]'), 'new ID');
    nav(app, 'cart');
    await waitFor(() => app.document.querySelector('#content').textContent.includes('NEW_COUPON') && app.document.querySelector('#content').textContent.includes('NEW_MEAL'), 'new context results');
    releaseOldMeal(); releaseOldCoupons();
    await new Promise(resolve => setTimeout(resolve, 30));
    const text = app.document.querySelector('#content').textContent;
    assert.match(text, /NEW_MEAL/); assert.match(text, /NEW_COUPON/);
    assert.doesNotMatch(text, /OLD_MEAL|OLD_COUPON/);
  } finally { app.close(); }
});

test('Pay Now does not approve a delayed bill from a different account', async () => {
  const bootstrap = baseState(); bootstrap.cart.quote = null;
  let releaseBill;
  const app = harness({ bootstrap, responder: call => {
    if (call.url.endsWith('/cart/sync')) return new Promise(resolve => {
      releaseBill = () => resolve(response({ ok: true, cart: structuredClone(cart), selectedAddress: address }));
    });
    if (call.url.endsWith('/accounts/select')) {
      const next = structuredClone(bootstrap);
      next.accounts[0].active = false; next.accounts[1].active = true; next.activeAccount = next.accounts[1];
      next.selectedAddress = null;
      return response(next);
    }
  } });
  try {
    await waitFor(() => app.document.querySelector('.ac-row.active'), 'accounts'); nav(app, 'cart');
    await waitFor(() => app.document.querySelector('.confirm-dialog'), 'automatic sync consent');
    app.document.querySelector('.confirm-dialog .button.soft').click();
    app.document.querySelector('[data-action="checkout-start"]').click();
    await waitFor(() => app.document.querySelector('.confirm-dialog .button.primary'), 'manual sync consent');
    app.document.querySelector('.confirm-dialog .button.primary').click();
    await waitFor(() => releaseBill, 'pending bill');
    nav(app, 'accounts'); app.document.querySelector('[data-action="account-select"][data-key="b"]').click();
    await waitFor(() => app.document.querySelector('.ac-row.active [data-key="b"]'), 'new ID');
    releaseBill(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(app.document.querySelector('.confirm-dialog'), null, 'old bill was not presented for payment');
    assert.equal(app.calls.some(c => c.url.endsWith('/checkout')), false, 'no checkout was sent');
    assert.equal(app.document.querySelector('#account-chip-text').textContent, 'Abbu');
    nav(app, 'cart'); assert.equal(app.document.querySelector('.bill-card'), null);
  } finally { app.close(); }
});
