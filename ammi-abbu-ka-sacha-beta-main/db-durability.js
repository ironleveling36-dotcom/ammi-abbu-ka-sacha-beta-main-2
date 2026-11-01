/**
 * Boss (31-10-2026, round 19):
 *   "SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"
 *
 * Render par disk attach na ho to har deploy `db.json` naya bana deta hai.
 * Isliye paisa + UTR ka sach **encrypted** form me cloud vault (`bot-vault`
 * branch) me rakha jata hai aur boot par wapas milta hai.
 *
 *  • `backupMoneyNow()`   — snapshot push (throttled)
 *  • `restoreMoneyOnBoot()` — boot par pull + merge (paisa kam nahi hota)
 *  • `durabilityStatus()` — app/boss ko sach (cloud ON/OFF, last snapshot, restore)
 *
 * Kuch bhi token ke bina nahi hota — aur token na ho to status saaf bolta hai
 * ki deploy par data ja sakta hai (jhootha "safe hai" nahi).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb, saveDb } from './store.js';
import { buildMoneySnapshot, snapshotHasData, needsMoneyRestore, mergeMoneySnapshot, describeDurableState } from './money-snapshot.js';
import { buildIdentitySnapshot, snapshotHasIdentities, mergeIdentitySnapshot, describeIdentityDurability, summarizeIdentities } from './identity-snapshot.js';
import { pushVaultTextFile, pullVaultTextFile, pullVaultTextFileDetailed, resolveVaultToken, encryptVaultPayloadObject, decryptVaultPayloadText } from './vault-sync.js';
import { proWorkspaceKeyHealth } from './swiggy-pro-store.js';
import { assessPush, describePushSafety, PUSH_BLOCK } from './vault-safety.js';

const SNAPSHOT_PATH = 'vault/db-money-snapshot.json';
const LOCAL_COPY = 'db-money-snapshot.json';
// Round 22: login IDs + mini-app workspaces bhi deploy-proof (boss: "JITNE BHI
// LOGIN ID HOTE HAIN KISIKA DATA NAHI BACHTA").
const IDENTITY_PATH = 'vault/db-identity-snapshot.json';
const LOCAL_IDENTITY_COPY = 'db-identity-snapshot.json';
const PUSH_MIN_INTERVAL_MS = 20_000;

const identityState = {
  lastPushAt: '', lastPushOk: null, lastError: '', restoredAt: '', restoredSummary: null,
  pushing: false, pending: false,
  // Round 24: push block hua to yahan asli wajah rehti hai (UI/DM isi se bolta hai).
  blockedPush: null, alerts: []
};

const state = {
  lastPushAt: '',
  lastPushOk: null,
  lastError: '',
  restoredAt: '',
  restoredSummary: null,
  bootChecked: false,
  pushing: false,
  pending: false,
  timer: null,
  // Round 24: push block hua to yahan asli wajah rehti hai.
  blockedPush: null,
  alerts: []
};

// Round 24: cloud ka sach baar-baar padhne ki zaroorat nahi — par push se pehle
// hamesha taza hona chahiye, isliye cache chhota rakha hai.
const REMOTE_PULL_CACHE_MS = 90_000;
const remoteCache = new Map();

/** Cloud par kya pada hai — present / readable / snapshot. Kabhi throw nahi. */
async function pullRemoteSnapshot(pathKey, decode) {
  const cached = remoteCache.get(pathKey);
  if (cached && Date.now() - cached.at < REMOTE_PULL_CACHE_MS) return cached;
  let text = '';
  let reason = '';
  let via = '';
  let status = 0;
  let sha = '';
  try {
    const detail = await pullVaultTextFileDetailed(pathKey);
    text = detail.text || '';
    reason = detail.reason || '';
    via = detail.via || '';
    status = Number(detail.status) || 0;
    sha = String(detail.sha || '');
  } catch (err) { reason = String(err?.message || err); text = ''; }
  // A failed authenticated read is NOT evidence that the remote file is empty.
  const cloudEnabled = Boolean(resolveVaultToken()) && process.env.PRO_VAULT_CLOUD_BACKUP !== '0';
  const present = Boolean(String(text).trim()) || (cloudEnabled && status !== 404);
  let snapshot = null;
  if (present) {
    try { snapshot = decode(text); } catch { snapshot = null; }
  }
  if (present && !snapshot && !reason) reason = 'file mili par is key se khul nahi rahi (VAULT_ENCRYPTION_KEY?)';
  const entry = { at: Date.now(), present, readable: present && Boolean(snapshot), snapshot, reason, via, status, sha, text };
  remoteCache.set(pathKey, entry);
  return entry;
}

