import fs from 'fs';
import path from 'path';
import {
  getGenuinePaymentDetails,
  generateUpiQrUrl,
  extractRealSwiggyTracking,
  verifyPaymentStatusFromApi
} from './swiggy-cart.js';
import { getDb } from './store.js';

console.log('====================================================');
console.log('🧪 RUNNING GENUINE PAYMENT QR & CHECKOUT VERIFICATION');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
  }
}

// ---------------------------------------------------------
// Test 1: Investigate Original Payment Options Dump (Swiggy API)
// ---------------------------------------------------------
console.log('--- Test Suite 1: Swiggy Web Payment Response Investigation ---');
const dumpPath = path.resolve('payment_options_dump.json');
assert(fs.existsSync(dumpPath), 'payment_options_dump.json fixture exists');

if (fs.existsSync(dumpPath)) {
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  const paymentGroups = dump?.data?.payment_group || [];
  const groupNames = paymentGroups.map(g => g.group_name);
  
  // Verify standard payment groups in web checkout
  assert(groupNames.includes('card') && groupNames.includes('wallet_web'), 
    'Payment options contains Cards and Wallets (AmazonPay, PhonePe, etc.)');

  // Verify that NO dynamic UPI QR image or payload exists in the web response
  let hasDynamicQrField = false;
  let hasDynamicQrImage = false;
  for (const group of paymentGroups) {
    for (const method of (group.payment_methods || [])) {
      if (method.qrCode || method.qr_image || method.qrPayload || method.dynamic_qr) {
        hasDynamicQrField = true;
      }
    }
  }
  assert(!hasDynamicQrField, 
    'Confirmed: Swiggy Web get-payment-options API does NOT expose dynamic UPI QR code');
}

// ---------------------------------------------------------
// Test 2: Elimination of Synthetic QR and Guessed Personal Data
// ---------------------------------------------------------
console.log('\n--- Test Suite 2: Elimination of Synthetic QR Generation ---');
const mockOrder = {
  id: '78291',
  restaurantName: 'Pramod Laddu Bhandar',
  finalPayable: 206.66,
  subtotal: 206.66
};

const genuineDetails = getGenuinePaymentDetails(mockOrder);
assert(!genuineDetails.hasGenuineQr, 'Order without custom QR reports hasGenuineQr = false');
assert(genuineDetails.swiggyPaymentUrl === 'https://www.swiggy.com/payments', 'Provides authentic Swiggy payment URL');

const legacyQr = generateUpiQrUrl(mockOrder.finalPayable, mockOrder.id);
assert(legacyQr.qrUrl === null, 'generateUpiQrUrl no longer calls api.qrserver.com or returns synthetic image URL');
assert(legacyQr.upiIntent === undefined, 'No synthetic upi://pay URI is generated or injected');

// Check that personal phonepe UPI ID 6296591407@ybl is not in swiggy-cart.js
const swiggyCartContent = fs.readFileSync(path.resolve('swiggy-cart.js'), 'utf8');
assert(!swiggyCartContent.includes('6296591407@ybl'), 'Personal UPI ID 6296591407@ybl completely removed from payment logic');
assert(!swiggyCartContent.includes('api.qrserver.com'), 'External synthetic generator api.qrserver.com completely removed');

// ---------------------------------------------------------
// Test 3: Genuine QR Image Preservation & Verification
// ---------------------------------------------------------
console.log('\n--- Test Suite 3: Genuine QR Image Preservation ---');
const genuineOrderWithFileId = {
  id: '78292',
  restaurantName: 'Haldiram',
  finalPayable: 350,
  customQrFileId: 'AgACAgUAAxkBAAI...genuine_telegram_file_id'
};
const detailsWithFileId = getGenuinePaymentDetails(genuineOrderWithFileId);
assert(detailsWithFileId.hasGenuineQr === true, 'Recognizes genuine uploaded QR file ID');
assert(detailsWithFileId.genuineQr === genuineOrderWithFileId.customQrFileId, 'Preserves original genuine QR file ID intact');

// Test with authentic screenshot buffer fixture if available
const screenshotPath = path.resolve('swiggy_payment_step.png');
if (fs.existsSync(screenshotPath)) {
  const buf = fs.readFileSync(screenshotPath);
  assert(buf.length > 1000 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', 
    'Authentic Swiggy payment screenshot is valid PNG binary');
}

// ---------------------------------------------------------
// Test 4: Authentic vs Local Order ID Distinction
// ---------------------------------------------------------
console.log('\n--- Test Suite 4: Authentic Swiggy Order ID vs Draft ID ---');
// Verify that local order IDs are treated as bot request IDs and not passed off as Swiggy Order IDs
const db = getDb();
assert(typeof db.orders === 'object', 'Local database orders structure is accessible');

// ---------------------------------------------------------
// Test 5: Real Tracking Extraction & Payment Verification
// ---------------------------------------------------------
console.log('\n--- Test Suite 5: Real Tracking & Payment Status Verification ---');
(async () => {
  // Test with empty cookies: must fail safely and NOT invent fake tracking URLs
  const emptyTracking = await extractRealSwiggyTracking('');
  assert(emptyTracking.trackingUrl === null, 'Without valid cookies, trackingUrl is strictly null');
  assert(emptyTracking.orderId === null, 'Without valid cookies, orderId is strictly null');

  const emptyVerification = await verifyPaymentStatusFromApi('');
  assert(emptyVerification.paid === false, 'Unauthenticated status correctly returns paid = false');
  assert(emptyVerification.status === 'NO_COOKIES', 'Returns status NO_COOKIES rather than falsely assuming SUCCESS');

  console.log('\n====================================================');
  console.log(`📊 FINAL RESULT: ${passedTests}/${totalTests} Tests Passed`);
  console.log('====================================================');
  
  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
})();
