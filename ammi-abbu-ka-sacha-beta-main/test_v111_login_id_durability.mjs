// Boss (31-10-2026, round 22):
//   "AB JAISE JITNE BHI LOGIN ID HOTE HAIN KISKA DATA NAHI BACHTA WO KISLIYE
//    AND KYA SOLUTION HAI"
//
// Jawab: `ensureDb()` disk na hone par default db bana deta hai — login IDs,
// unke cookies/token, mini-app workspaces (address/cart/orders) sab gayab.
// Ab identity snapshot: local + encrypted cloud, boot par restore, aur boss ko
// per-ID sach (session saved / expired / restore hua / cloud ON-OFF).
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v111-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v111-offline-token', PRO_VAULT_KEY: 'v111-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '1', DB_ASYNC_WRITE: '0', NODE_ENV: 'test', ALLOW_LIVE_SWIGGY_SMS_ORDER: '1',
  GITHUB_VAULT_TOKEN: 'ghp_test_token_v111', VAULT_ENCRYPTION_KEY: 'v111-vault-enc-key'
});

// GitHub vault mock — PUT/GET memory me.
const vaultFiles = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const url = String(raw);
  if (url.includes('127.0.0.1')) return realFetch(raw, options);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const m = url.match(/\/contents\/([^?]+)/);
  if (url.includes('api.github.com') && m) {
    const key = decodeURIComponent(m[1]);
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body || '{}');
      vaultFiles.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
      return json({ ok: true });
    }
    if (vaultFiles.has(key)) return json({ content: Buffer.from(vaultFiles.get(key), 'utf8').toString('base64') });
    return json({ message: 'Not Found' }, 404);
  }
  if (url.includes('api.github.com')) return json({ ok: true });
  return json({ statusCode: 0 });
};

const { getDb, saveDb } = await import('./store.js');
const { buildIdentitySnapshot, snapshotHasIdentities, mergeIdentitySnapshot, summarizeIdentities, describeIdentityDurability } =
  await import('./identity-snapshot.js');
