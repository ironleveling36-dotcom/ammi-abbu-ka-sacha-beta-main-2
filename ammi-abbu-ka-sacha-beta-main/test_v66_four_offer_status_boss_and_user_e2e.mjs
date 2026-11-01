/**
 * v66 — CHAAR OFFER KA STATUS, SAB JAGAH (boss + user), SABME ₹50
 *
 * Boss: "4 OFFER LINK DIA NA CHAARO KO CLAIM KARKE USKA STATUS BHI DIKHANA HAI
 *        SABME 50 50 CLAIM KARNA HAI"
 *
 * Yeh test proves (offline):
 *   1. Har offer ki line me ₹50 likha hai + apna status (✅ / ⏳ / ❌ / ⚪).
 *   2. Account card (boss) me chaaron numbered lines + score (2/4 · ₹100/₹200).
 *   3. JSON import summary me per-account chaaron ka ✓/⏳/✕ + (n/4).
 *   4. Offer Doctor card ke top par chaaron ka status pehle dikhta hai.
 *   5. "Claim ₹50 Offers" button chaaron claim karta hai (ek engine) aur
 *      chaaron ka status wapas bhejta hai.
 *   6. USER ke order card me bhi chaaron offer + ₹50 (dono ko send).
 *   7. Jhooth nahi: jo claim nahi hua wo ❌/⏳ dikhta hai, ✅ nahi.
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

const views = await import('./account-views.js');
const intake = await import('./account-vault-intake.js');

const ACC_ALL = {
  name: 'Chaar Offer',
  phone: '9876500123',
  offers: {
    lateNight: { status: 'CLAIMED', verified: true, discount: '₹50 Free Cash (>₹199)' },
    breakfast: { status: 'CLAIMED', verified: true },
    extra50: { status: 'CLAIMED', verified: true },
    weekend: { status: 'CLAIMED', verified: true },
    karwaChauth: { status: 'CLAIMED', verified: true }
  },
  offerAutoActivation: { offerValue: 1, label: '₹50 off on ₹199', claimedCount: 5, allFourClaimed: true }
};

const ACC_PARTIAL = {
  name: 'Aadha',
  phone: '9876500999',
  offerAutoActivation: {
    offerValue: 1,
    lateNight: { status: 'CLAIMED' },
    breakfast: { status: 'CLAIMED' },
    extra50: { status: 'PRE_LOCKED' },
    weekend: { status: 'FAILED', message: 'campaign id nahi mili' }
  }
};

console.log('\n=== 1. Chaar line, har line par ₹50 + asli status ===');
{
  const lines = views.fourOfferStatusLines(ACC_PARTIAL);
  check('saari line banti hain (har offer ek)', lines.length === views.OFFER_TRACK_COUNT, String(lines.length));
  check('har line me ₹50 likha hai', lines.every((l) => /₹50/.test(l)), JSON.stringify(lines));
  check('chaaron ka naam (Morning/Night/Extra ₹50/Weekend)', /Morning Link/.test(lines[0]) && /Night Link/.test(lines[1]) && /Extra ₹50/.test(lines[2]) && /Weekend/.test(lines[3]));
  check('CLAIMED par ✅', /✅/.test(lines[0]) && /✅/.test(lines[1]));
  check('PRE_LOCKED par ⏳ + "slot khulte hi"', /⏳/.test(lines[2]) && /slot khulte hi/.test(lines[2]), lines[2]);
  check('FAILED par ❌ + asli reason', /❌/.test(lines[3]) && /campaign id nahi mili/.test(lines[3]), lines[3]);
  check('koi jhootha ✅ nahi (2 hi claimed)', lines.filter((l) => /✅/.test(l)).length === 2);

  const score = views.fourOfferScoreLine(ACC_PARTIAL);
  check('score: 2/5 · ₹100 pakka / ₹250 possible', /2\/5 claimed/.test(score) && /₹100 pakka/.test(score) && /₹250 possible/.test(score), score);
  check('pre-locked score me gina', /1 pre-locked/.test(score), score);

  const allScore = views.fourOfferScoreLine(ACC_ALL);
  check('sab lage to 5/5 · ₹250', /5\/5 claimed/.test(allScore) && /₹250 pakka/.test(allScore), allScore);
}

console.log('\n=== 2. Boss account card me chaaron + score ===');
{
  const detail = views.accountDetailText({ acc: ACC_PARTIAL, key: 'acc_partial' });
  const block = detail.text.split('\n').filter((l) => /^\d\.\s/.test(l));
  check('card me har offer ki numbered line', block.length === views.OFFER_TRACK_COUNT, JSON.stringify(block));
  check('card me har line par ₹50', block.every((l) => /₹50/.test(l)));
  check('card me score line', /Score:/.test(detail.text) && /2\/5 claimed/.test(detail.text));
  check('card me chaar label hain', /Morning Link/.test(detail.text) && /Night Link/.test(detail.text) && /Extra ₹50/.test(detail.text) && /Weekend/.test(detail.text));
}

console.log('\n=== 3. JSON import summary me per-ID chaaron status ===');
{
  const html = intake.formatBulkVaultImportSummaryHtml({
    filesCount: 1,
    savedAccounts: [
      { key: 'acc_all', account: { ...ACC_ALL, ordersVerifiedLive: true, totalOrdersCount: 0 }, offerAutoActivation: ACC_ALL.offerAutoActivation },
      { key: 'acc_partial', account: { ...ACC_PARTIAL, ordersVerifiedLive: true, totalOrdersCount: 2 }, offerAutoActivation: ACC_PARTIAL.offerAutoActivation }
    ],
    expiredList: [],
    parseErrors: [],
    totalVaultActiveCount: 2,
    zeroOrderCount: 1,
    usedAccountCount: 1,
    totalVaultZeroOrderCount: 1
  }, 1);
  check('summary me ₹50×5 likha hai', /₹50×5/.test(html), html.slice(0, 200));
  check('har offer ka mark (🌙 ☀ 💸 🎉 🪔)', /🌙/.test(html) && /☀/.test(html) && /💸/.test(html) && /🎉/.test(html) && /🪔/.test(html));
  check('poora laga account (5/5)', /5\/5/.test(html), html);
  check('aadha laga account (2/5)', /2\/5/.test(html), html);
  check('fail par ✕ aur pre-lock par ⏳', /✕/.test(html) && /⏳/.test(html));
  check('purana "BF ✓ / LN ✕" format gaya', !/BF ✓ \/ LN/.test(html));
}

console.log('\n=== 4. Offer Doctor card top par chaaron ka status ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  check('doctor card chaar-offer block pehle bhejta hai', /const statusBlock = fourOfferStatusBlock\(acc, \{ escape: \(v\) => escapeHtml\(String\(v \?\? ''\)\) \}\);/.test(src));
  check('doctor text = statusBlock + report', /const text = statusBlock \+ '\\n\\n' \+/.test(src));
  check('account card claim chaaron engine se', /await autoActivateEventOffers\(accTarget, \{ force: false, offerValue: 1 \}\)/.test(src));
  check('account card hasExtra50/hasWeekend save karta hai', /accTarget\.hasExtra50 = Boolean\(slot/.test(src) && /accTarget\.hasWeekend = Boolean\(slot/.test(src));
  check('discount count chaaron ginta hai', /\['breakfast', 'lateNight', 'extra50', 'weekend'\]\.filter\(claimedSlot\)\.length/.test(src));
  check('boss card me saare-offer block hai', /SAARE \$\{OFFER_TRACKS\.length\} OFFER — har ek ₹50 \(option 1\)/.test(src));
  check('doc card me saare link buttons hain', ['Morning Link', 'Night Link', 'Extra ₹50 Link', 'Weekend Link'].every((t) => src.includes(t)));
}

console.log('\n=== 5. "Claim ₹50 Offers" button = chaaron claim + chaaron status ===');
{
  const src = fs.readFileSync('./index.js', 'utf8');
  const start = src.indexOf('bot.action(/^boss_retry_claim_');
  const handler = src.slice(start, start + 5000);
  check('button chaaron claims karta hai (engine)', /const claimRes = await autoActivateEventOffers\(acc, \{/.test(handler));
  check('button force:false (double claim band)', /force: false/.test(handler));
  check('button chaaron flags save karta hai', /acc\.hasExtra50 = slotClaimed\('extra50'\)/.test(handler) && /acc\.hasWeekend = slotClaimed\('weekend'\)/.test(handler));
  check('button reply me chaar-offer status block', /fourOfferStatusBlock\(acc, \{/.test(handler));
  check('button reply me doctor + fix buttons', /boss_offer_doctor_/.test(handler) && /boss_offer_fix_/.test(handler));
  check('purana 2-offer claim button se gaya', !/claimSwiggyBreakfastAndLateNightOffers\(acc, \{/.test(handler));
}

console.log('\n=== 6. USER ko bhi wahi status (dono panel) ===');
{
  const fwd = fs.readFileSync('./forwarded-order-flow.js', 'utf8');
  check('user card saare offer render karta hai', /Saare \$\{OFFER_TRACKS\.length\} offer — har ek ₹50/.test(fwd));
  check('user card me OFFER_TRACKS se numbered lines + ₹50', /OFFER_TRACKS\s*\n?\.map\(\(t, i\) =>/.test(fwd));
  check('user card me score (n/total + ₹ pakka)', /claimedCount \* 50\} pakka/.test(fwd));

  const cart = fs.readFileSync('./swiggy-cart.js', 'utf8');
  check('cart summary me fourOffer banta hai', /function fourOfferSummaryFor\(account, claim\)/.test(cart));
  check('cart ke dono jagah fourOffer attach hota hai', (cart.match(/fourOffer: fourOfferSummaryFor\(account,/g) || []).length === 2);
  const vendor = fs.readFileSync('./bossbot/vendor/swiggy-cart.js', 'utf8');
  check('vendor copy bhi sync hai (fourOffer)', (vendor.match(/fourOffer: fourOfferSummaryFor\(account,/g) || []).length === 2);
}

console.log('\n=== 7. Forwarded order card me user ko live status dikhta hai ===');
{
  const flow = await import('./forwarded-order-flow.js');
  const order = {
    id: 'ord_v66',
    status: 'BILL_READY',
    cardStage: 'BILL_READY',
    isForwardedOrder: true,
    selectedAccount: 'acc_all',
    orderAccount: '9876500123',
    selectedAccountZeroOrders: true,
    finalPayable: 240,
    itemTotal: 260,
    deliveryFee: 0,
    items: [{ name: 'Paneer Roll', qty: 1, price: 260 }],
    address: true,
    cart: 'https://www.swiggy.com/group-cart/abc123',
    addressDetails: {
      address: 'Nadiad, Gujarat 387001, near Bus Stand',
      lat: '22.6939',
      lng: '72.8616',
      mobile: '9876500123'
    },
    createdAt: new Date().toISOString(),
    eventsClaimSummary: {
      offerLabel: '₹50 Free Cash (>₹199)',
      fourOffer: { lateNight: 'CLAIMED', breakfast: 'CLAIMED', extra50: 'PRE_LOCKED', weekend: 'FAILED', karwaChauth: 'FAILED', claimedCount: 2, total: 5, score: '2/5' }
    }
  };
  const db = { config: { accounts: { acc_all: ACC_ALL } }, orders: { ord_v66: order }, drafts: {} };
  const view = flow.buildForwardedOrderCardView(order, db, () => 'BODY');
  const text = typeof view === 'string' ? view : String(view?.text || '');
  check('user card me saare offer block aaya', /Saare 5 offer — har ek ₹50/.test(text), text.slice(0, 300));
  check('user card me har offer line + ₹50', /Morning Link/.test(text) && /Night Link/.test(text) && /Extra ₹50/.test(text) && /Weekend/.test(text) && (text.match(/₹50/g) || []).length >= 5);
  check('user card me 2/5 + ₹100/₹250', /2\/5 claimed/.test(text) && /₹100 pakka/.test(text) && /₹250 possible/.test(text));
  check('user card me pre-lock ⏳ aur fail ❌', /⏳/.test(text) && /❌/.test(text));
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
  ? `🏆 CHAAR OFFER STATUS — BOSS + USER, HAR EK ₹50 — ${passed}/${passed + failed} checks passed`
  : `❌ ${failed} checks FAILED — ${passed}/${passed + failed} passed`);
console.log('=====================================================================');
process.exitCode = failed === 0 ? 0 : 1;
