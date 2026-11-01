// ============================================================================
// V33 — WAF-incident hardening (order 251633571101579 / #FWD9154, 22-10-2026):
//  1. Majority account failures render as "Swiggy rate-limit/WAF" (retry
//     later) — NOT "session expired, re-login everything".
//  2. Auto-retry cadence is WAF-friendly (no 10s/30s/60s burst).
//  3. Orders persist through the cloud vault → deploy/restart no longer wipes
//     order history (Export & Logout eligibility + tracking resume survive).
// ============================================================================
import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import { scanFailuresLine } from './scan-diagnostics.js';
import { DEFAULT_AUTO_DELAYS } from './order-tracking.js';
import { getDb, saveDb, buildCloudVaultSnapshot, hydrateAccountsFromCloudVault } from './store.js';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${label}`); }
  catch (err) { failed += 1; console.log(`❌ ${label}\n   ↳ ${err.message}`); }
}

const realFetch = globalThis.fetch;

function makeFailure(phone, reason, detail) {
  return { key: `acc_${phone}`, phone, name: 'T', reason, detail };
}
const ALL_FAIL = Array.from({ length: 29 }, (_, i) =>
  makeFailure(String(9000000000 + i), i % 2 ? 'AUTH_FAILED' : 'SESSION_EXPIRED', 'WAF challenge page returned (403)')
);

const envBackup = { GITHUB_VAULT_TOKEN: process.env.GITHUB_VAULT_TOKEN };
try {
  await check('Majority failures (29/29, WAF hints) → rate-limit label, NO mass re-login advice', () => {
    const html = scanFailuresLine({ status: 'NOT_FOUND', okScanned: 0, accountsTotal: 29, failures: ALL_FAIL });
    assert.ok(/rate-limit\/WAF/.test(html), `must say rate-limit/WAF: ${html}`);
    assert.ok(/10–15 min/.test(html), 'must say wait 10-15 min');
    assert.ok(!/dubara login karke retry/.test(html), 'must NOT tell boss to re-login everything');
    assert.ok(html.includes('9000000000'), 'first failed account still listed for the record');
  });

  await check('1–2 isolated failures → normal per-account re-login advice (unchanged)', () => {
    const html = scanFailuresLine({ status: 'NOT_FOUND', okScanned: 27, accountsTotal: 29, failures: [makeFailure('8000958285', 'SESSION_EXPIRED', 'Please login again')] });
    assert.ok(/dobara login karke retry/.test(html), `isolated failure keeps re-login advice: ${html}`);
    assert.ok(!/rate-limit\/WAF/.test(html), 'no WAF label for isolated failures');
  });

  await check('WAF hint in details (even 3/29) → rate-limit label kicks in', () => {
    const fails = [
      makeFailure('1111111111', 'AUTH_FAILED', 'HTTP 403'),
      makeFailure('2222222222', 'SESSION_EXPIRED', 'WAF challenge'),
      makeFailure('3333333333', 'AUTH_FAILED', 'cf-Blocked')
    ];
    const html = scanFailuresLine({ status: 'NOT_FOUND', okScanned: 26, accountsTotal: 29, failures: fails });
    assert.ok(/rate-limit\/WAF/.test(html), `WAF pattern detected: ${html}`);
  });

  await check('TIMEOUT partial coverage → "Scan incomplete" line (from v31 behaviour still intact)', () => {
    const html = scanFailuresLine({ status: 'TIMEOUT', okScanned: 8, accountsTotal: 27, failures: [] });
    assert.ok(/Scan incomplete/.test(html) && html.includes('8/27'), html);
  });

  await check('Auto-retry cadence: first two quick (≤30s), then gaps ≥ 3 min (WAF-friendly)', () => {
    assert.ok(Array.isArray(DEFAULT_AUTO_DELAYS) && DEFAULT_AUTO_DELAYS.length >= 6, 'delays exported');
    assert.ok(DEFAULT_AUTO_DELAYS[0] === 0, 'first try immediate');
    assert.ok(DEFAULT_AUTO_DELAYS[1] <= 30_000, 'second try within 30s');
    for (let i = 2; i < DEFAULT_AUTO_DELAYS.length; i++) {
      const gap = DEFAULT_AUTO_DELAYS[i] - DEFAULT_AUTO_DELAYS[i - 1];
      assert.ok(gap >= 120_000, `gap[${i}] = ${gap}ms must be ≥120s (no bursts)`);
    }
    // Whole schedule must not exceed ~45 min
    assert.ok(DEFAULT_AUTO_DELAYS[DEFAULT_AUTO_DELAYS.length - 1] <= 45 * 60_000);
  });

  // ── Order persistence through the cloud vault ─────────────────────────────
  const rawDbDisk = fs.existsSync('data/db.json') ? fs.readFileSync('data/db.json', 'utf8') : null;
  const dbBackup = JSON.parse(JSON.stringify(getDb()));

  function installVaultFetch(vaultObj) {
    const b64 = Buffer.from(JSON.stringify(vaultObj), 'utf8').toString('base64');
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/contents/vault/accounts-vault.json')) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ sha: 's', content: b64, encoding: 'base64', size: b64.length }),
          text: async () => JSON.stringify({})
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    };
  }

  await check('buildCloudVaultSnapshot includes orders (deploy-proof persistence)', () => {
    const db = getDb();
    db.orders.V33_PERSIST = { id: 'V33_PERSIST', swiggyOrderId: '251633571101579', status: 'COMPLETED', trackingLink: 'http://r.swiggy.com/x', selectedAccount: 'acc_1' };
    saveDb(db);
    const snap = buildCloudVaultSnapshot();
    assert.ok(snap.orders && snap.orders.V33_PERSIST, 'orders key present in snapshot');
    assert.strictEqual(snap.orders.V33_PERSIST.swiggyOrderId, '251633571101579');
  });

  await check('Hydrate restores missing orders + merges missing fields (local wins)', async () => {
    process.env.GITHUB_VAULT_TOKEN = 'ghp_v33_test_token';
    const remoteOrders = {
      V33_RESTORE: { id: 'V33_RESTORE', swiggyOrderId: '259999999999001', status: 'COMPLETED', deliveryOtp: '4821', selectedAccount: 'acc_9' },
      V33_MERGE: { id: 'V33_MERGE', swiggyOrderId: '259999999999002', status: 'COMPLETED', deliveryOtp: '9999' }
    };
    installVaultFetch({ accounts: {}, deletedAccounts: {}, sessionVault: {}, orders: remoteOrders });

    const db = getDb();
    delete db.orders.V33_RESTORE;
    db.orders.V33_MERGE = { id: 'V33_MERGE', status: 'COMPLETED', trackingLink: 'http://local-wins.example' }; // local copy without OTP
    saveDb(db);

    await hydrateAccountsFromCloudVault();
    const after = getDb().orders;
    assert.ok(after.V33_RESTORE, 'missing order restored from vault');
    assert.strictEqual(after.V33_RESTORE.deliveryOtp, '4821');
    assert.strictEqual(after.V33_MERGE.trackingLink, 'http://local-wins.example', 'local tracking link NOT overwritten');
    assert.strictEqual(after.V33_MERGE.deliveryOtp, '9999', 'missing field merged from remote');
  });
} finally {
  globalThis.fetch = realFetch;
  if (envBackup.GITHUB_VAULT_TOKEN === undefined) delete process.env.GITHUB_VAULT_TOKEN;
  else process.env.GITHUB_VAULT_TOKEN = envBackup.GITHUB_VAULT_TOKEN;
  try {
    if (rawDbDisk !== null) fs.writeFileSync('data/db.json', rawDbDisk, 'utf8');
    saveDb(JSON.parse(JSON.stringify(dbBackup)));
  } catch {}
}

console.log(`\n================================================================\n📊 V33 RESULT: ${passed}/${passed + failed} WAF-incident-hardening checks passed${failed ? ` — ${failed} FAILED` : ''}\n================================================================`);
process.exit(failed ? 1 : 0);
