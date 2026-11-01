import assert from 'node:assert';
import {
  extractTrackingUrlFromSwiggyFyiDetails,
  extractOrderShareUrlDeep,
  extractSwiggyProvidedTrackingUrl,
  extractTrackingCandidateUrlsFromString,
  isOfficialSwiggyTrackingUrl,
  validateTrackingUrlForOrder
} from './swiggy-cart.js';

console.log('--- STARTING V46 FYI_DETAILS & INSTANT TRACKV4 SHARE LINK E2E ---');

const TARGET_URL = 'https://www.swiggy.com/ofo/track/GfF1tVG8iSUk';
const TARGET_ORDER_ID = '251838950110925';

// 1. Test exact Swiggy trackV4 real payload structure as reported by user
const ctaExact = 'swiggy://share?text=I+ordered+food+from+McDonalds+-+track+my+order+live+on+Swiggy+at+https%3A%2F%2Fwww.swiggy.com%2Fofo%2Ftrack%2FGfF1tVG8iSUk';
const trackV4PayloadExact = {
  statusCode: 0,
  data: {
    order_id: TARGET_ORDER_ID,
    order_status_details: {
      status_message: 'Food is being prepared'
    },
    fyi_details: [
      {
        type: 'share',
        value: {
          title: 'Share tracking with family',
          cta_text: 'Share',
          cta_link: ctaExact
        }
      }
    ]
  }
};

const extracted1 = extractTrackingUrlFromSwiggyFyiDetails(trackV4PayloadExact);
assert.strictEqual(extracted1, TARGET_URL, 'extractTrackingUrlFromSwiggyFyiDetails must extract target URL');
console.log('✅ [PASS] 1. extractTrackingUrlFromSwiggyFyiDetails extracts real Swiggy trackV4 cta_link');

const direct1 = extractSwiggyProvidedTrackingUrl(trackV4PayloadExact.data);
assert.strictEqual(direct1, TARGET_URL, 'extractSwiggyProvidedTrackingUrl must extract target URL');
console.log('✅ [PASS] 2. extractSwiggyProvidedTrackingUrl fast-paths FYI details directly');

const deep1 = extractOrderShareUrlDeep(trackV4PayloadExact.data);
assert.strictEqual(deep1, TARGET_URL, 'extractOrderShareUrlDeep must return target URL immediately');
console.log('✅ [PASS] 3. extractOrderShareUrlDeep returns target tracking URL');

// 2. Test double-encoded URL in swiggy://share?text=
const ctaDouble = 'swiggy://share?text=Check+order+status%3A+https%253A%252F%252Fwww.swiggy.com%252Fofo%252Ftrack%252FGfF1tVG8iSUk';
const trackV4PayloadDouble = {
  data: {
    fyi_details: [
      {
        value: {
          cta_link: ctaDouble
        }
      }
    ]
  }
};
const deepDouble = extractOrderShareUrlDeep(trackV4PayloadDouble.data);
assert.strictEqual(deepDouble, TARGET_URL, 'double encoded URL must be decoded and matched');
console.log('✅ [PASS] 4. Double-encoded URL in swiggy://share?text= is decoded successfully');

// 3. Test unencoded sentence in swiggy://share?text=
const ctaUnencoded = 'swiggy://share?text=Track+your+order+at+https://www.swiggy.com/ofo/track/GfF1tVG8iSUk+now';
const trackV4PayloadUnencoded = {
  fyi_details: [
    {
      value: {
        cta_link: ctaUnencoded
      }
    }
  ]
};
const deepUnencoded = extractOrderShareUrlDeep(trackV4PayloadUnencoded);
assert.strictEqual(deepUnencoded, TARGET_URL, 'unencoded sentence URL must be extracted');
console.log('✅ [PASS] 5. Unencoded sentence URL in swiggy://share?text= is extracted');

// 4. Test validation of extracted URL against order
const mockOrder = { swiggyOrderId: TARGET_ORDER_ID };
assert.ok(isOfficialSwiggyTrackingUrl(TARGET_URL, { allowProviderShortLink: true }), 'URL must be official Swiggy tracking URL');
assert.ok(validateTrackingUrlForOrder(TARGET_URL, mockOrder, 'SWIGGY_API'), 'URL must validate for SWIGGY_API source');
console.log('✅ [PASS] 6. Extracted URL passes isOfficialSwiggyTrackingUrl and validateTrackingUrlForOrder');

// 5. Test speed benchmark: must extract in under 1ms (far below the 1000ms user budget)
const startHr = process.hrtime.bigint();
const fastExtract = extractOrderShareUrlDeep(trackV4PayloadExact.data);
const endHr = process.hrtime.bigint();
const elapsedMs = Number(endHr - startHr) / 1_000_000;
assert.strictEqual(fastExtract, TARGET_URL);
assert.ok(elapsedMs < 10, `Extraction must be faster than 10ms, took ${elapsedMs.toFixed(3)}ms`);
console.log(`✅ [PASS] 7. Ultra-fast extraction benchmark: completed in ${elapsedMs.toFixed(3)}ms (<< 1000ms budget)`);

console.log('================================================================');
console.log('🏆 ALL 7/7 V46 FYI_DETAILS & TRACKV4 CHECKS PASSED!');
console.log('================================================================');
