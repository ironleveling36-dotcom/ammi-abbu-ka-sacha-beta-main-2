// ============================================================================
// v16 — URL-first address intake, receipt-style order card, /start resilience
// ----------------------------------------------------------------------------
// Regression suite for four production bugs:
//   1. Pasted chat text (order account block, "india Address", phone numbers)
//      was copied into the delivery address. Only the shared Swiggy address
//      LINK may provide delivery details.
//   2. The delivery phone silently became the ordering account's number.
//   3. Order details rendered with duplicated / placeholder city lines.
//   4. /start crashed for brand-new users ("... is not defined").
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import assert from 'assert';
import fs from 'fs';

// Keep the repository's data/db.json untouched by this suite.
const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const restoreDb = () => {
  if (dbSnapshot !== null) {
    try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {}
  }
};

const SHARED_RECEIVER_PHONE = '9876500011'; // differs from the pasted account number on purpose
const SHARED_DISPLAY_ADDRESS = 'Shyam Baba Mandir, Nearby Kalshul Factory, Shivaji Nagar, Gullowara, Darbhanga, Bihar 846004';
const ACCOUNT_NUMBER_IN_TEXT = '8873415879';

const SAMPLE_FORWARDED_MESSAGE = `🧾 ORDER BILL READY (#FWD3416)
👤 Forwarded From: SHANU SAHANI

📱 Order Account
Account: ${ACCOUNT_NUMBER_IN_TEXT}

🛒 Cart / Restaurant
Restaurant: Mouj Mela

india Address
india Address
SHANU SAHANI
${ACCOUNT_NUMBER_IN_TEXT}
Shyam Baba Mandir, Nearby Kalshul Factory, Shivaji Nagar, Gullowara, Darbhanga, Bihar, India
Latitude: 26.0829899
Longitude: 86.0324951
Select an Available Payment Method

Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/kubail4a.

Address: Shyam Baba Mandir, Nearby Kalshul Factory, Shivaji Nagar, Gullowara, Darbhanga, Bihar, India
`;

// ---------------------------------------------------------------------------
// Offline network stub (installed BEFORE importing the modules so the modules
// capture it as their boot fetch reference).
// ---------------------------------------------------------------------------
const sharedAddressPayload = {
  statusCode: 0,
  data: {
    address: {
      id: 'addr_shared_1',
      display_address: SHARED_DISPLAY_ADDRESS,
      actual_address: {
        contact_name: 'SHANU SAHANI',
        phone: SHARED_RECEIVER_PHONE,
        city: 'Darbhanga',
        locality: 'Shivaji Nagar',
        landmark: 'Shyam Baba Mandir',
        address_line: 'Shyam Baba Mandir',
        location: { lat: 26.0829899, lng: 86.0324951 },
        tags: ['Home']
      }
    }
  }
};

const fetchLog = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  fetchLog.push(target);
  const jsonResponse = (json) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(json),
    json: async () => json
  });

  // AppsFlyer OneLink short link -> Swiggy OFO address page
  if (target.includes('onelink.me')) {
    return {
      ok: false,
      status: 302,
      headers: { get: (key) => (String(key).toLowerCase() === 'location' ? 'https://www.swiggy.com/ofo/address/shanu/TOKEN123456' : null) },
      text: async () => '',
      json: async () => ({})
    };
  }
  // Swiggy shared-address API — the ONLY accepted source of delivery details
  if (target.includes('social/getAddress/')) return jsonResponse(sharedAddressPayload);
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({})
  };
};

const results = [];
function check(label, condition) {
  results.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) process.exitCode = 1;
}

const {
  parseAddressDetails,
  extractAddressShareUrl,
  isAddressShareUrl,
  resolveSwiggyLink
} = await import('./swiggy-cart.js');
const { ingestForwardedContentIntoOrder, buildForwardedOrderCardView } = await import('./forwarded-order-flow.js');
const { getDb } = await import('./store.js');
const { bot, formatUserOrderCardText } = await import('./index.js');

// ---------------------------------------------------------------------------
// 1. Link detection
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: address-link detection ---');
check('Share-address OneLink detected', extractAddressShareUrl(SAMPLE_FORWARDED_MESSAGE) === 'https://swiggy.onelink.me/JgkQ/kubail4a');
check('Swiggy OFO address URL detected', isAddressShareUrl('https://www.swiggy.com/ofo/address/shanu/TOKEN123456'));
check('Google Maps pin detected', isAddressShareUrl('https://maps.app.goo.gl/abcd1234'));
check('Group cart link is NOT an address link', !isAddressShareUrl('https://swig.gy/gc/1467977/Umbashiya-642855918'));
check('Restaurant link is NOT an address link', !isAddressShareUrl('https://www.swiggy.com/restaurants/mouj-mela-12345'));

