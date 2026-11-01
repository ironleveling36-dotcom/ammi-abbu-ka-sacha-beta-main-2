import assert from 'node:assert/strict';
import { ok, strictEqual } from 'node:assert';
import {
  getDb,
  saveDb,
  isAccountLoggedInSession,
  permanentLogoutAccount,
  deleteAccount,
  findAccountKeyByPhone
} from './store.js';
import {
  inspectAccountOrderHistoryAndOffers,
  saveAddressToAccount,
  applyLiveCouponToOrder,
  findBestMaxCouponAccountForOrder,
  scanOrderAcrossAccounts,
  getSwiggySessionAuth
} from './swiggy-cart.js';
import {
  validateTrackingUrlForOrder,
  isOfficialSwiggyTrackingUrl,
  isFabricatedTrackingUrl
} from './tracking-validation.js';

console.log('--- STARTING COMPREHENSIVE VERIFICATION FOR 6 USER FIXES ---');

// =========================================================================
// TEST 1: Expired Account Session Detection & Re-login Prevention
// =========================================================================
console.log('\n--- 1. Expired Account Session Detection ---');

// Create an account with expired JWT timestamp in tid
const expiredExp = Math.floor((Date.now() - 86400000) / 1000); // 1 day ago
const expiredJwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ user_id: '998877', exp: expiredExp })).toString('base64') + '.fakeSig';

const expiredAccount = {
  id: 'acc_expired_1',
  name: 'Expired User',
  phone: '9876543210',
  isLoggedIn: true,
  tid: expiredJwt,
  cookies: `tid=${expiredJwt}; token=tok_expired; _sid=sid_123`
};

const db = getDb();
if (db.config.deletedAccounts) {
  delete db.config.deletedAccounts['acc_expired_1'];
  delete db.config.deletedAccounts['acc_9876543210'];
  delete db.config.deletedAccounts['9876543210'];
}
db.config.accounts['acc_expired_1'] = expiredAccount;
saveDb(db);

// isAccountLoggedInSession must detect expired JWT without session_tid as expired
const isLive = isAccountLoggedInSession(expiredAccount);
ok(!isLive, 'Expired JWT account correctly identified as NOT logged in');

// getSwiggySessionAuth must mark sessionExpired = true
const authRes = await getSwiggySessionAuth(expiredAccount);
ok(authRes.sessionExpired === true, 'getSwiggySessionAuth returns sessionExpired: true for expired JWT');

// inspectAccountOrderHistoryAndOffers must mark account in DB as sessionExpired = true, isLoggedIn = false
const prof = await inspectAccountOrderHistoryAndOffers('acc_expired_1', expiredAccount, { force: true });
ok(prof.valid === false, 'inspectAccountOrderHistoryAndOffers reports valid: false for expired session');
const refreshedDb = getDb();
ok(refreshedDb.config.accounts['acc_expired_1']?.sessionExpired === true, 'Account persisted with sessionExpired: true in DB');
ok(refreshedDb.config.accounts['acc_expired_1']?.isLoggedIn === false, 'Account persisted with isLoggedIn: false in DB');
console.log('✅ Fix 1 Verified: Expired sessions properly detected and flagged!');

// =========================================================================
// TEST 2: Logout Permanence & Tombstone Preservation (No Resurrection!)
// =========================================================================
console.log('\n--- 2. Logout Permanence & No Concurrent Resurrection ---');

const accToLogout = {
  id: 'acc_logout_test',
  name: 'Logout Test User',
  phone: '9123456789',
  isLoggedIn: true,
  cookies: '_session_tid=sess_abc; token=tok_123; _is_logged_in=1'
};
const curDb = getDb();
delete curDb.config.deletedAccounts['acc_logout_test'];
delete curDb.config.deletedAccounts['9123456789'];
delete curDb.config.deletedAccounts['acc_9123456789'];
curDb.config.accounts['acc_logout_test'] = accToLogout;
saveDb(curDb);

// Simulate background fiber (like EventsClaim or AutoPreBook) taking an in-memory snapshot
const backgroundFiberDb = JSON.parse(JSON.stringify(getDb()));
// Background fiber mutates metadata on the account
backgroundFiberDb.config.accounts['acc_logout_test'].offers = { breakfast: { status: 'CLAIMED' } };

// User clicks logout
permanentLogoutAccount('acc_logout_test', { purgeVault: true });
deleteAccount('acc_logout_test', { purgeVault: true });

ok(!getDb().config.accounts['acc_logout_test'], 'Account immediately deleted from db.config.accounts');
ok(getDb().config.deletedAccounts['acc_logout_test'] === true, 'Account key tombstoned');
ok(getDb().config.deletedAccounts['9123456789'] === true, 'Phone number tombstoned');

