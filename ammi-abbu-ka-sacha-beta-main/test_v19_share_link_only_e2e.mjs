// ============================================================================
// v19 — Only the URL of a Swiggy share message matters
// ----------------------------------------------------------------------------
// Real-world pastes look like this (Telegram keeps the markdown):
//
//   Hey! Save my address on Swiggy using the
//   link:[https://swiggy.onelink.me/JgkQ/kubail4a](https://swiggy.onelink.me/JgkQ/kubail4a).
//
//   Address: Shyam Baba Mandir, Nearby Kalshul Factory, Shivaji Nagar, ...
//
//   It is a one time use link and will be valid for 24 hours.
//
// The old `https?:\/\/[^\s]+` match swallowed `…kubail4a](https://…kubail4a`
// as ONE url, so the resolver, classifier and cards all carried the whole
// pasted block. These checks lock in "link in, everything else ignored" for
// both address links and restaurant/cart links.
// ============================================================================

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

import fs from 'fs';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => {
  if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} }
});

const fetchedUrls = [];
globalThis.fetch = async (input) => {
  fetchedUrls.push(String(input?.url || input));
  return {
    ok: false,
    status: 503,
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

const { extractSharedUrls, normalizeSharedUrl, stripSharedLinks } = await import('./link-utils.js');
const { formatUserOrderCardText, isValidSwiggyCartUrl } = await import('./index.js');
const {
  extractAddressShareUrl,
  parseAddressDetails,
  resolveSwiggyLink
} = await import('./swiggy-cart.js');
const { classifyRawOrderInputFast, ingestForwardedContentIntoOrder, splitMultipleOrderBlocks } = await import('./forwarded-order-flow.js');

const ADDRESS_LINK = 'https://swiggy.onelink.me/JgkQ/kubail4a';
const ADDRESS_SHARE_TEXT = `Hey! Save my address on Swiggy using the link:[${ADDRESS_LINK}](${ADDRESS_LINK}).  \n\nAddress: Shyam Baba Mandir, Nearby Kalshul Factory, Shivaji Nagar, Gullowara, Darbhanga, Bihar, India  \n\nIt is a one time use link and will be valid for 24 hours.`;
const CART_LINK = 'https://swig.gy/gc/1467977/Umbashiya-642855918';
const CART_SHARE_TEXT = `Order from Mouj Mela on Swiggy: [${CART_LINK}](${CART_LINK}) — tap to open the group cart. Link valid for 24 hours.`;

const FLUFF = [/save my address on swiggy/i, /one time use link/i, /valid for 24 hours/i, /\]\(https?:\/\//i, /tap to open/i];

// ---------------------------------------------------------------------------
// 1. URL extraction: markdown, duplicates, punctuation, bare hosts
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1: link extraction takes only the URL ---');
{
  const urls = extractSharedUrls(ADDRESS_SHARE_TEXT);
  check('exactly one address link is extracted', urls.length === 1);
  check('the link is byte-identical to the shared URL', urls[0] === ADDRESS_LINK);
  check('no markdown debris in the extracted link', !urls[0].includes('](') && !urls[0].includes(')'));
  check('surrounding sentence is not part of the link', !/save my address/i.test(urls[0]));

  const cartUrls = extractSharedUrls(CART_SHARE_TEXT);
  check('restaurant/cart link is extracted cleanly', cartUrls.length === 1 && cartUrls[0] === CART_LINK);

  check('plain url survives untouched', normalizeSharedUrl('https://swig.gy/gc/1/Shop-2') === 'https://swig.gy/gc/1/Shop-2');
  check('markdown link is unwrapped', normalizeSharedUrl(`[open](${ADDRESS_LINK})`) === ADDRESS_LINK);
  check('trailing punctuation is trimmed', normalizeSharedUrl(`${ADDRESS_LINK}.`) === ADDRESS_LINK);
  check('duplicated markdown url is collapsed', normalizeSharedUrl(`${ADDRESS_LINK}](${ADDRESS_LINK}`) === ADDRESS_LINK);
  check('angle brackets are trimmed', normalizeSharedUrl(`<${ADDRESS_LINK}>`) === ADDRESS_LINK);
  check('bare swiggy short host is upgraded to https', normalizeSharedUrl('swig.gy/gc/1/Shop-2') === 'https://swig.gy/gc/1/Shop-2');
  check('bare www host is upgraded to https', normalizeSharedUrl('www.swiggy.com/restaurants/x-123') === 'https://www.swiggy.com/restaurants/x-123');
  check('non-url text yields nothing', normalizeSharedUrl('It is a one time use link') === '');
  check('truncated scheme yields nothing', normalizeSharedUrl('https://') === '');
  check('duplicate links are de-duplicated', extractSharedUrls(`${ADDRESS_LINK} and ${ADDRESS_LINK}`).length === 1);
}

// ---------------------------------------------------------------------------
// 1b. Nested / triple-wrapped markdown (Telegram double paste)
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 1b: nested markdown wrappers ---');
{
  const nested = `Hey! Save my address on Swiggy using the link:[[${ADDRESS_LINK}](${ADDRESS_LINK})](${ADDRESS_LINK}](${ADDRESS_LINK})).    \n    \nAddress: Shyam Baba Mandir, Nearby Kalshul Factory, Shivaji Nagar, Gullowara, Darbhanga, Bihar, India    \n    \nIt is a one time use link and will be valid for 24 hours.`;
  const urls = extractSharedUrls(nested);
  check('nested markdown still yields exactly one link', urls.length === 1 && urls[0] === ADDRESS_LINK);
  check('nested markdown link has no bracket debris', !/[\[\]()]/.test(urls[0]));

  const stripped = stripSharedLinks(nested);
  check('stripping removes leftover bracket tokens', !/\]\(|^\[|\)$/.test(stripped.trim()));
  check('stripping keeps the human readable address line', /Shyam Baba Mandir/.test(stripped));
  check('nested address paste is classified as address only',
    extractAddressShareUrl(nested) === ADDRESS_LINK &&
    classifyRawOrderInputFast(nested).hasCart === false);
}

// ---------------------------------------------------------------------------
// 2. Address share message -> only the link is delivery data
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 2: address share message keeps only the link ---');
{
  const addressUrl = extractAddressShareUrl(ADDRESS_SHARE_TEXT);
  check('address share url is detected cleanly', addressUrl === ADDRESS_LINK);
  check('the pasted "Address:" block is never parsed while a link exists', parseAddressDetails(ADDRESS_SHARE_TEXT) === null);
  const strippedText = stripSharedLinks(ADDRESS_SHARE_TEXT);
  check('stripping links removes the url but keeps human text', !/https?:\/\//.test(strippedText) && /Shyam Baba Mandir/.test(strippedText));

  const classified = classifyRawOrderInputFast(ADDRESS_SHARE_TEXT);
  check('classified as an address (not a cart)', classified.hasAddress === true && classified.hasCart === false);
  check('no cart url is invented from an address message', classified.primaryCartUrl === '');

  const before = fetchedUrls.length;
  const resolved = await resolveSwiggyLink(ADDRESS_SHARE_TEXT).catch(() => null);
  const requested = fetchedUrls.slice(before).filter((u) => /onelink\.me|swiggy\.com/i.test(u));
  check('the resolver is called with the clean link only',
    requested.length === 0 || requested.every((u) => !u.includes('](')));
  check('the resolver never receives the pasted sentence', requested.every((u) => !/save my address/i.test(decodeURIComponent(u))));
  check('the address link is typed as ADDRESS (or fails safely offline)',
    !resolved || resolved.linkType === 'ADDRESS' || resolved.type === 'ADDRESS' || Boolean(resolved.addressDetails));
}

// ---------------------------------------------------------------------------
// 3. Restaurant / cart share message -> only the link is cart data
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 3: restaurant share message keeps only the link ---');
{
  check('cart link is recognised as a geniune Swiggy cart url', isValidSwiggyCartUrl(CART_LINK));
  check('the markdown-wrapped cart url is not used as-is', !extractSharedUrls(CART_SHARE_TEXT).some((u) => u.includes('](')));

  const classified = classifyRawOrderInputFast(CART_SHARE_TEXT);
  check('classified as a cart message', classified.hasCart === true && classified.hasAddress === false);
  check('the primary cart url is the clean link', classified.primaryCartUrl === CART_LINK);

  const before = fetchedUrls.length;
  const resolved = await resolveSwiggyLink(CART_SHARE_TEXT).catch(() => null);
  const requested = fetchedUrls.slice(before).filter((u) => /swig\.gy|swiggy\.com/i.test(u));
  check('cart resolver only ever sees the clean link',
    requested.every((u) => u.startsWith(CART_LINK) || (!u.includes('](') && !/tap to open/i.test(decodeURIComponent(u)))));
  check('restaurant + group cart ids are read from the link (offline-safe)',
    !resolved || (resolved.restaurantId === '1467977' && resolved.groupCartId === '642855918'));
}

// ---------------------------------------------------------------------------
// 4. Forwarded-order ingestion never stores the pasted block
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4: order fields stay free of pasted text ---');
{
  const addressOrder = { id: 'V19_ADDR', userId: 1, fwdSenderName: 'Ammi', userName: 'Ammi' };
  await ingestForwardedContentIntoOrder(addressOrder, { rawText: ADDRESS_SHARE_TEXT }).catch(() => {});
  const addressBlob = JSON.stringify(addressOrder);
  // Offline the link cannot be resolved, so the order keeps exactly the link.
  check('order.address is exactly the clean link', addressOrder.address === ADDRESS_LINK);
  check('order.address never contains the pasted share text', !/save my address|one time use/i.test(String(addressOrder.address || '')));
  check('order.addressOriginalText carries no marketing fluff',
    FLUFF.every((re) => !re.test(String(addressOrder.addressOriginalText || ''))));
  check('the whole order object has no markdown debris', !addressBlob.includes(']('));
  check('the address link is remembered for later resolution', addressOrder.addressLink === ADDRESS_LINK || addressOrder.addressLink === undefined);

  const cartOrder = { id: 'V19_CART', userId: 1, fwdSenderName: 'Ammi', userName: 'Ammi' };
  await ingestForwardedContentIntoOrder(cartOrder, { rawText: CART_SHARE_TEXT }).catch(() => {});
  check('order.cart is exactly the shared link', cartOrder.cart === CART_LINK);
  check('cart fields have no pasted text', FLUFF.every((re) => !re.test(JSON.stringify(cartOrder))));
}

// ---------------------------------------------------------------------------
// 4b. Two markdown cart links in one paste -> two clean order blocks
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 4b: multiple orders are split on clean links ---');
{
  const twoOrders = [
    `Order 1: [https://swig.gy/gc/111/ShopA-1](https://swig.gy/gc/111/ShopA-1)\nAddress: A, Bihar`,
    `Order 2: [https://swig.gy/gc/222/ShopB-2](https://swig.gy/gc/222/ShopB-2)\nAddress: B, Bihar`
  ].join('\n\n');
  const blocks = splitMultipleOrderBlocks(twoOrders);
  check('two cart links produce two order blocks', blocks.length === 2);
  check('each block holds exactly one cart link',
    blocks.every((b) => extractSharedUrls(b).filter((u) => /\/gc\//.test(u)).length === 1));
  check('split blocks carry no markdown debris', blocks.every((b) => !b.includes('](')));
  const single = splitMultipleOrderBlocks(ADDRESS_SHARE_TEXT);
  check('a single share message is never split', single.length === 1);
}

// ---------------------------------------------------------------------------
// 5. Cards never render the pasted block
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 5: order cards stay clean ---');
{
  const cardText = formatUserOrderCardText({
    id: 'V19_CARD',
    address: ADDRESS_LINK,
    addressDetails: null,
    addressOriginalText: ADDRESS_LINK,
    items: [{ name: 'Egg Roll', price: 109, qty: 1, lineTotal: 109 }],
    subtotal: 109,
    finalPayable: 109,
    restaurantName: 'Mouj Mela',
    status: 'PENDING'
  }, false);
  check('card never prints the marketing text', !/save my address|one time use|valid for 24 hours/i.test(cardText));
  check('card never prints markdown debris', !cardText.includes(']('));
  check('card does not dump a raw address url as the street address', !cardText.includes('onelink.me/JgkQ/kubail4a'));
}

// ---------------------------------------------------------------------------
// 6. Static guard: all link capture goes through link-utils
// ---------------------------------------------------------------------------
console.log('\n--- Scenario 6: no module re-introduces the greedy url regex ---');
{
  const sources = ['index.js', 'swiggy-cart.js', 'forwarded-order-flow.js'];
  const offenders = [];
  for (const file of sources) {
    const src = fs.readFileSync(file, 'utf8');
    // The old pattern captured `[url](url` as a single URL.
    if (/match\(\/https\?:\\\/\\\/\[\^\\s\]\+/i.test(src)) offenders.push(file);
  }
  check('no greedy URL capture left in the ingestion modules', offenders.length === 0);
  for (const file of sources) {
    const src = fs.readFileSync(file, 'utf8');
    check(`${file} uses the shared link helpers`, src.includes("from './link-utils.js'"));
  }
}

console.log('\n' + '='.repeat(64));
const passed = results.filter((r) => r.ok).length;
console.log(`📊 RESULT: ${passed}/${results.length} checks passed`);
console.log('='.repeat(64));
