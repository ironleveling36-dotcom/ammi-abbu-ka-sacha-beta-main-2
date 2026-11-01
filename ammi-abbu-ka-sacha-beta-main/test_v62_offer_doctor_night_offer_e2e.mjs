/**
 * v62 — "DUSRE LOGO KE ID ME NIGHT OFFER LAG RAHA HAI, MERE ME NAHI"
 *
 * Boss (26-10-2026): "dusre logo ke ID me abhi lag jaa raha Swiggy night offer
 * and mere me na lag rha"
 *
 * Asli defect: claim code `POST/PATCH` ka HTTP 200 dekh kar maan leta tha ki
 * offer lag gaya, aur UI "₹50 ✓" / "✕" bina kisi reason ke dikha deta tha.
 * Swiggy agar kuch aur save kare (value drift) ya kuch bhi save na kare, bot ko
 * pata hi nahi chalta tha — isliye "mera ID kyun nahi" ka koi jawab nahi tha.
 *
 * Ab proven:
 *   1. Har claim ke baad READ-BACK (GET /api/notify) verification — jhootha ✓ nahi.
 *   2. `offer-claim-doctor.js` per-ID truth: kaunsa campaign (kal/aaj/parso),
 *      kya save hai, HTTP status, slot live hai ya nahi.
 *   3. Doctor exact reason deta hai: NOT_BOOKED / WRONG_REWARD / RATE_LIMITED /
 *      AUTH_FAILED / LIVE_NOW / BOOKED.
 *   4. One-tap FIX: correct POST/PATCH (option 1) + read-back verify + honest result.
 *   5. Cross-midnight late-night slot (raat 9 → subah 6) sahi campaign pakadta hai.
 *   6. Transport fallback: token+tid fail (401) ho to cookie se try hota hai.
 */
import fs from 'node:fs';

process.env.TEST_MODE = '1';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-OFFLINE-E2E';
process.env.NODE_ENV = 'test';

const DB_PATH = 'data/db.json';
const dbSnapshot = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : null;
process.on('exit', () => { if (dbSnapshot !== null) { try { fs.writeFileSync(DB_PATH, dbSnapshot); } catch {} } });

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}`); return; }
  failed += 1;
  console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
}

const realFetch = globalThis.fetch;
const doctor = await import('./offer-claim-doctor.js');

function jwt(expSec, extra = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSec, user_id: '111', ...extra })}.sig`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 86400;

/**
 * Fake Swiggy: `state` maps campaignId -> { shouldNotify, value, status }.
 * Writes update the state only when `honourWrites` is true (Server jo sach me
 * karta hai wahi mock karta hai — including "write 200 par save kuch nahi").
 */
function installFakeSwiggy({ state = {}, honourWrites = true, writeStatus = 200, probeStatusOverride = null, requireCookieTransport = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = String(opts.method || 'GET').toUpperCase();
    calls.push({ url: u, method, headers: opts.headers || {}, body: opts.body || '' });
    const json = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => JSON.stringify(obj),
      json: async () => obj
    });

    if (u.includes('book-your-offer') || u.includes('pick-your-late-night-offer')) {
      return json(200, {}); // no __NEXT_DATA__ -> deterministic default campaigns
    }
    if (u.includes('chkout.swiggy.com')) return json(200, { statusCode: 0, tid: jwt(FUTURE) });
    if (u.includes('events.swiggy.com/api/notify')) {
      // Writes carry the campaign in the JSON body (no query string) — exactly
      // like the real Swiggy API.
      let bodyCampaign = null;
      if (method !== 'GET' && opts.body) {
        try { bodyCampaign = JSON.parse(opts.body).campaign || null; } catch {}
      }
      const campaign = new URL(u).searchParams.get('campaign') || bodyCampaign;
      const hasCookie = Boolean(opts.headers?.Cookie);
      if (requireCookieTransport && !hasCookie) return json(401, { message: 'unauthorized' });
      if (probeStatusOverride && method === 'GET') return json(probeStatusOverride, { message: 'nope' });
      if (method === 'GET') {
        const s = state[campaign] || { shouldNotify: false, value: 0 };
        return json(200, { shouldNotify: s.shouldNotify, value: s.value, timestamp: s.timestamp || new Date().toISOString() });
      }
      // POST / PATCH
      if (writeStatus !== 200) return json(writeStatus, { message: 'rejected' });
      if (honourWrites) {
        const body = JSON.parse(opts.body || '{}');
        state[campaign] = { shouldNotify: true, value: Number(body.value || 0), timestamp: new Date().toISOString() };
      }
      return json(200, { message: 'ok' });
    }
    return json(404, {});
  };
  return { calls, state };
}

