/**
 * perf-guard.js — "10 ORDER KE BAAD HAWA KYUN NIKAL JAATI HAI" ka ilaaj.
 *
 * YouTube billions of logs dekh kar bhi hang nahi hota kyunki uska kaam alag
 * threads/processes me hota hai aur woh apni memory khud saaf rakhta hai. Bot
 * ek hi Node process hai: ek slow kaam poore bot ko rok deta hai. Isliye yahan
 * 4 cheezein lagayi gayi hain:
 *
 *   1. LOG THROTTLE   — ek hi message 500 baar log nahi hoga (Render log I/O +
 *                       CPU bachta hai). Pehli baar turant, phir "xN zyada baar".
 *   2. MEMORY GUARD   — heap badhne par DB prune + (agar --expose-gc) GC, aur
 *                       ek line ka honest warning Boss ko.
 *   3. DB PRUNE LOOP  — purane band orders ke bhaari fields hatao, lists bound.
 *   4. PERF SNAPSHOT  — /health par rss, heap, db size, getDb/save counts,
 *                       update queue, payment pollers — sab ek jagah.
 */
import os from 'os';
import v8 from 'node:v8';

const throttledLogState = new Map();
const LOG_WINDOW_MS = Number(process.env.LOG_THROTTLE_MS) || 10_000;

/**
 * Same key ka log window me ek hi baar jaata hai. Baaki gina jaata hai aur
 * window ke baad "… xN baar" ke saath ek line.
 */
export function logThrottled(key, ...args) {
  const now = Date.now();
  const prev = throttledLogState.get(key);
  if (!prev) {
    throttledLogState.set(key, { at: now, count: 1, suppressed: 0 });
    console.log(...args);
    return true;
  }
  if (now - prev.at < LOG_WINDOW_MS) {
    prev.suppressed += 1;
    return false;
  }
  const suppressed = prev.suppressed;
  prev.at = now;
  prev.suppressed = 0;
  console.log(...args, suppressed > 0 ? ` (+${suppressed} same log suppressed)` : '');
  return true;
}

/** Sirf pehli baar (process lifetime) — boot-time notices ke liye. */
const onceKeys = new Set();
export function logOnce(key, ...args) {
  if (onceKeys.has(key)) return false;
  onceKeys.add(key);
  console.log(...args);
  return true;
}

export function getLogThrottleStats() {
  let suppressed = 0;
  for (const v of throttledLogState.values()) suppressed += v.suppressed;
  return { keys: throttledLogState.size, suppressed };
}

/**
 * Memory guard: heap limit ke 75% par prune + GC, 88% par Boss ko ek warning.
 * `global.gc` sirf tab available hota hai jab node --expose-gc se chale.
 */
export function startMemoryGuard({
  intervalMs = Number(process.env.MEMORY_GUARD_MS) || 60_000,
  onPressure = null,
  onCritical = null,
  getDbIoStats = null
} = {}) {
  const limitMb = Number(process.env.MEMORY_LIMIT_MB) || 0;
  let lastCriticalAt = 0;

  const tick = () => {
    try {
      const mem = process.memoryUsage();
      const heapMb = Math.round(mem.heapUsed / 1048576);
      const rssMb = Math.round(mem.rss / 1048576);
      const heapLimitMb = limitMb
        || Math.round((Number(v8.getHeapStatistics?.().heap_size_limit || 0) || 512 * 1048576) / 1048576);
      const usedPct = Math.round((heapMb / Math.max(1, heapLimitMb)) * 100);

      if (usedPct >= 75 || rssMb > 420) {
        try { onPressure?.({ heapMb, rssMb, usedPct }); } catch {}
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch {}
        }
      }
      if (usedPct >= 88 && Date.now() - lastCriticalAt > 10 * 60 * 1000) {
        lastCriticalAt = Date.now();
        try { onCritical?.({ heapMb, rssMb, usedPct }); } catch {}
        logOnce('memory-critical', `⚠️ Memory pressure: heap ${heapMb}MB / ${heapLimitMb}MB (${usedPct}%), RSS ${rssMb}MB — DB prune chala.`);
      }
      void getDbIoStats;
    } catch {}
  };

  const timer = setInterval(tick, Math.max(15_000, intervalMs));
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/** /health ke liye ek line ka sach. */
export function perfSnapshot(extra = {}) {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    heapTotalMb: Math.round(mem.heapTotal / 1048576),
    externalMb: Math.round((mem.external || 0) / 1048576),
    cpus: os.cpus()?.length || 1,
    loadAvg1: Math.round((os.loadavg()?.[0] || 0) * 100) / 100,
    logs: getLogThrottleStats(),
    ...extra
  };
}
