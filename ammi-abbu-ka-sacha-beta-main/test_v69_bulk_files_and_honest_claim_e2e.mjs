/**
 * v69 — 6 SE ZYADA FILE + JHOOTHA "OFFER CLAIMED" (dono band)
 *
 * Boss (27-10-2026): "WHEN I UPLOAD MORE THAN 6 JSON FILE IT SHOWS ALWAYS THAT 6
 * JSON FILE UPLOADED AND SAYS OFFER CLAIMED AND THE OFFER IS NOT ACTUALLY
 * CLAIMED".
 *
 * Bug 1 — "hamesha 6 file":
 *   Document handler `await bulkAccountDocCollector.enqueue(...)` karta tha,
 *   matlab handler poore batch (verify + cards + claims, minute tak) chalता rehta
 *   tha. Update dispatcher ek waqt me sirf UPDATE_CONCURRENCY (default 6)
 *   updates chalata hai — isliye 7th file ka handler shuru hi nahi hota tha aur
 *   batch sirf 6 files ka ban jata tha. Ab handler turant return karta hai
 *   (void), batch window 1500ms, aur ek chat ka flush ek waqt me ek hi chalta hai.
 *
 * Bug 2 — "offer claimed par asli me nahi":
 *   Swiggy kabhi `shouldNotify:true` rakhta hai par reward option 2/3/4 (coupon)
 *   save kar deta hai. Purana code usko bhi CLAIMED maan leta tha. Ab: ₹50 free
 *   cash (option 1) force karne ke liye ek PATCH, dobara read-back, aur phir bhi
 *   na bade to saaf WRONG_REWARD (✅ nahi).
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

const intake = await import('./account-vault-intake.js');
const views = await import('./account-views.js');
const offersEngine = await import('./event-offers.js');
const bridge = await import('./swiggy-bridge.js');

const makePhone = (i) => `9876${String(500000 + i).padStart(6, '0')}`;

function fakeCollector({ fileCount, batches, windowMs = 60 }) {
  const collector = intake.createBulkDocumentBatchCollector({
    windowMs,
    downloadBufferFn: async (d) => Buffer.from(JSON.stringify({ phone: d.phone, token: `tok_${d.phone}`, tid: 'a.b.c' })),
    ingestOptions: {
      verifyFn: async (c) => ({ valid: true, phone: c.phone, liveTid: c.tid, token: c.token, cookies: c.cookies }),
      orderProfileFn: async () => ({ valid: true, orderCount: 0, ordersVerifiedLive: true, totalOrdersCount: 0 }),
      claimOffersFn: async () => ({ ok: true, offers: {} }),
      syncVaultFn: async () => true,
      waitForClaims: false
    },
    onBatchComplete: async (info) => { batches.push({ filesCount: info.filesCount, raw: (info.rawEntries || []).length, saved: info.result?.savedAccounts?.length || 0 }); }
  });
  const ctx = { chat: { id: 900 }, telegram: {}, reply: async () => ({ message_id: 1 }) };
  return { collector, ctx };
}

console.log('\n=== 1. Handler dispatcher slot block NAHI karta (6 ka cap gaya) ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('document handler `void bulkAccountDocCollector.enqueue` karta hai', /void bulkAccountDocCollector\.enqueue\(String\(ctx\.chat\.id\), ctx, \{/.test(src));
  check('purana `await ... enqueue` nahi bacha', !/await bulkAccountDocCollector\.enqueue\(/.test(src));
  check('dispatcher concurrency abhi bhi 6 hai (wo galat nahi thi)', /process\.env\.UPDATE_CONCURRENCY\) \|\| 6\)/.test(src));
  check('batch window 1500ms (650 nahi)', /windowMs = 1500/.test(fs.readFileSync('./account-vault-intake.js', 'utf8')));
}

console.log('\n=== 2. 14 files ek saath = 14 file, ek hi summary, 14 save ===');
{
  const batches = [];
  const { collector, ctx } = fakeCollector({ fileCount: 14, batches, windowMs: 120 });
  const done = [];
  for (let i = 0; i < 14; i++) {
    done.push(collector.enqueue('chat900', ctx, { ctx, phone: makePhone(i), fileName: `${makePhone(i)}.json` }));
  }
  await Promise.all(done);
  const total = batches.reduce((n, b) => n + b.filesCount, 0);
  const saved = batches.reduce((n, b) => n + b.saved, 0);
  check('14 files bheje', true);
  check('summary me 14 file gini gayi (6 nahi)', total === 14, JSON.stringify(batches));
  check('14 accounts save hue', saved === 14, JSON.stringify(batches));
  check('ek hi batch bana (split nahi hua)', batches.length === 1, `batches=${batches.length}`);
}

console.log('\n=== 3. Batch ke dauraan aayi file next batch me poori process hoti hai ===');
{
  const src = fs.readFileSync('./account-vault-intake.js', 'utf8');
  check('flush ke waqt naya bucket queue me lagta hai', /pendingAfterFlush\.add\(chatKey\)/.test(src));
  check('ek hi chat ka do flush parallel nahi chalta', /if \(flushing\.has\(chatKey\)\)/.test(src));
  check('flush ke baad pending bucket turant chalta hai', /setTimeout\(\(\) => \{ flushBucket\(chatKey\)\.catch/.test(src));

  const batches = [];
  const { collector, ctx } = fakeCollector({ fileCount: 3, batches, windowMs: 80 });
  const p1 = [0, 1, 2].map((i) => collector.enqueue('chat901', ctx, { ctx, phone: makePhone(i), fileName: `${makePhone(i)}.json` }));
  await Promise.all(p1);
  const total1 = batches.reduce((n, b) => n + b.filesCount, 0);
  check('pehla batch 3 file', total1 === 3, JSON.stringify(batches));
}

console.log('\n=== 4. Summary card: har file ka hisaab + file-fail list ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('"Files received" line hai (jhoothi total nahi)', /Files received: <b>\$\{filesCount \|\|/.test(src));
  check('file fail count + naam dikhte hain', /File errors:/.test(src) && /dlErrors\.slice\(0, 6\)/.test(src));
  check('per-account saare offer (n/N dynamic)', /₹50×\$\{OFFER_TRACKS\.length\} → \$\{cells\} \(\$\{claimedN\}\/\$\{OFFER_TRACKS\.length\}\)/.test(src));
}

console.log('\n=== 5. WRONG REWARD ab CLAIMED nahi (asli jhooth ka fix) ===');
{
  // Swiggy: PATCH ke baad bhi value 3 (coupon) hi rehta hai.
  const state = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, target, body });
    if (target.includes('/api/notify')) {
      const campaign = method === 'GET'
        ? decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0])
        : (body?.campaign || '');
      if (method === 'GET') {
        const rec = state.get(campaign) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec }) };
      }
      // POST/PATCH: Swiggy "save" karta hai par hamesha coupon (3) rakhta hai
      state.set(campaign, { shouldNotify: true, value: 3 });
      return { ok: true, status: 200, json: async () => ({ statusCode: 0, message: 'Done Successfully' }) };
    }
    if (target.includes('events.swiggy.com')) return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  offersEngine.resetEventOfferMetaCache();
  offersEngine.resetFixedCampaignCache();
  const out = await offersEngine.activateAllEventOffers(
    { id: 'acc_wrong_reward', phone: '9876500777', token: 't', tid: 'a.b.c' },
    { fetchImpl, force: true, offerKey: ['lateNight'], offerKeys: ['lateNight'], meta: { lateNight: { prefix: 'byo-ln-v5-', boundaries: [], source: 'TEST' } } }
  );
  const slot = out.offers.lateNight;
  check('₹50 na lage to CLAIMED nahi', slot.status !== 'CLAIMED', slot.status);
  check('state WRONG_REWARD', slot.state === 'WRONG_REWARD', slot.state);
  check('verified false (jhootha ✓ nahi)', slot.verified === false);
  check('reason me asli option bataya', /option 3/.test(String(slot.message)), String(slot.message));
  check('ek extra PATCH se option 1 force karne ki koshish hui', calls.some((c) => c.method === 'PATCH' && Number(c.body?.value) === 1), JSON.stringify(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.body?.value])));

  // Card me bhi ✅ nahi, 🟡 + sach
  const block = views.fourOfferStatusBlock({ offers: { lateNight: slot } });
  check('card me 🟡 WRONG REWARD dikhta hai', /WRONG REWARD/.test(block), block);
  check('card me ✅ nahi', !/✅/.test(block.split('\n')[1] || ''), block.split('\n')[1]);
  check('card me "₹50 free cash nahi mila" likha hai', /₹50 free cash nahi mila/.test(block), block);
  const truth = views.offerClaimTruth({ offers: { lateNight: slot } });
  check('claimedCount me nahi gina', truth.claimedCount === 0, String(truth.claimedCount));
  check('truth label honest', /₹50 free cash nahi/.test(truth.lateNight.label), truth.lateNight.label);
}

console.log('\n=== 6. ₹50 sach me lag gaya to CLAIMED (dono taraf sach) ===');
{
  const state = new Map();
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (target.includes('/api/notify')) {
      const campaign = method === 'GET'
        ? decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0])
        : (body?.campaign || '');
      if (method === 'GET') {
        const rec = state.get(campaign) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec }) };
      }
      state.set(campaign, { shouldNotify: true, value: Number(body?.value || 1) });
      return { ok: true, status: 200, json: async () => ({ statusCode: 0 }) };
    }
    if (target.includes('events.swiggy.com')) return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  offersEngine.resetEventOfferMetaCache();
  offersEngine.resetFixedCampaignCache();
  const out = await offersEngine.activateAllEventOffers(
    { id: 'acc_good', phone: '9876500888', token: 't', tid: 'a.b.c' },
    { fetchImpl, force: true, offerKeys: ['lateNight'], meta: { lateNight: { prefix: 'byo-ln-v5-', boundaries: [], source: 'TEST' } } }
  );
  check('₹50 laga to CLAIMED', out.offers.lateNight.status === 'CLAIMED');
  check('verified true', out.offers.lateNight.verified === true);
  check('valueMatched true', out.offers.lateNight.valueMatched === true);
  check('card me ✅', /✅/.test(views.fourOfferStatusBlock({ offers: { lateNight: out.offers.lateNight } })));

  // Legacy (2-offer) path bhi ab jhooth nahi bolta
  const bridgeSrc = fs.readFileSync('./swiggy-bridge.js', 'utf8');
  check('legacy applyVerification value-mismatch par ok:false', /wrongReward: true/.test(bridgeSrc) && /ok: false,\s*\n\s*wrongReward/.test(bridgeSrc));
  check('legacy slot status WRONG_REWARD deta hai', /status: bfFinalOk \? 'CLAIMED' : \(bfApplied\.wrongReward \? 'WRONG_REWARD' : 'FAILED'\)/.test(bridgeSrc));
}

console.log('\n=== 7. Import claim honest engine se (legacy quickLock nahi) ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('sequential import chaaron offer engine se claim karta hai', /offersResult = await Promise\.race\(\[\s*\n\s*autoActivateEventOffers\(/.test(src));
  check('purana quickLockOnly pre-claim gaya', !/claimSwiggyBreakfastAndLateNightOffers\(\{\s*\n\s*id: savedKey/.test(src));
  const intakeSrc = fs.readFileSync('./account-vault-intake.js', 'utf8');
  check('bulk claim force:false (ledger + read-back)', /claimOffersFn\(account, \{ force: false, offerValue: 1 \}\)/.test(intakeSrc));
  check('IMPORT summary me 🟡 wrong-reward mark hai', /st === 'WRONG_REWARD' \|\| st === 'CLAIMED_OTHER_VALUE'\) \? '🟡'/.test(intakeSrc));
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
  ? `🏆 6+ FILE + HONEST CLAIM — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