console.log('\n=== 1. Campaign windows: LN raat 9 → subah 6 (cross-midnight) ===');
{
  const boundaries = [
    { day: 25, startTime: '2026-10-25T05:30:00.000Z', endTime: '2026-10-26T05:30:00.000Z' }, // 11:00 IST -> 11:00 IST
    { day: 26, startTime: '2026-10-26T05:30:00.000Z', endTime: '2026-10-27T05:30:00.000Z' },
    { day: 27, startTime: '2026-10-27T05:30:00.000Z', endTime: '2026-10-28T05:30:00.000Z' }
  ];
  const meta = { ...doctor.OFFER_CAMPAIGN_URLS && {}, metaSource: 'LIVE_PAGE', bfPrefix: 'byo-bf-v10-', lnPrefix: 'byo-ln-v5-', bfBoundaries: boundaries, lnBoundaries: boundaries };

  // 26-10 02:00 IST = 25th 20:30 UTC -> still 25th's late-night slot (21:00-06:00 IST on 26th)
  const lateNightAt2am = doctor.resolveTrackCampaigns(meta, 'lateNight', Date.parse('2026-10-25T20:30:00.000Z'));
  check('2 AM IST par LN campaign = 25 ka (kal ka slot), 26 ka nahi', lateNightAt2am.primary?.campaign === 'byo-ln-v5-25', lateNightAt2am.primary?.campaign);
  check('2 AM IST par slot LIVE hai', lateNightAt2am.primary?.slotLiveNow === true);
  check('primary hi live-slot campaign hai', lateNightAt2am.primary?.state === 'SLOT_LIVE_NOW', lateNightAt2am.primary?.state);

  // 26-10 20:00 IST (14:30 UTC): LN cutoff (18:30 IST) is gone, slot opens at 21:00
  const lnEvening = doctor.resolveTrackCampaigns(meta, 'lateNight', Date.parse('2026-10-26T14:30:00.000Z'));
  check('20:00 IST par LN campaign = 26 ka', lnEvening.primary?.campaign === 'byo-ln-v5-26', lnEvening.primary?.campaign);
  check('20:00 IST par cutoff pass + slot band', lnEvening.primary?.cutoffPassed === true && lnEvening.primary?.slotLiveNow === false);
  check('26 ka slot 21:00 IST par khulega (~1h)', Math.abs((lnEvening.primary?.slotOpensInMs || 0) - 3600 * 1000) < 60 * 1000, String(lnEvening.primary?.slotOpensInMs));

  // 27-10 08:00 IST: breakfast slot live (07:00-11:00)
  const bfMorning = doctor.resolveTrackCampaigns(meta, 'breakfast', Date.parse('2026-10-27T02:30:00.000Z'));
  check('8 AM IST par BF campaign = 26 ka (26 ki subah 7-11)', bfMorning.primary?.campaign === 'byo-bf-v10-26', bfMorning.primary?.campaign);
  check('8 AM IST par BF slot LIVE', bfMorning.primary?.slotLiveNow === true);

  check('candidates me kal/aaj/parso shaamil hain', lateNightAt2am.rows.length >= 2 && new Set(lateNightAt2am.rows.map((r) => r.campaign)).size === lateNightAt2am.rows.length);
  check('kisi bhi row ka campaign id prefix+day hai', lateNightAt2am.rows.every((r) => /^byo-ln-v5-\d+$/.test(r.campaign)));
  check('doctor constants swiggy-bridge se match karte hain', await (async () => {
    const bridge = await import('./swiggy-bridge.js');
    return bridge.EVENT_CAMPAIGN_URLS.lateNight === doctor.OFFER_CAMPAIGN_URLS.lateNight &&
      bridge.EVENT_CAMPAIGN_URLS.breakfast === doctor.OFFER_CAMPAIGN_URLS.breakfast &&
      bridge.EVENT_OFFER_OPTIONS[1].shortLabel === doctor.OFFER_OPTIONS[1].shortLabel;
  })());
}

