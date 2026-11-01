// Boss (31-10-2026, round 26): "PHIR DEPLOY HOTE HI SAB ERASE HOGAYA"
//
// Deploy ke baad data na aane ke sirf chaar asli kaaran hote hain — aur teeno
// chupchaap fail hote the:
//   1. token hi nahi / token read-only (push kabhi nahi hua)
//   2. `bot-vault` branch hi nahi bani
//   3. vault file 1 MB se badi → GitHub contents API khaali content deta hai →
//      hum use "file nahi mili" maan lete the (restore fail + overwrite ka dar)
//   4. key badli → snapshot khulta nahi
//
// Ab doctor har kadam live check karta hai, force-restore ek button se chalta
// hai, aur bade file ka content git blob se poora aata hai.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sacha-v115-'));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'), ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:v115-offline-token', PRO_VAULT_KEY: 'v115-offline-vault-key-123456',
  PRO_VAULT_CLOUD_BACKUP: '1', DB_ASYNC_WRITE: '0', NODE_ENV: 'test',
  GITHUB_VAULT_TOKEN: 'ghp_test_token_v115', VAULT_ENCRYPTION_KEY: 'v115-key'
});

// GitHub mock — contents API, git ref, aur git blob. Badi file par contents API
// asli GitHub jaisa `content: ''`/`encoding: 'none'` deta hai.
const vaultFiles = new Map();
let putCalls = 0;
let branchExists = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (raw, options = {}) => {
  const url = String(raw);
  if (url.includes('127.0.0.1')) return realFetch(raw, options);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('raw.githubusercontent.com')) {
    const key = decodeURIComponent(url.split('/').slice(6).join('/'));
    if (!vaultFiles.has(key)) return new Response('not found', { status: 404 });
    return new Response(vaultFiles.get(key), { status: 200 });
  }
  const blobMatch = url.match(/\/git\/blobs\/([a-f0-9]+)/);
  if (url.includes('api.github.com') && blobMatch) {
    const entry = [...vaultFiles.entries()].find(([, v]) => crypto.createHash('sha1').update(`blob ${v.length}\0${v}`).digest('hex') === blobMatch[1]);
    if (!entry) return json({ message: 'Not Found' }, 404);
    return json({ content: Buffer.from(entry[1], 'utf8').toString('base64'), encoding: 'base64', size: entry[1].length });
  }
  if (url.includes('/git/ref/heads/')) {
    return branchExists ? json({ object: { sha: 'deadbeef' } }) : json({ message: 'Not Found' }, 404);
  }
  const m = url.match(/\/contents\/([^?]+)/);
  if (url.includes('api.github.com') && m) {
    const key = decodeURIComponent(m[1]);
    if (options.method === 'PUT') {
      putCalls += 1;
      const body = JSON.parse(options.body || '{}');
      vaultFiles.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
      return json({ ok: true });
    }
    if (!vaultFiles.has(key)) return json({ message: 'Not Found' }, 404);
    const text = vaultFiles.get(key);
    // 1 MB se bada = GitHub content nahi deta.
    if (text.length > 1_000_000) {
      return json({ name: key.split('/').pop(), size: text.length, encoding: 'none', content: '', sha: crypto.createHash('sha1').update(`blob ${text.length}\0${text}`).digest('hex') });
    }
    return json({ content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64', size: text.length });
  }
  if (url.includes('api.github.com')) return json({ ok: true });
  return json({ statusCode: 0 });
};

const { getDb, saveDb } = await import('./store.js');
const { runDurabilityDoctor } = await import('./durability-doctor.js');
const { backupIdentityNow, backupMoneyNow, restoreFromVaultNow, restoreIdentityOnBoot, identityStatus, _resetDurabilityState } =
  await import('./db-durability.js');
const { pullVaultTextFileDetailed } = await import('./vault-sync.js');
const { handleSwiggyProHttp } = await import('./swiggy-pro-api.js');

const cookie = '_session_tid=v115; token=tok-v115';
function wipe() {
  const db = getDb();
  db.config.accounts = {}; db.config.deletedAccounts = {}; db.config.proWorkspaceMirror = {};
  db.config.wallets = {}; db.config.usedUtrs = {}; db.config.topupRequests = {}; db.config.topupIntents = {};
  db.config.bossIds = ['9000']; db.sessionVault = {};
  saveDb(db);
  for (const file of ['db-identity-snapshot.json', 'db-money-snapshot.json']) {
    try { fs.rmSync(path.join(tmp, file), { force: true }); } catch {}
  }
}
function seed() {
  const db = getDb();
  db.config.accounts = {
    acc_1: { id: 'acc_1', name: 'Ammi', phone: '9876543210', cookies: cookie, isLoggedIn: true },
    acc_2: { id: 'acc_2', name: 'Abbu', phone: '9812345678', cookies: '_session_tid=x', isLoggedIn: true }
  };
  db.config.wallets = { u1: { userId: 'u1', balancePaise: 5000 } };
  db.config.usedUtrs = { '111222333444': { utr: '111222333444', amountPaise: 5000 } };
  saveDb(db);
}
const reset = (key = 'v115-key') => {
  process.env.VAULT_ENCRYPTION_KEY = key;
  _resetDurabilityState();
  for (const file of ['db-identity-snapshot.json', 'db-money-snapshot.json']) {
    try { fs.rmSync(path.join(tmp, file), { force: true }); } catch {}
  }
};

// ── 1. Doctor: har kadam ka asli jawab ───────────────────────────────────
test('doctor: sab theek — token, branch, dono snapshot, aur write test pass', async () => {
  vaultFiles.clear(); wipe(); seed(); reset();
  assert.equal((await backupIdentityNow({ force: true })).ok, true);
  assert.equal((await backupMoneyNow({ force: true })).ok, true);
  const doctor = await runDurabilityDoctor();
  const byKey = Object.fromEntries(doctor.steps.map((s) => [s.key, s]));
  assert.equal(byKey.disk.ok, true);
  assert.equal(byKey.token.ok, true);
  assert.match(byKey.token.detail, /fingerprint [a-f0-9]{8}/);
  assert.equal(JSON.stringify(doctor).includes('ghp_test_token_v115'), false, 'token kabhi leak nahi');
  assert.equal(byKey.repo.ok, true);
  assert.equal(byKey.branch.ok, true);
  assert.equal(byKey.identity.ok, true);
  assert.equal(byKey.money.ok, true);
  assert.equal(byKey.write.ok, true);
  assert.equal(doctor.canBackup, true);
  assert.equal(doctor.canRestore, true);
  assert.match(doctor.verdictLine, /Backup chalu hai/);
  assert.equal(vaultFiles.has('vault/doctor-heartbeat.json'), true, 'heartbeat sach me vault me gaya');
});

test('doctor: token nahi — seedha "deploy par data nahi aayega"', async () => {
  const token = process.env.GITHUB_VAULT_TOKEN;
  delete process.env.GITHUB_VAULT_TOKEN;
  try {
    const doctor = await runDurabilityDoctor({ skipWriteTest: true });
    const byKey = Object.fromEntries(doctor.steps.map((s) => [s.key, s]));
    assert.equal(byKey.token.ok, false);
    assert.match(doctor.verdictLine, /GITHUB_VAULT_TOKEN nahi/);
    assert.ok(doctor.nextStep.join(' ').includes('GITHUB_VAULT_TOKEN'));
  } finally { process.env.GITHUB_VAULT_TOKEN = token; }
});

test('doctor: cloud switch band — saaf batata hai', async () => {
  process.env.PRO_VAULT_CLOUD_BACKUP = '0';
  try {
    const doctor = await runDurabilityDoctor({ skipWriteTest: true });
    assert.match(doctor.verdictLine, /Cloud backup band/i);
  } finally { process.env.PRO_VAULT_CLOUD_BACKUP = '1'; }
});

test('doctor: branch nahi bani to wahi dikhta hai', async () => {
  branchExists = false;
  try {
    const doctor = await runDurabilityDoctor({ skipWriteTest: true });
    const branch = doctor.steps.find((s) => s.key === 'branch');
    assert.equal(branch.ok, false);
    assert.match(branch.detail, /Not Found|404/);
  } finally { branchExists = true; }
});

test('doctor: key badli — file hai par khulti nahi (asli wajah)', async () => {
  reset('v115-OTHER-key');
  const doctor = await runDurabilityDoctor({ skipWriteTest: true });
  const identity = doctor.steps.find((s) => s.key === 'identity');
  assert.equal(identity.ok, false);
  assert.match(identity.detail, /khul nahi|VAULT_ENCRYPTION_KEY/);
});

test('doctor: vault khaali — "abhi tak koi backup nahi gaya"', async () => {
  vaultFiles.clear();
  reset();
  const doctor = await runDurabilityDoctor({ skipWriteTest: true });
  assert.equal(doctor.canRestore, false);
  assert.equal(doctor.identity, null);
  assert.match(doctor.steps.find((s) => s.key === 'identity').detail, /404|nahi hai|nahi mili/);
});

// ── 2. 1 MB se bada vault file (asli GitHub behaviour) ───────────────────
test('big file: 1 MB se bada snapshot git blob se poora padha jata hai', async () => {
  vaultFiles.clear(); wipe(); seed(); reset();
  // Workspaces ko bhaari bana do taaki snapshot 1 MB cross kare.
  const db = getDb();
  db.config.proWorkspaceMirror = {};
  for (let i = 0; i < 6; i += 1) {
    db.config.proWorkspaceMirror[`row_${i}`] = {
      v: 1, userId: `user_${i}`, savedAt: new Date().toISOString(), checksum: 'x'.repeat(32),
      envelope: JSON.stringify({ version: 1, iv: 'a'.repeat(16), tag: 'b'.repeat(22), data: 'z'.repeat(200_000) })
    };
  }
  saveDb(db);
  const pushed = await backupIdentityNow({ force: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  const key = [...vaultFiles.keys()].find((k) => k.includes('db-identity-snapshot'));
  assert.ok(vaultFiles.get(key).length > 1_000_000, 'vault file 1 MB se badi hai');
  const detail = await pullVaultTextFileDetailed(key);
  assert.ok(detail.text && detail.text.length > 1_000_000, 'poora content wapas aaya');
  assert.equal(detail.via, 'blob');
  const doctor = await runDurabilityDoctor({ skipWriteTest: true });
  const identity = doctor.steps.find((s) => s.key === 'identity');
  assert.equal(identity.ok, true, identity.detail);
  assert.match(identity.detail, /6 workspace/);
});

// ── 3. Force restore (ek button) ─────────────────────────────────────────
test('restore abhi: deploy ke baad khaali db — ek call se IDs + paisa wapas', async () => {
  vaultFiles.clear(); wipe(); seed(); reset();
  await backupIdentityNow({ force: true });
  await backupMoneyNow({ force: true });
  wipe();
  _resetDurabilityState();
  assert.equal(Object.keys(getDb().config.accounts).length, 0);
  const report = await restoreFromVaultNow({ actor: 'boss:9000' });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.identity.accounts, 2, JSON.stringify(report.identity));
  assert.equal(report.identity.total, 2);
  assert.equal(Object.keys(getDb().config.accounts).length, 2);
  assert.equal(getDb().config.wallets.u1.balancePaise, 5000);
  assert.equal(identityStatus().total, 2);
});

test('restore abhi: vault khaali to jhootha "ho gaya" nahi', async () => {
  vaultFiles.clear(); wipe(); reset();
  const report = await restoreFromVaultNow();
  assert.equal(report.ok, false);
  assert.match(String(report.identity.reason || report.money.reason || ''), /nahi/);
});

test('restore abhi: key galat ho to restore nahi, wajah saaf', async () => {
  vaultFiles.clear(); wipe(); seed(); reset();
  await backupIdentityNow({ force: true });
  wipe();
  reset('WRONG-KEY-v115');
  const report = await restoreFromVaultNow();
  assert.equal(report.ok, false);
  assert.match(String(report.identity.reason || ''), /khul nahi|VAULT_ENCRYPTION_KEY/);
  assert.equal(Object.keys(getDb().config.accounts).length, 0, 'kuch bhi jhootha restore nahi hua');
});

// ── 4. API: boss panel se jaanch + restore ───────────────────────────────
const server = http.createServer(async (req, res) => {
  const provider = {
    async verifySession() { return { valid: true }; },
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise((r) => server.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

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

test('api: boss ko doctor ka poora sach, user ko 403', async () => {
  vaultFiles.clear(); wipe(); seed(); reset();
  await backupIdentityNow({ force: true });
  const boss = await req(9000, 'boss/durability');
  assert.equal(boss.status, 200, JSON.stringify(boss.body));
  assert.ok(Array.isArray(boss.body.doctor.steps));
  assert.equal(boss.body.doctor.canRestore, true);
  assert.ok(boss.body.doctor.steps.some((s) => s.key === 'write' && s.ok === true));
  const user = await req(7101, 'boss/durability');
  assert.equal(user.status, 403);
});

test('api: deploy ke baad "Vault se abhi restore" button asli kaam karta hai', async () => {
  vaultFiles.clear(); wipe(); seed(); reset();
  await backupIdentityNow({ force: true });
  await backupMoneyNow({ force: true });
  wipe();
  const out = await req(9000, 'boss/durability/restore', {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.identities.total, 2);
  assert.match(out.body.message, /wapas aa gaya/);
  assert.equal(Object.keys(getDb().config.accounts).length, 2);
  const user = await req(7101, 'boss/durability/restore', {});
  assert.equal(user.status, 403);
});

test('api: vault khaali ho to restore ka jawab jhootha nahi', async () => {
  vaultFiles.clear(); wipe(); reset();
  const out = await req(9000, 'boss/durability/restore', {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, false);
  assert.match(out.body.message, /nahi mila|nahi/i);
});
