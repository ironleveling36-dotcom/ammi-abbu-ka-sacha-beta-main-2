// Offline security simulations. No provider or real Telegram service is called.
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-default-access-'));
const dbFile = path.join(tmp, 'db.json');
Object.assign(process.env, {
  DATA_DIR: tmp, DB_FILE: dbFile, ACCOUNTS_JSON_FILE: path.join(tmp, 'accounts.json'),
  BOT_TOKEN: '123456:offline-access-test', PRO_VAULT_KEY: 'offline-key-123456789',
  BOSS_ID: '9001', TEST_MODE: '1', NODE_ENV: 'test', DB_ASYNC_WRITE: '0'
});
delete process.env.GITHUB_VAULT_TOKEN;
const { getDb, saveDb, saveDbDurable } = await import('../store.js');
const { writeProWorkspace, resetProWorkspaceHydrationCache } = await import('../swiggy-pro-store.js');
const { handleSwiggyProHttp } = await import('../swiggy-pro-api.js');
const fake = {
  async addresses() { throw new Error('Shared address book must not be requested'); },
  async search() { return [
    { id: '101', name: 'Cafe Café', area: 'One' }, { id: '101', name: 'Cafe Café', area: 'Duplicate' },
    { id: '102', name: 'CAFE CAFÉ', area: 'Two' }, { id: '103', name: 'Cafe Café Express', area: 'Different name' },
    { name: 'Cafe Café', area: 'No ID' }
  ]; }
};
const server = http.createServer(async (req, res) => {
  if (!await handleSwiggyProHttp(req, res, { provider: fake, authorizeUser: async () => ({ allowed: true }) })) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function sign(user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(user), first_name: 'Offline' }), query_id: 'test' });
  const text = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(text).digest('hex'));
  return params.toString();
}
async function req(user, route, body) {
  const r = await fetch(`${base}/pro/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': sign(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
}
const change = (user, key, allow) => req(9001, 'boss/account-access', { userId: String(user), accountKey: key, allow, confirm: true });
const keys = async user => (await req(user, 'bootstrap')).body.accounts.map(a => a.key).sort();
const db = getDb();
db.config.accounts.shared = { name: 'Operator', phone: '9876543210', token: 'shared-secret', isLoggedIn: true };
db.knownUsers ||= {};
db.knownUsers['1001'] = { firstName: 'One', lastSeen: Date.now() };
db.knownUsers['1002'] = { firstName: 'Two', lastSeen: Date.now() };
assert.equal(saveDbDurable(db), true);
writeProWorkspace('1001', { version: 1, accounts: { private: { name: 'Private', phone: '9123456789', token: 'private-secret', isLoggedIn: true } }, activeAccountKey: '', selectedAddress: null, cart: null });
writeProWorkspace('1002', { version: 1, accounts: {}, activeAccountKey: '', selectedAddress: null, cart: null });
after(async () => { await new Promise(resolve => server.close(resolve)); resetProWorkspaceHydrationCache(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('current and future shared IDs are default-visible; private accounts and session exports remain restricted', async () => {
  assert.deepEqual(await keys(1001), ['private', 'shared']);
  assert.deepEqual(await keys(1002), ['shared']);
  const next = getDb();
  next.config.accounts.future = { name: 'Later upload', phone: '9988776655', token: 'future-secret', isLoggedIn: true };
  assert.equal(saveDbDurable(next), true);
  assert.deepEqual(await keys(1001), ['future', 'private', 'shared']);
  assert.deepEqual(await keys(1002), ['future', 'shared']);
  const exportShared = await req(1001, 'accounts/session?key=shared');
  assert.equal(exportShared.status, 403);
  assert.doesNotMatch(JSON.stringify(exportShared.body), /shared-secret/);
  assert.equal((await req(1002, 'accounts/session?key=private')).status, 404);
  assert.equal((await req(1002, 'accounts/select', { key: 'private' })).status, 404);
  assert.equal((await req(1002, 'boss/account-access')).status, 403);
  assert.equal((await req(9001, 'accounts/session?key=shared')).body.session.token, 'shared-secret');
});

test('saved offer status alone is not turned into a verified claim', async () => {
  const next = getDb();
  next.config.accounts.shared.offerAutoActivation = {
    lateNight: { status: 'CLAIMED', verified: false },
    breakfast: { status: 'ALREADY_ACTIVE' },
    extra50: { status: 'CLAIMED', verified: true, alreadyActive: true, results: [{ state: 'ALREADY_ACTIVE', verified: true }, { state: 'CLAIMED', verified: true }] },
    weekend: { status: 'PARTIAL', verified: true, alreadyActive: true },
    karwaChauth: { status: 'CLAIMED', verified: true, alreadyActive: true, results: [{ state: 'ALREADY_ACTIVE', verified: true }] }
  };
  assert.equal(saveDbDurable(next), true);
  const out = await req(9001, 'bootstrap');
  const tracks = out.body.accounts.find(a => a.key === 'shared').offerTracks;
  const byKey = Object.fromEntries(tracks.map(track => [track.key, track]));
  assert.equal(byKey.lateNight.verified, false);
  assert.equal(byKey.breakfast.verified, false);
  assert.equal(byKey.extra50.verified, true);
  assert.equal(byKey.extra50.status, 'CLAIMED', 'a mixture of new and already-active claims is not all already claimed');
  assert.equal(byKey.weekend.status, 'PARTIAL', 'a partly active track is not already claimed');
  assert.equal(byKey.karwaChauth.status, 'ALREADY_CLAIMED', 'a fully verified pre-existing claim remains identified');
  const clean = getDb(); delete clean.config.accounts.shared.offerAutoActivation; assert.equal(saveDbDurable(clean), true);
});

test('explicit revoke survives a stale writer, is per user and key, and can be restored', async () => {
  const stale = getDb();
  assert.equal((await change(1001, 'shared', false)).status, 200);
  assert.equal(saveDb(stale), true);
  assert.deepEqual(await keys(1001), ['future', 'private']);
  assert.deepEqual(await keys(1002), ['future', 'shared']);
  assert.notEqual((await req(1001, 'accounts/select', { key: 'shared' })).status, 200);
  const reallowed = await change(1001, 'shared', true);
  assert.equal(reallowed.status, 200);
  assert((await keys(1001)).includes('shared'));
  const later = getDb(); later.config.accounts.third = { name: 'Third', phone: '9765432109', token: 'third-secret', isLoggedIn: true }; saveDb(later);
  assert((await keys(1001)).includes('third'), 'new uploads remain shared by default');
});

test('divergent stale security decisions deny rather than default-allow', async () => {
  assert.equal((await change(1001, 'shared', false)).status, 200);
  const conflicting = getDb();
  assert.equal((await change(1001, 'shared', true)).status, 200);
  conflicting.config.proAccountGrants['1001'].shared = 'a'.repeat(64);
  assert.equal(saveDb(conflicting), true);
  assert(!(await keys(1001)).includes('shared'));
  assert.equal(getDb().config.proAccountGrants['1001'].shared, '!');
  assert.equal((await change(1001, 'shared', true)).status, 200);
});

test('corrupt maps and rows fail closed and cannot be silently reset by a stale writer or manager', async () => {
  const old = getDb();
  const corrupt = getDb(); corrupt.config.proAccountGrants['1001'] = 'broken-row'; assert.equal(saveDb(corrupt), true);
  saveDb(old);
  assert.equal(getDb().config.proAccountGrants['1001'], 'broken-row');
  assert.deepEqual(await keys(1001), ['private']);
  assert.equal((await change(1001, 'shared', true)).status, 503);
  const repaired = getDb(); delete repaired.config.proAccountGrants['1001']; assert.equal(saveDb(repaired), true);
  const beforeGlobal = getDb();
  const global = getDb(); global.config.proAccountGrants = ['corrupt']; saveDb(global);
  saveDb(beforeGlobal);
  assert.deepEqual(getDb().config.proAccountGrants, ['corrupt']);
  assert.deepEqual(await keys(1002), []);
  assert.equal((await change(1002, 'shared', false)).status, 503);
  const reset = getDb(); reset.config.proAccountGrants = {}; saveDb(reset);
});

test('failed write blocks the affected ID in process even if the disk still has the older allow', async () => {
  assert((await keys(1002)).includes('shared'));
  const original = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    const name = String(file);
    if (name === dbFile || name.startsWith(dbFile + '.')) throw new Error('simulated disk write failure');
    return original.call(this, file, ...args);
  };
  let result;
  try { result = await change(1002, 'shared', false); } finally { fs.writeFileSync = original; }
  assert.equal(result.status, 503);
  assert(!(await keys(1002)).includes('shared'), 'in-process unconfirmed change must fail closed');
  const disk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.notEqual(disk.config.proAccountGrants?.['1002']?.shared, '!', 'failed disk write may not survive restart');
  assert.equal((await change(1002, 'shared', false)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).config.proAccountGrants['1002'].shared, '!');
  assert.equal((await change(1002, 'shared', true)).status, 200);
});

test('failed fsync never grants an unconfirmed allow; successful retry restores access', async () => {
  assert.equal((await change(1002, 'shared', false)).status, 200);
  const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('simulated fsync failure'); };
  let result;
  try { result = await change(1002, 'shared', true); } finally { fs.fsyncSync = original; }
  assert.equal(result.status, 503);
  assert(!(await keys(1002)).includes('shared'));
  assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).config.proAccountGrants['1002'].shared, '!', 'rollback attempted on disk');
  assert.equal((await change(1002, 'shared', true)).status, 200);
  assert((await keys(1002)).includes('shared'));
});

test('outlet discovery returns only distinct provider IDs with an exact normalized name', async () => {
  writeProWorkspace('1003', { version: 1, accounts: {}, activeAccountKey: 'shared',
    selectedAddress: { id: 'home', name: 'Receiver', mobile: '9123456789', address: 'Road', lat: '18', lng: '73' }, cart: null });
  const out = await req(1003, 'restaurants/outlets?q=' + encodeURIComponent('Cafe Café'));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.outlets.map(row => row.id), ['101', '102']);
});

test('cart add rejects an item tap when a different restaurant menu replaced the server workspace', async () => {
  writeProWorkspace('1004', { version: 1, accounts: {}, activeAccountKey: 'shared',
    selectedAddress: { id: 'home', name: 'Receiver', mobile: '9123456789', address: 'Road', lat: '18', lng: '73' },
    cart: null, menu: { restaurant: { id: '111', name: 'One', isOpen: true }, categories: [{ title: 'Items', items: [{ id: '456', name: 'Meal', price: 100, inStock: true }] }] } });
  const wrong = await req(1004, 'cart/add', { itemId: '456', restaurantId: '222', replace: true });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /menu changed/i);
  assert.equal((await req(1004, 'bootstrap')).body.cart, null, 'wrong restaurant item was not added');
});