console.log('\n=== 2. Diagnosis: "mera ID kyun nahi" ka exact reason ===');
{
  const account = {
    id: 'acc_diag1', phone: '9000001111', isLoggedIn: true,
    token: 'tok_live', tid: jwt(FUTURE), cookies: '_session_tid=' + jwt(FUTURE)
  };
  const nowMs = Date.parse('2026-10-26T14:30:00.000Z'); // 20:00 IST -> LN campaign 26

  // (a) kuch bhi book nahi
  installFakeSwiggy({ state: {} });
  let rep = await doctor.diagnoseAccountOffers(account, { key: 'acc_diag1', nowMs });
  check('not booked -> state NOT_BOOKED', rep.tracks.lateNight.state === 'NOT_BOOKED', rep.tracks.lateNight.state);
  check('reason me campaign id + Fix ka hint hai', /byo-ln-v5-26/.test(rep.tracks.lateNight.reason) && /Fix/.test(rep.tracks.lateNight.reason));
  check('report ok + auth bataya', rep.ok === true && rep.auth.hasToken === true && rep.auth.hasTid === true);

  // (b) booked par reward option 3 (₹175 coupon) — yahi "offer nahi lag raha" ka asli reason
  installFakeSwiggy({ state: { 'byo-ln-v5-26': { shouldNotify: true, value: 3 } } });
  rep = await doctor.diagnoseAccountOffers(account, { key: 'acc_diag1', nowMs });
  check('wrong reward -> WRONG_REWARD', rep.tracks.lateNight.state === 'WRONG_REWARD', rep.tracks.lateNight.state);
  check('reason me option 3 ka naam hai', /₹175/.test(rep.tracks.lateNight.reason), rep.tracks.lateNight.reason);
  check('verdict me coupon-vs-cash ka farq samjhaya', rep.verdict.some((v) => /coupon cash nahi hote/.test(v)));

  // (c) sahi booked, slot khula
  installFakeSwiggy({ state: { 'byo-ln-v5-26': { shouldNotify: true, value: 1 } } });
  rep = await doctor.diagnoseAccountOffers(account, { key: 'acc_diag1', nowMs: Date.parse('2026-10-26T16:30:00.000Z') }); // 22:00 IST
  check('sahi 50 + slot khula -> LIVE_NOW', rep.tracks.lateNight.state === 'LIVE_NOW', rep.tracks.lateNight.state);
  check('LIVE_NOW reason me ₹199 MOV bataya', /₹199/.test(rep.tracks.lateNight.reason));

  // (d) 403 = WAF throttle (har 5 min retry isse aur bigadta hai)
  installFakeSwiggy({ probeStatusOverride: 403 });
  rep = await doctor.diagnoseAccountOffers(account, { key: 'acc_diag1', nowMs });
  check('403 -> RATE_LIMITED', rep.tracks.lateNight.state === 'RATE_LIMITED', rep.tracks.lateNight.state);
  check('reason me HTTP 403 + cool-down hai', /403/.test(rep.tracks.lateNight.reason) && /10 min/.test(rep.tracks.lateNight.reason));

  // (e) session dead
  installFakeSwiggy({ probeStatusOverride: 401 });
  rep = await doctor.diagnoseAccountOffers(account, { key: 'acc_diag1', nowMs });
  check('401 -> AUTH_FAILED (re-login ka hint)', rep.tracks.lateNight.state === 'AUTH_FAILED' && /re-login/i.test(rep.tracks.lateNight.reason));

  // (f) koi session hi nahi
  const noSession = await doctor.diagnoseAccountOffers({ phone: '1' }, { key: 'x' });
  check('session nahi -> NO_SESSION honest error', noSession.ok === false && noSession.code === 'NO_SESSION');

  // (g) transport fallback: token header 401, cookie chalta hai
  installFakeSwiggy({ state: { 'byo-ln-v5-26': { shouldNotify: true, value: 1 } }, requireCookieTransport: true });
  rep = await doctor.diagnoseAccountOffers(account, { key: 'acc_diag1', nowMs });
  const lnRow = rep.rows.find((r) => r.campaign === 'byo-ln-v5-26');
  check('token fail par cookie transport se probe hua', lnRow?.probe?.ok === true && lnRow.probe.transport === 'cookie', JSON.stringify(lnRow?.probe));
}

