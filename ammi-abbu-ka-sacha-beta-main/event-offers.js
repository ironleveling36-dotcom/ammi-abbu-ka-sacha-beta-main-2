/**
 * event-offers.js — Swiggy ke CHAAR offer links, har JSON import par activate.
 *
 * Boss (29-10-2026) ne paanchva link diya — Karwa Chauth (`karwa-chauth-byo`),
 * "Pick ₹50 cash" — 29 Oct 3 PM se 30 Oct 6 AM tak.
 *
 * Boss (26-10-2026 raat) ne chaar link diye:
 *   1. pick-your-late-night-offer   (boss: "Morning Link")
 *   2. book-your-offer              (boss: "Night Link")
 *   3. pick-your-offer              ("Extra 50 Link")
 *   4. byo-weekend                  ("Weekend Link")
 *   — "JAB BHI FILE BHEJU SAARE OFFER ACTIVATE HONE CHAHIYE"
 *
 * Pehle sirf PEHLE DO claim hote the, aur ek hi offer par dobara-dobara claim
 * bhi chala jata tha ("2 times claim ho rha tha"). Yeh module:
 *   • chaaron links ke campaign id LIVE page se nikalta hai (prefix + day number),
 *   • har campaign ka asli state GET se padhta hai — pehle se sahi hai to KUCH
 *     likhta hi nahi (isliye double claim nahi hota),
 *   • likhne ke baad ek aur GET se read-back verify karta hai (HTTP 200 = claim
 *     nahi; sirf shouldNotify:true && value:1 sach hai),
 *   • ek hi account par ek waqt me ek hi claim run (import + cart scan + prebook
 *     sab ek hi promise share karte hain),
 *   • jo nahi hua, uska asli reason deta hai (koi jhoota "✓ sab ho gaya" nahi).
 *
 * Naya offer add karna = yahan ek entry. Engine, cards, import summary sab
 * `EVENT_OFFER_KEYS` / `OFFER_TRACKS` se ginti karte hain (hardcoded 4 nahi).
 *
 * Pure-ish: fetch inject kiya ja sakta hai (`fetchImpl`) — tests offline chalti hain.
 */

const EVENTS_API = 'https://events.swiggy.com/api/notify';
export const PREFERRED_OFFER_VALUE = 1;
export const PREFERRED_OFFER_LABEL = '₹50 off on ₹199';

export const EVENT_OFFER_OPTIONS = {
  1: { value: 1, shortLabel: '₹50 Free Cash (>₹199)' },
  2: { value: 2, shortLabel: '₹150 OFF Coupon (>₹249)' },
  3: { value: 3, shortLabel: '₹175 LN / ₹100 BF Coupon' },
  4: { value: 4, shortLabel: '₹100 OFF Coupon (>₹149)' }
};

/**
 * Slug se plausible campaign ids. Fixed-offer pages (pick-your-offer,
 * byo-weekend, karwa-chauth-byo) apni campaign id HTML me nahi deti — in
 * candidates ko LIVE likh kar read-back se verify kiya jata hai, isliye "guess"
 * kabhi sach nahi banta. Sirf naye link ke liye nayi entry chahiye, code nahi.
 */
export function slugCampaignCandidates(slug, day) {
  const parts = String(slug || '').split('-').filter(Boolean);
  const bare = parts.filter((p) => p !== 'byo').join('-');
  if (!bare) return [];
  // Order matters: ladder sirf 3-4 id par likhti hai (WAF limit), isliye
  // sabse sambhavit shapes pehle — plain slug, phir versioned + day-number.
  const out = [
    String(slug),
    `byo-${bare}-v1-${day}`,
    `byo-${bare}-${day}`,
    `byo-${bare}`,
    `byo-${bare}-v1`,
    `byo-${bare}-v2-${day}`,
    `byo-${bare}-v2`,
    `${slug}-${day}`,
    `${slug}-v1`,
    `byo-${bare}-v1-day-${day}`
  ];
  return [...new Set(out.map((x) => String(x).toLowerCase()))];
}

/**
 * Offers. `windowed` = campaign id me day number hota hai (aaj + kal
 * pre-lock); warna page se mila fixed campaign id hi chalta hai.
 */
export const EVENT_OFFERS = [
  {
    key: 'lateNight',
    bossLabel: 'Morning Link',
    name: 'Late Night (9PM–6AM slot)',
    url: 'https://events.swiggy.com/pick-your-late-night-offer',
    slug: 'pick-your-late-night-offer',
    prefixHint: 'byo-ln-v5-',
    windowed: true,
    isLateNight: true,
    cutoffH: 7.5,
    slotOpenH: 10,
    slotCloseH: 19
  },
  {
    key: 'breakfast',
    bossLabel: 'Night Link',
    name: 'Breakfast (7AM–11AM slot)',
    url: 'https://events.swiggy.com/book-your-offer',
    slug: 'book-your-offer',
    prefixHint: 'byo-bf-v10-',
    windowed: true,
    isLateNight: false,
    cutoffH: 18,
    slotOpenH: 20,
    slotCloseH: 24
  },
  {
    key: 'extra50',
    bossLabel: 'Extra 50 Link',
    name: 'Extra ₹50 offer',
    url: 'https://events.swiggy.com/pick-your-offer',
    slug: 'pick-your-offer',
    prefixHint: '',
    windowed: false,
    // Page par campaign id na mile to yeh ids EK-EK karke live verify hote
    // hain (write + read-back). Guess nahi — sirf jo verify ho wahi use hota hai.
    candidates: (day) => [
      `byo-pick-your-offer-v2-${day}`,
      `byo-pick-your-offer-v2-${day + 1}`,
      `byo-pick-your-offer-${day}`,
      `byo-pick-your-offer-v2`,
      `byo-pick-your-offer-v1-${day}`,
      `byo-pick-your-offer-v1`,
      `byo-pick-your-offer`,
      `byo-extra50-v1-${day}`,
      `byo-x50-v1-${day}`
    ]
  },
  {
    key: 'weekend',
    bossLabel: 'Weekend Link',
    name: 'Weekend offer',
    url: 'https://events.swiggy.com/byo-weekend',
    slug: 'byo-weekend',
    prefixHint: '',
    windowed: false,
    candidates: (day) => [
      `byo-weekend-v1-${day}`,
      `byo-weekend-v1`,
      `byo-weekend-${day}`,
      `byo-weekend`,
      `byo-weekend-v2`,
      `byo-weekend-v2-${day}`,
      `byo-wknd-v1`
    ]
  },
  {
    // 29-10-2026: boss ka naya link — "Karwa Chauth · Pick 50 cash".
    // 29 Oct 3 PM → 30 Oct 6 AM. Page par campaign id nahi hoti, isliye
    // slug-candidates live verify hote hain (jo verify ho wahi asli id).
    key: 'karwaChauth',
    bossLabel: 'Karwa Chauth',
    name: 'Karwa Chauth (Pick ₹50 cash)',
    url: 'https://events.swiggy.com/karwa-chauth-byo?utm_source=app&utm_medium=share',
    slug: 'karwa-chauth-byo',
    prefixHint: '',
    windowed: false,
    windowLabel: '29 Oct 3PM – 30 Oct 6AM',
    windowStart: '2026-10-29T15:00:00+05:30',
    windowEnd: '2026-10-30T06:00:00+05:30',
    candidates: (day) => slugCampaignCandidates('karwa-chauth-byo', day)
  }
];