// ---------------------------------------------------------------------------
// 2. Text parser must refuse to parse messages that carry an address link
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: pasted text is never used next to an address link ---');
check('parseAddressDetails() returns null for the pasted bill/address block', parseAddressDetails(SAMPLE_FORWARDED_MESSAGE) === null);
check('parseAddressDetails() ignores the "Address: ..." line when a link is present',
  parseAddressDetails(`Hey! Save my address on Swiggy using the link:https://swiggy.onelink.me/JgkQ/kubail4a.\n\nAddress: Somewhere else, India`) === null);

const plainReceipt = parseAddressDetails(
  'Pune Address\nPrathmesh\n9823305540\nFlat no. 412, Parivartan Society, Pune Maharashtra 411030\nLatitude: 18.502975\nLongitude: 73.846375'
);
check('Plain-text address (no link) still parses', plainReceipt?.name === 'Prathmesh' && plainReceipt?.mobile === '9823305540' && plainReceipt?.city === 'Pune');
check('Order Account number is still never used as recipient mobile',
  parseAddressDetails('Order Account: 9876543210\nPune Address\nPrathmesh\nFlat no. 412, Parivartan Society, Pune Maharashtra 411030')?.mobile !== '9876543210');

// ---------------------------------------------------------------------------
// 3. resolveSwiggyLink resolves delivery data from the LINK only
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: resolveSwiggyLink() is URL-first ---');
const resolved = await resolveSwiggyLink(SAMPLE_FORWARDED_MESSAGE);
check('Resolved as ADDRESS', resolved.type === 'ADDRESS');
check('Address source is URL', resolved.addressSource === 'URL');
check('Receiver name comes from Swiggy link', resolved.addressDetails?.name === 'SHANU SAHANI');
check('Receiver phone comes from Swiggy link, NOT the pasted account number',
  resolved.addressDetails?.mobile === SHARED_RECEIVER_PHONE && resolved.addressDetails?.mobile !== ACCOUNT_NUMBER_IN_TEXT);
check('City comes from Swiggy link, never the pasted "india Address" header',
  resolved.addressDetails?.city === 'Darbhanga');
check('Street address comes from Swiggy link', resolved.addressDetails?.address === SHARED_DISPLAY_ADDRESS);
check('Coordinates come from Swiggy link', resolved.addressDetails?.lat === '26.0829899' && resolved.addressDetails?.lng === '86.0324951');

// ---------------------------------------------------------------------------
// 4. Forwarded-order intake keeps the text out of the order
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: forwarded intake stores link data only ---');
const forwardedOrder = {
  id: 'FWD_TEST_1',
  isForwardedOrder: true,
  userId: 9001,
  fwdSenderName: 'SHANU SAHANI',
  status: 'PENDING',
  cardStage: 'COLLECTING',
  cart: null,
  items: [],
  address: null,
  addressDetails: null,
  createdAt: new Date().toISOString()
};
const intake = await ingestForwardedContentIntoOrder(forwardedOrder, { rawText: SAMPLE_FORWARDED_MESSAGE });
check('Intake reports the address as updated', intake.updatedAddress === true);
check('Order delivery phone is the receiver number from the link', forwardedOrder.addressDetails?.mobile === SHARED_RECEIVER_PHONE);
check('Order city is not the pasted "india" placeholder', forwardedOrder.addressDetails?.city === 'Darbhanga');
check('Stored order.address is the resolved address (not the pasted chat text)',
  forwardedOrder.address === SHARED_DISPLAY_ADDRESS && !/Order Account|Forwarded From/i.test(forwardedOrder.address));
check('Raw chat text is not kept as the address', !String(forwardedOrder.addressDetails?.address || '').includes('Order Account'));

