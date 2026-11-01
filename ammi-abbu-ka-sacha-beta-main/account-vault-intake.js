import crypto from 'crypto';
import {
  getDb,
  saveDb,
  importSessionJson,
  normalizeSwiggySessionPayload,
  extractSwiggyAccountsListFromInput,
  syncCloudVaultNow
} from './store.js';
import { extractStandaloneMobileNumber } from './phone-utils.js';
export { extractStandaloneMobileNumber, normalizeIndianMobileNumber } from './phone-utils.js';
import {
  verifySwiggySessionLive,
  inspectAccountOrderHistoryAndOffers,
  accountTidExpiryMs
} from './swiggy-cart.js';
import {
  claimSwiggyBreakfastAndLateNightOffers,
  autoActivateEventOffers,
  decodeJwtPayload
} from './swiggy-bridge.js';
import {
  buildPortableSessionJson,
  stripUntrustedOrderClaims,
  detectedFileOrderClaims,
  OFFER_TRACKS
} from './account-views.js';
import { extractSessionFilesFromZipBuffer } from './vault-sync.js';
import { section, sub, table } from './rich-text.js';

/**
 * Validate a new display name and produce a short, collision-safe account key.
 */
export function prepareNewSwiggyAccountIdentity(rawName, accounts = {}) {
  const name = typeof rawName === 'string'
    ? rawName.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  const length = [...name].length;
  if (length < 2 || length > 40 || !/[\p{L}\p{N}]/u.test(name) || /^\p{N}+$/u.test(name)) {
    return { success: false, error: 'Use a name with 2–40 characters and at least one letter (for example, Bhai or Office).' };
  }

  const normalizedName = name.toLocaleLowerCase('en-IN');
  const duplicateName = Object.entries(accounts || {}).find(([, account]) =>
    String(account?.name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN') === normalizedName
  );
  if (duplicateName) {
    return { success: false, error: `That account name is already in use (${duplicateName[1]?.name || duplicateName[0]}). Choose a distinct label or use the existing account.` };
  }

  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 24)
    .replace(/_+$/g, '');
  const hash = crypto.createHash('sha256').update(normalizedName).digest('hex').slice(0, 10);
  const key = slug || `account_${hash}`;

  if (Object.prototype.hasOwnProperty.call(accounts || {}, key)) {
    return { success: false, error: `The generated account key “${key}” is already in use. Add a distinguishing word to the name.` };
  }
  return { success: true, name, key };
}

/**
 * Extracts a strict 4–6 digit OTP code ONLY when the message is purely an OTP number
 * (never when the user sends a Swiggy Cart URL, Address, JSON, or general sentence!).
 */
