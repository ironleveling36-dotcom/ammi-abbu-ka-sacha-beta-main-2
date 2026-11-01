// bot-maintenance.js
// Boss (30-10-2026): "bot ko maintenance kar jaldi se hang hogaya hai".
//
// Do kaam, dono honest:
//   1) HANG KA ILAAJ — ek module jo self-heal karta hai: atke hue account
//      locks, purani in-flight reservations, phansi hui scans, event-loop lag.
//   2) SACH DIKHANA — health snapshot: uptime, RAM, event-loop lag, kitne locks
//      / reservations / jobs abhi chal rahe hain. Jhooth nahi.
//
// Kuch bhi "reset" karne se pehle ye yaad rakhta hai ki kitna kuch chhoda gaya,
// taaki boss ko sach pata chale ("2 locks release kiye"), andha reset nahi.

const HEAL_INTERVAL_MS = 60_000;
const LAG_SAMPLE_MS = 2_000;

const inflightJobs = new Map(); // name -> { startedAt, timeoutMs, orderId }
const healLog = [];
const alertedStuckJobs = new Set();
let loopStarted = false;
let lagMs = 0;
let lagTimer = null;
let healTimer = null;
let lastHealAt = null;
let lastHealReport = null;

function pushLog(entry) {
  healLog.push({ at: new Date().toISOString(), ...entry });
  if (healLog.length > 40) healLog.splice(0, healLog.length - 40);
}

/**
 * Kisi bhi long job ko register karo. Job timeout se zyada chale to `sweep()`
 * uska naam report karta hai — isse pata chalta hai bot kahan atka.
 */
export function startJob(name, { timeoutMs = 90_000, orderId = '' } = {}) {
  const key = `${name}${orderId ? `#${orderId}` : ''}`;
  inflightJobs.set(key, { startedAt: Date.now(), timeoutMs: Math.max(100, Number(timeoutMs) || 90_000), orderId: String(orderId || '') });
  return () => inflightJobs.delete(key);
}

