/**
 * Boss (31-10-2026, round 22):
 *   "AB JAISE JITNE BHI LOGIN ID HOTE HAIN KISIKA DATA NAHI BACHTA WO KISLIYE
 *    AND KYA SOLUTION HAI"
 *
 * Wajah: `store.js` ka `ensureDb()` `db.json` na mile to `defaultData` bana deta
 * hai. Render par disk attach na ho to har deploy par **saari login IDs**
 * (cookies/token), unke mini-app workspaces (address, cart, orders) aur session
 * vault gayab. Money ka snapshot round 19 me bana tha — IDs ka nahi.
 *
 * Ye module pure hai (koi network/DB). Isi par `db-durability.js` ka
 * identity backup/restore chalta hai:
 *   • accounts (cookies/token/sessionVault) — ek bhi logged-in ID nahi jaata
 *   • mini-app workspaces (encrypted envelopes) — user ka pura app data
 *   • delete tombstones — jo ID jaan-boojh kar hataayi wo wapas nahi aati
 * Paisa jaisa hi rule: local live session kabhi cloud se overwrite nahi hota,
 * aur expired ID ko "chal rahi hai" nahi dikhaya jata.
 */

export const IDENTITY_SNAPSHOT_VERSION = 1;

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copy(value) {
  try { return JSON.parse(JSON.stringify(value ?? {})); } catch { return {}; }
}

function phoneOf(account) {
  return String(account?.phone || account?.mobile || '').replace(/\D/g, '').slice(-10);
}

/** Ek ID ka sach — UI/status ke liye (cookies kabhi bahar nahi jaate). */
export function summarizeIdentity(key, account) {
  const cookies = String(account?.cookies || '');
  const hasSession = Boolean(cookies.includes('_session_tid=') || account?.tid || account?.token || account?.jwtTid);
  const status = account?.isLoggedOut === true
    ? 'LOGGED_OUT'
    : account?.sessionExpired === true
      ? 'EXPIRED'
      : account?.isLoggedIn === false
        ? 'LOGGED_OUT'
        : hasSession ? 'LOGGED_IN' : 'NO_SESSION';
  return {
    key: String(key),
    name: String(account?.name || account?.swiggyName || '').slice(0, 60),
    phoneMasked: phoneOf(account) ? `${phoneOf(account).slice(0, 2)}••••${phoneOf(account).slice(-4)}` : '',
    status,
    hasSession,
    savedAt: String(account?.savedAt || ''),
    lastVerifiedAt: String(account?.lastVerifiedAt || ''),
    restoredFromSnapshot: account?.restoredFromSnapshot === true
  };
}

export function summarizeIdentities(accounts) {
  return Object.entries(safeObject(accounts)).map(([key, account]) => summarizeIdentity(key, account));
}

/**
 * Snapshot: har login ID + session vault + mini-app workspaces + tombstones.
 * Sirf wahi IDs jinme asli session hai (khaali shell ka backup bekaar hai).
 */
export function buildIdentitySnapshot(db, { at = Date.now() } = {}) {
  const config = safeObject(db?.config);
  const accounts = {};
  for (const [key, account] of Object.entries(safeObject(config.accounts))) {
    if (!account || typeof account !== 'object') continue;
    if (!account.cookies && !account.tid && !account.token && !account.jwtTid && account.isLoggedIn !== true) continue;
    accounts[key] = copy(account);
  }
  const workspaces = {};
  for (const [rowKey, row] of Object.entries(safeObject(config.proWorkspaceMirror))) {
    if (!row?.envelope || !row?.userId) continue;
    workspaces[rowKey] = { userId: String(row.userId), savedAt: String(row.savedAt || ''), envelope: String(row.envelope) };
  }
  return {
    version: IDENTITY_SNAPSHOT_VERSION,
    at: new Date(at).toISOString(),
    accounts,
    sessionVault: copy(db?.sessionVault),
    deletedAccounts: copy(config.deletedAccounts),
    workspaces,
    counts: {
      accounts: Object.keys(accounts).length,
      sessionVault: Object.keys(safeObject(db?.sessionVault)).length,
      workspaces: Object.keys(workspaces).length,
      tombstones: Object.keys(safeObject(config.deletedAccounts)).length
    }
  };
}

export function snapshotHasIdentities(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return Object.keys(safeObject(snapshot.accounts)).length > 0 ||
    Object.keys(safeObject(snapshot.workspaces)).length > 0 ||
    Object.keys(safeObject(snapshot.sessionVault)).length > 0;
}

function isTombstoned(deleted, key, phone) {
  const map = safeObject(deleted);
  if (map[key]) return true;
  if (!phone) return false;
  return Object.keys(map).some((candidate) => {
    if (!map[candidate]) return false;
    return String(candidate).includes(phone);
  });
}

/**
 * Snapshot ko db me milao. Rules:
 *  • local me pehle se live session hai → usko chhedо mat (naya hi jeetta hai)
 *  • local me jaan-boojh kar logout/expire kiya hai → wapas nahi laate
 *  • delete tombstone (local ya snapshot) → kabhi resurrect nahi
 *  • baaki sab missing IDs add ho jaate hain
 *  • workspaces sirf wahi return hote hain jo local db me nahi hain
 */
