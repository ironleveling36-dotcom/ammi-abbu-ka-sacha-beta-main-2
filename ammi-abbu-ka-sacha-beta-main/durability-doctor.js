/**
 * Boss (31-10-2026, round 26):
 *   "PHIR DEPLOY HOTE HI SAB ERASE HOGAYA"
 *
 * Poora system backup/restore par chalta hai, par jab wo chalta hi nahi to aaj
 * tak kisi ne jhootha "safe hai" bola hoga. Ye module **sach me check karta
 * hai** — ek ek kadam, live:
 *
 *   1. disk kahan hai, likha ja sakta hai, aur ephemeral hai ya nahi
 *   2. env: PRO_VAULT_CLOUD_BACKUP, GITHUB_VAULT_TOKEN, VAULT_ENCRYPTION_KEY
 *   3. GitHub token kaam karta hai? repo dikhta hai?
 *   4. `bot-vault` branch hai?
 *   5. login-ID snapshot: vault me hai? kitna bada? is key se khulta hai? kitni ID
 *   6. paisa snapshot: wahi cheez (wallet/UTR)
 *   7. **write test**: ek chhota heartbeat vault me push karke wapas padho —
 *      agar token read-only hai ya write permission nahi, yahin pakda jayega
 *
 * Iska jawab boss panel me ✅/❌ rows aur ek seedhi line me aata hai. Koi guess
 * nahi, koi "lagta hai theek hai" nahi.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDbFile } from './store.js';
import {
  vaultTarget, vaultTokenFingerprint, pullVaultTextFileDetailed, pushVaultTextFile,
  decryptVaultPayloadText, encryptVaultPayloadObject
} from './vault-sync.js';

const IDENTITY_PATH = 'vault/db-identity-snapshot.json';
const MONEY_PATH = 'vault/db-money-snapshot.json';
const HEARTBEAT_PATH = 'vault/doctor-heartbeat.json';

function safeCounts(kind, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { line: 'khula nahi', empty: true };
  if (kind === 'identity') {
    const accounts = Object.keys(snapshot.accounts || {}).length;
    const workspaces = Object.keys(snapshot.workspaces || {}).length;
    const vault = Object.keys(snapshot.sessionVault || {}).length;
    return {
      accounts, workspaces, sessionVault: vault, empty: accounts + workspaces + vault === 0,
      line: `${accounts} login ID · ${workspaces} workspace${vault ? ` · ${vault} purane session` : ''}`
    };
  }
  const sections = snapshot.sections || {};
  const wallets = Object.keys(sections.wallets || {}).length;
  const utrs = Object.keys(sections.usedUtrs || {}).length;
  const balancePaise = Object.values(sections.wallets || {}).reduce((sum, w) => sum + Math.max(0, Number(w?.balancePaise) || 0), 0);
  return {
    wallets, utrs, balancePaise, empty: wallets + utrs === 0,
    line: `${wallets} wallet · ${utrs} UTR${balancePaise ? ` · ₹${(balancePaise / 100).toFixed(2)}` : ''}`
  };
}

/** Vault file ka andar ka snapshot — failure par asli wajah ke saath. */
function openVaultFile(text, kind) {
  if (!text) return { snapshot: null, reason: 'file khaali / nahi mili' };
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { return { snapshot: null, reason: `JSON nahi hai (${err.message})` }; }
  let payload = parsed?.payload ?? parsed;
  // Hamara push shape: `{__xSnapshot, at, payload: "<encrypted JSON string>"}`.
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return { snapshot: null, reason: 'payload JSON nahi hai' }; }
  }
  if (payload && typeof payload === 'object' && payload.__vaultEnc) {
    const inner = decryptVaultPayloadText(JSON.stringify(payload));
    if (!inner) return { snapshot: null, reason: 'is key se khul nahi raha (VAULT_ENCRYPTION_KEY badli lagti hai)' };
    payload = inner;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return { snapshot: null, reason: 'decrypt ke baad JSON nahi' }; } }
  }
  if (!payload || typeof payload !== 'object') return { snapshot: null, reason: 'snapshot object nahi' };
  const looks = kind === 'identity' ? (payload.accounts || payload.workspaces) : payload.sections;
  if (!looks) return { snapshot: null, reason: 'snapshot ka shape alag hai' };
  return { snapshot: payload, reason: '' };
}