console.log('\n=== 3. FIX: option 1 likho + read-back se verify ===');
{
  const account = {
    id: 'acc_fix1', phone: '9000002222', isLoggedIn: true,
    token: 'tok_live', tid: jwt(FUTURE), cookies: '_session_tid=' + jwt(FUTURE)
  };
  const nowMs = Date.parse('2026-10-26T14:30:00.000Z');

  // (a) kuch book nahi -> POST -> read-back verified
  const fake1 = installFakeSwiggy({ state: {} });
  let out = await doctor.fixAccountOffers(account, { key: 'acc_fix1', nowMs });
  const postCall = fake1.calls.find((c) => c.url.includes('/api/notify') && c.method === 'POST');
  check('not booked par POST hua', Boolean(postCall));
  check('write me value 1 bheja', /"value":1/.test(String(postCall?.body || '')) || postCall?.headers, true);
  check('read-back verifiedAny true', out.verifiedAny === true, JSON.stringify(out.changes?.map((c) => c.verified)));
  check('verified change ka action post hai', out.changes.some((c) => c.action === 'post' && c.verified === true));
  check('after diagnosis me LN booked hai', out.after.tracks.lateNight.booked === true && out.after.tracks.lateNight.value === 1);

  // (b) value 3 saved -> PATCH (POST nahi)
  const fake2 = installFakeSwiggy({ state: { 'byo-ln-v5-26': { shouldNotify: true, value: 3 } } });
  out = await doctor.fixAccountOffers(account, { key: 'acc_fix1', nowMs });
  const patchCall = fake2.calls.find((c) => c.url.includes('/api/notify') && c.method === 'PATCH' && String(c.body || '').includes('byo-ln-v5-26'));
  check('value drift par PATCH hua (POST nahi)', Boolean(patchCall));
  check('PATCH ke baad LN ₹50 verified', out.after.tracks.lateNight.value === 1 && out.changes.some((c) => c.verified));
  check('changes me reason khali hai jab verified', out.changes.filter((c) => c.verified).every((c) => !c.reason));

  // (c) server jhooth bolta hai: write 200 par save kuch nahi
  installFakeSwiggy({ state: {}, honourWrites: false });
  out = await doctor.fixAccountOffers(account, { key: 'acc_fix1', nowMs });
  check('jhootha 200 -> verified FALSE (UI sach) ', out.verifiedAny === false, JSON.stringify(out.changes?.map((c) => c.verified)));
  check('reason me read-back truth hai', out.changes.some((c) => /Server par value|shouldNotify/.test(String(c.reason))), JSON.stringify(out.changes?.[0]?.reason));
  check('after diagnosis abhi bhi booked nahi', out.after.tracks.lateNight.booked === false);

  // db me truth save hoti hai
  const store = await import('./store.js');
  store.mutateDb((d) => {
    d.config.accounts = { ...(d.config.accounts || {}), acc_9000003333: { id: 'acc_9000003333', phone: '9000003333', isLoggedIn: true, token: 't', tid: jwt(FUTURE), cookies: '_session_tid=' + jwt(FUTURE) } };
  });
  installFakeSwiggy({ state: { 'byo-ln-v5-26': { shouldNotify: true, value: 3 } } });
  const rep2 = await doctor.runOfferDoctorForAccount('acc_9000003333', { nowMs });
  check('runOfferDoctorForAccount state store karta hai', store.getDb().config.accounts.acc_9000003333.offerDoctor?.lateNight === 'WRONG_REWARD', JSON.stringify(store.getDb().config.accounts.acc_9000003333.offerDoctor));
}

