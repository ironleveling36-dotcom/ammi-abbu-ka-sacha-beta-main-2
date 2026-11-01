/**
 * qr-worker.js — QR card renderer worker thread.
 *
 * Main bot ki event loop par 180–240ms ka CPU kaam (PNG paint + jsQR verify)
 * nahi karna chahiye. Yeh worker wahi kaam alag thread me karta hai: 10 order
 * ek saath aayein to bhi bot ke buttons/messages turant jawab dete hain.
 */
import { parentPort } from 'node:worker_threads';
import { generateNamedUpiQrPngBuffer } from './qr-card.js';

parentPort?.on('message', async (msg) => {
  const { id, job } = msg || {};
  try {
    const buffer = await generateNamedUpiQrPngBuffer(job || {});
    parentPort.postMessage({ id, ok: true, buffer });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