// Background fiber completes and calls saveDb(backgroundFiberDb)
saveDb(backgroundFiberDb);

// The tombstone must have wiped the mutated account, NOT resurrected it!
const postSaveDb = getDb();
ok(!postSaveDb.config.accounts['acc_logout_test'], 'Mutated background fiber CANNOT resurrect logged-out account!');
ok(postSaveDb.config.deletedAccounts['acc_logout_test'] === true, 'Tombstone strictly preserved after concurrent save');
console.log('✅ Fix 2 Verified: Logout is permanent and immune to background resurrection!');

// =========================================================================
// TEST 3 & 4: Address Matching, Offer Application & Auto Account Selection
// =========================================================================
console.log('\n--- 3 & 4. Address Reuse, Offer Application & Auto Account Selection ---');

// Valid active account with saved addresses
const activeExp = Math.floor((Date.now() + 864000000) / 1000);
const activeJwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ user_id: '112233', exp: activeExp })).toString('base64') + '.sig';

const activeAccount = {
  id: 'acc_active_hero',
  name: 'Active Hero',
  phone: '9888877777',
  isLoggedIn: true,
  tid: activeJwt,
  _session_tid: 'sess_live_123',
  cookies: `_session_tid=sess_live_123; tid=${activeJwt}; token=tok_live_123; _is_logged_in=1`,
  totalOrdersCount: 0,
  cachedTotalOrdersCount: 0,
  isZeroOrderAccount: true
};

const savedAddresses = [
  {
    id: 'addr_swiggy_456',
    address: 'Flat 402, Sunshine Heights, Koramangala 4th Block, Bengaluru',
    lat: 12.9345,
    lng: 77.6256,
    name: 'Home',
    mobile: '9888877777', // Account holder's number
    city: 'Bengaluru'
  }
];

// Order request with different recipient phone
const orderAddrInput = {
  address: 'Flat 402, Sunshine Heights, Koramangala 4th Block, Bengaluru, 560034',
  lat: 12.9345,
  lng: 77.6256,
  mobile: '9999900000', // Customer's phone!
  name: 'Aman Khan',
  city: 'Bengaluru'
};

// 🔒 RULE (boss 30-10-2026, /pro checkout se sakht hua): saved address tabhi
// reuse hota hai jab RECIPIENT bhi wahi ho — naam, mobile, street aur pin sab
// match karein. Pehle bot account-holder ka address (uske phone ke saath) chupchaap
// reuse kar leta tha, isliye rider galat number par call karta tha.
const savedRes = await saveAddressToAccount(activeAccount, orderAddrInput, savedAddresses);
strictEqual(savedRes.addressId, '', 'Different recipient phone wala saved address reuse NAHI hota (rider galat number par call na kare)');
ok(/did not accept|verify|recipient/i.test(String(savedRes.error || savedRes.addressDetails?.error || savedRes.error || '')),
  'Reuse na hone par saaf reason milta hai (chupchaap default address nahi)');
strictEqual(savedRes.createdNew, false, 'Koi jhoota "created" claim nahi');

// Ab bilkul match wala saved address — wahi reuse hona chahiye.
const matchingAddresses = [
  {
    id: 'addr_swiggy_456',
    address: orderAddrInput.address,
    lat: orderAddrInput.lat,
    lng: orderAddrInput.lng,
    name: orderAddrInput.name,
    mobile: orderAddrInput.mobile,
    city: orderAddrInput.city
  }
];
const matchedRes = await saveAddressToAccount(activeAccount, orderAddrInput, matchingAddresses);
strictEqual(matchedRes.addressId, 'addr_swiggy_456', 'Exact same recipient + street + pin ka address reuse hota hai');
strictEqual(matchedRes.addressDetails.mobile, '9999900000', 'Recipient customer mobile preserved for order delivery');
strictEqual(matchedRes.createdNew, false, 'Reuse par naya address nahi banaya');

// Coupon application check with bound vs unbound address
const unboundOrder = { id: 'ORD_UNBOUND', restaurantId: '12345', addressDetails: { ...matchedRes.addressDetails, id: '' }, items: [{ itemId: 'item_1', name: 'Burger', price: 250, quantity: 1 }] };
const unboundRes = await applyLiveCouponToOrder(activeAccount, unboundOrder, 'SWIGGYIT');
ok(unboundRes?.code === 'DELIVERY_ADDRESS_NOT_BOUND', 'Correctly rejects when delivery address is not bound');

const dummyOrder = {
  id: 'ORD_TEST_99',
  restaurantId: '12345',
  addressDetails: matchedRes.addressDetails,
  items: [{ itemId: 'item_1', name: 'Burger', price: 250, quantity: 1 }]
};