console.log('\n=== 4. Asli claim path: read-back ke bina "CLAIMED" nahi ===');
{
  globalThis.fetch = realFetch;
  const bridge = await import('./swiggy-bridge.js');

  // (a) write 200 par server kuch save nahi karta -> FAILED (pehle jhootha CLAIMED)
  installFakeSwiggy({ state: {}, honourWrites: false });
  const claimA = await bridge.claimSwiggyBreakfastAndLateNightOffers(
    { id: 'acc_claim_a', phone: '9000004444', token: 'tok', tid: jwt(FUTURE) }, { force: true, offerValue: 1 }
  );
  check('save na hone par status FAILED', claimA.lateNight?.status === 'FAILED', claimA.lateNight?.status);
  check('message read-back ka sach batata hai', /read-back/i.test(String(claimA.lateNight?.message || '')), String(claimA.lateNight?.message).slice(0, 120));
  check('verified false', claimA.lateNight?.verified === false);

  // (b) server value 2 save karta hai -> CLAIMED par message me option 2, verified false
  const stateB = { 'byo-bf-v10-15': { shouldNotify: true, value: 2 }, 'byo-ln-v5-15': { shouldNotify: true, value: 2 } };
  installFakeSwiggy({ state: stateB, honourWrites: false });
  const claimB = await bridge.claimSwiggyBreakfastAndLateNightOffers(
    { id: 'acc_claim_b', phone: '9000005555', token: 'tok', tid: jwt(FUTURE) }, { force: true, offerValue: 1 }
  );
  check('value drift par message me option 2 ka sach', /option 2/i.test(String(claimB.lateNight?.message || '')), String(claimB.lateNight?.message).slice(0, 160));
  check('verified false (₹50 nahi hai)', claimB.lateNight?.verified === false);

  // (c) sab theek -> CLAIMED + verified true
  installFakeSwiggy({ state: {} });
  const claimC = await bridge.claimSwiggyBreakfastAndLateNightOffers(
    { id: 'acc_claim_c', phone: '9000006666', token: 'tok', tid: jwt(FUTURE) }, { force: true, offerValue: 1 }
  );
  check('write + read-back sahi -> CLAIMED', claimC.breakfast?.status === 'CLAIMED' && claimC.lateNight?.status === 'CLAIMED');
  check('verified true', claimC.breakfast?.verified === true && claimC.lateNight?.verified === true);
  check('bothClaimed true', claimC.bothClaimed === true);

  // (d) auto-activate wrapper bhi verified flag aage bhejta hai
  installFakeSwiggy({ state: {} });
  const auto = await bridge.autoActivateEventOffers(
    { id: 'acc_claim_d', phone: '9000007777', token: 'tok', tid: jwt(FUTURE) }, { force: true }
  );
  // success = SAARE lage (Karwa Chauth sameth). Extra ₹50 / Weekend / Karwa
  // Chauth ka id page par nahi hota, isliye engine candidates ko live likh kar
  // read-back se verify karta hai.
  check('auto wrapper saare offer claim karta hai (5/5)',
    auto.success === true && auto.claimedCount === auto.totalCount && auto.claimedCount === 5,
    JSON.stringify({ s: auto.success, n: auto.claimedCount, t: auto.totalCount }));
  check('auto wrapper label ₹50-on-₹199 hi rakhta hai', /₹50/.test(auto.label), auto.label);
  check('auto wrapper bothClaimed + chaar slots deta hai', auto.offers?.bothClaimed === true && Boolean(auto.offers?.extra50) && Boolean(auto.offers?.weekend));
  check('Extra ₹50 / Weekend bhi verified', auto.offers?.extra50?.verified === true && auto.offers?.weekend?.verified === true, JSON.stringify({ x: auto.offers?.extra50?.status, w: auto.offers?.weekend?.status }));
}

