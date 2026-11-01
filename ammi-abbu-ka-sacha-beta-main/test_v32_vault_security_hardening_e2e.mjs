// ============================================================================
// V32 — Vault security hardening (2026-10-22 public-repo incident):
//  1. NO embedded credentials in source (the XOR-masked ghp_ PAT is gone).
//  2. Vault token comes ONLY from env (GITHUB_VAULT_TOKEN / GH_VAULT_TOKEN).
//  3. Vault payload is AES-256-GCM encrypted at rest on the bot-vault branch —
//     raw cookies never land in git in plaintext when VAULT_ENCRYPTION_KEY set.
//  4. Legacy plaintext vault files still hydrate (backward compat).
// ============================================================================
import './network-shield.js';
import fs from 'fs';
import assert from 'assert';
import {
  resolveVaultToken,
  decryptVaultPayloadText,
  pullAccountsFromCloudVault,
  pushAccountsToCloudVaultNow
} from './vault-sync.js';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`✅ ${label}`); }
  catch (err) { failed += 1; console.log(`❌ ${label}\n   ↳ ${err.message}`); }
}

const VAULT_REPO_PATH = 'https://api.github.com/repos/hulm0408/ammi-abbu-ka-sacha-beta';
const VAULT_FILE_URL = `${VAULT_REPO_PATH}/contents/vault/accounts-vault.json`;

const realFetch = globalThis.fetch;
let pushedContentBase64 = null;
let servedContentBase64 = null;
const makeMeta = (contentB64) => ({
  sha: 'prev-sha-123',
  content: contentB64,
  encoding: 'base64',
  size: contentB64.length
});

function installMock() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const okJson = (obj, status = 200) => ({
      ok: status < 400, status,
      headers: { get: () => null },
      json: async () => obj,
      text: async () => JSON.stringify(obj)
    });
    if (u.startsWith(`${VAULT_REPO_PATH}/git/ref/`)) return okJson({ ref: 'refs/heads/bot-vault', object: { sha: 'ref-sha' } });
    if (u.startsWith(VAULT_FILE_URL)) {
      if (init?.method === 'PUT') {
        pushedContentBase64 = JSON.parse(init.body).content;
        return okJson({ content: { sha: 'new-sha' } });
      }
      if (servedContentBase64) return okJson(makeMeta(servedContentBase64));
      return okJson({ message: 'Not Found' }, 404);
    }
    return okJson({ message: 'unexpected url ' + u }, 404);
  };
}

