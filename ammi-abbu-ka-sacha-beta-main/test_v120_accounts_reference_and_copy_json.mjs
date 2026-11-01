// Boss (01-11-2026, round 31): "ISKO AS IT IS COPY KAR — FONT SIZE, SPACING, ID
// AND ALL THE FEATURES IT PROVIDE LIKE WHEN CLICK COPY THE JSON".
//
// Reference: Add Account card (Number/JSON pill, flag + +91, gradient Send OTP),
// "Saved Accounts" + count, "Search Account...", aur har row par Used / JSON copy
// / green check / delete.
//
// Yahan sirf dikhawa nahi — copy JSON asli session deta hai (server se), par
// sirf usi account ka jo user khud manage karta hai. Shared/vault ID ka session
// kabhi client ko nahi jata. Koi nakli success nahi.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';

const css = fs.readFileSync(new URL('./swiggy-pro.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('./swiggy-pro-api.js', import.meta.url), 'utf8');

const base = (over = {}) => ({
  ok: true, user: { name: 'T', isBoss: false },
  accounts: [
    { key: 'acc_9031204105', name: 'skk', phone: '9031204105', active: true, isLoggedIn: true, status: 'USED', canRemove: true, canClaim: true, owner: 'self' },
    { key: 'acc_9876543210', name: 'Ammi', phone: '9876543210', active: false, isLoggedIn: true, status: 'READY', canRemove: true, canClaim: true, owner: 'self' }
  ],
  activeAccount: { key: 'acc_9031204105', name: 'skk', phone: '9031204105' },
  selectedAddress: null, selectedAddresses: [], checkoutEnabled: true, ordersDetailAllowed: true,
  ...over
});

function boot(state, responder) {
  const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''), {
    runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true
  });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.__STATE = state;
  window.__CALLS = [];
  window.fetch = async (url, opts = {}) => {
    window.__CALLS.push({ url: String(url), method: opts.method || 'GET' });
    const out = responder ? responder(String(url), opts) : window.__STATE;
    return { ok: true, status: 200, json: async () => out };
  };
  window.eval(appSource);
  return dom;
}
const waitFor = async (fn, label, ms = 5000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const v = fn(); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout: ' + label);
};

// ── 1. Structure + naap (reference screenshot se) ─────────────────────────
test('accounts: Add Account card, Number/JSON pill, flag + +91, Send OTP', async () => {
  const dom = boot(base());
  const { window } = dom;
  try {
    const card = await waitFor(() => window.document.querySelector('.ac-card'), 'add card');
    assert.match(card.textContent, /Add Account/);
    const modes = [...card.querySelectorAll('.ac-mode button')];
    assert.deepEqual(modes.map(b => b.textContent.trim()), ['Number', 'JSON']);
    assert.equal(modes[0].getAttribute('aria-selected'), 'true');
    // Flag emoji nahi — CSS ka tiranga (emoji font na ho to tofu banta hai)
    assert.ok(card.querySelector('.ac-prefix .ac-flag'), 'CSS flag');
    assert.match(card.querySelector('.ac-prefix').textContent, /\+91/);
    const cta = card.querySelector('button.ac-cta[type="submit"]');
    assert.match(cta.textContent, /Send OTP/);
    assert.ok(cta.querySelector('svg.icon'), 'Send OTP par asli icon');
    assert.equal(card.querySelector('form[data-form="send-otp"] input[name="phone"]').placeholder, 'Enter Mobile Number');
  } finally { window.close(); }
});

test('accounts: JSON mode dabane par session form (asli import form)', async () => {
  const dom = boot(base());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('.ac-mode button[data-mode="json"]'), 'mode');
    window.document.querySelector('.ac-mode button[data-mode="json"]').click();
    const form = await waitFor(() => window.document.querySelector('form[data-form="import"]'), 'json form');
    assert.ok(form.querySelector('textarea[name="session"]'));
    assert.match(form.textContent, /Login via JSON/);
  } finally { window.close(); }
});

test('accounts: Saved Accounts heading + ginti + Search Account… + counts sahi', async () => {
  const dom = boot(base());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('.ac-saved-head'), 'saved head');
    assert.match(window.document.querySelector('.ac-saved-head').textContent, /Saved Accounts/);
    assert.equal(window.document.querySelector('.ac-count').textContent.trim(), '2');
    const search = window.document.querySelector('.ac-search input[data-input="account-search"]');
    assert.equal(search.placeholder, 'Search Account...');
    assert.equal(window.document.querySelectorAll('.ac-row').length, 2);
  } finally { window.close(); }
});