const { backupIdentityNow, restoreIdentityOnBoot, identityStatus, durabilityStatus, _resetDurabilityState } =
  await import('./db-durability.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace, backupProWorkspaceNow } = await import('./swiggy-pro-store.js');

const cookie = '_session_tid=abc123; tid=tid-1; token=tok-1';
function seedDb() {
  const db = getDb();
  db.config.accounts = {
    acc_1: { id: 'acc_1', name: 'Ammi', phone: '9876543210', cookies: cookie, tid: 'tid-1', token: 'tok-1', isLoggedIn: true, savedAt: new Date().toISOString() },
    acc_2: { id: 'acc_2', name: 'Abbu', phone: '9812345678', cookies: '_session_tid=xyz789; token=tok-2', isLoggedIn: true, savedAt: new Date().toISOString() }
  };
  db.config.deletedAccounts = { acc_deleted: true };
  db.sessionVault = { acc_3: { account: 'acc_3', phone: '9800000000' } };
  db.config.proWorkspaceMirror = {};
  db.config.bossIds = ['9000'];
  saveDb(db);
}

// ── 1. snapshot / merge (pure) ────────────────────────────────────────────
test('snapshot: har login ID + tombstone + session vault yaad rehte hain', () => {
  seedDb();
  const snap = buildIdentitySnapshot(getDb());
  assert.equal(snapshotHasIdentities(snap), true);
  assert.equal(Object.keys(snap.accounts).length, 2);
  assert.equal(snap.counts.sessionVault, 1);
  assert.equal(snap.counts.tombstones, 1);
  assert.ok(snap.accounts.acc_1.cookies.includes('_session_tid'));
});

test('snapshot: khaali shell (bina session) backup me nahi jaata', () => {
  const db = getDb();
  db.config.accounts.acc_empty = { id: 'acc_empty', name: 'Khaali', isLoggedIn: false };
  saveDb(db);
  const snap = buildIdentitySnapshot(getDb());
  assert.equal(snap.accounts.acc_empty, undefined);
});

test('merge: deploy ke baad sab ID wapas, live local session overwrite nahi', () => {
  const snap = buildIdentitySnapshot(getDb());
  const fresh = { config: { accounts: {} }, sessionVault: {} };
  const out = mergeIdentitySnapshot(fresh, snap);
  assert.equal(out.changed, true);
  assert.equal(Object.keys(fresh.config.accounts).length, 2);
  assert.equal(fresh.config.accounts.acc_1.restoredFromSnapshot, true);
  assert.ok(fresh.sessionVault.acc_3);

  // Local me naya live session — snapshot purana hai, overwrite nahi hona chahiye.
  const local = { config: { accounts: { acc_1: { cookies: '_session_tid=NEW', isLoggedIn: true } } }, sessionVault: {} };
  mergeIdentitySnapshot(local, snap);
  assert.ok(local.config.accounts.acc_1.cookies.includes('NEW'));
});

test('merge: jaan-boojh kar logout ki ID wapas nahi aati (tombstone)', () => {
  const snap = buildIdentitySnapshot(getDb());
  const local = { config: { accounts: { acc_1: { cookies: cookie, isLoggedIn: false, isLoggedOut: true } }, deletedAccounts: { acc_1: true } }, sessionVault: {} };
  mergeIdentitySnapshot(local, snap);
  assert.equal(local.config.accounts.acc_1.isLoggedIn, false, 'logout wali ID live nahi hui');
  assert.equal(local.config.accounts.acc_1.restoredFromSnapshot, undefined);
});

test('merge: dead local copy ho to snapshot wali zinda session aati hai', () => {
  const snap = buildIdentitySnapshot(getDb());
  const local = { config: { accounts: { acc_2: { cookies: '', sessionExpired: true, isLoggedIn: false } } }, sessionVault: {} };
  mergeIdentitySnapshot(local, snap);
  assert.ok(local.config.accounts.acc_2.cookies.includes('xyz789'));
  assert.equal(local.config.accounts.acc_2.restoredFromSnapshot, true);
});

test('merge: waris (workspace) sirf tab wapas jab local khaali ho', () => {
  const db = getDb();
  db.config.proWorkspaceMirror = { row1: { v: 1, userId: '7001', savedAt: new Date().toISOString(), envelope: '{"version":1,"data":"x"}' } };
  saveDb(db);
  const snap = buildIdentitySnapshot(getDb());
  const fresh = { config: { accounts: {} }, sessionVault: {} };
  const out = mergeIdentitySnapshot(fresh, snap);
  assert.equal(out.workspacesToRestore.length, 1);
  assert.equal(out.workspacesToRestore[0].userId, '7001');
  assert.ok(fresh.config.proWorkspaceMirror.row1);
});

test('status line: cloud OFF par saaf warning, ON par counts', () => {
  assert.match(describeIdentityDurability({ cloud: false, accountCount: 3 }), /Cloud backup OFF/);
  assert.match(describeIdentityDurability({ cloud: true, accountCount: 3, workspaceCount: 2 }), /3 login ID · 2 mini-app workspace/);
});

test('summarize: cookies bahar nahi jaate, sirf masked number', () => {
  seedDb();
  const rows = summarizeIdentities(getDb().config.accounts);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].phoneMasked, '98••••3210');
  assert.equal(JSON.stringify(rows).includes('_session_tid'), false);
  assert.equal(rows.every(r => r.status === 'LOGGED_IN'), true);
});