export const EVENT_OFFER_LINKS = Object.fromEntries(EVENT_OFFERS.map((o) => [o.key, o.url]));
export const EVENT_OFFER_KEYS = EVENT_OFFERS.map((o) => o.key);

export function getEventOffer(key) {
  return EVENT_OFFERS.find((o) => o.key === key) || null;
}

// ── campaign id discovery ────────────────────────────────────────────────────

const DAY_SUFFIX_RE = /-(\d{1,3})$/;
// Swiggy ke campaign ids `byo-<slug>-v<n>-<day>` (windowed) ya `byo-<slug>[-v<n>]`
// (fixed) hote hain. Regex GREEDY rakho — lazy hone se `byo-pick-your-offer-v2-26`
// `byo-pick` ban jata tha (asli bug, test ne pakda).
const CAMPAIGN_TOKEN_RE = /byo-[a-z0-9][a-z0-9-]*/gi;
// Campaign-ish keys/params — in pages par id ka naam `byo-...` na ho to bhi
// pakdi jaye (Extra ₹50 / Weekend pages sach me bilkul khaali hote hain).
const CAMPAIGN_KEY_RE = /"(?:notify)?campaign[A-Za-z_]*"\s*:\s*"([a-z0-9][a-z0-9_-]{4,})"/gi;
const CAMPAIGN_PARAM_RE = /[?&]campaign=([a-z0-9][a-z0-9_-]{4,})/gi;
const SLUG_KEY_RE = /"(?:offerSlug|offer_slug|slug)"\s*:\s*"([a-z0-9][a-z0-9_-]{4,})"/gi;

/** HTML/JSON se sabse sahi campaign id candidates (lamba pehle). */
export function scanCampaignTokens(text) {
  const src = String(text || '');
  const raw = src.match(CAMPAIGN_TOKEN_RE) || [];
  const extra = [];
  for (const re of [CAMPAIGN_KEY_RE, CAMPAIGN_PARAM_RE, SLUG_KEY_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const v = String(m[1] || '').toLowerCase();
      // Slug-key values (jaise `book-your-offer`) campaign id nahi hote —
      // sirf tab lo jab usme digits ya `byo` ho.
      if (re === SLUG_KEY_RE && !/\d/.test(v) && !v.startsWith('byo')) continue;
      extra.push(v);
    }
  }
  const cleaned = [...new Set([...raw, ...extra].map((t) => String(t).replace(/[-_]+$/, '').toLowerCase()))]
    .filter((t) => t.length > 4 && t.length < 64);
  // `byo-` wale pehle (asli Swiggy naming), phir baaki — dono me lamba pehle.
  const byo = cleaned.filter((t) => t.startsWith('byo-')).sort((a, b) => b.length - a.length);
  const rest = cleaned.filter((t) => !t.startsWith('byo-')).sort((a, b) => b.length - a.length);
  return [...byo, ...rest];
}

function pickBestToken(tokens, offer) {
  const windowed = tokens.find((t) => /-v\d+-\d{1,3}$/.test(t));
  const versioned = tokens.find((t) => /-v\d+$/.test(t));
  const slugMatch = offer?.slug ? tokens.find((t) => t.includes(offer.slug)) : null;
  const exact = windowed || versioned || slugMatch || tokens[0] || '';
  if (!exact) return { prefix: '', fixed: '', token: '' };
  // Windowed offer (LN/BF) me day number badalta hai -> prefix chahiye.
  // Fixed offer (extra ₹50 / weekend) me page jo id de wahi asli hai — uska
  // day-number se anumaan NAHI lagate.
  if (offer?.windowed && windowed) {
    return { prefix: windowed.replace(DAY_SUFFIX_RE, '-'), fixed: '', token: windowed };
  }
  if (offer?.windowed && versioned) {
    // `byo-ln-v6` mila (day number ke bina) — prefix banao.
    return { prefix: `${versioned}-`, fixed: '', token: versioned };
  }
  return { prefix: '', fixed: exact, token: exact };
}

/**
 * Page HTML se campaign info nikalo. Swiggy ke offer pages Next.js hain aur
 * `props.pageProps.nexusData` me `notifyCampaignIdPrefix` + `dayBoundaries`
 * dete hain. Na mile to HTML ke andar `byo-...` tokens scan karte hain, aur
 * aakhri fallback slug-based prefix hota hai (source me likha jata hai).
 */
