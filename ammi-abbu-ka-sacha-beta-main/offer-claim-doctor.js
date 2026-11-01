/**
 * offer-claim-doctor.js — "dusre ID par night offer lag raha hai, mere ID par nahi"
 *
 * Pehle kya hota tha: claim code `POST/PATCH` ka HTTP 200 dekh kar maan leta tha
 * ki offer lag gaya, aur UI "₹50 ✓" dikha deta tha. Swiggy asal me kuch aur
 * (ya kuch bhi) save karta ho to bot ko pata hi nahi chalta tha — aur agar
 * write fail hoti to UI bas "₹50 ✕" dikha kar chup ho jata tha (koi reason nahi).
 *
 * Ab har claim ke baad **read-back verification** hoti hai, aur ek separate
 * "Offer Doctor" har campaign ki ASLI server state dikhata hai:
 *   GET /api/notify?campaign=<id>  ->  { shouldNotify, value, timestamp }
 *
 * Doctor 3 din (kal / aaj / parso) × 2 track (breakfast + late-night) probe
 * karta hai, isliye cross-midnight late-night offer bhi pakda jata hai, aur
 * exact reason batata hai: WAF 403, session dead, value drift (₹150 coupon ke
 * bajaye ₹50 free cash nahi), cutoff miss, ya slot band.
 */
import { getDb, saveDb } from './store.js';
import { EVENT_OFFER_LINKS, EVENT_OFFERS, extractCampaignInfoFromHtml, cachedFixedCampaignId, activateAllEventOffers } from './event-offers.js';

export const OFFER_CAMPAIGN_URLS = {
  breakfast: 'https://events.swiggy.com/book-your-offer?utm_source=app&utm_medium=share',
  lateNight: 'https://events.swiggy.com/pick-your-late-night-offer?utm_source=app&utm_medium=share',
  // 26-10-2026: do naye links — Extra ₹50 + Weekend (har JSON import par activate).
  extra50: EVENT_OFFER_LINKS.extra50,
  weekend: EVENT_OFFER_LINKS.weekend,
  // 29-10-2026: Karwa Chauth (Pick ₹50 cash).
  karwaChauth: EVENT_OFFER_LINKS.karwaChauth
};

export const OFFER_OPTIONS = {
  1: { value: 1, shortLabel: '₹50 Free Cash (>₹199)' },
  2: { value: 2, shortLabel: '₹150 OFF Coupon (>₹249)' },
  3: { value: 3, shortLabel: '₹175 LN / ₹100 BF Coupon' },
  4: { value: 4, shortLabel: '₹100 OFF Coupon (>₹149)' }
};

export const PREFERRED_OFFER_VALUE = 1;
const EVENTS_API = 'https://events.swiggy.com/api/notify';

/** Doctor chaaron offers dekhta hai (boss: "SAARE OFFER"). */
export const OFFER_TRACK_KEYS = ['lateNight', 'breakfast', 'extra50', 'weekend', 'karwaChauth'];

// Same live-page defaults as swiggy-bridge.js (test asserts they stay in sync).
const DEFAULT_META = {
  bfPrefix: 'byo-bf-v10-', lnPrefix: 'byo-ln-v5-',
  bfBoundaries: [], lnBoundaries: [],
  // Fixed (day-number ke bina) campaigns: Extra ₹50 + Weekend.
  x50Campaign: '', wkndCampaign: '', kcCampaign: '', x50Source: 'NONE', wkndSource: 'NONE', kcSource: 'NONE'
};

function decodeJwtExp(jwt) {
  try {
    const part = String(jwt || '').split('.')[1];
    if (!part) return 0;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(json?.exp || 0);
  } catch {
    return 0;
  }
}

/** Track config: LN redeem 21:00–06:00 (next-day), BF redeem 07:00–11:00. */
const TRACKS = {
  breakfast: { key: 'breakfast', label: 'Breakfast', isLateNight: false, cutoffH: 18, slotOpenH: 20, slotCloseH: 24 },
  lateNight: { key: 'lateNight', label: 'Late Night', isLateNight: true, cutoffH: 7.5, slotOpenH: 10, slotCloseH: 19 },
  // Fixed campaigns: koi day number / slot nahi — page ki di hui campaign id.
  extra50: { key: 'extra50', label: 'Extra ₹50', fixed: true, metaField: 'x50Campaign', sourceField: 'x50Source' },
  weekend: { key: 'weekend', label: 'Weekend', fixed: true, metaField: 'wkndCampaign', sourceField: 'wkndSource' },
  // 29-10-2026 Karwa Chauth — "Pick ₹50 cash" (29 Oct 3PM – 30 Oct 6AM).
  karwaChauth: { key: 'karwaChauth', label: 'Karwa Chauth', fixed: true, metaField: 'kcCampaign', sourceField: 'kcSource' }
};