test('accounts: search asli filter karta hai (naam ya number se), keyboard band nahi hota', async () => {
  const dom = boot(base());
  const { window } = dom;
  try {
    const search = await waitFor(() => window.document.querySelector('input[data-input="account-search"]'), 'search');
    search.value = 'ammi';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const rows = [...window.document.querySelectorAll('.ac-row')];
    assert.equal(rows.filter(r => !r.hidden).length, 1, 'sirf Ammi');
    assert.match(rows.filter(r => !r.hidden)[0].textContent, /Ammi/);
    search.value = '9031';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal([...window.document.querySelectorAll('.ac-row')].filter(r => !r.hidden).length, 1, 'number se bhi');
    search.value = 'zzz';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal([...window.document.querySelectorAll('.ac-row')].filter(r => !r.hidden).length, 0);
    assert.equal(window.document.querySelector('.ac-noresult-live').hidden, false, 'khaali result par line');
  } finally { window.close(); }
});

test('accounts: active row par Used pill, JSON copy, green check; doosri row par sirf copy/select', async () => {
  const dom = boot(base());
  const { window } = dom;
  try {
    await waitFor(() => window.document.querySelector('.ac-row.active'), 'active row');
    const active = window.document.querySelector('.ac-row.active');
    assert.match(active.querySelector('.ac-used').textContent, /Used/);
    assert.ok(active.querySelector('.ac-check.on'), 'green selected check');
    assert.ok(active.querySelector('[data-action="account-copy-json"]'), 'copy JSON');
    assert.ok(active.querySelector('[data-action="account-remove"]'), 'delete');
    const other = [...window.document.querySelectorAll('.ac-row')].find(r => !r.classList.contains('active'));
    assert.ok(other.querySelector('[data-action="account-select"]'), 'select button');
    assert.equal(other.querySelector('.ac-used'), null, 'non-used row par Used pill nahi');
    // Emoji/tofu kabhi nahi — sab SVG icon
    assert.equal(/[\u2600-\u27bf🌙☀️🎁]/u.test(window.document.querySelector('#content').textContent), false);
  } finally { window.close(); }
});

// ── 2. Copy JSON: asli fetch + clipboard + sach boliye ────────────────────
test('copy JSON: server se session aata hai aur clipboard me copy hota hai', async () => {
  let copied = '';
  const session = { phone: '9031204105', token: 'tok_abc', tid: 'tid_1' };
  const dom = boot(base(), url => (url.includes('/accounts/session') ? { ok: true, session, note: 'x' } : base()));
  const { window } = dom;
  try {
    window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    const btn = await waitFor(() => window.document.querySelector('[data-action="account-copy-json"]'), 'copy btn');
    btn.click();
    await waitFor(() => copied.length > 0, 'clipboard write');
    assert.deepEqual(JSON.parse(copied), session, 'wahi session jo server ne diya');
    const call = window.__CALLS.find(c => c.url.includes('/accounts/session'));
    assert.match(call.url, /key=acc_9031204105/);
    const toast = window.document.querySelector('#toast');
    await waitFor(() => /copy ho gaya/.test(toast.textContent), 'toast');
    assert.equal(toast.className, 'toast-ok');
  } finally { window.close(); }
});

test('copy JSON: clipboard band ho to execCommand fallback, jhooth nahi', async () => {
  let fallbackValue = '';
  const dom = boot(base(), url => (url.includes('/accounts/session') ? { ok: true, session: { token: 't' } } : base()));
  const { window } = dom;
  try {
    window.navigator.clipboard = { writeText: async () => { throw new Error('blocked'); } };
    window.document.execCommand = () => { fallbackValue = window.document.querySelector('textarea')?.value || ''; return true; };
    const btn = await waitFor(() => window.document.querySelector('[data-action="account-copy-json"]'), 'copy btn');
    btn.click();
    await waitFor(() => fallbackValue.length > 0, 'fallback copy');
    assert.deepEqual(JSON.parse(fallbackValue), { token: 't' });
    assert.equal(window.document.querySelector('#toast').className, 'toast-ok');
  } finally { window.close(); }
});

test('copy JSON: error par laal toast — chup-chaap kuch nahi hota', async () => {
  const dom = boot(base(), url => (url.includes('/accounts/session') ? { ok: false, error: 'Session mila nahi.' } : base()));
  const { window } = dom;
  try {
    const btn = await waitFor(() => window.document.querySelector('[data-action="account-copy-json"]'), 'copy btn');
    btn.click();
    const toast = await waitFor(() => /Session mila nahi|JSON nahi mila/.test(window.document.querySelector('#toast').textContent) && window.document.querySelector('#toast'), 'bad toast');
    assert.equal(toast.className, 'toast-bad');
  } finally { window.close(); }
});

