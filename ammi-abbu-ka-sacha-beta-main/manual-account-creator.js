// ===== 🛠 MANUAL ACCOUNT CREATOR — Local Multi-Chromium Helper =====
//
// Usage:
//   node manual-account-creator.js --count=5 --bot-token=YOUR_BOT_TOKEN --chat-id=YOUR_CHAT_ID
//
// Flow:
//   1. Launches N Chromium instances with isolated profiles
//   2. You manually complete Swiggy sign-up in each window
//   3. Script detects login → extracts session JSON → sends to your TG bot
//   4. Repeat for all N accounts
//
// Requirements:
//   - Google Chrome installed (default path auto-detected)
//   - Bot token + your chat ID (get from @userinfobot)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config from CLI / env ----
const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const COUNT = parseInt(getArg('count') || process.env.MANUAL_COUNT || '1', 10);
const BOT_TOKEN = getArg('bot-token') || process.env.BOT_TOKEN || process.env.MANUAL_BOT_TOKEN;
const CHAT_ID = getArg('chat-id') || process.env.CHAT_ID || process.env.MANUAL_CHAT_ID;
const HEADLESS = (getArg('headless') || process.env.MANUAL_HEADLESS || 'false') === 'true';
const PROFILE_BASE = path.join(__dirname, 'manual-profiles');

if (!BOT_TOKEN || !CHAT_ID) {
  console.error(`
❌ Missing required arguments!

Usage:
  node manual-account-creator.js --count=5 --bot-token=123:ABC --chat-id=6484999726

Or set env vars:
  MANUAL_COUNT=5
  MANUAL_BOT_TOKEN=123:ABC
  MANUAL_CHAT_ID=6484999726
`);
  process.exit(1);
}

// ---- Chrome detection ----
function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const p of paths) if (fs.existsSync(p)) return p;
  }
  const linuxPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of linuxPaths) if (fs.existsSync(p)) return p;
  return '/usr/bin/chromium';
}

const CHROME_PATH = findChromePath();
console.log(`🌐 Chrome: ${CHROME_PATH}`);
console.log(`📁 Profiles: ${PROFILE_BASE}`);
console.log(`🤖 Bot: ${BOT_TOKEN.slice(0, 10)}...`);
console.log(`💬 Chat ID: ${CHAT_ID}`);
console.log(`🔢 Count: ${COUNT}`);
console.log(`👻 Headless: ${HEADLESS}`);

// ---- Telegram sender ----
async function sendToTelegram(text, document = null) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const form = new URLSearchParams({
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) console.error('⚠️ TG send failed:', await res.text());
  } catch (e) {
    console.error('⚠️ TG error:', e.message);
  }
}

async function sendDocumentToTelegram(filePath, caption) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const formData = new FormData();
  formData.append('chat_id', CHAT_ID);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  const fileBlob = new Blob([fs.readFileSync(filePath)]);
  formData.append('document', fileBlob, path.basename(filePath));
  try {
    const res = await fetch(url, { method: 'POST', body: formData });
    if (!res.ok) console.error('⚠️ TG doc send failed:', await res.text());
  } catch (e) {
    console.error('⚠️ TG doc error:', e.message);
  }
}

// ---- Session extraction ----
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
  } catch { return null; }
}

async function extractSessionData(page, phone) {
  // Get all cookies
  const cookies = await page.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Get localStorage
  const localStorage = await page.evaluate(() => {
    const obj = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      obj[key] = localStorage.getItem(key);
    }
    return obj;
  });

  // Get sessionStorage
  const sessionStorage = await page.evaluate(() => {
    const obj = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      obj[key] = sessionStorage.getItem(key);
    }
    return obj;
  });

  // Extract key tokens
  const tid = cookies.find(c => c.name === 'tid')?.value || localStorage.tid || sessionStorage.tid || '';
  const sessionTid = cookies.find(c => c.name === '_session_tid')?.value || localStorage._session_tid || sessionStorage._session_tid || '';
  const token = cookies.find(c => c.name === 'token')?.value || localStorage.token || sessionStorage.token || '';
  const wafToken = cookies.find(c => c.name === 'aws-waf-token')?.value || '';
  const isLoggedIn = cookies.find(c => c.name === '_is_logged_in')?.value || '';

  // Decode user_id from tid if JWT
  let userId = '';
  if (tid && tid.includes('.')) {
    const payload = decodeJwtPayload(tid);
    userId = payload?.user_id || '';
  }

  return {
    phone,
    timestamp: new Date().toISOString(),
    cookies: cookieStr,
    cookieArray: cookies,
    localStorage,
    sessionStorage,
    extracted: {
      tid,
      _session_tid: sessionTid,
      token,
      aws_waf_token: wafToken,
      _is_logged_in: isLoggedIn,
      user_id: userId,
    },
    url: page.url(),
    userAgent: await page.evaluate(() => navigator.userAgent),
  };
}

function sanitizePhone(phone) {
  return String(phone).replace(/\D/g, '').slice(-10);
}