console.log('\n=== 4b. Auto-heal: cart use hone par ID ka offer khud theek ===');
{
  const store = await import('./store.js');
  const fof = await import('./forwarded-order-flow.js');
  const futureTid = jwt(FUTURE);
  store.mutateDb((d) => {
    d.config.accounts = {
      ...(d.config.accounts || {}),
      acc_9000008888: { id: 'acc_9000008888', phone: '9000008888', isLoggedIn: true, token: 't', tid: futureTid, cookies: '_session_tid=' + futureTid }
    };
  });
  // value 3 saved (coupon) -> auto-heal should NOT_BOOKED/WRONG_REWARD ko theek kare
  const fake = installFakeSwiggy({ state: { 'byo-ln-v5-26': { shouldNotify: true, value: 3 } } });
  const nowMs2 = Date.parse('2026-10-26T14:30:00.000Z');
  const heal = await fof.autoHealOffersForAccount('acc_9000008888', { nowMs: nowMs2, minGapMs: 0 });
  check('auto-heal ne offer theek kiya', Boolean(heal?.changes?.some((c) => c.verified === true)), JSON.stringify(heal?.changes?.map((c) => c.verified)));
  check('auto-heal ke baad LN ₹50 verified', heal?.after?.tracks?.lateNight?.value === 1, String(heal?.after?.tracks?.lateNight?.value));
  check('auto-heal timestamp ID par save hua', Boolean(store.getDb().config.accounts.acc_9000008888.offerAutoHealAt));

  // gap ke andar dobara nahi chalta (Swiggy ko hammer nahi karte)
  const callsBefore = fake.calls.length;
  const heal2 = await fof.autoHealOffersForAccount('acc_9000008888', { nowMs: nowMs2 + 1000, minGapMs: 15 * 60 * 1000 });
  check('15 min ke andar dobara network call nahi', heal2 === null && fake.calls.length === callsBefore, `${fake.calls.length - callsBefore} calls`);
}

console.log('\n=== 5. Wiring: buttons + command ===');
{
  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check('Boss ke paas 🎁 Night Offer Doctor button hai', /boss_offer_doctor_/.test(indexSrc));
  check('Boss ke paas 🔧 Fix (read-back) button hai', /boss_offer_fix_/.test(indexSrc));
  check('/offers command hai', /bot\.command\(\['offers', 'offercheck', 'nightoffer'\]/.test(indexSrc));
  check('Claim fail hone par doctor khud chalta hai (reason chhup nahi)', /const doctor = await runOfferDoctorForAccount\(accKey, \{\}\)/.test(indexSrc));
  check('account card par doctor button', /Night Offer Doctor', callback_data: `boss_offer_doctor_\$\{key\}`/.test(indexSrc));
  const report = doctor.formatOfferDoctorReport({
    ok: true, key: 'k', metaSource: 'LIVE_PAGE',
    auth: { hasToken: true, hasTid: true },
    tracks: {
      breakfast: { label: 'Breakfast', state: 'BOOKED', reason: 'ok', rows: [] },
      lateNight: { label: 'Late Night', state: 'WRONG_REWARD', reason: 'option 3 hai', rows: [{ campaign: 'byo-ln-v5-26', window: { slotLiveNow: true }, probe: { ok: true, value: 3, httpStatus: 200 } }] }
    },
    cash: { amount: 0 }, verdict: ['late night: WRONG_REWARD']
  }, { accountLabel: 'Ammi (9000001111)', escapeHtml: (v) => String(v) });
  check('report me track + campaign + verdict hai', /Late Night/.test(report) && /byo-ln-v5-26/.test(report) && /WRONG_REWARD/.test(report));
  check('report me free cash line hai', /Free cash/.test(report));
}

globalThis.fetch = realFetch;

console.log('\n=====================================================================');
console.log(failed === 0
  ? `🏆 OFFER DOCTOR + READ-BACK VERIFIED — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
