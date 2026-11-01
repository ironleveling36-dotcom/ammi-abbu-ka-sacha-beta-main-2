// Boss (31-10-2026, round 24): "BHAI TU PEHLE YE FIX KAR DE TAAKI KOI DATA ERASE NA HO"
//
// Round 19/22 ne data WAPAS laane ka rasta bana diya. Bacha hua khatra ulta
// tha: restore fail ho (key badli / network) → app khaali db par chale → agla
// backup khaali snapshot cloud par push kar de → purana data hamesha ke liye
// mit jaye. Ab har push se pehle cloud padha jata hai:
//   1. cloud file hai par khul nahi rahi  → push BAND (purana data safe)
//   2. local me kuch nahi bacha            → push BAND (khaali cloud par nahi)
//   3. cloud par bhi data hai              → pehle MILAO, phir push (kam kabhi nahi)
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v113-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v113-offline-token', PRO_VAULT_KEY: 'v113-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '1', DB_ASYNC_WRITE: '0', NODE_ENV: 'test',
  GITHUB_VAULT_TOKEN: 'ghp_test_token_v113', VAULT_ENCRYPTION_KEY: 'v113-key-one'
});

// GitHub vault mock — PUT/GET memory me (file ka text jaisa hai waisa hi).
const vaultFiles = new Map();
let onMoneyGet = null;
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
    if (key.includes('db-money-snapshot') && onMoneyGet) await onMoneyGet(key);
    if (vaultFiles.has(key)) return json({ content: Buffer.from(vaultFiles.get(key), 'utf8').toString('base64') });
    return json({ message: 'Not Found' }, 404);
  }
  if (url.includes('api.github.com')) return json({ ok: true });
  return json({ statusCode: 0 });
};

const { getDb, saveDb } = await import('./store.js');
const { creditWallet, debitWallet } = await import('./user-wallet.js');
const { assessPush, identityWeight, moneyWeight, describePushSafety, PUSH_BLOCK, PUSH_STATE } = await import('./vault-safety.js');
const { buildIdentitySnapshot, mergeIdentitySnapshot } = await import('./identity-snapshot.js');
const { buildMoneySnapshot } = await import('./money-snapshot.js');
const { backupIdentityNow, restoreIdentityOnBoot, identityStatus, durabilityStatus,
  backupMoneyNow, restoreMoneyOnBoot, _resetDurabilityState } = await import('./db-durability.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');
const { writeProWorkspace, backupProWorkspaceNow, resetProWorkspaceHydrationCache, proBackupStatus, emptyProWorkspace } =
  await import('./swiggy-pro-store.js');

const cookie = '_session_tid=abc123; tid=tid-1; token=tok-1';

function wipeDb() {
  const db = getDb();
  db.config.accounts = {};
  db.config.deletedAccounts = {};
  db.config.proWorkspaceMirror = {};
  db.config.wallets = {};
  db.config.usedUtrs = {};
  db.config.topupRequests = {};
  db.config.topupClaims = {};
  db.config.topupIntents = {};
  db.config.bossIds = ['9000'];
  db.sessionVault = {};
  saveDb(db);
}

function seedIdentities() {
  const db = getDb();
  db.config.accounts = {
    acc_1: { id: 'acc_1', name: 'Ammi', phone: '9876543210', cookies: cookie, tid: 'tid-1', token: 'tok-1', isLoggedIn: true, savedAt: new Date().toISOString() },
    acc_2: { id: 'acc_2', name: 'Abbu', phone: '9812345678', cookies: '_session_tid=xyz789; token=tok-2', isLoggedIn: true, savedAt: new Date().toISOString() }
  };
  db.config.deletedAccounts = {};
  db.config.proWorkspaceMirror = {};
  db.sessionVault = {};
  saveDb(db);
}

function clearLocalCopies() {
  for (const file of ['db-identity-snapshot.json', 'db-money-snapshot.json']) {
    try { fs.rmSync(path.join(tmp, file), { force: true }); } catch {}
  }
}

function reset(envKey = 'v113-key-one') {
  process.env.VAULT_ENCRYPTION_KEY = envKey;
  _resetDurabilityState();
  clearLocalCopies();
}