// ---------------------------------------------------------------------------
// 5. Receipt-style order card
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: receipt-style card layout ---');
const displayOrder = {
  id: 'FWD_TEST_2',
  isForwardedOrder: true,
  selectedAccount: 'acc_test',
  orderAccount: '7783067848',
  restaurantName: 'Shivsagar Pure Veg Restaurant',
  items: [
    { name: 'Extra butter', price: 55, qty: 1, lineTotal: 55 },
    { name: 'Watermelon Juice', price: 145, qty: 1, lineTotal: 145 }
  ],
  subtotal: 200,
  itemTotal: 200,
  couponCode: 'FEASTMODE70',
  discountAmount: 140,
  freeCashApplied: 40,
  swiggyOneMembershipFee: 1,
  freeDelivery: true,
  deliverySaved: 28,
  freeDeliveryDiscount: 28,
  deliveryFee: 0,
  taxesAndCharges: 22.38,
  totalSavings: 208,
  finalPayable: 43,
  address: SHARED_DISPLAY_ADDRESS,
  addressDetails: {
    name: 'Arjun',
    mobile: '9420891324',
    city: 'Nashik',
    address: 'Road corner bungalow, opp. Daksh enclave\nNashik, Maharashtra 422009',
    lat: '19.949595',
    lng: '73.772314'
  }
};
const card = formatUserOrderCardText(displayOrder, true);
const mustHave = [
  'Order Account:', '7783067848',
  'Your Cart', 'Shivsagar Pure Veg Restaurant',
  'Delivering To', 'Nashik Address', 'Arjun', '9420891324',
  'Road corner bungalow, opp. Daksh enclave', 'Nashik, Maharashtra 422009',
  'Latitude: 19.949595', 'Longitude: 73.772314',
  'Extra butter', '₹55 × 1 = ₹55', 'Watermelon Juice', '₹145 × 1 = ₹145',
  '2 Items • Subtotal: ₹200',
  'Bill Summary', 'Items Total: ₹200', 'Coupon FEASTMODE70: −₹140',
  'Extra Discount ( Free Cash ): −₹40', 'Swiggy One Lite Membership: +₹1',
  'Free Delivery upto 7km', 'Delivery Fee: FREE (₹28 saved)',
  'GST & Other Charges: ₹22.38', 'Total Savings: ₹208', 'To Pay: ₹43'
];
for (const fragment of mustHave) {
  check(`Card renders "${fragment}"`, card.includes(fragment));
}
check('Card never repeats the city header twice', (card.match(/Nashik Address/g) || []).length === 1);
check('Card drops the "Select an Available Payment Method" filler line', !/Select an Available Payment Method/i.test(card));
check('Card does not leak the pasted "india Address" placeholder', !/india Address/i.test(card));

const placeholderCard = formatUserOrderCardText({
  id: 'FWD_TEST_3',
  restaurantName: 'Mouj Mela',
  items: [],
  address: 'https://swiggy.onelink.me/JgkQ/kubail4a',
  addressDetails: { unresolvableShortLink: true, city: '', address: '', mobile: '' }
}, true);
check('Unresolved link asks for a fresh address instead of echoing chat text',
  /could not be resolved/i.test(placeholderCard) && !/Order Account: 8873415879/.test(placeholderCard));

// ---------------------------------------------------------------------------
// 6. /start must never crash for a brand-new user
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 6: brand-new user presses /start ---');
const telegramCalls = [];
const fakeCallApi = async (method, payload = {}) => {
  telegramCalls.push({ method, payload });
  if (method === 'sendMessage') {
    return {
      message_id: telegramCalls.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: payload.chat_id, type: 'private' },
      text: payload.text || ''
    };
  }
  if (method === 'getMe') {
    return { id: 123456, is_bot: true, first_name: 'Swiggy Slot Bot', username: 'swiggy_slot_test_bot' };
  }
  return true;
};
// Telegraf builds a fresh `Telegram` client per update, so the prototype is
// stubbed as well as the bot's own client.
bot.telegram.callApi = fakeCallApi;
Object.getPrototypeOf(bot.telegram).callApi = fakeCallApi;

const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map(a => (a && a.stack) ? a.stack : String(a)).join(' '));
  realConsoleError(...args);
};

const NEW_USER_ID = 9_990_161;
await bot.handleUpdate({
  update_id: 1,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: NEW_USER_ID, type: 'private', first_name: 'New' },
    from: { id: NEW_USER_ID, is_bot: false, first_name: 'New', language_code: 'en' },
    text: '/start',
    entities: [{ type: 'bot_command', offset: 0, length: 6 }]
  }
});

const startedAt = Date.now();
while (telegramCalls.filter(c => c.method === 'sendMessage').length === 0 && Date.now() - startedAt < 5000) {
  await new Promise(r => setTimeout(r, 50));
}
console.error = realConsoleError;