/**
 * Live campaign metadata (prefixes + day boundaries) from the public offer pages.
 * Cached 15 min; on failure the deterministic defaults are used and `metaSource`
 * says so honestly.
 */
let _metaCache = null;
let _metaAt = 0;
export async function loadOfferCampaignMeta({ force = false, fetchImpl = globalThis.fetch } = {}) {
  if (!force && _metaCache && Date.now() - _metaAt < 15 * 60 * 1000) return _metaCache;
  const parsePage = (html, defPrefix) => {
    const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return { prefix: defPrefix, boundaries: [] };
    try {
      const parsed = JSON.parse(m[1]);
      const nexus = parsed?.props?.pageProps?.nexusData || {};
      return {
        prefix: nexus.notifyCampaignIdPrefix || defPrefix,
        boundaries: Array.isArray(nexus.dayBoundaries) ? nexus.dayBoundaries : []
      };
    } catch {
      return { prefix: defPrefix, boundaries: [] };
    }
  };
  try {
    const [bfRes, lnRes] = await Promise.all([
      fetchImpl(OFFER_CAMPAIGN_URLS.breakfast, { signal: AbortSignal.timeout(6000) }),
      fetchImpl(OFFER_CAMPAIGN_URLS.lateNight, { signal: AbortSignal.timeout(6000) })
    ]);
    const [bfHtml, lnHtml] = await Promise.all([bfRes.text(), lnRes.text()]);
    const bf = parsePage(bfHtml, DEFAULT_META.bfPrefix);
    const ln = parsePage(lnHtml, DEFAULT_META.lnPrefix);
    // Extra ₹50 + Weekend bhi page se (unka day number nahi hota).
    const fixedMeta = async (offerKey) => {
      const offer = EVENT_OFFERS.find((o) => o.key === offerKey);
      if (!offer) return { campaign: '', source: 'NONE' };
      // In pages par campaign id HTML me hoti hi nahi. Claim engine ne jab
      // live write + read-back se id resolve ki ho, wahi sabse sach hai.
      const cached = cachedFixedCampaignId(offerKey);
      try {
        const res = await fetchImpl(offer.url, { signal: AbortSignal.timeout(6000) });
        const html = await res.text();
        const info = extractCampaignInfoFromHtml(html, offer);
        const campaign = info.fixedCampaignId || info.prefix || cached?.id || '';
        return {
          campaign,
          source: info.fixedCampaignId || info.prefix ? (info.source || 'NONE') : (cached?.source || (campaign ? 'CACHED_RESOLVED' : 'NONE'))
        };
      } catch (err) {
        if (cached?.id) return { campaign: cached.id, source: cached.source || 'CACHED_RESOLVED' };
        return { campaign: '', source: 'PAGE_FAILED', error: String(err?.message || err).slice(0, 80) };
      }
    };
    const [x50, wknd, kc] = await Promise.all([fixedMeta('extra50'), fixedMeta('weekend'), fixedMeta('karwaChauth')]);
    _metaCache = {
      ...DEFAULT_META,
      bfPrefix: bf.prefix,
      lnPrefix: ln.prefix,
      bfBoundaries: bf.boundaries,
      lnBoundaries: ln.boundaries,
      x50Campaign: x50.campaign,
      wkndCampaign: wknd.campaign,
      x50Source: x50.source,
      wkndSource: wknd.source,
      kcCampaign: kc.campaign,
      kcSource: kc.source,
      metaSource: 'LIVE_PAGE',
      loadedAt: new Date().toISOString()
    };
  } catch (err) {
    _metaCache = {
      ...(_metaCache || DEFAULT_META),
      metaSource: 'DEFAULT',
      metaError: String(err?.message || err).slice(0, 120),
      loadedAt: new Date().toISOString()
    };
  }
  _metaAt = Date.now();
  return _metaCache;
}