export function clearJob(name, orderId = '') {
  return inflightJobs.delete(`${name}${orderId ? `#${orderId}` : ''}`);
}

export function listStuckJobs(now = Date.now()) {
  const stuck = [];
  for (const [key, job] of inflightJobs.entries()) {
    const ageMs = now - job.startedAt;
    if (ageMs > job.timeoutMs) stuck.push({ key, ageMs, timeoutMs: job.timeoutMs, orderId: job.orderId });
  }
  return stuck;
}

/** Event-loop lag — bot "hang" lagta hai to yahi number sach batata hai. */
export function getEventLoopLagMs() {
  return Math.round(lagMs);
}

function startLagProbe() {
  if (lagTimer) return;
  let expected = Date.now() + LAG_SAMPLE_MS;
  lagTimer = setInterval(() => {
    const now = Date.now();
    lagMs = Math.max(0, now - expected);
    expected = now + LAG_SAMPLE_MS;
  }, LAG_SAMPLE_MS);
  if (typeof lagTimer.unref === 'function') lagTimer.unref();
}

/**
 * Self-heal. Har cheez ko "release" karne ke bajaye pehle dekhta hai ki wo
 * sach me atki hui hai ya abhi kaam kar rahi hai.
 *
 * @param {object} deps - { cart, tracking, db, saveDb } inject kiye jate hain
 *   taaki ye module kisi bhi module ko import karke cycle na banaye.
 */
export async function runMaintenance(deps = {}, { reason = 'AUTO', dryRun = false } = {}) {
  const report = {
    at: new Date().toISOString(),
    reason,
    dryRun: Boolean(dryRun),
    lagMs: getEventLoopLagMs(),
    locksReleased: [],
    locksObserved: [],
    reservationsReleased: [],
    scansReset: 0,
    stuckJobs: [],
    holdingTouched: 0,
    notes: []
  };

  const cart = deps.cart || null;
  const tracking = deps.tracking || null;

  // Active account locks are observations, not locks we have released.
  if (cart && typeof cart.getAccountLockStats === 'function') {
    const resolved = await Promise.resolve().then(() => cart.getAccountLockStats()).catch(() => null);
    if (resolved && Array.isArray(resolved.locks)) {
      report.locksObserved = resolved.locks.map(lock => ({ id: lock.id, ageMs: Number(lock.ageMs || 0) }));
      if (dryRun && report.locksObserved.length) report.notes.push(`${report.locksObserved.length} active lock(s) — none released`);
    }
  }
  if (cart && typeof cart.releaseStaleAccountLocks === 'function' && !dryRun) {
    const out = await Promise.resolve(cart.releaseStaleAccountLocks({ olderThanMs: 45_000 })).catch(() => null);
    if (out && typeof out === 'object') {
      report.locksReleased = Array.isArray(out.released) ? out.released : report.locksReleased;
      if (out.kept) report.notes.push(`${out.kept} lock(s) abhi real kaam me hain — chhode nahi`);
    }
  }

  // 2) In-flight account reservations (90s TTL) — order cancel/atka to release.
  if (cart && typeof cart.releaseStaleReservations === 'function' && !dryRun) {
    const out = await Promise.resolve(cart.releaseStaleReservations()).catch(() => null);
    if (out && typeof out === 'object') {
      report.reservationsReleased = Array.isArray(out.released) ? out.released : [];
    }
  }

  // 3) Tracking scans jo phans gaye (order-tracking ka `inflightScans`).
  if (tracking && typeof tracking.resetStuckScans === 'function' && !dryRun) {
    const out = await Promise.resolve(tracking.resetStuckScans({ olderThanMs: 60_000 })).catch(() => null);
    report.scansReset = Number(out?.reset || 0);
  }

  // 4) Stuck jobs (jo apne timeout se zyada chal rahe hain) — report + ek baar
  // boss ko alert. Job ko MARA nahi jata: chal raha worker beech me rokna
  // (jaise QR place ke dauraan) duplicate order bana sakta hai. Isliye sirf
  // batate hain, aur jo naya atka hai usko `newStuckJobs` me dete hain.
  report.stuckJobs = listStuckJobs();
  report.newStuckJobs = [];
  for (const job of report.stuckJobs) {
    const stamp = `${job.key}@${job.startedAt}`;
    if (alertedStuckJobs.has(stamp)) continue;
    alertedStuckJobs.add(stamp);
    report.newStuckJobs.push(job);
  }

  // 5) Orders jo cardStage par phanse hain aur unka koi job nahi chal raha.
  try {
    const db = deps.db && typeof deps.db === 'function' ? deps.db() : null;
    if (db?.orders) {
      const now = Date.now();
      for (const order of Object.values(db.orders)) {
        if (!order || ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) continue;
        const stageAt = order.cardStageAt ? new Date(order.cardStageAt).getTime() : 0;
        if (!stageAt || now - stageAt < 10 * 60_000) continue;
        if (['QR_GENERATED', 'FEE_PAID', 'DELIVERED'].includes(order.cardStage)) continue;
        report.holdingTouched += 1;
        if (!dryRun) {
          order.maintenanceNote = `Stage ${order.cardStage || '?'} 10+ min se wahi — maintenance ne note kiya`;
          order.maintenanceAt = new Date().toISOString();
        }
      }
      if (report.holdingTouched > 0 && !dryRun && typeof deps.saveDb === 'function') deps.saveDb(db);
    }
  } catch { /* db issues must never block healing */ }

  report.memoryMb = Math.round(process.memoryUsage().rss / 1048576);
  report.uptimeSec = Math.round(process.uptime());
  lastHealAt = report.at;
  lastHealReport = report;
  if (!dryRun) pushLog({ reason, locks: report.locksReleased.length, reservations: report.reservationsReleased.length, scans: report.scansReset });
  return report;
}

export function getMaintenanceSnapshot() {
  return {
    at: new Date().toISOString(),
    lagMs: getEventLoopLagMs(),
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    activeJobs: inflightJobs.size,
    stuckJobs: listStuckJobs(),
    lastHealAt,
    lastHeal: lastHealReport,
    log: healLog.slice(-10)
  };
}

/**
 * Auto-heal loop — har 60s. Boss ke bina bhi bot khud sambhalta rahe.
 * `onReport` optional hai (boss ko alert karne ke liye jab kuch bada mile).
 */
export function startMaintenanceLoop(deps = {}, { intervalMs = HEAL_INTERVAL_MS, onReport = null } = {}) {
  startLagProbe();
  if (loopStarted) return false;
  loopStarted = true;
  const tick = async () => {
    try {
      const report = await runMaintenance(deps, { reason: 'AUTO' });
      const something = report.locksReleased.length + report.reservationsReleased.length + report.scansReset;
      if (something > 0 && typeof onReport === 'function') {
        Promise.resolve(onReport(report)).catch(() => {});
      }
    } catch { /* loop kabhi na mare */ }
  };
  healTimer = setInterval(tick, Math.max(15_000, Number(intervalMs) || HEAL_INTERVAL_MS));
  if (typeof healTimer.unref === 'function') healTimer.unref();
  setTimeout(tick, 8_000).unref?.();
  return true;
}

/** Boss card — seedha, bina jargon. */
export function formatMaintenanceCard(snapshot) {
  const s = snapshot || getMaintenanceSnapshot();
  const lagLine = s.lagMs > 3000
    ? `🔴 <b>Lag:</b> ${s.lagMs} ms — bot atka hua hai`
    : s.lagMs > 800
      ? `🟡 <b>Lag:</b> ${s.lagMs} ms — thoda slow`
      : `🟢 <b>Lag:</b> ${s.lagMs} ms — theek chal raha hai`;
  const lines = [
    '🩺 <b>BOT MAINTENANCE</b>',
    '',
    lagLine,
    `▤ <b>RAM:</b> ${s.memoryMb} MB <i>(heap ${s.heapUsedMb} MB)</i>`,
    `⏱ <b>Uptime:</b> ${Math.floor(s.uptimeSec / 60)} min`,
    `⚙ <b>Chal rahe kaam:</b> ${s.activeJobs}`,
    s.stuckJobs.length ? `⚠ <b>Atke kaam:</b> ${s.stuckJobs.map((j) => `${j.key} (${Math.round(j.ageMs / 1000)}s)`).join(', ')}` : '✅ <b>Atke kaam:</b> koi nahi',
    s.lastHealAt ? `🧹 <b>Pichhli safai:</b> ${new Date(s.lastHealAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : '🧹 <b>Pichhli safai:</b> abhi nahi'
  ];
  const heal = s.lastHeal;
  if (heal) {
    const bits = [];
    if (heal.locksReleased?.length) bits.push(`${heal.locksReleased.length} lock free`);
    if (heal.reservationsReleased?.length) bits.push(`${heal.reservationsReleased.length} ID reservation free`);
    if (heal.scansReset) bits.push(`${heal.scansReset} scan reset`);
    lines.push(`◉ <b>Result:</b> ${bits.length ? bits.join(' · ') : 'kuch atka nahi tha'}`);
    for (const note of (heal.notes || []).slice(0, 2)) lines.push(`<i>› ${note}</i>`);
  }
  return lines.join('\n');
}
