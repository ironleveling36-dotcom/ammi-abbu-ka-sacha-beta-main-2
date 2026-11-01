// test_v84_maintenance_and_zero_order_scan.mjs
// Boss (30-10-2026): "bot ko maintenance kar jaldi se hang hogaya hai and order
// par wo id jispar 0 order hai usko scan nahi kar paa rha".
//
// Do bug, do fix — dono is guard me lock hote hain:
//
// A) HANG
//   1. Har Swiggy ID lock ka `since` timestamp track hota hai.
//   2. `releaseStaleAccountLocks()` sirf age dekhkar active lock release nahi
//      karta; isse placement ke dauran doosra cart mutation race nahi karta.
//   3. `releaseStaleReservations()` 90s+ purani reservations free karta hai.
//   4. `resetStuckScans()` phansi tracking scans hata deta hai.
//   5. Maintenance loop khud chalta hai + boss ko batata hai.
//   6. Boss panel me "🩺 Maintenance" button + /maintenance command hai.
//
// B) 0-ORDER ID SCAN
//   7. Scan ko sirf SESSION chahiye — `isLoggedIn` flag missing ho to bhi ID
//      scan hoti hai (pehle `NOT_LOGGED_IN` bol kar skip ho jati thi).
//   8. Auth fail par ek refresh + web-session bootstrap try hota hai.
//   9. Fail bhi ho jaye to "expired" ka jhooth nahi — `SCAN_SOFT_FAILED`
//      (retryable, ID zinda hai).
//  10. Soft-fail IDs ek baar dobara scan hoti hain (max 3) — fresh 0-order ID
//      chup-chaap pool se bahar nahi hoti.

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-MAINT';
process.env.NODE_ENV = 'test';

import fs from 'node:fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' });

const maint = await import('./bot-maintenance.js');
const cart = await import('./swiggy-cart.js');
const tracking = await import('./order-tracking.js');

// ── A) Maintenance module ─────────────────────────────────────────────────
{
  check('health snapshot milta hai', typeof maint.getMaintenanceSnapshot === 'function');
  const snap = maint.getMaintenanceSnapshot();
  check('snapshot me lag/RAM/uptime hai', Number.isFinite(snap.lagMs) && Number.isFinite(snap.memoryMb) && Number.isFinite(snap.uptimeSec));
  check('lag probe chalu hai (0 ya zyada)', snap.lagMs >= 0);

  const done = maint.startJob('QR_GENERATE', { timeoutMs: 120, orderId: 'O1' });
  await new Promise((r) => setTimeout(r, 260));
  const stuck = maint.listStuckJobs();
  check('atka hua job detect hota hai', stuck.some((j) => j.key === 'QR_GENERATE#O1'), JSON.stringify(stuck));
  done();
  check('job khatam hone par list se hatta hai', maint.listStuckJobs().length === 0);

  const card = maint.formatMaintenanceCard(snap);
  check('maintenance card Hinglish me hai', /BOT MAINTENANCE/.test(card) && /Lag:/.test(card) && /Uptime/.test(card));
  check('card atke kaam dikhata hai', /Atke kaam:/.test(card));
}

