// Boss (31-10-2026, round 21): "NO SMS RECEIVED AND NO TRACKING IS AVAILABLE"
//
// Do cheezein jhooth ke bina:
//   1. Tracking — deep rasta (trackV4 → order/details → Swiggy order page) aur
//      na mile to asli wajah + kya try hua.
//   2. SMS — Swiggy ke payload me jo flag hai wahi sach; nahi hai to "proof
//      nahi" aur asli wajah (receiver = account ka number / OFO confirm nahi).
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v110-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v110-offline-token', PRO_VAULT_KEY: 'v110-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '0', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1'
});

const { scanRecipientSmsEvidence, describeSmsTruth, describeTrackingTruth, buildOrderTruthReport, SMS_STATES } =
  await import('./tracking-truth.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { getDb, saveDb } = await import('./store.js');
const { writeProWorkspace } = await import('./swiggy-pro-store.js');

// ── 1. pure: SMS evidence ────────────────────────────────────────────────
test('sms: nested payload me jo flag Swiggy ne diya wahi pakda jata hai', () => {
  const sent = scanRecipientSmsEvidence({ data: { order: { ofo: { sms_sent: true } } } });
  assert.equal(sent.state, SMS_STATES.SENT);
  assert.match(sent.evidence, /sms_sent/);

  const notSent = scanRecipientSmsEvidence({ data: { order: { recipient_notification: { sms_sent: false } } } });
  assert.equal(notSent.state, SMS_STATES.NOT_SENT);

  const status = scanRecipientSmsEvidence({ data: { status: 'SMS_SENT', other: 1 } });
  assert.equal(status.state, SMS_STATES.SENT);

  const failed = scanRecipientSmsEvidence({ data: { notification_status: 'SMS_FAILED' } });
  assert.equal(failed.state, SMS_STATES.NOT_SENT);

  const nothing = scanRecipientSmsEvidence({ data: { order_status: 'processing', total: 48 } });
  assert.equal(nothing.state, SMS_STATES.UNKNOWN, 'bina proof UNKNOWN — jhooth nahi');
});

test('sms sach: SENT par proof line, NOT_SENT par asli wajah', () => {
  const sent = describeSmsTruth({
    sms: { state: SMS_STATES.SENT, evidence: 'data.order.ofo.sms_sent = true' },
    receiverPhone: '9876543210', accountPhone: '9123456789', ofoRequested: true, ofoConfirmed: true
  });
  assert.match(sent.line, /bhej diya/i);
  assert.match(sent.line, /98••••3210/);

  const same = describeSmsTruth({ receiverPhone: '9876543210', accountPhone: '9876543210' });
  assert.equal(same.samePhone, true);
  assert.match(same.line, /alag recipient SMS nahi bhejta/i);

  const notOfo = describeSmsTruth({ receiverPhone: '9876543210', accountPhone: '9123456789', ofoRequested: false });
  assert.match(notOfo.line, /someone else/i);

  const ofoUnconfirmed = describeSmsTruth({ receiverPhone: '9876543210', accountPhone: '9123456789', ofoRequested: true, ofoConfirmed: false });
  assert.match(ofoUnconfirmed.line, /OFO confirm nahi/i);

  const ofoOk = describeSmsTruth({ receiverPhone: '9876543210', accountPhone: '9123456789', ofoRequested: true, ofoConfirmed: true });
  assert.match(ofoOk.line, /flag nahi diya/i);

  const noPhone = describeSmsTruth({});
  assert.match(noPhone.line, /number hi wapas nahi diya/i);
});

test('tracking sach: link mila to kaise mila, nahi mila to kya try hua', () => {
  const ok = describeTrackingTruth({ trackingUrl: 'https://www.swiggy.com/ofo/track/abc', via: 'WEB_PAGE_SHARE', attempts: 2 });
  assert.equal(ok.ok, true);
  assert.match(ok.line, /order page se/);
  const nothing = describeTrackingTruth({ trackingUrl: '', tried: ['order/trackV4', 'order/details'], orderStatus: 'processing' });
  assert.equal(nothing.ok, false);
  assert.match(nothing.line, /order\/trackV4/);
  assert.match(nothing.line, /processing/);
  assert.match(nothing.reason, /Refresh/i);
});

test('report: tracking + sms dono ek jagah', () => {
  const report = buildOrderTruthReport({
    tracking: { trackingUrl: '', status: 'processing', sms: { state: SMS_STATES.UNKNOWN } },
    receiverPhone: '9876543210', accountPhone: '9123456789', ofoRequested: true, ofoConfirmed: false, orderStatus: 'processing'
  });
  assert.equal(report.tracking.ok, false);
  assert.equal(report.sms.state, SMS_STATES.UNKNOWN);
});

// ── 2. API: tracking endpoint + checkout SMS truth ───────────────────────
const receiver = { id: 'addr-1', name: 'Chiranjib', mobile: '7978459775', address: 'Golden villa, Kajala', lat: '20.2584', lng: '84.7925', annotation: 'HOME' };
let trackingPayload = null;
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true, phone: '9000011111' }; },
    async orders() { return [{ id: '252429282132542', restaurant: 'Arabecue', status: 'processing', amount: 48 }]; },
    async tracking() {
      if (!trackingPayload) {
        const err = new Error('Swiggy ne is order ka tracking nahi diya (trackV4, order/details aur order page — teeno khaali).');
        err.statusCode = 503; err.code = 'TRACKING_NOT_PUBLISHED'; err.tried = ['order/trackV4', 'order/details'];
        throw err;
      }
      return trackingPayload;
    },
    async checkPayment() { return { paid: false, paymentVerified: false }; }
  };
  if (!await handleSwiggyProHttp(req, res, {
    provider, claim: async () => ({}),
    otp: { request: async () => ({}), verify: async () => ({}) },
    deleteOtp: { request: async () => ({}), verify: async () => ({}) },
    authorizeUser: async () => ({ allowed: true })
  })) { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise((resolve) => server.close(resolve)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function sign(userId) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: `User ${userId}` }), query_id: 'q' });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
