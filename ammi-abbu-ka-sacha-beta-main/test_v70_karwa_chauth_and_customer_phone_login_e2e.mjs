/**
 * v70 — KARWA CHAUTH OFFER + "ID UNKE PHONE ME LOGIN HO, ORDER UNKE PHONE SE HO"
 *
 * Boss (29-10-2026):
 *   "🔥Swiggy karwa chauth new offer 29 Oct 3 PM - 30 Oct 6 AM · Pick 50 cash"
 *   + "jaise koi slot mere ammi abbu koi order de to unke phone me wo login hojaye
 *      wo id aur unke phone se order ho kiuki phone to unka hai aur order to india
 *      se hoga me to saudi me rahunga aur isi wajah se night cash and wo sab apply
 *      na horaha tha"
 *
 * Yeh test (offline) proves:
 *   1. Karwa Chauth paanchva offer hai — link, candidates (self-verifying ladder),
 *      aura har import/dashboard/bridge/doctor/import-summary me ginti me aata hai.
 *   2. Customer ke phone par wahi ID handover hoti hai jis par offers lage hain:
 *      card + buttons, honest status (koi jhootha "login ho gaya" nahi).
 *   3. Customer ne "main apne phone se karunga" bola to bot APNI TARAF SE place
 *      nahi karta (double order nahi, Saudi IP se order nahi).
 *   4. Live probe pass ho tabhi SESSION_LIVE; us ID par order dikhe tabhi
 *      VERIFIED_BY_ORDER (pakka proof).
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
const views = await import('./account-views.js');
const bridge = await import('./swiggy-bridge.js');
const doctor = await import('./offer-claim-doctor.js');
const intake = await import('./account-vault-intake.js');
const simpleChat = await import('./simple-chat.js');
const dl = await import('./customer-device-login.js');

const indexSrc = fs.readFileSync('./index.js', 'utf8');
const cartSrc = fs.readFileSync('./swiggy-cart.js', 'utf8');
const panelSrc = fs.readFileSync('./boss-panel.js', 'utf8');
const chatSrc = fs.readFileSync('./simple-chat.js', 'utf8');
const intakeSrc = fs.readFileSync('./account-vault-intake.js', 'utf8');

const H = 3600 * 1000;
const now = Date.now();
const ist = new Date(now + 5.5 * H);
const DAY = ist.getUTCHours() < 11 ? ist.getUTCDate() - 1 : ist.getUTCDate();

// ── mock Swiggy: sirf ASLI ids par write save hota hai (asli jaisa) ──────────
const PAGE = {
  'pick-your-late-night-offer': `<html><script id="__NEXT_DATA__">{"props":{"pageProps":{"nexusData":{"notifyCampaignIdPrefix":"byo-ln-v5-"}}}}</script></html>`,
  'book-your-offer': `<html><script id="__NEXT_DATA__">{"props":{"pageProps":{"nexusData":{"notifyCampaignIdPrefix":"byo-bf-v10-"}}}}</script></html>`,
  'pick-your-offer': '<html><body>Extra ₹50 offer</body></html>',
  'byo-weekend': '<html><body>Weekend offer</body></html>',
  'karwa-chauth-byo': '<html><body>Karwa Chauth · Pick ₹50 cash</body></html>'
};
const REAL_KC = `byo-karwa-chauth-v1-${DAY}`;
const REAL = [
  `byo-ln-v5-${DAY}`, `byo-ln-v5-${DAY + 1}`,
  `byo-bf-v10-${DAY}`, `byo-bf-v10-${DAY + 1}`,
  `byo-pick-your-offer-v2-${DAY}`, `byo-weekend-v1-${DAY}`, REAL_KC
];

function makeSwiggy({ realIds = REAL } = {}) {
  const state = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: target, method, body });
    const slug = target.replace('https://events.swiggy.com/', '').split('?')[0];
    if (PAGE[slug]) return { ok: true, status: 200, text: async () => PAGE[slug], json: async () => ({}) };
    if (target.includes('/api/notify')) {
      const campaign = method === 'GET'
        ? decodeURIComponent((target.split('campaign=')[1] || '').split('&')[0])
        : (body?.campaign || '');
      if (method === 'GET') {
        const rec = state.get(campaign) || { shouldNotify: false, value: 0 };
        return { ok: true, status: 200, json: async () => ({ ...rec, timestamp: new Date().toISOString() }) };
      }
      if (realIds.includes(campaign)) state.set(campaign, { shouldNotify: true, value: Number(body?.value || 1) });
      return { ok: true, status: 200, json: async () => ({ statusCode: 0, message: 'Done Successfully' }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { fetchImpl, state, calls };
}

const ACC = {
  id: 'acc_ammi',
  name: 'Ammi',
  phone: '9876500123',
  token: 'tok-ammi',
  tid: 'a.b.c',
  cookies: '_session_tid=a.b.c; tid=a.b.c',
  isLoggedIn: true
};

console.log('\n=== 1. Karwa Chauth = paanchva offer (link + engine) ===');
{
  const offer = offers.getEventOffer('karwaChauth');
  check('offer registry me hai', Boolean(offer), JSON.stringify(offers.EVENT_OFFER_KEYS));
  check('link = karwa-chauth-byo', String(offer?.url || '').includes('events.swiggy.com/karwa-chauth-byo'), offer?.url);
  check('boss ka label "Karwa Chauth"', offer?.bossLabel === 'Karwa Chauth');
  check('Pick ₹50 cash naam me', /Pick ₹50 cash/i.test(String(offer?.name || '')), offer?.name);
  check('window 29 Oct 3PM – 30 Oct 6AM likha hai', /29 Oct 3PM/.test(String(offer?.windowLabel || '')) && /30 Oct 6AM/.test(String(offer?.windowLabel || '')));
  check('windowStart/End parse hote hain', Number.isFinite(Date.parse(offer.windowStart)) && Number.isFinite(Date.parse(offer.windowEnd)));
  const cands = offer.candidates(DAY);
  check('self-verifying candidates hain', cands.length >= 6, JSON.stringify(cands));
  check('day-number wala shape pehle 4 me hai', cands.slice(0, 4).some((c) => /-v\d+-\d+$/.test(c)), JSON.stringify(cands.slice(0, 4)));
  check('EVENT_OFFER_KEYS me paanch offer', offers.EVENT_OFFER_KEYS.length === 5 && offers.EVENT_OFFER_KEYS.includes('karwaChauth'));

  // Live mock: sirf asli id par write save hota hai → ladder verify karti hai.
  offers.resetEventOfferMetaCache();
  offers.resetFixedCampaignCache();
  const mock = makeSwiggy();
  const out = await offers.activateAllEventOffers(ACC, { fetchImpl: mock.fetchImpl, force: true });
  check('Karwa Chauth CLAIMED (write + read-back)', out.offers.karwaChauth?.status === 'CLAIMED', JSON.stringify({ s: out.offers.karwaChauth?.status, m: out.offers.karwaChauth?.message }));
  check('sahi campaign id mili', out.offers.karwaChauth?.campaign === REAL_KC, out.offers.karwaChauth?.campaign);
  check('verified true (read-back)', out.offers.karwaChauth?.verified === true);
  check('saare paanch offers CLAIMED', out.summary.claimed === 5 && out.summary.failed === 0, JSON.stringify(out.summary));
  check('result me top-level karwaChauth slot', Boolean(out.karwaChauth));

  const wrapped = await bridge.autoActivateEventOffers(ACC, { force: true, fetchImpl: makeSwiggy().fetchImpl });
  check('bridge wrapper paanchva slot deta hai', Boolean(wrapped.karwaChauth) && wrapped.totalCount === 5, JSON.stringify({ n: wrapped.claimedCount, t: wrapped.totalCount }));
  check('bridge success = saare lage', wrapped.success === true && wrapped.claimedCount === 5);
  check('import summary me 🪔 (Karwa Chauth) cell', intakeSrc.includes('OFFER_TRACKS') && /OFFER_TRACKS\.length/.test(intakeSrc));
}

console.log('\n=== 2. Cards / doctor / dashboard me bhi Karwa Chauth ===');
{
  check('OFFER_TRACKS me karwaChauth track', views.OFFER_TRACKS.some((t) => t.key === 'karwaChauth'));
  check('OFFER_TRACK_COUNT 5 (hardcoded 4 nahi)', views.OFFER_TRACK_COUNT === 5);
  check('campaign url registry me', String(views.OFFER_CAMPAIGN_URLS.karwaChauth || '').includes('karwa-chauth-byo'));

  const acc = {
    name: 'Ammi',
    phone: '9876500123',
    offers: {
      lateNight: { status: 'CLAIMED' }, breakfast: { status: 'CLAIMED' },
      extra50: { status: 'CLAIMED' }, weekend: { status: 'WRONG_REWARD' },
      karwaChauth: { status: 'CLAIMED' }
    }
  };
  const lines = views.fourOfferStatusLines(acc);
  check('paanch lines (har offer ek)', lines.length === 5, JSON.stringify(lines));
  check('Karwa Chauth line 🪔 + ✅', /🪔/.test(lines[4]) && /✅/.test(lines[4]), lines[4]);
  const score = views.fourOfferScoreLine(acc);
  check('score 4/5 (jhooth nahi)', /4\/5 claimed/.test(score) && /₹250 possible/.test(score), score);
  const truth = views.offerClaimTruth(acc);
  check('truth me karwaChauth slot', truth.karwaChauth?.status === 'CLAIMED');
  check('truth.allFour sirf sab lage par', truth.allFour === false);

  check('doctor tracks me karwaChauth', doctor.OFFER_TRACK_KEYS.includes('karwaChauth'));
  check('doctor campaign url registry me', String(doctor.OFFER_CAMPAIGN_URLS.karwaChauth || '').includes('karwa-chauth-byo'));
}

console.log('\n=== 3. Customer ko ID handover card (wahi ID jispar offers lage hain) ===');
{
  const order = { id: 'ord_dl_1', selectedAccount: 'acc_9876500123', orderAccount: '9876500123', status: 'APPROVAL_PENDING' };
  const rec = dl.attachDeviceLogin(order, ACC, { key: 'acc_9876500123' });
  check('deviceLogin record bana', Boolean(rec) && rec.phone === '9876500123', JSON.stringify(rec));
  check('default placementMode BOT', order.placementMode === dl.PLACEMENT_MODE.BOT);

  const card = dl.buildDeviceLoginHandover({ order, account: ACC, key: 'acc_9876500123' });
  check('card me ID ka phone poora', card.text.includes('9876500123'));
  check('card me 3 steps', /1️⃣/.test(card.text) && /3️⃣/.test(card.text));
  check('card me "cart + ₹50 offer usi ID par" sach', /₹50/.test(card.text) && /Cart/i.test(card.text));
  check('card me jhooth nahi: bot phone nahi dekh sakta', /dekh nahi sakta/i.test(card.text));
  const flat = card.buttons.flat();
  check('button: Swiggy kholo', flat.some((b) => /Swiggy app kholo/.test(b.text) && b.url));
  check('button: login check', flat.some((b) => b.callback_data === 'devlogin_check_ord_dl_1'));
  check('button: main apne phone se karunga', flat.some((b) => b.callback_data === 'devlogin_phone_ord_dl_1'));
  check('button: madad', flat.some((b) => b.callback_data === 'devlogin_help_ord_dl_1'));

  dl.markHandoverSent(order);
  check('handover ke baad status AWAITING_LOGIN', order.deviceLogin.status === dl.DEVICE_LOGIN_STATUS.AWAITING_LOGIN);
  check('sach: abhi login verify nahi hua', dl.deviceLoginTruth(order).verified === false);

  // ID me phone hi nahi → handover jhooth nahi banata
  const bad = { id: 'ord_dl_bad', selectedAccount: 'acc_x' };
  const badCard = dl.buildDeviceLoginHandover({ order: bad, account: { name: 'NoPhone' }, key: 'acc_x' });
  check('phone na ho to card sach bolta hai', /phone number nahi hai/i.test(badCard.text));
}

console.log('\n=== 3b. "Burhe Ammi se OTP kaise parhaunga" → OTP ki zarurat hi nahi ===');
{
  // Boss ka asli sawaal: 70+ saal ki Ammi se OTP padhwana possible nahi.
  const order = { id: 'ord_otp_1', selectedAccount: 'acc_9876500123', orderAccount: '9876500123' };
  dl.attachDeviceLogin(order, ACC, { key: 'acc_9876500123' });
  dl.markHandoverSent(order);
  const card = dl.buildDeviceLoginHandover({ order, account: ACC, key: 'acc_9876500123' });
  const flat = card.buttons.flat();
  check('card saaf kehta hai ki yeh OPTIONAL hai', /optional/i.test(card.text));
  check('card me "Ammi/Abbu ko kuch nahi karna"', /kuch nahi karna/i.test(card.text));
  check('OTP-free button sabse pehle', flat[0].callback_data === 'devlogin_bot_ord_otp_1', JSON.stringify(flat[0]));
  check('button label "OTP nahi — bot khud order kare"', /OTP nahi/i.test(flat[0].text));
  check('card me "ek hi baar, ~30 din" sach', /ek hi baar/i.test(card.text) && /30 din/.test(card.text));
  check('default mode BOT hi hai (kuch karna hi nahi)', order.placementMode === dl.PLACEMENT_MODE.BOT);

  // Bot placement chuna → wapas default, koi "pending login" bakwaas nahi
  dl.chooseBotPlacement(order);
  check('placementMode BOT par wapas', order.placementMode === dl.PLACEMENT_MODE.BOT);
  check('botPlacesOrder true', order.deviceLogin.botPlacesOrder === true);
  check('status NOT_REQUESTED (adhoora pending nahi)', order.deviceLogin.status === dl.DEVICE_LOGIN_STATUS.NOT_REQUESTED);
  check('sach likha: OTP ki zarurat nahi', /OTP ki zarurat nahi/i.test(order.deviceLogin.lastReason));
  check('bot placement par "bot place nahi karega" nahi kehta', !/bot place nahi karega/i.test(dl.deviceLoginTruth(order).label));

  // Help text me boss ke teen asli raste
  const help = dl.buildDeviceLoginHelpText({ order });
  check('help: Ammi se OTP ki zarurat nahi', /OTP ki zarurat NAHI/i.test(help));
  check('help: OTP sirf ek baar (~30 din)', /sirf ek baar/i.test(help) && /30 din/.test(help));
  check('help: bot me Login with Number se boss khud OTP daal sakta hai', /Login with Number/i.test(help));

  // Har order par card nahi aana chahiye (spam nahi) + env se band
  check('handover dobara nahi jata (spam nahi)', /handover pehle hi bhej diya/.test(indexSrc));
  check('DEVICE_LOGIN_AUTO_HANDOVER=0 se band ho sakta hai', /DEVICE_LOGIN_AUTO_HANDOVER/.test(indexSrc));
}

console.log('\n=== 4. "Order main apne phone se karunga" → bot place nahi karta ===');
{
  const order = { id: 'ord_dl_2', selectedAccount: 'acc_9876500123', orderAccount: '9876500123' };
  dl.attachDeviceLogin(order, ACC, { key: 'acc_9876500123' });
  dl.markHandoverSent(order);
  dl.customerChoseOwnPhone(order);
  check('placementMode CUSTOMER_PHONE', order.placementMode === dl.PLACEMENT_MODE.CUSTOMER_PHONE);
  check('isCustomerPhonePlacement true', dl.isCustomerPhonePlacement(order) === true);
  check('truth me "bot place nahi karega"', /bot place nahi karega/i.test(dl.deviceLoginTruth(order).label));
  check('hold message customer ko sach batata hai', /aapke phone se place hoga/i.test(dl.placementHoldMessage(order)));

  // swiggy-cart ka asli guard: place call par saaf diag code, koi order nahi
  const cart = await import('./swiggy-cart.js');
  let caught = null;
  try {
    await cart.generateRealSwiggyMerchantUpiQr(ACC, order);
  } catch (err) {
    caught = err;
  }
  check('place blocked (koi order place nahi hua)', Boolean(caught), caught?.message);
  check('diag code CUSTOMER_PHONE_PLACEMENT_PENDING', caught?.diag?.code === 'CUSTOMER_PHONE_PLACEMENT_PENDING', JSON.stringify(caught?.diag));
  check('message me ID aur "app me cart" likha hai', /9876500123/.test(String(caught?.message || '')) && /app me cart/i.test(String(caught?.message || '')), caught?.message);
  check('source me guard maujood hai', /CUSTOMER_PHONE_PLACEMENT_PENDING/.test(cartSrc));
}

console.log('\n=== 5. Live probe = sach (pass ho tabhi SESSION_LIVE) ===');
{
  const order = { id: 'ord_dl_3', selectedAccount: 'acc_9876500123', orderAccount: '9876500123' };
  dl.attachDeviceLogin(order, ACC, { key: 'acc_9876500123' });
  dl.markHandoverSent(order);
  dl.markCustomerSaidLoggedIn(order);
  check('customer ke bolne par SELF_REPORTED (verified nahi)', order.deviceLogin.status === dl.DEVICE_LOGIN_STATUS.SELF_REPORTED && dl.deviceLoginTruth(order).verified === false);

  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ statusCode: 0, data: { orders: [] } }) });
  const probeOk = await dl.verifyAccountSessionLive(ACC, { fetchImpl: okFetch });
  check('probe live (Swiggy ne accept kiya)', probeOk.live === true, JSON.stringify(probeOk));
  dl.applySessionProbe(order, probeOk);
  check('SESSION_LIVE', order.deviceLogin.status === dl.DEVICE_LOGIN_STATUS.SESSION_LIVE);
  // v80 (boss 29-10-2026): server session live hone ka matlab phone me login
  // nahi — label wahi sach bolta hai, aur pakka proof order se aata hai.
  check('truth label me "saboot nahi / order se pakka"',
    /saboot nahi|pakka hoga|cart dikhne/i.test(dl.deviceLoginTruth(order).label));
  check('truth.proof batata hai ki sirf server session hai', dl.deviceLoginTruth(order).proof === 'SERVER_SESSION_ONLY');
  check('"aapke phone me login hai" ka dawa nahi', dl.deviceLoginTruth(order).verified === false);

  const badFetch = async () => ({ ok: false, status: 401, json: async () => ({ statusMessage: 'session expired' }) });
  const probeBad = await dl.verifyAccountSessionLive(ACC, { fetchImpl: badFetch });
  check('401 par live false', probeBad.live === false && /401/.test(probeBad.reason), JSON.stringify(probeBad));
  const order2 = { id: 'ord_dl_4', selectedAccount: 'acc_9876500123' };
  dl.attachDeviceLogin(order2, ACC, { key: 'acc_9876500123' });
  dl.markHandoverSent(order2);
  dl.markCustomerSaidLoggedIn(order2);
  dl.applySessionProbe(order2, probeBad);
  check('FAILED + asli wajah', order2.deviceLogin.status === dl.DEVICE_LOGIN_STATUS.FAILED && /401/.test(order2.deviceLogin.lastReason));
  check('status card me wajah dikhti hai', /Wajah:/.test(dl.buildDeviceLoginStatusText({ order: order2, probe: probeBad })));

  const noSession = await dl.verifyAccountSessionLive({ name: 'x' }, { fetchImpl: okFetch });
  check('session hi na ho to jhootha live nahi', noSession.live === false && /cookie\/tid/i.test(noSession.reason), JSON.stringify(noSession));

  // us ID par order aaya = PAKKA proof
  const order3 = { id: 'ord_dl_5', selectedAccount: 'acc_9876500123' };
  dl.attachDeviceLogin(order3, ACC, { key: 'acc_9876500123' });
  dl.customerChoseOwnPhone(order3);
  check('order aane se pehle verified nahi', dl.deviceLoginTruth(order3).verified === false);
  check('pehli baar verify hua', dl.noteCustomerPlacedOrder(order3, '251576512345') === true);
  const finalTruth = dl.deviceLoginTruth(order3);
  check('VERIFIED_BY_ORDER + order id', order3.deviceLogin.status === dl.DEVICE_LOGIN_STATUS.VERIFIED_BY_ORDER && finalTruth.placedOrderId === '251576512345');
  check('truth label me "customer ke phone se"', /customer ke phone se/i.test(finalTruth.label));
  check('wahi order dobara count nahi', dl.noteCustomerPlacedOrder(order3, '251576512345') === false);
  check('doosra order truth nahi badalta', dl.noteCustomerPlacedOrder(order3, '999999999999') === false && order3.deviceLogin.placedOrderId === '251576512345');
  check('koi deviceLogin hi na ho to kuch nahi hota', dl.noteCustomerPlacedOrder({ id: 'x' }, '123') === false);
}

console.log('\n=== 6. Wiring: consent par handover, callbacks, import summary ===');
{
  const consentStart = indexSrc.indexOf('bot.action(/^simple_confirm_order_');
  const consentBlock = indexSrc.slice(consentStart, consentStart + 4000);
  // v77: consent (QR banao) par ab koi lamba login card nahi jata — login
  // pehle hi ho chuka hai, bas ek line. Card ab lock/handover path par short
  // notice ke roop me jata hai.
  check('consent par lamba login card nahi jata', !/sendDeviceLoginHandover\(order, \{ telegram: bot\.telegram/.test(consentBlock));
  // v81 (boss 30-10-2026): "unable to inject the so remove it" — injection
  // notice hata diya; customer ko sirf bill jata hai.
  check('phone-injection notice hata diya gaya', !/sendDeviceLoginShortNotice/.test(indexSrc));
  check('lock par handover injection nahi hota', /const handover = null;/.test(indexSrc));
  check('handover function ID dhoondta hai aur sach likhta hai', /export async function sendDeviceLoginHandover/.test(indexSrc) && /attachDeviceLogin\(order, acc, \{ key: accKey \}\)/.test(indexSrc));
  check('live probe se truth refresh hota hai', /export async function refreshDeviceLoginTruth/.test(indexSrc) && /verifyAccountSessionLive\(acc, \{ fetchImpl \}\)/.test(indexSrc));
  check('devlogin_check_ callback registered', /bot\.action\(\/\^devlogin_check_/.test(indexSrc));
  check('devlogin_phone_ callback registered', /bot\.action\(\/\^devlogin_phone_/.test(indexSrc));
  check('devlogin_help_ callback registered', /bot\.action\(\/\^devlogin_help_/.test(indexSrc));
  check('devlogin_bot_ callback registered (OTP skip)', /bot\.action\(\/\^devlogin_bot_/.test(indexSrc));
  check('OTP skip par bot khud order karta hai (message)', /OTP SKIP — BOT KHUD ORDER KAREGA/.test(indexSrc));
  check('user card BILL me OTP-free button', /OTP nahi — bot kare/.test(chatSrc));
  check('phone choose par boss ko bhi batata hai (dono ko)', /CUSTOMER PHONE PLACEMENT ON/.test(indexSrc));
  check('paid/tracking par order proof likha jata hai', /noteCustomerPlacedOrder\(order, order\.swiggyOrderId\)/.test(indexSrc));
  check('proof message customer + boss dono ko', /ORDER CUSTOMER KE PHONE SE PLACE HUA/.test(indexSrc));

  check('boss card par phone-login badge', /deviceLoginBadge\(order\)/.test(panelSrc) && /deviceLoginTruth/.test(panelSrc));
  // v80: phone-login buttons ab cart-verification wale hain (asli saboot ke saath),
  // aur choosePhone/check bhi maujood rehte hain.
  check('simple user card par phone status + button',
    /dlCb\.cartYes/.test(chatSrc) && /dlCb\.cartNo/.test(chatSrc) && /deviceLoginTruth/.test(chatSrc));
  check('simple card me OTP-free rasta pehle', /dlCb\.botPlaces/.test(chatSrc));
  check('PAY stage phone placement par QR note nahi', /Order aapke phone se<\/b>/.test(chatSrc));

  const html = intake.formatBulkVaultImportSummaryHtml({
    filesCount: 1,
    savedAccounts: [{
      key: 'acc_9876500123',
      account: { ...ACC, ordersVerifiedLive: true, totalOrdersCount: 0 },
      offerAutoActivation: {
        offerValue: 1,
        lateNight: { status: 'CLAIMED' }, breakfast: { status: 'CLAIMED' },
        extra50: { status: 'CLAIMED' }, weekend: { status: 'CLAIMED' },
        karwaChauth: { status: 'CLAIMED' }
      }
    }],
    expiredList: [], parseErrors: [], totalVaultActiveCount: 1,
    zeroOrderCount: 1, usedAccountCount: 0, totalVaultZeroOrderCount: 1
  }, 1);
  check('import summary me ₹50×5', /₹50×5/.test(html), html.slice(0, 160));
  check('import summary me 5/5', /5\/5/.test(html), html);
  check('import summary me 🪔 mark', /🪔/.test(html));
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
  ? `🏆 KARWA CHAUTH + PHONE LOGIN HANDOVER — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exit(failed === 0 ? 0 : 1);
