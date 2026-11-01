/**
 * Boss (31-10-2026, round 19):
 *   "SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"
 *
 * Ye bilkul sahi diagnosis hai — Render par `/app/data` disk attach na ho to
 * har deploy par `db.json` naya ban jata hai: wallet, UTR ledger, top-up claims,
 * sab ud jaate hain. Paisa aur UTR ki yaad **deploy se zyada zinda** honi chahiye.
 *
 * Ye module pure hai — snapshot banao, merge karo, aur batao ki restore chahiye
 * ya nahi. Network (cloud vault) `db-durability.js` me hai.
 */

export const MONEY_SNAPSHOT_VERSION = 2;

/** db ki wo sections jo paise/UTR ka sach rakhte hain. */
export const MONEY_SECTIONS = ['wallets', 'topupRequests', 'topupClaims', 'topupIntents', 'usedUtrs'];

/** config me sirf paise wali settings (accounts/vault ka sach alag jagah hai). */
const MONEY_CONFIG_KEYS = ['walletUpiId', 'bossUpiId', 'serviceFeePaise', 'walletAutoCreditMaxPaise'];

function plain(value) {
  try { return JSON.parse(JSON.stringify(value ?? {})); } catch { return {}; }
}

/** Snapshot: sirf paisa/UTR ka sach — bhaari orders/accounts nahi. */
export function buildMoneySnapshot(db, { at = Date.now() } = {}) {
  const config = db?.config || {};
  const sections = {};
  for (const key of MONEY_SECTIONS) sections[key] = plain(config[key]);
  const moneyConfig = {};
  for (const key of MONEY_CONFIG_KEYS) if (config[key] !== undefined) moneyConfig[key] = config[key];
  const counts = Object.fromEntries(MONEY_SECTIONS.map((key) => [key, Object.keys(sections[key]).length]));
  return {
    version: MONEY_SNAPSHOT_VERSION,
    at: new Date(at).toISOString(),
    config: moneyConfig,
    sections,
    counts
  };
}

/** Snapshot me paisa/UTR ka kuch hai bhi? (khaali snapshot push karne ka matlab nahi) */
export function snapshotHasData(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const sections = snapshot.sections || {};
  return ['wallets', 'topupRequests', 'topupClaims', 'topupIntents', 'usedUtrs']
    .some((key) => sections[key] && Object.keys(sections[key]).length > 0);
}

/** DB fresh lag raha hai (deploy ke baad jaisa) — restore karna chahiye? */
export function needsMoneyRestore(db, snapshot) {
  if (!snapshotHasData(snapshot)) return false;
  const config = db?.config || {};
  const fresh = ['wallets', 'topupRequests', 'usedUtrs'].every((key) => !config[key] || Object.keys(config[key]).length === 0);
  return fresh;
}

