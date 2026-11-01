// ============================================================================
// V34 — WAF token pool + circuit breaker (22-10-2026, "waf pura hatado"):
//  1. Shared `aws-waf-token` pool: seed/validate, one token serves ALL accounts.
//  2. Circuit breaker: escalating cooldown 3 → 5 → 10 min on repeated hits,
//     with burst-debounce (one scan's 29×403 = ONE incident).
//  3. Cooldown state survives restart (db.waf) + Cloud Vault snapshot v16
//     carries the token so fresh deploys start WARM.
//  4. ensureOrderTracking short-circuits with WAF_COOLDOWN (no network) while
//     the breaker is open — scans stop instead of hammering Swiggy.
// ============================================================================
import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import * as wafPool from './waf-pool.js';
import { getDb, saveDb, buildCloudVaultSnapshot } from './store.js';
import { ensureOrderTracking } from './order-tracking.js';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${label}`); }
  catch (err) { failed += 1; console.log(`❌ ${label}\n   ↳ ${err.message}`); }
}

const FAKE_TOKEN_A = 'A'.repeat(120);
const FAKE_TOKEN_B = 'B'.repeat(120);
const REAL_NOW = Date.now;
let fakeNow = 0;
function withFakeClock(fn) {
  fakeNow = REAL_NOW();
  const realNow = Date.now;
  Date.now = () => fakeNow;
  const restore = () => { Date.now = realNow; };
  return Promise.resolve(fn()).then(restore, err => { restore(); throw err; });
}
function advance(ms) { fakeNow += ms; }

// Snapshot/restore db.waf + any temp order so the repo's db.json stays clean.
const dbBackup = (() => {
  const db = getDb();
  return {
    hadWaf: Object.prototype.hasOwnProperty.call(db, 'waf'),
    waf: db.waf ? JSON.parse(JSON.stringify(db.waf)) : undefined,
    tempOrderId: 'V34WAFTEST',
    hadTemp: Boolean(db.orders?.['V34WAFTEST'])
  };
})();

try {
  await check('seedToken rejects short junk, accepts a real-length token', () => {
    assert.strictEqual(wafPool.seedToken('short'), false, 'short token must be rejected');
    assert.strictEqual(wafPool.seedToken(FAKE_TOKEN_A, { source: 'manual' }), true);
    assert.strictEqual(wafPool.getTokenSync(), FAKE_TOKEN_A);
  });

  await withFakeClock(async () => {
    await check('1st WAF hit → 3-min cooldown', () => {
      wafPool.clearCooldown();
      wafPool.markWafHit();
      const cd = wafPool.cooldownRemainingMs();
      assert.ok(cd > 175_000 && cd <= 180_000, `expected ~3min, got ${cd}ms`);
    });

    await check('2nd hit 30s later (same scan burst) → still ONE incident (no escalation)', () => {
      advance(30_000);
      wafPool.markWafHit();
      const cd = wafPool.cooldownRemainingMs();
      assert.ok(cd > 140_000 && cd <= 180_000, `debounced hit must keep ~3min window, got ${cd}ms`);
    });

    await check('3rd hit 200s later (fresh burst) → escalates to 5 min', () => {
      advance(200_000);
      wafPool.markWafHit();
      const cd = wafPool.cooldownRemainingMs();
      assert.ok(cd > 295_000 && cd <= 300_000, `expected ~5min, got ${cd}ms`);
    });

    await check('4th hit → escalates to 10 min (and caps there)', () => {
      advance(200_000);
      wafPool.markWafHit();
      let cd = wafPool.cooldownRemainingMs();
      assert.ok(cd > 595_000 && cd <= 600_000, `expected ~10min, got ${cd}ms`);
      advance(200_000);
      wafPool.markWafHit();
      cd = wafPool.cooldownRemainingMs();
      assert.ok(cd > 595_000 && cd <= 600_000, `must cap at 10min, got ${cd}ms`);
    });

    await check('clearCooldown closes the circuit', () => {
      wafPool.clearCooldown();
      assert.strictEqual(wafPool.cooldownRemainingMs(), 0);
    });
  });

  await check('cooldown + token persist to db.waf and loadFromDb restores them', () => {
    const db = getDb();
    db.waf = {
      token: FAKE_TOKEN_B,
      acquiredAt: REAL_NOW(),
      source: 'vault',
      cooldownUntil: REAL_NOW() + 300_000,
      hitStreak: 2,
      windowStart: REAL_NOW()
    };
    saveDb(db);
    // Re-load from disk into a fresh pool state.
    wafPool.loadFromDb();
    assert.strictEqual(wafPool.getTokenSync(), FAKE_TOKEN_B, 'token restored from db');
    const cd = wafPool.cooldownRemainingMs();
    assert.ok(cd > 290_000 && cd <= 300_000, `cooldown restored, got ${cd}ms`);
    wafPool.clearCooldown();
  });

  await check('Cloud Vault snapshot v16 carries the shared WAF token (warm deploy)', () => {
    const db = getDb();
    db.waf = { token: FAKE_TOKEN_A, acquiredAt: REAL_NOW(), source: 'chromium' };
    saveDb(db);
    const snap = buildCloudVaultSnapshot(getDb());
    assert.strictEqual(snap.version, 16, 'snapshot version bumped to 16');
    assert.strictEqual(snap.waf?.token, FAKE_TOKEN_A, 'waf token in snapshot');
    assert.strictEqual(snap.waf?.source, 'chromium');
  });

  await check('snapshot has waf:null when no token is stored', () => {
    const db = getDb();
    delete db.waf;
    saveDb(db);
    const snap = buildCloudVaultSnapshot(getDb());
    assert.strictEqual(snap.waf, null, 'waf must be null without a token');
  });

  await check('ensureOrderTracking → WAF_COOLDOWN (no network) while breaker is open', async () => {
    const db = getDb();
    if (!db.orders) db.orders = {};
    db.orders[dbBackup.tempOrderId] = {
      id: dbBackup.tempOrderId,
      swiggyOrderId: '259999999999999',
      status: 'PAID_CONFIRMED',
      createdAt: new Date().toISOString()
    };
    saveDb(db);
    wafPool.clearCooldown();
    wafPool.markWafHit(); // 3-min cooldown
    const t0 = REAL_NOW();
    const result = await ensureOrderTracking(db.orders[dbBackup.tempOrderId], { force: true });
    const elapsed = REAL_NOW() - t0;
    assert.strictEqual(result.status, 'WAF_COOLDOWN', `status must be WAF_COOLDOWN, got ${result.status}`);
    assert.strictEqual(result.hasOrder, false);
    assert.ok(result.cooldownMs > 0, 'cooldownMs must be reported');
    assert.ok(elapsed < 5000, `must short-circuit fast, took ${elapsed}ms`);
  });
} finally {
  // Restore db.json exactly as it was before this test.
  const db = getDb();
  if (dbBackup.hadWaf) db.waf = dbBackup.waf;
  else delete db.waf;
  if (!dbBackup.hadTemp) delete db.orders?.[dbBackup.tempOrderId];
  saveDb(db);
  wafPool.clearCooldown();
}

console.log(`\n${failed === 0 ? '🎉' : '⚠️'} v34: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