/**
 * Poora doctor. Har step ka asli jawab; kuch bhi guess nahi.
 * @param {{fetchImpl?:Function, now?:number, skipWriteTest?:boolean}} options
 */
export async function runDurabilityDoctor({ fetchImpl = globalThis.fetch, now = Date.now(), skipWriteTest = false } = {}) {
  const steps = [];
  const add = (key, label, ok, detail, need = '') => steps.push({ key, label, ok: Boolean(ok), detail: String(detail || ''), need: String(need || '') });

  // 1. disk
  let dataDir = '';
  let diskWritable = false;
  let diskError = '';
  try {
    dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.doctor-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    diskWritable = true;
  } catch (err) { diskError = String(err?.message || err).slice(0, 120); }
  const looksEphemeral = !/^\/app\/data|^\/data\b|^\/var\/data/.test(dataDir) && process.env.NODE_ENV === 'production';
  add('disk', 'Server disk (data folder)', diskWritable,
    diskWritable ? `${dataDir} — likha ja sakta hai${looksEphemeral ? ' (dhyaan: ye path persistent disk jaisa nahi lagta — deploy par khali ho sakta hai)' : ''}` : (diskError || 'likha nahi ja saka'),
    diskWritable ? '' : 'Render me disk/permission theek karein');

  // 2. env
  const cloudDisabled = process.env.PRO_VAULT_CLOUD_BACKUP === '0';
  const token = vaultTokenFingerprint();
  const target = vaultTarget();
  const keySet = target.encrypted;
  add('cloud', 'Cloud backup switch', !cloudDisabled,
    cloudDisabled ? 'PRO_VAULT_CLOUD_BACKUP=0 — cloud backup band hai' : 'chalu hai', cloudDisabled ? 'PRO_VAULT_CLOUD_BACKUP hata dein' : '');
  add('token', 'GITHUB_VAULT_TOKEN', token.present,
    token.present ? `set hai (fingerprint ${token.fingerprint}, ${token.length} chars)` : 'set nahi hai — cloud vault kaam nahi karega',
    token.present ? '' : 'Render env me GITHUB_VAULT_TOKEN daalein');
  add('key', 'VAULT_ENCRYPTION_KEY', keySet,
    keySet ? 'set hai — snapshot isi key se khulta hai' : 'set nahi hai — vault plaintext/khula nahi hoga',
    keySet ? '' : 'Render env me VAULT_ENCRYPTION_KEY daalein (aur kabhi na badlein)');

  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, body });
  const api = async (url, options = {}) => {
    try {
      const res = await fetchImpl(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_VAULT_TOKEN || ''}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sacha-beta-doctor/1.0',
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json().catch(() => null);
      return json(body, res.status);
    } catch (err) { return { ok: false, status: 0, body: { message: String(err?.message || err) } }; }
  };

  // 3. repo access
  if (token.present) {
    const repo = await api(`https://api.github.com/repos/${target.owner}/${target.repo}`);
    add('repo', 'GitHub repo access', repo.ok,
      repo.ok ? `${target.owner}/${target.repo} — token chal raha hai` : `${repo.body?.message || 'access nahi'} (HTTP ${repo.status})`,
      repo.ok ? '' : 'Token ko repo (contents read/write) ka access dein');
    const ref = await api(`https://api.github.com/repos/${target.owner}/${target.repo}/git/ref/heads/${target.branch}`);
    add('branch', `Vault branch (${target.branch})`, ref.ok,
      ref.ok ? 'branch maujood hai' : `${ref.body?.message || 'nahi mili'} (HTTP ${ref.status})`,
      ref.ok ? '' : 'Pehla backup karne par branch khud ban jayegi');
  } else {
    add('repo', 'GitHub repo access', false, 'token nahi hai — check nahi ho saka', 'GITHUB_VAULT_TOKEN daalein');
    add('branch', `Vault branch (${target.branch})`, false, 'token nahi hai — check nahi ho saka', 'GITHUB_VAULT_TOKEN daalein');
  }

  // 4. snapshot files
  const readOne = async (filePath, kind) => {
    const detail = await pullVaultTextFileDetailed(filePath);
    if (!detail.text) {
      return { ok: false, detail: detail.reason || 'file nahi mili', counts: null, via: '' };
    }
    const opened = openVaultFile(detail.text, kind);
    if (!opened.snapshot) return { ok: false, detail: opened.reason, counts: null, via: detail.via || '' };
    const counts = safeCounts(kind, opened.snapshot);
    return { ok: !counts.empty, detail: counts.line || 'khaali snapshot', counts, via: detail.via || '', size: detail.size };
  };
  const identity = await readOne(IDENTITY_PATH, 'identity');
  add('identity', 'Login IDs ka vault backup', identity.ok, identity.detail, identity.ok ? '' : 'Backup abhi tak nahi hua / khul nahi raha');
  const money = await readOne(MONEY_PATH, 'money');
  add('money', 'Paisa + UTR ka vault backup', money.ok, money.detail, money.ok ? '' : 'Backup abhi tak nahi hua / khul nahi raha');

  // 5. write test — yahin pata chalta hai token read-only hai ya nahi
  let writeOk = false;
  let writeDetail = 'skip kiya gaya';
  if (!skipWriteTest && token.present && !cloudDisabled) {
    const stamp = { at: new Date(now).toISOString(), pid: process.pid, note: 'doctor heartbeat' };
    const text = JSON.stringify({ __doctorHeartbeat: true, payload: encryptVaultPayloadObject(stamp) });
    const pushed = await pushVaultTextFile(HEARTBEAT_PATH, text, 'chore(vault): durability doctor heartbeat');
    writeOk = pushed?.ok === true;
    if (writeOk) {
      const back = await pullVaultTextFileDetailed(HEARTBEAT_PATH);
      writeOk = Boolean(back.text);
      writeDetail = writeOk ? 'vault me likha aur wapas padha gaya — backup sach me chalta hai' : 'push hua par wapas padha nahi ja saka';
    } else {
      writeDetail = pushed?.reason || pushed?.error || `push fail (HTTP ${pushed?.status || '?'})`;
    }
  } else if (skipWriteTest) {
    writeDetail = 'skip (test mode)';
  } else if (!token.present) {
    writeDetail = 'token nahi — push nahi ho sakta';
  } else if (cloudDisabled) {
    writeDetail = 'cloud backup band hai';
  }
  add('write', 'Vault me likhne ka test', writeOk, writeDetail, writeOk ? '' : 'Token ko contents **write** permission dein (fine-grained PAT me ye alag hota hai)');

  const canReadBackup = identity.ok || money.ok;
  const verdictLine = !diskWritable
    ? 'Server disk par likha nahi ja raha — pehle ye theek karein.'
    : cloudDisabled
      ? 'Cloud backup band hai (PRO_VAULT_CLOUD_BACKUP=0) — deploy par data ja sakta hai.'
      : !token.present
        ? 'GITHUB_VAULT_TOKEN nahi hai — deploy par data wapas nahi aayega.'
        : !writeOk
          ? `Cloud me likha nahi ja raha (${writeDetail}) — isliye deploy par data erase ho sakta hai.`
          : canReadBackup
            ? `Backup chalu hai. Vault me: ${identity.detail} · ${money.detail}.`
            : 'Vault khali hai (abhi tak koi backup nahi gaya) — ek baar "Abhi backup karein" dabayein.';

  const dbFile = (() => { try { return getDbFile(); } catch { return ''; } })();
  return {
    ok: steps.every((step) => step.ok || ['identity', 'money'].includes(step.key)),
    at: new Date(now).toISOString(),
    target: { owner: target.owner, repo: target.repo, branch: target.branch },
    dataDir,
    looksEphemeral,
    dbFileExists: Boolean(dbFile && fs.existsSync(dbFile)),
    tokenFingerprint: token.fingerprint,
    keySet,
    canBackup: writeOk,
    canRestore: canReadBackup,
    identity: identity.counts,
    money: money.counts,
    steps,
    failed: steps.filter((s) => !s.ok).map((s) => s.key),
    verdictLine,
    // Boss ke liye seedha jawab: ab kya karna hai.
    nextStep: steps.filter((s) => !s.ok && s.need).map((s) => s.need)
  };
}