export function extractStandaloneOtpDigits(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (/https?:\/\/|swig\.gy|swiggy|goo\.gl|maps|[{[\]@]/i.test(trimmed)) return null;
  const direct = trimmed.match(/^(?:otp[\s:-]*)?(\d{4,6})$/i);
  return direct ? direct[1] : null;
}

/**
 * Checks whether a normalized Swiggy session payload carries an authenticated non-guest identity
 * (so transient network hiccups during 50-file bulk uploads NEVER discard valid `.json` files!).
 */
function hasAuthenticatedTokenIdentity(norm) {
  if (!norm) return false;
  const jwt = decodeJwtPayload(norm.tid || '');
  if (jwt) {
    const uid = String(jwt.user_id ?? jwt.userId ?? jwt.sub ?? '').trim();
    if (uid === '0' || uid === '-1') return false;
    if (uid && /^\d+$/.test(uid)) return true;
  }
  if (norm.token && String(norm.token).length >= 16) return true;
  if (norm.customerId && /^\d{4,}$/.test(String(norm.customerId))) return true;
  if (norm.cookies && /_is_logged_in=1/.test(norm.cookies) && /_session_tid=/.test(norm.cookies)) return true;
  return false;
}

async function runWithConcurrencyLimit(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await workerFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Core Bulk `.json` / `.txt` / multi-JSON Vault Importer & Permanent Cloud Saver:
 * - Accepts ANY array of `{ fileName, text }` items (1 file, 50 `.json` files sent together, `.zip` archive entries, or pasted JSON).
 * - Deduplicates by phone / customerId / token while keeping the newest credentials.
 * - Verifies live session & `0-Order` (`isZeroOrderAccount`) status with bounded concurrency (`8`),
 *   preserving authenticated sessions even if Swiggy rate-limits a single probe!
 * - Saves ALL valid accounts atomically into `db.config.accounts`, `db.sessionVault`, `accounts.json`, AND GitHub Cloud Vault (`bot-vault`)!
 */
export async function ingestAndPersistRawAccountTexts(
  rawEntries,
  options = {}
) {
  if (rawEntries && !Array.isArray(rawEntries) && typeof rawEntries === 'object') {
    if (rawEntries.rawEntries || rawEntries.rawTexts) {
      options = { ...rawEntries, ...options };
      rawEntries = rawEntries.rawEntries || rawEntries.rawTexts;
    }
  }
  const {
    verifyFn = verifySwiggySessionLive,
    orderProfileFn = inspectAccountOrderHistoryAndOffers,
    claimOffersFn = autoActivateEventOffers,
    syncVaultFn = syncCloudVaultNow,
    concurrency = 8,
    // Every import auto-activates BOTH offer links on EVERY ID (not just fresh
    // ones). Claims are awaited (batches of 2) so the reply can state the real
    // outcome instead of a hopeful "sab claim ho gaya".
    waitForClaims = true,
    claimConcurrency = 2
  } = options;
  const candidatePayloads = [];
  const parseErrors = [];

  for (const item of (Array.isArray(rawEntries) ? rawEntries : [])) {
    const fileName = (typeof item === 'object' && item?.fileName) ? item.fileName : 'session.json';
    const text = String((typeof item === 'object' && item !== null) ? (item.text || '') : item || '').trim();
    if (!text) continue;

    // Derive fallback label/phone hint from filename if present (e.g. `9876543210.json` or `acc_12.json`)
    const filePhoneHint = (fileName.match(/(?:^|\D)([6-9]\d{9})(?:\D|$)/) || [])[1] || '';
    const list = extractSwiggyAccountsListFromInput(text);

    if (list.length === 0) {
      parseErrors.push({ fileName, reason: 'Invalid / Unrecognized JSON format' });
      continue;
    }

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        if (!entry.phone && !entry.mobile && filePhoneHint && list.length === 1) {
          entry.phone = filePhoneHint;
        }
        if (!entry.name && fileName) {
          entry.name = fileName.replace(/\.(json|txt|cookies?)$/i, '');
        }
      }
      const rawNorm = normalizeSwiggySessionPayload(entry);
      // A `.json` file that says "order count 0" is NOT evidence. Drop every
      // count field before anything else looks at it; only the live Swiggy
      // check below may decide 0-Order vs used.
      const fileOrderClaims = detectedFileOrderClaims(entry).concat(detectedFileOrderClaims(rawNorm));
      const norm = rawNorm ? stripUntrustedOrderClaims(rawNorm) : null;
      if (norm && (norm.cookies || norm.tid || norm.token)) {
        candidatePayloads.push({ fileName, rawEntry: entry, norm, fileOrderClaims });
      } else {
        parseErrors.push({ fileName, reason: 'Missing Swiggy cookies / token fields' });
      }
    }
  }

  if (candidatePayloads.length === 0) {
    return {
      savedAccounts: [],
      zeroOrderCount: 0,
      usedAccountCount: 0,
      expiredList: [],
      parseErrors,
      totalVaultActiveCount: Object.values(getDb().config?.accounts || {}).filter(a => a?.isLoggedIn).length
    };
  }

  const verifiedItems = await runWithConcurrencyLimit(candidatePayloads, concurrency, async (cand) => {
    const { fileName, norm } = cand;
    let live = null;
    try {
      live = await verifyFn({
        cookies: norm.cookies,
        tid: norm.tid,
        sid: norm.sid,
        token: norm.token,
        customerId: norm.customerId,
        deviceId: norm.deviceId,
        phone: norm.phone
      });
    } catch (err) {
      live = { valid: false, networkError: true, error: err?.message || 'verify failed' };
    }

    const explicitlyDeadGuest = Boolean(
      live &&
      !live.valid &&
      !live.networkError &&
      !hasAuthenticatedTokenIdentity(norm)
    ) || Boolean(
      live &&
      !live.valid &&
      /guest|logged out|invalid session|session expired|statuscode.*999/i.test(String(live.error || ''))
    );

    if (!live?.valid && (explicitlyDeadGuest || !hasAuthenticatedTokenIdentity(norm))) {
      return {
        accepted: false,
        fileName,
        phone: norm.phone || '',
        name: norm.name || fileName,
        reason: live?.error || 'Session Expired / Logged Out'
      };
    }

    const mergedPayload = {
      ...norm,
      phone: live?.phone || norm.phone || '',
      mobile: live?.phone || norm.phone || '',
      name: live?.name || norm.name || '',
      customerId: live?.customerId || norm.customerId || '',
      tid: live?.liveTid || norm.tid || '',
      sid: live?.liveSid || norm.sid || '',
      token: live?.token || norm.token || '',
      deviceId: norm.deviceId || '',
      cookies: live?.cookies || norm.cookies || '',
      isLoggedIn: true,
      // Always the ₹50-on-₹199 reward (option #1 of the 4 Swiggy shows).
      preferredOfferValue: 1
    };
    const ignoredFileCounts = Array.isArray(cand.fileOrderClaims) ? cand.fileOrderClaims : [];

    // Quick order-history check so Vault immediately knows `0-Order` (`isZeroOrderAccount`) vs `Used`!
    try {
      const targetKey = mergedPayload.phone ? `acc_${mergedPayload.phone}` : (mergedPayload.account || 'acc_temp');
      const prof = await orderProfileFn(targetKey, mergedPayload, { force: true, timeoutMs: 8000 });
      if (prof?.valid === false) {
        mergedPayload.accountError = prof.error || prof.reason || 'Verification issue';
      }
      const orderCount = (typeof prof?.totalOrdersCount === 'number' && prof.totalOrdersCount !== 999999)
        ? prof.totalOrdersCount
        : (typeof prof?.orderCount === 'number' && prof.orderCount !== 999999 ? prof.orderCount : null);
      if (typeof orderCount === 'number' && Number.isFinite(orderCount) && prof?.valid !== false && prof?.ordersVerifiedLive === true) {
        mergedPayload.totalOrdersCount = orderCount;
        mergedPayload.cachedTotalOrdersCount = orderCount;
        mergedPayload.ordersVerifiedLive = true;
        mergedPayload.orderCountSource = 'LIVE';
        mergedPayload.isZeroOrderAccount = (orderCount === 0);
        mergedPayload.liveActiveOrdersCount = Number(prof?.liveActiveOrdersCount || 0);
        mergedPayload.orderTruthCheckedAt = new Date().toISOString();
        delete mergedPayload.orderCountUnverified;
      } else {
        // Live check could not answer -> say so, never fall back to the file.
        mergedPayload.ordersVerifiedLive = false;
        mergedPayload.orderCountSource = 'UNVERIFIED';
        mergedPayload.orderCountUnverified = true;
        delete mergedPayload.totalOrdersCount;
        delete mergedPayload.isZeroOrderAccount;
      }
      if (ignoredFileCounts.length > 0) {
        mergedPayload.ignoredFileOrderClaims = ignoredFileCounts;
      }
    } catch {}

    return { accepted: true, fileName, mergedPayload };
  });

  const acceptedPayloads = [];
  const expiredList = [];
  for (const item of verifiedItems) {
    if (item.accepted) acceptedPayloads.push(item.mergedPayload);
    else expiredList.push(item);
  }

  let savedAccounts = [];
  if (acceptedPayloads.length > 0) {
    // Atomic single-pass import across all accepted accounts (collision-free keys + `accounts.json` + `sessionVault`)!
    const impOut = importSessionJson(acceptedPayloads);
    savedAccounts = (impOut?.accounts || []).map((r) => ({
      key: r.key || r.account,
      account: r.accountObj || getDb().config?.accounts?.[r.key || r.account] || r,
      totalOrdersCount: r.totalOrdersCount,
      isZeroOrderAccount: r.isZeroOrderAccount
    }));

    // `importSessionJson` only persists white-listed fields, so stamp the honest
    // order-truth / offer metadata onto each saved account right here.
    {
      const dbNow = getDb();
      const byKey = new Map();
      for (const payload of acceptedPayloads) {
        const pKey = payload.phone ? `acc_${String(payload.phone).replace(/\D/g, '').slice(-10)}` : '';
        if (pKey) byKey.set(pKey, payload);
      }
      for (const item of savedAccounts) {
        const acc = dbNow.config?.accounts?.[item.key];
        if (!acc) continue;
        const payload = byKey.get(item.key) || null;
        acc.preferredOfferValue = 1;
        if (payload?.ordersVerifiedLive === true && typeof payload.totalOrdersCount === 'number') {
          acc.totalOrdersCount = payload.totalOrdersCount;
          acc.cachedTotalOrdersCount = payload.totalOrdersCount;
          acc.ordersVerifiedLive = true;
          acc.orderCountSource = 'LIVE';
          acc.isZeroOrderAccount = payload.totalOrdersCount === 0;
          acc.liveActiveOrdersCount = Number(payload.liveActiveOrdersCount || 0);
          acc.orderTruthCheckedAt = payload.orderTruthCheckedAt || new Date().toISOString();
        } else {
          acc.ordersVerifiedLive = false;
          acc.orderCountSource = 'UNVERIFIED';
          acc.orderCountUnverified = true;
          delete acc.totalOrdersCount;
          delete acc.cachedTotalOrdersCount;
          delete acc.isZeroOrderAccount;
        }
        if (Array.isArray(payload?.ignoredFileOrderClaims) && payload.ignoredFileOrderClaims.length) {
          acc.ignoredFileOrderClaims = payload.ignoredFileOrderClaims.slice(0, 10);
        }
        item.account = acc;
        item.totalOrdersCount = acc.totalOrdersCount;
        item.isZeroOrderAccount = acc.isZeroOrderAccount;
        item.ordersVerifiedLive = acc.ordersVerifiedLive;
        item.ignoredFileOrderClaims = acc.ignoredFileOrderClaims || [];
      }
      saveDb(dbNow);
    }

    // Immediately flush to persistent Cloud Vault (`bot-vault` branch) so Render restarts NEVER lose any file!
    await Promise.resolve(syncVaultFn(getDb())).catch(() => {});

    // AUTO-ACTIVATE **SAARE** offer links on EVERY imported ID (boss: "JAB BHI
    // FILE BHEJU SAARE OFFER ACTIVATE HONE CHAHIYE"): Late Night, Breakfast,
    // Extra ₹50, Weekend aur Karwa Chauth — reward option #1 = "₹50 off on ₹199".
    const runOfferActivation = async () => {
      const targets = savedAccounts.slice(0, 40);
      for (let i = 0; i < targets.length; i += claimConcurrency) {
        const chunk = targets.slice(i, i + claimConcurrency);
        await Promise.allSettled(
          chunk.map(async ({ account, key }) => {
            try {
              // `force: false` — engine pehle GET se asli state padhta hai, isliye
              // already-laga offer par ek bhi write nahi jata (double claim band),
              // aur jo galat reward par atka hai woh PATCH se ₹50 par set hota hai.
              const claimOut = await claimOffersFn(account, { force: false, offerValue: 1 });
              const freshDb = getDb();
              const target = freshDb.config?.accounts?.[key] || account;
              if (!target || !claimOut) return;
              target.offers = claimOut.offers || claimOut;
              target.preferredOfferValue = 1;
              target.hasBreakfast = Boolean(claimOut.breakfast?.status === 'CLAIMED');
              target.hasLateNight = Boolean(claimOut.lateNight?.status === 'CLAIMED');
              target.hasExtra50 = Boolean(claimOut.extra50?.status === 'CLAIMED');
              target.hasWeekend = Boolean(claimOut.weekend?.status === 'CLAIMED');
              target.hasKarwaChauth = Boolean(claimOut.karwaChauth?.status === 'CLAIMED');
              target.offerAutoActivation = {
                offerValue: 1,
                label: claimOut.label || '₹50 off on ₹199',
                at: claimOut.at || new Date().toISOString(),
                source: 'JSON_IMPORT',
                bothClaimed: Boolean(claimOut.bothClaimed),
                allFourClaimed: Boolean(claimOut.allFourClaimed),
                claimedCount: Number(claimOut.claimedCount || 0),
                breakfast: claimOut.breakfast || null,
                lateNight: claimOut.lateNight || null,
                extra50: claimOut.extra50 || null,
                weekend: claimOut.weekend || null,
                karwaChauth: claimOut.karwaChauth || null
              };
              // Har sach me active offer = 1 discount. Weekend/Extra50 ab ginte hain.
              let possibleDiscounts = (target.isZeroOrderAccount || target.totalOrdersCount === 0) ? 1 : 0;
              if (target.hasBreakfast) possibleDiscounts += 1;
              if (target.hasLateNight) possibleDiscounts += 1;
              if (target.hasExtra50) possibleDiscounts += 1;
              if (target.hasWeekend) possibleDiscounts += 1;
              if (target.hasKarwaChauth) possibleDiscounts += 1;
              target.possibleDiscountsCount = possibleDiscounts;
              saveDb(freshDb);
              const saved = savedAccounts.find((x) => x.key === key);
              if (saved) {
                saved.offerAutoActivation = target.offerAutoActivation;
                saved.hasBreakfast = target.hasBreakfast;
                saved.hasLateNight = target.hasLateNight;
                saved.hasExtra50 = target.hasExtra50;
                saved.hasWeekend = target.hasWeekend;
                saved.hasKarwaChauth = target.hasKarwaChauth;
                saved.account = target;
              }
            } catch (err) {
              const saved = savedAccounts.find((x) => x.key === key);
              if (saved) {
                saved.offerAutoActivation = {
                  offerValue: 1,
                  label: '₹50 off on ₹199',
                  at: new Date().toISOString(),
                  source: 'JSON_IMPORT',
                  bothClaimed: false,
                  breakfast: { status: 'FAILED', message: String(err?.message || err).slice(0, 120) },
                  lateNight: { status: 'FAILED', message: String(err?.message || err).slice(0, 120) },
                  extra50: { status: 'FAILED', message: String(err?.message || err).slice(0, 120) },
                  weekend: { status: 'FAILED', message: String(err?.message || err).slice(0, 120) },
                  karwaChauth: { status: 'FAILED', message: String(err?.message || err).slice(0, 120) }
                };
              }
            }
          })
        );
        if (i + claimConcurrency < targets.length) {
          await new Promise(r => setTimeout(r, 350));
        }
      }
    };

    if (waitForClaims) {
      await runOfferActivation().catch(() => {});
    } else {
      runOfferActivation().catch(() => {});
    }

    // Persist again so the claim results + live order truth are in the cloud vault.
    await Promise.resolve(syncVaultFn(getDb())).catch(() => {});
  }

  const allVaultActive = Object.values(getDb().config?.accounts || {}).filter(a => a?.isLoggedIn);
  const zeroOrderCount = savedAccounts.filter(s => s.ordersVerifiedLive !== false && (s.isZeroOrderAccount || s.totalOrdersCount === 0)).length;
  const usedAccountCount = savedAccounts.length - zeroOrderCount;

  // The portable 7-field JSON ({name, customerId, mobile, token, tid, sid,
  // deviceId}) for each imported ID — this is what the Boss copies out.
  const liveDb = getDb();
  const portableAccounts = savedAccounts.map((item) => {
    const acc = liveDb.config?.accounts?.[item.key] || item.account || {};
    return {
      key: item.key,
      phone: String(acc.phone || acc.mobile || '').slice(-10),
      name: acc.name || item.key,
      json: buildPortableSessionJson(acc, item.key)
    };
  });

  return {
    savedAccounts,
    portableAccounts,
    zeroOrderCount,
    usedAccountCount,
    expiredList,
    parseErrors,
    totalVaultActiveCount: allVaultActive.length,
    totalVaultZeroOrderCount: allVaultActive.filter(a => a.isZeroOrderAccount || a.totalOrdersCount === 0).length
  };
}