export function extractCampaignInfoFromHtml(html, offer) {
  const text = String(html || '');
  const out = { prefix: '', fixedCampaignId: '', boundaries: [], source: 'NONE' };

  const nextData = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData[1]);
      const nexus = parsed?.props?.pageProps?.nexusData || {};
      const prefix = String(nexus.notifyCampaignIdPrefix || '').trim();
      const fixed = String(nexus.notifyCampaignId || nexus.campaignId || nexus.campaign_id || '').trim();
      const boundaries = Array.isArray(nexus.dayBoundaries) ? nexus.dayBoundaries : [];
      if (prefix) { out.prefix = prefix; out.source = 'NEXT_DATA'; }
      else if (fixed) { out.fixedCampaignId = fixed; out.source = 'NEXT_DATA'; }
      if (boundaries.length) { out.boundaries = boundaries; out.source = 'NEXT_DATA'; }
      if (!out.prefix && !out.fixedCampaignId) {
        // NexusData ke andar kahin bhi campaign id ho sakti hai — poora JSON scan.
        const best = pickBestToken(scanCampaignTokens(JSON.stringify(nexus)), offer);
        if (best.prefix || best.fixed) {
          out.prefix = best.prefix;
          out.fixedCampaignId = best.fixed;
          out.source = 'NEXT_DATA_SCAN';
        }
      }
    } catch { /* fall through to raw scan */ }
  }

  // `notifyCampaignIdPrefix` page ke kisi bhi JSON blob me ho sakta hai (NEXT_DATA
  // ka exact path Swiggy badalta rehta hai) — seedha text se bhi pakdo.
  if (!out.prefix && !out.fixedCampaignId) {
    const prefixHit = text.match(/"notifyCampaignIdPrefix"\s*:\s*"([^"]+)"/);
    const fixedHit = text.match(/"(?:notifyCampaignId|campaignId|campaign_id)"\s*:\s*"(byo[^"]*)"/i);
    if (prefixHit?.[1]) { out.prefix = prefixHit[1].trim(); out.source = 'PAGE_JSON'; }
    else if (fixedHit?.[1]) { out.fixedCampaignId = fixedHit[1].trim(); out.source = 'PAGE_JSON'; }
  }

  if (!out.prefix && !out.fixedCampaignId) {
    const best = pickBestToken(scanCampaignTokens(text), offer);
    if (best.prefix || best.fixed) {
      out.prefix = best.prefix;
      out.fixedCampaignId = best.fixed;
      out.source = 'HTML_SCAN';
    }
  }

  // Fixed offers (pick-your-offer / byo-weekend) ki campaign id SIRF live page
  // se leni hai. Pehle yahan slug se id "guess" hoti thi (byo-pick-your-offer) —
  // woh galat id par write kar deti thi aur card me jhootha ✓ dikhta tha.
  // Ab: id na mile to khaali chhodo, doctor asli reason batayega.
  if (!out.prefix && !out.fixedCampaignId && offer?.windowed && offer?.prefixHint) {
    out.prefix = offer.prefixHint;
    out.source = 'HINT';
  }

  return out;
}

let _metaCache = null;
let _metaAt = 0;
const META_TTL_MS = 15 * 60 * 1000;

/**
 * Chaaron offer pages ka live meta (prefix / fixed id / day boundaries).
 * Cache 15 min. Page na khula to `source` me sach likha jata hai.
 */