async function req(userId, route, payload) {
  const response = await fetch(base + '/pro/api/' + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': sign(userId), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  return { status: response.status, body: await response.json() };
}
function seed(userId, extra = {}) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [], cart: null,
    ...extra
  });
}

test('api: tracking mila to via + sms sach dono jaate hain', async () => {
  const db = getDb();
  db.config.accounts = {}; db.config.bossIds = ['9000'];
  saveDb(db);
  seed(7301, { cart: { forSomeoneElse: true, items: [] } });
  trackingPayload = {
    orderId: '252429282132542', status: 'processing', eta: '35 min',
    trackingUrl: 'https://www.swiggy.com/ofo/track/tok-1', via: 'ORDER_DETAILS', tried: ['order/trackV4', 'order/details'], attempts: 2,
    sms: { state: 'SENT', evidence: 'data.order.ofo.sms_sent = true' }, deliveryOtp: '4321',
    deliveryPartner: { name: 'Rider', phone: '9000000001' }
  };
  const out = await req(7301, 'orders/tracking?id=252429282132542');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(out.body.tracking.trackingUrl, /swiggy\.com\/ofo\/track/);
  assert.equal(out.body.tracking.via, 'ORDER_DETAILS');
  assert.deepEqual(out.body.tracking.tried, ['order/trackV4', 'order/details']);
  assert.equal(out.body.sms.state, 'SENT');
  assert.match(out.body.sms.line, /bhej diya/i);
});

test('api: provider ne link nahi diya to asli wajah (khaali screen nahi)', async () => {
  seed(7302);
  trackingPayload = null;
  const out = await req(7302, 'orders/tracking?id=252429282132542');
  assert.ok(out.status >= 400, JSON.stringify(out.body));
  assert.match(String(out.body.error || ''), /tracking/i);
});

test('api: checkout PAID par SMS ka sach receiver ke number se banta hai', async () => {
  const db = getDb();
  db.config.accounts = {};
  saveDb(db);
  writeProWorkspace('7303', {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [], cart: null,
    checkout: {
      status: 'PAID', orderId: '252429282132542', accountKey: 'mine', accountPhone: '9234567890',
      receiverPhone: '7978459775', forSomeoneElse: false, ofoConfirmed: false,
      amount: 48, createdAt: new Date().toISOString(), paymentVerified: true,
      tracking: { orderId: '252429282132542', status: 'processing', trackingUrl: '', sms: null }
    }
  });
  const out = await req(7303, 'bootstrap');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const c = out.body.checkout;
  assert.equal(c.restricted, false);
  assert.equal(c.receiverMasked, '79••••9775');
  assert.equal(c.sms.state, 'UNKNOWN');
  assert.match(c.sms.line, /someone else/i, 'OFO nahi chala — wahi wajah');
});