function windowFor(boundary, track) {
  const startMs = Date.parse(boundary?.startTime);
  if (!Number.isFinite(startMs)) return null;
  const H = 3600 * 1000;
  return {
    day: Number(boundary?.day || 0),
    startMs,
    endMs: Date.parse(boundary?.endTime) || startMs + 24 * H,
    cutoffMs: startMs + track.cutoffH * H,
    slotOpenMs: startMs + track.slotOpenH * H,
    slotCloseMs: startMs + track.slotCloseH * H
  };
}

/**
 * Which campaigns matter RIGHT NOW for a track, in priority order:
 *   1. the campaign whose redeem slot is open now (late night can cross midnight),
 *   2. the campaign of the current Swiggy day,
 *   3. tomorrow.
 * Returns honest windows with slot state.
 */
export function resolveTrackCampaigns(meta, trackKey, nowMs = Date.now()) {
  const track = TRACKS[trackKey];
  if (!track) return { key: trackKey, label: trackKey, primary: null, rows: [], inferred: false };
  // Fixed campaign (Extra ₹50 / Weekend): day number nahi, page ki id hi asli hai.
  if (track.fixed) {
    const campaign = String(meta?.[track.metaField] || '');
    const source = String(meta?.[track.sourceField] || 'NONE');
    if (!campaign) {
      return {
        key: trackKey,
        label: track.label,
        prefix: '',
        metaSource: meta?.metaSource || 'DEFAULT',
        boundariesCount: 0,
        inferred: false,
        fixed: true,
        primary: null,
        rows: [],
        // Kya-kya try hua — boss ko saaf dikhe (jhooth nahi).
        tried: (cachedFixedCampaignId(trackKey)?.tried || []).slice(0, 5).map((t) => t.id || '').filter(Boolean),
        reason: 'campaign id page par nahi hoti — claim karte waqt live verify hoti hai (▣ Claim / 🔧 Fix dabaiye)'
      };
    }
    const row = {
      campaign,
      day: null,
      slotLiveNow: true,
      cutoffPassed: false,
      slotOpensInMs: 0,
      inferred: false,
      fixed: true,
      metaSource: source,
      state: 'BOOKABLE_NOW'
    };
    return {
      key: trackKey,
      label: track.label,
      prefix: '',
      metaSource: meta?.metaSource || 'DEFAULT',
      boundariesCount: 0,
      inferred: false,
      fixed: true,
      campaignIdSource: source,
      primary: row,
      rows: [row]
    };
  }
  const boundaries = (trackKey === 'breakfast' ? meta?.bfBoundaries : meta?.lnBoundaries) || [];
  const prefix = trackKey === 'breakfast' ? meta?.bfPrefix : meta?.lnPrefix;
  const wins = boundaries.map((b) => windowFor(b, track)).filter(Boolean);

  const inSlot = wins.find((w) => nowMs >= w.slotOpenMs && nowMs < w.slotCloseMs);
  const currentDay = wins.find((w) => nowMs >= w.startMs && nowMs < w.endMs)
    || wins.find((w) => nowMs < w.endMs)
    || null;
  const ordered = [];
  const push = (w) => { if (w && !ordered.some((o) => o.day === w.day)) ordered.push(w); };
  push(inSlot);
  push(currentDay);
  push(wins.find((w) => currentDay && w.day === currentDay.day + 1) || (currentDay ? null : wins[0]));
  push(wins.find((w) => currentDay && w.day === currentDay.day - 1));

  // Page kabhi block/403 ho jata hai -> dayBoundaries khaali. Tab campaign id
  // ka anumaan IST day-number se lagao (Swiggy `byo-ln-v5-<day>` format hi
  // rakhta hai), par report me `inferred: true` likho — guess ko sach na banao.
  let inferred = false;
  if (ordered.length === 0 && prefix) {
    inferred = true;
    const H = 3600 * 1000;
    const istNow = new Date(nowMs + 5.5 * H);
    // Swiggy ka "day" 11:00 IST par badalta hai, midnight par nahi. 11:00 se
    // pehle (jaise raat 1 baje) to kal wala day-number chalta hai — isi wajah se
    // cross-midnight late-night offer galat campaign par claim ho jata tha.
    const istDayShift = istNow.getUTCHours() < 11 ? -1 : 0;
    const dayNum = istNow.getUTCDate() + istDayShift;
    // 11:00 IST == 05:30 UTC (same date)
    const startOfIstDay = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 5, 30)
      + istDayShift * 24 * H;
    for (const d of [dayNum, dayNum - 1, dayNum + 1]) {
      const startMs = startOfIstDay + (d - dayNum) * 24 * H;
      ordered.push({
        day: d, startMs, endMs: startMs + 24 * H,
        cutoffMs: startMs + track.cutoffH * H,
        slotOpenMs: startMs + track.slotOpenH * H,
        slotCloseMs: startMs + track.slotCloseH * H
      });
    }
  }

  const rows = ordered.map((w) => {
    const slotLiveNow = nowMs >= w.slotOpenMs && nowMs < w.slotCloseMs;
    const cutoffPassed = nowMs > w.cutoffMs;
    const slotOpensIn = Math.max(0, w.slotOpenMs - nowMs);
    return {
      ...w,
      campaign: `${prefix}${w.day}`,
      slotLiveNow,
      cutoffPassed,
      slotOpensInMs: slotOpensIn,
      inferred,
      state: slotLiveNow ? 'SLOT_LIVE_NOW' : (cutoffPassed ? 'CUTOFF_PASSED' : 'BOOKABLE_NOW')
    };
  });

  return {
    key: trackKey,
    label: track.label,
    prefix,
    metaSource: meta?.metaSource || 'DEFAULT',
    boundariesCount: boundaries.length,
    inferred,
    primary: rows[0] || null,
    rows
  };
}