/**
 * Formats a clean, concise single-card summary for 1..200 imported `.json` accounts (never floods Telegram!).
 */
export function formatBulkVaultImportSummaryHtml(result, filesCount = 1) {
  const {
    savedAccounts = [],
    zeroOrderCount = 0,
    usedAccountCount = 0,
    expiredList = [],
    parseErrors = [],
    totalVaultActiveCount = 0,
    totalVaultZeroOrderCount = 0
  } = result || {};

  if (savedAccounts.length === 0) {
    const expLines = expiredList.slice(0, 12).map((e, idx) =>
      `${idx + 1}. <code>${String(e.phone || e.fileName || 'Account').slice(0, 32)}</code> — ${String(e.reason || 'Expired').slice(0, 48)}`
    ).join('\n');
    const errLines = parseErrors.slice(0, 6).map(p => `• <code>${p.fileName}</code>: ${p.reason}`).join('\n');
    return (
      `! <b>Koi Active Session Save Nahi Hua (${filesCount} file checked)</b>\n\n` +
      (expLines ? `× <b>Expired / Logged Out (${expiredList.length}):</b>\n${expLines}\n\n` : '') +
      (errLines ? `! <b>Invalid File (${parseErrors.length}):</b>\n${errLines}\n\n` : '') +
      `▣ <b>Permanent Vault Active IDs Ready:</b> <b>${totalVaultActiveCount}</b>`
    );
  }

  const previewLines = savedAccounts.slice(0, 18).map((item, idx) => {
    const acc = item.account || {};
    const label = acc.phone || acc.name || item.key;
    // Only a LIVE-verified count is printed; an unverified one says so.
    const tag = acc.ordersVerifiedLive === true
      ? (Number(acc.totalOrdersCount) === 0 ? '★ 0 orders (live)' : `▣ ${Number(acc.totalOrdersCount)} orders (live)`)
      : '⚠️ orders live-check pending';
    const act = item.offerAutoActivation || acc.offerAutoActivation || null;
    // SAARE offer — har ek ka apna status (boss: "saare offer ka status dikhana hai").
    const slotStatus = (t) => String(act?.[t.key]?.status || acc.offers?.[t.key]?.status || '').toUpperCase();
    const cells = OFFER_TRACKS.map((t) => {
      const st = slotStatus(t);
      const mark = st === 'CLAIMED' || st === 'ALREADY_CLAIMED' ? '✓'
        : st === 'PRE_LOCKED' ? '⏳'
        : (st === 'WRONG_REWARD' || st === 'CLAIMED_OTHER_VALUE') ? '🟡'
        : '✕';
      return `${t.emoji || ''}${mark}`;
    }).join(' ');
    const claimedN = OFFER_TRACKS.filter((t) => ['CLAIMED', 'ALREADY_CLAIMED'].includes(slotStatus(t))).length;
    return `${idx + 1}. ✓ <code>${label}</code> (${tag}) · ₹50×${OFFER_TRACKS.length} → ${cells} (${claimedN}/${OFFER_TRACKS.length})`;
  }).join('\n');
  const moreNote = savedAccounts.length > 18
    ? `\n<i>...aur ${savedAccounts.length - 18} accounts bhi Vault me save ho gaye!</i>`
    : '';
  const skippedNote = expiredList.length > 0
    ? `\n\n× <b>Skipped Dead/Logged-Out (${expiredList.length}):</b> ${expiredList.slice(0, 6).map(e => `<code>${e.phone || e.fileName}</code>`).join(', ')}${expiredList.length > 6 ? '...' : ''}`
    : '';

  // Web/OTP-style logins mint SHORT-lived tids (~40 min) unlike 30-day app
  // logins. An account imported with a short session will silently stop
  // working for orders/tracking right after expiry — warn at import time.
  const shortSessions = savedAccounts
    .map((item) => ({ label: String(item.account?.phone || item.key || '').slice(0, 12), exp: accountTidExpiryMs(item.account || {}) }))
    .filter((s) => s.exp && (s.exp - Date.now()) < 6 * 60 * 60 * 1000);
  const shortNote = shortSessions.length > 0
    ? `\n\n! <b>Short session (${shortSessions.length}):</b> ${shortSessions.slice(0, 6).map((s) => `<code>${s.label}</code>`).join(', ')}${shortSessions.length > 6 ? '...' : ''} — inka token ~${Math.max(1, Math.round((Math.min(...shortSessions.map((s) => s.exp)) - Date.now()) / 60000))} min me expire hoga (web login). Expire hone par us account se tracking/orders fail honge — fresh app session dobara upload karna.`
    : '';

  const summaryTable = [
    ['▤ Files Processed', String(filesCount)],
    ['+ Fresh 0-Order IDs', String(zeroOrderCount)],
    ['● Other Active IDs', String(usedAccountCount)],
    ['☁️ Total Active Ready', `${totalVaultActiveCount} (${totalVaultZeroOrderCount} Zero-Order)`],
  ];

  const ignoredCounts = savedAccounts.filter((i) => Array.isArray(i.ignoredFileOrderClaims) && i.ignoredFileOrderClaims.length).length;
  const ignoredNote = ignoredCounts > 0
    ? `\n\n<i>⚠️ ${ignoredCounts} file(s) me likha order count ignore kiya gaya — count sirf live Swiggy check se aata hai.</i>`
    : '';

  return (
    section(`✓ ${savedAccounts.length} Swiggy Account(s) Permanently Saved to Vault!`, [
      table(summaryTable),
      '',
      previewLines,
      moreNote,
      skippedNote,
      shortNote,
      ignoredNote,
    ].filter(Boolean).join('\n')) +
    `\n\n${sub('› Ab jab bhi Cart + Address aayega, bot bina OTP maange apne aap Best 0-Order + Max Offer account select karke bill nikal dega!')}`
  );
}

