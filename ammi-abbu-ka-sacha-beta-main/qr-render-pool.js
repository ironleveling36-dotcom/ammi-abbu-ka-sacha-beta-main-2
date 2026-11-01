/**
 * qr-render-pool.js — QR card render ko worker thread me chalata hai.
 *
 * Kyun: `generateNamedUpiQrPngBuffer` ~180–240ms ka SYNCHRONOUS CPU kaam hai
 * (pixel paint + PNG deflate + jsQR verify). 10 order ek saath aane par yeh
 * ~2 second ke liye poore bot ko block kar deta tha — usi "hang" ka ek bada
 * hissa. Worker thread me bhejne se main loop free rehta hai.
 *
 * Safety:
 *   • worker fail/exit/timeout ho to wahi kaam INLINE chalta hai (koi QR miss nahi)
 *   • tests me by default inline (deterministic), `QR_WORKER=1` se force
 *   • pool size QR_WORKERS (default 2) — zyada workers = zyada RAM
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { generateNamedUpiQrPngBuffer } from './qr-card.js';

const WORKER_TIMEOUT_MS = Number(process.env.QR_WORKER_TIMEOUT_MS) || 20_000;
const POOL_SIZE = Math.max(1, Math.min(4, Number(process.env.QR_WORKERS) || 2));

const isTest = Boolean(process.env.TEST_MODE || process.env.BOT_TEST_MODE || process.env.NODE_ENV === 'test');
const workerSetting = String(process.env.QR_WORKER || '').toLowerCase();
const WORKERS_ENABLED = workerSetting === '1'
  ? true
  : (workerSetting === '0' ? false : !isTest && os.cpus().length > 0);

const stats = { jobs: 0, workerRuns: 0, inlineRuns: 0, fallbacks: 0, timeouts: 0, errors: 0, active: 0 };
const pool = [];
const queue = [];
let seq = 0;
let workerBroken = false;

export function getQrPoolStats() {
  return {
    enabled: WORKERS_ENABLED && !workerBroken,
    poolSize: pool.length,
    queued: queue.length,
    ...stats
  };
}

function spawnWorker() {
  const worker = new Worker(new URL('./qr-worker.js', import.meta.url));
  const slot = { worker, busy: false, task: null };
  worker.on('message', (msg) => {
    if (!slot.task) return;
    const { resolve, reject, timer } = slot.task;
    slot.task = null;
    slot.busy = false;
    stats.active = Math.max(0, stats.active - 1);
    if (timer) clearTimeout(timer);
    if (msg?.ok) resolve(Buffer.isBuffer(msg.buffer) ? msg.buffer : Buffer.from(msg.buffer?.data || msg.buffer));
    else reject(new Error(msg?.error || 'worker render failed'));
    drain();
  });
  const fail = (err) => {
    workerBroken = true;
    stats.errors += 1;
    if (slot.task) {
      const { reject, timer } = slot.task;
      slot.task = null;
      if (timer) clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err?.message || err)));
    }
    slot.busy = false;
    stats.active = Math.max(0, stats.active - 1);
    // worker mara — queue ko inline nikaal do
    drain();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code !== 0) fail(new Error(`QR worker exit ${code}`)); });
  if (typeof worker.unref === 'function') worker.unref();
  pool.push(slot);
  return slot;
}

function ensurePool() {
  while (pool.length < POOL_SIZE) spawnWorker();
}

function runInline(job) {
  stats.inlineRuns += 1;
  return generateNamedUpiQrPngBuffer(job);
}

function drain() {
  if (!WORKERS_ENABLED || workerBroken || queue.length === 0) {
    if (queue.length > 0 && (workerBroken || !WORKERS_ENABLED)) {
      // inline fallback — kuch bhi na ruke
      const pending = queue.splice(0, queue.length);
      for (const item of pending) {
        item.resolve(runInline(item.job));
      }
    }
    return;
  }
  const slot = pool.find((s) => !s.busy);
  if (!slot) return;
  const item = queue.shift();
  slot.busy = true;
  stats.active += 1;
  stats.workerRuns += 1;
  slot.task = {
    resolve: item.resolve,
    reject: item.reject,
    timer: setTimeout(() => {
      stats.timeouts += 1;
      stats.fallbacks += 1;
      const t = slot.task;
      slot.task = null;
      slot.busy = false;
      stats.active = Math.max(0, stats.active - 1);
      if (t) t.resolve(runInline(item.job));
      drain();
    }, WORKER_TIMEOUT_MS)
  };
  try {
    slot.worker.postMessage({ id: ++seq, job: item.job });
  } catch (err) {
    stats.fallbacks += 1;
    if (slot.task?.timer) clearTimeout(slot.task.timer);
    slot.task = null;
    slot.busy = false;
    stats.active = Math.max(0, stats.active - 1);
    item.resolve(runInline(item.job));
    drain();
  }
}

/**
 * QR card buffer — worker me koshish, fail hone par inline. Kabhi reject nahi
 * hota agar inline render kaam kar gaya (jo pure JS hai).
 */
export async function renderQrCardBuffered(job) {
  stats.jobs += 1;
  if (!WORKERS_ENABLED || workerBroken) return runInline(job);
  try {
    ensurePool();
  } catch (err) {
    workerBroken = true;
    return runInline(job);
  }
  return new Promise((resolve, reject) => {
    queue.push({
      job,
      resolve: (buf) => resolve(buf),
      reject: (err) => {
        stats.fallbacks += 1;
        // worker fail ho gaya to inline — customer ka QR kabhi na ruke
        try {
          resolve(runInline(job));
        } catch (e) {
          reject(err || e);
        }
      }
    });
    drain();
  });
}