export async function discoverOfferMeta({ force = false, fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (!force && _metaCache && Date.now() - _metaAt < META_TTL_MS) return _metaCache;
  const meta = {};
  // Read independent pages together, not five sequential network timeouts.
  await Promise.all(EVENT_OFFERS.map(async offer => {
    let info = { prefix: offer.prefixHint || '', fixedCampaignId: '', boundaries: [], source: offer.prefixHint ? 'HINT' : 'NONE', error: '' };
    try {
      const res = await fetchImpl(offer.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res && typeof res.text === 'function') {
        const html = await res.text();
        info = { ...extractCampaignInfoFromHtml(html, offer), error: '' };
        if (offer.windowed && !info.prefix && offer.prefixHint) info.prefix = offer.prefixHint;
      }
    } catch (err) {
      info.error = String(err?.message || err).slice(0, 120);
      if (offer.prefixHint) info.prefix = info.prefix || offer.prefixHint;
    }
    meta[offer.key] = info;
  }));
  _metaCache = meta;
  _metaAt = Date.now();
  return meta;
}

export function resetEventOfferMetaCache() {
  _metaCache = null;
  _metaAt = 0;
  claimLedger.clear();
  accountRuns.clear();
}

/** Swiggy ka "day" 11:00 IST par badalta hai (midnight par nahi). */
function swiggyDayNumber(nowMs) {
  const H = 3600 * 1000;
  const ist = new Date(nowMs + 5.5 * H);
  const shift = ist.getUTCHours() < 11 ? -1 : 0;
  return ist.getUTCDate() + shift;
}

/**
 * Diye gaye campaign id ka redeem window ABHI khula hai ya nahi.
 * Pre-book (aaj + kal) me kal wali id ka window abhi band hota hai — us case
 * me Swiggy likh kar bhi `shouldNotify:false` hi dikhata hai. Isliye band
 * window par hum "save nahi hua" nahi kehte, "pre-lock ho gaya" kehte hain
 * aur dobara likhte hi nahi (wahi to "2 times claim" tha).
 */
function isWindowOpenNow(campaignId, info, nowMs) {
  const bounds = Array.isArray(info?.boundaries) ? info.boundaries : [];
  if (!bounds.length) return null; // pata nahi — jhooth mat bolo
  const dayMatch = String(campaignId || '').match(/(\d+)\s*$/);
  const day = dayMatch ? Number(dayMatch[1]) : null;
  const scoped = day === null ? bounds : bounds.filter((b) => Number(b.day) === day);
  if (!scoped.length) return null;
  return scoped.some((b) => {
    const start = Date.parse(b.startTime);
    const end = Date.parse(b.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && nowMs >= start && nowMs < end;
  });
}

/**
 * Ek offer ke aaj ke + kal ke campaign id. `windowed` offers me day number
 * lagta hai; fixed offers me wahi id.
 */
export function campaignIdsForOffer(offerKey, meta, nowMs = Date.now()) {
  const offer = getEventOffer(offerKey);
  const info = meta?.[offerKey] || {};
  if (!offer) return { ids: [], source: 'UNKNOWN', prefix: '', fixed: '' };

  if (offer.windowed) {
    const prefix = String(info.prefix || offer.prefixHint || '');
    if (!prefix) return { ids: [], source: info.source || 'NONE', prefix: '', fixed: '' };
    // Live boundaries ho to unse aaj ka day lo (Swiggy ka asli schedule).
    let day = swiggyDayNumber(nowMs);
    if (Array.isArray(info.boundaries) && info.boundaries.length) {
      const hit = info.boundaries.find((b) => {
        const s = Date.parse(b.startTime);
        const e = Date.parse(b.endTime);
        return Number.isFinite(s) && nowMs >= s && nowMs < e;
      });
      if (hit?.day) day = Number(hit.day);
    }
    const ids = [`${prefix}${day}`, `${prefix}${day + 1}`];
    return { ids, source: info.source || 'PREFIX', prefix, fixed: '' };
  }

  const fixed = String(info.fixedCampaignId || '').trim();
  if (fixed) return { ids: [fixed], source: info.source || 'FIXED', prefix: '', fixed };
  return { ids: [], source: info.source || 'NONE', prefix: '', fixed: '' };
}

// ── fixed offers (Extra ₹50 / Weekend): self-verifying discovery ─────────────
//
// `pick-your-offer` aur `byo-weekend` page apne campaign id HTML me NAHI dete
// (isliye bot sirf Late Night + Breakfast claim kar pata tha). Yahan id ka
// anumaan nahi lagta — candidates KO LIVE likh kar read-back se verify karte
// hain: jo id read-back me `shouldNotify:true` lauta de, wahi asli id hai.
// Pehla success 6 ghante cache hota hai, isliye 19 ID par sirf ek hi baar
// discovery chalti hai.

const resolvedFixedIds = new Map(); // `${offerKey}|${day}` -> { id, at, source, tried }
const FIXED_ID_TTL_MS = 6 * 60 * 60 * 1000;
const FIXED_ID_NEGATIVE_TTL_MS = 10 * 60 * 1000;
// Har write ke saath 2-3 GET jata hai (WAF <40 req/10s) — 4 write safe hai aur
// naye offers ke id-shapes cover karta hai. Discovery 6h cache hoti hai.
const MAX_LADDER_WRITES = 4;

/** Pehle se resolved fixed campaign id (agar cache fresh hai). */
export function cachedFixedCampaignId(offerKey, nowMs = Date.now()) {
  const day = swiggyDayNumber(nowMs);
  const rec = resolvedFixedIds.get(`${offerKey}|${day}`);
  if (!rec) return null;
  const ttl = rec.id ? FIXED_ID_TTL_MS : FIXED_ID_NEGATIVE_TTL_MS;
  if (Date.now() - rec.at > ttl) {
    resolvedFixedIds.delete(`${offerKey}|${day}`);
    return null;
  }
  return rec;
}

/** Resolved id yaad rakho (aur meta cache me bhi, taaki doctor wahi dikhaye). */
export function rememberFixedCampaignId(offerKey, id, { source = 'CANDIDATE_VERIFIED', tried = [], nowMs = Date.now() } = {}) {
  const day = swiggyDayNumber(nowMs);
  resolvedFixedIds.set(`${offerKey}|${day}`, { id: id || '', at: Date.now(), source, tried: tried.slice(0, 8) });
  if (id && _metaCache && _metaCache[offerKey]) {
    _metaCache[offerKey] = { ..._metaCache[offerKey], fixedCampaignId: id, source };
  }
  return day;
}

export function resetFixedCampaignCache() {
  resolvedFixedIds.clear();
}

// Extra ₹50 / Weekend page par id nahi hoti — to ho sakta hai woh kisi chhote
// JSON endpoint se aati ho. Yeh sirf DISCOVERY ke waqt (6h me ek baar) chalta
// hai; jo bhi mile use claim ke waqt live verify kiya jata hai.
const FIXED_DISCOVERY_PATHS = (slug) => [
  `/api/campaign/${slug}`,
  `/api/campaign/details?slug=${slug}`,
  `/api/campaign?slug=${slug}`,
  `/api/campaigns?slug=${slug}`,
  `/api/notify/campaign/${slug}`
];

async function discoverFixedCampaignIdsFromApis(offer, { fetchImpl, timeoutMs = 4000 } = {}) {
  const found = [];
  for (const path of FIXED_DISCOVERY_PATHS(String(offer?.slug || ''))) {
    if (!offer?.slug) break;
    try {
      const res = await fetchImpl(`https://events.swiggy.com${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res?.ok) continue;
      const text = typeof res.text === 'function' ? await res.text() : '';
      for (const token of scanCampaignTokens(text)) {
        if (!found.includes(token)) found.push(token);
      }
    } catch { /* endpoint nahi hai — koi baat nahi */ }
    if (found.length >= 4) break;
  }
  return found.slice(0, 5);
}

/** Ops escape hatch: `EVENT_OFFER_EXTRA_CANDIDATES=extra50:byo-x-1,weekend:byo-w-1`. */
function envExtraCandidates(offerKey) {
  const raw = String(process.env.EVENT_OFFER_EXTRA_CANDIDATES || '').trim();
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const [k, v] = part.split(':').map((x) => String(x || '').trim());
    if (!v) continue;
    if (!k || k === offerKey) out.push(v);
  }
  return out.slice(0, 6);
}

/**
 * Fixed offer ka campaign id dhoondo AUR claim karo (ek hi pass me).
 * Returns `{ campaignId, metaSource, results, tried }`.
 */
async function claimFixedOfferViaLadder(offer, {
  account,
  headers,
  auth,
  fetchImpl,
  value,
  force,
  nowMs = Date.now()
}) {
  const day = swiggyDayNumber(nowMs);
  const cacheKey = `${offer.key}|${day}`;
  const cached = resolvedFixedIds.get(cacheKey);
  if (cached) {
    const ttl = cached.id ? FIXED_ID_TTL_MS : FIXED_ID_NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (!cached.id) {
        return { campaignId: '', metaSource: 'CANDIDATE_FAILED_CACHED', results: [], tried: cached.tried || [] };
      }
      const res = await ensureCampaignClaim(account, {
        campaignId: cached.id,
        offerKey: offer.key,
        referer: offer.url,
        value,
        headers,
        auth,
        fetchImpl,
        force,
        windowOpen: null
      });
      // Cache hit: koi naya probe/write nahi hua — purana discovery record
      // `cachedTried` me alag rakha jata hai (warna "dobara ladder chali" lagta).
      return { campaignId: cached.id, metaSource: 'CACHED_RESOLVED', results: [res], tried: [], cachedTried: cached.tried || [] };
    }
    resolvedFixedIds.delete(cacheKey);
  }

  const baseCandidates = typeof offer.candidates === 'function' ? offer.candidates(day) : [];
  const apiCandidates = await discoverFixedCampaignIdsFromApis(offer, { fetchImpl });
  const candidates = [...new Set([
    ...apiCandidates,
    ...envExtraCandidates(offer.key),
    ...baseCandidates
  ])].slice(0, 16);
  const tried = [];
  let authFailed = false;

  // Phase 1 — sirf padho (koi write nahi): koi campaign pehle se laga hua mila?
  // WAF ki limit (<40 req/10s) ka khayal: zyada se zyada 6 probe.
  for (const id of candidates.slice(0, 6)) {
    const before = await readCampaignState(id, { headers, fetchImpl });
    tried.push({ id, probe: before.httpStatus || 0, active: Boolean(before.shouldNotify), value: Number(before.value || 0), phase: 'probe' });
    if (before.httpStatus === 401) { authFailed = true; break; }
    if (before.ok && before.shouldNotify) {
      const res = await ensureCampaignClaim(account, {
        campaignId: id,
        offerKey: offer.key,
        referer: offer.url,
        value,
        headers,
        auth,
        fetchImpl,
        force,
        windowOpen: null
      });
      if (res.verified) {
        rememberFixedCampaignId(offer.key, id, { tried, nowMs });
        return { campaignId: id, metaSource: 'RESOLVED_ALREADY_ACTIVE', results: [res], tried };
      }
    }
  }
  if (authFailed) {
    return {
      campaignId: '',
      metaSource: 'AUTH_FAILED',
      results: [{ campaignId: '', state: 'AUTH_FAILED', verified: false, writes: 0, reason: 'session se mana (401) — re-login' }],
      tried
    };
  }

  // Phase 2 — candidate par likho aur read-back se verify karo. Sirf jo verify
  // ho wahi asli id hai; baaki chhod diye jate hain (junk id par likhna no-op).
  let writes = 0;
  for (const id of candidates) {
    if (writes >= MAX_LADDER_WRITES) break;
    const res = await ensureCampaignClaim(account, {
      campaignId: id,
      offerKey: offer.key,
      referer: offer.url,
      value,
      headers,
      auth,
      fetchImpl,
      force: true,
      windowOpen: null
    });
    writes += Number(res.writes || 0);
    tried.push({ id, state: res.state, verified: Boolean(res.verified), phase: 'write' });
    if (res.state === 'RATE_LIMITED') {
      return { campaignId: id, metaSource: 'RATE_LIMITED', results: [res], tried };
    }
    if (res.verified) {
      rememberFixedCampaignId(offer.key, id, { tried, nowMs });
      return { campaignId: id, metaSource: 'CANDIDATE_VERIFIED', results: [res], tried };
    }
  }

  rememberFixedCampaignId(offer.key, '', { source: 'CANDIDATE_FAILED', tried, nowMs });
  const idList = candidates.slice(0, 5).join(', ');
  const wrongReward = tried.find((t) => t.phase === 'write' && t.state === 'WRONG_REWARD');
  return {
    campaignId: wrongReward?.id || '',
    metaSource: wrongReward ? 'WRONG_REWARD' : 'CANDIDATE_FAILED',
    tried,
    results: [{
      campaignId: wrongReward?.id || '',
      state: wrongReward ? 'WRONG_REWARD' : 'NO_CAMPAIGN_ID',
      verified: false,
      writes: 0,
      reason: wrongReward
        ? `${offer.name}: Swiggy ne campaign ${wrongReward.id} par doosra reward save rakha hai — ₹50 free cash (option 1) nahi mila`
        : `Swiggy ne ${offer.name} ka campaign id nahi bataya — ${Math.min(writes, MAX_LADDER_WRITES)} candidate likh kar dekhe (${idList}), koi verify nahi hua`
    }]
  };
}

// ── claim engine ─────────────────────────────────────────────────────────────

// Kitni der tak "is campaign par likh diya" yaad rahe (double claim rokne ke liye).
const ledger = new Map();       // `${accSig}|${campaignId}` -> { value, at, verified, state }
export const claimLedger = ledger;
const LEDGER_TTL_MS = 6 * 60 * 60 * 1000;
// PRE_LOCKED = write accept hua par window band tha. Yeh SIRF "dobara write na
// karo" ke liye hai — 6 ghante tak ise sach nahi maana ja sakta, warna slot
// khulne par bhi offer lagta hi nahi (cart me free cash nahi aata → QR bina
// offer ka banta tha). Isliye 45 min baad dobara live check hota hai.
const PRE_LOCK_TTL_MS = 45 * 60 * 1000;
const accountRuns = new Map();  // accSig -> promise (ek waqt me ek run)

function accountSignature(account) {
  return String(
    account?.id || account?.phone || account?.customerId || account?.token ||
    String(account?.cookies || '').slice(0, 80) || 'unknown'
  );
}

/** Baaki modules (swiggy-bridge ka purana claim path) bhi isi ledger ka hissa hon. */
export function campaignClaimSignature(account) {
  return accountSignature(account);
}

function ledgerGet(accSig, campaignId) {
  const rec = ledger.get(`${accSig}|${campaignId}`);
  if (!rec) return null;
  if (Date.now() - rec.at > LEDGER_TTL_MS) {
    ledger.delete(`${accSig}|${campaignId}`);
    return null;
  }
  return rec;
}

function ledgerSet(accSig, campaignId, value, verified, state = '') {
  ledger.set(`${accSig}|${campaignId}`, { value, at: Date.now(), verified: Boolean(verified), state });
}

/**
 * Kisi campaign par kuch hi der pehle likha gaya tha? Purane claim path
 * (`claimSwiggyBreakfastAndLateNightOffers`) isi se poochta hai, isliye dono
 * raaste ek hi ledger share karte hain — "2 times claim" dono taraf se band.
 */
export function recentCampaignClaim(account, campaignId, nowMs = Date.now()) {
  const rec = ledgerGet(accountSignature(account), campaignId);
  if (!rec) return null;
  const ageMs = Math.max(0, nowMs - rec.at);
  return {
    ...rec,
    ageMs,
    // Purana pre-lock bharosemand nahi — dobara live check hona chahiye.
    stalePreLock: rec.state === 'PRE_LOCKED' && ageMs > PRE_LOCK_TTL_MS
  };
}

/** Legacy path write ke baad ledger me note karta hai (same key, same TTL). */
export function noteCampaignClaim(account, campaignId, { value = PREFERRED_OFFER_VALUE, verified = false, state = '' } = {}) {
  if (!campaignId) return;
  ledgerSet(accountSignature(account), campaignId, Number(value) || PREFERRED_OFFER_VALUE, verified, state);
}

function decodeJwtExpSec(jwt) {
  try {
    const part = String(jwt || '').split('.')[1];
    if (!part) return 0;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(json?.exp || 0);
  } catch {
    return 0;
  }
}

/** events.swiggy.com sirf { token, tid } headers maanta hai (Cookie = CloudFront 403). */
export function resolveEventOfferAuth(account) {
  const acc = account || {};
  let token = String(acc.token || '');
  let tid = String(acc.jwtTid || acc.tid || '');
  const cookieStr = String(acc.cookies || '');
  for (const part of cookieStr.split(';').map((s) => s.trim())) {
    if (!token && part.startsWith('token=')) token = part.slice(6);
    if (!tid && part.startsWith('tid=') && part.slice(4).includes('.')) tid = part.slice(4);
    if (!tid && part.startsWith('_session_tid=') && part.slice(13).includes('.')) tid = part.slice(13);
  }
  return { token: token || tid, tid, hasToken: Boolean(token), hasTid: Boolean(tid) };
}

function buildHeaders(auth) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    token: auth.token || auth.tid || '',
    tid: auth.tid || auth.token || '',
    Origin: 'https://events.swiggy.com',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  };
}

async function readCampaignState(campaignId, { headers, fetchImpl, timeoutMs = 5500 }) {
  try {
    const res = await fetchImpl(`${EVENTS_API}?campaign=${encodeURIComponent(campaignId)}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await res.json().catch(() => ({}));
    return {
      ok: Boolean(res.ok),
      httpStatus: Number(res.status || 0),
      shouldNotify: Boolean(json?.shouldNotify),
      value: Number(json?.value || 0),
      timestamp: json?.timestamp || ''
    };
  } catch (err) {
    return { ok: false, httpStatus: 0, shouldNotify: false, value: 0, timestamp: '', error: String(err?.message || err).slice(0, 120) };
  }
}

/**
 * Ek campaign ko chahiye wali state me lao — par pehle padho:
 *   already `shouldNotify:true && value:N` hai  →  kuch likho hi nahi (0 write)
 *   nahi hai                                     →  ek POST/PATCH
 *   phir ek GET se read-back verify
 */
export async function ensureCampaignClaim(account, {
  campaignId,
  offerKey = '',
  referer = '',
  value = PREFERRED_OFFER_VALUE,
  headers = null,
  auth = null,
  fetchImpl = globalThis.fetch,
  force = false,
  maxRetries = 1,
  timeoutMs = 5500,
  windowOpen = null
} = {}) {
  if (!campaignId) {
    return { campaignId: '', state: 'NO_CAMPAIGN_ID', writes: 0, verified: false, reason: 'campaign id nahi mila (offer page se)' };
  }
  const accSig = accountSignature(account);
  const resolvedAuth = auth || resolveEventOfferAuth(account);
  const hdr = headers || buildHeaders(resolvedAuth);
  if (!hdr.token && !hdr.tid) {
    return { campaignId, state: 'NO_SESSION', writes: 0, verified: false, reason: 'ID me token/tid nahi — re-login karein' };
  }

  const cached = ledgerGet(accSig, campaignId);
  if (cached && cached.verified && cached.value === value && !force) {
    // Isi campaign par kuch hi der pehle verified likha gaya — dobara chhedna
    // hi "2 times claim" banata tha.
    return { campaignId, state: 'ALREADY_VERIFIED', writes: 0, verified: true, cached: true, reason: 'pehle se locked (read-back verified)' };
  }
  const preLockFresh = cached && cached.state === 'PRE_LOCKED'
    && cached.value === value
    && (Date.now() - cached.at) < PRE_LOCK_TTL_MS
    && windowOpen !== true; // window khul gaya → dobara live check
  if (preLockFresh) {
    // Window band tha, hum pehle hi likh chuke hain. `force` par bhi dobara
    // nahi likhenge — yahi boss ki shikayat ("2 times claim") thi.
    return { campaignId, state: 'PRE_LOCKED', writes: 0, verified: false, cached: true, reason: 'pre-lock pehle ho chuka (window band) — dobara nahi likhenge' };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(4000, timeoutMs)));
    const before = await readCampaignState(campaignId, { headers: hdr, fetchImpl, timeoutMs });
    if (before.httpStatus === 401) {
      return { campaignId, state: 'AUTH_FAILED', writes: 0, verified: false, httpStatus: 401, reason: 'session se mana (401) — re-login' };
    }
    if ([403, 429].includes(before.httpStatus) && attempt < maxRetries) continue; // WAF burst → window reset
    if (!before.ok) {
      return {
        campaignId,
        state: before.httpStatus ? 'PROBE_FAILED' : 'NETWORK_FAILED',
        writes: 0,
        verified: false,
        httpStatus: before.httpStatus,
        reason: before.httpStatus ? `events.swiggy.com HTTP ${before.httpStatus}` : (before.error || 'network')
      };
    }
    if (before.shouldNotify && before.value === value) {
      ledgerSet(accSig, campaignId, value, true);
      return { campaignId, state: 'ALREADY_ACTIVE', writes: 0, verified: true, httpStatus: before.httpStatus, value: before.value, reason: 'pehle se active' };
    }

    const method = before.shouldNotify ? 'PATCH' : 'POST';
    let writeRes = null;
    let writeJson = {};
    try {
      writeRes = await fetchImpl(EVENTS_API, {
        method,
        headers: { ...hdr, ...(referer ? { Referer: referer } : {}) },
        body: JSON.stringify({ campaign: campaignId, value }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      writeJson = await writeRes.json().catch(() => ({}));
      if ([403, 429].includes(Number(writeRes.status))) {
        if (attempt < maxRetries) continue; // WAF burst → 4s baad ek aur koshish
        // Retry bhi 403/429 → yeh "save nahi hua" nahi, Swiggy ne request hi
        // rok di. Jhoothi wajah mat likho.
        return {
          campaignId,
          method,
          writes: 0,
          state: 'RATE_LIMITED',
          verified: false,
          httpStatus: Number(writeRes.status),
          reason: `Swiggy ne request rok di (HTTP ${writeRes.status} WAF/throttle) — claim nahi hua, 10 min baad retry`
        };
      }
    } catch (err) {
      if (attempt < maxRetries) continue;
      return { campaignId, state: 'WRITE_FAILED', writes: 0, verified: false, reason: String(err?.message || err).slice(0, 120) };
    }

    let after = await readCampaignState(campaignId, { headers: hdr, fetchImpl, timeoutMs });
    let claimedAny = after.ok && after.shouldNotify === true;
    let ok = claimedAny && after.value === value;

    // ── REWARD LOCK: "claimed" ka matlab ₹50 free cash (option 1) hi hai ─────
    // Swiggy kabhi shouldNotify:true rakhta hai par doosra reward (option 2/3/4)
    // save kar deta hai. Woh ₹50 free cash NAHI hai. Pehle hum use bhi
    // "CLAIMED" bol dete the — isi liye card me "offer claimed" dikhta tha par
    // asli ₹50 nahi lagta tha. Ab: ek baar PATCH se option 1 force karte hain
    // aur dobara read-back; phir bhi na bade to saaf WRONG_REWARD.
    if (claimedAny && !ok) {
      try {
        await fetchImpl(EVENTS_API, {
          method: 'PATCH',
          headers: { ...hdr, ...(referer ? { Referer: referer } : {}) },
          body: JSON.stringify({ campaign: campaignId, value }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch { /* read-back hi sach batayega */ }
      after = await readCampaignState(campaignId, { headers: hdr, fetchImpl, timeoutMs });
      claimedAny = after.ok && after.shouldNotify === true;
      ok = claimedAny && after.value === value;
    }
    // Write accept hua par state save nahi — agar window ABHI band hai to yeh
    // normal pre-book hai (Swiggy band slot par shouldNotify:false hi rakhta
    // hai). Use PRE_LOCKED maano: 6h tak dobara write nahi.
    const preLocked = !claimedAny && after.ok && Number(writeRes.status) >= 200 && Number(writeRes.status) < 300 && windowOpen === false;
    const state = ok
      ? 'CLAIMED'
      : claimedAny
        ? 'WRONG_REWARD'
        : preLocked
          ? 'PRE_LOCKED'
          : (after.ok ? 'WRITE_NOT_SAVED' : 'READBACK_FAILED');
    // PRE_LOCKED me humne jo value bheji wahi yaad rakhte hain (read-back 0
    // dikhata hai kyunki window band hai) — warna har call dobara likhega.
    ledgerSet(accSig, campaignId, ok ? value : (preLocked ? value : after.value), ok, state);
    return {
      campaignId,
      method,
      writes: 1,
      state,
      // `verified` = ASLI ₹50 free cash (option ${value}) server par save hai.
      verified: ok,
      valueMatched: ok,
      savedValue: Number(after.value || 0),
      preLocked,
      httpStatus: Number(writeRes.status || 0),
      value: after.value,
      shouldNotify: after.shouldNotify,
      message: writeJson?.message || '',
      reason: ok
        ? `claim ho gaya (read-back: option ${after.value})`
        : claimedAny
          ? `Swiggy ne option ${after.value} (${(EVENT_OFFER_OPTIONS[after.value] || {}).shortLabel || 'doosra reward'}) save rakha hai — ₹50 free cash (option 1) nahi mila, dobara PATCH ke baad bhi nahi`
          : preLocked
          ? 'pre-lock ho gaya (window abhi band hai, Swiggy slot khulne par laga dega)'
          : after.ok
            ? `Swiggy ne likha par save nahi kiya (read-back: shouldNotify=${after.shouldNotify}, value=${after.value})`
            : `read-back fail (HTTP ${after.httpStatus || 'network'}) — claim ka pakka pata nahi`
    };
  }
  return { campaignId, state: 'RATE_LIMITED', writes: 0, verified: false, reason: 'Swiggy ne throttle kiya (403/429) — 10 min baad retry' };
}

/**
 * CHAARON offers activate karo — ek hi account par ek waqt me ek run.
 * JSON import, cart scan, pre-book loop — sab isi ko call karte hain, isliye
 * double claim possible nahi.
 */
export async function activateAllEventOffers(account, {
  force = false,
  offerValue = PREFERRED_OFFER_VALUE,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  meta = null,
  offerKeys = EVENT_OFFER_KEYS,
  skipIfRunInFlight = false,
  requestTimeoutMs = 5500,
  maxRetries = 1,
  deadlineAt = Infinity,
  parallelOffers = false,
  currentWindowOnly = false
} = {}) {
  const accSig = accountSignature(account);
  const runKey = `${accSig}:v${offerValue}:${[...offerKeys].sort().join(',')}`;
  const inflight = accountRuns.get(runKey);
  if (inflight) {
    if (skipIfRunInFlight) return { ...(await inflight), sharedRun: true };
    return inflight;
  }

  const run = (async () => {
    const remaining = () => Math.max(0, deadlineAt - Date.now());
    const resolvedMeta = meta || (remaining() > 0 ? await discoverOfferMeta({ fetchImpl, timeoutMs: Math.min(2500, requestTimeoutMs, remaining()) }) : {});
    const auth = resolveEventOfferAuth(account);
    const headers = buildHeaders(auth);
    const offers = {};
    let claimed = 0;
    let already = 0;
    let failed = 0;
    let preLocked = 0;

    const processOffer = async offerKey => {
      if (remaining() <= 0) return;
      const offer = getEventOffer(offerKey);
      if (!offer) return;
      let { ids, source } = campaignIdsForOffer(offerKey, resolvedMeta, nowMs);
      if (currentWindowOnly && offer.windowed) ids = ids.slice(0, 1);
      let ladderFailure = null;

      // Fixed offers (Extra ₹50 / Weekend): inke page par campaign id nahi hoti,
      // isliye self-verifying ladder — jo id likhne ke baad read-back me verify
      // ho jaye wahi asli hai. Isse hi Extra ₹50 aur Weekend claim hote hain.
      if (!ids.length && !offer.windowed && typeof offer.candidates === 'function') {
        const ladder = await claimFixedOfferViaLadder(offer, {
          account, headers, auth, fetchImpl, value: offerValue, force, nowMs
        });
        const primary = ladder.results?.[0] || null;
        const ladderState = String(primary?.state || '').toUpperCase();
        const isAlready = ladderState === 'ALREADY_ACTIVE' || ladderState === 'ALREADY_VERIFIED';

        if (ladder.campaignId && primary?.verified) {
          if (isAlready) already += 1; else claimed += 1;
          offers[offerKey] = {
            key: offerKey,
            bossLabel: offer.bossLabel,
            name: offer.name,
            url: offer.url,
            campaign: ladder.campaignId,
            ids: [ladder.campaignId],
            metaSource: ladder.metaSource,
            status: 'CLAIMED',
            state: primary.state,
            verified: true,
            valueMatched: primary.valueMatched !== false,
            alreadyActive: isAlready,
            writes: Number(primary.writes || 0),
            campaignUrl: offer.url,
            discount: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
            message: primary.reason || '',
            results: ladder.results,
            tried: ladder.tried,
            cachedTried: ladder.cachedTried || []
          };
          return;
        }

        if (ladderState === 'RATE_LIMITED' || ladderState === 'AUTH_FAILED') {
          failed += 1;
          offers[offerKey] = {
            key: offerKey,
            bossLabel: offer.bossLabel,
            name: offer.name,
            url: offer.url,
            campaign: ladder.campaignId || '',
            ids: ladder.campaignId ? [ladder.campaignId] : [],
            metaSource: ladder.metaSource,
            status: 'FAILED',
            state: ladderState,
            verified: false,
            alreadyActive: false,
            writes: 0,
            campaignUrl: offer.url,
            discount: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
            message: primary?.reason || '',
            results: ladder.results,
            tried: ladder.tried
          };
          return;
        }

        if (ladderState === 'WRONG_REWARD' && ladder.campaignId) {
          // Id mil gayi, offer bhi "save" hua — par ₹50 free cash nahi. Sach bolo.
          failed += 1;
          offers[offerKey] = {
            key: offerKey,
            bossLabel: offer.bossLabel,
            name: offer.name,
            url: offer.url,
            campaign: ladder.campaignId,
            ids: [ladder.campaignId],
            metaSource: ladder.metaSource,
            status: 'WRONG_REWARD',
            state: 'WRONG_REWARD',
            verified: false,
            alreadyActive: false,
            writes: 0,
            campaignUrl: offer.url,
            discount: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
            message: primary?.reason || '',
            results: ladder.results,
            tried: ladder.tried
          };
          return;
        }
        ladderFailure = ladder;
        source = ladder.metaSource;
      }
      if (!ids.length) {
        offers[offerKey] = {
          key: offerKey,
          bossLabel: offer.bossLabel,
          name: offer.name,
          url: offer.url,
          campaign: '',
          ids: [],
          metaSource: source,
          status: 'NO_CAMPAIGN_ID',
          state: 'NO_CAMPAIGN_ID',
          verified: false,
          claimed: false,
          message: ladderFailure?.results?.[0]?.reason
            || 'offer page se campaign id nahi mili — link khol kar ek baar claim karein',
          reason: ladderFailure?.results?.[0]?.reason
            || 'offer page se campaign id nahi mili — link khol kar ek baar claim karein',
          tried: ladderFailure?.tried || []
        };
        failed += 1;
        return;
      }
      const results = [];
      for (const campaignId of ids) {
        if (remaining() <= 0) break;
        const out = await ensureCampaignClaim(account, {
          campaignId,
          offerKey,
          referer: offer.url,
          value: offerValue,
          headers,
          auth,
          fetchImpl,
          force,
          maxRetries,
          timeoutMs: Math.min(requestTimeoutMs, remaining()),
          windowOpen: isWindowOpenNow(campaignId, resolvedMeta?.[offerKey], nowMs)
        });
        results.push(out);
      }
      if (!results.length) return;
      const primary = results[0];
      const anyClaimed = results.some((r) => r.state === 'CLAIMED' || r.verified);
      const allVerified = results.every((r) => r.verified);
      const anyPreLocked = results.some((r) => r.state === 'PRE_LOCKED');
      // Swiggy ne offer save kiya par ₹50 (option 1) nahi — yeh CLAIMED nahi hai.
      const anyWrongReward = results.some((r) => r.state === 'WRONG_REWARD');
      if (primary?.state === 'ALREADY_ACTIVE' || primary?.state === 'ALREADY_VERIFIED') already += 1;
      else if (primary?.verified) claimed += 1;
      else if (primary?.state === 'PRE_LOCKED') preLocked += 1;
      else failed += 1;
      offers[offerKey] = {
        key: offerKey,
        bossLabel: offer.bossLabel,
        name: offer.name,
        url: offer.url,
        campaign: primary?.campaignId || '',
        ids,
        metaSource: source,
        status: allVerified
          ? 'CLAIMED'
          : anyClaimed
            ? 'PARTIAL'
            : anyWrongReward
              ? 'WRONG_REWARD'
              : (anyPreLocked ? 'PRE_LOCKED' : 'FAILED'),
        state: primary?.state || 'UNKNOWN',
        preLocked: anyPreLocked,
        wrongReward: anyWrongReward,
        verified: Boolean(primary?.verified),
        valueMatched: Boolean(primary?.valueMatched),
        savedValue: Number(primary?.savedValue || primary?.value || 0),
        alreadyActive: primary?.state === 'ALREADY_ACTIVE' || primary?.state === 'ALREADY_VERIFIED',
        writes: results.reduce((n, r) => n + Number(r.writes || 0), 0),
        campaignUrl: offer.url,
        discount: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
        message: primary?.reason || '',
        results
      };
        };
    if (parallelOffers) await Promise.all(offerKeys.map(processOffer));
    else for (const offerKey of offerKeys) { if (remaining() <= 0) break; await processOffer(offerKey); }

    const total = Object.keys(offers).length;
    return {
      ok: failed === 0,
      at: new Date(nowMs).toISOString(),
      source: 'EVENT_OFFERS_ENGINE',
      offerValue,
      label: (EVENT_OFFER_OPTIONS[offerValue] || EVENT_OFFER_OPTIONS[1]).shortLabel,
      links: EVENT_OFFER_LINKS,
      offers,
      summary: { total, claimed, alreadyActive: already, preLocked, failed },
      // "all active" ka matlab sach me laga — pre-lock (window band) active nahi.
      allActive: total > 0 && failed === 0 && preLocked === 0,
      // Purane callers (import card / doctor) `offers.breakfast` & `offers.lateNight`
      // padhte hain — woh shape isi me maujood hai.
      breakfast: offers.breakfast || null,
      lateNight: offers.lateNight || null,
      extra50: offers.extra50 || null,
      weekend: offers.weekend || null,
      karwaChauth: offers.karwaChauth || null
    };
  })();

  accountRuns.set(runKey, run);
  try {
    return await run;
  } finally {
    if (accountRuns.get(runKey) === run) accountRuns.delete(runKey);
  }
}

/** UI ke liye saaf Hinglish lines (jo hua wahi dikhta hai). */
export function describeEventOfferActivation(result) {
  if (!result?.offers) return ['Offers: koi jawab nahi mila.'];
  const lines = [];
  for (const offer of EVENT_OFFERS) {
    const rec = result.offers[offer.key];
    if (!rec) continue;
    const tag = rec.status === 'CLAIMED'
      ? (rec.alreadyActive ? '✓ pehle se active' : '✓ activate')
      : (rec.status === 'PARTIAL' ? '◐ aadha' : '✕ nahi hua');
    lines.push(`${offer.bossLabel}: ${tag}${rec.campaign ? ` · ${rec.campaign}` : ''}${rec.message ? ` — ${rec.message}` : ''}`);
  }
  return lines;
}

/** Kitne offers sach me active hain (UI/counter ke liye). */
export function countActiveEventOffers(result) {
  if (!result?.offers) return 0;
  return Object.values(result.offers).filter((o) => o && (o.status === 'CLAIMED' || o.verified)).length;
}
