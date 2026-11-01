import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb, saveDb } from './store.js';
import { proWorkspaceVaultPath, pullVaultTextFile, pushVaultTextFile } from './vault-sync.js';

// The chat bot's shared vault must not contain the Mini App's private users.
// Each Telegram user's workspace is authenticated and encrypted separately.
// Back this directory up on an encrypted persistent volume: it is deliberately
// NOT included in the bot's existing shared-account cloud vault.
// ---------------------------------------------------------------------------
// VAULT KEY — boss (31-10-2026): "Server setup needed … Try again ISKO THEEK KAR"
//
// Pehle jab tak owner PRO_VAULT_KEY na daale, app dead-end tha: har user ko
// "Server setup needed" dikhta tha. Ab key khud manage hoti hai, par safe
// tarteeb me — jo data pehle se encrypted hai wo kabhi silently na toote:
//
//   1. PRO_VAULT_KEY / VAULT_ENCRYPTION_KEY  (owner ka explicit key — best)
//   2. DATA_DIR/pro-vault.key               (pehle se bani hui key file)
//   3. BOT_TOKEN se derive                  (deploy ke baad bhi same rehti hai,
//                                            ephemeral disk par bhi stable)
//   4. random generate + file me save       (sirf jab BOT_TOKEN bhi na ho)
//
// Sach ka rule: agar kisi user ka purana workspace is key se khulta nahi, to
// read path PRO_VAULT_DECRYPT_FAILED deta hai aur likhne ki koshish nahi hoti —
// purana data overwrite nahi hota (sirf "kuch nahi kiya" ka jhooth nahi).
// ---------------------------------------------------------------------------
const KEY_FILE_NAME = 'pro-vault.key';
// scrypt mehnga hai (~50ms) — sirf derived key cache karte hain, secret se
// keyed. Isse env badalne par nayi key turant lagti hai (stale cache nahi).
const derivedKeyCache = new Map();
let lastSource = '';

function keyFile() {
  return path.join(getDataDir(), KEY_FILE_NAME);
}

function workspaceDir() {
  return path.join(getDataDir(), 'pro-workspaces');
}

function keyFromSecret(secret) {
  const hit = derivedKeyCache.get(secret);
  if (hit) return hit;
  const key = crypto.scryptSync(secret, 'sacha-beta-miniapp-v1', 32);
  if (derivedKeyCache.size > 8) derivedKeyCache.clear();
  derivedKeyCache.set(secret, key);
  return key;
}

function readKeyFile() {
  try {
    const raw = fs.readFileSync(keyFile(), 'utf8').trim();
    return raw.length >= 16 ? raw : '';
  } catch {
    return '';
  }
}

function writeKeyFile(secret) {
  try {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${keyFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, secret, { mode: 0o600 });
    fs.renameSync(tmp, keyFile());
    return true;
  } catch (err) {
    console.warn('[MiniAppVault] key file save nahi hui (read-only disk?):', err?.message || err);
    return false;
  }
}

/**
 * Server par available secrets se deterministic key — redeploy ke baad bhi wahi,
 * isliye ephemeral disk par bhi workspaces khulte rehte hain.
 */
function derivedSecret() {
  // Sirf server ke asli secrets — DATA_DIR jaisa path nahi (wo machine badalne
  // par badal sakta hai, aur key badalna = purana data band).
  const parts = [
    String(process.env.BOT_TOKEN || '').trim(),
    String(process.env.PAY_WEBHOOK_SECRET || '').trim()
  ].filter(Boolean);
  if (!parts.length) return '';
  return crypto.createHash('sha256').update(`pro-vault-v1:${parts.join('|')}`).digest('hex');
}

/** Tests / rotate ke liye — key cache clear. */
export function resetProVaultKeyCache() {
  derivedKeyCache.clear();
  lastSource = '';
}

/** Ab kaunsi key source chal rahi hai (ENV / KEY_FILE / DERIVED / GENERATED). */
export function getProVaultSource() {
  try {
    secretKey();
    return lastSource;
  } catch (err) {
    return err?.code || 'UNKNOWN';
  }
}