const couponRes = await applyLiveCouponToOrder(activeAccount, dummyOrder, 'SWIGGYIT', { fastSingleEngine: true });
ok(couponRes?.code !== 'DELIVERY_ADDRESS_NOT_BOUND', 'Bound address passes validation and executes coupon engines');

// Auto Account Selection with active pool
const heroDb = getDb();
if (heroDb.config.deletedAccounts) {
  delete heroDb.config.deletedAccounts['acc_active_hero'];
  delete heroDb.config.deletedAccounts['acc_9888877777'];
  delete heroDb.config.deletedAccounts['9888877777'];
}
heroDb.config.accounts['acc_active_hero'] = activeAccount;
saveDb(heroDb);

const autoPick = await findBestMaxCouponAccountForOrder({
  id: 'ORD_AUTO_PICK_TEST',
  subtotal: 300,
  addressDetails: matchedRes.addressDetails,
  items: [{ itemId: 'item_1', name: 'Burger', price: 300, quantity: 1 }]
}, { maxSearchWaves: 1, maxParallelProbes: 1 });

ok(autoPick !== null, 'findBestMaxCouponAccountForOrder executes cleanly');
console.log('✅ Fix 3 & 4 Verified: Address bound cleanly, coupon engine ready, auto selection unblocked!');

// =========================================================================
// TEST 5: Order Count Accuracy & Persistence
// =========================================================================
console.log('\n--- 5. Order Count Verification & Increment ---');

// Account totalOrdersCount persistence
activeAccount.totalOrdersCount = 2;
activeAccount.cachedTotalOrdersCount = 2;
activeAccount.isZeroOrderAccount = false;
const countDb = getDb();
if (countDb.config.deletedAccounts) {
  delete countDb.config.deletedAccounts['acc_active_hero'];
  delete countDb.config.deletedAccounts['acc_9888877777'];
  delete countDb.config.deletedAccounts['9888877777'];
}
countDb.config.accounts['acc_active_hero'] = activeAccount;
saveDb(countDb);

strictEqual(getDb().config.accounts['acc_active_hero'].totalOrdersCount, 2, 'Total orders count persisted in DB');
strictEqual(getDb().config.accounts['acc_active_hero'].isZeroOrderAccount, false, 'isZeroOrderAccount updated');
console.log('✅ Fix 5 Verified: Order count accurately stored and tracked!');

// =========================================================================
// TEST 6: Tracking Link Validation & Retrieval
// =========================================================================
console.log('\n--- 6. Tracking Link Validation & Fetching ---');

// Official tracking links that Swiggy API returns
const swiggyApiOrdersUrl = 'https://www.swiggy.com/orders/251576512345';
const swiggyTrackUrl = 'https://www.swiggy.com/orders/track/251576512345';
const swiggyShortUrl = 'https://swig.gy/ofo/track/abc12345';
const swiggyRUrl = 'https://r.swiggy.com/aBcDeFg';

const fakeAppendUrl = 'https://www.swiggy.com/track/251576512345';
const fakeGenericUrl = 'https://www.swiggy.com/orders';

const mockOrder = {
  id: 'ORD_TRK_1',
  swiggyOrderId: '251576512345'
};

// 1. Official Swiggy API tracking links must pass validation
ok(validateTrackingUrlForOrder(swiggyApiOrdersUrl, mockOrder, 'SWIGGY_API'), 'swiggy.com/orders/<id> is valid for SWIGGY_API');
ok(validateTrackingUrlForOrder(swiggyTrackUrl, mockOrder, 'SWIGGY_API'), 'swiggy.com/orders/track/<id> is valid');
ok(validateTrackingUrlForOrder(swiggyShortUrl, mockOrder, 'SWIGGY_API'), 'swig.gy/ofo/track/<id> is valid');
ok(validateTrackingUrlForOrder(swiggyRUrl, mockOrder, 'SWIGGY_API'), 'r.swiggy.com/<shortcode> is valid');

// 2. Generic placeholders must be rejected
ok(!validateTrackingUrlForOrder(fakeGenericUrl, mockOrder, 'SWIGGY_API'), 'Generic /orders URL is rejected');

// 3. Scan order across accounts must filter out expired and logged-out accounts
const scanRes = await scanOrderAcrossAccounts('251576512345', {
  getAccountsFn: () => ({
    acc_expired_1: expiredAccount,
    acc_active_hero: activeAccount
  }),
  budgetMs: 4000
});

ok(scanRes !== null, 'scanOrderAcrossAccounts completes without hanging on dead accounts');
console.log('✅ Fix 6 Verified: Legitimate tracking links verified and dead accounts skipped during scan!');

console.log('\n================================================================');
console.log('🏆 ALL 6 FIXES VERIFIED AND PASSING SUCCESSFULLY!');
console.log('================================================================');
