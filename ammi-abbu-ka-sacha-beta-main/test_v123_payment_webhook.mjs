// Isolated localhost webhook integration, fake Telegram only; no real UPI/Swiggy calls.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('webhook requires evidence and credits a matching pending UTR only once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-webhook-test-'));
  const port = await freePort();
  const env = { ...process.env, DATA_DIR: tmp, DB_FILE: path.join(tmp, 'db.json'),
    ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'), PORT: String(port),
    BOT_TOKEN: '123456:offline-webhook-token', BOSS_ID: '9001', TEST_MODE: '1', NODE_ENV: 'test',
    DB_ASYNC_WRITE: '0', SWIGGY_BLOCK_LIVE_ORDER_PLACE: '1', PAY_WEBHOOK_SECRET: 'offline-secret' };
  delete env.GITHUB_VAULT_TOKEN;
  const code = `
    const { bot } = await import('./index.js');
    const { getDb, saveDb } = await import('./store.js');
    const { submitTopupRequestWithLookup } = await import('./user-wallet.js');
    bot.telegram.callApi = async () => true;
    Object.getPrototypeOf(bot.telegram).callApi = async () => true;
    const db = getDb();
    db.config.bossIds = ['9001'];
    const claim = submitTopupRequestWithLookup(db, { userId: '8401', utr: '654321987003', amountPaise: 1500, autoVerify: false, minPaise: 100 });
    if (!claim.ok || !saveDb(db)) throw new Error('test seed failed');
    console.log('OFFLINE_WEBHOOK_READY');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('OFFLINE_WEBHOOK_READY') && output.includes('listening on')) resolve(); });
        child.once('exit', () => reject(new Error(`test server exited: ${output}`)));
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`test server timeout: ${output}`)), 10000);
        timer.unref();
      })
    ]);
    async function post(body, secret = 'offline-secret') {
      const response = await fetch(`http://127.0.0.1:${port}/pay/webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-pay-secret': secret }, body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    }
    const payload = { userId: '8401', amountPaise: 1200, utr: '654321987003', payeeName: 'MISBAHUL ISLAM', status: 'SUCCESS' };
    assert.equal((await post(payload, 'wrong')).status, 403);
    assert.equal((await post({ ...payload, status: '' })).status, 422);
    assert.equal((await post({ ...payload, utr: '' })).status, 400);
    assert.equal((await post({ ...payload, payeeName: 'OTHER PERSON' })).status, 422);
    assert.equal((await post({ ...payload, payeeVpa: 'someoneelse@okbank' })).status, 422, 'matching name cannot override wrong VPA');
    assert.equal((await post({ ...payload, amountPaise: 1200.5 })).status, 400);
    const verified = await post(payload);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.credited, 1200);
    assert.equal((await post(payload)).status, 409);
    const db = JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf8'));
    assert.equal(db.config.wallets['8401'].balancePaise, 1200);
    assert.equal(db.config.usedUtrs[payload.utr].status, 'CREDITED');
  } finally {
    child.kill('SIGKILL');
    if (child.exitCode === null) await once(child, 'exit').catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