function secretKey() {
  const explicit = String(process.env.PRO_VAULT_KEY || process.env.VAULT_ENCRYPTION_KEY || '').trim();
  if (Buffer.byteLength(explicit) >= 16) {
    lastSource = 'ENV';
    return keyFromSecret(explicit);
  }

  const fromFile = readKeyFile();
  if (fromFile) {
    lastSource = 'KEY_FILE';
    return keyFromSecret(fromFile);
  }

  // Server ke apne secrets se deterministic key — redeploy ke baad bhi wahi,
  // isliye ephemeral disk par bhi purana data khulta rehta hai.
  const derived = derivedSecret();
  if (derived) {
    lastSource = 'DERIVED';
    // File nahi likhte: derived key har boot par khud banti hai (BOT_TOKEN se),
    // isliye disk read-only ho ya na ho, key wahi rehti hai.
    console.log('[MiniAppVault] PRO_VAULT_KEY set nahi hai — bot ke server secrets se stable key derive ki gayi (source=DERIVED).');
    return keyFromSecret(derived);
  }

  // Kuch bhi available nahi — nayi random key banao aur disk par rakh do.
  const generated = crypto.randomBytes(32).toString('hex');
  lastSource = 'GENERATED';
  writeKeyFile(generated);
  console.warn('[MiniAppVault] Koi server secret nahi mila — nayi random vault key banayi (source=GENERATED).');
  return keyFromSecret(generated);
}

function workspacePath(userId) {
  if (!/^\d{1,20}$/.test(String(userId))) throw new Error('Invalid Telegram user');
  const fileName = crypto.createHash('sha256').update(String(userId)).digest('hex') + '.json';
  return path.join(getDataDir(), 'pro-workspaces', fileName);
}

function aad(userId) {
  return Buffer.from(`sacha-beta-miniapp-v1:${userId}`);
}

// Encrypt chat handoff links before storing them in the bot database. The
// Telegram user id is authenticated data, so blobs cannot be moved between
// users. The same vault key and rotation rules as the workspace apply.
export function sealProHandoff(userId, links) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  cipher.setAAD(Buffer.from(`pro-chat-handoff:v1:${String(userId)}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(links), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
export function openProHandoff(userId, envelope) {
  try {
    if (!envelope || envelope.version !== 1) throw new Error('Invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(`pro-chat-handoff:v1:${String(userId)}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid links');
    return value;
  } catch {
    const err = new Error('Mini App links khol nahi sake. Existing data nahi badla; admin se baat karein.');
    err.statusCode = 503; err.code = 'PRO_VAULT_DECRYPT_FAILED';
    throw err;
  }
}

export function emptyProWorkspace() {
  return { version: 1, accounts: {}, activeAccountKey: '', selectedAddress: null, addressCandidates: [], cart: null };
}

export function readProWorkspace(userId) {
  const key = secretKey();
  const file = workspacePath(userId);
  if (!fs.existsSync(file)) return emptyProWorkspace();
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (envelope.version !== 1) throw new Error('Unsupported workspace version');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const value = JSON.parse(plain.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace');
    return { ...emptyProWorkspace(), ...value, accounts: value.accounts || {} };
  } catch {
    const err = new Error('Unable to decrypt the Mini App workspace. Check the configured vault key; existing data was not changed.');
    err.statusCode = 503;
    err.code = 'PRO_VAULT_DECRYPT_FAILED';
    throw err;
  }
}