export function mergeIdentitySnapshot(db, snapshot, { at = Date.now(), reviveDead = true } = {}) {
  const summary = { accounts: 0, accountsSkippedLive: 0, accountsSkippedTombstone: 0, sessionVault: 0, tombstones: 0, workspaces: 0 };
  const workspacesToRestore = [];
  if (!snapshot || typeof snapshot !== 'object') return { changed: false, summary, workspacesToRestore };

  if (!db.config) db.config = {};
  const ensureObject = (holder, key) => {
    if (!holder[key] || typeof holder[key] !== 'object' || Array.isArray(holder[key])) holder[key] = {};
    return holder[key];
  };
  ensureObject(db.config, 'accounts');
  ensureObject(db, 'sessionVault');
  ensureObject(db.config, 'deletedAccounts');
  ensureObject(db.config, 'proWorkspaceMirror');
  let changed = false;

  // Tombstones pehle — warna snapshot ka purana account resurrect ho jayega.
  for (const [key, value] of Object.entries(safeObject(snapshot.deletedAccounts))) {
    if (!value) continue;
    if (!db.config.deletedAccounts[key]) { db.config.deletedAccounts[key] = true; summary.tombstones += 1; changed = true; }
  }

  for (const [key, remote] of Object.entries(safeObject(snapshot.accounts))) {
    if (!remote || typeof remote !== 'object') continue;
    const phone = phoneOf(remote);
    if (isTombstoned(db.config.deletedAccounts, key, phone) || isTombstoned(snapshot.deletedAccounts, key, phone)) {
      summary.accountsSkippedTombstone += 1;
      continue;
    }
    const existing = db.config.accounts[key];
    if (existing) {
      // Round 24: backup se pehle mila rahe hain to local sach hi jeetta hai —
      // verified-expired ID ko purane cloud copy se zinda nahi karte.
      if (!reviveDead) { summary.accountsSkippedLive += 1; continue; }
      const live = existing.isLoggedOut !== true && existing.isLoggedIn !== false && existing.sessionExpired !== true;
      if (live && (existing.cookies || existing.tid || existing.token)) { summary.accountsSkippedLive += 1; continue; }
      // Local copy dead hai — snapshot wali zinda session wapas laao.
      db.config.accounts[key] = { ...copy(remote), restoredFromSnapshot: true, restoredAt: new Date(at).toISOString() };
      summary.accounts += 1;
      changed = true;
      continue;
    }
    db.config.accounts[key] = { ...copy(remote), restoredFromSnapshot: true, restoredAt: new Date(at).toISOString() };
    summary.accounts += 1;
    changed = true;
  }

  for (const [key, value] of Object.entries(safeObject(snapshot.sessionVault))) {
    if (!value || db.sessionVault[key]) continue;
    db.sessionVault[key] = copy(value);
    summary.sessionVault += 1;
    changed = true;
  }

  const mirror = safeObject(db.config.proWorkspaceMirror);
  for (const [rowKey, row] of Object.entries(safeObject(snapshot.workspaces))) {
    if (!row?.envelope || !row?.userId) continue;
    if (mirror[rowKey]?.envelope) continue; // local workspace zinda hai
    db.config.proWorkspaceMirror[rowKey] = {
      v: 1, userId: String(row.userId), savedAt: String(row.savedAt || new Date(at).toISOString()),
      checksum: String(row.checksum || ''), envelope: String(row.envelope)
    };
    workspacesToRestore.push({ userId: String(row.userId), envelope: String(row.envelope) });
    summary.workspaces += 1;
    changed = true;
  }

  if (changed) db.config.lastIdentityRestoreAt = new Date(at).toISOString();
  return { changed, summary, workspacesToRestore };
}

/** App/boss card ke liye ek line — sach, dhamki nahi. */
export function describeIdentityDurability({
  cloud = false, accountCount = 0, workspaceCount = 0, restoredAt = '', snapshotAt = '', lastError = ''
} = {}) {
  const when = (iso) => {
    const ms = Date.parse(iso || '');
    return Number.isFinite(ms) ? new Date(ms).toLocaleString('en-IN') : '';
  };
  if (!cloud) {
    return `Cloud backup OFF — deploy par ${accountCount || 'saari'} login ID aur mini-app data mit sakta hai. GITHUB_VAULT_TOKEN Render env me daalein.`;
  }
  const parts = [`${accountCount} login ID`, `${workspaceCount} mini-app workspace`];
  const bits = [`Cloud backup ON · ${parts.join(' · ')} yaad`];
  if (snapshotAt) bits.push(`last snapshot ${when(snapshotAt)}`);
  if (restoredAt) bits.push(`deploy ke baad restore hua ${when(restoredAt)}`);
  if (lastError) bits.push(`last error: ${String(lastError).slice(0, 120)}`);
  return bits.join(' · ');
}