function forgetRemoteSnapshot(pathKey) {
  try { remoteCache.delete(pathKey); } catch {}
}

function recordAlert(bucket, code, line) {
  const at = new Date().toISOString();
  bucket.blockedPush = { code, line, at };
  bucket.alerts = [{ code, line, at }, ...(Array.isArray(bucket.alerts) ? bucket.alerts : [])].slice(0, 10);
}

function localCopyPath() {
  try { return path.join(getDataDir(), LOCAL_COPY); } catch { return ''; }
}

/**
 * Local disk copy — cloud token na ho to bhi redeploy ke baad (disk bacha ho
 * to) paisa wapas milta hai.
 */
function writeLocalCopy(snapshot) {
  const file = localCopyPath();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    state.lastError = `local copy: ${err?.message || err}`;
    return false;
  }
}

function readLocalCopy() {
  const file = localCopyPath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && snapshotHasData(parsed) ? parsed : null;
  } catch { return null; }
}

/** Snapshot push — best effort, kabhi throw nahi. */
export async function backupMoneyNow({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.lastPushAt && now - Date.parse(state.lastPushAt) < PUSH_MIN_INTERVAL_MS) {
    state.pending = true;
    return { ok: false, skipped: 'throttled' };
  }
  if (state.pushing) { state.pending = true; return { ok: false, skipped: 'busy' }; }
  state.pushing = true;
  try {
    // Fetch first, then read the latest DB. A stale pre-network snapshot could
    // otherwise overwrite a fee debit or a newly approved recharge.
    const remote = await pullRemoteSnapshot(SNAPSHOT_PATH, decodeSnapshotText);
    const db = getDb();
    let snapshot = buildMoneySnapshot(db);
    if (remote.readable && remote.snapshot) {
      const merged = mergeMoneySnapshot(db, remote.snapshot);
      if (merged.conflicts?.length) {
        const line = 'Wallet/UTR histories alag hain — cloud backup ruka hai; dono copies admin review ke liye rakhi gayi hain.';
        recordAlert(state, PUSH_BLOCK.MONEY_CONFLICT, line);
        state.lastError = line;
        return { ok: false, blocked: PUSH_BLOCK.MONEY_CONFLICT, conflicts: merged.conflicts.length, reason: line };
      }
      if (merged.changed) { saveDb(db); snapshot = buildMoneySnapshot(db); }
    }
    const verdict = assessPush({ kind: 'money', local: snapshot, remote: remote.snapshot, remotePresent: remote.present, remoteReadable: remote.readable });
    if (!verdict.allow) {
      recordAlert(state, verdict.code, verdict.line);
      state.lastError = verdict.line;
      return { ok: false, blocked: verdict.code, reason: verdict.line };
    }
    state.blockedPush = null;
    if (!snapshotHasData(snapshot)) return { ok: false, skipped: 'empty' };
    const localOk = writeLocalCopy(snapshot);
    const token = resolveVaultToken();
    if (!token) {
      state.lastPushAt = new Date(now).toISOString();
      state.lastPushOk = localOk;
      state.lastError = localOk ? 'cloud token nahi — sirf local copy' : 'cloud token nahi aur local copy fail';
      return { ok: localOk, localOnly: true };
    }
    const text = JSON.stringify({ __moneySnapshot: true, at: snapshot.at, payload: encryptVaultPayloadObject(snapshot) });
    const res = await pushVaultTextFile(SNAPSHOT_PATH, text, 'chore(vault): money/UTR snapshot (deploy-proof)', {
      expectedRemote: { present: remote.present, sha: remote.sha, text: remote.text }
    });
    if (res?.ok || res?.reason === 'REMOTE_CHANGED') forgetRemoteSnapshot(SNAPSHOT_PATH);
    // A debit or credit can arrive while the network push is in progress.
    // Queue another backup instead of treating the older snapshot as current.
    const latest = buildMoneySnapshot(getDb());
    if (JSON.stringify([latest.config, latest.sections]) !== JSON.stringify([snapshot.config, snapshot.sections])) state.pending = true;
    state.lastPushAt = new Date(now).toISOString();
    state.lastPushOk = res?.ok === true;
    state.lastError = res?.ok ? '' : String(res?.reason || res?.error || `HTTP ${res?.status || '?'}`);
    return { ok: state.lastPushOk, localOnly: false };
  } catch (err) {
    state.lastError = String(err?.message || err);
    return { ok: false, error: state.lastError };
  } finally {
    state.pushing = false;
    if (state.pending) {
      state.pending = false;
      const t = setTimeout(() => { backupMoneyNow({ force: true }).catch(() => {}); }, 1500);
      if (typeof t.unref === 'function') t.unref();
    }
  }
}