// ── 3. CSS naap (reference: 390px width) ─────────────────────────────────
test('css: accounts screen ke naap reference se (pill, CTA, row, search)', () => {
  assert.match(css, /\.ac-mode button \{[\s\S]*?padding: 6px 10px; font-size: var\(--t-11\)/);
  assert.match(css, /\.ac-cta \{[\s\S]*?min-height: 46px;[\s\S]*?border-radius: 12px/);
  assert.match(css, /\.ac-input \{[\s\S]*?min-height: 46px/);
  assert.match(css, /\.ac-row \{[\s\S]*?padding: 11px 12px;[\s\S]*?border-radius: 16px/);
  assert.match(css, /\.ac-row\.active \{ background: #eefaf3; border-color: #b7e8cf; \}/);
  assert.match(css, /\.ac-flag \{/);
  assert.match(css, /\.ac-search \{[\s\S]*?min-height: 46px/);
  assert.match(css, /\.topbar \{ min-height: 60px/);
});

// ── 4. Server: sirf apne account ka session, shared nahi ───────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-json-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'db.json');
process.env.ACCOUNTS_JSON_FILE = path.join(tmp, 'accounts.json');
process.env.BOT_TOKEN = '123456:offline-test-bot-token';
process.env.PRO_VAULT_KEY = 'offline-random-test-key-only';
process.env.BOSS_ID = '7000';
process.env.DB_ASYNC_WRITE = '0';
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { getDb, saveDb } = await import('./store.js');
const db = getDb();
db.config.accounts.vault_acc = { id: 'vault_acc', isLoggedIn: true, name: 'Vault ID', phone: '9812345678', token: 'vault-secret-sentinel' };
saveDb(db);
const address = { id: 'a1', name: 'R', mobile: '9123456789', address: 'Test road', lat: '18.5', lng: '73.8' };
const provider = {
  async verifySession() { return { valid: true, name: 'P', phone: '9234567890', customerId: 'c-9234567890' }; },
  async addresses() { return [address]; },
  async orders() { return []; }
};
const otp = { async request() { return { success: true }; }, async verify() { return { success: true, phone: '9234567890', name: 'P', exportJson: { phone: '9234567890', token: 'my-secret-sentinel', tid: 't' } }; } };
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider, otp, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Asli Telegram init data jaisa signature — warna server 401 deta hai. */
function sign(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'User ' + userId }),
    query_id: 'query'
  });
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
const initData = (id) => sign(id);
async function call(p, userId = '7001') {
  const res = await fetch(baseUrl + '/pro/api/' + p, { headers: { 'X-Telegram-Init-Data': initData(userId) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function post(p, body, userId = '7001') {
  const res = await fetch(baseUrl + '/pro/api/' + p, {
    method: 'POST', headers: { 'X-Telegram-Init-Data': initData(userId), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('server: apne account ka session milta hai aur wahi import me chalta hai', async () => {
  await post('accounts/send-otp', { phone: '9234567890' });
  const added = await post('accounts/verify-otp', { otp: '123456' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const key = added.body.accounts.find(a => a.active)?.key;
  assert.ok(key, 'active account key');
  const out = await call('accounts/session?key=' + encodeURIComponent(key));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.token, 'my-secret-sentinel');
  assert.equal(out.body.session.isLoggedIn, undefined, 'internal flags nahi');
  assert.match(out.body.note, /share na karein/i);
});

test('server: shared ID is selectable by default but its vault session stays operator-only', async () => {
  const out = await call('accounts/session?key=vault_acc', '7001');
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal(JSON.stringify(out.body).includes('vault-secret-sentinel'), false, 'shared token leak nahi');

  const current = getDb();
  current.knownUsers ||= {};
  current.knownUsers['7001'] = { id: '7001', firstName: 'Family', lastSeen: Date.now() };
  saveDb(current);
  const grant = await post('boss/account-access', { userId: '7001', accountKey: 'vault_acc', allow: true, confirm: true }, '7000');
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const granted = await call('accounts/session?key=vault_acc', '7001');
  assert.equal(granted.status, 403, JSON.stringify(granted.body));
  assert.match(granted.body.error, /operator ke vault/i);
  assert.equal(JSON.stringify(granted.body).includes('vault-secret-sentinel'), false, 'granted token leak nahi');

  // Boss khud apna vault ID export kar sakta hai (wahi ID jise wo manage karta hai).
  const bossView = await call('accounts/session?key=vault_acc', '7000');
  assert.equal(bossView.status, 200, JSON.stringify(bossView.body));
  assert.equal(bossView.body.session.token, 'vault-secret-sentinel');
});

test('server: unknown key par 404, aur rate-limit bucket maujood hai', async () => {
  const out = await call('accounts/session?key=kuch_bhi_nahi');
  assert.equal(out.status, 404);
  assert.ok(apiSource.includes("enforceRateLimit(user, 'accountExport')"), 'rate limit lagu');
  const rl = fs.readFileSync(new URL('./pro-rate-limit.js', import.meta.url), 'utf8');
  assert.match(rl, /accountExport: \{ max: 30/);
});
