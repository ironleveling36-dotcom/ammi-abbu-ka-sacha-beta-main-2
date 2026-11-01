/**
 * v67 — EXTRA ₹50 + WEEKEND bhi claim hone chahiye (asli bug fix)
 *
 * Boss: "BOT IS STILL NOT ABLE TO CLAIM THE OTHER OFFER — ONLY LATE NIGHT AND
 *        BREAKFAST".
 *
 * Wajah: `pick-your-offer` aur `byo-weekend` page apne campaign id HTML/JSON me
 * NAHI dete (LN/BF dete hain — `notifyCampaignIdPrefix`). Isliye engine ko id
 * milti hi nahi thi aur woh `NO_CAMPAIGN_ID` par ruk jata tha.
 *
 * Ab: id ka anumaan nahi — candidates KO LIVE likh kar read-back se verify karte
 * hain; jo id verify ho wahi asli id hai, aur woh 6 ghante cache hoti hai
 * (19 ID par sirf ek hi baar discovery). Yeh test wahi asli situation mock
 * karta hai: page bilkul khaali, sirf asli campaign ids hi "save" hote hain.
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

const offers = await import('./event-offers.js');
const doctor = await import('./offer-claim-doctor.js');
const views = await import('./account-views.js');

// Swiggy ka din 11:00 IST par badalta hai — wahi hisaab.
const now = Date.now();
const H = 3600 * 1000;
const ist = new Date(now + 5.5 * H);
const DAY = ist.getUTCHours() < 11 ? ist.getUTCDate() - 1 : ist.getUTCDate();
const REAL_X50 = `byo-pick-your-offer-v2-${DAY}`;
const REAL_WKND = `byo-weekend-v1-${DAY}`;
// 29-10-2026 naya offer — Karwa Chauth (slug byo-karwa-chauth-...).
const REAL_KC = `byo-karwa-chauth-v1-${DAY}`;

// Asli pages: LN/BF par prefix hota hai, Extra ₹50 / Weekend par KUCH NAHI.
const PAGE = {
  'pick-your-late-night-offer': `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"nexusData":{"notifyCampaignIdPrefix":"byo-ln-v5-"}}}}</script></html>`,
  'book-your-offer': `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"nexusData":{"notifyCampaignIdPrefix":"byo-bf-v10-"}}}}</script></html>`,
  'pick-your-offer': '<html><body><div id="__next">Extra ₹50 offer</div><script src="/_next/static/chunk.js"></script></body></html>',
  'byo-weekend': '<html><body><div id="__next">Weekend offer</div><script src="/_next/static/chunk.js"></script></body></html>',
  'karwa-chauth-byo': '<html><body><div id="__next">Karwa Chauth · Pick ₹50 cash</div></body></html>'
};

/**
 * Mock Swiggy: sirf ASLI campaign ids par write "save" hota hai. Jhooti id par
 * POST 200 deta hai par state nahi badalta (bilkul asli jaisa).
 */
const REAL_WINDOWED = [`byo-ln-v5-${DAY}`, `byo-ln-v5-${DAY + 1}`, `byo-bf-v10-${DAY}`, `byo-bf-v10-${DAY + 1}`];
const ALL_REAL = [REAL_X50, REAL_WKND, REAL_KC, ...REAL_WINDOWED];