// Env state we must restore (vault-sync reads env at call time)
const envBackup = {
  GITHUB_VAULT_TOKEN: process.env.GITHUB_VAULT_TOKEN,
  GH_VAULT_TOKEN: process.env.GH_VAULT_TOKEN,
  VAULT_ENCRYPTION_KEY: process.env.VAULT_ENCRYPTION_KEY,
  DISABLE_CLOUD_VAULT: process.env.DISABLE_CLOUD_VAULT
};
function setEnv(patch) {
  for (const [k, v] of Object.entries(envBackup)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
const SAMPLE_SECRET_COOKIES = 'TOPSECRET _session_tid=aaaa; tid=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiMTIzIn0.sig; token=secret-token-xyz';
const SAMPLE_PAYLOAD = {
  version: 15,
  updatedAt: new Date().toISOString(),
  accounts: { acc_101: { name: 'Test User', phone: '1111111111', cookies: SAMPLE_SECRET_COOKIES, isLoggedIn: true } },
  deletedAccounts: {},
  sessionVault: {}
};

try {
  await check('Source has NO embedded credentials (no ghp_, no XOR mask remnants, no 40-hex token blobs)', () => {
    const src = fs.readFileSync('vault-sync.js', 'utf8');
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(src), 'no classic PAT pattern in source');
    assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(src), 'no fine-grained PAT pattern in source');
    assert.ok(!src.includes('_ENC_DEFAULT_HEX'), 'XOR-masked token blob removed');
    assert.ok(!src.includes('_MASK_KEY'), 'XOR mask key removed');
    assert.ok(!/[0-9a-f]{60,}/.test(src), 'no long hex credential blob in source');
  });

  await check('Token resolves ONLY from env (set → value, unset → empty)', () => {
    setEnv({ GITHUB_VAULT_TOKEN: 'ghp_from_env_only_test', GH_VAULT_TOKEN: undefined, VAULT_ENCRYPTION_KEY: undefined });
    assert.strictEqual(resolveVaultToken(), 'ghp_from_env_only_test');
    setEnv({ GITHUB_VAULT_TOKEN: undefined, GH_VAULT_TOKEN: undefined, VAULT_ENCRYPTION_KEY: undefined });
    assert.strictEqual(resolveVaultToken(), '', 'no env → no token (never a hardcoded fallback)');
    setEnv({ GITHUB_VAULT_TOKEN: undefined, GH_VAULT_TOKEN: 'ghp_alt_env_test', VAULT_ENCRYPTION_KEY: undefined });
    assert.strictEqual(resolveVaultToken(), 'ghp_alt_env_test');
  });

  await check('Push encrypts the payload (AES-256-GCM envelope; raw cookies NOT present in git content)', async () => {
    installMock();
    pushedContentBase64 = null;
    setEnv({ GITHUB_VAULT_TOKEN: 'ghp_test_token', VAULT_ENCRYPTION_KEY: 'test-enc-key-v32' });
    const res = await pushAccountsToCloudVaultNow(SAMPLE_PAYLOAD);
    assert.ok(res?.ok, `push ok: ${JSON.stringify(res)}`);
    assert.ok(pushedContentBase64, 'content captured');
    const gitText = Buffer.from(pushedContentBase64, 'base64').toString('utf8');
    const envelope = JSON.parse(gitText);
    assert.strictEqual(envelope.__vaultEnc, 'v2-aes256gcm', 'envelope marker present');
    assert.ok(envelope.iv && envelope.tag && envelope.data, 'iv/tag/data present');
    assert.ok(!gitText.includes(SAMPLE_SECRET_COOKIES), 'raw cookies must NOT be in plaintext in the git blob');
    assert.ok(!gitText.includes('secret-token-xyz'), 'raw token must NOT be in plaintext in the git blob');
  });

  await check('Pull decrypts the encrypted vault back to the exact original payload', async () => {
    // Feed back the exact blob the previous push produced.
    servedContentBase64 = pushedContentBase64;
    setEnv({ GITHUB_VAULT_TOKEN: 'ghp_test_token', VAULT_ENCRYPTION_KEY: 'test-enc-key-v32' });
    const pulled = await pullAccountsFromCloudVault();
    assert.ok(pulled, 'pulled object');
    assert.strictEqual(pulled.accounts.acc_101.cookies, SAMPLE_SECRET_COOKIES, 'cookies decrypt intact');
    assert.strictEqual(pulled.version, 15);
  });

  await check('Wrong VAULT_ENCRYPTION_KEY → graceful null (no crash, no silent plaintext)', async () => {
    servedContentBase64 = pushedContentBase64;
    setEnv({ GITHUB_VAULT_TOKEN: 'ghp_test_token', VAULT_ENCRYPTION_KEY: 'totally-different-key' });
    const pulled = await pullAccountsFromCloudVault();
    assert.strictEqual(pulled, null);
  });

  await check('Legacy PLAINTEXT vault still hydrates (backward compat) and unit decrypt passthrough', async () => {
    const legacy = JSON.stringify(SAMPLE_PAYLOAD);
    servedContentBase64 = Buffer.from(legacy, 'utf8').toString('base64');
    setEnv({ GITHUB_VAULT_TOKEN: 'ghp_test_token', VAULT_ENCRYPTION_KEY: 'test-enc-key-v32' });
    const pulled = await pullAccountsFromCloudVault();
    assert.strictEqual(pulled?.accounts?.acc_101?.cookies, SAMPLE_SECRET_COOKIES, 'legacy plaintext readable');
    // Unit: passthrough for non-envelope JSON
    assert.deepStrictEqual(decryptVaultPayloadText('{"a":1}'), { a: 1 });
  });

  await check('No VAULT_ENCRYPTION_KEY → push falls back to plaintext (warns), so zero-env prod keeps working', async () => {
    installMock();
    pushedContentBase64 = null;
    setEnv({ GITHUB_VAULT_TOKEN: 'ghp_test_token', VAULT_ENCRYPTION_KEY: undefined });
    const res = await pushAccountsToCloudVaultNow(SAMPLE_PAYLOAD);
    assert.ok(res?.ok);
    const gitText = Buffer.from(pushedContentBase64, 'base64').toString('utf8');
    assert.ok(!JSON.parse(gitText).__vaultEnc, 'fallback plaintext (no envelope)');
    assert.ok(gitText.includes(SAMPLE_SECRET_COOKIES), 'plaintext payload written when no key set');
  });
} finally {
  globalThis.fetch = realFetch;
  setEnv({});
}

console.log(`\n================================================================\n📊 V32 RESULT: ${passed}/${passed + failed} vault-security checks passed${failed ? ` — ${failed} FAILED` : ''}\n================================================================`);
process.exit(failed ? 1 : 0);