export function writeProWorkspace(userId, workspace) {
  const key = secretKey();
  const file = workspacePath(userId);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(userId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(workspace), 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    // Checkout state must survive a restart before a placement POST begins.
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, envelope);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    const parentFd = fs.openSync(path.dirname(dir), 'r');
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    // Do jagah backup: (1) encrypted mirror bot ke db.json me — token ki
    // zaroorat nahi, ephemeral disk par bhi bachta hai jab bot ka db bachta
    // hai; (2) cloud vault (jab token/git available ho).
    scheduleProWorkspaceMirror(userId, envelope);
    scheduleProWorkspaceBackup(userId);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── DURABLE BACKUP (boss 31-10-2026) ──────────────────────────────────────
// "JAISE ME KOI CHEEZ UPDATE KARU TO SAARA USER KA DATA RESET NA HOJAYE, BAAKI
// RAHE UNKE PHONES ME." Render ka disk redeploy par khali ho sakta hai. Isliye
// har workspace ka ENCRYPTED blob cloud vault me bhi jata hai aur naye disk par
// pehli read se pehle wapas aata hai. Key wahi rehti hai (env/derived/key file),
// isliye blob wapas aane par data waisa hi khulta hai.
const hydratedUsers = new Set();
const backupTimers = new Map();
const mirrorTimers = new Map();
const pendingMirrorEnvelopes = new Map();

/**
 * Boss (31-10-2026): "TU BAAR BAAR KEHTA HAI DATA SAFE HAI BUT DATA TO ERASE
 * HOJATA." Ab backup ka sach do jagah dikhta hai:
 *   • `dbMirror` — encrypted blob bot ke `db.json` me (koi token nahi chahiye).
 *   • `cloud`    — `bot-vault` branch (GITHUB_VAULT_TOKEN ya git creds hone par).
 * Dono ki asli haalat `/pro/api/backup` aur bootstrap ke `backup` field me aati
 * hai; fail hone par error chhupta nahi.
 */
export const proBackupState = {
  cloud: { enabled: true, lastOkAt: '', lastError: '', pushed: 0, blocked: null },
  mirror: { lastAt: '', rows: 0, wrote: 0 },
  restored: { count: 0, lastAt: '', lastFrom: '' }
};

export function cloudBackupEnabled() {
  return process.env.PRO_VAULT_CLOUD_BACKUP !== '0';
}

// getDb() har call par file se fresh object deta hai — isliye likhne ke liye
// wahi object pakadna padta hai (warna mirror chup-chaap gayab ho jata hai).
function mirrorOn(db) {
  if (!db.config) db.config = {};
  if (!db.config.proWorkspaceMirror || typeof db.config.proWorkspaceMirror !== 'object' || Array.isArray(db.config.proWorkspaceMirror)) {
    db.config.proWorkspaceMirror = {};
  }
  return db.config.proWorkspaceMirror;
}
function mirrorRows() {
  try { return getDb().config?.proWorkspaceMirror || {}; } catch { return {}; }
}

function mirrorRowKey(userId) {
  return crypto.createHash('sha256').update(`mirror:${userId}`).digest('hex');
}

/** Encrypted workspace ko bot ke db me rakh do — token ki zaroorat nahi. */
export function writeProWorkspaceMirror(userId, envelope) {
  try {
    const db = getDb();
    const bucket = mirrorOn(db);
    const rowKey = mirrorRowKey(userId);
    // Round 24: khaali workspace kabhi bhare hue mirror ko overwrite na kare.
    try {
      const incoming = openEnvelope(envelope, String(userId));
      const existing = openEnvelope(bucket[rowKey]?.envelope, String(userId));
      if (incoming !== null && existing && workspaceHasContent(existing) && !workspaceHasContent(incoming)) {
        proBackupState.cloud.blocked = {
          at: new Date().toISOString(), reason: 'LOCAL_WORKSPACE_EMPTY', where: 'db-mirror',
          line: 'Khaali workspace se purana mirror data nahi mitaya (round 24).'
        };
        return false;
      }
    } catch { /* guard best-effort */ }
    bucket[rowKey] = {
      v: 1, userId: String(userId), savedAt: new Date().toISOString(),
      checksum: crypto.createHash('sha256').update(String(envelope)).digest('hex').slice(0, 32),
      envelope: String(envelope)
    };
    // Bahut zyada rows na hon — purane (sabse chhote savedAt) hata do.
    const keys = Object.keys(bucket);
    if (keys.length > 300) {
      keys.sort((a, b) => String(bucket[a]?.savedAt || '').localeCompare(String(bucket[b]?.savedAt || '')));
      for (const stale of keys.slice(300)) delete bucket[stale];
    }
    const saved = saveDb(db);
    proBackupState.mirror.lastAt = new Date().toISOString();
    proBackupState.mirror.wrote += 1;
    proBackupState.mirror.rows = Object.keys(bucket).length;
    // saveDb false bhi de sakta hai (read-only disk) — jhooth nahi bolte.
    return saved !== false;
  } catch (err) {
    console.warn('[MiniAppVault] db mirror save fail:', err?.message || err);
    return false;
  }
}

function readProWorkspaceMirror(userId) {
  try {
    const row = mirrorRows()[mirrorRowKey(userId)];
    if (!row?.envelope) return null;
    const sum = crypto.createHash('sha256').update(String(row.envelope)).digest('hex').slice(0, 32);
    if (row.checksum && row.checksum !== sum) return null;
    return { envelope: String(row.envelope), savedAt: row.savedAt || '' };
  } catch { return null; }
}

function scheduleProWorkspaceMirror(userId, envelope) {
  const key = String(userId);
  // Several wizard steps can finish inside the debounce window. Mirror the
  // newest envelope, not the first (which may still contain an older draft).
  pendingMirrorEnvelopes.set(key, envelope);
  if (mirrorTimers.has(key)) return;
  const timer = setTimeout(() => {
    mirrorTimers.delete(key);
    const latest = pendingMirrorEnvelopes.get(key);
    pendingMirrorEnvelopes.delete(key);
    if (latest) writeProWorkspaceMirror(key, latest);
  }, 1500);
  if (typeof timer.unref === 'function') timer.unref();
  mirrorTimers.set(key, timer);
}

/**
 * Round 24 (boss: "TAAKI KOI DATA ERASE NA HO"):
 * Ek workspace khaali (accounts/cart/address kuch nahi) ho par cloud/db-mirror par
 * usi user ka bhara hua workspace pada ho, to us khaali blob se purana data
 * mitana bilkul galat hoga. Isliye push se pehle check.
 */
export function workspaceHasContent(workspace) {
  if (!workspace || typeof workspace !== 'object') return false;
  const accounts = workspace.accounts && typeof workspace.accounts === 'object' ? Object.keys(workspace.accounts).length : 0;
  const addresses = Array.isArray(workspace.addressCandidates) ? workspace.addressCandidates.length : 0;
  const orders = Array.isArray(workspace.orders) ? workspace.orders.length : 0;
  return accounts > 0 || addresses > 0 || orders > 0
    || Boolean(workspace.cart) || Boolean(workspace.selectedAddress) || Boolean(workspace.pendingAddress)
    || Boolean(workspace.activeAccountKey) || Boolean(workspace.chatFlow) || Boolean(workspace.checkout)
    || (Array.isArray(workspace.handoffDraftBackups) && workspace.handoffDraftBackups.length > 0);
}

/** Encrypted envelope kholo — fail ho to null (kabhi throw nahi). */
function openEnvelope(envelopeText, userId) {
  try {
    const envelope = JSON.parse(String(envelopeText || ''));
    if (envelope.version !== 1) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad(String(userId)));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const value = JSON.parse(plain.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * Push safe hai? Local khaali ho aur kahin bhi purana bhara hua workspace pada ho
 * to push ROK do (naya data nahi mitega).
 */
export async function guardWorkspacePush(userId, envelopeText) {
  const key = String(userId);
  const local = openEnvelope(envelopeText, key);
  if (local === null) return { allow: true, reason: 'local-unreadable' };
  if (workspaceHasContent(local)) return { allow: true, reason: '' };
  const older = [];
  if (cloudBackupEnabled()) {
    try {
      const pulled = await pullVaultTextFile(proWorkspaceVaultPath(path.basename(workspacePath(key))));
      const opened = openEnvelope(pulled, key);
      if (opened && workspaceHasContent(opened)) older.push('cloud');
    } catch { /* network — mirror check neeche */ }
  }
  try {
    const mirrored = readProWorkspaceMirror(key);
    const opened = openEnvelope(mirrored?.envelope, key);
    if (opened && workspaceHasContent(opened)) older.push('db-mirror');
  } catch {}
  if (older.length === 0) return { allow: true, reason: '' };
  const line = `Local workspace khaali hai par ${older.join(' + ')} par purana bhara hua data pada hai — push ROK diya, purana data mitega nahi.`;
  proBackupState.cloud.blocked = { at: new Date().toISOString(), reason: 'LOCAL_WORKSPACE_EMPTY', where: older.join(','), line };
  return { allow: false, reason: 'LOCAL_WORKSPACE_EMPTY', line, where: older.join(',') };
}

/** Boss ke "Abhi backup karein" button ke liye — turant, debounce ke bina. */
export async function backupProWorkspaceNow(userId) {
  const key = String(userId);
  const file = workspacePath(key);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Is user ka workspace file server par nahi hai.'), { statusCode: 404 });
  const envelope = fs.readFileSync(file, 'utf8');
  // Round 24: pehle guard — khaali workspace se purana data (mirror/cloud) na mite.
  const guard = cloudBackupEnabled() ? await guardWorkspacePush(key, envelope) : { allow: true };
  if (!guard.allow) {
    proBackupState.cloud.lastError = guard.line;
    return { mirrored: false, cloud: { ok: false, skipped: true, blocked: guard.reason, reason: guard.line } };
  }
  const mirrored = writeProWorkspaceMirror(key, envelope);
  let cloud = { ok: false, skipped: true };
  if (cloudBackupEnabled()) {
    try {
      await pushVaultTextFile(proWorkspaceVaultPath(path.basename(file)), envelope);
      proBackupState.cloud.lastOkAt = new Date().toISOString();
      proBackupState.cloud.lastError = '';
      proBackupState.cloud.pushed += 1;
      cloud = { ok: true, skipped: false };
    } catch (err) {
      proBackupState.cloud.lastError = String(err?.message || err).slice(0, 300);
      cloud = { ok: false, skipped: false, error: proBackupState.cloud.lastError };
    }
  }
  return { mirrored, cloud };
}


/**
 * Boss (31-10-2026, round 22): "data bachta nahi" ka ek aur asli kaaran —
 * vault key badal jaye to purane workspace khulte hi nahi. Ye function har
 * encrypted workspace ko sach me kholne ki koshish karta hai aur batata hai
 * kitne khul rahe hain, kitne nahi. (Key badli to data safe hai par unreadable
 * — ye sach UI me dikhna chahiye, "sab theek" ka jhooth nahi.)
 */
export function proWorkspaceKeyHealth() {
  let ok = 0;
  let failed = 0;
  let rows = [];
  try { rows = Object.values(mirrorRows()); } catch { rows = []; }
  const key = secretKey();
  for (const row of rows) {
    try {
      const envelope = JSON.parse(String(row?.envelope || ''));
      if (envelope.version !== 1) throw new Error('version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(aad(String(row.userId)));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      ok += 1;
    } catch { failed += 1; }
  }
  return { ok, failed, total: rows.length, keySource: getProVaultSource() };
}

export function proBackupStatus() {
  let rows = 0;
  try { rows = Object.keys(mirrorRows()).length; } catch {}
  return {
    cloud: {
      enabled: cloudBackupEnabled(),
      lastOkAt: proBackupState.cloud.lastOkAt,
      lastError: proBackupState.cloud.lastError
    },
    dbMirror: { enabled: true, rows, lastAt: proBackupState.mirror.lastAt },
    blockedPush: proBackupState.cloud.blocked,
    restored: { ...proBackupState.restored },
    vaultSource: getProVaultSource()
  };
}

function scheduleProWorkspaceBackup(userId) {
  if (!cloudBackupEnabled()) return;
  const key = String(userId);
  if (backupTimers.has(key)) return;
  const timer = setTimeout(async () => {
    backupTimers.delete(key);
    try {
      const file = workspacePath(key);
      if (!fs.existsSync(file)) return;
      const envelope = fs.readFileSync(file, 'utf8');
      const guard = await guardWorkspacePush(key, envelope);
      if (!guard.allow) {
        proBackupState.cloud.lastError = guard.line;
        return;
      }
      await pushVaultTextFile(proWorkspaceVaultPath(path.basename(file)), envelope);
      proBackupState.cloud.lastOkAt = new Date().toISOString();
      proBackupState.cloud.lastError = '';
      proBackupState.cloud.pushed += 1;
    } catch (err) {
      // Boss: chup-chaap fail nahi — asli wajah rakho.
      proBackupState.cloud.lastError = String(err?.message || err).slice(0, 300);
    }
  }, 6000);
  if (typeof timer.unref === 'function') timer.unref();
  backupTimers.set(key, timer);
}

/**
 * Naye/khali disk par (redeploy ke baad) encrypted workspace wapas laata hai.
 * Sirf tab likhta hai jab local file bilkul nahi hai — chalta hua data kabhi
 * overwrite nahi hota.
 */
function validEnvelopeText(text) {
  const value = String(text || '');
  if (!value.trim().startsWith('{') || value.length > 2_000_000) return false;
  try { JSON.parse(value); return true; } catch { return false; }
}

export async function ensureProWorkspaceHydrated(userId) {
  const key = String(userId);
  if (hydratedUsers.has(key)) return false;
  hydratedUsers.add(key);
  const file = workspacePath(key);
  try {
    if (fs.existsSync(file)) return false;
  } catch { return false; }

  let text = '';
  let from = '';
  // 1) Cloud vault (jab token/git available ho).
  if (cloudBackupEnabled()) {
    try {
      const pulled = await pullVaultTextFile(proWorkspaceVaultPath(path.basename(file)));
      if (validEnvelopeText(pulled)) { text = pulled; from = 'cloud'; }
    } catch (err) {
      proBackupState.cloud.lastError = String(err?.message || err).slice(0, 300);
    }
  }
  // 2) Bot ke db.json ka encrypted mirror — token ke bina bhi chalta hai.
  if (!from) {
    const mirrored = readProWorkspaceMirror(key);
    if (mirrored && validEnvelopeText(mirrored.envelope)) { text = mirrored.envelope; from = 'db-mirror'; }
  }
  if (!from) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.restore.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    proBackupState.restored = { count: proBackupState.restored.count + 1, lastAt: new Date().toISOString(), lastFrom: from };
    console.log(`[MiniAppVault] workspace ${from} se wapas aaya (redeploy recovery).`);
    return true;
  } catch (err) {
    console.warn('[MiniAppVault] restore fail:', err?.message || err);
    return false;
  }
}

/** Tests ke liye. */
export function resetProWorkspaceHydrationCache() {
  proBackupState.cloud.blocked = null;
  hydratedUsers.clear();
  for (const timer of backupTimers.values()) clearTimeout(timer);
  backupTimers.clear();
  for (const timer of mirrorTimers.values()) clearTimeout(timer);
  mirrorTimers.clear();
  pendingMirrorEnvelopes.clear();
}

/** Tests ke liye — mirror timers ko turant chalane ki ummeed nahi karte. */
export function flushProWorkspaceMirror(userId, envelope) {
  return writeProWorkspaceMirror(userId, envelope);
}

const locks = new Map();
// Serialize complete requests for a user, including asynchronous provider calls.
// This prevents two tabs from losing each other's changes in one Node process.
export async function withProWorkspaceLock(userId, task) {
  const key = String(userId);
  const previous = locks.get(key) || Promise.resolve();
  let unlock;
  const current = new Promise((resolve) => { unlock = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    unlock();
    if (locks.get(key) === current) locks.delete(key);
  }
}