// ── A) Lock timestamps + stale release ────────────────────────────────────
{
  const acc = { id: 'acc_lock_test', phone: '9800000001', cookies: 'x=1', tid: 'a.b.c' };
  let release;
  const held = cart.withSwiggyAccountLock(acc, () => new Promise((r) => { release = r; }), { maxWaitMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  const stats = cart.getAccountLockStats();
  check('lock stats me ID hai', stats.locks.some((l) => l.id === 'acc_lock_test'), JSON.stringify(stats));
  const fresh = await cart.releaseStaleAccountLocks({ olderThanMs: 60_000 });
  check('naya lock chhoda nahi jata (kaam kar raha hai)', fresh.released.length === 0 && fresh.kept >= 1, JSON.stringify(fresh));
  await new Promise((r) => setTimeout(r, 1200));
  const stale = await cart.releaseStaleAccountLocks({ olderThanMs: 1000 });
  check('purana lekin active lock zabardasti nahi chhoda jata', stale.released.length === 0 && stale.kept >= 1, JSON.stringify(stale));
  release?.();
  await held.catch(() => {});
  check('job ke khatam hone par lock khud release ho gaya', !cart.getAccountLockStats().locks.some(l => l.id === 'acc_lock_test'));
}

// ── A) Stale reservations ─────────────────────────────────────────────────
{
  const stats = cart.getReservationStats();
  check('reservation stats milta hai', typeof stats.count === 'number');
  const out = cart.releaseStaleReservations({ olderThanMs: 15_000 });
  check('reservation release ka jawab sach me hai', Array.isArray(out.released));
}

// ── A) Stuck tracking scans ───────────────────────────────────────────────
{
  check('resetStuckScans exported hai', typeof tracking.resetStuckScans === 'function');
  const out = tracking.resetStuckScans({ olderThanMs: 10_000 });
  check('scan reset report deta hai', typeof out.reset === 'number');
  check('inflight scan count milta hai', typeof tracking.getInflightScanCount() === 'number');
}

// ── A) Wiring: boss command + panel button + auto loop ────────────────────
{
  const iSrc = fs.readFileSync('./index.js', 'utf8');
  check('/maintenance command hai', /bot\.command\(\['maintenance', 'maintain', 'heal'\]/.test(iSrc));
  check('boss_maintenance button handler hai', /bot\.action\('boss_maintenance'/.test(iSrc));
  check('auto maintenance loop boot par start hota hai', /startMaintenanceLoop\(\{ cart, tracking, db: getDb, saveDb \}/.test(iSrc));
  const pSrc = fs.readFileSync('./boss-panel.js', 'utf8');
  check('boss panel me 🩺 Maintenance button hai', /🩺 Maintenance/.test(pSrc) && /callback_data: 'boss_maintenance'/.test(pSrc));
}

// ── B) 0-order ID scan (login flag ki dependency hatai gayi) ──────────────
{
  const src = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('scan session-material se chalta hai, isLoggedIn flag se nahi', /const hasSessionMaterial = Boolean\(acc\?\.cookies \|\| acc\?\.tid/.test(src));
  check('isLoggedIn=false ho par session ho to self-heal', /acc\.isLoggedIn !== true && !acc\.hardLoggedOut/.test(src));
  check('auth fail par refresh retry hota hai', /const retryAuth = await getSwiggySessionAuth\(acc, true\)/.test(src));
  check('auth fail par web-session bootstrap try hota hai', /bootstrapSwiggyWebSessionFromAndroidTokens\(acc, \{ force: true \}\)/.test(src));
  check('soft fail alag se mark hota hai (jhootha expired nahi)', /softFail: !auth\?\.sessionExpired/.test(src));
  check('SCAN_SOFT_FAILED honest error hai', /code: 'SCAN_SOFT_FAILED'/.test(src));
  check('soft-fail IDs dobara scan hoti hain (max 3)', /slice\(0, 3\)/.test(src) && /retriedAfterSoftFail/.test(src));
}

// ── B) Live behaviour: 0-order ID jiska `isLoggedIn` flag missing hai ─────
{
  globalThis.fetch = realFetch;
  const acc = {
    phone: '9800000123',
    cookies: '_session_tid=abc;',
    tid: 'h.p.s',
    // isLoggedIn jaan-boojh kar missing — purane imports me aisa hi hota tha
    totalOrdersCount: 0,
    ordersVerifiedLive: true,
    cachedTotalOrdersCount: 0
  };
  const profile = await cart.inspectAccountOrderHistoryAndOffers('acc_zero_test', acc, { force: false }).catch((e) => ({ error: String(e?.message || e) }));
  check('0-order ID scan hoti hai (NOT_LOGGED_IN nahi)', profile?.valid === true, JSON.stringify(profile));
  check('0-order ID ka count 0 hi rehta hai', Number(profile?.totalOrdersCount) === 0, String(profile?.totalOrdersCount));
  check('0-order badge bana', profile?.isZeroOrderAccount === true);
  check('flag self-heal hua', acc.isLoggedIn === true);
}

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} v84 maintenance + 0-order scan: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