/**
 * One message per imported account with the exact 7-field JSON the Boss copies
 * out: { name, customerId, mobile, token, tid, sid, deviceId }.
 * Returned as plain data so the caller decides how to send it.
 */
export function buildPortableAccountMessages(result) {
  const list = Array.isArray(result?.portableAccounts) ? result.portableAccounts : [];
  return list.map((item) => {
    const saved = (result.savedAccounts || []).find((s) => s.key === item.key) || {};
    const acc = saved.account || {};
    const act = saved.offerAutoActivation || acc.offerAutoActivation || null;
    const bf = act?.breakfast?.status === 'CLAIMED';
    const ln = act?.lateNight?.status === 'CLAIMED';
    const orders = acc.ordersVerifiedLive === true
      ? (Number(acc.totalOrdersCount) === 0 ? '★ 0 orders (LIVE check)' : `● ${Number(acc.totalOrdersCount)} orders (LIVE check)`)
      : '⚠️ order count live-check pending';
    const claimState = (bf && ln) ? 'ALREADY CLAIMED (both offers)' : (act ? 'NEW / PARTIAL — retry claim' : 'NEW — claim pending');
    return {
      key: item.key,
      phone: item.phone,
      fileName: `${item.key}.json`,
      jsonText: JSON.stringify(item.json, null, 2),
      caption:
        `▤ <b>${String(item.name || item.key)}</b> · <code>${String(item.phone || '')}</code>\n` +
        `📦 ${orders}\n` +
        `🎁 ₹50 off on ₹199 → Breakfast ${bf ? '✓' : '✕'} · Late night ${ln ? '✓' : '✕'}\n` +
        `◈ ${claimState}`
    };
  });
}