// Ledger IDs are generated at mutation time; timestamps and larger balances do
// not prove which copy is newer. The capped ledger may lose an old prefix, so
// a later copy must contain a contiguous suffix of the older history.
function ledgerEntryKey(entry) {
  return JSON.stringify([
    String(entry?.id || ''), String(entry?.at || ''), String(entry?.type || ''),
    Number(entry?.amountPaise || 0), Number(entry?.balanceAfterPaise || 0),
    String(entry?.meta?.utr || ''), String(entry?.meta?.topupId || ''), String(entry?.meta?.orderId || '')
  ]);
}
function walletHistory(wallet) {
  const ledger = Array.isArray(wallet?.ledger) ? wallet.ledger : [];
  const balance = Number(wallet?.balancePaise || 0);
  if (!Number.isSafeInteger(balance) || balance < 0) return null;
  if (ledger.some((entry) => !entry?.id)) return null;
  if (new Set(ledger.map((entry) => String(entry.id))).size !== ledger.length) return null;
  if (ledger.length && Number(ledger[ledger.length - 1].balanceAfterPaise) !== balance) return null;
  return { ledger, balance };
}
function isLedgerExtension(older, newer) {
  if (!older.length || !newer.length) return false;
  const lastId = String(older[older.length - 1].id);
  const index = newer.findIndex((entry) => String(entry.id) === lastId);
  if (index < 0 || index >= newer.length - 1 || index + 1 > older.length) return false;
  const tail = older.slice(older.length - index - 1);
  return tail.every((entry, i) => ledgerEntryKey(entry) === ledgerEntryKey(newer[i]));
}
function compareWalletHistory(local, snapshot) {
  const l = walletHistory(local), s = walletHistory(snapshot);
  if (!l || !s) return 'conflict';
  if (!l.ledger.length && !s.ledger.length) {
    return l.balance === s.balance && Boolean(local.feeExempt) === Boolean(snapshot.feeExempt) ? 'same' : 'conflict';
  }
  const lLast = l.ledger.at(-1), sLast = s.ledger.at(-1);
  if (lLast && sLast && String(lLast.id) === String(sLast.id)) {
    const overlap = Math.min(l.ledger.length, s.ledger.length);
    const sameTail = l.ledger.slice(-overlap).every((entry, i) => ledgerEntryKey(entry) === ledgerEntryKey(s.ledger.slice(-overlap)[i]));
    return sameTail && l.balance === s.balance &&
      Boolean(local.feeExempt) === Boolean(snapshot.feeExempt) ? 'same' : 'conflict';
  }
  if (isLedgerExtension(s.ledger, l.ledger)) return 'local-newer';
  if (isLedgerExtension(l.ledger, s.ledger)) return 'snapshot-newer';
  return 'conflict';
}

/** Merge only histories that can be ordered. Divergence returns conflicts
 * before ANY mutation so neither local nor remote money can be overwritten. */
