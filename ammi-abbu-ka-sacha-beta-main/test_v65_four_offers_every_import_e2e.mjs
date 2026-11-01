/**
 * v65 — SAARE OFFER, HAR FILE PAR, EK HI BAAR (no double claim)
 *
 * Boss (26-10-2026 raat) ne chaar link diye:
 *   Morning  → pick-your-late-night-offer
 *   Night    → book-your-offer
 *   Extra 50 → pick-your-offer
 *   Weekend  → byo-weekend
 *   "JAB BHI FILE BHEJU SAARE OFFER ACTIVATE HONE CHAHIYE"
 * aur complaint: "2 times claim ho rha tha jo 9 bje se pehle wala kiya tha".
 *
 * Yeh test (offline, mock Swiggy) proves:
 *   1. Chaaron offers ke campaign id live page se nikalte hain
 *      (__NEXT_DATA__ prefix / page JSON / HTML scan).
 *   2. JSON import par CHAARON claim hote hain — ₹50-on-₹199 (option 1).
 *   3. Dobara import / dobara claim → koi extra write NAHI (double claim band).
 *   4. Write ke baad read-back se verify — "HTTP 200" ko success nahi maana
 *      jata; jhoota save pakda jata hai.
 *   5. Ek hi account par ek waqt me ek run (import + cart scan share karte hain).
 *   6. Jo offer nahi hua, uska asli reason (no fake ✓), aur WAF 403 par retry.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

const DB_PATH = 'data/db.json';
const ACCOUNTS_MIRROR_PATH = 'accounts.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
const mirrorSnapshot = fs.existsSync(ACCOUNTS_MIRROR_PATH) ? fs.readFileSync(ACCOUNTS_MIRROR_PATH, 'utf8') : null;
process.on('exit', () => restoreState());

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const offers = await import('./event-offers.js');
const bridge = await import('./swiggy-bridge.js');
const doctor = await import('./offer-claim-doctor.js');
const views = await import('./account-views.js');
const intake = await import('./account-vault-intake.js');
const store = await import('./store.js');

const DAY = 26;
const PAGE_HTML = {
  lateNight: `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"nexusData":{"notifyCampaignIdPrefix":"byo-ln-v5-","dayBoundaries":[{"day":${DAY},"startTime":"2026-10-25T05:30:00Z","endTime":"2026-10-26T05:30:00Z"},{"day":${DAY + 1},"startTime":"2026-10-26T05:30:00Z","endTime":"2026-10-27T05:30:00Z"}]}}}}</script></html>`,
  breakfast: `<html><script id="__NEXT_DATA__">{"props":{"pageProps":{"nexusData":{"notifyCampaignIdPrefix":"byo-bf-v10-"}}}}</script></html>`,
  extra50: `<html><div data-campaign="byo-pick-your-offer-v2-${DAY}">Extra ₹50</div></html>`,
  weekend: `<html><script id="__NEXT_DATA__">{"props":{"pageProps":{"nexusData":{"notifyCampaignId":"byo-weekend-v3"}}}}</script></html>`,
  // 29-10-2026: Karwa Chauth page apni campaign id HTML me nahi deti (asli
  // Swiggy jaisa) — id live write + read-back se verify hoti hai.
  karwaChauth: `<html><div>Karwa Chauth · Pick ₹50 cash</div></html>`
};

/** Mock Swiggy: pages + /api/notify (GET state, POST/PATCH writes) with a real store. */
function makeMockServer({ saveWrites = true, forbid = null } = {}) {
  const state = new Map();      // campaign -> { shouldNotify, value }
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: target, method, body: init.body ? JSON.parse(init.body) : null });
    if (forbid && forbid(target, method)) {
      return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ message: 'forbidden' }), text: async () => '' };
    }
    for (const [key, html] of Object.entries(PAGE_HTML)) {
      const pageSlug = key === 'extra50' ? 'pick-your-offer'
        : key === 'weekend' ? 'byo-weekend'
          : key === 'karwaChauth' ? 'karwa-chauth-byo'
            : key === 'breakfast' ? 'book-your-offer' : 'pick-your-late-night-offer';
      if (target.includes(`/${pageSlug}`)) {
        return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
      }
    }
    if (target.includes('/api/notify')) {
      if (method === 'GET') {
        const campaign = decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0]);
        const rec = state.get(campaign) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec, timestamp: new Date().toISOString() }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (saveWrites) {
        state.set(body.campaign, { shouldNotify: true, value: Number(body.value) });
      }
      return { ok: true, status: 200, json: async () => ({ statusCode: 0, message: 'Done Successfully' }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { fetchImpl, state, calls };
}

const ACCOUNT = {
  id: 'acc_offer_test',
  name: 'Offer Test',
  phone: '9876500123',
  token: 'tok-offer-test',
  tid: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig',
  cookies: 'token=tok-offer-test; tid=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig',
  isLoggedIn: true
};

console.log('\n=== 1. Chaar links ka registry + campaign discovery ===');
{
  check('saare boss links registry me hain', Object.keys(offers.EVENT_OFFER_LINKS).length === offers.EVENT_OFFERS.length && offers.EVENT_OFFERS.length >= 5, JSON.stringify(Object.keys(offers.EVENT_OFFER_LINKS)));
  check('Morning link = pick-your-late-night-offer', offers.EVENT_OFFER_LINKS.lateNight.includes('pick-your-late-night-offer'));
  check('Night link = book-your-offer', offers.EVENT_OFFER_LINKS.breakfast.includes('book-your-offer'));
  check('Extra ₹50 link = pick-your-offer', offers.EVENT_OFFER_LINKS.extra50.endsWith('/pick-your-offer'));
  check('Weekend link = byo-weekend', offers.EVENT_OFFER_LINKS.weekend.includes('byo-weekend'));
  check('Karwa Chauth link = karwa-chauth-byo', offers.EVENT_OFFER_LINKS.karwaChauth.includes('karwa-chauth-byo'));

  const ln = offers.extractCampaignInfoFromHtml(PAGE_HTML.lateNight, offers.getEventOffer('lateNight'));
  check('__NEXT_DATA__ se LN prefix mila', ln.prefix === 'byo-ln-v5-', JSON.stringify(ln));
  check('LN day boundaries bhi mile', ln.boundaries.length === 2);
  const bf = offers.extractCampaignInfoFromHtml(PAGE_HTML.breakfast, offers.getEventOffer('breakfast'));
  check('__NEXT_DATA__ se BF prefix mila', bf.prefix === 'byo-bf-v10-');
  const x50 = offers.extractCampaignInfoFromHtml(PAGE_HTML.extra50, offers.getEventOffer('extra50'));
  check('Extra ₹50 ka EXACT campaign id (day-number guess nahi)', x50.fixedCampaignId === `byo-pick-your-offer-v2-${DAY}`, JSON.stringify(x50));
  const wk = offers.extractCampaignInfoFromHtml(PAGE_HTML.weekend, offers.getEventOffer('weekend'));
  check('Weekend ka campaign id NEXT_DATA se', wk.fixedCampaignId === 'byo-weekend-v3', JSON.stringify(wk));
  check('page khaali ho to jhoota id nahi banta', offers.extractCampaignInfoFromHtml('<html>nothing</html>', offers.getEventOffer('extra50')).fixedCampaignId === '');
  check('slug se campaign id guess nahi hoti (SLUG_GUESS hata diya)', !/SLUG_GUESS/.test(fs.readFileSync('./event-offers.js', 'utf8')));
  const noId = offers.campaignIdsForOffer('weekend', { weekend: { fixedCampaignId: '', source: 'NONE' } }, Date.now());
  check('id na mile to claim list khaali', noId.ids.length === 0);
}

console.log('\n=== 2. Chaaron offers claim (option 1 = ₹50 on ₹199) ===');
{
  offers.resetEventOfferMetaCache();
  const mock = makeMockServer();
  const out = await offers.activateAllEventOffers(ACCOUNT, { fetchImpl: mock.fetchImpl, force: true });

  const keys = offers.EVENT_OFFER_KEYS;
  check('saare offers ka result hai', keys.every((k) => out.offers[k]), JSON.stringify(Object.keys(out.offers)));
  check('saare CLAIMED', keys.every((k) => out.offers[k].status === 'CLAIMED'), JSON.stringify(keys.map((k) => [k, out.offers[k].status])));
  check('saare verified (read-back)', keys.every((k) => out.offers[k].verified === true));
  check('summary: saare claimed / 0 failed', out.summary.claimed === keys.length && out.summary.failed === 0, JSON.stringify(out.summary));
  check('allActive true', out.allActive === true);

  const writes = mock.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH');
  // Morning + Night windowed hain → aaj + kal (2 campaign id each = 4 write);
  // Extra ₹50 + Weekend + Karwa Chauth fixed hain → 1-1 write. Total 7,
  // aur ek bhi duplicate nahi.
  check('7 write: 2+2 (Morning/Night aaj+kal) + 1+1+1 (fixed)', writes.length === 7, `writes=${writes.length}`);
  check('sab writes par value=1 (₹50 on ₹199)', writes.every((w) => Number(w.body?.value) === 1));
  const writtenCampaigns = writes.map((w) => w.body.campaign).sort();
  check('koi campaign do baar nahi likha gaya', new Set(writtenCampaigns).size === writtenCampaigns.length, JSON.stringify(writtenCampaigns));
  check('LN/BF par aaj + kal (2 days) pre-lock hua', out.offers.lateNight.ids.length === 2 && out.offers.breakfast.ids.length === 2);
  check('per-offer write count sach bolta hai', out.offers.lateNight.writes === 2 && out.offers.breakfast.writes === 2 && out.offers.extra50.writes === 1 && out.offers.weekend.writes === 1 && out.offers.karwaChauth.writes === 1, JSON.stringify(keys.map((k) => [k, out.offers[k].writes])));
}

console.log('\n=== 3. DOBARA claim = koi extra write nahi (double claim band) ===');
{
  offers.resetEventOfferMetaCache();
  const mock = makeMockServer();
  await offers.activateAllEventOffers(ACCOUNT, { fetchImpl: mock.fetchImpl, force: true });
  const writesFirst = mock.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;

  // dobara, force ke saath (jaise import + cart scan ek saath)
  const again = await offers.activateAllEventOffers(ACCOUNT, { fetchImpl: mock.fetchImpl, force: true });
  const writesAfter = mock.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;
  check('pehle run me 7 write', writesFirst === 7, `got ${writesFirst}`);
  check('dobara run me ZERO naya write', writesAfter === writesFirst, `first=${writesFirst} after=${writesAfter}`);
  check('dobara run me sab ALREADY active/verified', Object.values(again.offers).every((o) => o.verified && o.alreadyActive));

  // in-flight share: ek hi waqt me 2 callers => ek hi run
  offers.resetEventOfferMetaCache();
  const mock2 = makeMockServer();
  const [a, b] = await Promise.all([
    offers.activateAllEventOffers(ACCOUNT, { fetchImpl: mock2.fetchImpl, force: true }),
    offers.activateAllEventOffers(ACCOUNT, { fetchImpl: mock2.fetchImpl, force: true })
  ]);
  const writes2 = mock2.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;
  check('parallel 2 callers par bhi sirf 7 write (shared run)', writes2 === 7, `writes=${writes2}`);
  check('dono callers ko same summary mila', JSON.stringify(a.summary) === JSON.stringify(b.summary));
}

console.log('\n=== 4. Jhoota save pakda jata hai (read-back verify) ===');
{
  offers.resetEventOfferMetaCache();
  const mock = makeMockServer({ saveWrites: false }); // Swiggy 200 deta hai par save nahi karta
  const out = await offers.activateAllEventOffers(ACCOUNT, { fetchImpl: mock.fetchImpl, force: true });
  check('jhootha save CLAIMED nahi kaha jata', Object.values(out.offers).every((o) => o.status !== 'CLAIMED'), JSON.stringify(Object.values(out.offers).map((o) => o.status)));
  check('state WRITE_NOT_SAVED hai', out.offers.weekend.state === 'WRITE_NOT_SAVED', out.offers.weekend.state);
  check('reason me asli baat likhi hai', /save nahi kiya/i.test(String(out.offers.weekend.message)), String(out.offers.weekend.message));
  check('allActive false (jhoot nahi)', out.allActive === false);
}

console.log('\n=== 5. WAF 403 par retry, aur asli reason ===');
{
  offers.resetEventOfferMetaCache();
  let blocksLeft = 1; // sirf pehla write 403 (WAF burst), retry par chalna chahiye
  const mock = makeMockServer();
  const wrapped = async (url, init = {}) => {
    if (blocksLeft > 0 && String(url).includes('/api/notify') && String(init.method || 'GET').toUpperCase() !== 'GET') {
      blocksLeft -= 1;
      return { ok: false, status: 403, json: async () => ({ message: 'WAF' }), text: async () => '' };
    }
    return mock.fetchImpl(url, init);
  };
  const out = await offers.activateAllEventOffers(ACCOUNT, { fetchImpl: wrapped, force: true, offerKeys: ['weekend'] });
  check('ek 403 ke baad retry hua aur claim ho gaya', out.offers.weekend.status === 'CLAIMED' && out.offers.weekend.verified === true, JSON.stringify({ s: out.offers.weekend.status, m: out.offers.weekend.message }));
  check('retry ke baad bhi sirf ek hi asli write', out.offers.weekend.writes === 1, String(out.offers.weekend.writes));

  // ab hamesha 403: honest reason
  offers.resetEventOfferMetaCache();
  // GET (padhna) chalta hai, sirf WRITE par lagatar 403.
  const okMock = makeMockServer();
  const always403 = async (url, init = {}) => {
    if (String(url).includes('/api/notify') && String(init.method || 'GET').toUpperCase() !== 'GET') {
      return { ok: false, status: 403, json: async () => ({ message: 'blocked' }), text: async () => '' };
    }
    return okMock.fetchImpl(url, init);
  };
  const failedOut = await offers.activateAllEventOffers(ACCOUNT, { fetchImpl: always403, force: true, offerKeys: ['extra50'] });
  check('403 par FAILED (fake success nahi)', failedOut.offers.extra50.status === 'FAILED');
  check('state RATE_LIMITED — "save nahi hua" jhooth nahi', failedOut.offers.extra50.state === 'RATE_LIMITED', String(failedOut.offers.extra50.state));
  check('reason me asli HTTP 403 ka zikr', /403/.test(String(failedOut.offers.extra50.message)), String(failedOut.offers.extra50.message));
  check('rok di gayi request write me nahi ginti', failedOut.offers.extra50.writes === 0, String(failedOut.offers.extra50.writes));
}

console.log('\n=== 6. Bridge + import + doctor + card, sab chaar dikhate hain ===');
{
  offers.resetEventOfferMetaCache();
  const mock = makeMockServer();
  const out = await bridge.autoActivateEventOffers(ACCOUNT, { force: true, fetchImpl: mock.fetchImpl });
  check('bridge: claimedCount = saare offer', out.claimedCount === offers.EVENT_OFFER_KEYS.length, String(out.claimedCount));
  check('bridge: allFourClaimed true (saare lage)', out.allFourClaimed === true);
  check('bridge: breakfast/lateNight/extra50/weekend/karwaChauth maujood',
    ['breakfast', 'lateNight', 'extra50', 'weekend', 'karwaChauth'].every((k) => out[k] && out[k].status === 'CLAIMED'));
  check('bridge: saare link response me hain', Object.keys(out.links || {}).length === offers.EVENT_OFFER_KEYS.length);

  const viewsTruth = views.offerClaimTruth({
    offers: out.offers,
    offerAutoActivation: { offerValue: 1, label: out.label, at: out.at, ...out.offers }
  });
  check('account card saare offer dikhata hai', viewsTruth.allFour === true && viewsTruth.claimedCount === views.OFFER_TRACK_COUNT, JSON.stringify({ all: viewsTruth.allFour, n: viewsTruth.claimedCount }));
  const detail = views.accountDetailText({ acc: { name: 'X', phone: '9876500123', offers: out.offers }, key: 'acc_offer_test' });
  check('card text me Extra ₹50 + Weekend lines hain', /Extra ₹50/.test(detail.text) && /Weekend/.test(detail.text));

  // doctor: chaar tracks
  const meta = await doctor.loadOfferCampaignMeta({ force: true, fetchImpl: mock.fetchImpl });
  check('doctor meta me extra50 campaign mila', Boolean(meta.x50Campaign), JSON.stringify({ x50: meta.x50Campaign, wknd: meta.wkndCampaign }));
  check('doctor meta me weekend campaign mila', Boolean(meta.wkndCampaign));
  for (const key of ['extra50', 'weekend', 'karwaChauth']) {
    const track = doctor.resolveTrackCampaigns(meta, key, Date.now());
    check(`doctor track "${key}" ka campaign row hai`, track.rows.length === 1 && Boolean(track.rows[0].campaign), JSON.stringify(track.rows));
  }
  check('doctor saare tracks probe karta hai (source)',
    /OFFER_TRACK_KEYS = \['lateNight', 'breakfast', 'extra50', 'weekend', 'karwaChauth'\]/.test(fs.readFileSync('./offer-claim-doctor.js', 'utf8')));

  const intakeSrc = fs.readFileSync('./account-vault-intake.js', 'utf8');
  check('JSON import chaaron offers save karta hai', /hasExtra50/.test(intakeSrc) && /hasWeekend/.test(intakeSrc));
  check('import discount count me chaaron ginte hain', /if \(target\.hasExtra50\) possibleDiscounts/.test(intakeSrc));
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check('boss panel me chaaron offer link buttons hain', ['Morning Link', 'Night Link', 'Extra ₹50 Link', 'Weekend Link'].every((t) => indexSrc.includes(t)));
  check('2 ghante wala pre-book sweep chaaron claim karta hai', /const out = await autoActivateEventOffers\(acc, \{/.test(indexSrc));
}

console.log('\n=== 7. Import end-to-end: file bhejo → chaaron activate ===');
{
  offers.resetEventOfferMetaCache();
  store.mutateDb((d) => { d.orders = {}; d.config.accounts = {}; d.config.deletedAccounts = {}; });
  const mock = makeMockServer();
  const res = await intake.ingestAndPersistRawAccountTexts(
    [{ fileName: '9876500123.json', text: JSON.stringify({ name: 'Offer Test', mobile: '9876500123', token: 'tok-offer-test', tid: ACCOUNT.tid, sid: 'sid', deviceId: 'dev' }) }],
    {
      verifyFn: async (c) => ({ valid: true, phone: c.phone, liveTid: c.tid, token: c.token, cookies: c.cookies }),
      orderProfileFn: async () => ({ valid: true, totalOrdersCount: 0, isZeroOrderAccount: true, ordersVerifiedLive: true, offers: {} }),
      claimOffersFn: (acc) => bridge.autoActivateEventOffers(acc, { force: true, fetchImpl: mock.fetchImpl }),
      syncVaultFn: async () => true,
      waitForClaims: true,
      concurrency: 1,
      claimConcurrency: 1
    }
  );
  const db = store.getDb();
  const savedKey = Object.keys(db.config.accounts).find((k) => /9876500123/.test(k) || /9876500123/.test(String(db.config.accounts[k]?.phone || '')));
  check('savedAccounts me account aaya', res.savedAccounts.length === 1, JSON.stringify(res.savedAccounts.map((a) => a.key)));
  const acc = savedKey ? db.config.accounts[savedKey] : null;
  check('file import se account save hua', Boolean(acc), JSON.stringify(Object.keys(db.config.accounts)));
  check('account par chaaron offers ka sach save hua', Boolean(acc?.hasExtra50 && acc?.hasWeekend), JSON.stringify({ bf: acc?.hasBreakfast, ln: acc?.hasLateNight, x50: acc?.hasExtra50, wk: acc?.hasWeekend }));
  check('offerAutoActivation me chaaron records hain', Boolean(acc?.offerAutoActivation?.extra50 && acc?.offerAutoActivation?.weekend));
  check('allFourClaimed true (import par)', acc?.offerAutoActivation?.allFourClaimed === true, JSON.stringify(acc?.offerAutoActivation && { n: acc.offerAutoActivation.claimedCount }));
  const writes = mock.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length;
  check('import par 7 hi write (double claim nahi)', writes === 7, `writes=${writes}`);
}

console.log('\n=== 8. Band window = PRE_LOCK (ek baar likha, dobara nahi) ===');
{
  offers.resetEventOfferMetaCache();
  // Swiggy ka din 11:00 IST par badalta hai — wahi hisaab yahan bhi.
  const now = Date.now();
  const H = 3600 * 1000;
  const ist = new Date(now + 5.5 * H);
  const day = ist.getUTCHours() < 11 ? ist.getUTCDate() - 1 : ist.getUTCDate();
  const future = {
    lateNight: `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { nexusData: {
      notifyCampaignIdPrefix: 'byo-ln-v5-',
      dayBoundaries: [
        { day, startTime: new Date(now + 30 * H).toISOString(), endTime: new Date(now + 49 * H).toISOString() },
        { day: day + 1, startTime: new Date(now + 54 * H).toISOString(), endTime: new Date(now + 73 * H).toISOString() }
      ]
    } } } })}</script></html>`
  };
  const state = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: target, method, body: init.body ? JSON.parse(init.body) : null });
    if (target.includes('/pick-your-late-night-offer')) {
      return { ok: true, status: 200, text: async () => future.lateNight, json: async () => ({}) };
    }
    if (target.includes('/api/notify')) {
      if (method === 'GET') {
        const c = decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0]);
        const rec = state.get(c) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec }) };
      }
      // Swiggy band slot par 200 deta hai par state save nahi karta.
      return { ok: true, status: 200, json: async () => ({ statusCode: 0, message: 'Done Successfully' }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  const first = await offers.activateAllEventOffers({ id: 'acc_prelock', token: 't', tid: 'a.b.c' }, { fetchImpl, force: true, offerKeys: ['lateNight'], meta: { lateNight: offers.extractCampaignInfoFromHtml(future.lateNight, offers.getEventOffer('lateNight')) } });
  const writes1 = calls.filter((c) => c.method !== 'GET').length;
  check('band window par 2 din pre-lock (2 write)', writes1 === 2, `writes=${writes1}`);
  check('status PRE_LOCKED (jhootha ✓ nahi)', first.offers.lateNight.status === 'PRE_LOCKED', JSON.stringify({ s: first.offers.lateNight.status, st: first.offers.lateNight.state }));
  check('reason sach bolta hai', /pre-lock/i.test(String(first.offers.lateNight.message)), String(first.offers.lateNight.message));
  check('summary me preLocked gina', first.summary.preLocked === 1, JSON.stringify(first.summary));
  check('allActive false (claim nahi hua)', first.allActive === false);

  const second = await offers.activateAllEventOffers({ id: 'acc_prelock', token: 't', tid: 'a.b.c' }, { fetchImpl, force: true, offerKeys: ['lateNight'], meta: { lateNight: offers.extractCampaignInfoFromHtml(future.lateNight, offers.getEventOffer('lateNight')) } });
  const writes2 = calls.filter((c) => c.method !== 'GET').length;
  check('force ke baad bhi ZERO naya write', writes2 === writes1, `first=${writes1} after=${writes2}`);
  check('dusri baar bhi PRE_LOCKED', second.offers.lateNight.status === 'PRE_LOCKED');

  const truth = views.offerClaimTruth({ offers: { lateNight: first.offers.lateNight } });
  check('card PRE_LOCK ko ⏳ dikhata hai', /Pre-locked/.test(truth.lateNight.label), truth.lateNight.label);
  check('card claimedCount 0 (fake claim nahi)', truth.claimedCount === 0);
}

console.log('\n=== 9. Shared ledger + 14-din pre-book + compact card ===');
{
  const acc = { id: 'acc_ledger', token: 't', tid: 'a.b.c' };
  offers.noteCampaignClaim(acc, 'byo-ln-v5-99', { value: 1, verified: true, state: 'CLAIMED' });
  const rec = offers.recentCampaignClaim(acc, 'byo-ln-v5-99');
  check('ledger me claim note hua', rec && rec.verified === true && rec.value === 1, JSON.stringify(rec));
  check('doosre account par leak nahi', offers.recentCampaignClaim({ id: 'acc_other' }, 'byo-ln-v5-99') === null);

  const bridgeSrc = fs.readFileSync('./swiggy-bridge.js', 'utf8');
  check('purana claim path ledger poochta hai', /const recent = recentCampaignClaim\(account, campaignId\);/.test(bridgeSrc));
  check('purana claim path write ke baad ledger note karta hai', /noteCampaignClaim\(account, campaignId, \{ value: chosenVal/.test(bridgeSrc));
  check('14 din tak pre-book', /Math\.min\(14, Math\.max\(1, maxDay - currentDay \+ 1\)\)/.test(bridgeSrc));
  check('writes 5 ke batch me', /const BATCH_CONCURRENCY = 5;/.test(bridgeSrc));
  check('autoActivateEventOffers skipIfRunInFlight leta hai', /skipIfRunInFlight = false/.test(bridgeSrc));

  const fwdSrc = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('forwarded flow chaar offers engine se claim karta hai', (fwdSrc.match(/autoActivateEventOffers\(acc, \{ force: false, skipIfRunInFlight: true \}\)/g) || []).length === 3);
  check('forwarded flow me purana 2-offer claim nahi bacha', !/claimSwiggyBreakfastAndLateNightOffers\(acc, \{ force: true \}\)/.test(fwdSrc));

  const allClaimed = Object.fromEntries(views.OFFER_TRACKS.map((t) => [t.key, { status: 'CLAIMED' }]));
  const line = views.compactAccountLine({ name: 'X', phone: '9876500999', offers: allClaimed }, 'acc_x', { index: 1 });
  check('compact line sab lage to ✓ dikhati hai', new RegExp(`${views.OFFER_TRACK_COUNT}/${views.OFFER_TRACK_COUNT}`).test(line), line);
  const line2 = views.compactAccountLine({ name: 'Y', phone: '9876500888', offers: { breakfast: { status: 'CLAIMED' }, lateNight: { status: 'FAILED' } } }, 'acc_y', { index: 2 });
  check('compact line aadha sach dikhati hai (1/5)', /1\/5/.test(line2), line2);
}

function restoreState() {
  try { if (dbSnapshot !== null) fs.writeFileSync(DB_PATH, dbSnapshot); else if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch {}
  try {
    if (mirrorSnapshot !== null) fs.writeFileSync(ACCOUNTS_MIRROR_PATH, mirrorSnapshot);
    else if (fs.existsSync(ACCOUNTS_MIRROR_PATH)) fs.unlinkSync(ACCOUNTS_MIRROR_PATH);
  } catch {}
}
restoreState();

console.log('\n=====================================================================');
console.log(failed === 0
  ? `🏆 CHAAR OFFER — HAR FILE PAR, EK HI BAAR — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