/**
 * Coalesces multi-file bursts (e.g. Boss dropping 20 `.json` files or a `.zip` file at once in Telegram)
 * into ONE single batch execution + ONE single summary reply — ZERO Telegram `429` flood errors!
 */
export function createBulkDocumentBatchCollector({
  // 1500ms: Telegram 10-20 files thoda gap se bhejta hai. 650ms me batch beech
  // me hi cut ho jata tha aur "jitni file bheji, utni hi" nahi dikhti thi.
  windowMs = 1500,
  downloadBufferFn,
  ingestOptions = {},
  onBatchComplete
} = {}) {
  const buckets = new Map();
  const flushing = new Set();      // chat -> flush chal raha hai
  const pendingAfterFlush = new Set();

  async function flushBucket(chatKey) {
    if (flushing.has(chatKey)) {
      // Isi chat ka flush pehle se chal raha hai (bada batch) — naya bucket
      // uske baad hi chalega, warna do imports aapas me race karte hain aur
      // accounts ghayab ho jate hain.
      pendingAfterFlush.add(chatKey);
      return null;
    }
    flushing.add(chatKey);
    try {
      return await flushBucketInner(chatKey);
    } finally {
      flushing.delete(chatKey);
      if (pendingAfterFlush.delete(chatKey)) {
        // Jo files flush ke dauraan aayi thi — usi ke turant baad process karo.
        setTimeout(() => { flushBucket(chatKey).catch(() => {}); }, 50);
      }
    }
  }

  async function flushBucketInner(chatKey) {
    const bucket = buckets.get(chatKey);
    if (!bucket) return null;
    buckets.delete(chatKey);

    const files = bucket.items;
    const lastCtx = bucket.lastCtx;

    let statusMsg = null;
    if (files.length >= 2 && lastCtx?.reply) {
      statusMsg = await lastCtx.reply(
        `◷ <b>${files.length} Account Files Received!</b> Sabko ek saath verify karke Permanent Vault me save kiya ja raha hai...`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
    }

    // Download all queued Telegram file buffers concurrently (`concurrency = 6`) + unpack `.zip` archives automatically!
    const rawEntries = [];
    const dlErrors = [];
    await runWithConcurrencyLimit(files, 6, async (docItem) => {
      try {
        const buf = await downloadBufferFn(docItem);
        const fname = docItem.fileName || 'session.json';
        if (/\.zip$/i.test(fname) || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
          const unzipped = extractSessionFilesFromZipBuffer(buf);
          if (unzipped.length === 0) {
            dlErrors.push({ fileName: fname, reason: 'ZIP contained no .json / .txt files' });
          } else {
            rawEntries.push(...unzipped);
          }
        } else {
          rawEntries.push({ fileName: fname, text: buf.toString('utf8') });
        }
      } catch (err) {
        dlErrors.push({ fileName: docItem.fileName || 'file.json', reason: err?.message || 'Download error' });
      }
    });

    const result = await ingestAndPersistRawAccountTexts(rawEntries, ingestOptions);
    if (dlErrors.length > 0) {
      result.parseErrors = [...(result.parseErrors || []), ...dlErrors];
    }
    const html = formatBulkVaultImportSummaryHtml(result, Math.max(files.length, rawEntries.length));

    if (onBatchComplete) {
      await onBatchComplete({ chatKey, lastCtx, statusMsg, result, html, filesCount: files.length, rawEntries, dlErrors });
    }
    return result;
  }

  function enqueue(chatKey, ctx, docMeta) {
    let bucket = buckets.get(chatKey);
    if (!bucket) {
      let resolveDone;
      const donePromise = new Promise((res) => { resolveDone = res; });
      bucket = {
        items: [],
        lastCtx: ctx,
        timer: null,
        donePromise,
        resolveDone
      };
      buckets.set(chatKey, bucket);
    }
    bucket.items.push(docMeta);
    bucket.lastCtx = ctx;

    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(async () => {
      try {
        const out = await flushBucket(chatKey);
        bucket.resolveDone(out);
      } catch (err) {
        bucket.resolveDone({ error: err });
      }
    }, windowMs);

    return bucket.donePromise;
  }

  return { enqueue, flushBucket };
}