/** Resolve the { token, tid } pair the events API authenticates with. */
export async function resolveEventsAuth(account, { fetchImpl = globalThis.fetch } = {}) {
  const acc = account || {};
  let token = String(acc.token || '');
  let tid = String(acc.jwtTid || acc.tid || '');
  const cookieStr = String(acc.cookies || '');
  if (!token || !tid) {
    for (const part of cookieStr.split(';').map((s) => s.trim())) {
      if (!token && part.startsWith('token=')) token = part.slice(6);
      if (!tid && part.startsWith('tid=') && part.slice(4).includes('.')) tid = part.slice(4);
      if (!tid && part.startsWith('_session_tid=') && part.slice(13).includes('.')) tid = part.slice(13);
    }
  }
  // tid is a 30-day JWT that `chkout` re-mints; an expired one gets a 401 on events.
  const nowSec = Math.floor(Date.now() / 1000);
  let refreshed = false;
  if ((!tid || decodeJwtExp(tid) < nowSec + 120) && (token || tid)) {
    try {
      const res = await fetchImpl('https://chkout.swiggy.com/api/v2/cart/client', {
        headers: {
          'User-Agent': 'Swiggy-Android',
          'app-version': '4.67.0',
          'version-code': '1365',
          'os-version': '13',
          Accept: 'application/json',
          ...(tid ? { tid } : {}),
          ...(token ? { token } : {}),
          ...(acc.sid ? { sid: acc.sid } : {}),
          ...(acc.deviceId ? { deviceId: acc.deviceId, swuid: acc.deviceId } : {})
        },
        signal: AbortSignal.timeout(5000)
      });
      const json = await res.json().catch(() => null);
      if (json?.statusCode === 0 && json?.tid && String(json.tid).includes('.')) {
        tid = String(json.tid);
        refreshed = true;
      }
    } catch {}
  }
  return { token: token || tid, tid, refreshed, hasToken: Boolean(token), hasTid: Boolean(tid) };
}

/** Header sets tried in order. Cookie-auth is the fallback for web-only sessions. */
function authHeaderVariants(creds, account) {
  const base = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://events.swiggy.com',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  };
  const variants = [];
  if (creds?.token || creds?.tid) {
    variants.push({
      id: 'token+tid',
      headers: { ...base, token: creds.token || creds.tid, tid: creds.tid || creds.token }
    });
  }
  const cookie = String(account?.cookies || '');
  if (cookie) {
    variants.push({
      id: 'cookie',
      headers: { ...base, Cookie: cookie, ...(creds?.tid ? { tid: creds.tid } : {}) }
    });
  }
  return variants;
}

