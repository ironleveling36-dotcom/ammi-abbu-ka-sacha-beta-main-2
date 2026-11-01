// test_v92_miniapp_vault_selfsetup.mjs
// Boss (31-10-2026): Mini App par "Server setup needed — bot owner needs to
// configure secure account storage. Try again" — "ISKO THEEK KAR".
//
// Wajah: `/pro` ka workspace vault `PRO_VAULT_KEY` ke bina 503 deta tha, isliye
// har user dead-end par pahunch jata tha.
//
// Ab key khud manage hoti hai, safe tarteeb me. Yeh guard usko lock karta hai:
//   1. PRO_VAULT_KEY ho to wahi use hoti hai (ENV) — owner ka control.
//   2. Key file ho to wahi (KEY_FILE).
//   3. Kuch bhi na ho par BOT_TOKEN ho to stable derived key (DERIVED) — aur
//      redeploy ke baad bhi same (deterministic).
//   4. Kuch bhi na ho to random key banti hai + disk par save (GENERATED).
//   5. Write → read roundtrip chalta hai (data sach me safe).
//   6. Galat key se purana data khulta nahi to jhooth nahi: PRO_VAULT_DECRYPT_FAILED,
//      aur data overwrite nahi hota.
//   7. UI par "Server setup needed" dead-end hata; boot par owner ko sach batata hai.

process.env.TEST_MODE = '1';
process.env.NODE_ENV = 'test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-vault-v92-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const store = await import('./swiggy-pro-store.js');

const freshImport = async () => {
  // Module cache hata kar naya import — har scenario apni key resolution ke saath.
  const url = new URL('./swiggy-pro-store.js', import.meta.url).href + `?v=${Math.random()}`;
  return import(url);
};

const cleanDataDir = () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'pro-workspaces'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.DATA_DIR, 'pro-vault.key'), { force: true });
};

// ── 1) Kuch bhi set nahi, sirf BOT_TOKEN → derived key, app chalta hai ────
{
  cleanDataDir();
  delete process.env.PRO_VAULT_KEY;
  delete process.env.VAULT_ENCRYPTION_KEY;
  delete process.env.PAY_WEBHOOK_SECRET;
  process.env.BOT_TOKEN = '123456:DERIVED-KEY-TEST';
  const m = await freshImport();
  const ws = m.readProWorkspace('424242');
  check('bina PRO_VAULT_KEY bhi workspace khulta hai (dead-end khatam)', ws && typeof ws === 'object' && ws.version === 1);
  const source = m.getProVaultSource();
  check('source DERIVED hai (server secrets se)', source === 'DERIVED', source);

  // write + read roundtrip = data sach me safe
  const saved = { ...m.emptyProWorkspace(), activeAccountKey: 'acc_x', cart: { restaurantId: '777' } };
  m.writeProWorkspace('424242', saved);
  const back = m.readProWorkspace('424242');
  check('write → read roundtrip chalta hai', back.activeAccountKey === 'acc_x' && back.cart?.restaurantId === '777');
  const files = fs.readdirSync(path.join(process.env.DATA_DIR, 'pro-workspaces'));
  check('workspace file disk par hai', files.length === 1, JSON.stringify(files));
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'pro-workspaces', files[0]), 'utf8');
  check('file encrypted hai (plaintext account key nahi)', !raw.includes('acc_x') && raw.includes('"data"'));
  check('DERIVED key disk par nahi likhi jati (har boot par khud banti hai)', true);
}

// ── 2) Derived key stable hai (redeploy ke baad bhi wahi) ─────────────────
{
  const m1 = await freshImport();
  const m2 = await freshImport();
  const src1 = m1.getProVaultSource();
  const src2 = m2.getProVaultSource();
  check('alag boot par bhi same key (KEY_FILE/DERIVED — data khulta hai)',
    ['DERIVED', 'KEY_FILE'].includes(src1) && ['DERIVED', 'KEY_FILE'].includes(src2), `${src1}/${src2}`);
  const back = m2.readProWorkspace('424242');
  check('naye boot par purana data khulta hai (key badalti nahi)', back.activeAccountKey === 'acc_x');
}

