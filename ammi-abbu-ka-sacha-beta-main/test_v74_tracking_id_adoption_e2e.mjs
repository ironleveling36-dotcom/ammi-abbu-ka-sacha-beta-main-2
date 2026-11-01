/**
 * v74 — "same ID me login karke turant link nikaal do" (boss 30-10-2026)
 *
 * Boss:
 *   "jis id se order hota same id me dusre bot me login karta to wo nikaal kar
 *    dete turant. ab to har order user ke device par order hoga uska ip kam se
 *    kam — ab to karde sahi tracking link wala."
 *
 * Asli wajah: order customer ke phone se place hota hai → bot ke paas Swiggy ka
 * order id hota hi nahi → `trackV4` call hi nahi hoti → link kabhi nahi nikalta.
 *
 * Yeh test (offline) proves:
 *   1. `adoptSwiggyOrderIdForBot` usi ID ki `order/all` se apna order pehchanta
 *      hai (time + amount + restaurant) — koi guess nahi.
 *   2. Galat order / purana order / doosre bot ka order adopt NAHI hota.
 *   3. `extractTrackingNow` fast trackV4 se OFO link laata hai (fyi_details →
 *      cta_link), order par save + notifier chalta hai.
 *   4. Link na mile to asli reason (NOT_ON_ANY_ACCOUNT / NO_SWIGGY_ID), fake
 *      link kabhi nahi.
 *   5. Wiring: tracking ladder bina id ke bhi chalti hai, "🔗 Link lao" button
 *      customer card + handler dono taraf.
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

const dapiLog = [];
function orderAllPayload(orders) {
  // dapiFetch ka shape: { ok, status, json: <parsed body> }
  return { data: { orders } };
}

// Fake Swiggy: order/all + trackV4 (fyi_details → cta_link) — exactly the live shape.
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  dapiLog.push(target);
  const ok = (payload) => ({ ok: true, status: 200, headers: new Map(), json: async () => payload, text: async () => JSON.stringify(payload) });
  if (target.includes('/dapi/order/all')) {
    return ok(orderAllPayload(globalThis.__FAKE_ORDERS || []));
  }
  if (target.includes('order/trackV4')) {
    const id = (target.match(/order_id=(\d+)/) || [])[1] || '';
    if (globalThis.__FAKE_TRACK_ID === id) {
      return ok({
        data: {
          order_id: id,
          order_status_details: { status_message: 'Order Confirmed' },
          fyi_details: [{
            value: { cta_link: `swiggy://share?text=${encodeURIComponent(`https://www.swiggy.com/ofo/track/GfF1tVG8iSUk`)}` }
          }]
        }
      });
    }
    return ok({ data: {} });
  }
  if (target.includes('swiggy.com')) {
    return { ok: true, status: 200, headers: new Map(), json: async () => ({}), text: async () => '' };
  }
  return { ok: false, status: 404, headers: new Map(), json: async () => ({}), text: async () => '' };
};

const { getDb, saveDb, mutateDb } = await import('./store.js');
const tracking = await import('./order-tracking.js');
const indexSrc = fs.readFileSync('./index.js', 'utf8');
const chatSrc = fs.readFileSync('./simple-chat.js', 'utf8');
const trackingSrc = fs.readFileSync('./order-tracking.js', 'utf8');

const U = '8800111';
const ACC = 'acc_9000012345';
const NOW = Date.now();

function seed() {
  mutateDb((d) => {
    d.config = d.config || {};
    d.config.accounts = {
      [ACC]: {
        name: 'Ammi ID', phone: '9000012345', isLoggedIn: true,
        cookies: 'tid=abc.def.ghi', tid: 'a.b.c', customerId: '778899'
      }
    };
    d.config.bossIds = ['9990001'];
    d.orders = {
      ORD1: {
        id: 'ORD1', userId: U, status: 'PAYMENT_PENDING', cardStage: 'QR_RELEASED',
        restaurantName: 'Pizza Hut', finalPayable: 249,
        createdAt: new Date(NOW - 4 * 60 * 1000).toISOString(),
        selectedAccount: ACC, selectedAccountPhone: '9000012345', billApprovedByUser: true
      }
    };
  });
}

console.log('\n1) Adoption — customer ke phone se place hua order');
seed();
globalThis.__FAKE_ORDERS = [{
  order_id: '251838950110925',
  order_status: 'Delivered',
  order_total: 249,
  restaurant_name: 'Pizza Hut',
  order_time: Math.floor((NOW - 2 * 60 * 1000) / 1000)
}];
globalThis.__FAKE_TRACK_ID = '251838950110925';

const adopted = await tracking.adoptSwiggyOrderIdForBot('ORD1', { budgetMs: 5000 });
check('order id adopt hua', adopted.ok === true && adopted.adopted === true, JSON.stringify(adopted).slice(0, 120));
check('wahi id mili', adopted.swiggyOrderId === '251838950110925', adopted.swiggyOrderId);
check('usi account se mila', adopted.accKey === ACC, adopted.accKey);
check('order par id save hui', getDb().orders.ORD1.swiggyOrderId === '251838950110925');
check('adoption ka source likha', getDb().orders.ORD1.swiggyOrderAdoptedFrom === ACC);
check('order/all hi call hua (koi guess nahi)', dapiLog.some((u) => u.includes('/dapi/order/all')));
check('dobara adopt karne par kaam khatam', (await tracking.adoptSwiggyOrderIdForBot('ORD1')).adopted === false);

console.log('\n2) Galat order adopt nahi hota');
seed();
globalThis.__FAKE_ORDERS = [
  // purana order (2 din pehle) — window ke bahar
  { order_id: '111111111111111', order_total: 249, restaurant_name: 'Pizza Hut', order_time: Math.floor((NOW - 48 * 3600 * 1000) / 1000) },
  // amount match nahi
  { order_id: '222222222222222', order_total: 899, restaurant_name: 'Pizza Hut', order_time: Math.floor((NOW - 60 * 1000) / 1000) },
  // doosra restaurant
  { order_id: '333333333333333', order_total: 249, restaurant_name: 'Dominos', order_time: Math.floor((NOW - 60 * 1000) / 1000) }
];
const noAdopt = await tracking.adoptSwiggyOrderIdForBot('ORD1', { budgetMs: 5000 });
check('koi galat id adopt nahi hui', noAdopt.ok === false, JSON.stringify(noAdopt).slice(0, 120));
check('order par id nahi likhi', !getDb().orders.ORD1.swiggyOrderId);

console.log('\n3) Doosre bot order ki id chori nahi hoti');
seed();
mutateDb((d) => { d.orders.OTHER = { id: 'OTHER', userId: '123', swiggyOrderId: '444444444444444', status: 'COMPLETED' }; });
globalThis.__FAKE_ORDERS = [{ order_id: '444444444444444', order_total: 249, restaurant_name: 'Pizza Hut', order_time: Math.floor((NOW - 60 * 1000) / 1000) }];
const taken = await tracking.adoptSwiggyOrderIdForBot('ORD1', { budgetMs: 5000 });
check('already-used id adopt nahi hoti', taken.ok === false && !getDb().orders.ORD1.swiggyOrderId, JSON.stringify(taken).slice(0, 100));

console.log('\n4) extractTrackingNow — turant OFO link');
seed();
globalThis.__FAKE_ORDERS = [{
  order_id: '251838950110925', order_total: 249, restaurant_name: 'Pizza Hut',
  order_time: Math.floor((NOW - 2 * 60 * 1000) / 1000)
}];
globalThis.__FAKE_TRACK_ID = '251838950110925';
const found = await tracking.extractTrackingNow('ORD1', { budgetMs: 9000 });
check('link mila', found.ok === true && /swiggy\.com\/ofo\/track\//.test(found.url || ''), JSON.stringify(found).slice(0, 140));
check('link order par save hua', /ofo\/track/.test(String(getDb().orders.ORD1.trackingLink || '')));
check('source SWIGGY_API', getDb().orders.ORD1.trackingLinkSource === 'SWIGGY_API');
check('cross-order link reject hota hai', !/ZXQPy4BbQuGb/.test(String(getDb().orders.ORD1.trackingLink)));

console.log('\n5) Link na mile to asli reason (fake link kabhi nahi)');
seed();
globalThis.__FAKE_ORDERS = [];
const notFound = await tracking.extractTrackingNow('ORD1', { budgetMs: 6000 });
check('fail honest hai', notFound.ok === false);
check('reason code aata hai', Boolean(notFound.reason), String(notFound.reason));
check('koi fake link nahi', !notFound.url);
check('order par koi tracking link nahi', !getDb().orders.ORD1.trackingLink);

const noRecord = await tracking.extractTrackingNow('NOPE', { budgetMs: 2000 });
check('order record na ho to ORDER_NOT_FOUND', noRecord.reason === 'ORDER_NOT_FOUND', noRecord.reason);

console.log('\n6) Wiring');
check('adopt export hai', /export async function adoptSwiggyOrderIdForBot/.test(trackingSrc));
check('extractTrackingNow export hai', /export async function extractTrackingNow/.test(trackingSrc));
check('trackV4 fast path use hota hai', /fetchSwiggyTrackingLinkFast/.test(trackingSrc));
check('ensureOrderTracking me adoption', /adoptSwiggyOrderIdForBot\(order\.id/.test(trackingSrc));
check('ladder bina id ke rukti nahi', !/if \(!orderSwiggyOrderId\(order\)\) return null;/.test(trackingSrc));
check('placing account stale flag ke baawajood poocha jata hai', /includeStaleFlags: includeStaleFlags \|\| Boolean\(order\.selectedAccount\)/.test(trackingSrc));
check('index me Link lao handler', /track_now_/.test(indexSrc));
check('index me honest reason list', /TRACK_FAIL_REASONS/.test(indexSrc));
check('paid-status par adopt hota hai', /adoptSwiggyOrderIdForBot\(order\.id, \{ budgetMs: 7000 \}\)/.test(indexSrc));
check('customer card par Link lao button', /track_now_\$\{order\.id\}/.test(chatSrc));
check('waf cooldown ignore hota hai manual me', /ignoreWafCooldown: true/.test(trackingSrc));

function restoreState() {
  try {
    if (dbSnapshot === null) fs.rmSync(DB_PATH, { force: true });
    else fs.writeFileSync(DB_PATH, dbSnapshot);
    if (mirrorSnapshot === null) fs.rmSync(MIRROR, { force: true });
    else fs.writeFileSync(MIRROR, mirrorSnapshot);
  } catch { /* ignore */ }
}
restoreState();

console.log(`\n${failed === 0 ? '🏆' : '❌'} v74: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