/** One live GET — the only source of truth about a campaign. */
export async function probeCampaign(account, campaignId, { creds = null, fetchImpl = globalThis.fetch, referer = '' } = {}) {
  const auth = creds || await resolveEventsAuth(account, { fetchImpl });
  const variants = authHeaderVariants(auth, account);
  const tried = [];
  for (const variant of variants) {
    try {
      const res = await fetchImpl(`${EVENTS_API}?campaign=${encodeURIComponent(campaignId)}`, {
        headers: variant.headers,
        ...(referer ? { referer } : {}),
        signal: AbortSignal.timeout(6000)
      });
      const json = await res.json().catch(() => ({}));
      tried.push({ transport: variant.id, status: res.status });
      if (res.ok) {
        return {
          ok: true,
          transport: variant.id,
          httpStatus: res.status,
          shouldNotify: Boolean(json?.shouldNotify),
          value: Number(json?.value || 0),
          timestamp: json?.timestamp || '',
          raw: json
        };
      }
      // 401/403 can be a transport problem (web-only session) -> try next variant.
      if (![401, 403].includes(res.status)) {
        return { ok: false, transport: variant.id, httpStatus: res.status, shouldNotify: false, value: 0, timestamp: '', raw: json, tried };
      }
    } catch (err) {
      tried.push({ transport: variant.id, status: 0, error: String(err?.message || err).slice(0, 80) });
    }
  }
  const last = tried[tried.length - 1] || {};
  return {
    ok: false,
    transport: last.transport || 'none',
    httpStatus: Number(last.status || 0),
    shouldNotify: false,
    value: 0,
    timestamp: '',
    raw: {},
    tried
  };
}

function readCartFreeCashFor(account) {
  const keys = ['freeCashBalance', 'freeCashEstimate', 'walletBalance', 'swiggyMoney'];
  for (const k of keys) {
    const n = Number(account?.[k]);
    if (Number.isFinite(n) && n > 0) return { amount: n, source: k };
  }
  const offers = account?.offers;
  const both = Boolean(offers?.breakfast?.status === 'CLAIMED' && offers?.lateNight?.status === 'CLAIMED');
  return { amount: 0, source: both ? 'claims-marked-but-cash-unknown' : 'unknown' };
}

/**
 * Full honesty report for ONE account: what Swiggy actually has on the server
 * for both tracks (and neighbours), why it is not applying, and what to do.
 */