function decodeSnapshotText(text) {
  if (!text) return null;
  const asSnapshot = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return asSnapshot(JSON.parse(value)); } catch { return null; }
    }
    if (typeof value !== 'object') return null;
    // `decryptVaultPayloadText` parsed object deta hai, isliye dono shape chalti hain.
    if (value.sections && value.version) return value;
    return null;
  };
  try {
    const parsed = JSON.parse(text);
    const payload = parsed?.payload ?? parsed;
    if (typeof payload === 'string' || (payload && typeof payload === 'object' && payload.__vaultEnc)) {
      const inner = decryptVaultPayloadText(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return asSnapshot(inner);
    }
    // Plain / doosre shape: `sections` wala seedha snapshot.
    return asSnapshot(payload);
  } catch { return null; }
}

/**
 * Boot par ek baar: agar db fresh lagta hai (deploy ke baad) aur snapshot
 * milta hai to paisa/UTR wapas. Local copy bhi try hoti hai.
 */
export async function restoreMoneyOnBoot() {
  state.bootChecked = true;
  const local = readLocalCopy();
  // Always inspect cloud too: a local copy can be older than a successful
  // remote write. Read the DB only AFTER this potentially slow network call.
  const remote = await pullRemoteSnapshot(SNAPSHOT_PATH, decodeSnapshotText);
  const copies = [
    ...(local ? [{ source: 'local', snapshot: local }] : []),
    ...(remote.readable && remote.snapshot ? [{ source: 'cloud', snapshot: remote.snapshot }] : [])
  ];
  if (remote.present && !remote.readable) {
    recordAlert(state, PUSH_BLOCK.REMOTE_UNREADABLE,
      `Cloud money snapshot padha nahi gaya (${remote.reason || 'unknown'}); backup ruka hai taaki purana data na mite.`);
  }
  if (!copies.length) {
    state.restoredAt = '';
    return { restored: false, reason: state.blockedPush?.line || 'snapshot nahi mila' };
  }
  const db = getDb();
  // Preflight into an isolated object; a conflict in the second copy must not
  // allow the first copy to partially mutate the real DB.
  const staged = JSON.parse(JSON.stringify(db));
  let restored = false;
  let source = '';
  let summary = null;
  for (const copy of copies) {
    const merge = mergeMoneySnapshot(staged, copy.snapshot);
    if (merge.conflicts?.length) {
      const line = 'Wallet/UTR histories alag hain — restore ruka hai; dono copies admin review ke liye rakhi gayi hain.';
      recordAlert(state, PUSH_BLOCK.MONEY_CONFLICT, line);
      return { restored: false, source: copy.source, blocked: PUSH_BLOCK.MONEY_CONFLICT, conflicts: merge.conflicts.length, reason: line };
    }
    if (merge.changed) { restored = true; source = copy.source; summary = merge.summary; }
  }
  if (!restored) return { restored: false, source: copies[0].source, reason: 'local db me pehle se data hai' };
  // No async gap since reading db; preserve its concurrency metadata.
  db.config = staged.config;
  saveDb(db);
  state.restoredAt = new Date().toISOString();
  state.restoredSummary = summary;
  console.log('[db-durability] money/UTR restore', source, JSON.stringify(summary));
  return { restored: true, source, summary };
}

