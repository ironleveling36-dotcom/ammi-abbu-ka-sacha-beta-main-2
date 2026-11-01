import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, saveDb, updateAccount } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Standard Windows Chrome Path
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function loginWithBrowser(targetAccount = 'ammi', telegramNotifier = null) {
  const accountName = targetAccount.charAt(0).toUpperCase() + targetAccount.slice(1);
  console.log(`\n› Launching Google Chrome for ${accountName}'s Swiggy Login...`);

  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error('Google Chrome was not found at standard path.');
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: process.platform === 'linux' ? 'new' : false,
    defaultViewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  console.log('◎ Opening https://www.swiggy.com ...');
  await page.goto('https://www.swiggy.com/', { waitUntil: 'domcontentloaded' });

  if (telegramNotifier) {
    await telegramNotifier(`◎ <b>Chrome window opened on your screen!</b>\n\nPlease enter <b>${accountName}</b>'s phone number and OTP on Swiggy screen. The bot will automatically detect login and save it!`);
  }

  console.log(`\n› Please enter ${accountName}'s Phone Number and OTP in the Chrome browser window.`);
  console.log('◷ Bot is waiting for successful login...');

  // Poll for login success (checks cookies for _session_id or tid)
  let isLoggedIn = false;
  let attempts = 0;
  const maxAttempts = 120; // 4 minutes timeout

  while (!isLoggedIn && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;

    try {
      const cookies = await page.cookies();
      const hasSession = cookies.some(c => c.name === '_session_id' || c.name === 'tid' || c.name === 'user_id');

      // Also check if user profile element exists in DOM
      const userBadge = await page.evaluate(() => {
        return Boolean(document.querySelector('span._1W_Ta') || document.querySelector('a[href*="/my-account"]'));
      }).catch(() => false);

      if (hasSession || userBadge) {
        isLoggedIn = true;
        console.log(`\n✓ Login detected for ${accountName}!`);

        // Grab cookies string
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        // Update database
        updateAccount(targetAccount, {
          isLoggedIn: true,
          cookies: cookieStr,
          savedAt: new Date().toISOString()
        });

        console.log(`✓ Saved ${accountName}'s session to db.json!`);

        if (telegramNotifier) {
          await telegramNotifier(`✓ <b>MUBARAK! ${accountName}'s Swiggy account is successfully LOGGED IN and SAVED!</b>\n\nAb aap Saudi jao ya kahin bhi, is account ka session bot ke andar hamesha ke liye save ho chuka hai!`);
        }

        await new Promise(r => setTimeout(r, 3000));
        await browser.close();
        return { success: true, targetAccount, cookieStr };
      }
    } catch (e) {
      // Browser might have been closed by user
      if (e.message.includes('Session closed') || e.message.includes('Target closed')) {
        console.log('! Browser window closed by user.');
        return { success: false, message: 'Browser window closed.' };
      }
    }
  }

  await browser.close().catch(() => {});
  return { success: false, message: 'Login timed out after 4 minutes.' };
}

// Allow direct CLI execution: node login-helper.js ammi
const arg = process.argv[2];
if (arg) {
  loginWithBrowser(arg).then(res => {
    console.log('\nResult:', res);
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