export async function diagnoseAccountOffers(account, {
  key = '', nowMs = Date.now(), fetchImpl = globalThis.fetch, meta = null
} = {}) {
  const acc = account || {};
  if (!acc || (!acc.cookies && !acc.token && !acc.tid && !acc.jwtTid)) {
    return {
      ok: false,
      code: 'NO_SESSION',
      account: acc,
      key,
      verdict: ['Is account ka koi session nahi hai — pehle login/JSON import karein.'],
      rows: []
    };
  }
  const resolvedMeta = meta || await loadOfferCampaignMeta({ fetchImpl });
  const creds = await resolveEventsAuth(acc, { fetchImpl });
  const tracks = {};
  const rows = [];
  const verdict = [];

  for (const trackKey of OFFER_TRACK_KEYS) {
    const track = resolveTrackCampaigns(resolvedMeta, trackKey, nowMs);
    const probes = [];
    for (const w of track.rows) {
      const probe = await probeCampaign(acc, w.campaign, {
        creds,
        fetchImpl,
        referer: OFFER_CAMPAIGN_URLS[trackKey] || ''
      });
      const row = { track: trackKey, campaign: w.campaign, day: w.day, window: w, probe };
      probes.push(row);
      rows.push(row);
    }
    const primaryRow = probes[0] || null;
    const liveRow = probes.find((r) => r.window.slotLiveNow) || null;
    const bookedPrimary = Boolean(primaryRow?.probe?.ok && primaryRow.probe.shouldNotify);
    const valuePrimary = Number(primaryRow?.probe?.value || 0);
    const valueLive = Number(liveRow?.probe?.value || 0);
    let state = 'UNKNOWN';
    let reason = '';
    if (!primaryRow) {
      state = 'NO_META';
      reason = 'Campaign list nahi mili (Swiggy offer page nahi khula) — thodi der baad retry.';
    } else if (primaryRow.probe.httpStatus === 401) {
      state = 'AUTH_FAILED';
      reason = 'Session se events.swiggy.com ne mana kar diya (401) — ID re-login karein.';
    } else if ([403, 429].includes(primaryRow.probe.httpStatus)) {
      state = 'RATE_LIMITED';
      reason = `Swiggy ne throttle kiya (HTTP ${primaryRow.probe.httpStatus}) — 10 min ruk kar dobara try karein.`;
    } else if (!primaryRow.probe.ok) {
      state = 'PROBE_FAILED';
      reason = `events.swiggy.com ne jawab nahi diya (HTTP ${primaryRow.probe.httpStatus || 'network'}).`;
    } else if (!bookedPrimary) {
      state = 'NOT_BOOKED';
      reason = `Aaj ka campaign ${primaryRow.campaign} book hi nahi hua — "Fix" dabaiye, abhi book ho jayega.`;
    } else if (valuePrimary !== PREFERRED_OFFER_VALUE) {
      state = 'WRONG_REWARD';
      reason = `${primaryRow.campaign} me reward option ${valuePrimary} (${OFFER_OPTIONS[valuePrimary]?.shortLabel || 'unknown'}) save hai, ₹50 free cash nahi — "Fix" se option 1 ho jayega.`;
    } else if (track.fixed) {
      state = valuePrimary === PREFERRED_OFFER_VALUE ? 'LIVE_NOW' : 'BOOKED';
      reason = `${primaryRow.campaign} par ₹50 free cash (option ${valuePrimary}) ${valuePrimary === PREFERRED_OFFER_VALUE ? 'active hai' : 'save hai — option 1 par set karein'}.`;
    } else if (liveRow && valueLive === PREFERRED_OFFER_VALUE && liveRow.window.slotLiveNow) {
      state = 'LIVE_NOW';
      reason = `Slot abhi khula hai (${liveRow.campaign}) aur ₹50 free cash booked hai — cart me ₹199+ par turant lagna chahiye.`;
    } else {
      state = 'BOOKED';
      reason = `${primaryRow.campaign} me ₹50 free cash booked hai — cash ${trackKey === 'lateNight' ? 'raat 9 baje' : 'subah 7 baje'} se cart me lagega.`;
    }
    tracks[trackKey] = {
      ...track,
      // `rows` = live probes (campaign + window + server state), not just windows.
      rows: probes,
      primary: primaryRow,
      live: liveRow,
      booked: bookedPrimary,
      value: valuePrimary,
      state,
      reason
    };
    verdict.push(`${track.label}: ${state} — ${reason}`);
  }

  for (const k of ['extra50', 'weekend']) {
    const t = tracks[k];
    if (t && t.rows.length === 0) {
      verdict.push(`${t.label}: campaign id nahi mila — "${OFFER_CAMPAIGN_URLS[k]}" ek baar khol kar claim karein, phir Doctor dobara chalayein.`);
    }
  }
  if (tracks.lateNight?.inferred || tracks.breakfast?.inferred) {
    verdict.push('Note: offer page se campaign list nahi mili — campaign id day-number se anumaan hai (probe fir bhi asli hai).');
  }
  const cash = readCartFreeCashFor(acc);
  if (tracks.lateNight.state === 'WRONG_REWARD') {
    verdict.push('Note: ₹150/₹175 wale coupon cash nahi hote — wahi is ID par "offer nahi lag raha" jaisa dikhta hai.');
  }
  if (cash.amount === 0 && tracks.lateNight.booked) {
    verdict.push('Swiggy Money/free cash 0 dikha raha hai — cash cart me add hone par (₹199+ cart) hi dikhta hai, wallet me nahi.');
  }

  return {
    ok: true,
    key,
    at: new Date().toISOString(),
    account: acc,
    metaSource: resolvedMeta.metaSource,
    auth: { hasToken: creds.hasToken, hasTid: creds.hasTid, refreshed: creds.refreshed },
    tracks,
    rows,
    cash,
    verdict
  };
}

async function writeCampaign(account, campaignId, value, { method, creds, fetchImpl, referer }) {
  const auth = creds || await resolveEventsAuth(account, { fetchImpl });
  const variants = authHeaderVariants(auth, account);
  const tried = [];
  for (const variant of variants) {
    try {
      const res = await fetchImpl(EVENTS_API, {
        method,
        headers: { ...variant.headers, ...(referer ? { Referer: referer } : {}) },
        body: JSON.stringify({ campaign: campaignId, value }),
        signal: AbortSignal.timeout(7000)
      });
      const json = await res.json().catch(() => ({}));
      tried.push({ transport: variant.id, status: res.status });
      if (res.ok) return { ok: true, transport: variant.id, httpStatus: res.status, json, tried };
      if (![401, 403].includes(res.status)) return { ok: false, transport: variant.id, httpStatus: res.status, json, tried };
    } catch (err) {
      tried.push({ transport: variant.id, status: 0, error: String(err?.message || err).slice(0, 80) });
    }
  }
  const last = tried[tried.length - 1] || {};
  return { ok: false, transport: last.transport || 'none', httpStatus: Number(last.status || 0), json: {}, tried };
}