/** Boot par interval — har 30s me (badla ho to) snapshot. */
export function startDbDurability({ intervalMs = 30_000 } = {}) {
  if (state.timer) return state.timer;
  state.timer = setInterval(() => {
    backupMoneyNow().catch(() => {});
    // Round 22: login IDs + workspaces bhi (deploy se pehle hi cloud par ho).
    backupIdentityNow().catch(() => {});
  }, intervalMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  // Shutdown se pehle bhi ek baar (best effort).
  try {
    process.once('SIGTERM', () => {
      backupMoneyNow({ force: true }).catch(() => {});
      backupIdentityNow({ force: true }).catch(() => {});
    });
    process.once('beforeExit', () => {
      backupMoneyNow({ force: true }).catch(() => {});
      backupIdentityNow({ force: true }).catch(() => {});
    });
  } catch {}
  return state.timer;
}

export function durabilityStatus() {
  let wallets = 0;
  let utrs = 0;
  try {
    const config = getDb()?.config || {};
    wallets = Object.keys(config.wallets || {}).length;
    utrs = Object.keys(config.usedUtrs || {}).length;
  } catch {}
  let identity = null;
  try { identity = identityStatus(); } catch { identity = null; }
  const cloud = Boolean(resolveVaultToken());
  const dataDir = (() => { try { return getDataDir(); } catch { return ''; } })();
  const looksEphemeral = !/^\/app\/data|^\/data\b|^\/var\/data/.test(dataDir) && process.env.NODE_ENV === 'production';
  return {
    cloud,
    dataDir,
    looksEphemeral,
    lastPushAt: state.lastPushAt,
    lastPushOk: state.lastPushOk,
    lastError: state.lastError,
    restoredAt: state.restoredAt,
    restoredSummary: state.restoredSummary,
    // Round 24: push ruka hai ya nahi + asli wajah (UI/DM isi se bolta hai).
    pushBlocked: state.blockedPush,
    alerts: state.alerts,
    safetyLine: describePushSafety({ blocked: state.blockedPush, alerts: state.alerts }),
    wallets,
    utrs,
    // Round 22: login IDs ka sach bhi isi status me.
    identity: identity ? {
      total: identity.total, live: identity.live, expired: identity.expired,
      workspaces: identity.workspaceCount, restoredAt: identity.restoredAt,
      lastPushAt: identity.lastPushAt, lastError: identity.lastError, line: identity.line
    } : null,
    line: describeDurableState({
      snapshotAt: state.lastPushAt ? new Date(state.lastPushAt).toLocaleString('en-IN') : '',
      restoredAt: state.restoredAt ? new Date(state.restoredAt).toLocaleString('en-IN') : '',
      cloud,
      localOnly: looksEphemeral,
      walletCount: wallets,
      utrCount: utrs
    })
  };
}


// ── Login ID / mini-app workspace durability (round 22) ────────────────────

function identityLocalPath() {
  try { return path.join(getDataDir(), LOCAL_IDENTITY_COPY); } catch { return ''; }
}

function writeIdentityLocalCopy(snapshot) {
  const file = identityLocalPath();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    identityState.lastError = `local copy: ${err?.message || err}`;
    return false;
  }
}