// ── 2. deploy simulation ──────────────────────────────────────────────────
test('deploy: snapshot cloud me (encrypted) jata hai aur boot par IDs wapas aati hain', async () => {
  _resetDurabilityState();
  seedDb();
  const pushed = await backupIdentityNow({ force: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  const raw = [...vaultFiles.entries()].find(([k]) => k.includes('db-identity-snapshot'))?.[1];
  assert.ok(raw, 'identity snapshot vault me gaya');
  assert.match(raw, /__vaultEnc/);
  assert.equal(raw.includes('_session_tid=abc123'), false, 'cookies plaintext me nahi');

  // Deploy: db.json naya, disk khali.
  const fresh = getDb();
  fresh.config.accounts = {}; fresh.config.deletedAccounts = {}; fresh.sessionVault = {}; fresh.config.proWorkspaceMirror = {};
  saveDb(fresh);
  fs.rmSync(path.join(tmp, 'db-identity-snapshot.json'), { force: true });
  fs.rmSync(path.join(tmp, 'pro-workspaces'), { recursive: true, force: true });

  _resetDurabilityState();
  const out = await restoreIdentityOnBoot();
  assert.equal(out.restored, true, JSON.stringify(out));
  assert.equal(out.source, 'cloud');
  const keys = Object.keys(getDb().config.accounts);
  assert.deepEqual(keys.sort(), ['acc_1', 'acc_2']);
  assert.ok(getDb().config.accounts.acc_1.cookies.includes('_session_tid=abc123'));
  const status = identityStatus();
  assert.equal(status.total, 2);
  assert.equal(status.live, 2);
  assert.equal(status.cloud, true);
});

test('deploy: dabara restore par kuch nahi badalta (jhootha "restore hua" nahi)', async () => {
  _resetDurabilityState();
  const again = await restoreIdentityOnBoot();
  assert.equal(again.restored, false);
});

test('durabilityStatus me login IDs ka sach bhi aata hai', () => {
  const d = durabilityStatus();
  assert.ok(d.identity, 'identity block mila');
  assert.equal(d.identity.total, 2);
  assert.match(d.identity.line, /login ID/);
});

// ── 3. API: boss panel ────────────────────────────────────────────────────
let verifyCalls = 0;
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession(account) {
      verifyCalls += 1;
      if (String(account?.phone || '') === '9812345678') return { valid: false, reason: 'session expired' };
      return { valid: true, customerId: 'c1', phone: '9876543210', liveTid: 'tid-new', cookies: '_session_tid=new-live' };
    },
    async orders() { return []; },
    async tracking() { return {}; },
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
function seedWorkspace(userId) {
  writeProWorkspace(String(userId), {
    version: 1,
    accounts: { mine: { phone: '9234567890', name: 'Mine', token: 't', isLoggedIn: true, customerId: 'c1' } },
    activeAccountKey: 'mine', selectedAddress: null, addressCandidates: [], cart: null
  });
}

test('api: boss ko per-ID sach, user ko nahi', async () => {
  seedDb();
  seedWorkspace(7101);
  const boss = await req(9000, 'boss/identities');
  assert.equal(boss.status, 200, JSON.stringify(boss.body));
  assert.equal(boss.body.identities.total, 2);
  assert.equal(boss.body.identities.accounts[0].phoneMasked.length, 10);
  assert.equal(JSON.stringify(boss.body).includes('_session_tid'), false, 'cookies leak nahi');
  const user = await req(7101, 'boss/identities');
  assert.equal(user.status, 403);
});

test('api: backup button sach bolta hai (cloud ON)', async () => {
  const out = await req(9000, 'boss/identities', {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.backup.ok, true);
  assert.match(out.body.message, /save ho gaya/i);
});

test('api: sessions Swiggy par asli check — expired ID ka sach', async () => {
  seedDb();
  verifyCalls = 0;
  const out = await req(9000, 'boss/identities', { verify: true });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.checked, 2);
  assert.ok(verifyCalls >= 2);
  const abbu = out.body.results.find(r => r.name === 'Abbu');
  assert.equal(abbu.valid, false);
  assert.match(abbu.reason, /expired/i);
  const ammi = out.body.results.find(r => r.name === 'Ammi');
  assert.equal(ammi.valid, true);
  // Expired ID db me honestly mark hui, aur live ID ka naya tid save hua.
  assert.equal(getDb().config.accounts.acc_2.sessionExpired, true);
  assert.equal(getDb().config.accounts.acc_1.sessionExpired, false);
  assert.ok(String(getDb().config.accounts.acc_1.tid).includes('new'));
});

test('api: bootstrap me boss ko identities summary aati hai', async () => {
  seedDb();
  const out = await req(9000, 'bootstrap');
  assert.equal(out.status, 200);
  assert.ok(out.body.identities);
  assert.equal(out.body.identities.total, 2);
});

// ── 4. DOM: boss card ─────────────────────────────────────────────────────
const html = fs.readFileSync(new URL('./swiggy-pro.html', import.meta.url), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
const appSource = fs.readFileSync(new URL('./swiggy-pro-app.js', import.meta.url), 'utf8');

test('DOM: Tools hides the login-data card while backend durability APIs remain tested', async () => {
  const state = {
    ok: true, user: { name: 'Boss', isBoss: true },
    accounts: [{ key: 'op', name: 'Operator', phone: '9000011111', active: true, isLoggedIn: true, owner: 'operator' }],
    activeAccount: { key: 'op', name: 'Operator' }, selectedAddress: null, selectedAddresses: [],
    checkoutEnabled: true, ordersDetailAllowed: true, cart: null,
    wallet: { balancePaise: 0, balance: '0', feePaise: 1500, fee: '15', ready: false, shortfall: '15', upiId: 'mius@ybl', presets: [], history: [] },
    identities: {
      cloud: true, total: 2, live: 1, expired: 1, workspaceCount: 3,
      lastPushAt: new Date().toISOString(), restoredAt: new Date().toISOString(),
      line: 'Cloud backup ON · 2 login ID · 3 mini-app workspace yaad',
      accounts: [
        { key: 'acc_1', name: 'Ammi', phoneMasked: '98••••3210', status: 'LOGGED_IN', savedAt: new Date().toISOString(), restoredFromSnapshot: true },
        { key: 'acc_2', name: 'Abbu', phoneMasked: '98••••5678', status: 'EXPIRED', savedAt: new Date().toISOString() }
      ]
    }
  };
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/pro', pretendToBeVisual: true });
  const { window } = dom;
  window.Telegram = { WebApp: { initData: 'x', ready() {}, expand() {} } };
  window.scrollTo = () => {};
  window.fetch = async () => ({ ok: true, status: 200, json: async () => state });
  window.eval(appSource);
  try {
    const waitFor = async (fn, label, ms = 5000) => {
      const started = Date.now();
      while (Date.now() - started < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 20)); }
      throw new Error('timeout: ' + label);
    };
    await waitFor(() => window.document.querySelector('[data-tab="tools"]:not([disabled])'), 'nav');
    window.document.querySelector('[data-tab="tools"]').click();
    await waitFor(() => /ID access/.test(window.document.querySelector('#content').textContent), 'tools');
    const text = window.document.querySelector('#content').textContent;
    assert.doesNotMatch(text, /Login ID ka data|IDs saved|deploy ke baad wapas aaya/);
    assert.equal(window.document.querySelector('[data-action="identities-backup"]'), null);
    assert.equal(window.document.querySelector('[data-action="identities-verify"]'), null);
  } finally { window.close(); }
});

test('workspace key health: khulte hain ya nahi — sach', async () => {
  seedDb();
  seedWorkspace(7202);
  const backupRes = await backupProWorkspaceNow(7202);   // mirror row turant (debounce ka intezaar nahi)
  assert.equal(backupRes.mirrored, true);
  const before = identityStatus();
  assert.equal(before.workspaceHealth.total >= 1, true);
  assert.equal(before.workspaceHealth.failed, 0, 'isi key se khul raha hai');
  assert.ok(before.workspaceHealth.keySource);
});