// ---- Main account creation loop ----
async function createAccount(index) {
  const profileDir = path.join(PROFILE_BASE, `account_${index}_${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`\n🚀 [${index}/${COUNT}] Launching Chromium...`);
  console.log(`   Profile: ${profileDir}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    userDataDir: profileDir,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--window-position=' + ((index - 1) % 3) * 450 + ',' + Math.floor((index - 1) / 3) * 400,
      '--lang=en-IN,en-US,en',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.emulateTimezone('Asia/Kolkata').catch(() => {});

  // Inject anti-detection
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

  // Navigate to Swiggy login
  console.log(`   🌐 Opening Swiggy login...`);
  await page.goto('https://www.swiggy.com/signin', { waitUntil: 'networkidle2', timeout: 60000 });

  // Send start notification
  await sendToTelegram(
    `🚀 <b>Manual Account Creator</b>\n` +
    `📱 Account <b>${index}/${COUNT}</b> ready for sign-up\n` +
    `🔗 <a href="https://www.swiggy.com/signin">Swiggy Sign-in</a>\n` +
    `⏳ Complete OTP login in the browser window...`
  );

  // Wait for login - poll for session indicators
  console.log(`   ⏳ Waiting for login (check browser window)...`);
  let sessionData = null;
  let attempts = 0;
  const maxAttempts = 300; // 5 minutes (10s intervals)

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 10000));
    attempts++;

    try {
      // Check if logged in by looking for user indicators
      const cookies = await page.cookies();
      const hasSessionTid = cookies.some(c => c.name === '_session_tid' && c.value.length > 20);
      const hasTid = cookies.some(c => c.name === 'tid' && c.value.includes('.'));
      const isLoggedIn = cookies.some(c => c.name === '_is_logged_in' && c.value === '1');

      // Also check localStorage
      const ls = await page.evaluate(() => ({
        tid: localStorage.tid,
        sessionTid: localStorage._session_tid,
        token: localStorage.token,
      }));
      const hasLsSession = ls.sessionTid && ls.sessionTid.length > 20;

      if (hasSessionTid || hasTid || isLoggedIn || hasLsSession) {
        console.log(`   ✅ Login detected!`);
        sessionData = await extractSessionData(page, `pending_${index}`);
        break;
      }

      if (attempts % 6 === 0) {
        console.log(`   ⏳ Still waiting... (${attempts * 10}s)`);
      }
    } catch (e) {
      console.log(`   ⚠️ Check error: ${e.message}`);
    }
  }

  if (!sessionData) {
    console.log(`   ❌ Timeout - no login detected after 5 minutes`);
    await sendToTelegram(`❌ <b>Account ${index}/${COUNT}</b> — Timeout (no login detected)`);
    await browser.close();
    return null;
  }

  // Try to get phone number from Swiggy profile
  let phone = `unknown_${index}`;
  try {
    await page.goto('https://www.swiggy.com/my-account', { waitUntil: 'networkidle2', timeout: 15000 });
    const pagePhone = await page.evaluate(() => {
      // Try to find phone in page
      const text = document.body.innerText;
      const match = text.match(/(\+91|91)?[6-9]\d{9}/);
      return match ? match[0] : null;
    });
    if (pagePhone) phone = sanitizePhone(pagePhone);
  } catch {}

  // Update session with phone
  sessionData.phone = phone;
  sessionData.accountKey = `acc_${phone}`;

  // Save JSON file
  const jsonFile = path.join(profileDir, `session_${phone}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(sessionData, null, 2));
  console.log(`   💾 Session saved: ${jsonFile}`);

  // Send to Telegram
  const caption = `✅ <b>Account ${index}/${COUNT} Ready</b>\n` +
    `📱 Phone: <code>${phone}</code>\n` +
    `🔑 User ID: <code>${sessionData.extracted.user_id || 'unknown'}</code>\n` +
    `🍪 Cookies: ${sessionData.cookieArray.length} items\n` +
    `🛡 WAF Token: ${sessionData.extracted.aws_waf_token ? 'Yes' : 'No'}`;

  await sendDocumentToTelegram(jsonFile, caption);

  console.log(`   📤 Sent to Telegram!`);

  await browser.close();
  return sessionData;
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     🛠 MANUAL ACCOUNT CREATOR — Swiggy Session Extractor ║
╚══════════════════════════════════════════════════════════╝

Instructions:
1. ${COUNT} Chromium windows will open (one by one)
2. In each window: Go through Swiggy sign-up/login manually
3. Enter OTP, complete registration
4. Script auto-detects login → extracts session → sends to TG
5. Close window when done → next one opens

Press Ctrl+C to stop anytime.
`);

  await sendToTelegram(
    `🚀 <b>Manual Account Creator Started</b>\n` +
    `📊 Target: <b>${COUNT}</b> accounts\n` +
    `🕐 ${new Date().toLocaleString()}`
  );

  const results = [];
  for (let i = 1; i <= COUNT; i++) {
    const result = await createAccount(i);
    if (result) results.push(result);
    
    if (i < COUNT) {
      console.log(`\n⏸ Next account in 3 seconds...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Summary
  console.log(`\n🎉 Done! ${results.length}/${COUNT} accounts created.`);
  
  const summary = results.map((r, i) => 
    `${i + 1}. <code>${r.phone}</code> → <b>${r.extracted.user_id || 'no-id'}</b>`
  ).join('\n');

  await sendToTelegram(
    `🏁 <b>Manual Account Creator Complete</b>\n` +
    `✅ Success: <b>${results.length}/${COUNT}</b>\n\n` +
    `${summary || 'No accounts created'}`
  );

  // Save combined file
  const combinedFile = path.join(PROFILE_BASE, `all_sessions_${Date.now()}.json`);
  fs.writeFileSync(combinedFile, JSON.stringify(results, null, 2));
  console.log(`💾 Combined file: ${combinedFile}`);
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});