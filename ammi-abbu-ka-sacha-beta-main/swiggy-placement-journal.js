import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './store.js';

// This is a fail-closed local dispatch journal, not a claim that Swiggy supports
// idempotency. It must be on a persistent disk shared by every process that can
// place this logical order. Never delete an uncertain record automatically.
function keyHash(key) {
  const value = String(key || '').trim();
  if (!value || value.length > 512) {
    const err = new Error('Cannot place an order without a stable checkout identifier.');
    err.code = 'PLACEMENT_KEY_REQUIRED';
    err.diag = { code: err.code, placementAttempted: false };
    throw err;
  }
  return crypto.createHash('sha256').update(value).digest('hex');
}

function journalPath(key) {
  return path.join(getDataDir(), 'swiggy-placement-journal', `${keyHash(key)}.json`);
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function readSwiggyPlacement(key) {
  const file = journalPath(key);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== 1 || data.keyHash !== keyHash(key) || !data.state) throw new Error('Invalid journal');
    return data;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // A corrupted or unreadable record must never look like an unused key.
    return { version: 1, keyHash: keyHash(key), state: 'UNKNOWN', unreadable: true };
  }
}

export function placementAlreadyAttemptedError(record) {
  const id = /^\d{10,20}$/.test(String(record?.orderId || '')) ? String(record.orderId) : '';
  const err = new Error(
    `A Swiggy placement was already attempted${id ? ` (order ${id})` : ''}. ` +
    'Do not retry or switch accounts. Check this account in Swiggy before taking any further action.'
  );
  err.code = 'PLACEMENT_ALREADY_ATTEMPTED';
  err.diag = { code: err.code, placementAttempted: true, state: String(record?.state || 'UNKNOWN'), placedOrderId: id };
  return err;
}

function reservePlacement(key) {
  const file = journalPath(key);
  const dir = path.dirname(file);
  const record = { version: 1, keyHash: keyHash(key), state: 'SUBMITTING', createdAt: new Date().toISOString() };
  let fd;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // O_EXCL is the cross-process barrier. Write and sync it BEFORE any POST.
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDirectory(dir);
    // Persist creation of the journal directory as well when it was just made.
    syncDirectory(path.dirname(dir));
    return record;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (err?.code === 'EEXIST') throw placementAlreadyAttemptedError(readSwiggyPlacement(key));
    const failure = new Error('Could not safely record the checkout attempt. No placement request was sent.');
    failure.code = 'PLACEMENT_JOURNAL_UNAVAILABLE';
    failure.diag = { code: failure.code, placementAttempted: false };
    throw failure;
  }
}

function updatePlacement(key, initial, patch) {
  const file = journalPath(key);
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ ...initial, ...patch, updatedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function uncertainPlacementError() {
  const err = new Error('Swiggy did not return a safely verifiable placement result. An order may exist; check Swiggy My Orders. Do not retry or switch accounts.');
  err.code = 'SWIGGY_PLACEMENT_OUTCOME_UNKNOWN';
  err.diag = { code: err.code, placementAttempted: true, state: 'UNKNOWN' };
  return err;
}

/** Execute at most one provider POST for this logical checkout on this disk.
 * Timeouts, crashes, malformed responses and explicit rejections all stay locked:
 * without a provider guarantee, none proves that no order was created.
 */
export async function executeSingleSwiggyPlacement(key, sendOnce) {
  const initial = reservePlacement(key);
  let result;
  try {
    result = await sendOnce();
  } catch {
    try { updatePlacement(key, initial, { state: 'UNKNOWN' }); } catch {}
    throw uncertainPlacementError();
  }
  const json = result?.json;
  const data = json?.data?.order_data || json?.data?.orderData || json?.data || {};
  const candidateId = String(data?.order_id || data?.orderId || '');
  const orderId = /^\d{10,20}$/.test(candidateId) ? candidateId : '';
  const statusCode = json?.statusCode;
  const accepted = Boolean(result?.placeRes?.ok && (statusCode === 0 || statusCode === '0'));
  try {
    updatePlacement(key, initial, {
      state: accepted ? 'PROVIDER_ACCEPTED' : 'RESPONSE_UNCERTAIN',
      ...(orderId ? { orderId } : {}),
      httpStatus: Number(result?.placeRes?.status) || 0,
      providerStatus: typeof statusCode === 'number' || typeof statusCode === 'string' ? String(statusCode).slice(0, 30) : ''
    });
  } catch {
    // The original SUBMITTING record remains a permanent fail-closed barrier.
    throw uncertainPlacementError();
  }
  return result;
}