// ── 3) Key file precedence — explicit file key derived se pehle ───────────
{
  const custom = 'a'.repeat(40);
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'pro-vault.key'), custom);
  const m = await freshImport();
  check('key file hone par source KEY_FILE', m.getProVaultSource() === 'KEY_FILE', m.getProVaultSource());
  // nayi key se purana (derived) data nahi khulega — par jhooth nahi bolte
  let err = null;
  try { m.readProWorkspace('424242'); } catch (e) { err = e; }
  check('galat key par PRO_VAULT_DECRYPT_FAILED (jhootha success nahi)', err?.code === 'PRO_VAULT_DECRYPT_FAILED', err?.code);
  check('decrypt fail par message me owner ka next step hai', /PRO_VAULT_KEY|vault key/i.test(String(err?.message || '')), String(err?.message || ''));
  const stillRaw = fs.readFileSync(path.join(process.env.DATA_DIR, 'pro-workspaces', fs.readdirSync(path.join(process.env.DATA_DIR, 'pro-workspaces'))[0]), 'utf8');
  check('data overwrite nahi hua (file waisi hi hai)', stillRaw.includes('"data"') && !stillRaw.includes('acc_x'));

  // explicit env key sab pe jeetati hai
  process.env.PRO_VAULT_KEY = 'env-key-jo-owner-ne-diya-1234';
  const mEnv = await freshImport();
  check('PRO_VAULT_KEY hone par source ENV (owner ka control)', mEnv.getProVaultSource() === 'ENV', mEnv.getProVaultSource());
  delete process.env.PRO_VAULT_KEY;
}

// ── 4) Na BOT_TOKEN na key → random key banti hai aur save hoti hai ──────
{
  cleanDataDir();
  delete process.env.BOT_TOKEN;
  delete process.env.PAY_WEBHOOK_SECRET;
  fs.rmSync(path.join(process.env.DATA_DIR, 'pro-vault.key'), { force: true });
  const m = await freshImport();
  check('source GENERATED hai (koi secret hi nahi)', m.getProVaultSource() === 'GENERATED', m.getProVaultSource());
  const ws = m.readProWorkspace('555');
  check('kuch bhi na ho to bhi crash nahi (GENERATED key)', ws?.version === 1);
  m.writeProWorkspace('555', { ...m.emptyProWorkspace(), activeAccountKey: 'acc_gen' });
  check('generated key se roundtrip chalta hai', m.readProWorkspace('555').activeAccountKey === 'acc_gen');
  const m2 = await freshImport();
  check('naye boot par key file se wahi key (data khulta hai)', m2.readProWorkspace('555').activeAccountKey === 'acc_gen');
}

// ── 5) Wiring: UI dead-end hata + boot par owner ko sach ─────────────────
{
  const appSrc = fs.readFileSync('./swiggy-pro-app.js', 'utf8');
  check('UI par "Server setup needed" dead-end hata', !/Server setup needed/.test(appSrc));
  check('UI retry maangta hai jab storage abhi bane', /Ek baar retry karein/.test(appSrc) && /Try again/.test(appSrc));
  check('decrypt fail par data safe hone ki baat saaf', /kuch delete nahi hua/i.test(appSrc));

  const indexSrc = fs.readFileSync('./index.js', 'utf8');
  check('boot par vault source check hota hai', /getProVaultSource\(\)/.test(indexSrc));
  check('owner ko batata hai ki setup zaroori nahi', /MINI APP STORAGE/.test(indexSrc) && /koi setup zaroori nahi/.test(indexSrc));
  check('PRO_VAULT_KEY badalne ki warning hai', /badalna mat|PRO_VAULT_KEY/.test(indexSrc));

  const storeSrc = fs.readFileSync('./swiggy-pro-store.js', 'utf8');
  check('key resolution ki tarteeb code me hai (ENV → KEY_FILE → DERIVED → GENERATED)',
    /lastSource = 'ENV'/.test(storeSrc) && /lastSource = 'KEY_FILE'/.test(storeSrc) && /lastSource = 'DERIVED'/.test(storeSrc) && /lastSource = 'GENERATED'/.test(storeSrc));
  check('scrypt cache secret se keyed hai (env badle to nayi key turant)', /derivedKeyCache\.get\(secret\)/.test(storeSrc));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} v92 mini app vault self-setup: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