export function mergeMoneySnapshot(db, snapshot, { at = Date.now() } = {}) {
  const summary = { wallets: 0, walletsKeptHigher: 0, topupRequests: 0, topupClaims: 0, topupIntents: 0, usedUtrs: 0, config: 0 };
  if (!snapshot || typeof snapshot !== 'object') return { changed: false, summary, conflicts: [] };
  const localConfig = db?.config || {};
  const snapSections = snapshot.sections || {};
  const conflicts = [];
  const walletOrder = new Map();
  for (const [id, remote] of Object.entries(snapSections.wallets || {})) {
    const local = localConfig.wallets?.[id];
    if (!local || !remote || typeof remote !== 'object') continue;
    const order = compareWalletHistory(local, remote);
    walletOrder.set(id, order);
    if (order === 'conflict') conflicts.push({ section: 'wallets', id });
  }
  for (const key of ['topupRequests', 'topupClaims', 'topupIntents', 'usedUtrs']) {
    for (const [id, remote] of Object.entries(snapSections[key] || {})) {
      const local = localConfig[key]?.[id];
      if (!local || !remote || typeof remote !== 'object') continue;
      const different = (field) => local[field] != null && local[field] !== '' && remote[field] != null && remote[field] !== '' && String(local[field]) !== String(remote[field]);
      let conflict = different('userId') || different('utr');
      if (key === 'usedUtrs' && String(local.status || '').toUpperCase() === 'CREDITED' &&
          String(remote.status || '').toUpperCase() === 'CREDITED') conflict ||= different('amountPaise');
      if (key === 'topupRequests' || key === 'topupClaims') {
        conflict ||= different('claimedPaise');
        const a = String(local.status || '').toUpperCase(), b = String(remote.status || '').toUpperCase();
        const terminal = (value) => ['APPROVED', 'AUTO_VERIFIED', 'REJECTED'].includes(value);
        if (terminal(a) && terminal(b)) {
          const approved = (value) => value === 'APPROVED' || value === 'AUTO_VERIFIED';
          conflict ||= approved(a) !== approved(b) || (approved(a) && different('approvedPaise'));
        }
      }
      if (key === 'topupIntents' && local.usedAt && remote.usedAt) conflict ||= different('requestId');
      if (conflict) conflicts.push({ section: key, id });
    }
  }
  if (conflicts.length) return { changed: false, summary, conflicts };
  if (!db.config) db.config = {};
  let changed = false;

  // config (paise wali settings) — local na ho to snapshot se.
  for (const [key, value] of Object.entries(snapshot.config || {})) {
    // Khaali value wapas likhne ka koi matlab nahi — warna har boot par
    // "restore hua" jhootha dikhta (aur `changed` hamesha true rehta).
    if (value === undefined || value === null || value === '') continue;
    if (db.config[key] === undefined || db.config[key] === '' || db.config[key] === null) {
      db.config[key] = value;
      summary.config += 1;
      changed = true;
    }
  }

  if (!db.config.wallets || typeof db.config.wallets !== 'object') db.config.wallets = {};
  for (const [userId, snapWallet] of Object.entries(snapSections.wallets || {})) {
    if (!snapWallet || typeof snapWallet !== 'object') continue;
    const local = db.config.wallets[userId];
    if (!local) {
      db.config.wallets[userId] = { ...snapWallet };
      summary.wallets += 1;
      changed = true;
      continue;
    }
    if (walletOrder.get(userId) === 'snapshot-newer') {
      db.config.wallets[userId] = { ...local, ...snapWallet };
      summary.walletsKeptHigher += 1; // legacy field: newer snapshot, not a higher balance
      changed = true;
    }
  }

  // union sections
  const union = (key, counter) => {
    if (!db.config[key] || typeof db.config[key] !== 'object') db.config[key] = {};
    for (const [id, record] of Object.entries(snapSections[key] || {})) {
      if (!record || typeof record !== 'object') continue;
      if (!db.config[key][id]) {
        db.config[key][id] = { ...record };
        summary[counter] += 1;
        changed = true;
      } else if (key === 'topupIntents' && !db.config[key][id].usedAt && record.usedAt) {
        db.config[key][id] = { ...db.config[key][id], ...record };
        summary[counter] += 1;
        changed = true;
      } else if ((key === 'topupRequests' || key === 'topupClaims') &&
                 String(db.config[key][id].status || '').toUpperCase() === 'PENDING' &&
                 ['APPROVED', 'AUTO_VERIFIED', 'REJECTED'].includes(String(record.status || '').toUpperCase())) {
        // Do not resurrect a settled claim as pending and allow a second credit.
        db.config[key][id] = { ...db.config[key][id], ...record };
        summary[counter] += 1;
        changed = true;
      }
    }
  };
  union('topupRequests', 'topupRequests');
  union('topupClaims', 'topupClaims');
  union('topupIntents', 'topupIntents');

  // usedUtrs — sabse zaroori: ek UTR hamesha ek hi baar.
  if (!db.config.usedUtrs || typeof db.config.usedUtrs !== 'object') db.config.usedUtrs = {};
  for (const [utr, record] of Object.entries(snapSections.usedUtrs || {})) {
    if (!db.config.usedUtrs[utr]) {
      db.config.usedUtrs[utr] = { ...(record || {}) };
      summary.usedUtrs += 1;
      changed = true;
    } else if (String(record?.status || '').toUpperCase() === 'CREDITED' &&
               String(db.config.usedUtrs[utr]?.status || '').toUpperCase() !== 'CREDITED') {
      db.config.usedUtrs[utr] = { ...db.config.usedUtrs[utr], ...record };
      summary.usedUtrs += 1;
      changed = true;
    }
  }

  if (changed) db.config.lastMoneyRestoreAt = new Date(at).toISOString();
  return { changed, summary, conflicts };
}

/** App/tools me dikhane ke liye ek line — sach, dhamki nahi. */
export function describeDurableState({ snapshotAt = '', restoredAt = '', cloud = false, localOnly = false, walletCount = 0, utrCount = 0 } = {}) {
  if (!cloud) return 'Cloud backup OFF — deploy par wallet aur UTR ki yaad mit sakti hai. GITHUB_VAULT_TOKEN Render env me daalein.';
  const bits = [`Cloud backup ON`];
  if (snapshotAt) bits.push(`last snapshot ${snapshotAt}`);
  if (restoredAt) bits.push(`deploy ke baad restore hua ${restoredAt}`);
  bits.push(`${walletCount} wallet, ${utrCount} UTR yaad`);
  if (localOnly) bits.push('disk local hai — deploy par khali ho sakta hai');
  return bits.join(' · ');
}