/**
 * FIX + READ-BACK: har zaroori campaign par option 1 (₹50 free cash) likho,
 * phir GET se verify karo. "Likh diya" kabhi success nahi kaha jata — sirf
 * read-back `shouldNotify:true && value:1` ko success mana jata hai.
 */
export async function fixAccountOffers(account, {
  key = '', nowMs = Date.now(), fetchImpl = globalThis.fetch, value = PREFERRED_OFFER_VALUE, meta = null
} = {}) {
  const acc = account || {};
  const resolvedMeta = meta || await loadOfferCampaignMeta({ fetchImpl });
  const creds = await resolveEventsAuth(acc, { fetchImpl });
  const before = await diagnoseAccountOffers(acc, { key, nowMs, fetchImpl, meta: resolvedMeta });
  const changes = [];

  for (const trackKey of OFFER_TRACK_KEYS) {
    const track = before.tracks?.[trackKey];
    if (!track) continue;
    const referer = OFFER_CAMPAIGN_URLS[trackKey] || '';
    const trackDef = TRACKS[trackKey] || {};
    // Extra ₹50 / Weekend: page par campaign id nahi milti, isliye engine ki
    // self-verifying ladder chalai jati hai (likho → read-back → tabhi ✓).
    if (trackDef.fixed && !(track.rows || []).length) {
      let slot = null;
      try {
        const out = await activateAllEventOffers(acc, { offerKeys: [trackKey], force: true, fetchImpl });
        slot = out?.offers?.[trackKey] || null;
      } catch (err) {
        slot = { campaign: '', verified: false, message: String(err?.message || err).slice(0, 120) };
      }
      if (slot?.campaign) {
        resolvedMeta[trackDef.metaField] = slot.campaign;
        resolvedMeta[trackDef.sourceField] = slot.metaSource || 'CANDIDATE_VERIFIED';
      }
      changes.push({
        track: trackKey,
        campaign: slot?.campaign || '',
        action: 'ladder',
        wrote: Number(slot?.writes || 0) > 0,
        writeStatus: 200,
        verified: Boolean(slot?.verified),
        value: Number(value),
        shouldNotify: Boolean(slot?.verified),
        reason: slot?.verified ? '' : (slot?.message || 'campaign id live verify nahi hui')
      });
      continue;
    }
    for (const row of (track.rows || []).slice(0, 2)) {
      const campaign = row.campaign;
      const probe = row.probe || {};
      const alreadyGood = probe.ok && probe.shouldNotify && Number(probe.value) === Number(value);
      if (alreadyGood) {
        changes.push({ track: trackKey, campaign, action: 'none', verified: true, value: Number(probe.value) });
        continue;
      }
      const method = probe.ok && probe.shouldNotify ? 'PATCH' : 'POST';
      const write = await writeCampaign(acc, campaign, Number(value), { method, creds, fetchImpl, referer });
      // Never trust the write answer — ask the server what it really stored.
      const readBack = await probeCampaign(acc, campaign, { creds, fetchImpl, referer });
      const verified = Boolean(readBack.ok && readBack.shouldNotify && Number(readBack.value) === Number(value));
      changes.push({
        track: trackKey,
        campaign,
        action: method.toLowerCase(),
        wrote: write.ok,
        writeStatus: write.httpStatus,
        verified,
        value: Number(readBack.value || 0),
        shouldNotify: Boolean(readBack.shouldNotify),
        reason: verified
          ? ''
          : (readBack.httpStatus === 403 || readBack.httpStatus === 429
            ? `Swiggy ne throttle kiya (HTTP ${readBack.httpStatus}) — 10 min baad dobara.`
            : (readBack.ok ? `Server par value ${readBack.value || 0} / shouldNotify ${readBack.shouldNotify} — Swiggy ne badla nahi.` : 'Read-back fail (network/WAF).'))
      });
    }
  }

  const after = await diagnoseAccountOffers(acc, { key, nowMs, fetchImpl, meta: resolvedMeta });
  const verifiedAny = changes.some((c) => c.verified);
  return {
    ok: true,
    key,
    at: new Date().toISOString(),
    verifiedAny,
    changes,
    before,
    after,
    verdict: [
      ...changes.map((c) => `${c.campaign}: ${c.action} → ${c.verified ? '✓ verified ₹50 free cash' : `✕ ${c.reason}`}`),
      ...(after.verdict || [])
    ]
  };
}