function readIdentityLocalCopy() {
  const file = identityLocalPath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && snapshotHasIdentities(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * Login IDs + mini-app workspaces ka snapshot — local copy + encrypted cloud.
 * Kabhi throw nahi karta (backup fail hone se app nahi rukta).
 */
export async function backupIdentityNow({ force = false } = {}) {
  const now = Date.now();
  if (!force && identityState.lastPushAt && now - Date.parse(identityState.lastPushAt) < PUSH_MIN_INTERVAL_MS) {
    identityState.pending = true;
    return { ok: false, skipped: 'throttled' };
  }
  if (identityState.pushing) { identityState.pending = true; return { ok: false, skipped: 'busy' }; }
  identityState.pushing = true;
  try {
    const db = getDb();
    let snapshot = buildIdentitySnapshot(db);
    // Round 24: push se pehle cloud ka sach — login ID kabhi kam nahi hote.
    const remote = await pullRemoteSnapshot(IDENTITY_PATH, decodeIdentityText);
    if (remote.readable && remote.snapshot) {
      const merged = mergeIdentitySnapshot(db, remote.snapshot, { reviveDead: false });
      if (merged.changed) {
        saveDb(db);
        writeRestoredWorkspaces(merged.workspacesToRestore);
        snapshot = buildIdentitySnapshot(db);
      }
    }
    const verdict = assessPush({ kind: 'identity', local: snapshot, remote: remote.snapshot, remotePresent: remote.present, remoteReadable: remote.readable });
    if (!verdict.allow) {
      recordAlert(identityState, verdict.code, verdict.line);
      identityState.lastError = verdict.line;
      return { ok: false, blocked: verdict.code, reason: verdict.line };
    }
    identityState.blockedPush = null;
    // Mirror row se naya disk file ho to wahi snapshot me jaye — warna 1.5s ke
    // debounce me hua aakhri change deploy par chhut sakta hai.
    try {
      const dir = path.join(getDataDir(), 'pro-workspaces');
      for (const row of Object.values(snapshot.workspaces)) {
        const file = path.join(dir, `${require_sha256(row.userId)}.json`);
        if (!fs.existsSync(file)) continue;
        const envelope = fs.readFileSync(file, 'utf8');
        if (envelope.length > 20 && envelope.includes('"version"')) row.envelope = envelope;
      }
    } catch { /* disk read best-effort */ }
    if (!snapshotHasIdentities(snapshot)) return { ok: false, skipped: 'empty' };
    const localOk = writeIdentityLocalCopy(snapshot);
    const token = resolveVaultToken();
    if (!token) {
      identityState.lastPushAt = new Date(now).toISOString();
      identityState.lastPushOk = localOk;
      identityState.lastError = localOk ? 'cloud token nahi — sirf local copy' : 'cloud token nahi aur local copy fail';
      return { ok: localOk, localOnly: true };
    }
    const text = JSON.stringify({ __identitySnapshot: true, at: snapshot.at, payload: encryptVaultPayloadObject(snapshot) });
    const res = await pushVaultTextFile(IDENTITY_PATH, text, 'chore(vault): login IDs + mini-app workspaces (deploy-proof)');
    if (res?.ok) forgetRemoteSnapshot(IDENTITY_PATH);
    identityState.lastPushAt = new Date(now).toISOString();
    identityState.lastPushOk = res?.ok === true;
    identityState.lastError = res?.ok ? '' : String(res?.reason || res?.error || `HTTP ${res?.status || '?'}`);
    return { ok: identityState.lastPushOk, localOnly: false, counts: snapshot.counts };
  } catch (err) {
    identityState.lastError = String(err?.message || err);
    return { ok: false, error: identityState.lastError };
  } finally {
    identityState.pushing = false;
    if (identityState.pending) {
      identityState.pending = false;
      const t = setTimeout(() => { backupIdentityNow({ force: true }).catch(() => {}); }, 1500);
      if (typeof t.unref === 'function') t.unref();
    }
  }
}

function decodeIdentityText(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const payload = parsed?.payload ?? parsed;
    if (typeof payload === 'string' || (payload && typeof payload === 'object' && payload.__vaultEnc)) {
      const inner = decryptVaultPayloadText(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (!inner || typeof inner !== 'object') return null;
      return inner.accounts || inner.workspaces ? inner : null;
    }
    if (payload && typeof payload === 'object' && payload.accounts) return payload;
    return null;
  } catch { return null; }
}

/**
 * Boot par: deploy ke baad khaali db me login IDs + workspaces wapas.
 * Local copy pehle, phir cloud. Live local session kabhi overwrite nahi hota.
 */
export async function restoreIdentityOnBoot() {
  let snapshot = readIdentityLocalCopy();
  let source = snapshot ? 'local' : '';
  if (!snapshot) {
    const remote = await pullRemoteSnapshot(IDENTITY_PATH, decodeIdentityText);
    if (remote.readable && remote.snapshot) {
      snapshot = remote.snapshot;
      source = 'cloud';
    } else if (remote.present) {
      recordAlert(identityState, PUSH_BLOCK.REMOTE_UNREADABLE,
        'Cloud par login IDs ka snapshot hai par is key se khul nahi raha (VAULT_ENCRYPTION_KEY badli lagti hai) — restore nahi hua, aur backup ROK diya hai taaki purana data mite na.');
    }
  }
  if (!snapshot) return { restored: false, reason: identityState.blockedPush?.line || 'identity snapshot nahi mila' };
  const db = getDb();
  const merge = mergeIdentitySnapshot(db, snapshot);
  // Workspace files bhi disk par wapas — warna user ko dobara login karna padta.
  const workspacesWritten = writeRestoredWorkspaces(merge.workspacesToRestore);
  if (merge.changed) {
    saveDb(db);
    identityState.restoredAt = new Date().toISOString();
    identityState.restoredSummary = { ...merge.summary, workspacesWritten };
    console.log('[db-durability] login ID restore', source, JSON.stringify(identityState.restoredSummary));
  }
  return {
    restored: merge.changed,
    source,
    summary: { ...merge.summary, workspacesWritten },
    reason: merge.changed ? '' : 'local db me IDs pehle se hain'
  };
}

/** Snapshot se aaye workspace envelopes disk par wapas. Kabhi throw nahi. */
function writeRestoredWorkspaces(items = []) {
  let written = 0;
  for (const item of items || []) {
    try {
      const file = path.join(getDataDir(), 'pro-workspaces');
      fs.mkdirSync(file, { recursive: true, mode: 0o700 });
      const target = path.join(file, `${require_sha256(item.userId)}.json`);
      if (fs.existsSync(target)) continue;
      const tmp = `${target}.${process.pid}.restore.tmp`;
      fs.writeFileSync(tmp, item.envelope, { mode: 0o600 });
      fs.renameSync(tmp, target);
      written += 1;
    } catch { /* ek workspace fail ho to baaki chalte rahen */ }
  }
  return written;
}

function require_sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Boss/user card ke liye login ID ka sach. */
export function identityStatus() {
  let accounts = [];
  let workspaceCount = 0;
  let cloud = false;
  let workspaceHealth = { ok: 0, failed: 0, total: 0, keySource: '' };
  try {
    const db = getDb();
    accounts = summarizeIdentities(db?.config?.accounts);
    workspaceCount = Object.keys(db?.config?.proWorkspaceMirror || {}).length;
    cloud = Boolean(resolveVaultToken());
    workspaceHealth = proWorkspaceKeyHealth();
  } catch { /* health check best-effort */ }
  const live = accounts.filter((a) => a.status === 'LOGGED_IN').length;
  const expired = accounts.filter((a) => a.status === 'EXPIRED' || a.status === 'LOGGED_OUT').length;
  return {
    cloud,
    total: accounts.length,
    live,
    expired,
    workspaceCount,
    lastPushAt: identityState.lastPushAt,
    lastPushOk: identityState.lastPushOk,
    lastError: identityState.lastError,
    restoredAt: identityState.restoredAt,
    restoredSummary: identityState.restoredSummary,
    // Round 24: push ruka hai ya nahi + asli wajah.
    pushBlocked: identityState.blockedPush,
    alerts: identityState.alerts,
    safetyLine: describePushSafety({ blocked: identityState.blockedPush, alerts: identityState.alerts }),
    workspaceHealth,
    accounts,
    line: describeIdentityDurability({
      cloud,
      accountCount: accounts.length,
      workspaceCount,
      restoredAt: identityState.restoredAt,
      snapshotAt: identityState.lastPushAt,
      lastError: identityState.lastError
    }) + (workspaceHealth.failed > 0
      ? ` · ${workspaceHealth.failed} mini-app workspace is vault key se khul nahi rahe — PRO_VAULT_KEY/VAULT_ENCRYPTION_KEY badla lagta hai (data safe hai, par padha nahi ja sakta).`
      : '')
  };
}

/**
 * Round 26 (boss: "PHIR DEPLOY HOTE HI SAB ERASE HOGAYA"):
 * boot restore fail ho gaya ho (network/key) to bhi boss ke ek button se poora
 * vault wapas aana chahiye — bina naya deploy kiye. Ye **forced** restore hai:
 * cloud se padhta hai, union merge karta hai (data kabhi kam nahi), aur saaf
 * summary deta hai ki kitni ID / kitna paisa / kitne workspace wapas aaye.
 */
export async function restoreFromVaultNow({ actor = 'boss', at = Date.now() } = {}) {
  // Cache clear — warna purana "mil nahi raha" wala jawab hi laut aayega.
  forgetRemoteSnapshot(IDENTITY_PATH);
  forgetRemoteSnapshot(SNAPSHOT_PATH);
  const report = { ok: false, identity: null, money: null, at: new Date(at).toISOString(), actor: String(actor || 'boss') };
  try {
    const db = getDb();
    const idRemote = await pullRemoteSnapshot(IDENTITY_PATH, decodeIdentityText);
    if (idRemote.readable && idRemote.snapshot) {
      const merged = mergeIdentitySnapshot(db, idRemote.snapshot, { at, reviveDead: true });
      if (merged.changed) saveDb(db);
      const written = writeRestoredWorkspaces(merged.workspacesToRestore);
      report.identity = {
        source: idRemote.via || 'cloud', restored: merged.changed,
        accounts: merged.summary.accounts, workspaces: merged.summary.workspaces,
        workspacesWritten: written, total: (identityStatus().total || 0)
      };
    } else {
      report.identity = { restored: false, reason: idRemote.present ? (idRemote.reason || 'snapshot khula nahi') : (idRemote.reason || 'identity snapshot vault me nahi hai') };
    }
  } catch (err) { report.identity = { restored: false, reason: String(err?.message || err) }; }
  try {
    const db = getDb();
    const moneyRemote = await pullRemoteSnapshot(SNAPSHOT_PATH, decodeSnapshotText);
    if (moneyRemote.readable && moneyRemote.snapshot) {
      const merged = mergeMoneySnapshot(db, moneyRemote.snapshot, { at });
      if (merged.changed) saveDb(db);
      report.money = { source: moneyRemote.via || 'cloud', restored: merged.changed, summary: merged.summary || null, wallets: Object.keys(db?.config?.wallets || {}).length };
    } else {
      report.money = { restored: false, reason: moneyRemote.present ? (moneyRemote.reason || 'snapshot khula nahi') : (moneyRemote.reason || 'paisa snapshot vault me nahi hai') };
    }
  } catch (err) { report.money = { restored: false, reason: String(err?.message || err) }; }
  const idOk = report.identity && (report.identity.restored || Number(report.identity.total) > 0);
  const moneyOk = report.money && (report.money.restored || Number(report.money.wallets) > 0);
  report.ok = Boolean(idOk || moneyOk);
  if (report.ok) {
    identityState.restoredAt = new Date(at).toISOString();
    state.restoredAt = new Date(at).toISOString();
    state.blockedPush = null;
    identityState.blockedPush = null;
  }
  return report;
}

/** Test ke liye — state reset. */
export function _resetDurabilityState() {
  identityState.lastPushAt = ''; identityState.lastPushOk = null; identityState.lastError = '';
  identityState.restoredAt = ''; identityState.restoredSummary = null;
  identityState.pushing = false; identityState.pending = false;
  identityState.blockedPush = null; identityState.alerts = [];
  state.lastPushAt = ''; state.lastPushOk = null; state.lastError = '';
  state.restoredAt = ''; state.restoredSummary = null; state.bootChecked = false;
  state.pushing = false; state.pending = false;
  state.blockedPush = null; state.alerts = [];
  remoteCache.clear();
}