const sentMessages = telegramCalls.filter(c => c.method === 'sendMessage').map(c => c.payload);
check('/start replies to the new user', sentMessages.length > 0);
check('/start sends the welcome screen', sentMessages.some(m => /Welcome|Assalamu Alaikum|Khana Order Karein/i.test(String(m.text || ''))));
check('/start attaches working reply keyboard', sentMessages.some(m => Boolean(m.reply_markup)));
check('/start does not throw a "not defined" error', !consoleErrors.some(line => /is not defined/i.test(line)));
check('/start does not throw UNEXPECTED_ERROR', !consoleErrors.some(line => /UNEXPECTED_ERROR/i.test(line)));

// ---------------------------------------------------------------------------
// 7. Static guard: no referenced-but-undeclared helper in the bot sources
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 7: static undefined-reference guard ---');
const sourceFiles = ['index.js', 'simple-chat.js', 'ammi-abbu-topic-flow.js', 'forwarded-order-flow.js', 'swiggy-cart.js', 'swiggy-bridge.js', 'store.js', 'boss-panel.js', 'rich-text.js', 'order-tracking.js', 'link-utils.js', 'sms-notify.js', 'account-vault-intake.js', 'vault-sync.js', 'phone-utils.js', 'network-shield.js', 'login-helper.js', 'waf-pool.js', 'tracking-validation.js', 'scan-diagnostics.js', 'swiggy.js'];
let acorn = null;
try {
  acorn = await import('acorn');
  acorn = acorn.default || acorn;
} catch { /* optional dependency — guard degrades gracefully */ }

if (acorn) {
  const walk = (await import('acorn-walk')).default || (await import('acorn-walk'));
  const GLOBALS = new Set(`console JSON Math Number String Boolean Object Array Promise Error TypeError RangeError Date RegExp Map Set WeakMap WeakSet Symbol BigInt Intl URL URLSearchParams navigator window document Buffer process globalThis setTimeout clearTimeout setInterval clearInterval setImmediate fetch AbortController AbortSignal Response Request Headers TextEncoder TextDecoder Uint8Array Uint8ClampedArray Int8Array Uint16Array Int32Array Float32Array Float64Array ArrayBuffer DataView encodeURIComponent decodeURIComponent encodeURI decodeURI isNaN isFinite parseInt parseFloat undefined NaN Infinity require module exports __dirname __filename queueMicrotask structuredClone crypto atob btoa FormData Blob Event EventTarget WebSocket performance arguments`.split(/\s+/));
  const offenders = [];
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowAwaitOutsideFunction: true });
    const declared = new Set();
    const addPattern = (p) => {
      if (!p) return;
      if (p.type === 'Identifier') declared.add(p.name);
      else if (p.type === 'ObjectPattern') p.properties.forEach(pr => addPattern(pr.type === 'RestElement' ? pr.argument : pr.value));
      else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
      else if (p.type === 'AssignmentPattern') addPattern(p.left);
      else if (p.type === 'RestElement') addPattern(p.argument);
    };
    walk.full(ast, (node) => {
      if (node.type === 'VariableDeclarator') addPattern(node.id);
      if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        if (node.id) declared.add(node.id.name);
        (node.params || []).forEach(addPattern);
      }
      if (node.type === 'ImportDeclaration') node.specifiers.forEach(s => declared.add(s.local.name));
      if (node.type === 'CatchClause' && node.param) addPattern(node.param);
    });
    walk.ancestor(ast, {
      Identifier(node, _state, ancestors) {
        const parent = ancestors[ancestors.length - 2];
        if (!parent) return;
        if ((parent.type === 'MemberExpression' || parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.property === node && !parent.computed) return;
        if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
        if (/^(?:Import|Export)(?:Default|Namespace)?Specifier$/.test(parent.type)) return;
        if (parent.type === 'VariableDeclarator' && parent.id === node) return;
        if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression' || parent.type === 'ClassDeclaration') && (parent.id === node || (parent.params || []).includes(node))) return;
        if (!declared.has(node.name) && !GLOBALS.has(node.name)) {
          offenders.push(`${file}:${node.loc.start.line} → ${node.name}`);
        }
      }
    });
  }
  check(`No undeclared identifiers in bot sources${offenders.length ? ` (found: ${[...new Set(offenders)].join(', ')})` : ''}`, offenders.length === 0);
} else {
  check('Static undefined-reference guard (acorn not installed — skipped)', true);
}

// ---------------------------------------------------------------------------
console.log('\n================================================================');
const passed = results.filter(r => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('================================================================');
restoreDb();
if (passed !== results.length) process.exitCode = 1;