test('api: receiver ka number hi account ka ho to SMS ka sach wahi bolta hai', async () => {
  writeProWorkspace('7304', {
    version: 1,
    accounts: { mine: { phone: '7978459775', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: receiver, addressCandidates: [], cart: null,
    checkout: {
      status: 'PAID', orderId: '252429282132542', accountKey: 'mine', accountPhone: '7978459775',
      receiverPhone: '7978459775', forSomeoneElse: false, ofoConfirmed: false,
      amount: 48, createdAt: new Date().toISOString(), paymentVerified: true, tracking: { status: 'processing', trackingUrl: '' }
    }
  });
  const out = await req(7304, 'bootstrap');
  assert.equal(out.body.checkout.sms.samePhone, true);
  assert.match(out.body.checkout.sms.line, /isi account ka hai/i);
});

// ── 3. DOM: order kholte hi tracking khud, aur SMS ka sach dikhta hai ─────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

function boot(state, { onApi } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.fetch = async (raw, options = {}) => {
    if (onApi) { const handled = await onApi(String(raw), options); if (handled) return handled; }
    return { ok: true, status: 200, json: async () => state };
  };
  window.eval(appSource);
  return { window, dom };
}
const waitFor = async (fn, label, ms = 5000) => {
  const started = Date.now();
  while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout: ' + label);
};

test('DOM: order kholte hi tracking khud load hoti hai + SMS sach card', async () => {
  const state = {
    ok: true, user: { name: 'T', isBoss: false },
    accounts: [{ key: 'mine', name: 'Mine', phone: '9234567890', active: true, isLoggedIn: true }],
    activeAccount: { key: 'mine', name: 'Mine' }, selectedAddress: receiver, selectedAddresses: [receiver],
    checkoutEnabled: true, ordersDetailAllowed: true, cart: null,
    orders: [{ id: '252429282132542', restaurant: 'Arabecue', status: 'processing', amount: 48, placedAt: '2026-10-31 20:44', items: [] }],
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [], history: [] }
  };
  let trackingCalls = 0;
  const { window } = boot(state, {
    onApi: async (url) => {
      if (url.includes('orders/tracking')) {
        trackingCalls += 1;
        return { ok: true, status: 200, json: async () => ({
          ok: true,
          sms: { state: 'UNKNOWN', line: 'OFO fields bheje gaye the par Swiggy ne OFO confirm nahi kiya.', advice: 'Tracking app ke andar hi hai.' },
          tracking: {
            orderId: '252429282132542', status: 'processing', eta: '35 min',
            trackingUrl: 'https://www.swiggy.com/ofo/track/tok-1', via: 'ORDER_DETAILS',
            sms: { state: 'UNKNOWN' }, note: 'Tracking link Swiggy ke order page se mila.'
          }
        }) };
      }
      return null;
    }
  });
  try {
    await waitFor(() => window.document.querySelector('[data-tab="orders"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="orders"]').click();
    const row = await waitFor(() => window.document.querySelector('[data-action="order-detail"]'), 'order row');
    row.click();
    // Koi Refresh click nahi — khud aani chahiye.
    await waitFor(() => trackingCalls >= 1, 'auto tracking');
    const link = await waitFor(() => window.document.querySelector('a[href^="https://www.swiggy.com/ofo/track"]'), 'link');
    assert.ok(link, 'tracking link dikha');
    const text = window.document.querySelector('#content').textContent;
    assert.match(text, /SMS/, 'SMS row dikhi');
    assert.match(text, /OFO confirm nahi/i);
    assert.match(text, /Link kahan se/, 'link kis route se mila woh bhi');
  } finally { window.close(); }
});

test('api: boss ko live-order ka sach — block hai to SMS ka intezaar bekaar', async () => {
  const previous = process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
  process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE = '1';
  try {
    const out = await req(9000, 'bootstrap');
    assert.equal(out.status, 200);
    assert.equal(out.body.liveOrder.blocked, true);
    assert.match(out.body.liveOrder.line, /live order place band/i);
  } finally {
    if (previous === undefined) delete process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE;
    else process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE = previous;
  }
  const user = await req(7301, 'bootstrap');
  assert.equal(user.body.liveOrder.smsAllowed !== undefined, true);
});