function makeSwiggy({ realIds = ALL_REAL, forceValue = null, deadWrite = false } = {}) {
  const state = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: target, method, body });

    const slug = target.replace('https://events.swiggy.com/', '').split('?')[0];
    if (PAGE[slug]) {
      return { ok: true, status: 200, text: async () => PAGE[slug], json: async () => ({}) };
    }
    if (target.includes('/api/notify')) {
      const campaign = method === 'GET'
        ? decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0])
        : (body?.campaign || '');
      if (method === 'GET') {
        const rec = state.get(campaign) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec, timestamp: new Date().toISOString() }) };
      }
      if (deadWrite) {
        return { ok: false, status: 403, json: async () => ({ message: 'WAF' }), text: async () => '' };
      }
      if (realIds.includes(campaign)) {
        state.set(campaign, { shouldNotify: true, value: forceValue ? Number(forceValue) : Number(body?.value || 1) });
      }
      return { ok: true, status: 200, json: async () => ({ statusCode: 0, message: 'Done Successfully' }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { fetchImpl, state, calls };
}

const ACC1 = { id: 'acc_ladder_1', phone: '9876500111', token: 'tok-1', tid: 'a.b.c' };
const ACC2 = { id: 'acc_ladder_2', phone: '9876500222', token: 'tok-2', tid: 'a.b.c' };

console.log('\n=== 1. Page par id NAHI hai — engine ko pata hai (yahi asli bug tha) ===');
{
  const x50 = offers.extractCampaignInfoFromHtml(PAGE['pick-your-offer'], offers.getEventOffer('extra50'));
  const wk = offers.extractCampaignInfoFromHtml(PAGE['byo-weekend'], offers.getEventOffer('weekend'));
  check('Extra ₹50 page se koi id nahi milti (jaisa asli page)', !x50.fixedCampaignId && !x50.prefix, JSON.stringify(x50));
  check('Weekend page se koi id nahi milti', !wk.fixedCampaignId && !wk.prefix, JSON.stringify(wk));
  check('candidate ladder maujood hai (extra50)', (offers.getEventOffer('extra50').candidates(DAY) || []).length >= 6);
  check('candidate ladder me asli id sabse pehle', offers.getEventOffer('extra50').candidates(DAY)[0] === REAL_X50);
  check('weekend ladder me asli id shamil', offers.getEventOffer('weekend').candidates(DAY).includes(REAL_WKND));
}

console.log('\n=== 2. CHAARON claim — Extra ₹50 + Weekend bhi (write + read-back verify) ===');
{
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  const mock = makeSwiggy();
  const out = await offers.activateAllEventOffers(ACC1, { fetchImpl: mock.fetchImpl, force: true });

  check('chaaron offer ka result', ['lateNight', 'breakfast', 'extra50', 'weekend'].every((k) => out.offers[k]));
  check('Late Night CLAIMED', out.offers.lateNight.status === 'CLAIMED');
  check('Breakfast CLAIMED', out.offers.breakfast.status === 'CLAIMED');
  check('Extra ₹50 CLAIMED (pehle NO_CAMPAIGN_ID tha)', out.offers.extra50.status === 'CLAIMED', JSON.stringify({ s: out.offers.extra50.status, m: out.offers.extra50.message }));
  check('Weekend CLAIMED (pehle NO_CAMPAIGN_ID tha)', out.offers.weekend.status === 'CLAIMED', JSON.stringify({ s: out.offers.weekend.status, m: out.offers.weekend.message }));
  check('Extra ₹50 ka sahi campaign id mila', out.offers.extra50.campaign === REAL_X50, out.offers.extra50.campaign);
  check('Weekend ka sahi campaign id mila', out.offers.weekend.campaign === REAL_WKND, out.offers.weekend.campaign);
  check('Extra ₹50 ka source CANDIDATE_VERIFIED', out.offers.extra50.metaSource === 'CANDIDATE_VERIFIED', out.offers.extra50.metaSource);
  check('Weekend ka source CANDIDATE_VERIFIED', out.offers.weekend.metaSource === 'CANDIDATE_VERIFIED', out.offers.weekend.metaSource);
  check('har offer verified (read-back)', ['lateNight', 'breakfast', 'extra50', 'weekend', 'karwaChauth'].every((k) => out.offers[k].verified === true));
  check('summary: saare claimed / 0 failed', out.summary.claimed === 5 && out.summary.failed === 0, JSON.stringify(out.summary));
  check('Karwa Chauth CLAIMED (naya offer bhi)', out.offers.karwaChauth.status === 'CLAIMED', JSON.stringify({ s: out.offers.karwaChauth.status, m: out.offers.karwaChauth.message }));
  check('allActive true', out.allActive === true);

  const writes = mock.calls.filter((c) => c.method !== 'GET');
  check('Swiggy par sirf verified campaigns hi bache (7)', mock.state.size === 7, JSON.stringify([...mock.state.keys()]));
  check('junk id par likhna bhi verify nahi hua (jhooth nahi)', mock.state.has('byo-pick-your-offer') === false);
  check('discovery writes bounded (≤3 per fixed offer)', out.offers.extra50.tried.filter((t) => t.phase === 'write').length <= 3, JSON.stringify(out.offers.extra50.tried));
}

console.log('\n=== 3. Doosri ID par discovery dobara nahi (cache) ===');
{
  offers.resetEventOfferMetaCache();
  const mock = makeSwiggy();
  const before = mock.calls.length;
  const out = await offers.activateAllEventOffers(ACC2, { fetchImpl: mock.fetchImpl, force: true });
  const x50Tried = (out.offers.extra50.tried || []).length;
  check('doosri ID par bhi chaaron claim', out.offers.extra50.status === 'CLAIMED' && out.offers.weekend.status === 'CLAIMED');
  check('cached id se chala (source CACHED_RESOLVED)', out.offers.extra50.metaSource === 'CACHED_RESOLVED', out.offers.extra50.metaSource);
  check('cached path me ladder dobara nahi chali (0 naye probe)', x50Tried === 0, JSON.stringify(out.offers.extra50.tried));
  check('cache hit par purana discovery record sambhal kar rakha', (out.offers.extra50.cachedTried || []).length > 0);
  check('is ID par sirf 1-1 write (extra50 + weekend)', out.offers.extra50.writes === 1 && out.offers.weekend.writes === 1, JSON.stringify({ x: out.offers.extra50.writes, w: out.offers.weekend.writes }));
}

console.log('\n=== 4. Jhooti id se claim nahi hota — asli reason milta hai ===');
{
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  // Swiggy par koi bhi expected id kaam nahi karti (offer user ke liye hi nahi).
  // LN/BF theek chal rahe hain (jaisa boss ne bola) — sirf Extra ₹50 / Weekend fail.
  const mock = makeSwiggy({ realIds: REAL_WINDOWED });
  const out = await offers.activateAllEventOffers(ACC1, { fetchImpl: mock.fetchImpl, force: true });
  check('Extra ₹50 par jhootha CLAIMED nahi', out.offers.extra50.status !== 'CLAIMED', out.offers.extra50.status);
  check('state NO_CAMPAIGN_ID', out.offers.extra50.state === 'NO_CAMPAIGN_ID', out.offers.extra50.state);
  check('reason me "campaign id nahi bataya" + candidates', /campaign id nahi bataya/i.test(out.offers.extra50.message) && /byo-pick-your-offer/.test(out.offers.extra50.message), out.offers.extra50.message);
  check('tried list report hoti hai', Array.isArray(out.offers.extra50.tried) && out.offers.extra50.tried.length > 0);
  check('summary me failed gina (extra50 + weekend + karwaChauth)', out.summary.failed === 3, JSON.stringify(out.summary));

  const writes1 = mock.calls.filter((c) => c.method !== 'GET').length;
  const again = await offers.activateAllEventOffers(ACC1, { fetchImpl: mock.fetchImpl, force: false });
  const writes2 = mock.calls.filter((c) => c.method !== 'GET').length;
  check('fail ke baad dobara spam nahi (negative cache)', writes2 === writes1, `first=${writes1} after=${writes2}`);
  check('dusri baar bhi NO_CAMPAIGN_ID', again.offers.extra50.state === 'NO_CAMPAIGN_ID');
}

console.log('\n=== 5. Campaign apna option force kare to ₹50 CLAIMED nahi (sach) ===');
{
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  const mock = makeSwiggy({ forceValue: 3 }); // Swiggy ne option 3 (coupon) hi lagaya
  const out = await offers.activateAllEventOffers(ACC1, { fetchImpl: mock.fetchImpl, force: true });
  // ₹50 free cash = option 1. Coupon save hona "claimed" NAHI hai (yahi jhooth tha).
  check('Extra ₹50 par jhootha CLAIMED nahi', out.offers.extra50.status === 'WRONG_REWARD', JSON.stringify({ s: out.offers.extra50.status, m: out.offers.extra50.message }));
  check('state WRONG_REWARD', out.offers.extra50.state === 'WRONG_REWARD', out.offers.extra50.state);
  check('reason me ₹50 free cash nahi mila likha hai', /₹50 free cash \(option 1\) nahi mila/.test(String(out.offers.extra50.message)), out.offers.extra50.message);
  check('verified false (option 1 save nahi hua)', out.offers.extra50.verified === false);
}

console.log('\n=== 6. Doctor bhi ab Extra ₹50 / Weekend ka id jaanta hai ===');
{
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  const mock = makeSwiggy();
  await offers.activateAllEventOffers(ACC1, { fetchImpl: mock.fetchImpl, force: true });
  check('resolved id cache me hai', offers.cachedFixedCampaignId('extra50')?.id === REAL_X50, JSON.stringify(offers.cachedFixedCampaignId('extra50')));

  const meta = await doctor.loadOfferCampaignMeta({ force: true, fetchImpl: mock.fetchImpl });
  check('doctor meta me Extra ₹50 id (cache se)', meta.x50Campaign === REAL_X50, JSON.stringify({ x: meta.x50Campaign, s: meta.x50Source }));
  check('doctor meta me Weekend id', meta.wkndCampaign === REAL_WKND, String(meta.wkndCampaign));
  const row = doctor.resolveTrackCampaigns(meta, 'extra50', Date.now());
  check('doctor ka fixed track row bana', row.rows.length === 1 && row.rows[0].campaign === REAL_X50);
}

console.log('\n=== 7. Card sach dikhata hai: chaar ✅ ₹50 ===');
{
  const truth = views.fourOfferTruthFromActivation ? null : null; // compat guard
  const block = views.fourOfferStatusBlock({
    offerAutoActivation: {
      lateNight: { status: 'CLAIMED' }, breakfast: { status: 'CLAIMED' },
      extra50: { status: 'CLAIMED' }, weekend: { status: 'CLAIMED' }, karwaChauth: { status: 'CLAIMED' }
    }
  });
  check('har line par ✅ + ₹50', (block.match(/✅/g) || []).length === 5 && (block.match(/₹50/g) || []).length >= 5, block);
  check('score 5/5 · ₹250 pakka', /5\/5 claimed/.test(block) && /₹250 pakka/.test(block));

  const partial = views.fourOfferStatusBlock({
    offerAutoActivation: {
      lateNight: { status: 'CLAIMED' }, breakfast: { status: 'CLAIMED' },
      extra50: { status: 'NO_CAMPAIGN_ID', message: 'Swiggy ne campaign id nahi bataya' },
      weekend: { status: 'FAILED', message: 'HTTP 403' }
    }
  });
  check('fail par ✅ nahi', (partial.match(/✅/g) || []).length === 2);
  check('reason card me dikhta hai', /campaign id nahi bataya/.test(partial), partial);
}

console.log('\n=== 8. Page khaali ho to API se + env se id discovery ===');
{
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  // Is baar asli id bilkul naye naam ki hai — built-in ladder me hai hi nahi.
  const API_ID = `byo-x50-special-${DAY}`;
  const state = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: target, method, body });
    if (target.includes('/api/campaign/pick-your-offer')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ campaignId: API_ID, name: 'Extra 50' }), json: async () => ({ campaignId: API_ID }) };
    }
    const slug = target.replace('https://events.swiggy.com/', '').split('?')[0];
    if (PAGE[slug]) return { ok: true, status: 200, text: async () => PAGE[slug], json: async () => ({}) };
    if (target.includes('/api/notify')) {
      const campaign = method === 'GET'
        ? decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0])
        : (body?.campaign || '');
      if (method === 'GET') {
        const rec = state.get(campaign) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec }) };
      }
      if (campaign === API_ID) state.set(campaign, { shouldNotify: true, value: Number(body?.value || 1) });
      return { ok: true, status: 200, json: async () => ({ statusCode: 0 }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const out = await offers.activateAllEventOffers(ACC1, { fetchImpl, force: true, offerKeys: ['extra50'] });
  check('API se nayi id mili aur claim hua', out.offers.extra50.status === 'CLAIMED' && out.offers.extra50.campaign === API_ID, JSON.stringify({ s: out.offers.extra50.status, c: out.offers.extra50.campaign }));
  check('API discovery ka source report hua', /CANDIDATE_VERIFIED/.test(out.offers.extra50.metaSource), out.offers.extra50.metaSource);

  // Env se force karna (ops escape hatch)
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  const ENV_ID = `byo-weekend-env-${DAY}`;
  process.env.EVENT_OFFER_EXTRA_CANDIDATES = `weekend:${ENV_ID}`;
  const mock2 = makeSwiggy({ realIds: [ENV_ID] });
  const out2 = await offers.activateAllEventOffers(ACC1, { fetchImpl: mock2.fetchImpl, force: true, offerKeys: ['weekend'] });
  check('env se di gayi id claim hui', out2.offers.weekend.status === 'CLAIMED' && out2.offers.weekend.campaign === ENV_ID, JSON.stringify({ s: out2.offers.weekend.status, c: out2.offers.weekend.campaign }));
  delete process.env.EVENT_OFFER_EXTRA_CANDIDATES;
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
  ? `🏆 EXTRA ₹50 + WEEKEND BHI CLAIM — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
