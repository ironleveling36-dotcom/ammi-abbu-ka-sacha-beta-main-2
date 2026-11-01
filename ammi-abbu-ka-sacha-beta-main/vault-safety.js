/**
 * Boss (31-10-2026, round 24):
 *   "BHAI TU PEHLE YE FIX KAR DE TAAKI KOI DATA ERASE NA HO"
 *
 * Round 19/22 ne deploy ke baad data wapas laane ka rasta bana diya (cloud
 * vault + local copies). Par ek rasta **ulta** bacha hua tha, aur wahi sabse
 * khatarnaak tha:
 *
 *   Boot par restore fail ho jaye (network, key badalna, token expire) →
 *   app khaali db ke saath chalta rahe → agla backup us **khaali snapshot** ko
 *   cloud par push kar de → purana asli data hamesha ke liye overwrite.
 *
 * Isliye ab har push se pehle cloud ka sach padha jata hai aur tay hota hai ki
 * push safe hai ya nahi. Ye module **pure** hai (koi network, koi disk nahi) —
 * sirf faisla, taaki test se saabit ho sake.
 *
 * Faisla (dono taraf — paisa aur login IDs):
 *   1. Cloud par file hai par hum padh nahi pa rahe (key galat/badli) →
 *      **push band**. Naya data cloud par jaakar purana nahi mitayega.
 *   2. Local me data hi nahi bacha (khaali db) → **push band**. Khaali cheez
 *      cloud par kabhi nahi jaati.
 *   3. Warna push theek — lekin pehle cloud wala padha aur local me **milaya**
 *      jata hai (`mergeMoneySnapshot` / `mergeIdentitySnapshot` dono union hain),
 *      taaki do jagah ka data kabhi kam na ho.
 */

export const PUSH_BLOCK = {
  REMOTE_UNREADABLE: 'REMOTE_UNREADABLE',
  LOCAL_EMPTY: 'LOCAL_EMPTY',
  MONEY_CONFLICT: 'MONEY_CONFLICT'
};

export const PUSH_STATE = {
  ALLOW: 'ALLOW',
  MERGE_THEN_ALLOW: 'MERGE_THEN_ALLOW'
};

/** Identity snapshot ka weight — kya kya andar hai. */
export function identityWeight(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const count = (value) => (value && typeof value === 'object' ? Object.keys(value).length : 0);
  const accounts = count(s.accounts);
  const workspaces = count(s.workspaces);
  const sessionVault = count(s.sessionVault);
  const tombstones = count(s.deletedAccounts);
  return { accounts, workspaces, sessionVault, tombstones, total: accounts + workspaces + sessionVault + tombstones };
}

/** Paisa snapshot ka weight — kitne record aur kitna balance. */
export function moneyWeight(snapshot) {
  const sections = snapshot?.sections || {};
  const count = (value) => (value && typeof value === 'object' ? Object.keys(value).length : 0);
  const counts = {
    wallets: count(sections.wallets),
    topupRequests: count(sections.topupRequests),
    topupClaims: count(sections.topupClaims),
    topupIntents: count(sections.topupIntents),
    usedUtrs: count(sections.usedUtrs)
  };
  const balancePaise = Object.values(sections.wallets || {}).reduce((sum, wallet) => {
    const value = Number(wallet?.balancePaise);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const records = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ...counts, records, balancePaise };
}

export function weightOf(kind, snapshot) {
  return kind === 'money' ? moneyWeight(snapshot) : identityWeight(snapshot);
}

function hasWeight(weight) {
  if (!weight || typeof weight !== 'object') return false;
  if (Number(weight.total) > 0 || Number(weight.records) > 0) return true;
  return Number(weight.balancePaise) > 0;
}

function describeWeight(kind, weight) {
  if (!weight) return 'kuch nahi';
  if (kind === 'money') {
    return `${weight.records} record (₹${(Number(weight.balancePaise || 0) / 100).toFixed(0)} balance)`;
  }
  return `${weight.accounts} ID · ${weight.workspaces} workspace · ${weight.sessionVault} purane session`;
}

/**
 * Push safe hai ya nahi.
 * @param {{kind?:'money'|'identity', local?:object, remote?:object,
 *          remotePresent?:boolean, remoteReadable?:boolean}} input
 */
export function assessPush({ kind = 'identity', local = null, remote = null, remotePresent = false, remoteReadable = true } = {}) {
  const localWeight = weightOf(kind, local);
  const remoteWeight = weightOf(kind, remote);
  const localData = hasWeight(localWeight);
  const remoteData = remotePresent && remoteReadable && hasWeight(remoteWeight);

  if (remotePresent && !remoteReadable) {
    return {
      allow: false,
      code: PUSH_BLOCK.REMOTE_UNREADABLE,
      localWeight,
      remoteWeight,
      line: `Cloud par purana data pada hai par is key se khul nahi raha — backup ROK diya, purana data overwrite nahi hoga. Render me VAULT_ENCRYPTION_KEY wahi rakhein jo pehle tha.`
    };
  }
  if (!localData) {
    return {
      allow: false,
      code: PUSH_BLOCK.LOCAL_EMPTY,
      localWeight,
      remoteWeight,
      line: remoteData
        ? `Local me data khaali hai jabki cloud par ${describeWeight(kind, remoteWeight)} pada hai — khaali snapshot cloud par nahi bheja (warna data mit jata).`
        : `Local me abhi kuch nahi hai — khaali snapshot push nahi hota.`
    };
  }
  if (remoteData) {
    return {
      allow: true,
      code: PUSH_STATE.MERGE_THEN_ALLOW,
      localWeight,
      remoteWeight,
      line: `Cloud par bhi ${describeWeight(kind, remoteWeight)} hai — pehle milaya, phir push.`
    };
  }
  return {
    allow: true,
    code: PUSH_STATE.ALLOW,
    localWeight,
    remoteWeight,
    line: `Push theek hai (${describeWeight(kind, localWeight)}).`
  };
}

/** Status card ke liye ek saaf line — jhooth nahi. */
export function describePushSafety({ blocked = null, alerts = [], remoteUnreadable = false } = {}) {
  if (blocked?.code === PUSH_BLOCK.REMOTE_UNREADABLE || remoteUnreadable) {
    return 'Cloud backup RUKA hua hai — purana vault is key se khul nahi raha. Data overwrite nahi hone diya; VAULT_ENCRYPTION_KEY purani wali rakhein.';
  }
  if (blocked?.code === PUSH_BLOCK.LOCAL_EMPTY) {
    return 'Cloud backup RUKA hua hai — local me abhi data khaali hai, khaali snapshot cloud par nahi bheja.';
  }
  if (blocked?.code) return `Cloud backup RUKA hua hai — ${blocked.line || blocked.code}`;
  if (Array.isArray(alerts) && alerts.length > 0) return alerts[0].line || String(alerts[0].code || '');
  return '';
}
