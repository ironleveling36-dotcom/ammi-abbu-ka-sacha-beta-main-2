/**
 * v71 — EK ORDER = EK ID (zero-order), deliver/cancel tak Abbu ko bhi nahi
 *
 * Boss (29-10-2026):
 *   "abbu ammi ne link bheja, address fetch + cart fetched. Ab jo ID zero order
 *    wali hogi uska JSON Ammi ke phone se login hoga → bill → QR → link →
 *    updates. After deliver **ya cancel** account wapas mere vault me aaye —
 *    tab tak wo Abbu ko bhi assign na ho. After deliver auto export mujhe aur
 *    Ammi ke phone se logout."
 *
 * Yeh test (offline) proves:
 *   1. Lock durable hai (`acc.orderLock`) — 90s / 20min wali purani window nahi.
 *   2. Locked ID doosre order ko NAHI milti (selection/busy map + rotation BUSY).
 *   3. Bill ready hote hi lock + wahi ID customer (Ammi) ke phone par handover.
 *   4. Delivered → lock free + auto export (JSON boss ko) + logout (phone se).
 *   5. Cancel → lock free; export/logout sirf tab jab Swiggy par place ho chuka
 *      tha ya ID phone par gayi thi (warna zinda session ko maarna galat).
 *   6. Sweep: bot restart / missed callback ke baad bhi terminal orders ke locks
 *      chhoot jate hain; 6h TTL safety.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

const DB_PATH = 'data/db.json';
const MIRROR = 'accounts.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const mirrorSnapshot = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR, 'utf8') : null;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const lock = await import('./order-account-lock.js');
const cart = await import('./swiggy-cart.js');
const views = await import('./account-views.js');
const delivery = await import('./delivery-release.js');

const indexSrc = fs.readFileSync('./index.js', 'utf8');
const fwdSrc = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');

const AMMI = 'acc_9876500123';
const ABBU = 'acc_9876500456';

function makeDb(nowMs = Date.now()) {
  return {
    config: {
      accounts: {
        [AMMI]: {
          name: 'Ammi', phone: '9876500123', token: 'tok_ammi', tid: 'a.b.c',
          cookies: 'tid=a.b.c', isLoggedIn: true, isZeroOrderAccount: true, totalOrdersCount: 0
        },
        [ABBU]: {
          name: 'Abbu', phone: '9876500456', token: 'tok_abbu', tid: 'a.b.c',
          cookies: 'tid=a.b.c', isLoggedIn: true, isZeroOrderAccount: true, totalOrdersCount: 0
        }
      },
      bossIds: ['111'],
      activeOrderAccount: AMMI
    },
    orders: {
      ord_ammi: {
        id: 'ord_ammi', userId: 222, userName: 'Ammi', status: 'APPROVAL_PENDING',
        cardStage: 'BILL_READY', selectedAccount: AMMI, orderAccount: '9876500123',
        createdAt: new Date(nowMs).toISOString()
      },
      ord_abbu: {
        id: 'ord_abbu', userId: 333, userName: 'Abbu', status: 'PENDING',
        cardStage: 'AUTO_SELECTING', createdAt: new Date(nowMs).toISOString()
      }
    }
  };
}

console.log('\n=== 1. Lock: ek order = ek ID, disk par durable ===');
{
  const db = makeDb();
  const res = lock.lockAccountToOrder(db, AMMI, db.orders.ord_ammi, { phone: '9876500123' });
  check('lock bana', res?.lock?.orderId === 'ord_ammi' && res.conflict === false, JSON.stringify(res));
  check('account par orderLock likha', db.config.accounts[AMMI].orderLock?.orderId === 'ord_ammi');
  check('holder = Ammi (order se)', db.config.accounts[AMMI].orderLock.holder === 'Ammi');
  check('order par lockedAccount', db.orders.ord_ammi.lockedAccount === AMMI && Boolean(db.orders.ord_ammi.accountLockedAt));
  check('TTL 6h hai (20 min / 90s nahi)', lock.ACCOUNT_LOCK_TTL_MS === 6 * 60 * 60 * 1000);

  // Doosre order ke liye locked?
  const other = lock.isAccountLockedForOtherOrder(db, AMMI, 'ord_abbu');
  check('Abbu ko na mile (locked)', other.locked === true && other.orderId === 'ord_ammi');
  check('holder + age report hoti hai', other.holder === 'Ammi' && Number.isFinite(other.ageMs));
  const own = lock.isAccountLockedForOtherOrder(db, AMMI, 'ord_ammi');
  check('apne order par rukavat nahi', own.locked === false && own.ownLock === true);

  // Conflict: doosre order ki locked ID chheeni nahi jaati
  const conflict = lock.lockAccountToOrder(db, AMMI, db.orders.ord_abbu);
  check('doosre order ko lock nahi milta (conflict)', conflict?.conflict === true && conflict.lock.orderId === 'ord_ammi');

  // ID switch: ek hi order ki doosri ID → purani lock hat jati hai
  const switchRes = lock.lockAccountToOrder(db, ABBU, db.orders.ord_ammi, { phone: '9876500456' });
  check('ID switch par nayi ID lock', switchRes?.conflict === false && db.config.accounts[ABBU].orderLock.orderId === 'ord_ammi');
  check('purani ID free (ek order = ek ID)', db.config.accounts[AMMI].orderLock === null);
  check('purani ID ka reason sach', /ID switch/i.test(String(db.config.accounts[AMMI].lastUnlockReason || '')));
}

console.log('\n=== 2. Locked ID kisi doosre order ko assign nahi hoti ===');
{
  const db = makeDb();
  lock.lockAccountToOrder(db, AMMI, db.orders.ord_ammi);
  const busyForAbbu = cart.getBusySwiggyAccountsMap(db, 'ord_abbu');
  check('busy map me Ammi ki ID (durable lock se)', busyForAbbu.has(AMMI), JSON.stringify([...busyForAbbu.keys()]));
  check('busy entry me asli order id', String(busyForAbbu.get(AMMI)?.id || '') === 'ord_ammi');
  const busyForAmmi = cart.getBusySwiggyAccountsMap(db, 'ord_ammi');
  check('apne order ke liye busy nahi', !busyForAmmi.has(AMMI));
  check('doosri ID free hai (Abbu ko mil sakti hai)', !busyForAbbu.has(ABBU));

  const locked = lock.lockedKeysForOtherOrders(db, 'ord_abbu');
  check('lockedKeysForOtherOrders me sirf locked ID', locked.size === 1 && locked.has(AMMI));

  const line = lock.lockStatusLine(db, AMMI, { escape: (v) => String(v) });
  check('status line: locked to order #ord_ammi', /locked/.test(line) && /ord_ammi/.test(line), line);
  check('source: per-order lock ALL_ACCOUNTS_BUSY me dikhta hai', /Locked: \$\{lockedNow\.join/.test(cartSrc));
  check('source: selection mein lockedKeysForOtherOrders use hota hai', /lockedKeysForOtherOrders\(db, excludeOrderId/.test(cartSrc));
  check('source: rotation (ID switch picker) me bhi lock BUSY', /lockedKeysForOtherOrders\(db, orderId\)/.test(cartSrc));
}

console.log('\n=== 3. Deliver hone par: lock free + auto export + logout ===');
{
  const db = makeDb();
  lock.lockAccountToOrder(db, AMMI, db.orders.ord_ammi);
  // Delivered
  db.orders.ord_ammi.status = 'COMPLETED';
  db.orders.ord_ammi.liveOrderStatus = 'Delivered';
  db.orders.ord_ammi.deliveredAt = new Date().toISOString();
  db.orders.ord_ammi.swiggyOrderId = '251576512345';
  db.orders.ord_ammi.deviceLogin = { status: 'SESSION_LIVE', handoverSentAt: new Date().toISOString(), phone: '9876500123' };

  const plan = lock.planAccountReturnOnClose(db.orders.ord_ammi);
  check('deliver par lock release', plan.shouldRelease === true && plan.accountKey === AMMI);
  check('deliver par export', plan.shouldExport === true);
  check('deliver par logout', plan.shouldLogout === true);
  check('reason sach', /delivered/i.test(plan.reason), plan.reason);

  // Delivery-release (existing) bhi lock chhodta hai
  check('source: releaseAndExportInjectedSessionOnDelivery lock chhodta hai',
    /releaseAccountLock\(db, accKeyForLock, \{ orderId, reason: 'order delivered' \}\)/.test(indexSrc));

  // Auto export planner: ID doosre live order par na ho to export allowed
  const planExport = delivery.planDeliveryExport(db, db.orders.ord_ammi);
  check('auto export plan ready (delivered)', planExport.shouldExport === true, JSON.stringify(planExport.reason));
  check('file ka naam phone se', planExport.fileName === 'swiggy_9876500123.json', planExport.fileName);
}

console.log('\n=== 4. Cancel: lock free; export/logout sirf zarurat par ===');
{
  // (a) Bill reject — Swiggy par kuch place nahi hua, ID phone par bhi nahi gayi
  const db = makeDb();
  lock.lockAccountToOrder(db, AMMI, db.orders.ord_ammi);
  db.orders.ord_ammi.status = 'CANCELLED';
  const planA = lock.planAccountReturnOnClose(db.orders.ord_ammi);
  check('cancel par lock release', planA.shouldRelease === true);
  check('kuch place nahi hua → export NAHI', planA.shouldExport === false);
  check('kuch place nahi hua → logout NAHI (session zinda rehta hai)', planA.shouldLogout === false);
  check('reason honest', /session zinda/i.test(planA.reason), planA.reason);

  // (b) Cancel par Swiggy order ban chuka tha
  const db2 = makeDb();
  lock.lockAccountToOrder(db2, AMMI, db2.orders.ord_ammi);
  db2.orders.ord_ammi.status = 'CANCELLED';
  db2.orders.ord_ammi.pendingSwiggyOrderId = '251500000001';
  const planB = lock.planAccountReturnOnClose(db2.orders.ord_ammi);
  check('cancel + Swiggy par bana tha → export', planB.shouldExport === true);
  check('cancel + Swiggy par bana tha → logout', planB.shouldLogout === true);

  // (c) Cancel par ID customer ke phone par gayi thi
  const db3 = makeDb();
  lock.lockAccountToOrder(db3, AMMI, db3.orders.ord_ammi);
  db3.orders.ord_ammi.status = 'CANCELLED';
  db3.orders.ord_ammi.deviceLogin = { handoverSentAt: new Date().toISOString(), phone: '9876500123' };
  const planC = lock.planAccountReturnOnClose(db3.orders.ord_ammi);
  check('cancel + phone par ID thi → export + logout', planC.shouldExport === true && planC.shouldLogout === true);
  check('reason me phone ka zikr', /phone/i.test(planC.reason), planC.reason);

  // chalte order par kuch nahi hota
  const planLive = lock.planAccountReturnOnClose(db.orders.ord_abbu);
  check('chalte order ka lock chalu rehta hai', planLive.shouldRelease === false);

  check('source: customer bill reject par closeOrderAccountLock', /closeOrderAccountLock\(order\.id, \{ reason: 'customer ne bill cancel kiya' \}\)/.test(indexSrc));
  check('source: boss cancel par closeOrderAccountLock', /closeOrderAccountLock\(order\.id, \{ reason: 'boss ne order cancel kiya'/.test(indexSrc));
  check('source: cancel par export+logout function', /exportAndLogoutClosedOrder/.test(indexSrc) && /AUTO EXPORT &amp; LOGOUT/.test(indexSrc));
  check('source: file pehle boss ko, logout baad me', indexSrc.indexOf('sendDocument(') < indexSrc.indexOf('deactivateSwiggyAccountViaBridge(bossChatId, key, true)'));
}

console.log('\n=== 5. Sweep + TTL: ID kabhi hamesha ke liye atki nahi rehti ===');
{
  const now = Date.now();
  const db = makeDb(now);
  lock.lockAccountToOrder(db, AMMI, db.orders.ord_ammi, { at: now });
  lock.lockAccountToOrder(db, ABBU, db.orders.ord_abbu, { at: now });
  db.orders.ord_abbu.status = 'CANCELLED'; // terminal, close handler chala hi nahi (bot restart)

  const swept = lock.sweepAccountLocks(db, { nowMs: now });
  check('terminal order ka lock sweep me free', swept.released.some((r) => r.accountKey === ABBU && r.orderId === 'ord_abbu'), JSON.stringify(swept.released));
  check('chalte order ka lock sweep nahi karta', !swept.released.some((r) => r.accountKey === AMMI));
  check('sweep reason sach', /order cancelled/i.test(swept.released.find((r) => r.accountKey === ABBU)?.reason || ''));

  // TTL ke baad (order chalte hue bhi) lock chhoot jata hai — infinite hold nahi
  const later = now + lock.ACCOUNT_LOCK_TTL_MS + 1000;
  check('6h se purana lock dead mana jata hai', lock.isAccountLockedForOtherOrder(db, AMMI, 'ord_abbu', { nowMs: later }).locked === false);
  const swept2 = lock.sweepAccountLocks(db, { nowMs: later });
  check('TTL sweep release karta hai', swept2.released.some((r) => r.accountKey === AMMI) || db.config.accounts[AMMI].orderLock === null);
  check('source: sweep boot + har 10 min chalta hai', /runAccountLockSweep\(\)/.test(indexSrc));

  // order hi delete ho gaya
  const db4 = makeDb();
  lock.lockAccountToOrder(db4, AMMI, db4.orders.ord_ammi);
  delete db4.orders.ord_ammi;
  check('order missing → lock dead', lock.isAccountLockedForOtherOrder(db4, AMMI, 'ord_abbu').locked === false);
}

console.log('\n=== 6. Bill ready par lock + wahi ID Ammi ke phone par ===');
{
  check('source: BILL_READY par lockOrderAccountAndHandover', /lockOrderAccountAndHandover\(order, order\.selectedAccount \|\| best\.winningKey/.test(indexSrc));
  check('source: handover usi order ki ID ka', /export async function lockOrderAccountAndHandover/.test(indexSrc) && /lockAccountToOrder\(db, key, order/.test(indexSrc));
  check('source: conflict par code ACCOUNT_LOCKED_FOR_OTHER_ORDER', /ACCOUNT_LOCKED_FOR_OTHER_ORDER/.test(indexSrc));
  check('source: boss ko lock message jata hai', /ID LOCKED TO ORDER/.test(indexSrc));
  check('source: handover card wahi ID par (deviceLogin attach)', /attachDeviceLogin\(order, acc, \{ key: accKey \}\)/.test(indexSrc));
  check('source: ID switch par purana lock chhutta hai', /releaseAccountLock\(lockDb, prevKey/.test(fwdSrc));
  check('source: ID switch par nayi ID lock hoti hai', /lockAccountToOrder\(lockDb, target\.key, order/.test(fwdSrc));

  // Card me sach dikhta hai
  const db = makeDb();
  lock.lockAccountToOrder(db, AMMI, db.orders.ord_ammi);
  const compact = views.compactAccountLine(db.config.accounts[AMMI], AMMI, { index: 1 });
  check('account list line me 🔒 + order id', /🔒/.test(compact) && /ord_ammi/.test(compact), compact);
  const detail = views.accountDetailText({ acc: db.config.accounts[AMMI], key: AMMI });
  check('account detail me Locked to order + TTL sach', /Locked<\/b> to order/.test(detail.text) && /max 6h/.test(detail.text));
  check('free account par lock line nahi', !/Locked<\/b> to order/.test(views.accountDetailText({ acc: db.config.accounts[ABBU], key: ABBU }).text));
}

function restoreState() {
  try { if (dbSnapshot !== null) fs.writeFileSync(DB_PATH, dbSnapshot); else if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch {}
  try {
    if (mirrorSnapshot !== null) fs.writeFileSync(MIRROR, mirrorSnapshot);
    else if (fs.existsSync(MIRROR)) fs.unlinkSync(MIRROR);
  } catch {}
}
restoreState();

console.log('\n=====================================================================');
console.log(failed === 0
  ? `🏆 EK ORDER = EK ID (deliver/cancel tak) — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exit(failed === 0 ? 0 : 1);
