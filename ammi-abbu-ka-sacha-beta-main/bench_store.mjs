/**
 * bench_store.mjs — "10 ORDER KE BAAD HAWA KYUN NIKAL RAHI THI" ka naapa hua sach.
 *
 * Chalane ka tarika:
 *   node bench_store.mjs                 (naya fast store)
 *   DB_FAST=0 node bench_store.mjs       (purana behaviour simulate: har getDb par
 *                                          disk read + har save par disk re-read)
 *
 * Kya naapte hain:
 *   1. 40 orders + 19 IDs wala realistic DB (cookies ke saath) — ~asli size.
 *   2. 400 x getDb() (ek update me itni baar hota hai)
 *   3. 80 x saveDb() (bill/QR/tracking updates)
 *   4. Peak latency (event loop kitni der block hua) — yahi "system hang" hai.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-store-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = path.join(tmpDir, 'db.json');
process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:BENCH';
const FAST = process.env.DB_FAST !== '0';

// LEGACY mode = merge hone se PEHLE ka asli store.js (git se nikala jata hai),
// taaki comparison imaandaar rahe (simulate nahi, actual purana code).
let store;
if (FAST) {
  store = await import('./store.js');
} else {
  const { execSync } = await import('node:child_process');
  const base = process.env.BENCH_LEGACY_REF || 'origin/main';
  const legacyPath = new URL('./.bench_legacy_store.mjs', import.meta.url);
  const src = execSync(`git show ${base}:store.js`, { encoding: 'utf8' });
  fs.writeFileSync(legacyPath, src, 'utf8');
  store = await import(legacyPath.href);
  process.on('exit', () => { try { fs.unlinkSync(legacyPath); } catch {} });
}

// ── realistic DB banao ───────────────────────────────────────────────────────
const accounts = {};
for (let i = 0; i < 19; i++) {
  accounts[`acc_90000000${String(i).padStart(2, '0')}`] = {
    id: `acc_90000000${String(i).padStart(2, '0')}`,
    phone: `90000000${String(i).padStart(2, '0')}`,
    name: `ID ${i}`,
    isLoggedIn: true,
    cookies: `_session_tid=${'a'.repeat(1400)}; tid=${'b'.repeat(300)}; _sid=${'c'.repeat(120)}`,
    tid: 'x'.repeat(900),
    token: 'y'.repeat(700),
    savedAt: '2026-10-26T00:00:00.000Z'
  };
}
const orders = {};
const ORDER_COUNT = Number(process.env.BENCH_ORDERS) || 40;
for (let i = 0; i < ORDER_COUNT; i++) {
  orders[`ORD${1000 + i}`] = {
    id: `ORD${1000 + i}`,
    userId: 6400000 + i,
    status: 'ACCEPTED',
    cardStage: 'QR_GENERATED',
    restaurantName: 'Pizza Hut',
    items: Array.from({ length: 10 }, (_, j) => ({ name: `Item ${j}`, qty: 1, price: 120, id: `i${j}` })),
    finalPayable: 420 + i,
    selectedAccount: Object.keys(accounts)[i % 19],
    addressDetails: { name: 'Sneha', mobile: '9109533577', address: '350, MIG 2, New Subhash Nagar', lat: '26.9', lng: '82.1' },
    bossMessageIds: { 6484999726: 900 + i },
    pendingSwiggyUpiUri: `upi://pay?pa=upiswiggy@icici&pn=SWIGGY&am=${420 + i}.00&cu=INR&tr=TXN${i}`,
    pendingSwiggyOrderId: `25990000${i}`,
    createdAt: new Date(Date.now() - i * 3_600_000).toISOString()
  };
}
const seed = {
  config: {
    totalSlots: 9,
    slotsLeft: 5,
    bossIds: [6484999726],
    bossUpiId: '',
    familyMembers: {},
    accounts,
    deletedAccounts: {},
    accountHealthEvents: Array.from({ length: 50 }, (_, i) => ({ at: new Date().toISOString(), type: 'HEALTHY', key: `acc_${i}` }))
  },
  sessionVault: {},
  orders,
  drafts: { 6400001: { cart: 'https://swig.gy/gc/1/x', updatedAt: new Date().toISOString() } },
  bossState: null,
  userStates: { 6400001: { step: 'WAIT_CART' } }
};
fs.writeFileSync(process.env.DB_FILE, JSON.stringify(seed, null, 2));
const dbSizeKb = Math.round(fs.statSync(process.env.DB_FILE).size / 1024);

const getDb = store.getDb;
const saveDb = store.saveDb;

// ── workload ────────────────────────────────────────────────────────────────
const GETS = Number(process.env.BENCH_GETS) || 400;
const SAVES = Number(process.env.BENCH_SAVES) || 80;

function measure(label, fn) {
  const t = process.hrtime.bigint();
  fn();
  return { label, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

const getRun = measure('gets', () => {
  for (let i = 0; i < GETS; i++) {
    const db = getDb();
    void db.orders[`ORD${1000 + (i % 40)}`]?.finalPayable;
  }
});

const saveRun = measure('saves', () => {
  for (let i = 0; i < SAVES; i++) {
    const db = getDb();
    const id = `ORD${1000 + (i % 40)}`;
    if (db.orders[id]) {
      db.orders[id].finalPayable = 421 + i;
      db.orders[id].lastCheckedAt = new Date().toISOString();
    }
    saveDb(db);
  }
});

// ek "update" = 40 getDb + 8 save (Boss ke asli flow ka realistic mix)
const updateRun = measure('one-update', () => {
  for (let i = 0; i < 40; i++) getDb();
  for (let i = 0; i < 8; i++) {
    const db = getDb();
    const id = `ORD${1000 + (i % 40)}`;
    if (db.orders[id]) db.orders[id].cardStage = i % 2 ? 'QR_GENERATED' : 'BILL_READY';
    saveDb(db);
  }
});

if (FAST) store.flushDbSync?.();

const stats = FAST ? store.getDbIoStats() : null;
const row = (r, per) => `${r.label.padEnd(12)} ${r.ms.toFixed(1).padStart(8)} ms  ${per ? `(${(r.ms / per).toFixed(2)} ms/op)` : ''}`;

console.log(`\n════════ STORE BENCHMARK (${FAST ? 'FAST' : 'LEGACY'}) ════════`);
console.log(`db.json: ${dbSizeKb} KB · ${ORDER_COUNT} orders · 19 IDs · ${GETS} gets · ${SAVES} saves`);
console.log(row(getRun, GETS));
console.log(row(saveRun, SAVES));
console.log(row(updateRun, 1));
if (stats) {
  console.log(`disk reads: ${stats.diskReads} · parses: ${stats.parses} · merges: ${stats.merges} · writes: ${stats.writes}`);
  console.log(`avg getDb: ${stats.avgGetMs} ms · async write: ${stats.asyncWrite}`);
}

const out = {
  mode: FAST ? 'fast' : 'legacy',
  dbSizeKb,
  gets: { totalMs: Math.round(getRun.ms), perOpMs: Math.round((getRun.ms / GETS) * 100) / 100 },
  saves: { totalMs: Math.round(saveRun.ms), perOpMs: Math.round((saveRun.ms / SAVES) * 100) / 100 },
  oneUpdateMs: Math.round(updateRun.ms)
};
fs.writeFileSync(path.join(os.tmpdir(), `bench-store-${out.mode}.json`), JSON.stringify(out, null, 2));
console.log(`\nJSON: ${path.join(os.tmpdir(), `bench-store-${out.mode}.json`)}`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