/** Telegram-ready report (Hinglish, honest, with the raw numbers). */
export function formatOfferDoctorReport(report, { accountLabel = '', escapeHtml = (s) => String(s) } = {}) {
  const esc = escapeHtml;
  if (!report?.ok) {
    return `🎁 <b>OFFER DOCTOR</b>\n\n${esc(accountLabel)}\n\n` +
      (report?.verdict || ['Account ka session nahi mila — pehle login/JSON import karein.']).map((v) => `• ${esc(v)}`).join('\n');
  }
  const lines = [`🎁 <b>OFFER DOCTOR — ${esc(accountLabel || report.key || 'Account')}</b>`, ''];
  lines.push(`◈ Campaign source: <b>${esc(report.metaSource)}</b> · auth: ${report.auth?.hasToken ? 'token ✓' : 'token ✕'} / ${report.auth?.hasTid ? 'tid ✓' : 'tid ✕'}`);
  lines.push('');
  for (const key of OFFER_TRACK_KEYS) {
    const t = report.tracks?.[key];
    if (!t) continue;
    const icon = t.state === 'LIVE_NOW' || t.state === 'BOOKED' ? '🟢' : (t.state === 'WRONG_REWARD' ? '🟡' : '🔴');
    lines.push(`${icon} <b>${esc(t.label)}</b> — <b>${esc(t.state)}</b>`);
    lines.push(`   ${esc(t.reason)}`);
    if (Array.isArray(t.tried) && t.tried.length) {
      lines.push(`   <i>try kiye: ${t.tried.map((x) => esc(x)).join(', ')}</i>`);
    }
    for (const row of (t.rows || []).slice(0, 3)) {
      const p = row.probe || {};
      lines.push(
        `   • <code>${esc(row.campaign)}</code>${row.window?.slotLiveNow ? ' <b>(slot LIVE)</b>' : ''} — ` +
        (p.ok ? `saved=${p.value ? esc(OFFER_OPTIONS[p.value]?.shortLabel || `option ${p.value}`) : 'none'}` : `HTTP ${esc(p.httpStatus || 'net')} fail`)
      );
    }
    lines.push('');
  }
  lines.push(`₹ <b>Free cash/cash read:</b> ${report.cash?.amount ? `₹${report.cash.amount}` : '0 (cart me ₹199+ par hi dikhta hai)'}`);
  if (Array.isArray(report.verdict) && report.verdict.length) {
    lines.push('', '<b>Verdict:</b>');
    report.verdict.slice(0, 6).forEach((v) => lines.push(`• ${esc(v)}`));
  }
  return lines.join('\n');
}

function saveAccountOfferTruth(key, payload) {
  const k = String(key || '');
  if (!k) return;
  try {
    const db = getDb();
    const acc = db?.config?.accounts?.[k];
    if (!acc) return;
    acc.offerDoctor = payload;
    acc.offerDoctorAt = new Date().toISOString();
    saveDb(db);
  } catch {}
}

export async function runOfferDoctorForAccount(key, opts = {}) {
  const db = getDb();
  const acc = db?.config?.accounts?.[key];
  if (!acc) return { ok: false, code: 'ACCOUNT_NOT_FOUND', verdict: ['Ye ID vault me nahi mili.'] };
  const report = opts.fix
    ? await fixAccountOffers(acc, { key, ...opts })
    : await diagnoseAccountOffers(acc, { key, ...opts });
  saveAccountOfferTruth(key, {
    at: new Date().toISOString(),
    breakfast: report.tracks?.breakfast?.state || report.before?.tracks?.breakfast?.state || '',
    lateNight: report.tracks?.lateNight?.state || report.before?.tracks?.lateNight?.state || '',
    extra50: report.tracks?.extra50?.state || report.before?.tracks?.extra50?.state || '',
    weekend: report.tracks?.weekend?.state || report.before?.tracks?.weekend?.state || '',
    karwaChauth: report.tracks?.karwaChauth?.state || report.before?.tracks?.karwaChauth?.state || '',
    verdict: (report.verdict || []).slice(0, 4),
    fixed: Boolean(opts.fix)
  });
  return report;
}