/** Vault file ka asli andar ka payload (outer wrapper kholo). */
async function decodeVault(text) {
  const { decryptVaultPayloadText } = await import('./vault-sync.js');
  const parsed = JSON.parse(text);
  const payload = parsed?.payload ?? parsed;
  return decryptVaultPayloadText(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

const identityKey = () => [...vaultFiles.keys()].find((k) => k.includes('db-identity-snapshot'));
const moneyKey = () => [...vaultFiles.keys()].find((k) => k.includes('db-money-snapshot'));

// ── 1. pure: faisla ──────────────────────────────────────────────────────
test('safety: cloud padha nahi ja raha to push BAND (purana data overwrite nahi)', () => {
  const out = assessPush({ kind: 'identity', local: { accounts: { a: 1 } }, remote: null, remotePresent: true, remoteReadable: false });
  assert.equal(out.allow, false);
  assert.equal(out.code, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.match(out.line, /overwrite nahi/);
});

test('safety: local khaali ho to khaali snapshot cloud par nahi jata', () => {
  const out = assessPush({ kind: 'identity', local: { accounts: {}, workspaces: {}, sessionVault: {} }, remote: null, remotePresent: false, remoteReadable: true });
  assert.equal(out.allow, false);
  assert.equal(out.code, PUSH_BLOCK.LOCAL_EMPTY);
});

test('safety: cloud par bhi data hai to pehle milao, phir push', () => {
  const out = assessPush({
    kind: 'identity',
    local: { accounts: { a: 1 } },
    remote: { accounts: { a: 1, b: 2 } }, remotePresent: true, remoteReadable: true
  });
  assert.equal(out.allow, true);
  assert.equal(out.code, PUSH_STATE.MERGE_THEN_ALLOW);
  assert.equal(out.remoteWeight.accounts, 2);
});

test('safety: paisa — balance aur UTR ka weight sahi gina jata hai', () => {
  const snap = { sections: { wallets: { u1: { balancePaise: 2500 }, u2: { balancePaise: 1000 } }, usedUtrs: { x: {} } } };
  const weight = moneyWeight(snap);
  assert.equal(weight.balancePaise, 3500);
  assert.equal(weight.wallets, 2);
  assert.equal(weight.records, 3);
  assert.equal(identityWeight({ accounts: { a: 1 }, workspaces: { w: 1 }, sessionVault: {}, deletedAccounts: { d: 1 } }).total, 3);
});

test('safety: line — blocked hone par saaf wajah', () => {
  assert.match(describePushSafety({ blocked: { code: PUSH_BLOCK.REMOTE_UNREADABLE } }), /RUKA/);
  assert.equal(describePushSafety({}), '');
});

// ── 2. network: asli push/restore ─────────────────────────────────────────
test('backup: purana data cloud par overwrite NAHI hota jab key galat ho', async () => {
  vaultFiles.clear();
  reset();
  wipeDb();
  seedIdentities();
  const first = await backupIdentityNow({ force: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = vaultFiles.get(identityKey());
  assert.ok(before && before.includes('__vaultEnc'));

  // Key badal gayi (Render me galti se) — ab snapshot khulega nahi.
  reset('v113-key-WRONG');
  const blocked = await backupIdentityNow({ force: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.equal(vaultFiles.get(identityKey()), before, 'cloud ka purana data bilkul waisa hi hai');
  const status = identityStatus();
  assert.equal(status.pushBlocked.code, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.match(status.safetyLine, /RUKA/);
});

test('backup: local khaali hai, cloud par 2 ID — push ruka, cloud ka data waisa hi', async () => {
  reset(); // sahi key wapas
  const before = await decodeVault(vaultFiles.get(identityKey()));
  wipeDb(); // "deploy ke baad khaali db" jaisa, par key parhta hai
  clearLocalCopies();
  _resetDurabilityState();
  // Cloud se merge pehle hota hai — isliye IDS wapas aani chahiye, khaali push nahi.
  const out = await backupIdentityNow({ force: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(Object.keys(getDb().config.accounts).length, 2, 'khaali snapshot push nahi hua, IDS wapas aayi');
  const after = await decodeVault(vaultFiles.get(identityKey()));
  assert.deepEqual(Object.keys(after.accounts).sort(), Object.keys(before.accounts).sort(), 'cloud par wahi 2 ID ka data raha');
});

test('backup: cloud par extra ID ho to mila kar push hota hai (kabhi kam nahi)', async () => {
  reset();
  wipeDb();
  // Cloud me 3 ID ka snapshot rakho (jaise purane deploy ka), local me sirf 1.
  const db = getDb();
  db.config.accounts = {
    acc_1: { id: 'acc_1', name: 'Ammi', phone: '9876543210', cookies: cookie, isLoggedIn: true },
    acc_2: { id: 'acc_2', name: 'Abbu', phone: '9812345678', cookies: '_session_tid=xyz789', isLoggedIn: true },
    acc_3: { id: 'acc_3', name: 'Bhai', phone: '9700000000', cookies: '_session_tid=q', isLoggedIn: true }
  };
  saveDb(db);
  clearLocalCopies();
  await backupIdentityNow({ force: true });

  reset();
  wipeDb();
  const local = getDb();
  local.config.accounts = { acc_1: { id: 'acc_1', name: 'Ammi', phone: '9876543210', cookies: cookie, isLoggedIn: true } };
  saveDb(local);
  const out = await backupIdentityNow({ force: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(Object.keys(getDb().config.accounts).length, 3, 'cloud wali baaki ID bachi rahi');
  // Ab cloud snapshot bhi 3 ID ka hai.
  const pushed = await decodeVault(vaultFiles.get(identityKey()));
  assert.equal(Object.keys(pushed.accounts).length, 3);
});

test('backup: local khaali + cloud bhi khaali to khaali snapshot push nahi hota', async () => {
  vaultFiles.clear();
  reset();
  wipeDb();
  const out = await backupIdentityNow({ force: true });
  assert.equal(out.ok, false);
  assert.ok(out.blocked === PUSH_BLOCK.LOCAL_EMPTY || out.skipped === 'empty', JSON.stringify(out));
  assert.equal(vaultFiles.size, 0, 'cloud par kuch bhi nahi likha gaya');
});

test('backup: paisa — local wallet khaali ho to cloud ka balance bach jata hai', async () => {
  vaultFiles.clear();
  reset();
  wipeDb();
  const db = getDb();
  db.config.wallets = { boss: { userId: 'boss', balancePaise: 50000 } };
  db.config.usedUtrs = { 'utr-1': { utr: 'utr-1', amountPaise: 50000 } };
  saveDb(db);
  const first = await backupMoneyNow({ force: true });
  assert.equal(first.ok, true, JSON.stringify(first));

  // Deploy: db khaali, par local copy bhi nahi (ephemeral disk).
  reset();
  wipeDb();
  const out = await backupMoneyNow({ force: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(getDb().config.wallets.boss.balancePaise, 50000, 'cloud se paisa wapas mila');
  const pushed = await decodeVault(vaultFiles.get(moneyKey()));
  assert.equal(pushed.sections.wallets.boss.balancePaise, 50000, 'cloud par kam paisa nahi gaya');
  assert.ok(pushed.sections.usedUtrs['utr-1'], 'UTR ledger bacha');
});

test('backup: ambiguous money histories preserve both copies and block the cloud write', async () => {
  vaultFiles.clear(); reset(); wipeDb();
  let db = getDb(); db.config.wallets = { u: { userId: 'u', balancePaise: 500 } }; saveDb(db);
  assert.equal((await backupMoneyNow({ force: true })).ok, true);
  const original = vaultFiles.get(moneyKey());
  reset(); db = getDb(); db.config.wallets.u.balancePaise = 100; saveDb(db);
  const blocked = await backupMoneyNow({ force: true });
  assert.equal(blocked.blocked, PUSH_BLOCK.MONEY_CONFLICT);
  assert.equal(getDb().config.wallets.u.balancePaise, 100);
  assert.equal(vaultFiles.get(moneyKey()), original, 'remote copy was not overwritten');
});

test('backup: a debit during remote read is not overwritten by an older snapshot', async () => {
  vaultFiles.clear(); reset(); wipeDb();
  let db = getDb(); creditWallet(db, 'u', 1500, { at: 1700000000000 }); saveDb(db);
  assert.equal((await backupMoneyNow({ force: true })).ok, true);
  reset();
  let release, entered;
  const seen = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  onMoneyGet = async () => { onMoneyGet = null; entered(); await gate; };
  const pending = backupMoneyNow({ force: true });
  await seen;
  db = getDb(); debitWallet(db, 'u', 1500, { at: 1700000001000 }); saveDb(db);
  release();
  const out = await pending;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(getDb().config.wallets.u.balancePaise, 0);
  assert.equal((await decodeVault(vaultFiles.get(moneyKey()))).sections.wallets.u.balancePaise, 0);
});

test('backup: remote changing after the read is not silently overwritten', async () => {
  vaultFiles.clear(); reset(); wipeDb();
  const db = getDb(); creditWallet(db, 'u', 1500, { at: 1700000000000 }); saveDb(db);
  assert.equal((await backupMoneyNow({ force: true })).ok, true);
  reset();
  let gets = 0;
  const external = '{"externallyChanged":true}';
  onMoneyGet = async (key) => { if (++gets === 2) { vaultFiles.set(key, external); onMoneyGet = null; } };
  const out = await backupMoneyNow({ force: true });
  assert.equal(out.ok, false);
  assert.equal(vaultFiles.get(moneyKey()), external, 'concurrent remote change survived');
});

test('restore: galat key par jhootha "restore hua" nahi — asli wajah + alert', async () => {
  vaultFiles.clear();
  reset();
  wipeDb();
  seedIdentities();
  const pushed = await backupIdentityNow({ force: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  reset('v113-key-WRONG-2');
  wipeDb();
  const out = await restoreIdentityOnBoot();
  assert.equal(out.restored, false);
  assert.match(out.reason, /khul nahi raha|VAULT_ENCRYPTION_KEY/);
  const status = identityStatus();
  assert.equal(status.alerts[0].code, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.match(status.safetyLine, /VAULT_ENCRYPTION_KEY/);
  // Aur uske baad backup bhi band rahega — data mitega nahi.
  const blocked = await backupIdentityNow({ force: true });
  assert.equal(blocked.blocked, PUSH_BLOCK.REMOTE_UNREADABLE);
});

test('restore: sahi key wapas aate hi data phir se aa jata hai', async () => {
  reset();
  wipeDb();
  const out = await restoreIdentityOnBoot();
  assert.equal(out.restored, true, JSON.stringify(out));
  assert.equal(Object.keys(getDb().config.accounts).length >= 2, true);
  const ready = await backupIdentityNow({ force: true });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(identityStatus().pushBlocked, null, 'block clear ho gaya');
});

test('restore: paisa restore fail hone par bhi wajah saaf', async () => {
  reset();
  wipeDb();
  const moneyDb = getDb();
  moneyDb.config.wallets = { boss: { userId: 'boss', balancePaise: 25000 } };
  saveDb(moneyDb);
  const seeded = await backupMoneyNow({ force: true });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  reset('v113-key-WRONG-3');
  wipeDb();
  const out = await restoreMoneyOnBoot();
  assert.equal(out.restored, false);
  assert.match(out.reason, /khul nahi raha|VAULT_ENCRYPTION_KEY/);
  const d = durabilityStatus();
  assert.equal(d.pushBlocked.code, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.match(d.safetyLine, /RUKA/);
});

// ── 3. mini-app workspace: khaali blob purana data nahi mitata ───────────
const workspaceVaultKey = () => [...vaultFiles.keys()].find((k) => k.includes('/pro-workspaces/'));

test('workspace: khaali workspace cloud ka bhara hua data overwrite nahi karta', async () => {
  vaultFiles.clear();
  reset();
  resetProWorkspaceHydrationCache();
  writeProWorkspace('8001', {
    version: 1, accounts: { mine: { phone: '9111111111', name: 'Mine', isLoggedIn: true } },
    activeAccountKey: 'mine', selectedAddress: { id: 'addr-1' }, addressCandidates: [{ id: 'addr-1' }], cart: { items: [1] }
  });
  const first = await backupProWorkspaceNow('8001');
  assert.equal(first.cloud.ok, true, JSON.stringify(first));
  const file = workspaceVaultKey();
  const before = vaultFiles.get(file);
  assert.ok(before, 'workspace vault me gaya');

  // Deploy ke baad khaali workspace (sirf defaults) — purana data mita na jaye.
  resetProWorkspaceHydrationCache();
  writeProWorkspace('8001', emptyProWorkspace());
  const second = await backupProWorkspaceNow('8001');
  assert.equal(second.cloud.ok, false);
  assert.equal(second.cloud.blocked, 'LOCAL_WORKSPACE_EMPTY');
  assert.match(second.cloud.reason, /ROK/);
  assert.equal(vaultFiles.get(file), before, 'cloud par purana bhara hua workspace waisa hi hai');
  const status = proBackupStatus();
  assert.equal(status.blockedPush.reason, 'LOCAL_WORKSPACE_EMPTY');
});

test('workspace: khaali workspace db-mirror ka data bhi nahi mitata', async () => {
  resetProWorkspaceHydrationCache();
  writeProWorkspace('8002', {
    version: 1, accounts: { mine: { phone: '9222222222', name: 'Mine', isLoggedIn: true } },
    activeAccountKey: 'mine', selectedAddress: null, addressCandidates: [], cart: null
  });
  // mirror debounce 1.5s — chhoti si wait.
  await new Promise((r) => setTimeout(r, 1700));
  const mirroredRows = () => Object.keys(getDb().config.proWorkspaceMirror || {}).length;
  assert.ok(mirroredRows() >= 1, 'mirror row bani');
  const checksumBefore = Object.values(getDb().config.proWorkspaceMirror || {})
    .find((r) => String(r.userId) === '8002')?.checksum;
  assert.ok(checksumBefore, 'mirror checksum mila');
  resetProWorkspaceHydrationCache();
  writeProWorkspace('8002', emptyProWorkspace());
  await new Promise((r) => setTimeout(r, 1700));
  // Mirror row abhi bhi bhara hua hai (khaali ne overwrite nahi kiya).
  const rows = Object.values(getDb().config.proWorkspaceMirror || {});
  const forUser = rows.filter((r) => String(r.userId) === '8002');
  assert.equal(forUser.length, 1);
  // Wahi purana bhara hua envelope — khaali workspace ne overwrite nahi kiya.
  assert.equal(forUser[0].checksum, checksumBefore, 'mirror row ka data waisa hi hai');
  assert.ok(String(forUser[0].envelope).length > 40);
});

test('workspace: bhara hua data normally push hota hai (guard galat block nahi karta)', async () => {
  vaultFiles.clear();
  reset();
  resetProWorkspaceHydrationCache();
  writeProWorkspace('8003', {
    version: 1, accounts: { mine: { phone: '9333333333', name: 'Mine', isLoggedIn: true } },
    activeAccountKey: 'mine', selectedAddress: null, addressCandidates: [], cart: null
  });
  const out = await backupProWorkspaceNow('8003');
  assert.equal(out.cloud.ok, true, JSON.stringify(out));
  assert.ok(workspaceVaultKey());
});

// ── 3. API: boss ko ye sach dikhe ────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true, cookies: '_session_tid=new', liveTid: 'tid-new' }; },
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

test('api: boss panel me "backup ruka hai" aur asli wajah dikhti hai', async () => {
  reset();
  wipeDb();
  seedIdentities();
  await backupIdentityNow({ force: true });
  reset('v113-key-WRONG-4');
  const out = await req(9000, 'boss/identities', {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.backup.blocked, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.equal(out.body.identities.pushBlocked.code, PUSH_BLOCK.REMOTE_UNREADABLE);
  assert.match(out.body.identities.safetyLine, /RUKA/);
  assert.match(out.body.message, /overwrite nahi|RUKA|khul nahi/i);
  reset();
});
